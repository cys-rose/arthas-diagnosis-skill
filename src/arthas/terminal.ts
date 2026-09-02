/**
 * arthas WebSocket 终端通道（web console 同源通道，ws://127.0.0.1:<httpPort>/ws）——exec 的主通道（ADR-0009）。
 *
 * 实测协议（arthas 4.3.4 已验证）：
 * - 客户端→服务端是 JSON 包装：输入 {"action":"read","data":"memory\n"}；建连后按 web console 前端惯例先发
 *   {"action":"resize",...}；Ctrl+C 是 {"action":"read","data":"\x03"}。
 * - 服务端→客户端是裸文本帧（含 ANSI，\r\n 行尾）；帧切分极碎（watch 期间大量 1 字节帧），
 *   必须拼接累积后判定，不能按帧判定。
 * - 命令完成标志：提示符精确形态 `[arthas@<pid>]$ `（无 ANSI 包裹、带尾随空格，总在 \r\n 后或独立成帧）。
 * - 连接后先到 banner（含一个提示符），必须先消费 banner 再进入"发命令→等提示符"状态机。
 * - 持续型命令（watch/trace）运行期间输出不含提示符；Ctrl+C 后提示符回归。
 */
import { randomUUID } from 'node:crypto';

/** 一次 exec 的流式输出回调：chunk 为服务端裸文本帧原文（含 ANSI）。 */
export type TerminalDataListener = (chunk: string) => void;

/** 一条命令的终端执行结果。 */
export interface TerminalExecResult {
  /** 该命令的完整终端输出原文（含 ANSI，含命令回显与结尾提示符；\r\n 行尾）。 */
  output: string;
  /** true 表示 timeoutMs 内提示符未回归，命令仍在后台执行（可 interrupt 中断）。 */
  timedOut: boolean;
}

/**
 * 终端会话：一条 WS 连接，同一时刻只跑一条命令。
 * 会话忙（超时命令仍在后台执行）时不可复用；遇忙开新会话由 Gateway 会话池管理。
 */
export interface TerminalSession {
  /** 会话标识（Gateway 侧生成，供 sessions 工具展示）。 */
  readonly id: string;
  /** 会话是否已关闭（WS 断开或对端不可达后不可复用）。 */
  readonly closed: boolean;
  /**
   * 执行一条命令直到提示符回归或超时：
   * onData 流式回调收到服务端裸文本帧原文（含 ANSI）；超时未等到提示符时 timedOut=true，output 为已收到的部分输出，
   * 命令仍在后台执行（会话保持 busy，不可复用，可 interrupt 中断）。
   */
  exec(command: string, timeoutMs: number, onData: TerminalDataListener): Promise<TerminalExecResult>;
  /**
   * 发送 Ctrl+C 中断正在运行的命令并等待提示符回归（会话恢复可用）。
   * 提示符未在限定时间内回归时关闭会话并抛 TerminalClosedError，调用方应丢弃该会话。
   */
  interrupt(): Promise<void>;
  /** 关闭 WS 连接（幂等）。 */
  close(): void;
}

/**
 * WS 终端通道接缝：测试用 stub 替代真实 WS。
 * 对应 arthas agent 内置 web console 的 WebSocket 端点（/ws）。
 */
export interface TerminalChannel {
  /**
   * 打开一条终端会话：连上 WS、发 resize、消费 banner（含首个提示符）后返回。
   * 连接失败/超时抛带明确原因的 Error。
   */
  openSession(httpPort: number): Promise<TerminalSession>;
}

/** 会话忙：一条终端会话同一时刻只跑一条命令，并发 exec 命中说明会话池管理有误。 */
export class TerminalSessionBusyError extends Error {}

/** 终端会话已关闭（WS 断开或对端不可达）。 */
export class TerminalClosedError extends Error {}

/** 提示符精确形态（含尾随空格）：`[arthas@<pid>]$ `，总在 \r\n 后或独立成帧。 */
const PROMPT_TAIL_RE = /(?:^|\r\n)(\[arthas@\d+\]\$ $)/;

/** 提示符行形态（剥 ANSI 后整行匹配，允许尾随空格）：`[arthas@<pid>]$`。 */
const PROMPT_LINE_RE = /^\[arthas@\d+\]\$ ?$/;

/**
 * 累积原文中尾部提示符的起始下标（`[` 的下标），没有则 -1。
 * 要求提示符是缓冲的当前尾部（后续输出会推开它），且前驱是 \r\n 或缓冲开头。
 */
function trailingPromptIndex(buffer: string): number {
  const match = PROMPT_TAIL_RE.exec(buffer);
  if (!match) return -1;
  return match.index + (match[0].length - match[1]!.length);
}

/** 剥掉 ANSI CSI 转义序列（SGR 颜色、光标控制等全部丢弃）。 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * 一次命令的终端原文 → 展示用输出：去掉命令回显首行与结尾提示符行，保留 ANSI 原文；
 * \r\n → \n；行内 \r（重绘）取最后段。
 */
export function trimTerminalOutput(raw: string, command: string): string {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line));
  // 结尾提示符行：剥 ANSI 后整行为 [arthas@<pid>]$
  while (lines.length > 0 && PROMPT_LINE_RE.test(stripAnsi(lines[lines.length - 1]!).trim())) {
    lines.pop();
  }
  // 命令回显首行：剥 ANSI 后以命令原文结尾（终端回显的输入行）
  if (lines.length > 0 && stripAnsi(lines[0]!).trim().endsWith(command.trim())) {
    lines.shift();
  }
  return lines.join('\n');
}

/** 给 agent 的输出：剥掉 ANSI 的纯终端文本。 */
export function toAgentOutput(output: string): string {
  return stripAnsi(output);
}

/** WS 建连与 banner 等待超时。 */
const OPEN_TIMEOUT_MS = 5_000;
/** Ctrl+C 后等待提示符回归的超时；超时视为会话失效。 */
const INTERRUPT_PROMPT_TIMEOUT_MS = 10_000;

/** WS 终端通道真实实现：与 web console 同源的 ws://127.0.0.1:<httpPort>/ws。 */
export class WsTerminalChannel implements TerminalChannel {
  /** 打开一条终端会话：连接 WS、等待 banner（含首个提示符）后返回。 */
  async openSession(httpPort: number): Promise<TerminalSession> {
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`);
    const session = new WsTerminalSession(ws, `ws-${randomUUID().slice(0, 8)}`);
    try {
      await session.handshake(httpPort);
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }
}

/**
 * 单条 WS 终端会话：维护累积原文缓冲与"发命令→等提示符"状态机。
 * 帧切分极碎（watch 期间大量 1 字节帧），必须拼接累积后判定提示符，不能按帧判定。
 */
class WsTerminalSession implements TerminalSession {
  readonly id: string;
  private readonly ws: WebSocket;
  /** 连接后累积的全部原文（含 ANSI）；提示符判定基于全量缓冲。 */
  private buffer = '';
  private isClosed = false;
  /** 当前是否有命令在执行中（含超时未结束的）；busy 会话不可复用。 */
  private busy = false;
  /** 当前命令的流式回调。 */
  private onData: TerminalDataListener | null = null;
  /** 等待提示符的挂起请求；after 为请求发起时的缓冲长度，只有 after 之后出现的新尾部提示符才算数。 */
  private waiters: Array<{ after: number; resolve: (done: boolean) => void }> = [];

  constructor(ws: WebSocket, id: string) {
    this.ws = ws;
    this.id = id;
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onclose = () => this.fail();
    ws.onerror = () => this.fail();
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * 建连握手：等 open、按 web console 前端惯例发 resize、消费 banner（含首个提示符）。
   * 建连失败/超时/提示符未出现都抛带明确原因的 Error。
   */
  async handshake(httpPort: number): Promise<void> {
    await this.waitForOpen(httpPort);
    // web console 前端惯例：建连后发 resize。dashboard 等 TUI 命令按终端高度分配线程表行数、
    // 按宽度截断表格列，尺寸取接近全屏浏览器窗口的 160x50，避免输出比原生 console 少
    this.ws.send(JSON.stringify({ action: 'resize', cols: 160, rows: 50 }));
    const ok = await this.waitForPrompt(0, OPEN_TIMEOUT_MS);
    if (!ok) {
      throw new Error(`WS 终端 banner 提示符未在限定时间内出现（端口 ${httpPort}）：agent 未就绪或对端不是 arthas web console 通道。`);
    }
  }

  /**
   * 执行命令：发送 read 帧后等待 after 位置之后出现新的尾部提示符。
   * 超时返回 timedOut=true（命令仍在后台执行，会话保持 busy）。
   */
  async exec(command: string, timeoutMs: number, onData: TerminalDataListener): Promise<TerminalExecResult> {
    if (this.isClosed) throw new TerminalClosedError(`终端会话 ${this.id} 已关闭。`);
    if (this.busy) {
      throw new TerminalSessionBusyError(`终端会话 ${this.id} 忙：同一时刻只能执行一条命令。`);
    }
    this.busy = true;
    this.onData = onData;
    const after = this.buffer.length;
    this.ws.send(JSON.stringify({ action: 'read', data: `${command}\n` }));
    const done = await this.waitForPrompt(after, timeoutMs);
    this.onData = null;
    if (this.isClosed) {
      throw new TerminalClosedError(`终端会话 ${this.id} 在执行中断开。`);
    }
    if (!done) {
      // 命令仍在后台执行：会话保持 busy（interrupt 可使其恢复可用）
      return { output: this.buffer.slice(after), timedOut: true };
    }
    this.busy = false;
    const promptAt = trailingPromptIndex(this.buffer);
    return { output: this.buffer.slice(after, promptAt < 0 ? this.buffer.length : promptAt), timedOut: false };
  }

  /**
   * 发送 Ctrl+C 并等待提示符回归（会话恢复可用）；提示符未回归时关闭会话并抛错。
   */
  async interrupt(): Promise<void> {
    if (this.isClosed) throw new TerminalClosedError(`终端会话 ${this.id} 已关闭。`);
    this.ws.send(JSON.stringify({ action: 'read', data: '\x03' }));
    const after = this.buffer.length;
    const ok = await this.waitForPrompt(after, INTERRUPT_PROMPT_TIMEOUT_MS);
    if (!ok || this.isClosed) {
      this.close();
      throw new TerminalClosedError(`终端会话 ${this.id} 中断后提示符未回归，会话已关闭。`);
    }
    this.busy = false;
  }

  /** 关闭 WS 连接（幂等）：释放挂起的等待请求。 */
  close(): void {
    this.fail();
  }

  /** 等 open 事件；连接失败（close/error）或超时都视为失败。 */
  private waitForOpen(httpPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`无法连接 arthas WS 终端（端口 ${httpPort}）：连接超时。`));
      }, OPEN_TIMEOUT_MS);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error(`无法连接 arthas WS 终端（端口 ${httpPort}）。`));
      }, { once: true });
    });
  }

  /** 等待 after 位置之后出现新的尾部提示符；超时或会话关闭返回 false。 */
  private waitForPrompt(after: number, timeoutMs: number): Promise<boolean> {
    if (this.isClosed) return Promise.resolve(false);
    if (trailingPromptIndex(this.buffer) >= after) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = { after, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      timer.unref();
    });
  }

  /** 累积一帧原文；触发流式回调；唤醒等到新尾部提示符的挂起请求。 */
  private handleMessage(data: unknown): void {
    if (this.isClosed) return;
    const chunk = typeof data === 'string' ? data : String(data ?? '');
    if (!chunk) return;
    this.buffer += chunk;
    this.onData?.(chunk);
    const promptAt = trailingPromptIndex(this.buffer);
    if (promptAt < 0) return;
    for (const waiter of this.waiters) {
      if (promptAt >= waiter.after) waiter.resolve(true);
    }
    this.waiters = this.waiters.filter((w) => promptAt < w.after);
  }

  /** 会话失效：标记关闭、清空缓冲、释放全部挂起等待、尽力关闭底层连接。 */
  private fail(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.buffer = '';
    for (const waiter of this.waiters) waiter.resolve(false);
    this.waiters = [];
    try {
      this.ws.close();
    } catch {
      // 底层连接已断开，忽略
    }
  }
}

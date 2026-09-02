import type { GatewayDeps } from '../src/gateway.ts';
import type { ArthasInstallation, ArthasLocator } from '../src/arthas/locator.ts';
import type { AttachRequest, Attacher } from '../src/arthas/attacher.ts';
import type { AgentProber, ProbedJvmInfo } from '../src/arthas/http-api.ts';
import type {
  TerminalChannel,
  TerminalDataListener,
  TerminalExecResult,
  TerminalSession,
} from '../src/arthas/terminal.ts';
import type { BrowserOpener } from '../src/browser.ts';
import type { JvmProcess, ProcessLister } from '../src/process-listing.ts';

/** 测试用 arthas 安装信息。 */
export const FAKE_INSTALL: ArthasInstallation = {
  version: '4.3.4',
  home: '/fake/.arthas/lib/4.3.4/arthas',
  bootJar: '/fake/.arthas/lib/4.3.4/arthas/arthas-boot.jar',
};

/** 记录调用的 attacher stub；onAttach 可注入失败。 */
export class StubAttacher implements Attacher {
  calls: AttachRequest[] = [];
  onAttach?: (req: AttachRequest) => void | Promise<void>;

  /** 记录请求后执行注入行为（默认成功）。 */
  async attach(_install: ArthasInstallation, req: AttachRequest): Promise<void> {
    this.calls.push(req);
    await this.onAttach?.(req);
  }
}

/** 记录打开 URL 的浏览器 stub。 */
export class StubBrowserOpener implements BrowserOpener {
  openedUrls: string[] = [];
  /** 记录 URL，不真正打开浏览器。 */
  async open(url: string): Promise<void> {
    this.openedUrls.push(url);
  }
}

/** 固定返回进程列表的 lister stub。 */
export function stubLister(processes: JvmProcess[]): ProcessLister {
  return { list: async () => processes };
}

/** 固定返回 FAKE_INSTALL 的 locator stub；可注入错误。 */
export function stubLocator(error?: Error): ArthasLocator {
  return {
    locate: async () => {
      if (error) throw error;
      return FAKE_INSTALL;
    },
  };
}

/** agent 收养探测 stub：记录被探测端口；onProbeJvmInfo 注入探测结果（默认 null 表示无 agent 收养）。 */
export class StubAgentProber implements AgentProber {
  /** 被探测过的 httpPort 列表。 */
  probed: number[] = [];
  /** 注入探测行为：返回某端口上的 agent 信息（默认 null 表示无 agent 收养）。 */
  onProbeJvmInfo?: (httpPort: number) => ProbedJvmInfo | null | Promise<ProbedJvmInfo | null>;

  /** 记录探测端口并返回注入结果（默认 null）。 */
  async probeJvmInfo(httpPort: number): Promise<ProbedJvmInfo | null> {
    this.probed.push(httpPort);
    return (await this.onProbeJvmInfo?.(httpPort)) ?? null;
  }
}

/** 注入 exec 行为的返回值形状：output 覆盖默认终端原文，timedOut 模拟超时（命令仍在后台执行，会话保持 busy）。 */
export interface StubExecBehavior {
  output?: string;
  timedOut?: boolean;
}

/** 终端会话 stub：内存命令执行。默认行为：回显 + 'stub output' + 提示符的默认终端原文；onExec 可注入输出/超时/错误。 */
export class StubTerminalSession implements TerminalSession {
  readonly id: string;
  readonly httpPort: number;
  /** 已执行命令列表（按序）。 */
  executed: string[] = [];
  /** interrupt 调用次数。 */
  interruptCount = 0;
  isClosed = false;
  /** 注入 exec 行为：返回 { output?, timedOut? } 覆盖默认输出，或抛错模拟执行失败。 */
  onExec?: (command: string, session: StubTerminalSession) => StubExecBehavior | Promise<StubExecBehavior>;

  constructor(id: string, httpPort: number) {
    this.id = id;
    this.httpPort = httpPort;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * 模拟执行：记录命令 → 执行注入行为（可抛错）→ 返回终端原文。
   * 默认原文为「回显 + stub output + 提示符」：`<command>\r\nstub output\r\n[arthas@1234]$ `。
   */
  async exec(command: string, _timeoutMs: number, onData: TerminalDataListener): Promise<TerminalExecResult> {
    this.executed.push(command);
    const injected = await this.onExec?.(command, this);
    const raw = injected?.output ?? `${command}\r\nstub output\r\n[arthas@1234]$ `;
    onData(raw);
    return { output: raw, timedOut: injected?.timedOut ?? false };
  }

  /** 记录 interrupt 调用。 */
  async interrupt(): Promise<void> {
    this.interruptCount++;
  }

  /** 关闭会话（标记 closed）。 */
  close(): void {
    this.isClosed = true;
  }
}

/** 终端通道 stub：openSession 直接新建会话记录并返回；onOpenSession 在会话创建后回调（抛错即建连失败）。 */
export class StubTerminalChannel implements TerminalChannel {
  private seq = 0;
  sessions: StubTerminalSession[] = [];
  /** 注入会话创建后行为：给新会话注入 onExec，或抛错模拟建连失败。 */
  onOpenSession?: (session: StubTerminalSession) => void | Promise<void>;

  /** 新建会话（注入行为在创建后回调，抛错即建连失败）。 */
  async openSession(httpPort: number): Promise<TerminalSession> {
    const session = new StubTerminalSession(`stub-session-${++this.seq}`, httpPort);
    await this.onOpenSession?.(session);
    this.sessions.push(session);
    return session;
  }

  /** 所有会话上执行过的命令（跨会话平铺，便于断言）。 */
  allExecuted(): string[] {
    return this.sessions.flatMap((s) => s.executed);
  }
}

export interface StubDeps {
  deps: GatewayDeps;
  attacher: StubAttacher;
  opener: StubBrowserOpener;
  prober: StubAgentProber;
  terminal: StubTerminalChannel;
}

/** 组装一套默认全部成功的 stub 依赖（dashboard 用随机端口）。 */
export function makeStubDeps(processes: JvmProcess[] = [{ pid: 1234, name: 'com.example.Main' }]): StubDeps {
  const attacher = new StubAttacher();
  const opener = new StubBrowserOpener();
  const prober = new StubAgentProber();
  const terminal = new StubTerminalChannel();
  return {
    attacher,
    opener,
    prober,
    terminal,
    deps: {
      processLister: stubLister(processes),
      arthasLocator: stubLocator(),
      attacher,
      terminal,
      agentProber: prober,
      browserOpener: opener,
      dashboardPort: 0,
    },
  };
}

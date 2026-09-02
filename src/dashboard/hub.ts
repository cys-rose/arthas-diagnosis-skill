import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { renderDashboardPage } from './page.ts';

/** Dashboard 上单个 Target JVM 卡片的状态。 */
export interface JvmCardState {
  pid: number;
  name: string;
  telnetPort: number;
  httpPort: number;
  /** ISO 时间串。 */
  attachedAt: string;
  arthasVersion: string;
  sessionCount: number;
  pendingConfirmations: number;
  status: 'attached' | 'exited';
  /** 诊断活动流：Gateway 在该 JVM 上执行过的命令及流式结果（最新在尾部）。 */
  activity: ActivityEntry[];
}

/**
 * 诊断活动流中的一条记录：一次 exec 的命令回显 + 流式累积的终端文本输出。
 * 背景：arthas 的结果共享（SharingResultDistributor）只覆盖 HTTP Session 通道，web console 的 WebSocket 通道看不到其他 Session 的输出，且结果共享不覆盖 WS 通道，
 * 因此"agent 做了什么"必须由 Gateway 侧记录并推送到 Dashboard（exec 走 WS 终端通道后这一点仍然成立，见 ADR-0009）。
 */
export interface ActivityEntry {
  id: number;
  command: string;
  /** ISO 时间串。 */
  startedAt: string;
  state: 'running' | 'done' | 'timeout' | 'error';
  /**
   * 终端文本输出：running 时为含 ANSI 的流式原文（随 WS 帧流式追加，含回显/提示符）；done/timeout 后裁剪为去掉命令回显与提示符的终端文本（含 ANSI 原文）。
   * 提示符判定基于"累积原文 + 尾部提示符"（见 terminal.ts 模块头注释）。
   */
  output: string;
  /** state 为 error 时的给人看原因。 */
  error?: string;
}

/** Dashboard 全量快照：SSE 每次推送与 /api/state 都使用它（客户端无状态重渲染）。 */
export interface DashboardSnapshot {
  gatewayVersion: string;
  jvms: JvmCardState[];
}

export const DEFAULT_DASHBOARD_PORT = 18765;

/**
 * Dashboard 托管服务：Gateway 同进程的 HTTP + SSE。
 * 数据只存内存（快照由 Gateway 回调现算），刷新页面不丢诊断现场，Gateway 重启即清空。
 */
export class DashboardHub {
  private server: Server | null = null;
  private sseClients = new Set<ServerResponse>();
  private readonly getSnapshot: () => DashboardSnapshot;
  private readonly preferredPort: number;
  /** 自助卸载回调（Dashboard 按钮触发，返回 null 或错误信息）。 */
  private readonly onShutdownRequest?: ((pid: number) => Promise<string | null>) | undefined;
  /** 「关闭 Gateway」回调（Dashboard 按钮触发）：退出 Gateway 进程，不卸载任何 arthas agent。 */
  private readonly onExitRequest?: (() => void) | undefined;

  constructor(
    getSnapshot: () => DashboardSnapshot,
    options: { port?: number; onShutdownRequest?: (pid: number) => Promise<string | null>; onExitRequest?: () => void } = {},
  ) {
    this.getSnapshot = getSnapshot;
    this.preferredPort = options.port ?? Number(process.env['ARTHAS_GATEWAY_DASHBOARD_PORT'] ?? DEFAULT_DASHBOARD_PORT);
    this.onShutdownRequest = options.onShutdownRequest;
    this.onExitRequest = options.onExitRequest;
  }

  /** 启动 HTTP 服务（幂等）；首选端口被占用（如残留 Gateway）时回退随机端口；返回实际端口。 */
  async start(): Promise<number> {
    if (this.server) return this.port;
    try {
      this.server = await this.listen(this.preferredPort);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.preferredPort === 0) throw error;
      console.error(`[gateway] Dashboard 首选端口 ${this.preferredPort} 被占用，改用随机端口`);
      this.server = await this.listen(0);
    }
    return this.port;
  }

  /** 在指定端口监听；端口为 0 时由系统分配随机端口。 */
  private listen(port: number): Promise<Server> {
    const server = createServer((req, res) => this.handleRequest(req, res));
    return new Promise<Server>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
  }

  /** Dashboard 页面 URL；未启动时抛错。 */
  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  get started(): boolean {
    return this.server !== null;
  }

  private get port(): number {
    if (!this.server) throw new Error('Dashboard 尚未启动');
    return (this.server.address() as AddressInfo).port;
  }

  /** 向所有 SSE 客户端推送最新全量快照。 */
  publish(): void {
    if (this.sseClients.size === 0) return;
    const payload = `event: state\ndata: ${JSON.stringify(this.getSnapshot())}\n\n`;
    for (const client of this.sseClients) client.write(payload);
  }

  /** 关闭服务（Gateway 退出时调用；不触碰任何 arthas agent）。 */
  async close(): Promise<void> {
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderDashboardPage());
      return;
    }
    // 浏览器端脚本（纯 ESM 文件，与 hub 同目录；src 运行与 dist 构建产物下均存在）
    if (url.pathname === '/client.js' && req.method === 'GET') {
      void readFile(new URL('./client.js', import.meta.url), 'utf8').then(
        (js) => {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
          res.end(js);
        },
        () => {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
        },
      );
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.getSnapshot()));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(this.getSnapshot())}\n\n`);
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }
    // 自助卸载按钮：POST /api/jvms/:pid/shutdown（页面已二次确认）
    const shutdownMatch = /^\/api\/jvms\/(\d+)\/shutdown$/.exec(url.pathname);
    if (shutdownMatch && req.method === 'POST') {
      const pid = Number(shutdownMatch[1]);
      void this.onShutdownRequest?.(pid).then((error) => {
        if (error) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(error);
        } else {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ shutdown: true }));
        }
      });
      return;
    }
    // 「关闭 Gateway」按钮：POST /api/gateway/shutdown（页面已二次确认）
    // 先回 200 再触发退出，保证响应能刷回浏览器；只退出 Gateway 进程，不卸载任何 arthas agent
    if (url.pathname === '/api/gateway/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ closing: true }));
      const timer = setTimeout(() => this.onExitRequest?.(), 150);
      timer.unref();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

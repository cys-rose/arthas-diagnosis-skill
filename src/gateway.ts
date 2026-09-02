import type { JvmProcess, ProcessLister } from './process-listing.ts';
import type { ArthasLocator } from './arthas/locator.ts';
import type { Attacher } from './arthas/attacher.ts';
import type { AgentProber } from './arthas/http-api.ts';
import {
  TerminalClosedError,
  toAgentOutput,
  trimTerminalOutput,
  type TerminalChannel,
  type TerminalSession,
} from './arthas/terminal.ts';
import type { BrowserOpener } from './browser.ts';
import { allocatePorts, DEFAULT_HTTP_PORT, DEFAULT_TELNET_PORT } from './ports.ts';
import { readFile } from 'node:fs/promises';
import {
  extractCollapsedOutputFile,
  isProfilerStopCommand,
  parseCollapsed,
  type CollapsedSummary,
} from './profiler-hotspots.ts';
import { DashboardHub, type ActivityEntry, type DashboardSnapshot, type JvmCardState } from './dashboard/hub.ts';
import { ConfirmationManager } from './confirmation.ts';
import { describeRisk, forbiddenReason, gradeCommand } from './grading.ts';
import { SystemProcessProbe, type ProcessProbe } from './process-probe.ts';
import { GATEWAY_VERSION } from './version.ts';

/** Gateway 外部依赖接缝：测试时全部可替换为 stub。 */
export interface GatewayDeps {
  processLister: ProcessLister;
  arthasLocator: ArthasLocator;
  attacher: Attacher;
  /** exec 主通道：WS 终端通道（测试 stub 替代，主测试接缝，ADR-0009）。 */
  terminal: TerminalChannel;
  /** 收养探测：HTTP API init_session + welcome（ADR-0006，exec 之外仅存的 HTTP API 用途）。 */
  agentProber: AgentProber;
  browserOpener: BrowserOpener;
  /** 进程存活探测；默认 signal 0 真实探测。 */
  processProbe?: ProcessProbe;
  /** Dashboard 首选端口；测试传 0 用随机端口。 */
  dashboardPort?: number;
  /** JVM 存活检测周期（ms），默认 3000；测试可调大并手动调 checkLiveness。 */
  livenessIntervalMs?: number;
  /** Dashboard「关闭 Gateway」按钮触发：退出 Gateway 进程（不卸载任何 arthas agent）。 */
  onExitRequest?: () => void;
}

/** 一条诊断 Session 的对外信息：Gateway 自动管理，不暴露给 agent 显式操作。 */
export interface SessionInfo {
  sessionId: string;
  busy: boolean;
  /** ISO 时间串。 */
  createdAt: string;
}

/** 会话池内部条目：对外信息 + WS 终端会话句柄。 */
interface PooledSession extends SessionInfo {
  term: TerminalSession;
}

/** 一个已 attach 的 Target JVM 的现场记录。 */
export interface AttachedJvm {
  pid: number;
  name: string;
  telnetPort: number;
  httpPort: number;
  /** ISO 时间串。 */
  attachedAt: string;
  arthasVersion: string;
  status: 'attached' | 'exited';
  sessions: PooledSession[];
  /** 诊断活动流（最新在尾部，超过上限淘汰最旧）。 */
  activity: ActivityEntry[];
}

/** exec 的执行结果。 */
export interface ExecOutcome {
  sessionId: string;
  /** 剥掉 ANSI 的终端文本输出（去命令回显与结尾提示符，\r\n → \n）。 */
  output: string;
  /** true 表示命令在超时前未结束，仍在执行（可用 interrupt 中断）。 */
  timedOut: boolean;
  /** profiler stop 时自动附带的 collapsed 热点摘要（抓取失败时缺省，ADR-0006）。 */
  hotspots?: CollapsedSummary;
}

/** exec 被命令分级拦截、等待用户确认时的返回。 */
export interface ConfirmationRequired {
  requiresConfirmation: true;
  /** 一次性确认令牌：用户同意后带它重发 exec。 */
  confirmToken: string;
  command: string;
  /** 给人看的风险说明，agent 在 chat 中转述。 */
  risk: string;
}

export type ExecResult = ExecOutcome | ConfirmationRequired;

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** 每个 JVM 诊断活动流的最大条数（淘汰最旧）。 */
const MAX_ACTIVITY_ENTRIES = 100;
/** 活动流流式更新的推送合并周期：高频终端帧（watch 期间 1 字节帧）合并为每周期一次全量快照推送。 */
const STREAM_PUBLISH_INTERVAL_MS = 200;

/**
 * Gateway 核心：持有诊断现场状态（已 attach JVM 注册表、Session 池、Dashboard），
 * 工具处理函数只是它之上的薄壳。
 */
export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly registry = new Map<number, AttachedJvm>();
  private readonly dashboard: DashboardHub;
  private readonly confirmations = new ConfirmationManager();
  private readonly processProbe: ProcessProbe;
  private readonly livenessIntervalMs: number;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** 流式输出时的推送合并定时器（高频终端帧下避免逐帧推送）。 */
  private streamPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private browserOpened = false;
  private activitySeq = 0;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.processProbe = deps.processProbe ?? new SystemProcessProbe();
    this.livenessIntervalMs = deps.livenessIntervalMs ?? 3000;
    this.dashboard = new DashboardHub(() => this.snapshot(), {
      ...(deps.dashboardPort !== undefined ? { port: deps.dashboardPort } : {}),
      onShutdownRequest: (pid) => this.shutdownFromDashboard(pid),
      ...(deps.onExitRequest !== undefined ? { onExitRequest: deps.onExitRequest } : {}),
    });
  }

  /** 枚举本机可被诊断的 Java 进程（PID + 主类/jar 名）。 */
  async listJvms(): Promise<JvmProcess[]> {
    return this.deps.processLister.list();
  }

  /**
   * 对目标 JVM 执行 attach（幂等：重复 attach 同一 PID 直接返回既有现场）。
   * 编排：收养探测（候选端口上已有同 PID 的常驻 agent 则直接收养，跳过 arthas-boot）
   * → 定位本地 arthas（版本校验）→ 分配端口 → arthas-boot attach（禁用 stop）
   * → 启动/更新 Dashboard → 首次 attach 自动弹出浏览器。
   * 收养路径返回 alreadyAttached: true（agent 是常驻的，Gateway 重启后注册表丢失时靠它避免重 attach 卡死，ADR-0006）。
   * 失败抛出带明确原因的 Error（AttachError 或定位错误）。
   */
  async attach(pid: number): Promise<{ jvm: AttachedJvm; alreadyAttached: boolean }> {
    const existing = this.registry.get(pid);
    if (existing) {
      if (existing.status === 'exited') {
        // 目标 JVM 已退出（PID 可能被新进程复用）：清掉陈旧现场，重新真实 attach
        this.closeSessions(existing);
        this.registry.delete(pid);
        this.dashboard.publish();
      } else {
        return { jvm: existing, alreadyAttached: true };
      }
    }

    const usedPorts = new Set<number>();
    for (const jvm of this.registry.values()) {
      usedPorts.add(jvm.telnetPort);
      usedPorts.add(jvm.httpPort);
    }

    // 收养已存在的 agent：目标 JVM 里的 arthas agent 是常驻的，若候选端口上已有
    // 属于该 PID 的 agent，直接用其端口对注册现场，不再跑 arthas-boot
    const adopted = await this.probeAdoptableAgent(pid, usedPorts);
    if (adopted) {
      const processes = await this.deps.processLister.list().catch(() => [] as JvmProcess[]);
      const jvm: AttachedJvm = {
        pid,
        name: processes.find((p) => p.pid === pid)?.name ?? '',
        telnetPort: adopted.telnetPort,
        httpPort: adopted.httpPort,
        attachedAt: new Date().toISOString(),
        arthasVersion: adopted.version,
        status: 'attached',
        sessions: [],
        activity: [],
      };
      this.registry.set(pid, jvm);
      await this.activateJvm();
      return { jvm, alreadyAttached: true };
    }

    const install = await this.deps.arthasLocator.locate();
    const ports = await allocatePorts(usedPorts);
    await this.deps.attacher.attach(install, { pid, ...ports });

    const processes = await this.deps.processLister.list().catch(() => [] as JvmProcess[]);
    const name = processes.find((p) => p.pid === pid)?.name ?? '';

    const jvm: AttachedJvm = {
      pid,
      name,
      telnetPort: ports.telnetPort,
      httpPort: ports.httpPort,
      attachedAt: new Date().toISOString(),
      arthasVersion: install.version,
      status: 'attached',
      sessions: [],
      activity: [],
    };
    this.registry.set(pid, jvm);

    await this.activateJvm();
    return { jvm, alreadyAttached: false };
  }

  /**
   * 探测候选端口上是否已有属于该 PID 的常驻 arthas agent（收养场景）：
   * 遍历默认端口区间（与 allocatePorts 同区间，跳过已被本 Gateway 注册的端口），
   * welcome 的 pid 匹配即返回端口对与 arthas 版本；全部不匹配返回 null。
   */
  private async probeAdoptableAgent(
    pid: number,
    usedPorts: ReadonlySet<number>,
  ): Promise<{ telnetPort: number; httpPort: number; version: string } | null> {
    for (let offset = 0; offset < 100; offset++) {
      const telnetPort = DEFAULT_TELNET_PORT + offset;
      const httpPort = DEFAULT_HTTP_PORT + offset;
      if (usedPorts.has(telnetPort) || usedPorts.has(httpPort)) continue;
      const info = await this.deps.agentProber.probeJvmInfo(httpPort);
      if (info && info.pid === pid) {
        return { telnetPort, httpPort, version: info.version };
      }
    }
    return null;
  }

  /** 注册现场后的激活动作：启动/刷新 Dashboard、开启存活检测、首次 attach 弹出浏览器。 */
  private async activateJvm(): Promise<void> {
    await this.dashboard.start();
    this.dashboard.publish();
    this.startLivenessWatch();
    if (!this.browserOpened) {
      this.browserOpened = true;
      await this.deps.browserOpener.open(this.dashboard.url);
    }
  }

  /**
   * 在指定 JVM 上执行 arthas 命令，执行前按 ADR-0004 命令分级：
   * - 放行类：直接执行；
   * - 确认类：无令牌时拦截并签发一次性确认令牌（agent 在 chat 转述风险、用户同意后带令牌重发）；
   * - 禁用类（stop/shutdown）：直接拒绝，shutdown 引导走 shutdown_agent 工具。
   * Session 由 Gateway 自动管理：复用空闲终端会话，遇忙（上个超时命令仍在跑）自动开新会话执行，不向 agent 报错。
   * 返回值为剥掉 ANSI 的终端文本输出（去命令回显与结尾提示符）+ timedOut/sessionId 元信息。
   */
  async exec(
    pid: number,
    command: string,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    confirmToken?: string,
  ): Promise<ExecResult> {
    const jvm = this.requireJvm(pid);
    if (jvm.status === 'exited') {
      throw new Error(
        `PID ${pid} 的目标 JVM 已退出，无法继续诊断。请重新调用 list_jvms 让用户选择仍在运行的进程，然后重新 attach。`,
      );
    }

    const grade = gradeCommand(command);
    if (grade === 'forbidden') {
      throw new Error(forbiddenReason(command) ?? `命令被禁用：${command}`);
    }
    if (grade === 'confirm') {
      if (!confirmToken) {
        const confirmation = this.confirmations.create(pid, command, describeRisk(command));
        this.dashboard.publish();
        return {
          requiresConfirmation: true,
          confirmToken: confirmation.token,
          command,
          risk: confirmation.risk,
        };
      }
      if (!this.confirmations.consume(confirmToken, pid, command)) {
        throw new Error('确认令牌无效、已过期或已使用。请重新发起 exec 获取新令牌，并在征得用户同意后重试。');
      }
      this.dashboard.publish();
    }

    // profiler stop 前 best-effort 抓取 collapsed 热点摘要（ADR-0006）：
    // dump 走完整 exec 路径、进入活动流（Dashboard 透明性，有意如此）；
    // dump 失败、无输出文件、读文件失败都静默跳过，绝不影响 stop 命令本身
    const hotspots = isProfilerStopCommand(command) ? await this.collectProfilerHotspots(pid) : undefined;

    // 记录诊断活动流：命令回显先行，终端输出随 WS 帧流式追加，Dashboard 实时可见
    const entry: ActivityEntry = {
      id: ++this.activitySeq,
      command,
      startedAt: new Date().toISOString(),
      state: 'running',
      output: '',
    };
    jvm.activity.push(entry);
    if (jvm.activity.length > MAX_ACTIVITY_ENTRIES) {
      jvm.activity.splice(0, jvm.activity.length - MAX_ACTIVITY_ENTRIES);
    }
    this.dashboard.publish();

    const session = await this.acquireSession(jvm);
    session.busy = true;
    this.dashboard.publish();
    try {
      const raw = await session.term.exec(command, timeoutMs, (chunk) => {
        // 流式原文（含 ANSI，含回显/提示符）先行入流，done/timeout 时再裁剪
        entry.output += chunk;
        this.publishStreamUpdate();
      });
      this.cancelStreamPublish();
      // done/timeout 后裁剪为去掉命令回显与提示符的终端文本（含 ANSI 原文，供 Dashboard 渲染）
      entry.output = trimTerminalOutput(raw.output, command);
      entry.state = raw.timedOut ? 'timeout' : 'done';
      if (!raw.timedOut) {
        session.busy = false;
      }
      this.dashboard.publish();
      const outcome: ExecOutcome = {
        sessionId: session.sessionId,
        output: toAgentOutput(entry.output),
        timedOut: raw.timedOut,
      };
      if (hotspots) outcome.hotspots = hotspots;
      return outcome;
    } catch (error) {
      this.cancelStreamPublish();
      session.busy = false;
      entry.state = 'error';
      entry.error = error instanceof Error ? error.message : String(error);
      // 会话已关闭（WS 断开）时从池中丢弃，后续 exec 自动开新会话
      if (error instanceof TerminalClosedError || session.term.closed) {
        this.dropSession(jvm, session);
      }
      this.dashboard.publish();
      throw error;
    }
  }

  /** 返回该 JVM 的活跃 Session 列表。 */
  sessions(pid: number): SessionInfo[] {
    const jvm = this.requireJvm(pid);
    return jvm.sessions.map((s) => ({ sessionId: s.sessionId, busy: s.busy, createdAt: s.createdAt }));
  }

  /**
   * 中断该 JVM 上所有正在执行命令的 Session（向 WS 会话发送 Ctrl+C，如失控的 watch/trace）。
   * 返回被中断的 sessionId 列表；没有在跑的命令时返回空列表。
   * 中断后提示符未回归的会话视为失效，从池中丢弃。
   */
  async interrupt(pid: number): Promise<string[]> {
    const jvm = this.requireJvm(pid);
    const interrupted: string[] = [];
    for (const session of [...jvm.sessions]) {
      if (!session.busy) continue;
      try {
        await session.term.interrupt();
        session.busy = false;
        interrupted.push(session.sessionId);
      } catch {
        // Ctrl+C 后提示符未回归：会话失效，丢弃（session.term.interrupt 内部已关闭连接）
        this.dropSession(jvm, session);
      }
    }
    if (interrupted.length > 0) this.dashboard.publish();
    return interrupted;
  }

  /**
   * 卸载指定 JVM 上的 arthas agent（Shutdown，确认类操作）。
   * 无令牌时签发一次性确认令牌；带令牌时校验后执行 arthas `shutdown` 命令并移除现场。
   * 卸载后该 JVM 的 exec 返回"未 attach"错误。
   */
  async shutdownAgent(
    pid: number,
    confirmToken?: string,
  ): Promise<{ shutdown: true } | ConfirmationRequired> {
    const jvm = this.requireJvm(pid);
    const command = `shutdown_agent(pid=${pid})`;
    const risk = '从目标 JVM 中完全移除 arthas agent：所有会话与正在执行的诊断命令立即终止，需重新 attach 才能继续诊断。';
    if (!confirmToken) {
      const confirmation = this.confirmations.create(pid, command, risk);
      this.dashboard.publish();
      return { requiresConfirmation: true, confirmToken: confirmation.token, command, risk: confirmation.risk };
    }
    if (!this.confirmations.consume(confirmToken, pid, command)) {
      throw new Error('确认令牌无效、已过期或已使用。请重新调用 shutdown_agent 获取新令牌，并在征得用户同意后重试。');
    }

    await this.unloadAgent(jvm);
    return { shutdown: true };
  }

  /**
   * Dashboard 自助卸载入口：人在页面上已二次确认（confirm 弹窗），不再走令牌流程。
   * 返回 null 表示成功，否则为给人看的错误信息。
   */
  async shutdownFromDashboard(pid: number): Promise<string | null> {
    const jvm = this.registry.get(pid);
    if (!jvm) return `PID ${pid} 未 attach。`;
    await this.unloadAgent(jvm);
    return null;
  }

  /** 执行卸载：经终端会话发送 arthas `shutdown` 命令移除 agent 并清理现场（agent 自卸载导致的连接断开属预期）。 */
  private async unloadAgent(jvm: AttachedJvm): Promise<void> {
    try {
      const session = await this.acquireSession(jvm);
      await session.term.exec('shutdown', 10_000, () => {});
    } catch {
      // agent 自卸载导致连接中断是正常路径
    }
    this.closeSessions(jvm);
    this.registry.delete(jvm.pid);
    this.dashboard.publish();
  }

  /** 启动周期性 JVM 存活检测（幂等；定时器 unref，不阻碍 Gateway 退出）。 */
  private startLivenessWatch(): void {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => this.checkLiveness(), this.livenessIntervalMs);
    this.livenessTimer.unref();
  }

  /**
   * 检测所有已 attach JVM 的存活状态：进程退出的标记为 exited 并推送 Dashboard（标灰）。
   * 返回新检测到退出的 PID 列表。
   */
  checkLiveness(): number[] {
    const exited: number[] = [];
    for (const jvm of this.registry.values()) {
      if (jvm.status === 'attached' && !this.processProbe.isAlive(jvm.pid)) {
        jvm.status = 'exited';
        exited.push(jvm.pid);
      }
    }
    if (exited.length > 0) this.dashboard.publish();
    return exited;
  }

  /** 取一个空闲终端会话，没有则新建（WS 终端会话同时只跑一条命令，遇忙开新会话）；新建后 Dashboard 会话数同步更新。 */
  private async acquireSession(jvm: AttachedJvm): Promise<PooledSession> {
    const idle = jvm.sessions.find((s) => !s.busy && !s.term.closed);
    if (idle) return idle;
    const term = await this.deps.terminal.openSession(jvm.httpPort);
    const session: PooledSession = {
      sessionId: term.id,
      busy: false,
      createdAt: new Date().toISOString(),
      term,
    };
    jvm.sessions.push(session);
    this.dashboard.publish();
    return session;
  }

  /** 从会话池中丢弃失效会话并推送 Dashboard。 */
  private dropSession(jvm: AttachedJvm, session: PooledSession): void {
    const index = jvm.sessions.indexOf(session);
    if (index >= 0) jvm.sessions.splice(index, 1);
  }

  /** 关闭该 JVM 会话池里的全部终端会话连接。 */
  private closeSessions(jvm: AttachedJvm): void {
    for (const session of jvm.sessions) session.term.close();
    jvm.sessions = [];
  }

  /**
   * 活动流流式更新：高频终端帧（watch 期间 1 字节帧）合并为每周期一次全量快照推送，
   * 周期内多次追加只触发一次；命令结束/出错时以最终 publish 兜底，不会丢终态。
   */
  private publishStreamUpdate(): void {
    if (this.streamPublishTimer) return;
    this.streamPublishTimer = setTimeout(() => {
      this.streamPublishTimer = null;
      this.dashboard.publish();
    }, STREAM_PUBLISH_INTERVAL_MS);
    this.streamPublishTimer.unref();
  }

  /** 取消未触发的流式推送合并定时器（exec 结束/出错时调用，随后紧跟一次即时推送）。 */
  private cancelStreamPublish(): void {
    if (this.streamPublishTimer) {
      clearTimeout(this.streamPublishTimer);
      this.streamPublishTimer = null;
    }
  }

  /**
   * best-effort 抓取 profiler collapsed 热点摘要：内部执行 `profiler dump --format collapsed`
   * （profiler 在放行白名单内，递归走完整 exec 路径不会触发确认），从其终端文本输出中提取输出文件并解析。
   * 任何失败（dump 失败、无输出文件、读文件失败）都返回 undefined 静默跳过。
   */
  private async collectProfilerHotspots(pid: number): Promise<CollapsedSummary | undefined> {
    try {
      const outcome = await this.exec(pid, 'profiler dump --format collapsed', 15_000);
      if ('requiresConfirmation' in outcome) return undefined;
      const outputFile = extractCollapsedOutputFile(outcome.output);
      if (!outputFile) return undefined;
      return parseCollapsed(await readFile(outputFile, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** 按 PID 取已 attach 的 JVM；未 attach 抛明确错误。 */
  private requireJvm(pid: number): AttachedJvm {
    const jvm = this.registry.get(pid);
    if (!jvm) {
      throw new Error(`PID ${pid} 未 attach。请先对用户确认的进程调用 attach。`);
    }
    return jvm;
  }

  /** 按 PID 取已 attach 的 JVM；未 attach 返回 undefined。 */
  getAttachedJvm(pid: number): AttachedJvm | undefined {
    return this.registry.get(pid);
  }

  /** Dashboard 访问地址（未启动为 null）。 */
  get dashboardUrl(): string | null {
    return this.dashboard.started ? this.dashboard.url : null;
  }

  /** Dashboard 全量快照。 */
  snapshot(): DashboardSnapshot {
    return {
      gatewayVersion: GATEWAY_VERSION,
      jvms: [...this.registry.values()].map(
        (jvm): JvmCardState => ({
          pid: jvm.pid,
          name: jvm.name,
          telnetPort: jvm.telnetPort,
          httpPort: jvm.httpPort,
          attachedAt: jvm.attachedAt,
          arthasVersion: jvm.arthasVersion,
          sessionCount: jvm.sessions.length,
          pendingConfirmations: this.confirmations.pendingCount(jvm.pid),
          status: jvm.status,
          activity: jvm.activity,
        }),
      ),
    };
  }

  /** 关闭 Dashboard、存活检测与全部终端会话（Gateway 退出时用；不卸载任何 arthas agent）。 */
  async close(): Promise<void> {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    this.cancelStreamPublish();
    for (const jvm of this.registry.values()) this.closeSessions(jvm);
    await this.dashboard.close();
  }
}

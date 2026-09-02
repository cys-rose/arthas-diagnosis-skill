/**
 * arthas HTTP API 的收养探测（ADR-0006）：init_session 后拉 welcome 结果项解析常驻 agent 的 JVM 信息。
 * exec 主通道已切换到 WS 终端（src/arthas/terminal.ts，ADR-0009），HTTP API 仅保留收养探测用途；attach 就绪探测（attacher.ts 的 HTTP GET /）不属于此接缝。
 */

/** 探测到的常驻 arthas agent 所属 JVM 信息（来自 welcome 结果项）。 */
export interface ProbedJvmInfo {
  pid: number;
  mainClass: string;
  /** arthas 版本（welcome 的 version 字段）。 */
  version: string;
}

/**
 * agent 收养探测接缝：测试用 stub 替代真实 HTTP 调用。
 * 用于 Gateway 重启后收养目标 JVM 里常驻的 agent（ADR-0006）。
 */
export interface AgentProber {
  /**
   * 探测该端口上是否有活跃的 arthas agent：init_session 后拉 welcome 结果项解析 JVM 信息。
   * 任何网络错误/超时/非 arthas 服务都返回 null，不抛异常。
   */
  probeJvmInfo(httpPort: number): Promise<ProbedJvmInfo | null>;
}

interface ApiResponse {
  body?: Record<string, unknown> & { results?: unknown[] };
  /** init_session 的字段是平铺在顶层的（camelCase）。 */
  sessionId?: string;
  consumerId?: string;
}

/** 真实实现：fetch POST http://127.0.0.1:<port>/api。 */
export class HttpAgentProber implements AgentProber {
  /** POST 到 arthas HTTP API，返回解析后的 JSON；解析失败/非 JSON 抛错。 */
  private async post(httpPort: number, payload: Record<string, unknown>, timeoutMs: number): Promise<ApiResponse> {
    const response = await fetch(`http://127.0.0.1:${httpPort}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await response.json()) as ApiResponse;
  }

  /**
   * 探测端口上的活跃 arthas agent：init_session 后拉取 welcome 结果项
   * （实测 arthas 4.x：init_session 后首次 pull_results 即含 {type:'welcome', pid, mainClass, version}，
   * 无需执行任何命令）。用短超时（800ms）——本机未监听端口 connection refused 是即时的，
   * 批量探测 100 个候选端口也不会慢；任何异常一律返回 null。
   */
  async probeJvmInfo(httpPort: number): Promise<ProbedJvmInfo | null> {
    try {
      const init = await this.post(httpPort, { action: 'init_session' }, 800);
      const sessionId = init.sessionId ?? init.body?.['session_id'];
      const consumerId = init.consumerId ?? init.body?.['consumer_id'];
      if (typeof sessionId !== 'string' || typeof consumerId !== 'string') return null;
      // welcome 项通常在首次 pull_results 就有，兜底在约 1.5s 内重试几次
      const deadline = Date.now() + 1500;
      do {
        const json = await this.post(httpPort, { action: 'pull_results', sessionId, consumerId }, 800);
        const results = (json.body?.results ?? []) as unknown[];
        const welcome = results.find(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && (item as Record<string, unknown>)['type'] === 'welcome',
        );
        if (welcome) {
          const pid = Number(welcome['pid']);
          if (!Number.isInteger(pid)) return null;
          return { pid, mainClass: String(welcome['mainClass'] ?? ''), version: String(welcome['version'] ?? '') };
        }
        await new Promise((r) => setTimeout(r, 300));
      } while (Date.now() < deadline);
      return null;
    } catch {
      return null;
    }
  }
}

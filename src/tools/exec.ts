import type { Gateway } from '../gateway.ts';
import { err, ok, type ToolResult } from './result.ts';

/**
 * exec 工具处理函数：在已 attach 的 Target JVM 上执行 arthas 命令。
 * - 观察类命令直接放行，返回剥掉 ANSI 的终端文本输出（output）+ timedOut/sessionId 元信息；
 * - 确认类命令首次调用被拦截，返回 requiresConfirmation + 一次性令牌 + 风险说明，
 *   agent 应在 chat 中向用户转述风险，征得同意后带 confirmToken 重发；
 * - 命令超时未结束时 timedOut=true，提示可用 interrupt 中断。
 */
export async function handleExec(
  gateway: Gateway,
  args: { pid: number; command: string; timeoutMs?: number | undefined; confirmToken?: string | undefined },
): Promise<ToolResult> {
  try {
    const result = await gateway.exec(args.pid, args.command, args.timeoutMs, args.confirmToken);
    if ('requiresConfirmation' in result) {
      return ok({
        requiresConfirmation: true,
        confirmToken: result.confirmToken,
        command: result.command,
        risk: result.risk,
        instruction:
          '该命令属于确认类（写/高危）。请在 chat 中向用户转述上述风险并征得明确同意；用户同意后，携带 confirmToken 重新调用 exec（令牌一次性、5 分钟过期）。',
      });
    }
    return ok({
      sessionId: result.sessionId,
      timedOut: result.timedOut,
      output: result.output,
      // profiler stop 自动附带的 collapsed 热点摘要（未触发或抓取失败时缺省）
      ...(result.hotspots ? { hotspots: result.hotspots } : {}),
      ...(result.timedOut
        ? { note: '命令在超时前未结束，仍在执行中。可用 interrupt 中断该 JVM 上正在运行的命令。' }
        : {}),
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

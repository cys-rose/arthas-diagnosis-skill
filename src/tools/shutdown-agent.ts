import type { Gateway } from '../gateway.ts';
import { err, ok, type ToolResult } from './result.ts';

/**
 * shutdown_agent 工具处理函数：卸载指定 JVM 上的 arthas agent（Shutdown）。
 * 确认类操作：首次调用返回 requiresConfirmation + 一次性令牌 + 风险说明；
 * agent 在 chat 中向用户转述并征得同意后，带 confirmToken 重发才真正卸载。
 */
export async function handleShutdownAgent(
  gateway: Gateway,
  args: { pid: number; confirmToken?: string | undefined },
): Promise<ToolResult> {
  try {
    const result = await gateway.shutdownAgent(args.pid, args.confirmToken);
    if ('requiresConfirmation' in result) {
      return ok({
        requiresConfirmation: true,
        confirmToken: result.confirmToken,
        risk: result.risk,
        instruction:
          '卸载 arthas agent 是确认类操作。请在 chat 中向用户转述上述风险并征得明确同意；用户同意后，携带 confirmToken 重新调用 shutdown_agent（令牌一次性、5 分钟过期）。',
      });
    }
    return ok({ shutdown: true, note: `PID ${args.pid} 上的 arthas agent 已卸载，Dashboard 对应卡片已移除。` });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

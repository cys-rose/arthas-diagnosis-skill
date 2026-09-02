import type { Gateway } from '../gateway.ts';
import { err, ok, type ToolResult } from './result.ts';

/**
 * sessions 工具处理函数：返回该 JVM 的活跃 Session 列表（Gateway 自动管理的诊断会话）。
 */
export async function handleSessions(gateway: Gateway, args: { pid: number }): Promise<ToolResult> {
  try {
    return ok({ sessions: gateway.sessions(args.pid) });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

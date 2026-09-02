import type { Gateway } from '../gateway.ts';
import { err, ok, type ToolResult } from './result.ts';

/**
 * interrupt 工具处理函数：中断该 JVM 上正在运行的命令（如失控的 watch/trace）。
 */
export async function handleInterrupt(gateway: Gateway, args: { pid: number }): Promise<ToolResult> {
  try {
    const interrupted = await gateway.interrupt(args.pid);
    if (interrupted.length === 0) {
      return ok({ interrupted: [], note: '该 JVM 上没有正在执行的命令。' });
    }
    return ok({ interrupted, note: `已中断 ${interrupted.length} 个 Session 上正在执行的命令，会话恢复可用。` });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

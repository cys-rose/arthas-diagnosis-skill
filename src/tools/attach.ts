import type { Gateway } from '../gateway.ts';
import { err, ok, type ToolResult } from './result.ts';

/**
 * attach 工具处理函数：对指定 PID 的 Target JVM 完成 attach。
 * 幂等；成功后自动弹出 Dashboard。失败返回带明确原因的错误结果。
 */
export async function handleAttach(gateway: Gateway, args: { pid: number }): Promise<ToolResult> {
  try {
    const { jvm, alreadyAttached } = await gateway.attach(args.pid);
    return ok({
      pid: jvm.pid,
      name: jvm.name,
      telnetPort: jvm.telnetPort,
      httpPort: jvm.httpPort,
      attachedAt: jvm.attachedAt,
      arthasVersion: jvm.arthasVersion,
      alreadyAttached,
      dashboardUrl: gateway.dashboardUrl,
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

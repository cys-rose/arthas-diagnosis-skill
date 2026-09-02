import type { Gateway } from '../gateway.ts';
import { ok, type ToolResult } from './result.ts';

/**
 * list_jvms 工具处理函数：返回本机 Java 进程列表（PID + 主类/jar 名）。
 * 无进程时返回空列表而非报错。
 */
export async function handleListJvms(gateway: Gateway): Promise<ToolResult> {
  const jvms = await gateway.listJvms();
  return ok({ jvms });
}

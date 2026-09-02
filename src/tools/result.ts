import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** MCP 工具返回值的最小形状，与 SDK 的 CallToolResult 兼容。 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** 注册到 MCP SDK 时做一次边界类型适配（SDK 要求索引签名）。 */
export function asCallToolResult(result: ToolResult): CallToolResult {
  return result as CallToolResult;
}

/** 把任意可 JSON 化的数据包成文本工具结果。 */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** 包成错误工具结果（MCP isError 语义）。 */
export function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }] };
}

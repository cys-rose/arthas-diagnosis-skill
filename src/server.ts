import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Gateway, type GatewayDeps } from './gateway.ts';
import { handleListJvms } from './tools/list-jvms.ts';
import { handleAttach } from './tools/attach.ts';
import { handleExec } from './tools/exec.ts';
import { handleSessions } from './tools/sessions.ts';
import { handleInterrupt } from './tools/interrupt.ts';
import { handleShutdownAgent } from './tools/shutdown-agent.ts';
import { asCallToolResult } from './tools/result.ts';
import { GATEWAY_VERSION } from './version.ts';

/**
 * 组装 MCP server：注册工具（ADR-0005 的 6 个工具面随 ticket 推进逐个落地）。
 * 返回 server 与 gateway，便于测试与入口复用。
 */
export function createMcpServer(deps: GatewayDeps): { server: McpServer; gateway: Gateway } {
  const gateway = new Gateway(deps);
  const server = new McpServer(
    { name: 'arthas-diagnostic-gateway', version: GATEWAY_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'list_jvms',
    {
      description:
        '列出本机所有可被诊断的 Java 进程（Target JVM 候选），返回 PID 与主类/jar 名。诊断前先调用它，并把列表交给用户选择目标进程。',
      inputSchema: {},
    },
    () => handleListJvms(gateway).then(asCallToolResult),
  );

  server.registerTool(
    'attach',
    {
      description:
        '对用户指定的 Target JVM 执行 attach（幂等）。attach 后 arthas agent 常驻目标 JVM，浏览器自动弹出 Dashboard 供人实时观察。仅在用户明确指定进程后调用。',
      inputSchema: { pid: z.number().int().positive().describe('目标 Java 进程的 PID（来自 list_jvms，需用户确认）') },
    },
    (args) => handleAttach(gateway, args).then(asCallToolResult),
  );

  server.registerTool(
    'exec',
    {
      description:
        '在已 attach 的 Target JVM 上执行 arthas 命令，返回剥掉 ANSI 的终端文本输出（output）+ timedOut/sessionId 元信息。Session 由 Gateway 自动管理（遇忙自动开新 Session）。写/高危命令（ognl/redefine/heapdump 等）会被拦截并返回 confirmToken——必须先在 chat 中向用户转述风险、征得明确同意后带 confirmToken 重发。命令在 timeoutMs 内未结束时返回 timedOut=true，可用 interrupt 中断。',
      inputSchema: {
        pid: z.number().int().positive().describe('已 attach 的 Target JVM 的 PID'),
        command: z.string().min(1).describe('arthas 命令，如 "thread -n 3"、"watch demo.MathGame primeFactors"'),
        timeoutMs: z.number().int().positive().optional().describe('等待命令结束的超时毫秒数，默认 30000'),
        confirmToken: z.string().optional().describe('用户确认后重发时携带的一次性确认令牌（由上一次 exec 返回）'),
      },
    },
    (args) => handleExec(gateway, args).then(asCallToolResult),
  );

  server.registerTool(
    'sessions',
    {
      description: '返回指定 Target JVM 的活跃 Session 列表（Gateway 自动管理，无需 agent 显式开关）。',
      inputSchema: { pid: z.number().int().positive().describe('已 attach 的 Target JVM 的 PID') },
    },
    (args) => handleSessions(gateway, args).then(asCallToolResult),
  );

  server.registerTool(
    'interrupt',
    {
      description: '中断指定 Target JVM 上正在运行的命令（如失控的 watch/trace），长任务 Session 恢复可用。',
      inputSchema: { pid: z.number().int().positive().describe('已 attach 的 Target JVM 的 PID') },
    },
    (args) => handleInterrupt(gateway, args).then(asCallToolResult),
  );

  server.registerTool(
    'shutdown_agent',
    {
      description:
        '从指定 Target JVM 上完全卸载 arthas agent（Shutdown）。确认类操作：首次调用返回 confirmToken 与风险说明，必须征得用户明确同意后带 confirmToken 重发才真正执行。诊断结束时应询问用户是否卸载。',
      inputSchema: {
        pid: z.number().int().positive().describe('已 attach 的 Target JVM 的 PID'),
        confirmToken: z.string().optional().describe('用户确认后重发时携带的一次性确认令牌'),
      },
    },
    (args) => handleShutdownAgent(gateway, args).then(asCallToolResult),
  );

  return { server, gateway };
}

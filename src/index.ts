#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.ts';
import { JpsLister } from './process-listing.ts';
import { LocalArthasLocator } from './arthas/locator.ts';
import { ArthasBootAttacher } from './arthas/attacher.ts';
import { HttpAgentProber } from './arthas/http-api.ts';
import { WsTerminalChannel } from './arthas/terminal.ts';
import { SystemBrowserOpener } from './browser.ts';

/**
 * Gateway 入口：stdio 接入对话式 agent。
 * Gateway 不常驻——由 agent 按需拉起；客户端会话结束（stdin 关闭）或收到 SIGINT/SIGTERM 即退出。
 * 退出时不卸载任何 arthas agent（agent 常驻目标 JVM，靠收养机制复用，见 ADR-0006）。
 */
async function main(): Promise<void> {
  const arthasLocator = new LocalArthasLocator();
  // 启动时校验本地 arthas 版本（>= 4.x）；失败不阻断 MCP 接入，但 attach 会返回同样原因
  await arthasLocator.locate().catch((error: unknown) => {
    console.error(`[gateway] arthas 安装校验失败：${error instanceof Error ? error.message : String(error)}`);
  });
  const { server, gateway } = createMcpServer({
    processLister: new JpsLister(),
    arthasLocator,
    attacher: new ArthasBootAttacher(),
    terminal: new WsTerminalChannel(),
    agentProber: new HttpAgentProber(),
    browserOpener: new SystemBrowserOpener(),
    // Dashboard「关闭 Gateway」按钮：复用会话结束的同一退出路径（关闭 Dashboard、退出进程，不卸载 agent）
    onExitRequest: () => void shutdown(),
  });
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await gateway.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // 客户端会话结束/被杀时 stdio 管道关闭：随之退出，避免残留进程占用 Dashboard 端口
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error('Gateway failed to start:', error);
  process.exit(1);
});

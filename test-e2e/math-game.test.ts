import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { JpsLister } from '../src/process-listing.ts';
import { LocalArthasLocator } from '../src/arthas/locator.ts';
import { ArthasBootAttacher } from '../src/arthas/attacher.ts';
import { HttpAgentProber } from '../src/arthas/http-api.ts';
import { WsTerminalChannel } from '../src/arthas/terminal.ts';
import type { BrowserOpener } from '../src/browser.ts';
import { handleExec } from '../src/tools/exec.ts';
import { handleSessions } from '../src/tools/sessions.ts';

/**
 * 真实链路 e2e：math-game（arthas 自带）起真实 JVM，真实 attach + exec（走 WS 终端通道，ADR-0009）。
 * 需要本机已安装 arthas 4.x（~/.arthas）；端口由 allocatePorts 自动跳过被占用者。
 */

const MATH_GAME_JAR = join(homedir(), '.arthas', 'lib', '4.3.4', 'arthas', 'math-game.jar');

const noopOpener: BrowserOpener = { open: async () => {} };

let mathGame: ChildProcess | null = null;
let gateway: Gateway;
let mathGamePid: number;

/** 轮询 jps 直到 math-game 进程出现（jps -l 对 jar 启动的进程显示 jar 路径）。 */
async function waitForMathGamePid(timeoutMs = 15_000): Promise<number> {
  const lister = new JpsLister();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await lister.list()).find((p) => p.name.includes('math-game.jar'));
    if (found) return found.pid;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('math-game 进程未在限定时间内出现在 jps 列表中');
}

before(async () => {
  mathGame = spawn('java', ['-jar', MATH_GAME_JAR], { stdio: 'ignore' });
  mathGamePid = await waitForMathGamePid();
  gateway = new Gateway({
    processLister: new JpsLister(),
    arthasLocator: new LocalArthasLocator(),
    attacher: new ArthasBootAttacher(),
    terminal: new WsTerminalChannel(),
    agentProber: new HttpAgentProber(),
    browserOpener: noopOpener,
    dashboardPort: 0,
  });
});

after(async () => {
  await gateway?.close();
  mathGame?.kill('SIGKILL');
});

test('e2e：list_jvms 能看到 math-game', async () => {
  const jvms = await gateway.listJvms();
  assert.ok(
    jvms.some((p) => p.pid === mathGamePid && p.name.includes('math-game.jar')),
    `jps 列表应包含 math-game (pid=${mathGamePid})`,
  );
});

test('e2e：真实 attach math-game 并弹出 Dashboard 现场', async () => {
  const { jvm, alreadyAttached } = await gateway.attach(mathGamePid);
  assert.equal(alreadyAttached, false);
  assert.ok(jvm.name.includes('math-game.jar'));
  assert.equal(jvm.arthasVersion, '4.3.4');
  assert.ok(gateway.dashboardUrl);
  // Dashboard 快照包含该 JVM
  const state = await (await fetch(`${gateway.dashboardUrl}api/state`)).json();
  assert.equal(state.jvms[0].pid, mathGamePid);
});

test('e2e：exec memory 经 WS 终端通道返回终端文本（含 ps_eden_space）', async () => {
  const memory = await handleExec(gateway, { pid: mathGamePid, command: 'memory', timeoutMs: 30_000 });
  assert.equal(memory.isError, undefined, memory.content[0]!.text);
  const payload = JSON.parse(memory.content[0]!.text);
  assert.equal(payload.timedOut, false);
  assert.ok(typeof payload.sessionId === 'string' && payload.sessionId.length > 0);
  // 终端文本输出：memory 的表格内容（已剥 ANSI）
  assert.match(payload.output, /ps_eden_space/, `memory 输出应含 ps_eden_space：${payload.output.slice(0, 500)}`);
});

test('e2e：exec thread --all 经 WS 终端通道返回线程列表文本', async () => {
  const thread = await handleExec(gateway, { pid: mathGamePid, command: 'thread --all', timeoutMs: 30_000 });
  assert.equal(thread.isError, undefined, thread.content[0]!.text);
  const payload = JSON.parse(thread.content[0]!.text);
  assert.equal(payload.timedOut, false);
  assert.match(payload.output, /Threads Total/, `thread 输出应含汇总行：${payload.output.slice(0, 500)}`);
});

test('e2e：Dashboard /api/state 活动流实时包含已执行命令与终端输出', async () => {
  const state = await (await fetch(`${gateway.dashboardUrl}api/state`)).json();
  const activity = state.jvms[0].activity;
  assert.ok(Array.isArray(activity) && activity.length >= 2, `活动流应至少有 2 条记录：${JSON.stringify(activity).slice(0, 300)}`);
  const memoryEntry = activity.find((e: { command?: string }) => e.command === 'memory');
  assert.ok(memoryEntry, '活动流应包含 memory 命令回显');
  assert.equal(memoryEntry.state, 'done');
  // 活动流保存含 ANSI 的终端文本原文（Dashboard 还原颜色渲染）
  assert.match(memoryEntry.output, /ps_eden_space/, '活动流应累积 memory 的终端文本输出');
});

test('e2e：sessions 返回真实活跃 Session', async () => {
  const result = await handleSessions(gateway, { pid: mathGamePid });
  const payload = JSON.parse(result.content[0]!.text);
  assert.ok(payload.sessions.length >= 1);
  assert.ok(payload.sessions[0].sessionId.length > 0);
});

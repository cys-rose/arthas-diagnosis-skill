import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { handleExec } from '../src/tools/exec.ts';
import { handleSessions } from '../src/tools/sessions.ts';
import { makeStubDeps } from './helpers.ts';

test('exec 经 WS 终端通道执行命令并返回终端文本输出（剥 ANSI）', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleExec(gateway, { pid: 1234, command: 'thread --all' });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.timedOut, false);
    assert.equal(payload.sessionId, 'stub-session-1');
    assert.equal(payload.output, 'stub output');
    assert.deepEqual(terminal.allExecuted(), ['thread --all']);
  } finally {
    await gateway.close();
  }
});

test('exec 返回值剥掉 ANSI、命令回显与结尾提示符', async () => {
  const { deps, terminal } = makeStubDeps();
  terminal.onOpenSession = (session) => {
    session.onExec = (command) => ({
      output: `${command}\r\n\x1b[32mheap\x1b[0m 100\r\n[arthas@1234]$ `,
    });
  };
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleExec(gateway, { pid: 1234, command: 'memory' });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.output, 'heap 100');
  } finally {
    await gateway.close();
  }
});

test('长任务超时后该 Session 保持占用，后续 exec 自动开新 Session', async () => {
  const { deps, terminal } = makeStubDeps();
  terminal.onOpenSession = (session) => {
    if (session.id === 'stub-session-1') {
      // 模拟持续型命令：超时未等到提示符（命令仍在后台执行，会话保持 busy）
      session.onExec = (command) => ({ output: `${command}\r\npartial\r\n`, timedOut: true });
    }
  };
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = await handleExec(gateway, { pid: 1234, command: 'watch demo.MathGame primeFactors', timeoutMs: 500 });
    const firstPayload = JSON.parse(first.content[0]!.text);
    assert.equal(firstPayload.timedOut, true);
    assert.match(firstPayload.note, /interrupt/);

    const second = await handleExec(gateway, { pid: 1234, command: 'thread --all', timeoutMs: 2000 });
    const secondPayload = JSON.parse(second.content[0]!.text);
    assert.equal(secondPayload.timedOut, false);
    assert.notEqual(secondPayload.sessionId, firstPayload.sessionId);
    assert.equal(secondPayload.sessionId, 'stub-session-2');
    assert.equal(gateway.snapshot().jvms[0]!.sessionCount, 2);
  } finally {
    await gateway.close();
  }
});

test('sessions 返回该 JVM 活跃 Session 列表', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    await handleExec(gateway, { pid: 1234, command: 'jvm' });
    const result = await handleSessions(gateway, { pid: 1234 });
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].sessionId, 'stub-session-1');
    assert.equal(payload.sessions[0].busy, false);
    assert.ok(payload.sessions[0].createdAt.length > 0);
  } finally {
    await gateway.close();
  }
});

test('exec 未 attach 的 JVM 返回明确错误', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    const result = await handleExec(gateway, { pid: 4321, command: 'jvm' });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0]!.text).error, /未 attach/);
  } finally {
    await gateway.close();
  }
});

test('sessions 未 attach 的 JVM 返回明确错误', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    const result = await handleSessions(gateway, { pid: 4321 });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0]!.text).error, /未 attach/);
  } finally {
    await gateway.close();
  }
});

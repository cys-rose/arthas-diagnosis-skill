import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { handleExec } from '../src/tools/exec.ts';
import { handleInterrupt } from '../src/tools/interrupt.ts';
import { handleShutdownAgent } from '../src/tools/shutdown-agent.ts';
import { handleSessions } from '../src/tools/sessions.ts';
import { makeStubDeps } from './helpers.ts';

/** 起一个 stub Gateway 并让一条命令进入"执行中"（超时未终态）状态。 */
async function gatewayWithBusySession() {
  const stub = makeStubDeps();
  stub.terminal.onOpenSession = (session) => {
    if (session.id === 'stub-session-1') {
      // 模拟持续型命令：超时未等到提示符（命令仍在后台执行，会话保持 busy）
      session.onExec = (command) => ({ output: `${command}\r\npartial\r\n`, timedOut: true });
    }
  };
  const gateway = new Gateway(stub.deps);
  await gateway.attach(1234);
  const execResult = await handleExec(gateway, { pid: 1234, command: 'watch demo.MathGame primeFactors', timeoutMs: 400 });
  assert.equal(JSON.parse(execResult.content[0]!.text).timedOut, true);
  return { ...stub, gateway };
}

test('interrupt 中断正在执行的命令，长任务 Session 恢复可用', async () => {
  const { gateway, terminal } = await gatewayWithBusySession();
  try {
    const result = await handleInterrupt(gateway, { pid: 1234 });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.deepEqual(payload.interrupted, ['stub-session-1']);
    assert.equal(terminal.sessions[0]!.interruptCount, 1);
    // 会话恢复可用
    const sessions = JSON.parse((await handleSessions(gateway, { pid: 1234 })).content[0]!.text);
    assert.equal(sessions.sessions[0].busy, false);
  } finally {
    await gateway.close();
  }
});

test('interrupt 在没有在跑命令时返回空列表并说明', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleInterrupt(gateway, { pid: 1234 });
    const payload = JSON.parse(result.content[0]!.text);
    assert.deepEqual(payload.interrupted, []);
    assert.match(payload.note, /没有正在执行/);
    assert.equal(terminal.sessions.length, 0);
  } finally {
    await gateway.close();
  }
});

test('interrupt 未 attach 的 JVM 返回明确错误', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    const result = await handleInterrupt(gateway, { pid: 9999 });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0]!.text).error, /未 attach/);
  } finally {
    await gateway.close();
  }
});

test('shutdown_agent 首次调用被拦截：返回令牌与风险说明，agent 未卸载', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleShutdownAgent(gateway, { pid: 1234 });
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.requiresConfirmation, true);
    assert.ok(payload.confirmToken.length > 0);
    assert.match(payload.risk, /移除 arthas agent/);
    // 未执行 shutdown，现场还在
    assert.equal(terminal.allExecuted().filter((c) => c === 'shutdown').length, 0);
    assert.ok(gateway.getAttachedJvm(1234));
    assert.equal(gateway.snapshot().jvms[0]!.pendingConfirmations, 1);
  } finally {
    await gateway.close();
  }
});

test('shutdown_agent 带令牌确认后卸载：arthas 收到 shutdown，Dashboard 卡片移除', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = JSON.parse((await handleShutdownAgent(gateway, { pid: 1234 })).content[0]!.text);
    const confirmed = await handleShutdownAgent(gateway, { pid: 1234, confirmToken: first.confirmToken });
    assert.equal(confirmed.isError, undefined);
    assert.equal(JSON.parse(confirmed.content[0]!.text).shutdown, true);
    // arthas 侧收到 shutdown 命令
    assert.equal(terminal.allExecuted().filter((c) => c === 'shutdown').length, 1);
    // 现场移除
    assert.equal(gateway.getAttachedJvm(1234), undefined);
    assert.equal(gateway.snapshot().jvms.length, 0);
  } finally {
    await gateway.close();
  }
});

test('shutdown_agent 令牌复用被拒绝', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = JSON.parse((await handleShutdownAgent(gateway, { pid: 1234 })).content[0]!.text);
    await handleShutdownAgent(gateway, { pid: 1234, confirmToken: first.confirmToken });
    await gateway.attach(1234);
    const reuse = await handleShutdownAgent(gateway, { pid: 1234, confirmToken: first.confirmToken });
    assert.equal(reuse.isError, true);
    assert.match(JSON.parse(reuse.content[0]!.text).error, /令牌无效/);
  } finally {
    await gateway.close();
  }
});

test('卸载后再 exec 该 JVM 返回"未 attach"的明确错误', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = JSON.parse((await handleShutdownAgent(gateway, { pid: 1234 })).content[0]!.text);
    await handleShutdownAgent(gateway, { pid: 1234, confirmToken: first.confirmToken });
    const result = await handleExec(gateway, { pid: 1234, command: 'jvm' });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0]!.text).error, /未 attach/);
  } finally {
    await gateway.close();
  }
});

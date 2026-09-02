import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { handleExec } from '../src/tools/exec.ts';
import { makeStubDeps } from './helpers.ts';

/** 可控的进程存活探测 stub。 */
function probeWith(deadPids: Set<number>) {
  return { isAlive: (pid: number) => !deadPids.has(pid) };
}

test('目标 JVM 退出后：快照标记 exited（Dashboard 标灰对应 console）', async () => {
  const dead = new Set<number>();
  const { deps } = makeStubDeps();
  deps.processProbe = probeWith(dead);
  deps.livenessIntervalMs = 60_000; // 手动触发
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    dead.add(1234);
    const exited = gateway.checkLiveness();
    assert.deepEqual(exited, [1234]);
    const card = gateway.snapshot().jvms[0]!;
    assert.equal(card.status, 'exited');
    // 重复检测不重复上报
    assert.deepEqual(gateway.checkLiveness(), []);
  } finally {
    await gateway.close();
  }
});

test('JVM 退出后再 exec 收到明确错误并引导重新 list_jvms', async () => {
  const dead = new Set<number>();
  const { deps, terminal } = makeStubDeps();
  deps.processProbe = probeWith(dead);
  deps.livenessIntervalMs = 60_000;
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    dead.add(1234);
    gateway.checkLiveness();
    const result = await handleExec(gateway, { pid: 1234, command: 'jvm' });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0]!.text).error;
    assert.match(error, /已退出/);
    assert.match(error, /list_jvms/);
    assert.equal(terminal.allExecuted().length, 0);
  } finally {
    await gateway.close();
  }
});

test('Dashboard 页面呈现 Gateway 离线标注与自助卸载入口（用户可见文本）', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const html = await (await fetch(gateway.dashboardUrl!)).text();
    const clientJs = await (await fetch(`${gateway.dashboardUrl}client.js`)).text();
    // 只断言用户可见内容，不断言页面内部实现（文案分布在页面骨架与 client.js 两处）
    assert.match(html, /Gateway 在线/);
    assert.match(html, /关闭 Gateway/);
    assert.match(clientJs, /Gateway 已离线/);
    assert.match(clientJs, /卸载 arthas agent/);
  } finally {
    await gateway.close();
  }
});

test('自助卸载端点：POST 触发卸载，效果与 shutdown_agent 一致', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const response = await fetch(`${gateway.dashboardUrl}api/jvms/1234/shutdown`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(terminal.allExecuted().filter((c) => c === 'shutdown').length, 1);
    assert.equal(gateway.getAttachedJvm(1234), undefined);
    assert.equal(gateway.snapshot().jvms.length, 0);
  } finally {
    await gateway.close();
  }
});

test('自助卸载端点：未 attach 的 PID 返回 400 与原因', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const response = await fetch(`${gateway.dashboardUrl}api/jvms/9999/shutdown`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /未 attach/);
  } finally {
    await gateway.close();
  }
});

test('目标 JVM 退出后重新 attach 同一 PID：清掉陈旧现场并真实重挂', async () => {
  const dead = new Set<number>();
  const { deps, attacher } = makeStubDeps();
  deps.processProbe = probeWith(dead);
  deps.livenessIntervalMs = 60_000;
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    dead.add(1234);
    gateway.checkLiveness();
    assert.equal(gateway.snapshot().jvms[0]!.status, 'exited');

    // PID 被新进程复用，再次 attach 应真正重新执行 arthas-boot
    dead.delete(1234);
    const { jvm, alreadyAttached } = await gateway.attach(1234);
    assert.equal(alreadyAttached, false);
    assert.equal(jvm.status, 'attached');
    assert.equal(attacher.calls.length, 2);
    assert.equal(gateway.snapshot().jvms[0]!.status, 'attached');
  } finally {
    await gateway.close();
  }
});

test('Gateway 退出（close）不自动卸载任何 arthas agent', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  await gateway.attach(1234);
  await gateway.close();
  assert.equal(terminal.allExecuted().filter((c) => c === 'shutdown').length, 0);
});

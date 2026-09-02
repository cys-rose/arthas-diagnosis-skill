import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { handleExec } from '../src/tools/exec.ts';
import { describeRisk, gradeCommand } from '../src/grading.ts';
import { ConfirmationManager } from '../src/confirmation.ts';
import { makeStubDeps } from './helpers.ts';

test('观察类清单命令直接放行', () => {
  for (const cmd of ['dashboard -n 1', 'thread -n 3', 'thread --all', 'jvm', 'memory', 'sc demo.*', 'sm demo.MathGame', 'jad demo.MathGame', 'watch demo.MathGame primeFactors', 'trace demo.MathGame run', 'stack demo.MathGame run', 'monitor -c 5 demo.MathGame run', 'tt -t demo.MathGame primeFactors', 'profiler start', 'getstatic demo.MathGame random', 'sysprop', 'sysenv', 'perfcounter', 'mbean']) {
    assert.equal(gradeCommand(cmd), 'allow', `${cmd} 应放行`);
  }
});

test('确认类清单命令被分级为确认', () => {
  for (const cmd of ['ognl @demo.MathGame@random', 'redefine /tmp/A.class', 'retransform /tmp/A.class', 'mc /tmp/A.java', 'heapdump /tmp/dump.hprof', 'vmtool --action forceGc', 'vmoption PrintGC true', 'reset', 'options unsafe true']) {
    assert.equal(gradeCommand(cmd), 'confirm', `${cmd} 应需确认`);
  }
});

test('stop / shutdown / quit / exit 被分级为禁用', () => {
  assert.equal(gradeCommand('stop'), 'forbidden');
  assert.equal(gradeCommand('shutdown'), 'forbidden');
  // quit/exit 会关闭 arthas 会话，与 Gateway 的会话自动管理冲突
  assert.equal(gradeCommand('quit'), 'forbidden');
  assert.equal(gradeCommand('exit'), 'forbidden');
});

test('复合命令取最严分级；清单外命令按确认类保守处理', () => {
  assert.equal(gradeCommand('thread --all; ognl @x@y'), 'confirm');
  assert.equal(gradeCommand('thread --all; stop'), 'forbidden');
  assert.equal(gradeCommand('some-unknown-command arg'), 'confirm');
});

test('风险说明覆盖确认类命令', () => {
  assert.match(describeRisk('heapdump /tmp/dump.hprof'), /停顿/);
  assert.match(describeRisk('some-unknown-command'), /白名单/);
  assert.equal(describeRisk('thread --all'), '');
});

test('确认类命令首次 exec 被拦截：返回令牌与风险说明，命令未到达 arthas', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleExec(gateway, { pid: 1234, command: 'heapdump /tmp/dump.hprof' });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.requiresConfirmation, true);
    assert.ok(payload.confirmToken.length > 0);
    assert.match(payload.risk, /停顿/);
    assert.match(payload.instruction, /转述/);
    // 未真正执行
    assert.equal(terminal.allExecuted().length, 0);
    // Dashboard 待确认数 +1
    assert.equal(gateway.snapshot().jvms[0]!.pendingConfirmations, 1);
  } finally {
    await gateway.close();
  }
});

test('用户同意后带令牌重发：校验通过并执行，待确认数归零', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = JSON.parse((await handleExec(gateway, { pid: 1234, command: 'heapdump /tmp/dump.hprof' })).content[0]!.text);
    const retry = await handleExec(gateway, {
      pid: 1234,
      command: 'heapdump /tmp/dump.hprof',
      confirmToken: first.confirmToken,
    });
    assert.equal(retry.isError, undefined);
    const payload = JSON.parse(retry.content[0]!.text);
    assert.equal(payload.requiresConfirmation, undefined);
    assert.equal(terminal.allExecuted().length, 1);
    assert.equal(gateway.snapshot().jvms[0]!.pendingConfirmations, 0);
  } finally {
    await gateway.close();
  }
});

test('确认令牌一次性：复用被拒绝', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = JSON.parse((await handleExec(gateway, { pid: 1234, command: 'reset' })).content[0]!.text);
    await handleExec(gateway, { pid: 1234, command: 'reset', confirmToken: first.confirmToken });
    const reuse = await handleExec(gateway, { pid: 1234, command: 'reset', confirmToken: first.confirmToken });
    assert.equal(reuse.isError, true);
    assert.match(JSON.parse(reuse.content[0]!.text).error, /令牌无效/);
    assert.equal(terminal.allExecuted().length, 1);
  } finally {
    await gateway.close();
  }
});

test('令牌绑定 PID 与命令：换命令重发被拒绝', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const first = JSON.parse((await handleExec(gateway, { pid: 1234, command: 'reset' })).content[0]!.text);
    const swapped = await handleExec(gateway, { pid: 1234, command: 'heapdump /tmp/x.hprof', confirmToken: first.confirmToken });
    assert.equal(swapped.isError, true);
    assert.equal(terminal.allExecuted().length, 0);
  } finally {
    await gateway.close();
  }
});

test('令牌过期被拒绝（ConfirmationManager 单元）', () => {
  const manager = new ConfirmationManager();
  const past = Date.now() - 10 * 60 * 1000;
  const c = manager.create(1234, 'reset', '风险', past);
  assert.equal(manager.consume(c.token, 1234, 'reset'), false);
});

test('stop 作为普通命令被拒绝（arthas 侧另有静态禁死兜底）', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleExec(gateway, { pid: 1234, command: 'stop' });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0]!.text).error, /禁用/);
    assert.equal(terminal.allExecuted().length, 0);
  } finally {
    await gateway.close();
  }
});

test('shutdown 作为普通命令被拒绝并引导走专门卸载工具', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleExec(gateway, { pid: 1234, command: 'shutdown' });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0]!.text).error;
    assert.match(error, /shutdown_agent/);
    assert.equal(terminal.allExecuted().length, 0);
  } finally {
    await gateway.close();
  }
});

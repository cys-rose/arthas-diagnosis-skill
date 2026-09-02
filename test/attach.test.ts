import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { handleAttach } from '../src/tools/attach.ts';
import { AttachError } from '../src/arthas/attacher.ts';
import { DEFAULT_HTTP_PORT, DEFAULT_TELNET_PORT } from '../src/ports.ts';
import { FAKE_INSTALL, makeStubDeps, stubLocator } from './helpers.ts';

test('attach 成功：编排 arthas-boot 并弹出 Dashboard', async () => {
  const { deps, attacher, opener } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    const result = await handleAttach(gateway, { pid: 1234 });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.pid, 1234);
    assert.equal(payload.name, 'com.example.Main');
    assert.equal(payload.arthasVersion, '4.3.4');
    assert.equal(payload.alreadyAttached, false);
    assert.ok(payload.dashboardUrl.startsWith('http://127.0.0.1:'));

    // arthas-boot 调用带分配的端口；disabledCommands=stop 在真实 attacher 内拼装（e2e 覆盖）
    assert.equal(attacher.calls.length, 1);
    assert.equal(attacher.calls[0]!.pid, 1234);
    assert.equal(typeof attacher.calls[0]!.telnetPort, 'number');
    assert.equal(typeof attacher.calls[0]!.httpPort, 'number');

    // 首次 attach 自动弹出浏览器，指向 Dashboard
    assert.deepEqual(opener.openedUrls, [payload.dashboardUrl]);
  } finally {
    await gateway.close();
  }
});

test('attach 幂等：重复 attach 同一 PID 返回既有现场，不重复调 arthas-boot', async () => {
  const { deps, attacher, opener } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await handleAttach(gateway, { pid: 1234 });
    const second = await handleAttach(gateway, { pid: 1234 });
    const payload = JSON.parse(second.content[0]!.text);
    assert.equal(payload.alreadyAttached, true);
    assert.equal(attacher.calls.length, 1);
    assert.equal(opener.openedUrls.length, 1);
  } finally {
    await gateway.close();
  }
});

test('attach 收养：候选端口上已有同 PID 的常驻 agent 时直接收养，不跑 arthas-boot', async () => {
  const { deps, attacher, prober, opener } = makeStubDeps();
  prober.onProbeJvmInfo = (httpPort) =>
    httpPort === DEFAULT_HTTP_PORT ? { pid: 1234, mainClass: 'com.example.Main', version: '4.3.4' } : null;
  const gateway = new Gateway(deps);
  try {
    const result = await handleAttach(gateway, { pid: 1234 });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.alreadyAttached, true);
    // 收养用旧 agent 占用的默认端口对，版本取 welcome 里的 version
    assert.equal(payload.telnetPort, DEFAULT_TELNET_PORT);
    assert.equal(payload.httpPort, DEFAULT_HTTP_PORT);
    assert.equal(payload.arthasVersion, '4.3.4');
    assert.equal(payload.name, 'com.example.Main');
    // 跳过 arthas-boot attach，Dashboard 与浏览器弹出逻辑与正常路径一致
    assert.equal(attacher.calls.length, 0);
    assert.deepEqual(opener.openedUrls, [payload.dashboardUrl]);
  } finally {
    await gateway.close();
  }
});

test('attach 收养未命中（welcome pid 不匹配）时走原有真实 attach 路径', async () => {
  const { deps, attacher, prober } = makeStubDeps();
  prober.onProbeJvmInfo = () => ({ pid: 9999, mainClass: 'com.other.Main', version: '4.3.4' });
  const gateway = new Gateway(deps);
  try {
    const result = await handleAttach(gateway, { pid: 1234 });
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.alreadyAttached, false);
    assert.equal(attacher.calls.length, 1);
    assert.equal(attacher.calls[0]!.pid, 1234);
    assert.ok(prober.probed.length > 0);
  } finally {
    await gateway.close();
  }
});

test('attach 收养未命中（探测全部返回 null）时走原有真实 attach 路径', async () => {
  const { deps, attacher, prober } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    const result = await handleAttach(gateway, { pid: 1234 });
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.alreadyAttached, false);
    assert.equal(attacher.calls.length, 1);
    // 默认端口区间 100 个候选全部探测过
    assert.equal(prober.probed.length, 100);
  } finally {
    await gateway.close();
  }
});

test('attach 失败（进程消失/权限/JDK 问题）返回明确错误原因', async () => {
  const { deps, attacher, opener } = makeStubDeps();
  attacher.onAttach = () => {
    throw new AttachError('arthas-boot 退出码 1。常见原因：目标进程已退出、非 Java 进程、权限不足或 JDK 版本不兼容。');
  };
  const gateway = new Gateway(deps);
  try {
    const result = await handleAttach(gateway, { pid: 9999 });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0]!.text);
    assert.match(payload.error, /退出码 1/);
    // 失败不留现场、不弹浏览器
    assert.equal(gateway.getAttachedJvm(9999), undefined);
    assert.equal(gateway.dashboardUrl, null);
    assert.equal(opener.openedUrls.length, 0);
  } finally {
    await gateway.close();
  }
});

test('本地 arthas 版本过低或缺失时 attach 返回明确错误', async () => {
  const { deps } = makeStubDeps();
  deps.arthasLocator = stubLocator(new Error('本地 arthas 版本 3.7.2 过低，需要 >= 4.x。'));
  const gateway = new Gateway(deps);
  try {
    const result = await handleAttach(gateway, { pid: 1234 });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0]!.text).error, /版本 3\.7\.2 过低/);
  } finally {
    await gateway.close();
  }
});

test('attach 后 Dashboard 快照包含 JVM 卡片数据（PID/进程名/attach 时间/版本）', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await handleAttach(gateway, { pid: 1234 });
    const snapshot = gateway.snapshot();
    assert.equal(snapshot.jvms.length, 1);
    const card = snapshot.jvms[0]!;
    assert.equal(card.pid, 1234);
    assert.equal(card.name, 'com.example.Main');
    assert.ok(card.attachedAt.length > 0);
    assert.equal(card.arthasVersion, FAKE_INSTALL.version);
    assert.equal(card.status, 'attached');
    assert.ok(snapshot.gatewayVersion.length > 0);
  } finally {
    await gateway.close();
  }
});

test('Dashboard HTTP：client.js 内嵌 ?iframe=true console，/api/state 返回快照', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await handleAttach(gateway, { pid: 1234 });
    const base = gateway.dashboardUrl!;
    // console iframe 的拼装逻辑在 client.js（页面骨架只剩结构与样式）
    const clientJs = await (await fetch(`${base}client.js`)).text();
    assert.match(clientJs, /\?iframe=true/);
    const jvm = gateway.getAttachedJvm(1234)!;
    const state = await (await fetch(`${base}api/state`)).json();
    assert.equal(state.jvms[0].pid, 1234);
    assert.equal(state.jvms[0].httpPort, jvm.httpPort);
  } finally {
    await gateway.close();
  }
});

test('Dashboard SSE：attach 后 /events 推送全量快照', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await handleAttach(gateway, { pid: 1234 });
    const base = gateway.dashboardUrl!;
    const response = await fetch(`${base}events`);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: state/);
    assert.match(text, /"pid":1234/);
    await reader.cancel();
  } finally {
    await gateway.close();
  }
});

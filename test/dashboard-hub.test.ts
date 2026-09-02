import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DashboardHub } from '../src/dashboard/hub.ts';

const snapshot = { gatewayVersion: 'test', jvms: [] };

/** 起一个占坑服务，返回它占用的端口（模拟残留 Gateway 占着首选端口）。 */
async function occupyPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

test('首选端口被占用（残留 Gateway）时回退随机端口，/api/state 仍可用', async () => {
  const { server: squatter, port: occupied } = await occupyPort();
  const hub = new DashboardHub(() => snapshot, { port: occupied });
  try {
    const port = await hub.start();
    assert.notEqual(port, occupied);
    const state = (await (await fetch(`${hub.url}api/state`)).json()) as { gatewayVersion: string };
    assert.equal(state.gatewayVersion, 'test');
    // 幂等：再次 start 复用同一服务
    assert.equal(await hub.start(), port);
  } finally {
    await hub.close();
    await new Promise((r) => squatter.close(r));
  }
});

test('首选端口空闲时正常使用首选端口', async () => {
  // 先借一个端口再释放，拿到一个大概率空闲的端口号
  const { server: temp, port: freePort } = await occupyPort();
  await new Promise((r) => temp.close(r));
  const hub = new DashboardHub(() => snapshot, { port: freePort });
  try {
    assert.equal(await hub.start(), freePort);
  } finally {
    await hub.close();
  }
});

test('GET /client.js 返回浏览器端脚本', async () => {
  const hub = new DashboardHub(() => snapshot, { port: 0 });
  try {
    await hub.start();
    const res = await fetch(`${hub.url}client.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
    assert.match(await res.text(), /ansiToHtml/);
  } finally {
    await hub.close();
  }
});

test('POST /api/gateway/shutdown 返回 200 并延迟触发 onExitRequest', async () => {
  let resolveExit!: () => void;
  const exitCalled = new Promise<void>((r) => {
    resolveExit = r;
  });
  const hub = new DashboardHub(() => snapshot, { port: 0, onExitRequest: () => resolveExit() });
  try {
    await hub.start();
    const res = await fetch(`${hub.url}api/gateway/shutdown`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { closing: true });
    // 退出回调延迟 150ms 触发（先让响应刷回浏览器）
    await exitCalled;
  } finally {
    await hub.close();
  }
});

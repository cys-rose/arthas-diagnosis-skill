import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { handleExec } from '../src/tools/exec.ts';
import { makeStubDeps } from './helpers.ts';

/**
 * 诊断活动流：Gateway 记录每次 exec 的命令与流式终端文本输出，经 Dashboard 快照暴露给人。
 * 前提背景：arthas 结果共享不覆盖 WS 终端通道，Dashboard 必须由 Gateway 侧提供活动流才能"实时可见"（ADR-0009）。
 */

test('exec 后快照的活动流包含命令、终端文本输出与 done 状态', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    await handleExec(gateway, { pid: 1234, command: 'thread --all' });
    const activity = gateway.snapshot().jvms[0]!.activity;
    assert.equal(activity.length, 1);
    const entry = activity[0]!;
    assert.equal(entry.command, 'thread --all');
    assert.equal(entry.state, 'done');
    assert.ok(entry.startedAt.length > 0);
    // done 后裁剪为去掉命令回显与提示符的终端文本（保留 ANSI 原文）
    assert.equal(entry.output, 'stub output');
  } finally {
    await gateway.close();
  }
});

test('活动流记录保存含 ANSI 的终端文本（供 Dashboard 还原颜色渲染）', async () => {
  const { deps, terminal } = makeStubDeps();
  terminal.onOpenSession = (session) => {
    session.onExec = (command) => ({
      output: `${command}\r\n\x1b[32mheap\x1b[0m 100\r\n[arthas@1234]$ `,
    });
  };
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    await handleExec(gateway, { pid: 1234, command: 'memory' });
    const entry = gateway.snapshot().jvms[0]!.activity[0]!;
    assert.equal(entry.state, 'done');
    assert.equal(entry.output, '\x1b[32mheap\x1b[0m 100');
  } finally {
    await gateway.close();
  }
});

test('超时的命令在活动流中标记为 timeout', async () => {
  const { deps, terminal } = makeStubDeps();
  terminal.onOpenSession = (session) => {
    // 模拟持续型命令：超时未等到提示符（命令仍在后台执行）
    session.onExec = (command) => ({ output: `${command}\r\npartial\r\n`, timedOut: true });
  };
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    await handleExec(gateway, { pid: 1234, command: 'watch demo.MathGame primeFactors', timeoutMs: 500 });
    const entry = gateway.snapshot().jvms[0]!.activity[0]!;
    assert.equal(entry.state, 'timeout');
  } finally {
    await gateway.close();
  }
});

test('执行失败的命令在活动流中标记为 error 并记录原因', async () => {
  const { deps, terminal } = makeStubDeps();
  terminal.onOpenSession = (session) => {
    session.onExec = () => {
      throw new Error('arthas agent 内部错误');
    };
  };
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await handleExec(gateway, { pid: 1234, command: 'thread --all' });
    assert.equal(result.isError, true);
    const entry = gateway.snapshot().jvms[0]!.activity[0]!;
    assert.equal(entry.state, 'error');
    assert.match(entry.error ?? '', /arthas agent 内部错误/);
  } finally {
    await gateway.close();
  }
});

test('活动流按 JVM capped 在最近 100 条，淘汰最旧', async () => {
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    for (let i = 0; i < 105; i++) {
      await handleExec(gateway, { pid: 1234, command: `thread -n ${i}` });
    }
    const activity = gateway.snapshot().jvms[0]!.activity;
    assert.equal(activity.length, 100);
    assert.equal(activity.at(-1)!.command, 'thread -n 104');
    assert.equal(activity[0]!.command, 'thread -n 5');
  } finally {
    await gateway.close();
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import {
  extractCollapsedOutputFile,
  isProfilerStopCommand,
  parseCollapsed,
} from '../src/profiler-hotspots.ts';
import { makeStubDeps } from './helpers.ts';

test('isProfilerStopCommand 只匹配 profiler stop', () => {
  assert.equal(isProfilerStopCommand('profiler stop'), true);
  assert.equal(isProfilerStopCommand('  profiler stop --format html  '), true);
  assert.equal(isProfilerStopCommand('profiler start'), false);
  assert.equal(isProfilerStopCommand('profiler stopper'), false);
  assert.equal(isProfilerStopCommand('memory'), false);
});

test('parseCollapsed 聚合 total/self/百分比，递归帧同行去重', () => {
  const text = [
    'a;b;c 10',
    'a;b 5',
    'a;a;b 4', // 递归帧 a 在同行出现两次，只计一次
    'd 1',
  ].join('\n');
  const summary = parseCollapsed(text);
  assert.equal(summary.totalSamples, 20);
  const byFrame = new Map(summary.top.map((f) => [f.frame, f]));
  // a: total = 10+5+4 = 19（去重后），self = 0
  assert.equal(byFrame.get('a')!.total, 19);
  assert.equal(byFrame.get('a')!.self, 0);
  assert.equal(byFrame.get('a')!.totalPct, 95);
  // b: total = 10+5+4 = 19，self = 5+4 = 9（作为叶帧的行）
  assert.equal(byFrame.get('b')!.total, 19);
  assert.equal(byFrame.get('b')!.self, 9);
  assert.equal(byFrame.get('b')!.selfPct, 45);
  // c: total = self = 10
  assert.equal(byFrame.get('c')!.total, 10);
  assert.equal(byFrame.get('c')!.self, 10);
  assert.equal(byFrame.get('c')!.totalPct, 50);
  // d: total = self = 1
  assert.equal(byFrame.get('d')!.total, 1);
  assert.equal(byFrame.get('d')!.selfPct, 5);
});

test('parseCollapsed 按 total 降序并截断 topN', () => {
  const lines = ['x 1', 'y 3', 'z 2'];
  const summary = parseCollapsed(lines.join('\n'), 2);
  assert.equal(summary.totalSamples, 6);
  assert.deepEqual(
    summary.top.map((f) => f.frame),
    ['y', 'z'],
  );
});

test('parseCollapsed 跳过空行与无法解析的行', () => {
  const summary = parseCollapsed('\nnot-a-sample-line\na;b 7\n');
  assert.equal(summary.totalSamples, 7);
  assert.equal(summary.top.length, 2);
});

test('extractCollapsedOutputFile 从终端文本提取 collapsed dump 的输出文件路径', () => {
  // profiler dump 走 WS 终端通道后，输出为终端文本：提示行里含以 .collapsed 结尾的路径
  assert.equal(extractCollapsedOutputFile('OK,profiling data saved to /tmp/a.collapsed'), '/tmp/a.collapsed');
  assert.equal(extractCollapsedOutputFile('OK,profiling data saved to C:\\tmp\\a.collapsed\r\n'), 'C:\\tmp\\a.collapsed');
  assert.equal(extractCollapsedOutputFile('dump saved to /tmp/a.html'), null);
  assert.equal(extractCollapsedOutputFile(''), null);
});

test('profiler stop 自动附带 collapsed 热点摘要：dump 先于 stop 执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collapsed-'));
  const file = join(dir, 'hotspots.collapsed');
  await writeFile(file, 'a;b;c 10\na;b 5\n', 'utf8');
  const { deps, terminal } = makeStubDeps();
  terminal.onOpenSession = (session) => {
    session.onExec = (command) => {
      if (command === 'profiler dump --format collapsed') {
        return { output: `${command}\r\nOK,profiling data saved to ${file}\r\n[arthas@1234]$ ` };
      }
      return {};
    };
  };
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await gateway.exec(1234, 'profiler stop --format html');
    assert.ok(!('requiresConfirmation' in result));
    // dump 命令出现在 stop 之前（dump 经完整 exec 路径，进入活动流）
    assert.deepEqual(
      terminal.allExecuted(),
      ['profiler dump --format collapsed', 'profiler stop --format html'],
    );
    assert.equal(result.hotspots!.totalSamples, 15);
    const byFrame = new Map(result.hotspots!.top.map((f) => [f.frame, f]));
    assert.equal(byFrame.get('a')!.total, 15);
    assert.equal(byFrame.get('c')!.self, 10);
    assert.equal(byFrame.get('c')!.selfPct, 66.67);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('profiler stop 的 dump 抓取失败时静默跳过，stop 正常返回', async () => {
  // dump 的终端文本输出里没有 .collapsed 输出文件路径：hotspots 缺省，不影响 stop
  const { deps } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await gateway.exec(1234, 'profiler stop');
    assert.ok(!('requiresConfirmation' in result));
    assert.equal(result.timedOut, false);
    assert.equal(result.hotspots, undefined);
  } finally {
    await gateway.close();
  }
});

test('非 profiler stop 命令不触发 collapsed dump', async () => {
  const { deps, terminal } = makeStubDeps();
  const gateway = new Gateway(deps);
  try {
    await gateway.attach(1234);
    const result = await gateway.exec(1234, 'memory');
    assert.ok(!('requiresConfirmation' in result));
    assert.equal(result.hotspots, undefined);
    assert.deepEqual(terminal.allExecuted(), ['memory']);
  } finally {
    await gateway.close();
  }
});

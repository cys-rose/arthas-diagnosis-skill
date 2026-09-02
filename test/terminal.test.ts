import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAnsi, toAgentOutput, trimTerminalOutput } from '../src/arthas/terminal.ts';

test('stripAnsi 剥掉 CSI 转义序列（SGR 颜色与光标控制）', () => {
  assert.equal(stripAnsi('\x1b[32mheap\x1b[0m 100'), 'heap 100');
  assert.equal(stripAnsi('\x1b[1;91mERR\x1b[m'), 'ERR');
  assert.equal(stripAnsi('\x1b[2J\x1b[Hhello'), 'hello');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('trimTerminalOutput 去掉命令回显首行与结尾提示符行，保留 ANSI', () => {
  const raw = 'memory\r\n\x1b[32mheap\x1b[0m 100\r\nnon-heap 0\r\n[arthas@1234]$ ';
  assert.equal(trimTerminalOutput(raw, 'memory'), '\x1b[32mheap\x1b[0m 100\nnon-heap 0');
});

test('trimTerminalOutput：\\r\\n 归一、行内 \\r 重绘取最后段', () => {
  const raw = 'dashboard\r\nold\rnew\r\n[arthas@99]$ ';
  assert.equal(trimTerminalOutput(raw, 'dashboard'), 'new');
});

test('trimTerminalOutput：提示符行带 ANSI 包裹也能识别', () => {
  const raw = 'version\r\n4.3.4\r\n\x1b[32m[arthas@1234]$ \x1b[0m';
  assert.equal(trimTerminalOutput(raw, 'version'), '4.3.4');
});

test('toAgentOutput：剥掉 ANSI 的纯终端文本', () => {
  assert.equal(toAgentOutput('\x1b[32mheap\x1b[0m 100\nnext'), 'heap 100\nnext');
});

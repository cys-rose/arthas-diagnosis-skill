import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ansiToHtml,
  buildActivity,
  buildEntryHtml,
  esc,
  MAX_OUTPUT_CHARS,
  renderOutput,
} from '../src/dashboard/client.js';

test('esc 转义 HTML 特殊字符', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('ansiToHtml：纯文本只做转义，不加 span', () => {
  assert.equal(ansiToHtml('hello <world>'), 'hello &lt;world&gt;');
});

test('ansiToHtml：颜色码转 span 并在 reset 处闭合', () => {
  assert.equal(
    ansiToHtml('\x1b[32mOK\x1b[0m done'),
    '<span class="a32">OK</span> done',
  );
});

test('ansiToHtml：粗体与亮色码叠加', () => {
  assert.equal(
    ansiToHtml('\x1b[1;91mERR'),
    '<span class="a-bold"><span class="a91">ERR</span></span>',
  );
});

test('ansiToHtml：未闭合的 span 结尾自动闭合', () => {
  assert.equal(ansiToHtml('\x1b[31mred'), '<span class="a31">red</span>');
});

test('ansiToHtml：背景色码转 span（arthas 表头 bold+黑字+白底）', () => {
  assert.equal(
    ansiToHtml('\x1b[1;30;47mNAME\x1b[m'),
    '<span class="a-bold"><span class="a30"><span class="a47">NAME</span></span></span>',
  );
});

test('ansiToHtml：亮色背景码（100–107）也支持', () => {
  assert.equal(ansiToHtml('\x1b[107mx'), '<span class="a107">x</span>');
});

test('renderOutput：终端文本按行渲染，\\r\\n 归一', () => {
  const html = renderOutput('line1\r\nline2');
  assert.equal(html, '<div class="t-line">line1</div><div class="t-line">line2</div>');
});

test('renderOutput：ANSI SGR 颜色还原，非 SGR 控制序列丢弃', () => {
  const html = renderOutput('\x1b[2J\x1b[H\x1b[32mheap\x1b[0m 100');
  assert.match(html, /<span class="a32">heap<\/span> 100/);
  assert.ok(!html.includes('[2J'));
});

test('renderOutput：行内 \\r 重绘取最后段', () => {
  const html = renderOutput('old\rnew');
  assert.match(html, />new</);
  assert.ok(!html.includes('old'));
});

test('renderOutput：HTML 特殊字符转义', () => {
  const html = renderOutput('<tag> & "x"');
  assert.ok(!html.includes('<tag>'));
  assert.match(html, /&lt;tag&gt;/);
});

test('renderOutput：超长输出整体截断并标注', () => {
  const html = renderOutput('a'.repeat(MAX_OUTPUT_CHARS + 100));
  assert.match(html, /输出过长，已截断/);
});

test('renderOutput：空输出返回空串', () => {
  assert.equal(renderOutput(''), '');
  assert.equal(renderOutput(undefined), '');
});

test('buildEntryHtml：arthas 提示符风格命令回显 + 终端输出行', () => {
  const html = buildEntryHtml(
    {
      id: 1,
      command: 'thread -n 3',
      startedAt: '2026-09-02T10:00:00.000Z',
      state: 'done',
      output: 'Threads:\r\n  1 main',
    },
    71257,
  );
  assert.match(html, /\[arthas@71257\]/);
  assert.match(html, /<span class="t-cmd">thread -n 3<\/span>/);
  assert.match(html, /Threads:/);
  assert.match(html, /1 main/);
});

test('buildEntryHtml：running/timeout/error 状态行', () => {
  const base = { id: 1, command: 'watch a b', startedAt: '2026-09-02T10:00:00.000Z', output: '' };
  assert.match(buildEntryHtml({ ...base, state: 'running' }, 1), /执行中/);
  assert.match(buildEntryHtml({ ...base, state: 'timeout' }, 1), /超时未结束/);
  assert.match(buildEntryHtml({ ...base, state: 'error', error: 'boom' }, 1), /执行失败：boom/);
  assert.equal(buildEntryHtml({ ...base, state: 'done' }, 1).includes('state-line'), false);
});

test('buildActivity：空态提示；多条记录按序渲染', () => {
  assert.match(buildActivity([], 1), /尚无诊断命令/);
  const html = buildActivity(
    [
      { id: 1, command: 'jvm', startedAt: '2026-09-02T10:00:00.000Z', state: 'done', output: '' },
      { id: 2, command: 'dashboard', startedAt: '2026-09-02T10:01:00.000Z', state: 'done', output: '' },
    ],
    9,
  );
  assert.ok(html.indexOf('jvm') < html.indexOf('dashboard'));
  assert.match(html, /\[arthas@9\]/);
});

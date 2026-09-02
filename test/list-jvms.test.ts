import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '../src/gateway.ts';
import { parseJpsOutput } from '../src/process-listing.ts';
import { handleListJvms } from '../src/tools/list-jvms.ts';
import { makeStubDeps, stubLister } from './helpers.ts';

test('list_jvms 返回 PID 与主类/jar 名', async () => {
  const { deps } = makeStubDeps();
  deps.processLister = stubLister([
    { pid: 1234, name: 'com.example.Main' },
    { pid: 5678, name: '/opt/app/demo.jar' },
  ]);
  const gateway = new Gateway(deps);
  try {
    const result = await handleListJvms(gateway);
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text);
    assert.deepEqual(payload.jvms, [
      { pid: 1234, name: 'com.example.Main' },
      { pid: 5678, name: '/opt/app/demo.jar' },
    ]);
  } finally {
    await gateway.close();
  }
});

test('list_jvms 在本机无 Java 进程时返回空列表而非报错', async () => {
  const { deps } = makeStubDeps([]);
  const gateway = new Gateway(deps);
  try {
    const result = await handleListJvms(gateway);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0]!.text), { jvms: [] });
  } finally {
    await gateway.close();
  }
});

test('parseJpsOutput 解析 jps -l 输出并过滤 jps 自身', () => {
  const stdout = [
    '12345 com.example.Main',
    '23456 /opt/app/demo.jar',
    '34567 sun.tools.jps.Jps',
    '45678',
    '',
  ].join('\n');
  assert.deepEqual(parseJpsOutput(stdout), [
    { pid: 12345, name: 'com.example.Main' },
    { pid: 23456, name: '/opt/app/demo.jar' },
    { pid: 45678, name: '' },
  ]);
});

test('parseJpsOutput 对空输出返回空列表', () => {
  assert.deepEqual(parseJpsOutput(''), []);
  assert.deepEqual(parseJpsOutput('\n\n'), []);
});

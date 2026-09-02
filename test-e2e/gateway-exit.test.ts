import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * 进程生命周期 e2e：客户端会话结束时 stdio 管道关闭，Gateway 进程必须随之退出，
 * 否则残留进程会一直占着 Dashboard 首选端口（18765），新会话的 Dashboard/浏览器就打不开。
 * 不需要目标 JVM 或 arthas 安装（locate 失败不阻断启动）。
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('e2e：stdin 关闭（客户端会话结束）后 Gateway 进程自行退出', async () => {
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'src', 'index.ts')], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  try {
    child.stdin!.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway 未在 stdin 关闭后 10s 内退出')), 10_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
  }
});

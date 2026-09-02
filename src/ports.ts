import { createServer } from 'node:net';

/** 默认端口基线：与 arthas 默认 telnet/http 端口一致，多 JVM 时递增。 */
export const DEFAULT_TELNET_PORT = 3658;
export const DEFAULT_HTTP_PORT = 8563;

/**
 * 为一个新 arthas agent 分配 telnet/http 端口对：
 * 跳过已占用（本 Gateway 已分配 + 系统已被监听）的端口，两端口一起推进。
 */
export async function allocatePorts(usedPorts: ReadonlySet<number>): Promise<{ telnetPort: number; httpPort: number }> {
  for (let offset = 0; offset < 100; offset++) {
    const telnetPort = DEFAULT_TELNET_PORT + offset;
    const httpPort = DEFAULT_HTTP_PORT + offset;
    if (usedPorts.has(telnetPort) || usedPorts.has(httpPort)) continue;
    if ((await isFree(telnetPort)) && (await isFree(httpPort))) {
      return { telnetPort, httpPort };
    }
  }
  throw new Error('无法分配 arthas agent 端口：3658+/8563+ 区间均被占用。');
}

/** 尝试在 127.0.0.1 上绑定端口判断其是否空闲。 */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

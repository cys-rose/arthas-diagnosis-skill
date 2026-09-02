import { spawn } from 'node:child_process';
import type { ArthasInstallation } from './locator.ts';

/** attach 请求：目标 PID 与分配给该 arthas agent 的端口对。 */
export interface AttachRequest {
  pid: number;
  telnetPort: number;
  httpPort: number;
}

/**
 * attach 进程调用接缝：测试用 stub 替代真实 arthas-boot 调用。
 * 实现需在失败时抛出带明确原因（进程消失/权限/JDK 问题等）的 AttachError。
 */
export interface Attacher {
  attach(install: ArthasInstallation, request: AttachRequest): Promise<void>;
}

/** attach 失败：message 为给人看的原因摘要。 */
export class AttachError extends Error {}

/**
 * 真实实现：`java -jar arthas-boot.jar <pid> --attach-only --disabled-commands stop ...`。
 * attach 完成后轮询 agent HTTP 端口确认就绪；arthas-boot 非零退出或超时视为失败，
 * stderr 尾部并入错误原因。
 */
export class ArthasBootAttacher implements Attacher {
  private readonly javaBin: string;
  private readonly timeoutMs: number;

  constructor(options: { javaBin?: string; timeoutMs?: number } = {}) {
    this.javaBin = options.javaBin ?? process.env['JAVA_BIN'] ?? 'java';
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async attach(install: ArthasInstallation, request: AttachRequest): Promise<void> {
    const args = [
      '-jar',
      install.bootJar,
      String(request.pid),
      '--telnet-port',
      String(request.telnetPort),
      '--http-port',
      String(request.httpPort),
      '--use-version',
      install.version,
      '--disabled-commands',
      'stop',
      '--attach-only',
    ];
    const stderrTail = await this.runBoot(args);
    await this.waitUntilReady(request.httpPort, stderrTail);
  }

  /** 运行 arthas-boot 至退出；非零退出抛 AttachError，返回 stderr 尾部供后续错误诊断。 */
  private runBoot(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.javaBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        // 只保留尾部，避免长日志撑爆内存
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new AttachError(`attach 超时（${this.timeoutMs / 1000}s 内未完成）。`));
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new AttachError(`无法启动 java 进程执行 arthas-boot：${error.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        if (code === 0) {
          resolve(tail);
        } else {
          reject(
            new AttachError(
              `arthas-boot 退出码 ${code}。常见原因：目标进程已退出、非 Java 进程、权限不足或 JDK 版本不兼容。${tail ? `\n${tail}` : ''}`,
            ),
          );
        }
      });
    });
  }

  /** 轮询 agent HTTP 端口直到就绪；超时抛出带 stderr 上下文的 AttachError。 */
  private async waitUntilReady(httpPort: number, stderrTail: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new AttachError(
      `attach 后 agent HTTP 端口 ${httpPort} 未就绪：${lastError}${stderrTail ? `\n${stderrTail}` : ''}`,
    );
  }
}

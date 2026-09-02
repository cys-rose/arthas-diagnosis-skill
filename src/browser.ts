import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * 浏览器打开接缝：测试用 stub 记录打开的 URL。
 */
export interface BrowserOpener {
  open(url: string): Promise<void>;
}

/** 真实实现：按平台调 open / start / xdg-open；失败仅告警不阻断诊断。 */
export class SystemBrowserOpener implements BrowserOpener {
  async open(url: string): Promise<void> {
    const [command, args] =
      platform() === 'darwin'
        ? ['open', [url]]
        : platform() === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    await new Promise<void>((resolve) => {
      execFile(command, args, (error) => {
        if (error) console.error(`[gateway] 自动打开浏览器失败，请手动访问：${url}`);
        resolve();
      });
    });
  }
}

/**
 * 进程存活探测接缝：测试用 stub 替代真实信号探测。
 */
export interface ProcessProbe {
  /** 进程是否存活。 */
  isAlive(pid: number): boolean;
}

/** 真实实现：signal 0 探测；EPERM 表示进程存在但无权限发信号（视为存活）。 */
export class SystemProcessProbe implements ProcessProbe {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

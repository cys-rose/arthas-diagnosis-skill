import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 一个可被诊断的本机 Java 进程（Target JVM 候选）。 */
export interface JvmProcess {
  pid: number;
  /** 主类全名或 jar 路径；jps 未给出时为空串。 */
  name: string;
}

/**
 * 进程枚举接缝：测试用 stub 实现替代真实 jps 调用。
 */
export interface ProcessLister {
  list(): Promise<JvmProcess[]>;
}

/**
 * 基于 `jps -l` 的真实实现。jps 会把自身（sun.tools.jps.Jps）也列出来，过滤掉。
 */
export class JpsLister implements ProcessLister {
  async list(): Promise<JvmProcess[]> {
    const { stdout } = await execFileAsync('jps', ['-l'], { timeout: 10_000 });
    return parseJpsOutput(stdout);
  }
}

/**
 * 解析 `jps -l` 输出为进程列表；跳过空行与 jps 自身条目。
 * 无 Java 进程时返回空数组（jps 此时仍可能输出自身一行，已被过滤）。
 */
export function parseJpsOutput(stdout: string): JvmProcess[] {
  const result: JvmProcess[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const name = (match[2] ?? '').trim();
    if (name === 'sun.tools.jps.Jps') continue;
    result.push({ pid, name });
  }
  return result;
}

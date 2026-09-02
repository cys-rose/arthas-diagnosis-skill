import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一份本地 arthas 安装。 */
export interface ArthasInstallation {
  /** 版本号，如 "4.3.4"。 */
  version: string;
  /** arthas home 目录，如 ~/.arthas/lib/4.3.4/arthas。 */
  home: string;
  /** arthas-boot.jar 绝对路径。 */
  bootJar: string;
}

/**
 * arthas 安装定位接缝：测试用 stub 替代真实文件系统探测。
 */
export interface ArthasLocator {
  /** 定位本地 arthas 安装；缺失或版本低于 4.x 时抛出带明确原因的 Error。 */
  locate(): Promise<ArthasInstallation>;
}

const MIN_MAJOR_VERSION = 4;

/**
 * 真实实现：扫描 ~/.arthas/lib/<version>/arthas（可用 ARTHAS_LIB_DIR 覆盖），
 * 取语义版本最高的一份，要求主版本号 >= 4（依赖 ?iframe=true 与结果共享行为）。
 */
export class LocalArthasLocator implements ArthasLocator {
  private readonly libDir: string;

  constructor(libDir?: string) {
    this.libDir = libDir ?? process.env['ARTHAS_LIB_DIR'] ?? join(homedir(), '.arthas', 'lib');
  }

  async locate(): Promise<ArthasInstallation> {
    let entries: string[];
    try {
      entries = await readdir(this.libDir);
    } catch {
      throw new Error(
        `未找到本地 arthas 安装（目录 ${this.libDir} 不存在）。请先安装 arthas 4.x： https://arthas.aliyun.com/doc/install-detail.html`,
      );
    }
    const versions = entries
      .filter((e) => /^\d+\.\d+\.\d+$/.test(e))
      .sort(compareSemver)
      .reverse();
    if (versions.length === 0) {
      throw new Error(`本地 arthas 目录 ${this.libDir} 下没有可用的版本安装。`);
    }
    const version = versions[0]!;
    const major = Number(version.split('.')[0]);
    if (major < MIN_MAJOR_VERSION) {
      throw new Error(
        `本地 arthas 版本 ${version} 过低，需要 >= ${MIN_MAJOR_VERSION}.x（Dashboard 内嵌 console 与结果共享依赖 arthas 4 行为）。`,
      );
    }
    const home = join(this.libDir, version, 'arthas');
    const bootJar = join(home, 'arthas-boot.jar');
    if (!existsSync(bootJar)) {
      throw new Error(`arthas 安装不完整：${bootJar} 不存在。`);
    }
    return { version, home, bootJar };
  }
}

/** 语义版本比较（仅 x.y.z 数字段）。 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

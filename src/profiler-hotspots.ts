/**
 * profiler stop 热点摘要：profiler stop 前自动执行 `profiler dump --format collapsed`，
 * 解析 collapsed 采样文件聚合出热点帧排行，随 exec 结果返回（ADR-0006）。
 *
 * collapsed 文件每行格式：`帧1;帧2;...;叶帧 计数`（根→叶顺序，计数前是空格）。
 */

/** collapsed 聚合结果。 */
export interface CollapsedSummary {
  /** 全部样本计数之和。 */
  totalSamples: number;
  /** 按 total 降序的热点帧排行。 */
  top: CollapsedFrame[];
}

/** 单个热点帧的聚合数据。 */
export interface CollapsedFrame {
  frame: string;
  /** 包含该帧的行的计数之和（同一行内去重，防止递归帧重复计数）。 */
  total: number;
  /** total 占 totalSamples 的百分比（保留 2 位小数）。 */
  totalPct: number;
  /** 该帧作为叶帧（行内最后一帧）的计数之和。 */
  self: number;
  /** self 占 totalSamples 的百分比（保留 2 位小数）。 */
  selfPct: number;
}

/** 判断命令是否为 `profiler stop`（触发热点摘要抓取的钩子）。 */
export function isProfilerStopCommand(command: string): boolean {
  return /^profiler\s+stop(?:\s|$)/.test(command.trim());
}

/**
 * 解析 collapsed 文本并聚合热点帧。
 * totalSamples 为所有行计数之和；每帧 total=包含该帧的行的计数之和（行内去重），
 * self=该帧作为叶帧的计数之和；按 total 降序取前 topN，百分比保留 2 位小数。
 */
export function parseCollapsed(text: string, topN = 20): CollapsedSummary {
  const totals = new Map<string, number>();
  const selfs = new Map<string, number>();
  let totalSamples = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.lastIndexOf(' ');
    if (sep < 0) continue;
    const count = Number(line.slice(sep + 1));
    if (!Number.isFinite(count)) continue;
    const frames = line.slice(0, sep).split(';').filter((f) => f.length > 0);
    if (frames.length === 0) continue;
    totalSamples += count;
    // 同一行内去重：递归帧在一条栈中出现多次只计一次
    for (const frame of new Set(frames)) {
      totals.set(frame, (totals.get(frame) ?? 0) + count);
    }
    const leaf = frames[frames.length - 1]!;
    selfs.set(leaf, (selfs.get(leaf) ?? 0) + count);
  }
  const pct = (n: number): number => (totalSamples === 0 ? 0 : Math.round((n / totalSamples) * 10000) / 100);
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, total]) => {
      const self = selfs.get(frame) ?? 0;
      return { frame, total, totalPct: pct(total), self, selfPct: pct(self) };
    });
  return { totalSamples, top };
}

/**
 * 从终端文本输出中提取 collapsed dump 的输出文件路径（ADR-0009 后 dump 走 WS 终端通道，输出为终端文本）：
 * profiler dump 会打印形如 "OK, profiling data saved to /path/xxx.collapsed" 的提示，取其中以 .collapsed 结尾的路径；没有则返回 null。
 */
export function extractCollapsedOutputFile(output: string): string | null {
  const match = /([\w./\\:-]+\.collapsed)/.exec(output);
  return match ? match[1]! : null;
}

/** 命令分级（ADR-0004）：放行 / 确认 / 禁用。 */
export type CommandGrade = 'allow' | 'confirm' | 'forbidden';

/** 放行：观察类命令（spec User Story 9 + spec 路径 6 使用的 classloader）。 */
const ALLOW_COMMANDS = new Set([
  'dashboard',
  'thread',
  'jvm',
  'memory',
  'sc',
  'sm',
  'jad',
  'watch',
  'trace',
  'stack',
  'monitor',
  'tt',
  'profiler',
  'getstatic',
  'sysprop',
  'sysenv',
  'perfcounter',
  'mbean',
  'classloader',
]);

/** 确认：写操作与高危命令（spec User Story 10）。 */
const CONFIRM_COMMANDS = new Set([
  'ognl',
  'redefine',
  'retransform',
  'mc',
  'heapdump',
  'vmtool',
  'vmoption',
  'reset',
  'options',
]);

/**
 * 禁用命令及原因：stop 静态禁死；shutdown 不开放为普通命令（只走 shutdown_agent 工具）；
 * quit/exit 会关闭 arthas 会话，与 Gateway 的会话自动管理冲突，同样拒绝。
 */
const FORBIDDEN_REASONS: Record<string, string> = {
  stop: 'stop 命令已被禁用：attach 时通过 arthas.disabledCommands 静态禁死，Gateway 也不会放行。',
  shutdown: 'shutdown 不开放为普通命令。如需卸载 arthas agent，请使用 shutdown_agent 工具（需用户确认）。',
  quit: 'quit 会关闭诊断 Session；会话由 Gateway 自动管理，无需手动退出。',
  exit: 'exit 会关闭诊断 Session；会话由 Gateway 自动管理，无需手动退出。',
};

/** 各确认类命令的风险说明，供 agent 在 chat 中向用户转述。 */
const RISK_DESCRIPTIONS: Record<string, string> = {
  ognl: '执行任意 OGNL 表达式，可读写目标 JVM 的运行时状态，可能修改字段值或调用有副作用的方法。',
  redefine: '热替换已加载类的字节码，直接改变目标 JVM 的行为，错误字节码可导致类不可用。',
  retransform: '热转换已加载类，直接改变目标 JVM 的行为，可能触发大量类重转换开销。',
  mc: '在目标 JVM 内编译 Java 源码并加载类，会向 JVM 注入新类。',
  heapdump: '生成堆转储文件：大堆会导致目标 JVM 长时间停顿，并占用与堆大小相当的磁盘空间。',
  vmtool: 'JVM 层面的强力操作（强制 GC、实例枚举、线程中断等），可能干扰目标进程运行。',
  vmoption: '修改目标 JVM 的运行时参数（如 GC 日志开关），影响进程行为。',
  reset: '重置所有被增强的类，正在运行的 watch/trace/tt 等观察会全部失效。',
  options: '修改 arthas 全局开关，影响该 JVM 上所有会话的诊断行为。',
};

const GENERIC_CONFIRM_RISK = '该命令不在观察类白名单内，按确认类处理：可能对目标 JVM 产生写副作用。';

/**
 * 提取命令名序列：按 `;` 与换行拆成子命令（arthas 支持串行执行），取每条的首个 token。
 */
export function extractCommandNames(command: string): string[] {
  return command
    .split(/[;\n]/)
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0);
}

/**
 * 对整条命令分级：取所有子命令中最严的一级（forbidden > confirm > allow）。
 * 未在任何清单中的命令按确认类处理（保守放行）。
 */
export function gradeCommand(command: string): CommandGrade {
  const names = extractCommandNames(command);
  if (names.length === 0) return 'allow';
  if (names.some((n) => n in FORBIDDEN_REASONS)) return 'forbidden';
  if (names.some((n) => CONFIRM_COMMANDS.has(n) || !ALLOW_COMMANDS.has(n))) return 'confirm';
  return 'allow';
}

/**
 * 禁用命令的拒绝原因；命令不在禁用清单时返回 undefined。
 */
export function forbiddenReason(command: string): string | undefined {
  const name = extractCommandNames(command).find((n) => n in FORBIDDEN_REASONS);
  return name ? FORBIDDEN_REASONS[name] : undefined;
}

/**
 * 命令的风险说明：只针对确认类与未知命令给出风险，观察类忽略；其余返回空串。
 */
export function describeRisk(command: string): string {
  const names = extractCommandNames(command);
  const parts = names
    .filter((n) => CONFIRM_COMMANDS.has(n) || !ALLOW_COMMANDS.has(n))
    .map((n) => RISK_DESCRIPTIONS[n] ?? GENERIC_CONFIRM_RISK);
  const unique = [...new Set(parts)];
  return unique.join(' ');
}

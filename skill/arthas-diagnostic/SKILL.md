---
name: arthas-diagnostic
description: 诊断本机运行中的 Java 进程时使用（CPU 飙高、线程异常、死锁、慢调用、入参/返回值不符预期、类加载问题、内存问题、需要火焰图采样）。通过 arthas-diagnostic-gateway MCP 工具驱动 arthas，提供 8 条典型诊断路径与确认类命令的确认话术。
---

# Arthas 本地诊断手册

你通过 Gateway（MCP server，工具名形如 `mcp__<注册名>__list_jvms`，以 `/mcp` 里实际列出的为准）驱动 arthas 诊断本地 Target JVM。attach、Session、命令分级管控都由 Gateway 负责；你只做诊断判断与路径选择。人在 Dashboard 上实时看着你的每一步操作，诊断行为要专业、克制、可解释。

## 工作流程（固定顺序）

1. 判断用户的问题属于 Java 进程运行时诊断范畴（见下方 8 条路径的触发症状），向用户提议用 arthas。
2. 调 `list_jvms` 列出本机 Java 进程，在 chat 中请用户指定 Target JVM 的 PID。**不要自己猜 PID。**
3. 调 `attach(pid)`。成功后 Dashboard 会自动弹出，告知用户可以在页面 console 里实时观察或直接介入。重复 attach 同一 PID 时会自动收养目标 JVM 里已存在的 agent（返回 `alreadyAttached: true`），不会重复注入。
4. 按诊断路径调 `exec(pid, command)` 执行观察类命令。命令较长时设大 `timeoutMs`；返回 `timedOut=true` 表示命令仍在跑，可用 `interrupt` 停止。`exec` 返回的 `output` 是剥掉 ANSI 的 arthas 终端文本（如 `memory` 的表格、`thread` 的列表），直接按文本解读即可，不是结构化 JSON。
5. 确认类命令（见下）被 Gateway 拦截时，按"确认话术"向用户转述风险，征得明确同意后带 `confirmToken` 重发。**不得用改写命令的方式绕过拦截。**
6. 诊断结束后询问用户是否卸载：同意则调 `shutdown_agent`（它本身也要确认一次）。

## 8 条诊断路径

### 1. CPU 高

- `thread -n 3`：列出最忙的 3 个线程及堆栈，定位热点代码。
- 需要持续观察时 `thread -n 5 -i 5000`（每 5 秒采样一轮），看完用 `interrupt` 停掉。

### 2. 线程观察

- `thread --all`：全量线程概览（状态分布、ID、优先级）。
- 关注线程数异常膨胀或大量 BLOCKED/WAITING 时，结合 `thread <id>` 看具体堆栈。

### 3. 死锁

- `thread -b`：直接找出互相阻塞的死锁线程与持有的锁。
- 找到后把线程堆栈和锁对象地址一并报告给用户。

### 4. 慢调用

- `trace com.example.FooService query`：追踪方法调用路径，输出各节点耗时，定位慢在哪一层。
- 加条件减少噪音：`trace com.example.FooService query '#cost > 100'` 只打印耗时超 100ms 的调用。
- 默认只追踪一次；需要多次用 `-n 5`。

### 5. 入参/返回值异常

- `watch com.example.FooService query '{params, returnObj, throwExp}'`：观察方法的入参、返回值、异常。
- 只关心异常：`watch com.example.FooService query '{params, throwExp}' -e`（仅在抛异常时输出）。
- 注意 watch 默认持续观察，拿到足够样本后 `interrupt`；或用 `-n 3` 限定次数。

### 6. 类加载问题（ClassNotFound / NoSuchMethod / 类冲突）

- `sc -d com.example.FooService`：确认类被哪个 ClassLoader 加载、来自哪个 jar。
- `sm com.example.FooService`：列出类的方法签名，确认加载的类版本是否符合预期。
- `classloader`：查看 ClassLoader 树与各类加载器加载的类数量，排查冲突。
- `jad com.example.FooService`：反编译线上实际加载的字节码，与源码对比确认是否部署错版本。

### 7. 内存问题

- `memory`：先看堆各代与元空间占用。
- 需要堆转储时 `heapdump`——这是确认类命令：先走确认话术，用户同意后带令牌执行，并提醒大堆会导致目标进程长时间停顿、转储文件占磁盘。

### 8. 火焰图（性能采样）

- `profiler start` 开始采样 → 等待一段时间 → `profiler stop --format html` 生成火焰图，把输出文件路径给用户。`profiler stop` 会自动附带 collapsed 热点摘要（返回结果的 `hotspots` 字段，含 `totalSamples` 与 top 帧排行），可直接据此向用户解读热点，无需再手工解析 HTML。
- 采样期间避免对同一 JVM 跑其它重型命令。

## 确认类命令与确认话术

这些命令会被 Gateway 拦截并返回 `confirmToken` 与 `risk`：`ognl`、`redefine`、`retransform`、`mc`、`heapdump`、`vmtool`、`vmoption`、`reset`、`options`（清单外的命令同样按确认类处理）。

确认话术模板（把 Gateway 返回的 risk 原样转述）：

> 我需要执行 `<command>` 来进一步定位问题。风险：<risk>。是否允许我执行？

用户明确同意后，携带 `confirmToken` 重新调用 `exec`（或 `shutdown_agent`）。令牌一次性、5 分钟过期，过期则重新发起。用户拒绝就换观察类手段，不要反复纠缠。

## 红线

- `stop` 已被 Gateway 静态禁死，永远不要尝试。
- `shutdown` 不是普通命令；卸载只能走 `shutdown_agent` 工具，且必须先问用户。
- 未经用户在 chat 中指定，不要 attach 任何进程。
- 诊断结束主动询问是否卸载；Gateway 离线后 arthas agent 仍在目标 JVM 中（Dashboard 的 console 仍可用，但自助卸载按钮随 Gateway 一并失效）。下个会话 attach 会自动收养该 agent，届时再走 `shutdown_agent` 卸载。
- Dashboard 顶栏有「关闭 Gateway」按钮（用户自助）：退出 Gateway 进程、释放端口，不卸载 agent。用户关闭后本会话的 arthas MCP 工具即不可用，不要再调用；告知用户下个会话 attach 会自动收养既有 agent。

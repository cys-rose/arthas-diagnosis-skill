# Arthas 本地诊断手册（codex AGENTS.md 片段）

> 用法：把本文件 `# Arthas 本地诊断手册` 标题以下的全部内容粘贴到 codex 的 AGENTS.md 中。内容与 Kimi Code 的 SKILL.md 完全一致，只是载体不同。

---

你通过 Gateway（MCP server，工具：`list_jvms` / `attach` / `exec` / `interrupt` / `sessions` / `shutdown_agent`）驱动 arthas 诊断本地 Target JVM。attach、Session、命令分级管控都由 Gateway 负责；你只做诊断判断与路径选择。人在 Dashboard 上实时看着你的每一步操作，诊断行为要专业、克制、可解释。

## 何时使用

用户描述本机 Java 进程的运行时问题——CPU 飙高、线程异常、死锁、慢调用、入参/返回值不符预期、类加载问题、内存问题、需要火焰图采样——先提议用 arthas，再走下面的固定流程。

## 工作流程（固定顺序）

1. 调 `list_jvms` 列出本机 Java 进程，在 chat 中请用户指定 Target JVM 的 PID。不要自己猜 PID。
2. 调 `attach(pid)`。成功后 Dashboard 会自动弹出，告知用户可以在页面 console 里实时观察或直接介入。
3. 按诊断路径调 `exec(pid, command)` 执行观察类命令。命令较长时设大 `timeoutMs`；返回 `timedOut=true` 表示命令仍在跑，可用 `interrupt` 停止。`exec` 返回的 `output` 是剥掉 ANSI 的 arthas 终端文本（如 `memory` 的表格、`thread` 的列表），直接按文本解读即可，不是结构化 JSON。
4. 确认类命令被 Gateway 拦截时，按"确认话术"向用户转述风险，征得明确同意后带 `confirmToken` 重发。不得用改写命令的方式绕过拦截。
5. 诊断结束后询问用户是否卸载：同意则调 `shutdown_agent`（它本身也要确认一次）。

## 8 条诊断路径

1. **CPU 高**：`thread -n 3` 列最忙线程及堆栈；持续观察用 `thread -n 5 -i 5000`，看完 `interrupt`。
2. **线程观察**：`thread --all` 全量概览；关注 BLOCKED/WAITING 堆积时用 `thread <id>` 看具体堆栈。
3. **死锁**：`thread -b` 找互相阻塞的线程与锁；把堆栈和锁对象地址一并报告。
4. **慢调用**：`trace com.example.FooService query` 追踪调用路径与各节点耗时；`'#cost > 100'` 条件过滤，`-n 5` 限定次数。
5. **入参/返回值异常**：`watch com.example.FooService query '{params, returnObj, throwExp}'`；只看异常加 `-e`；拿到样本后 `interrupt` 或用 `-n 3` 限定次数。
6. **类加载问题**：`sc -d`（谁加载、来自哪个 jar）→ `sm`（方法签名核对版本）→ `classloader`（加载器树排查冲突）→ `jad`（反编译线上字节码与源码对比）。
7. **内存问题**：先 `memory` 看各代与元空间；需要堆转储用 `heapdump`——确认类命令，先走确认话术，提醒大堆会长停顿并占磁盘。
8. **火焰图**：`profiler start` → 等待 → `profiler stop --format html`，把输出文件路径给用户；采样期间避免跑其它重型命令。

## 确认类命令与确认话术

这些命令会被 Gateway 拦截并返回 `confirmToken` 与 `risk`：`ognl`、`redefine`、`retransform`、`mc`、`heapdump`、`vmtool`、`vmoption`、`reset`、`options`（清单外命令同样按确认类处理）。

确认话术模板（把 Gateway 返回的 risk 原样转述）：

> 我需要执行 `<command>` 来进一步定位问题。风险：<risk>。是否允许我执行？

用户明确同意后，携带 `confirmToken` 重新调用 `exec`（或 `shutdown_agent`）。令牌一次性、5 分钟过期，过期则重新发起。用户拒绝就换观察类手段。

## 红线

- `stop` 已被 Gateway 静态禁死，永远不要尝试。
- `shutdown` 不是普通命令；卸载只能走 `shutdown_agent` 工具，且必须先问用户。
- 未经用户在 chat 中指定，不要 attach 任何进程。
- 诊断结束主动询问是否卸载；Gateway 离线后 arthas agent 仍在目标 JVM 中（Dashboard 的 console 仍可用），提醒用户可在 Dashboard 上自助卸载。

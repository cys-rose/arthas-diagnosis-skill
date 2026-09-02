# Arthas 本地诊断 Agent 工具

让本地对话式 agent（codex / Kimi Code 等）通过 MCP 驱动 arthas 诊断本地 Java 进程，并通过浏览器页面实时向人暴露 agent 的诊断行为。

## Language

**Attach（附加）**:
arthas agent 注入目标 JVM 的动作。同一 JVM 至多 attach 一次，attach 后 agent 常驻在目标 JVM 内，直到被卸载。
_Avoid_: 监控、启动 arthas 进程

**Session（会话）**:
诊断发起方与已 attach JVM 之间的一条命令通道。同一 JVM 可并发多个会话，会话间相互独立。
_Avoid_: arthas 进程、连接

**Target JVM（诊断目标）**:
被 attach 的本地 Java 进程。

**Shutdown（卸载）**:
通过 arthas `shutdown` 命令把 arthas agent 从目标 JVM 中完全移除。关闭会话 ≠ 卸载。

**Dashboard（观察页）**:
agent 首次使用 arthas 时自动弹出的浏览器页面，每个已 attach 的 JVM 一张卡片：状态栏 + 诊断活动流 + 内嵌 arthas 原生 console（iframe，供人直接输入介入）。顶栏「关闭 Gateway」按钮供人自助退出 Gateway、释放端口（不卸载 agent）。
_Avoid_: web console（歧义：可能指 arthas 原生 web console）

**诊断活动流（Activity Feed）**:
Dashboard 卡片上由 Gateway 侧记录并推送的命令流水：每次 exec 的命令回显 + 流式累积的终端文本输出（含 ANSI 原文，WS 终端通道产出，见 ADR-0009）+ 终态（done/timeout/error），每 JVM 保留最近 100 条。存在原因：arthas 结果共享不覆盖 WS 通道，故"agent 做了什么"必须由 Gateway 提供。
_Avoid_: 日志、审计历史（数据只存内存，不持久化）

**Gateway（网关）**:
自研的 MCP server，位于对话式 agent 与 arthas agent 之间。所有 arthas 命令经它转发，负责 attach、命令分级拦截、确认流程、托管 Dashboard。arthas 自带的 `/mcp` 端点不使用。

**命令分级**:
Gateway 对 arthas 命令的三类处置：放行（观察类）、确认（写/高危类，经 chat 向人确认后放行）、禁用（attach 时通过 `arthas.disabledCommands` 静态禁死，如 `stop`）。

**Skill（诊断手册）**:
分发给对话式 agent 的诊断提示词，按运行时载体落地：Kimi Code 用原生 SKILL.md，codex 用 AGENTS.md 片段。职责是"何时该用 arthas + 典型诊断路径"，不含任何进程管理能力（那是 Gateway 的职责）。

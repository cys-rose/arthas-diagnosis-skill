# Arthas 本地诊断 Agent 工具

让本地对话式 agent（codex / Kimi Code）通过 MCP 驱动 arthas 诊断本地 Java 进程，并通过浏览器 Dashboard 实时向人暴露 agent 的诊断行为。

组成：**Gateway**（TypeScript MCP server，stdio 接入）、**Dashboard**（Gateway 同进程托管的浏览器页面，内嵌 arthas 原生 console）、**Skill 诊断手册**（`skill/` 目录）。

## 前置条件

- Node.js >= 23.6
- 本机已安装 arthas >= 4.x（默认读 `~/.arthas/lib/<version>/arthas`，可用环境变量 `ARTHAS_LIB_DIR` 覆盖）
- JDK 的 `java`、`jps` 在 PATH 上（`java` 可用 `JAVA_BIN` 覆盖）

## 本地构建

```bash
npm install
npm run build   # 产物在 dist/，入口为 dist/index.js
```

## 接入 codex

在 `~/.codex/config.toml` 中注册 MCP server（路径改为本仓库的绝对路径）：

```toml
[mcp_servers.arthas]
command = "node"
args = ["/absolute/path/to/arthas-diagnostic-gateway/dist/index.js"]
```

再把 `skill/AGENTS.snippet.md` 中 `# Arthas 本地诊断手册` 标题以下的内容粘贴到项目的 AGENTS.md。

## 接入 Kimi Code

在 `~/.kimi-code/mcp.json` 中注册（用户级，全项目共享）：

```json
{
  "mcpServers": {
    "my-arthas": {
      "command": "node",
      "args": ["/absolute/path/to/arthas-diagnostic-gateway/dist/index.js"]
    }
  }
}
```

再安装诊断手册 skill：

```bash
cp -r skill/arthas-diagnostic ~/.kimi-code/skills/arthas-diagnostic
```

新会话中 `/mcp` 可确认连接状态；agent 遇到 Java 运行时问题时会自动按手册引导使用。

## 工具面（6 个）

| 工具 | 说明 |
| --- | --- |
| `list_jvms` | 列出本机 Java 进程（PID + 主类/jar 名） |
| `attach` | 对用户指定的进程 attach（幂等），自动弹出 Dashboard；attach 时静态禁用 `stop` |
| `exec` | 执行 arthas 命令（走 WS 终端通道，返回剥 ANSI 的终端文本输出）；观察类直接放行，写/高危类拦截后需带一次性 `confirmToken` 重发 |
| `interrupt` | 中断该 JVM 上正在运行的命令 |
| `sessions` | 列出该 JVM 的活跃 Session（Gateway 自动管理） |
| `shutdown_agent` | 卸载 arthas agent（确认类操作） |

## Dashboard

- attach 成功后自动打开；也可手动访问 Gateway 输出/日志中的地址（默认 <http://127.0.0.1:18765>，可用 `ARTHAS_GATEWAY_DASHBOARD_PORT` 改端口）。
- 每个 Target JVM 一张卡片：状态栏（PID/进程名/attach 时间/arthas 版本/活跃 Session 数/待确认数）+ **诊断活动流**（agent 执行的每条 arthas 命令回显与流式终端文本输出，arthas 终端原生样式：提示符回显、ANSI 颜色还原，`memory` 等命令呈现原生表格）+ 内嵌可交互 arthas console（供人直接输入介入；注意 console 看不到 agent 执行的命令——arthas 的结果共享不覆盖 web console 通道，agent 的操作以活动流为准）。
- 目标 JVM 退出 → 卡片标灰；Gateway 离线 → 页面顶部标注；每张卡片有自助卸载按钮（二次确认）。
- 顶栏「关闭 Gateway」按钮：退出 Gateway 进程、释放 Dashboard 端口（二次确认；**不卸载任何 arthas agent**，agent 常驻，下个会话自动收养）。
- 数据只存内存：刷新不丢诊断现场，Gateway 重启清空。Gateway 退出不会自动卸载任何 arthas agent。

## 测试

```bash
npm test        # 单元/集成（node:test，arthas 边界全部 stub）
npm run e2e     # 真实链路：math-game JVM + 真实 attach + exec（需要本机 arthas 与空闲端口）
npm run typecheck
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ARTHAS_LIB_DIR` | `~/.arthas/lib` | arthas 安装根目录 |
| `JAVA_BIN` | `java` | 执行 arthas-boot 的 java 命令 |
| `ARTHAS_GATEWAY_DASHBOARD_PORT` | `18765` | Dashboard 首选端口（被占用时自动回退随机端口） |

## 设计文档

- 术语表：`CONTEXT.md`
- 架构决策：`docs/adr/0001` ~ `0009`
- Spec：`docs/specs/0001-arthas-diagnostic-gateway.md`

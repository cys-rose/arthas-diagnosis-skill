/**
 * 渲染 Dashboard 单页 HTML 骨架（结构与样式；交互逻辑在同目录 client.js，经 /client.js 路由提供）。
 * 每个 Target JVM 一张卡片：状态栏（PID/进程名/attach 时间/版本/会话数/待确认数）+ 左右双栏面板
 * （左侧终端风格诊断活动流：Gateway 记录的 exec 命令与流式结果，仿 arthas 终端渲染；
 * 右侧内嵌 arthas 原生 console：?iframe=true，同源直连；底部拖拽手柄统一调整两栏高度）。
 * 顶栏提供「关闭 Gateway」按钮：退出 Gateway 进程、释放 Dashboard 端口（不卸载任何 arthas agent）。
 * 数据通过 /api/state 首屏加载 + /events SSE 全量快照推送更新；SSE 断开时标注 Gateway 离线/已关闭。
 * 活动流由 Gateway 侧记录（arthas 结果共享不覆盖 web console 的 WebSocket 通道，
 * console iframe 看不到 agent 执行的命令，故活动流由 Gateway 提供）。
 */
export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Arthas 诊断 Dashboard</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; margin: 0; background: #1e1f24; color: #e4e6eb; }
  #topbar { display: flex; align-items: center; gap: 16px; padding: 10px 16px; background: #2a2b32; border-bottom: 1px solid #3a3b44; font-size: 14px; }
  #topbar .title { font-weight: 600; }
  #gateway-status.online { color: #4caf50; }
  #gateway-status.offline { color: #f44336; font-weight: 600; }
  #gateway-exit-btn { margin-left: auto; background: #b71c1c; color: #fff; border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  #gateway-exit-btn:hover { background: #d32f2f; }
  #offline-banner { display: none; padding: 8px 16px; background: #5d2626; color: #ffcdd2; font-size: 13px; }
  #jvms { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
  .jvm-card { background: #26272e; border: 1px solid #3a3b44; border-radius: 8px; overflow: hidden; }
  .jvm-card.exited { opacity: 0.55; }
  .jvm-card.exited iframe { pointer-events: none; filter: grayscale(1); }
  .jvm-header { display: flex; align-items: center; gap: 14px; padding: 8px 12px; background: #2f3038; font-size: 13px; flex-wrap: wrap; }
  .jvm-header .label { color: #9ba0ab; }
  .jvm-header .exited-tag { color: #ffb74d; font-weight: 600; }
  .jvm-header .unload-btn { margin-left: auto; background: #b71c1c; color: #fff; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  /* 双栏面板：活动流（左）与 arthas console（右）并排，高度由底部拖拽手柄统一调整 */
  .panes { display: flex; height: 480px; min-height: 160px; }
  body.resizing { user-select: none; cursor: row-resize; }
  body.resizing iframe { pointer-events: none; }
  .resize-handle { height: 6px; cursor: row-resize; background: #2f3038; border-top: 1px solid #3a3b44; }
  .resize-handle:hover { background: #4a4b56; }
  /* 活动流：仿 arthas 终端（深色底 + 等宽字体） */
  .activity { width: 45%; overflow-y: auto; background: #0d1117; padding: 10px 14px; border-right: 1px solid #3a3b44; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; }
  .activity .empty-tip { color: #5b5e68; }
  .activity .entry { margin-bottom: 10px; }
  .activity .cmd-line { white-space: pre-wrap; word-break: break-all; }
  .activity .cmd-line .t-prompt { color: #98c379; font-weight: 600; }
  .activity .cmd-line .t-dollar { color: #5b5e68; margin: 0 2px; }
  .activity .cmd-line .t-cmd { color: #e4e6eb; }
  .activity .cmd-line .time { color: #5b5e68; margin-left: 10px; }
  .activity .t-line { color: #c9ccd4; white-space: pre-wrap; word-break: break-all; }
  .activity .t-dim { color: #5b5e68; }
  .activity .state-line.running { color: #e5c07b; }
  .activity .state-line.timeout { color: #e5c07b; }
  .activity .state-line.error { color: #e06c75; }
  /* ANSI SGR 前景色映射 */
  .a-bold { font-weight: 700; }
  .a30 { color: #5b5e68; } .a31 { color: #e06c75; } .a32 { color: #98c379; } .a33 { color: #e5c07b; }
  .a34 { color: #61afef; } .a35 { color: #c678dd; } .a36 { color: #56b6c2; } .a37 { color: #c9ccd4; }
  .a90 { color: #7f848e; } .a91 { color: #ff7b86; } .a92 { color: #b5e48c; } .a93 { color: #ffd479; }
  .a94 { color: #82cfff; } .a95 { color: #d8a2e8; } .a96 { color: #7adfd8; } .a97 { color: #ffffff; }
  /* ANSI SGR 背景色映射（调色板对齐 xterm.js 默认色，与内嵌 arthas console 视觉一致） */
  .a40 { background-color: #000000; } .a41 { background-color: #cd3131; } .a42 { background-color: #0dbc79; } .a43 { background-color: #e5e510; }
  .a44 { background-color: #2472c8; } .a45 { background-color: #bc3fbc; } .a46 { background-color: #11a8cd; } .a47 { background-color: #e5e5e5; }
  .a100 { background-color: #666666; } .a101 { background-color: #f14c4c; } .a102 { background-color: #23d18b; } .a103 { background-color: #f5f543; }
  .a104 { background-color: #3b8eea; } .a105 { background-color: #d670d6; } .a106 { background-color: #29b8db; } .a107 { background-color: #ffffff; }
  iframe.console { flex: 1; border: 0; background: #000; display: block; }
  #empty { padding: 40px; text-align: center; color: #9ba0ab; }
</style>
</head>
<body>
<div id="topbar">
  <span class="title">Arthas 诊断 Dashboard</span>
  <span id="gateway-status" class="online">Gateway 在线</span>
  <span>Gateway 版本: <span id="gateway-version">-</span></span>
  <button id="gateway-exit-btn" title="退出 Gateway 进程、释放 Dashboard 端口（不卸载 arthas agent）">关闭 Gateway</button>
</div>
<div id="offline-banner"></div>
<div id="jvms"></div>
<div id="empty">尚无已 attach 的 Target JVM。</div>
<script type="module" src="/client.js"></script>
</body>
</html>`;
}

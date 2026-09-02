/**
 * Dashboard 浏览器端脚本（ESM，由 /client.js 路由提供）。
 * 分两层：
 * - 纯渲染函数（esc / ansiToHtml / renderOutput / stateTag / buildEntryHtml / buildActivity），
 *   不触碰 DOM，导出供 node --test 单测（接缝：终端风格渲染逻辑）；
 * - init() 浏览器引导（SSE 订阅、卡片管理、按钮事件），仅在浏览器环境执行。
 * 渲染风格仿 arthas 终端：提示符命令回显 + 终端文本输出（ANSI SGR 颜色还原）。
 */

/** HTML 转义（防注入：结果文本来自 arthas 输出，可能含任意字符）。 */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** 单条活动记录输出文本的最大渲染长度（超长截断，防巨型输出撑爆 DOM）。 */
export var MAX_OUTPUT_CHARS = 50000;

/**
 * 最小 ANSI SGR → HTML span 转换：支持 0(reset)、1(bold)、30–37/90–97(前景色)。
 * 先整体 HTML 转义再按转义序列切分；未支持的序列直接丢弃。结尾自动闭合未闭合的 span。
 */
export function ansiToHtml(text) {
  var s = esc(text);
  var re = /\x1b\[([0-9;]*)m/g;
  var out = '';
  var last = 0;
  var open = 0;
  var m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    var codes = m[1] === '' ? ['0'] : m[1].split(';');
    for (var i = 0; i < codes.length; i++) {
      var c = parseInt(codes[i], 10);
      if (c === 0) {
        while (open > 0) { out += '</span>'; open--; }
      } else if (c === 1) {
        out += '<span class="a-bold">';
        open++;
      } else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        out += '<span class="a' + c + '">';
        open++;
      }
    }
    last = m.index + m[0].length;
  }
  out += s.slice(last);
  while (open > 0) { out += '</span>'; open--; }
  return out;
}

/**
 * 终端文本输出 → HTML 行渲染：
 * - \r\n 归一为 \n；行内 \r（重绘）取最后段；非 SGR 的 ANSI 控制序列丢弃（保留 SGR 颜色序列供 ansiToHtml 还原）；
 * - 每行经 ansiToHtml 渲染为 t-line 行。超长输出整体截断防撑爆 DOM。
 */
export function renderOutput(output) {
  if (!output) return '';
  var text = String(output);
  var truncated = false;
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }
  var lines = text.replace(/\r\n/g, '\n').split('\n');
  var html = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // 行内 \r（重绘）取最后段；非 SGR 的 ANSI 控制序列丢弃（保留 SGR 颜色序列供 ansiToHtml 还原）
    if (line.indexOf('\r') >= 0) line = line.slice(line.lastIndexOf('\r') + 1);
    line = line.replace(/\x1b\[(?![0-9;]*m)[0-9;?]*[A-Za-z]/g, '');
    html += '<div class="t-line">' + ansiToHtml(line) + '</div>';
  }
  if (truncated) html += '<div class="t-line"><span class="t-dim">…(输出过长，已截断)</span></div>';
  return html;
}

/** 执行状态行（执行中/超时/失败；done 无状态行）。 */
export function stateTag(entry) {
  if (entry.state === 'running') return '<div class="state-line running">…执行中</div>';
  if (entry.state === 'timeout') return '<div class="state-line timeout">⚠ 超时未结束，命令仍在后台执行（可调用 interrupt 中断）</div>';
  if (entry.state === 'error') return '<div class="state-line error">✗ 执行失败：' + esc(entry.error || '') + '</div>';
  return '';
}

/** 一条诊断活动记录：arthas 提示符风格命令回显（[arthas@pid]$ cmd）+ 终端输出行 + 状态行。 */
export function buildEntryHtml(entry, pid) {
  return '<div class="entry">' +
    '<div class="cmd-line"><span class="t-prompt">[arthas@' + esc(pid) + ']</span><span class="t-dollar">$</span> ' +
    '<span class="t-cmd">' + esc(entry.command) + '</span>' +
    '<span class="time">' + esc(new Date(entry.startedAt).toLocaleTimeString()) + '</span></div>' +
    renderOutput(entry.output) +
    stateTag(entry) +
    '</div>';
}

/** 整张卡片的诊断活动流 HTML（空态给出提示）。 */
export function buildActivity(entries, pid) {
  if (!entries || entries.length === 0) {
    return '<div class="empty-tip">尚无诊断命令。agent 执行的 arthas 命令与结果会实时显示在这里。</div>';
  }
  return entries.map(function (entry) { return buildEntryHtml(entry, pid); }).join('');
}

/**
 * 浏览器引导：SSE 订阅全量快照重渲染（按 pid 复用卡片与 console iframe）、
 * 卸载 agent / 关闭 Gateway 按钮事件、Gateway 离线/已关闭横幅。
 */
function init() {
  var jvmsEl = document.getElementById('jvms');
  var emptyEl = document.getElementById('empty');
  var statusEl = document.getElementById('gateway-status');
  var bannerEl = document.getElementById('offline-banner');
  var versionEl = document.getElementById('gateway-version');
  var exitBtn = document.getElementById('gateway-exit-btn');
  // 用户主动关闭 Gateway 后置位：保持「已关闭」文案，不被 SSE 断连的「离线」覆盖
  var gatewayClosed = false;

  function showBanner(text) {
    bannerEl.textContent = text;
    bannerEl.style.display = 'block';
  }

  function unload(pid) {
    if (!window.confirm('确认从 PID ' + pid + ' 卸载 arthas agent？此操作不可撤销。')) return;
    fetch('/api/jvms/' + pid + '/shutdown', { method: 'POST' })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { alert('卸载失败：' + t); }); })
      .catch(function (e) { alert('卸载失败：' + e.message); });
  }

  function shutdownGateway() {
    if (!window.confirm(
      '关闭 Gateway 进程并释放 Dashboard 端口？\n\n' +
      '- 不会卸载任何 arthas agent（如需卸载，请先点对应 JVM 卡片上的「卸载 arthas agent」）\n' +
      '- 关闭后本次会话的 arthas MCP 工具将不可用；下个会话会自动重启 Gateway 并收养既有 agent'
    )) return;
    fetch('/api/gateway/shutdown', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { alert('关闭失败：' + t); });
        gatewayClosed = true;
        statusEl.textContent = 'Gateway 已关闭';
        statusEl.className = 'offline';
        showBanner('Gateway 已关闭，Dashboard 端口已释放。arthas agent 仍常驻目标 JVM（console 仍可用），下个会话会自动收养。');
      })
      .catch(function (e) { alert('关闭失败：' + e.message); });
  }

  exitBtn.addEventListener('click', shutdownGateway);

  /**
   * 卡片底部拖拽手柄：垂直拖拽统一调整双栏面板（活动流 + console）高度。
   * 拖拽期间给 body 加 resizing 类禁用 iframe 鼠标事件，避免指针进入 iframe 后丢失 mousemove。
   */
  function attachResize(card) {
    var panes = card.querySelector('.panes');
    var handle = card.querySelector('.resize-handle');
    handle.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var startY = ev.clientY;
      var startHeight = panes.getBoundingClientRect().height;
      document.body.classList.add('resizing');
      function onMove(e) {
        panes.style.height = Math.max(160, startHeight + e.clientY - startY) + 'px';
      }
      function onUp() {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function render(snapshot) {
    versionEl.textContent = snapshot.gatewayVersion;
    var jvms = snapshot.jvms || [];
    emptyEl.style.display = jvms.length ? 'none' : 'block';
    // 按 pid 复用已有 iframe，避免每次快照刷新都重载 console
    var seen = {};
    jvms.forEach(function (jvm) {
      seen[jvm.pid] = true;
      var card = document.getElementById('jvm-' + jvm.pid);
      var exited = jvm.status === 'exited';
      if (!card) {
        card = document.createElement('div');
        card.className = 'jvm-card';
        card.id = 'jvm-' + jvm.pid;
        var consoleUrl = 'http://127.0.0.1:' + jvm.httpPort + '/?iframe=true';
        card.innerHTML =
          '<div class="jvm-header">' +
          '<span><span class="label">PID:</span> ' + esc(jvm.pid) + '</span>' +
          '<span><span class="label">进程:</span> ' + esc(jvm.name) + '</span>' +
          '<span><span class="label">attach 时间:</span> ' + esc(new Date(jvm.attachedAt).toLocaleString()) + '</span>' +
          '<span><span class="label">arthas:</span> ' + esc(jvm.arthasVersion) + '</span>' +
          '<span><span class="label">活跃 Session:</span> <span class="session-count">' + jvm.sessionCount + '</span></span>' +
          '<span><span class="label">待确认:</span> <span class="pending-count">' + jvm.pendingConfirmations + '</span></span>' +
          '<span class="exited-tag" style="display:none">目标 JVM 已退出</span>' +
          '<button class="unload-btn">卸载 arthas agent</button>' +
          '</div>' +
          '<div class="panes">' +
          '<div class="activity"></div>' +
          '<iframe class="console" src="' + esc(consoleUrl) + '"></iframe>' +
          '</div>' +
          '<div class="resize-handle" title="拖拽调整面板高度"></div>';
        card.querySelector('.unload-btn').addEventListener('click', function () { unload(jvm.pid); });
        attachResize(card);
        jvmsEl.appendChild(card);
      }
      card.querySelector('.session-count').textContent = jvm.sessionCount;
      card.querySelector('.pending-count').textContent = jvm.pendingConfirmations;
      card.querySelector('.exited-tag').style.display = exited ? 'inline' : 'none';
      card.classList.toggle('exited', exited);
      // 活动流：用户在底部附近时跟随滚动到底，翻上去看历史时不动
      var actEl = card.querySelector('.activity');
      var nearBottom = actEl.scrollHeight - actEl.scrollTop - actEl.clientHeight < 40;
      actEl.innerHTML = buildActivity(jvm.activity, jvm.pid);
      if (nearBottom) actEl.scrollTop = actEl.scrollHeight;
    });
    Array.prototype.forEach.call(jvmsEl.children, function (card) {
      var pid = Number(card.id.replace('jvm-', ''));
      if (!seen[pid]) card.remove();
    });
  }

  var es = new EventSource('/events');
  es.addEventListener('state', function (ev) { render(JSON.parse(ev.data)); });
  es.onopen = function () {
    statusEl.textContent = 'Gateway 在线';
    statusEl.className = 'online';
    bannerEl.style.display = 'none';
  };
  es.onerror = function () {
    statusEl.textContent = gatewayClosed ? 'Gateway 已关闭' : 'Gateway 离线';
    statusEl.className = 'offline';
    if (!gatewayClosed) {
      showBanner('Gateway 已离线：页面内容为最后一次快照，console 仍可直接操作，但 agent 侧诊断已停止。arthas agent 不会被自动卸载。');
    }
  };
}

if (typeof document !== 'undefined') init();

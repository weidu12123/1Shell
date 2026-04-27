(() => {
  'use strict';

  // index.html 已有 IDE 面板，跳过
  if (document.getElementById('ide-panel')) return;

  // ── 模块上下文映射 ──────────────────────────────────────────────────
  const MODULE_MAP = {
    'containers': { name: '容器管理', icon: '🐳', hint: '当前在容器管理页面。可操作 Docker 容器：查看状态、启停、删除、查看日志、拉取镜像等。' },
    'sites':      { name: '网站管理', icon: '🌐', hint: '当前在网站管理页面。可操作反向代理站点：创建、修改、删除、SSL 证书管理等。' },
    'scripts':    { name: '脚本库',   icon: '📜', hint: '当前在脚本库页面。可管理和执行 Shell 脚本。' },
    'skills':     { name: 'Skill 仓库', icon: '🧩', hint: '当前在 Skill 仓库页面。可查看、运行已有的 AI Skills。' },
    'programs':   { name: '长驻程序', icon: '⚙',  hint: '当前在长驻程序页面。可管理 Programs（定时任务 + 自动修复）。' },
    'playbooks':  { name: 'Playbook', icon: '📋', hint: '当前在 Playbook 编排页面。可查看和运行 Playbooks。' },
    'playbook-runs': { name: '运行记录', icon: '📊', hint: '当前在 Playbook 运行记录页面。' },
    'probe':      { name: '探针监控', icon: '🔍', hint: '当前在探针监控页面。可查看主机探针数据和健康状态。' },
    'audit':      { name: '审计日志', icon: '📋', hint: '当前在审计日志页面。可查询操作日志。' },
    'skill-studio': { name: '创作台', icon: '✍️', hint: '当前在 Skill 创作台。可创建和编辑 AI Skills。' },
    'cli-setup':  { name: 'AI 配置', icon: '⚙',  hint: '当前在 AI 引擎配置页面。' },
  };

  function detectModule() {
    const page = location.pathname.replace(/.*\//, '').replace(/\.html$/, '');
    return MODULE_MAP[page] || { name: '1Shell', icon: '🖥', hint: '' };
  }

  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── CSS 注入 ────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #ai-fab-btn {
      position: fixed; bottom: 28px; right: 28px; z-index: 8000;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #06b6d4);
      color: #fff; border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(59,130,246,0.4);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; transition: all 0.25s ease;
    }
    #ai-fab-btn:hover { transform: scale(1.1); box-shadow: 0 6px 28px rgba(59,130,246,0.55); }
    #ai-fab-btn.open { border-radius: 16px; width: 44px; height: 44px; font-size: 18px; }

    #ai-fab-panel {
      position: fixed; bottom: 92px; right: 28px; z-index: 8001;
      width: 400px; max-width: calc(100vw - 40px);
      height: 520px; max-height: calc(100vh - 120px);
      background: #fff; border-radius: 20px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 12px 48px rgba(0,0,0,0.15);
      display: none; flex-direction: column; overflow: hidden;
      animation: ai-fab-in 0.2s ease;
    }
    .dark #ai-fab-panel {
      background: #111827; border-color: #1e293b;
      box-shadow: 0 12px 48px rgba(0,0,0,0.4);
    }
    #ai-fab-panel.visible { display: flex; }

    @keyframes ai-fab-in { from { opacity:0; transform: translateY(12px) scale(0.95); } to { opacity:1; transform: translateY(0) scale(1); } }

    #ai-fab-panel .fab-header {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 16px; border-bottom: 1px solid #f1f5f9;
      flex-shrink: 0;
    }
    .dark #ai-fab-panel .fab-header { border-color: #1e293b; }
    .fab-header .fab-title { font-size: 13px; font-weight: 700; color: #334155; flex: 1; }
    .dark .fab-header .fab-title { color: #e2e8f0; }
    .fab-header .fab-badge {
      font-size: 9px; padding: 2px 6px; border-radius: 6px;
      background: linear-gradient(135deg, #3b82f6, #06b6d4);
      color: #fff; font-weight: 600;
    }

    .fab-chat { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .fab-placeholder { text-align: center; color: #94a3b8; font-size: 11px; padding: 40px 0; }
    .fab-user-msg {
      align-self: flex-end; max-width: 85%;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      color: #fff; border-radius: 16px 16px 4px 16px;
      padding: 8px 12px; font-size: 12px; line-height: 1.5;
      white-space: pre-wrap; word-break: break-word;
    }
    .fab-ai-wrap { align-self: flex-start; width: 100%; }
    .fab-ai-label { font-size: 10px; color: #94a3b8; margin-bottom: 4px; }
    .fab-ai-body {
      background: #f8fafc; border-radius: 4px 16px 16px 16px;
      padding: 8px 12px; display: flex; flex-direction: column; gap: 2px;
    }
    .dark .fab-ai-body { background: #0f172a; border: 1px solid #1e293b; }
    .fab-ai-body .fab-line {
      font-size: 11px; font-family: 'Cascadia Code','JetBrains Mono','Fira Code',Consolas,monospace;
      line-height: 1.5; white-space: pre-wrap; word-break: break-all;
    }
    .fab-line.stdout { color: #334155; } .dark .fab-line.stdout { color: #cbd5e1; }
    .fab-line.stderr { color: #ef4444; }
    .fab-line.info   { color: #3b82f6; }
    .fab-line.error  { color: #dc2626; font-weight: 600; }
    .fab-line.success { color: #059669; font-weight: 600; }

    .fab-input-area {
      flex-shrink: 0; padding: 8px 12px 12px;
      border-top: 1px solid #f1f5f9;
      display: flex; flex-direction: column; gap: 6px;
    }
    .dark .fab-input-area { border-color: #1e293b; }
    .fab-input-area textarea {
      width: 100%; resize: none; border: 1px solid #e2e8f0; border-radius: 10px;
      padding: 8px 10px; font-size: 12px; outline: none; background: #fff;
      color: #334155; font-family: inherit;
    }
    .dark .fab-input-area textarea { background: #0a0f1c; border-color: #1e293b; color: #e2e8f0; }
    .fab-input-area textarea:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    .fab-bottom-row { display: flex; align-items: center; gap: 6px; }
    .fab-status { font-size: 10px; color: #94a3b8; flex: 1; }
    .fab-send-btn {
      height: 28px; padding: 0 14px; border: none; border-radius: 8px;
      background: linear-gradient(135deg, #3b82f6, #06b6d4);
      color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .fab-send-btn:disabled { opacity: 0.5; cursor: default; }
    .fab-stop-btn {
      height: 28px; padding: 0 12px; border: none; border-radius: 8px;
      background: #ef4444; color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .fab-close-btn, .fab-clear-btn {
      background: none; border: 1px solid #e2e8f0; border-radius: 6px;
      padding: 2px 8px; font-size: 10px; color: #94a3b8; cursor: pointer;
    }
    .dark .fab-close-btn, .dark .fab-clear-btn { border-color: #1e293b; }
    .fab-close-btn:hover { color: #ef4444; border-color: #fca5a5; }
    .fab-clear-btn:hover { color: #3b82f6; border-color: #93c5fd; }

    .fab-approve-bar {
      display: none; position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
      z-index: 8100; width: 560px; max-width: 90vw;
      background: #fff; border-radius: 14px; border: 1px solid #fcd34d;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18); overflow: hidden;
      animation: ai-fab-in 0.2s ease;
    }
    .dark .fab-approve-bar { background: #1e293b; border-color: rgba(245,158,11,0.4); }
  `;
  document.head.appendChild(style);

  // ── DOM 创建 ─────────────────────────────────────────────────────────

  const mod = detectModule();

  // FAB 按钮
  const fabBtn = document.createElement('button');
  fabBtn.id = 'ai-fab-btn';
  fabBtn.innerHTML = '&#129302;';
  fabBtn.title = '1Shell AI';
  document.body.appendChild(fabBtn);

  // 聊天面板
  const panel = document.createElement('div');
  panel.id = 'ai-fab-panel';
  panel.innerHTML = `
    <div class="fab-header">
      <span style="font-size:16px">${escapeHtml(mod.icon)}</span>
      <span class="fab-title">1Shell AI</span>
      <span class="fab-badge">${escapeHtml(mod.name)}</span>
      <button class="fab-clear-btn" id="fab-stop-header" style="color:#ef4444;border-color:#fca5a5">停止</button>
      <button class="fab-clear-btn" id="fab-clear">清空</button>
      <button class="fab-close-btn" id="fab-close">关闭</button>
    </div>
    <div class="fab-chat" id="fab-chat">
      <div class="fab-placeholder" id="fab-placeholder">
        <div style="font-size:24px;margin-bottom:6px">&#129302;</div>
        <div>1Shell AI 助手</div>
        <div style="margin-top:4px;font-size:10px;color:#64748b">${escapeHtml(mod.hint || '输入需求，AI 会在你的主机上执行操作')}</div>
      </div>
    </div>
    <div class="fab-input-area">
      <textarea id="fab-input" rows="2" placeholder="描述你的需求..."></textarea>
      <div class="fab-bottom-row">
        <span class="fab-status" id="fab-status">待命</span>
        <button class="fab-send-btn" id="fab-send">发送 →</button>
        <button class="fab-stop-btn" id="fab-stop">停止</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // 审批条
  const approveBar = document.createElement('div');
  approveBar.className = 'fab-approve-bar';
  approveBar.id = 'fab-approve-bar';
  approveBar.innerHTML = `
    <div style="padding:8px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(252,211,77,0.3)">
      <span>&#128737;</span>
      <span id="fab-approve-title" style="font-size:11px;font-weight:600;color:#b45309;flex:1">安全模式</span>
      <span id="fab-approve-countdown" style="font-size:10px;color:#94a3b8"></span>
    </div>
    <div style="padding:8px 14px">
      <div id="fab-approve-desc" style="font-size:11px;color:#64748b;margin-bottom:6px"></div>
      <pre id="fab-approve-detail" style="font-size:11px;padding:8px;border-radius:8px;background:#0f172a;color:#34d399;font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:100px;overflow:auto;border:1px solid #1e293b"></pre>
    </div>
    <div style="padding:8px 14px;display:flex;align-items:center;gap:6px;border-top:1px solid #f1f5f9">
      <button id="fab-approve-deny" style="padding:4px 14px;border-radius:8px;border:1px solid #fca5a5;color:#ef4444;font-size:11px;font-weight:600;cursor:pointer;background:none">✕ 拒绝</button>
      <div style="flex:1;display:flex;gap:4px">
        <input id="fab-approve-input" style="flex:1;font-size:11px;padding:4px 8px;border-radius:8px;border:1px solid #e2e8f0;outline:none" placeholder="自定义回复..." />
        <button id="fab-approve-custom" style="padding:4px 10px;border-radius:8px;border:1px solid #93c5fd;color:#3b82f6;font-size:11px;font-weight:600;cursor:pointer;background:none">回复</button>
      </div>
      <button id="fab-approve-allow" style="padding:4px 14px;border-radius:8px;border:none;background:#059669;color:#fff;font-size:11px;font-weight:600;cursor:pointer">✓ 允许</button>
    </div>
  `;
  document.body.appendChild(approveBar);

  // ── 获取 DOM 引用 ──────────────────────────────────────────────────
  const $chat   = document.getElementById('fab-chat');
  const $input  = document.getElementById('fab-input');
  const $send   = document.getElementById('fab-send');
  const $stop   = document.getElementById('fab-stop');
  const $stopH  = document.getElementById('fab-stop-header');
  const $status = document.getElementById('fab-status');

  // ── 状态 ───────────────────────────────────────────────────────────
  let socket = null;
  let sessionId = null;
  let isRunning = false;
  let currentAiBody = null;
  let panelOpen = false;

  // ── 面板开关 ───────────────────────────────────────────────────────
  fabBtn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('visible', panelOpen);
    fabBtn.classList.toggle('open', panelOpen);
    fabBtn.innerHTML = panelOpen ? '&#10005;' : '&#129302;';
    if (panelOpen && !socket) connectSocket();
  });
  document.getElementById('fab-close').addEventListener('click', () => {
    panelOpen = false;
    panel.classList.remove('visible');
    fabBtn.classList.remove('open');
    fabBtn.innerHTML = '&#129302;';
  });

  // ── Socket 连接 ───────────────────────────────────────────────────
  function ensureIo(cb) {
    if (typeof io !== 'undefined') return cb();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.min.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function connectSocket() {
    ensureIo(() => {
      socket = io({ transports: ['websocket', 'polling'] });
      socket.on('connect', () => setStatus('已连接'));

      socket.on('ide:thinking', (m) => { if (m.sessionId === sessionId) setStatus('思考中...'); });
      socket.on('ide:text', (m) => {
        if (m.sessionId !== sessionId || !m.text) return;
        appendLine('stdout', m.text);
      });
      socket.on('ide:tool-start', (m) => {
        if (m.sessionId !== sessionId) return;
        const inp = m.input ? ` ${JSON.stringify(m.input).slice(0, 80)}` : '';
        appendLine('info', `⚙ ${m.name}${inp}`);
      });
      socket.on('ide:tool-end', (m) => {
        if (m.sessionId !== sessionId) return;
        const txt = String(m.result || '').trim();
        appendLine(m.is_error ? 'stderr' : 'stdout', txt.length > 1500 ? txt.slice(0, 1500) + '\n...[truncated]' : txt);
      });
      socket.on('ide:done', (m) => {
        if (m.sessionId !== sessionId) return;
        setStatus(`完成 (${m.round ?? 0} 轮)`);
        finalize();
      });
      socket.on('ide:error', (m) => {
        if (m.sessionId !== sessionId) return;
        appendLine('error', `✘ ${m.error || '未知错误'}`);
        finalize();
      });
      socket.on('ide:cancelled', (m) => {
        if (m.sessionId !== sessionId) return;
        setStatus('已取消');
        finalize();
      });

      // 安全模式审批
      socket.on('ide:approve-request', (m) => {
        if (m.sessionId !== sessionId) return;
        showApproveBar(m);
      });
    });
  }

  // ── UI 渲染 ────────────────────────────────────────────────────────
  function setStatus(t) { $status.textContent = t; }

  function setRunning(v) {
    isRunning = v;
    $send.disabled = v;
  }

  function finalize() { setRunning(false); currentAiBody = null; }

  function hidePlaceholder() {
    const ph = document.getElementById('fab-placeholder');
    if (ph) ph.remove();
  }

  function renderUserBubble(text) {
    hidePlaceholder();
    const d = document.createElement('div');
    d.className = 'fab-user-msg';
    d.textContent = text;
    $chat.appendChild(d);
    $chat.scrollTop = $chat.scrollHeight;
  }

  function renderAiTurn() {
    hidePlaceholder();
    const wrap = document.createElement('div');
    wrap.className = 'fab-ai-wrap';
    wrap.innerHTML = '<div class="fab-ai-label">&#129302; 1Shell AI</div><div class="fab-ai-body"></div>';
    $chat.appendChild(wrap);
    currentAiBody = wrap.querySelector('.fab-ai-body');
    $chat.scrollTop = $chat.scrollHeight;
  }

  function appendLine(kind, text) {
    if (!currentAiBody) renderAiTurn();
    const line = document.createElement('div');
    line.className = `fab-line ${kind}`;
    line.textContent = text;
    currentAiBody.appendChild(line);
    $chat.scrollTop = $chat.scrollHeight;
  }

  // ── 上下文构建 ─────────────────────────────────────────────────────
  function buildContext() {
    const ctx = { module: mod.name, moduleHint: mod.hint };
    const hostSel = document.getElementById('host-select');
    if (hostSel) {
      const opt = hostSel.options[hostSel.selectedIndex];
      if (opt) {
        ctx.hosts = [{ id: hostSel.value, name: opt.textContent.trim() }];
      }
    }
    return ctx;
  }

  // ── 发送 / 停止 / 清空 ────────────────────────────────────────────
  function onSend() {
    const text = $input.value.trim();
    if (!text || isRunning) return;
    if (!socket) { connectSocket(); return; }

    if (!sessionId) sessionId = 'fab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    renderUserBubble(text);
    $input.value = '';
    renderAiTurn();
    setRunning(true);
    setStatus('启动中...');

    socket.emit('ide:message', {
      sessionId,
      message: text,
      context: buildContext(),
    }, (ack) => {
      if (!ack?.ok) {
        setStatus('启动失败');
        appendLine('error', ack?.error || 'ide:message 被拒绝');
        finalize();
      }
    });
  }

  $send.addEventListener('click', onSend);
  const stopFn = () => { if (socket && sessionId) socket.emit('ide:stop', { sessionId }); };
  $stop.addEventListener('click', stopFn);
  $stopH.addEventListener('click', stopFn);
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  document.getElementById('fab-clear').addEventListener('click', () => {
    if (isRunning) return;
    if (sessionId && socket) socket.emit('ide:clear', { sessionId });
    sessionId = null;
    currentAiBody = null;
    $chat.innerHTML = `<div class="fab-placeholder" id="fab-placeholder">
      <div style="font-size:24px;margin-bottom:6px">&#129302;</div>
      <div>1Shell AI 助手</div>
      <div style="margin-top:4px;font-size:10px;color:#64748b">${escapeHtml(mod.hint || '输入需求，AI 会在你的主机上执行操作')}</div>
    </div>`;
    setStatus('待命');
  });

  // ── 审批条 ─────────────────────────────────────────────────────────
  function showApproveBar(m) {
    const bar = document.getElementById('fab-approve-bar');
    document.getElementById('fab-approve-title').textContent = m.title || '安全模式';
    document.getElementById('fab-approve-desc').textContent = `AI 要执行 ${m.toolName || '操作'}：`;
    document.getElementById('fab-approve-detail').textContent = m.detail || '';
    document.getElementById('fab-approve-input').value = '';
    bar.style.display = '';

    let remaining = 120;
    const $cd = document.getElementById('fab-approve-countdown');
    $cd.textContent = `${remaining}s`;
    const tick = setInterval(() => {
      remaining--;
      $cd.textContent = `${remaining}s`;
      if (remaining <= 0) respond('deny');
    }, 1000);

    const respond = (action, text) => {
      clearInterval(tick);
      bar.style.display = 'none';
      socket.emit('ide:approve-response', {
        requestId: m.requestId,
        sessionId: m.sessionId,
        action,
        text: text || '',
      });
    };

    document.getElementById('fab-approve-deny').onclick = () => respond('deny');
    document.getElementById('fab-approve-allow').onclick = () => respond('allow');
    document.getElementById('fab-approve-custom').onclick = () => {
      const t = document.getElementById('fab-approve-input').value.trim();
      if (t) respond('custom', t);
    };
  }

  // ── 外部接口：允许其他页面模块预填消息并发送 ──────────────────────
  window.sendToAiFab = function (message) {
    if (!panelOpen) {
      panelOpen = true;
      panel.classList.add('visible');
      fabBtn.classList.add('open');
      fabBtn.innerHTML = '&#10005;';
    }
    if (!socket) connectSocket();
    $input.value = message;
    setTimeout(() => onSend(), 300);
  };
})();

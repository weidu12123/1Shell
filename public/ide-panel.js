(() => {
  'use strict';

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function createIdePanelModule({
    getActiveHost,
    getSessionTerminalModule,
    showErrorMessage,
  }) {
    const panelEl     = document.getElementById('ide-panel');
    const openBtnEl   = document.getElementById('ide-panel-btn');
    const closeBtnEl  = document.getElementById('ide-panel-close-btn');
    const sendBtnEl   = document.getElementById('ide-send-btn');
    const stopBtnEl   = document.getElementById('ide-stop-btn');
    const clearBtnEl  = document.getElementById('ide-clear-btn');
    const inputEl     = document.getElementById('ide-input');
    const chatAreaEl  = document.getElementById('ide-chat-area');
    const statusEl    = document.getElementById('ide-status-text');

    let socket = null;
    let sessionId = null;
    let isRunning = false;
    let currentAiBody = null;
    let visible = false;
    let safeMode = true;

    // ─── 安全模式开关 ──────────────────────────────────────────────────
    const $safeToggle = document.getElementById('ide-safe-toggle');
    const $safeLabel = document.getElementById('ide-safe-label');
    if ($safeToggle) {
      $safeToggle.addEventListener('change', () => {
        safeMode = $safeToggle.checked;
        if ($safeLabel) {
          $safeLabel.style.borderColor = safeMode ? '' : '#e2e8f0';
          const spanEl = $safeLabel.querySelector('span');
          if (spanEl) spanEl.className = safeMode ? 'text-amber-500 font-medium' : 'text-slate-400 font-medium';
        }
        if (socket && sessionId) {
          socket.emit('ide:safe-mode', { sessionId, enabled: safeMode });
        }
      });
    }

    // ─── 工具选择 ────────────────────────────────────────────────────
    const selectedTools = new Set();
    let toolItems = [];

    async function loadTools() {
      try {
        const headers = { 'X-CSRF-Token': getCsrfToken() };
        const [skillRes, mcpRes] = await Promise.all([
          fetch('/api/skills', { headers }).then(r => r.json()).catch(() => ({ skills: [] })),
          fetch('/api/mcp-servers', { headers }).then(r => r.json()).catch(() => ({ servers: [] })),
        ]);
        toolItems = [];
        for (const s of (skillRes.skills || [])) {
          if (s.id === 'skill-authoring') continue;
          toolItems.push({ kind: 'skill', id: s.id, name: s.name || s.id, icon: s.icon || '⚡', description: s.description || '' });
        }
        for (const m of (mcpRes.servers || [])) {
          const isLocal = m.type === 'local' || !!m.command;
          toolItems.push({ kind: isLocal ? 'local-mcp' : 'remote-mcp', id: m.id, name: m.name, icon: isLocal ? '📦' : '🔌', description: m.description || '', command: m.command || '', url: m.url || '' });
        }
        renderToolPicker();
      } catch { /* silent */ }
    }

    function renderToolPicker() {
      const $picker = document.getElementById('ide-tool-picker');
      const $chips  = document.getElementById('ide-tool-chips');
      if (!$picker) return;

      if (toolItems.length === 0) {
        $picker.innerHTML = '<div class="text-slate-400 text-center py-2">暂无可用工具</div>';
      } else {
        $picker.innerHTML = toolItems.map(it => {
          const key = `${it.kind}:${it.id}`;
          const sel = selectedTools.has(key) ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600' : 'hover:bg-slate-50 dark:hover:bg-[#1e293b]';
          let tag = '';
          if (it.kind === 'skill')      tag = '<span class="text-[9px] px-1 rounded bg-purple-100 text-purple-600">Skill</span>';
          if (it.kind === 'local-mcp')  tag = '<span class="text-[9px] px-1 rounded bg-emerald-100 text-emerald-600">本地MCP</span>';
          if (it.kind === 'remote-mcp') tag = '<span class="text-[9px] px-1 rounded bg-amber-100 text-amber-600">远程MCP</span>';
          return `<div class="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer ${sel}" data-key="${escapeHtml(key)}">
            <span>${escapeHtml(it.icon)}</span><span class="flex-1 truncate">${escapeHtml(it.name)}</span>${tag}
          </div>`;
        }).join('');
      }

      $picker.querySelectorAll('[data-key]').forEach(el => {
        el.addEventListener('click', () => {
          const k = el.dataset.key;
          if (selectedTools.has(k)) selectedTools.delete(k); else selectedTools.add(k);
          renderToolPicker();
          handleToolSelection(k);
        });
      });

      if ($chips) {
        $chips.innerHTML = [...selectedTools].map(k => {
          const it = toolItems.find(x => `${x.kind}:${x.id}` === k);
          if (!it) return '';
          return `<span class="px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-900/30">${escapeHtml(it.icon)} ${escapeHtml(it.name)}</span>`;
        }).join('');
      }
    }

    function handleToolSelection(key) {
      if (!socket) return;
      const it = toolItems.find(x => `${x.kind}:${x.id}` === key);
      if (!it) return;

      if (it.kind === 'local-mcp' && selectedTools.has(key)) {
        socket.emit('ide:mcp-start', { mcpId: it.id }, (ack) => {
          if (ack?.ok) {
            appendLine('success', `✓ 本地 MCP "${it.name}" 已启动`);
          } else {
            appendLine('error', `✗ 启动 MCP "${it.name}" 失败: ${ack?.error || '未知错误'}`);
          }
        });
      } else if (it.kind === 'local-mcp' && !selectedTools.has(key)) {
        socket.emit('ide:mcp-stop', { mcpId: it.id });
        appendLine('info', `■ 本地 MCP "${it.name}" 已停止`);
      }
    }

    function buildContext() {
      const ctx = {};
      const host = getActiveHost?.();
      if (host) {
        ctx.hosts = [{
          id: host.id || 'local',
          name: host.name,
          username: host.username,
          host: host.host,
          port: host.port,
        }];
      }

      const skills = [];
      const mcpServers = [];
      for (const key of selectedTools) {
        const it = toolItems.find(x => `${x.kind}:${x.id}` === key);
        if (!it) continue;
        if (it.kind === 'skill') {
          skills.push({ id: it.id, name: it.name });
        } else {
          mcpServers.push({ id: it.id, name: it.name, url: it.url || '', type: it.kind === 'local-mcp' ? 'local' : 'remote' });
        }
      }
      if (skills.length > 0) ctx.skills = skills;
      if (mcpServers.length > 0) ctx.mcpServers = mcpServers;

      return ctx;
    }

    // ─── 基础 UI ─────────────────────────────────────────────────────

    function getSocket() {
      return getSessionTerminalModule?.()?.getSocket?.() || null;
    }

    function genSessionId() {
      return 'ide-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function setStatus(text) { if (statusEl) statusEl.textContent = text; }

    function showPlaceholder() {
      chatAreaEl.innerHTML = `
        <div id="ide-chat-placeholder" class="text-[11px] text-slate-400 text-center py-10 flex flex-col items-center gap-2">
          <span class="text-2xl">&#128187;</span>
          <span>1Shell AI 助手<br/>输入需求，AI 会在你的主机上执行操作</span>
        </div>`;
    }

    function hidePlaceholder() {
      const ph = document.getElementById('ide-chat-placeholder');
      if (ph) ph.remove();
    }

    function renderUserBubble(text) {
      hidePlaceholder();
      const div = document.createElement('div');
      div.className = 'self-end max-w-[85%] bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-2xl rounded-br-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words';
      div.textContent = text;
      chatAreaEl.appendChild(div);
      chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    }

    function renderAiTurn() {
      hidePlaceholder();
      const wrap = document.createElement('div');
      wrap.className = 'self-start w-full';
      wrap.innerHTML = `<div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1"><span>&#129302;</span><span>1Shell AI</span></div><div class="ai-body bg-slate-100 dark:bg-[#0f172a] dark:border dark:border-[#1e293b] rounded-sm rounded-br-2xl rounded-bl-2xl rounded-tr-2xl px-3 py-2 flex flex-col gap-0.5"></div>`;
      chatAreaEl.appendChild(wrap);
      currentAiBody = wrap.querySelector('.ai-body');
      chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    }

    function appendLine(kind, text) {
      if (!currentAiBody) renderAiTurn();
      const line = document.createElement('div');
      const cls = {
        stdout: 'text-slate-700 dark:text-slate-300',
        stderr: 'text-red-500',
        info: 'text-blue-500',
        error: 'text-red-600 font-semibold',
        success: 'text-emerald-600 font-semibold',
      }[kind] || 'text-slate-600 dark:text-slate-400';
      line.className = `text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all ${cls}`;
      line.textContent = text;
      currentAiBody.appendChild(line);
      chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    }

    function truncate(s) {
      const t = String(s || '').trim();
      return t.length > 2000 ? t.slice(0, 2000) + '\n...[truncated]' : t;
    }

    function setRunning(v) {
      isRunning = v;
      sendBtnEl.disabled = v;
      sendBtnEl.classList.toggle('hidden', v);
      stopBtnEl.classList.toggle('hidden', !v);
    }

    // ─── Socket ──────────────────────────────────────────────────────

    function bindSocket() {
      socket = getSocket();
      if (!socket) return;

      socket.on('ide:thinking', (msg) => {
        if (msg.sessionId !== sessionId) return;
        setStatus('思考中...');
      });
      socket.on('ide:text', (msg) => {
        if (msg.sessionId !== sessionId || !msg.text) return;
        appendLine('stdout', msg.text);
      });
      socket.on('ide:tool-start', (msg) => {
        if (msg.sessionId !== sessionId) return;
        const inputStr = msg.input ? ` ${JSON.stringify(msg.input).slice(0, 100)}` : '';
        appendLine('info', `⚙ ${msg.name}${inputStr}`);
      });
      socket.on('ide:tool-end', (msg) => {
        if (msg.sessionId !== sessionId) return;
        appendLine(msg.is_error ? 'stderr' : 'stdout', truncate(msg.result || ''));
      });
      socket.on('ide:done', (msg) => {
        if (msg.sessionId !== sessionId) return;
        setStatus(`完成 (${msg.round ?? 0} 轮)`);
        finalize();
      });
      socket.on('ide:error', (msg) => {
        if (msg.sessionId !== sessionId) return;
        setStatus('出错');
        appendLine('error', `✘ ${msg.error || '未知错误'}`);
        finalize();
      });
      socket.on('ide:cancelled', (msg) => {
        if (msg.sessionId !== sessionId) return;
        setStatus('已取消');
        finalize();
      });

      // 安全模式审批
      socket.on('ide:approve-request', (msg) => {
        if (msg.sessionId !== sessionId) return;
        const $bar = document.getElementById('approve-bar');
        if (!$bar) return;
        const $title = document.getElementById('approve-title');
        const $desc = document.getElementById('approve-desc');
        const $detail = document.getElementById('approve-detail');
        const $allow = document.getElementById('approve-allow');
        const $deny = document.getElementById('approve-deny');
        const $customInput = document.getElementById('approve-custom-input');
        const $customBtn = document.getElementById('approve-custom-btn');
        const $countdown = document.getElementById('approve-countdown');

        $title.textContent = msg.title || '安全模式';
        $desc.textContent = `AI 要执行 ${msg.toolName || '操作'}：`;
        $detail.textContent = msg.detail || '';
        $customInput.value = '';
        $bar.classList.remove('hidden');

        let remaining = 120;
        $countdown.textContent = `${remaining}s`;
        const tick = setInterval(() => {
          remaining--;
          $countdown.textContent = `${remaining}s`;
          if (remaining <= 0) respond('deny');
        }, 1000);

        const respond = (action, text) => {
          clearInterval(tick);
          $bar.classList.add('hidden');
          socket.emit('ide:approve-response', { requestId: msg.requestId, sessionId: msg.sessionId, action, text: text || '' });
        };

        $deny.onclick = () => respond('deny');
        $allow.onclick = () => respond('allow');
        $customBtn.onclick = () => {
          const text = $customInput.value.trim();
          if (!text) return;
          respond('custom', text);
        };
        $customInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $customBtn.click(); } };
      });
    }

    function finalize() {
      setRunning(false);
      currentAiBody = null;
    }

    // ─── Actions ─────────────────────────────────────────────────────

    function onSend() {
      const text = inputEl.value.trim();
      if (!text || isRunning) return;
      if (!socket) { socket = getSocket(); if (!socket) { showErrorMessage?.({ message: 'Socket 未连接' }); return; } }

      if (!sessionId) {
        sessionId = genSessionId();
        socket.emit('ide:safe-mode', { sessionId, enabled: safeMode });
      }

      renderUserBubble(text);
      inputEl.value = '';

      renderAiTurn();
      setRunning(true);
      setStatus('启动中...');

      socket.emit('ide:message', {
        sessionId,
        message: text,
        context: buildContext(),
        safeMode,
      }, (ack) => {
        if (!ack?.ok) {
          setStatus('启动失败');
          appendLine('error', ack?.error || 'ide:message 被拒绝');
          finalize();
        }
      });
    }

    function onStop() {
      if (!socket || !sessionId) return;
      socket.emit('ide:stop', { sessionId });
    }

    function onClear() {
      if (isRunning) return;
      if (sessionId && socket) {
        socket.emit('ide:clear', { sessionId });
      }
      sessionId = null;
      currentAiBody = null;
      showPlaceholder();
      setStatus('待命');
    }

    // ─── Panel toggle ────────────────────────────────────────────────

    function openPanel() {
      if (!panelEl) return;
      visible = true;
      window.setIdePanelOpen?.(true);
      if (!socket) bindSocket();
      if (toolItems.length === 0) loadTools();
    }

    function closePanel() {
      if (!panelEl) return;
      visible = false;
      window.setIdePanelOpen?.(false);
    }

    function syncActiveHost() {
      if (toolItems.length === 0 && visible) loadTools();
    }

    // ─── Initialize ──────────────────────────────────────────────────

    function initialize() {
      openBtnEl?.addEventListener('click', () => { visible ? closePanel() : openPanel(); });
      closeBtnEl?.addEventListener('click', closePanel);
      sendBtnEl?.addEventListener('click', onSend);
      stopBtnEl?.addEventListener('click', onStop);
      clearBtnEl?.addEventListener('click', onClear);
      inputEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });

      const $toolToggle = document.getElementById('ide-tool-toggle');
      const $toolPicker = document.getElementById('ide-tool-picker');
      if ($toolToggle && $toolPicker) {
        $toolToggle.addEventListener('click', () => {
          $toolPicker.classList.toggle('hidden');
          if (!$toolPicker.classList.contains('hidden') && toolItems.length === 0) loadTools();
        });
      }

      const waitSocket = setInterval(() => {
        const s = getSocket();
        if (s) { clearInterval(waitSocket); bindSocket(); }
      }, 500);

      setStatus('待命');
    }

    return {
      closePanel,
      initialize,
      syncActiveHost,
    };
  }

  window.createIdePanelModule = createIdePanelModule;
})();
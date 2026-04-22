(() => {
  'use strict';

  function createAgentPanelModule({
    getActiveHost,
    getSessionTerminalModule,
    showErrorMessage,
  }) {
    const panelEl     = document.getElementById('agent-panel');
    const openBtnEl   = document.getElementById('agent-panel-btn');
    const closeBtnEl  = document.getElementById('agent-panel-close-btn');
    const sendBtnEl   = document.getElementById('agent-send-btn');
    const stopBtnEl   = document.getElementById('agent-stop-btn');
    const clearBtnEl  = document.getElementById('agent-clear-btn');
    const inputEl     = document.getElementById('agent-input');
    const chatAreaEl  = document.getElementById('agent-chat-area');
    const statusEl    = document.getElementById('agent-status-text');

    let socket = null;
    let sessionId = null;
    let isRunning = false;
    let currentAiBody = null;
    let visible = false;

    function getSocket() {
      return getSessionTerminalModule?.()?.getSocket?.() || null;
    }

    function genSessionId() {
      return 'cli-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // ─── UI helpers ──────────────────────────────────────────────────

    function setStatus(text) { if (statusEl) statusEl.textContent = text; }

    function showPlaceholder() {
      chatAreaEl.innerHTML = `
        <div id="agent-chat-placeholder" class="text-[11px] text-slate-400 text-center py-10 flex flex-col items-center gap-2">
          <span class="text-2xl">&#128187;</span>
          <span>1Shell AI 助手<br/>输入需求，AI 会在你的主机上执行操作</span>
        </div>`;
    }

    function hidePlaceholder() {
      const ph = document.getElementById('agent-chat-placeholder');
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

      if (!sessionId) sessionId = genSessionId();

      renderUserBubble(text);
      inputEl.value = '';

      renderAiTurn();
      setRunning(true);
      setStatus('启动中...');

      socket.emit('ide:message', {
        sessionId,
        message: text,
        context: {},
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
      panelEl.classList.remove('hidden');
      panelEl.style.width = '380px';
      visible = true;
      if (!socket) bindSocket();
    }

    function closePanel() {
      if (!panelEl) return;
      panelEl.classList.add('hidden');
      panelEl.style.width = '0';
      visible = false;
    }

    function syncActiveHost() {}

    // ─── Initialize ──────────────────────────────────────────────────

    function initialize() {
      openBtnEl?.addEventListener('click', () => { visible ? closePanel() : openPanel(); });
      closeBtnEl?.addEventListener('click', closePanel);
      sendBtnEl?.addEventListener('click', onSend);
      stopBtnEl?.addEventListener('click', onStop);
      clearBtnEl?.addEventListener('click', onClear);
      inputEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });

      // 等 socket 就绪后绑定
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

  window.createAgentPanelModule = createAgentPanelModule;
})();
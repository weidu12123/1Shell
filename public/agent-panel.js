(() => {
  'use strict';

  function createAgentPanelModule({
    getActiveHost,
    getSessionTerminalModule,
    showErrorMessage,
  }) {
    const openBtnEl        = document.getElementById('agent-panel-btn');
    const closeBtnEl       = document.getElementById('agent-panel-close-btn');
    const startBtnEl       = document.getElementById('agent-start-btn');
    const startLocalBtnEl  = document.getElementById('agent-start-local-btn');
    const stopBtnEl        = document.getElementById('agent-stop-btn');
    const clearBtnEl       = document.getElementById('agent-clear-btn');
    const setupBtnEl       = document.getElementById('agent-setup-btn');
    const providerSelectEl = document.getElementById('agent-provider-select');
    const statusTextEl     = document.getElementById('agent-status-text');
    const terminalWrapEl   = document.getElementById('agent-terminal-wrap');
    const agentTabsEl      = document.getElementById('agent-tabs');

    /**
     * 会话以 hostId 为键，一台主机对应一个 Claude Code 会话：
     * state.sessions: Map<hostId, {
     *   agentSessionId, terminal, fitAddon, containerEl, resizeObserver,
     *   status, providerLabel, label
     * }>
     *
     * 竞态修复：agent:output 在 agent:start 回调前到达时缓冲到 pendingOutput，
     * 会话注册后立即回放。
     */
    const state = {
      initialized:    false,
      providersLoaded: false,
      providerLoadPromise: null,
      visible:        false,
      socketBound:    false,
      sessions:       new Map(), // sessionKey → session data + terminal
      activeSessionKey: null,
      pendingOutput:  new Map(), // agentSessionId → string[]
      sessionCounter: 0,
      providerMeta:   new Map(),
    };

    function getSocket() {
      return getSessionTerminalModule?.()?.getSocket?.() || null;
    }

    // ─── Target / status display ───────────────────────────────────────────

    function setStatus(text) {
      if (statusTextEl) statusTextEl.textContent = text;
    }

    function appendSystemLine(text, key) {
      const k = key || state.activeSessionKey;
      const sess = k ? state.sessions.get(k) : null;
      sess?.terminal?.writeln(`\x1b[36m${text}\x1b[0m`);
    }

    function escapeHtml(str) {      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    // ─── Per-session terminal management ───────────────────────────────────

    function createTerminalForSession(sessionKey) {
      const containerEl = document.createElement('div');
      containerEl.className = 'agent-session-term w-full h-full hidden rounded-lg overflow-hidden';
      containerEl.dataset.sessionKey = sessionKey;
      terminalWrapEl.appendChild(containerEl);

      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle:  'block',
        fontSize:     12,
        fontFamily:   '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        lineHeight:   1.2,
        scrollback:   3000,
        theme: {
          background:         '#09111f',
          foreground:         '#dbeafe',
          cursor:             '#7c3aed',
          selectionBackground: 'rgba(124, 58, 237, 0.28)',
        },
      });
      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerEl);
      fitAddon.fit();

      terminal.onData((data) => {
        const sess = state.sessions.get(sessionKey);
        if (!sess?.agentSessionId || state.activeSessionKey !== sessionKey) return;
        getSocket()?.emit('agent:input', { agentSessionId: sess.agentSessionId, data });
      });

      terminal.onResize(({ cols, rows }) => {
        const sess = state.sessions.get(sessionKey);
        if (!sess?.agentSessionId || state.activeSessionKey !== sessionKey) return;
        getSocket()?.emit('agent:resize', { agentSessionId: sess.agentSessionId, cols, rows });
      });

      const resizeObserver = new ResizeObserver(() => {
        if (state.activeSessionKey !== sessionKey) return;
        try { fitAddon.fit(); } catch { /* ignore */ }
      });
      resizeObserver.observe(containerEl);

      return { terminal, fitAddon, containerEl, resizeObserver };
    }

    function registerSession(sessionKey, sessionData) {
      const termData = createTerminalForSession(sessionKey);
      const sess = { ...sessionData, ...termData };
      state.sessions.set(sessionKey, sess);

      const buffered = state.pendingOutput.get(sessionData.agentSessionId);
      if (buffered?.length && sess.terminal) {
        for (const chunk of buffered) sess.terminal.write(chunk);
        state.pendingOutput.delete(sessionData.agentSessionId);
      }
    }

    function destroySession(sessionKey) {
      const sess = state.sessions.get(sessionKey);
      if (!sess) return;
      if (sess.agentSessionId) state.pendingOutput.delete(sess.agentSessionId);
      sess.resizeObserver?.disconnect();
      sess.terminal?.dispose();
      sess.containerEl?.remove();
      state.sessions.delete(sessionKey);
    }

    function switchToSession(sessionKey) {
      for (const [k, sess] of state.sessions) {
        sess.containerEl.classList.toggle('hidden', k !== sessionKey);
      }
      state.activeSessionKey = sessionKey;
      const sess = state.sessions.get(sessionKey);
      if (sess) {
        if (sess.status === 'ready')   setStatus(`运行中 · ${sess.providerLabel || 'Agent'}`);
        else if (sess.status === 'stopped') setStatus('已停止');
        else if (sess.status === 'error')   setStatus('错误');
        else                                setStatus(sess.status || '');
        setTimeout(() => {
          try { sess.fitAddon.fit(); } catch { /* ignore */ }
          sess.terminal.focus();
        }, 50);
      } else {
        setStatus('未启动');
      }
      renderAgentTabs();
      syncButtons();
    }

    // ─── Tab rendering ───────────────────────────────────────────────────────

    function renderAgentTabs() {
      if (!agentTabsEl) return;

      let html = '';
      for (const [sessionKey, sess] of state.sessions) {
        const isActive  = sessionKey === state.activeSessionKey;
        const dotColor  = sess.status === 'ready'    ? 'bg-purple-400'
                        : sess.status === 'starting' ? 'bg-amber-400'
                        : 'bg-red-400';
        const activeCls = isActive
          ? 'bg-white border-slate-200 shadow-sm text-slate-700'
          : 'bg-transparent border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600';
        const label = escapeHtml(sess.label || sessionKey);

        html +=
          `<div data-agent-tab="${escapeHtml(sessionKey)}" class="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-xs font-semibold cursor-pointer transition-all shrink-0 ${activeCls}">` +
            `<span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>` +
            `<span class="truncate max-w-[80px]">${label}</span>` +
            `<button data-agent-tab-close="${escapeHtml(sessionKey)}" class="ml-0.5 text-slate-300 hover:text-red-400 text-[10px] leading-none" title="停止并关闭">×</button>` +
          `</div>`;
      }

      html += `<button class="h-7 px-2.5 rounded-lg border border-dashed border-slate-300 text-xs text-slate-400 hover:border-purple-300 hover:text-purple-500 transition-all shrink-0" id="agent-new-session-btn">+ 新会话</button>`;
      agentTabsEl.innerHTML = html;

      document.getElementById('agent-new-session-btn')?.addEventListener('click', () => {
        Promise.resolve(runAgentStart({ forceNew: true })).catch(showErrorMessage);
      });

      for (const tabEl of agentTabsEl.querySelectorAll('[data-agent-tab]')) {
        tabEl.addEventListener('click', (e) => {
          const closeBtn = e.target.closest('[data-agent-tab-close]');
          if (closeBtn) {
            e.stopPropagation();
            stopAndRemoveSession(closeBtn.getAttribute('data-agent-tab-close'));
            return;
          }
          const key = tabEl.getAttribute('data-agent-tab');
          if (key && key !== state.activeSessionKey) switchToSession(key);
        });
      }
    }

    // ─── Session lifecycle ─────────────────────────────────────────────────

    function stopAndRemoveSession(sessionKey) {
      const socket = getSocket();
      const sess   = state.sessions.get(sessionKey);
      if (socket && sess?.agentSessionId) {
        socket.emit('agent:stop', { agentSessionId: sess.agentSessionId });
      }
      if (state.activeSessionKey === sessionKey) {
        const remaining = [...state.sessions.keys()].filter((k) => k !== sessionKey);
        if (remaining.length > 0) {
          switchToSession(remaining[remaining.length - 1]);
        } else {
          state.activeSessionKey = null;
          setStatus('未启动');
        }
      }
      destroySession(sessionKey);
      renderAgentTabs();
      syncButtons();
    }

    function syncButtons() {
      const activeSess = state.activeSessionKey ? state.sessions.get(state.activeSessionKey) : null;
      const running    = activeSess?.status === 'ready';
      if (stopBtnEl) stopBtnEl.disabled = !running;
      if (startBtnEl) startBtnEl.disabled = false;
      if (startLocalBtnEl) startLocalBtnEl.disabled = false;
    }

    // ─── MCP Setup ────────────────────────────────────────────────────────

    function syncSetupButton(configured) {
      if (!setupBtnEl) return;
      if (configured) {
        setupBtnEl.textContent = '✓ 沙箱就绪';
        setupBtnEl.classList.add('btn-link--done');
      } else {
        setupBtnEl.textContent = '⚡ 创建沙箱';
        setupBtnEl.classList.remove('btn-link--done');
      }
    }

    function getSelectedProviderMeta() {
      const providerId = providerSelectEl?.value || 'claude-code';
      return state.providerMeta.get(providerId) || null;
    }

    function syncProviderRuntimeStatus(providers = []) {
      state.providerMeta = new Map((providers || []).map((provider) => [provider.id, provider]));

      const selected = getSelectedProviderMeta();
      if (!selected) {
        setStatus('未启动');
        return;
      }

      const activeSess = state.activeSessionKey ? state.sessions.get(state.activeSessionKey) : null;
      if (activeSess?.status === 'ready' || activeSess?.status === 'starting') {
        return;
      }

      if (selected.configured) {
        const channel = selected.activeProviderName || '已配置渠道';
        const model = selected.model ? ` · ${selected.model}` : '';
        setStatus(`就绪 · ${channel}${model}`);
        return;
      }

      setStatus('未配置 API · 请先到 AI CLI 接入页配置');
    }

    function getCsrfToken() {
      const match = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    }

    async function checkMcpStatus() {
      try {
        const providerId = providerSelectEl?.value || 'claude-code';
        const res  = await fetch(`/api/agent/sandbox/status/${encodeURIComponent(providerId)}`);
        const json = await res.json();
        const sandboxed = Boolean(json?.sandboxed);
        syncSetupButton(sandboxed);
        return sandboxed;
      } catch {
        syncSetupButton(false);
        return false;
      }
    }

    async function handleSetup() {
      const provider = providerSelectEl?.value || 'claude-code';
      if (setupBtnEl) { setupBtnEl.disabled = true; setupBtnEl.textContent = '配置中…'; }
      try {
        const res  = await fetch(`/api/agent/sandbox/ensure/${encodeURIComponent(provider)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (!json.ok) {
          appendSystemLine(`[Setup] 沙箱创建失败：${json.error || '未知错误'}`);
          if (setupBtnEl) setupBtnEl.textContent = '⚡ 创建沙箱';
          return;
        }
        appendSystemLine(`[Setup] 沙箱已就绪：${json.sandboxDir || ''}`);
        appendSystemLine('[Setup] 下次启动该 CLI 时将自动接入 1Shell MCP');
        syncSetupButton(true);
      } catch (err) {
        appendSystemLine(`[Setup] 请求失败：${err.message}`);
        if (setupBtnEl) setupBtnEl.textContent = '⚡ 创建沙箱';
      } finally {
        if (setupBtnEl) setupBtnEl.disabled = false;
      }
    }

    async function ensureMcpSetup() {
      const provider = providerSelectEl?.value || 'claude-code';

      const configured = await checkMcpStatus();
      if (configured) return false;

      const meta = state.providerMeta.get(provider);
      const label = meta?.label || provider;
      appendSystemLine(`[Setup] 检测到 ${label} 沙箱未就绪，正在自动创建…`);

      const res = await fetch(`/api/agent/sandbox/ensure/${encodeURIComponent(provider)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({}),
      });
      const json = await res.json();

      if (!json.ok) {
        throw new Error(json.error || '沙箱创建失败');
      }

      syncSetupButton(true);
      appendSystemLine(`[Setup] ${label} 沙箱已就绪，新启动的会话将自动加载 1Shell 工具。`);
      return true;
    }

    // ─── Panel open / close ────────────────────────────────────────────────

    function openPanel() {
      state.visible = true;
      window.setAgentPanelOpen?.(true);
      setTimeout(() => {
        if (state.activeSessionKey) {
          try { state.sessions.get(state.activeSessionKey)?.fitAddon?.fit(); } catch { /* ignore */ }
        }
      }, 120);
    }

    function closePanel() {
      state.visible = false;
      window.setAgentPanelOpen?.(false);
    }

    // ─── Socket events ─────────────────────────────────────────────────────

    function bindSocketEvents() {
      if (state.socketBound) return;
      const socket = getSocket();
      if (!socket) return;

      socket.on('agent:status', (payload) => {
        if (!payload?.id) return;
        let sessionKey = null;
        for (const [k, s] of state.sessions) { if (s.agentSessionId === payload.id) { sessionKey = k; break; } }
        if (!sessionKey) return;

        const sess = state.sessions.get(sessionKey);
        if (!sess) return;

        sess.status       = payload.status       || sess.status;
        sess.providerId    = payload.providerId    || sess.providerId;
        sess.providerLabel = payload.providerLabel || sess.providerLabel;
        if (typeof payload.useLocalEnv === 'boolean') sess.useLocalEnv = payload.useLocalEnv;

        if (payload.status === 'error' && payload.lastError) {
          appendSystemLine(`[Agent Error] ${payload.lastError}`, sessionKey);
        }
        if (payload.status === 'stopped') {
          appendSystemLine('[Agent] 会话已停止', sessionKey);
        }

        if (state.activeSessionKey === sessionKey) {
          if (payload.status === 'ready')   setStatus(`运行中 · ${payload.providerLabel || sess.providerLabel}`);
          else if (payload.status === 'stopped') setStatus('已停止');
          else if (payload.status === 'error')   setStatus(`错误：${payload.lastError || ''}`);
        }

        renderAgentTabs();
        syncButtons();
      });

      socket.on('agent:output', (payload) => {
        if (!payload?.agentSessionId) return;
        let sessionKey = null;
        for (const [k, s] of state.sessions) { if (s.agentSessionId === payload.agentSessionId) { sessionKey = k; break; } }

        if (!sessionKey) {
          if (!state.pendingOutput.has(payload.agentSessionId)) {
            state.pendingOutput.set(payload.agentSessionId, []);
          }
          state.pendingOutput.get(payload.agentSessionId).push(payload.data || '');
          return;
        }

        state.sessions.get(sessionKey)?.terminal?.write(payload.data || '');
      });

      state.socketBound = true;
    }

    function loadProviders(force = false) {
      const socket = getSocket();
      if (!socket) return Promise.resolve([]);
      if (!force && state.providersLoaded) return Promise.resolve([...state.providerMeta.values()]);
      if (!force && state.providerLoadPromise) return state.providerLoadPromise;

      state.providerLoadPromise = new Promise((resolve) => {
        socket.emit('agent:providers', (result) => {
          if (!result?.ok) {
            state.providerLoadPromise = null;
            setStatus(result?.error || '加载 Provider 失败');
            resolve([]);
            return;
          }
          if (providerSelectEl) {
            const previousValue = providerSelectEl.value;
            providerSelectEl.innerHTML = (result.providers || []).map((p) => {
              const meta = p.configured
                ? `${p.activeProviderName ? ` · ${p.activeProviderName}` : ''}${p.model ? ` · ${p.model}` : ''}`
                : ' · 未配置 API';
              return `<option value="${p.id}" ${p.isDefault ? 'selected' : ''}>${p.label}${meta}</option>`;
            }).join('');
            // 恢复用户之前的选择，防止重建下拉框后被重置回默认值
            if (previousValue && [...providerSelectEl.options].some((o) => o.value === previousValue)) {
              providerSelectEl.value = previousValue;
            }
          }
          state.providersLoaded = true;
          state.providerLoadPromise = null;
          checkMcpStatus();
          syncProviderRuntimeStatus(result.providers || []);
          resolve(result.providers || []);
        });
      });

      return state.providerLoadPromise;
    }

    async function ensureProviderReadyForLaunch() {
      await loadProviders(true);
      const selected = getSelectedProviderMeta();
      if (!selected) {
        throw new Error('当前 CLI 不存在，请刷新页面后重试');
      }
      if (!selected.configured) {
        throw new Error('当前 CLI 未配置 API 渠道，请先到 AI CLI 接入页配置');
      }
      return selected;
    }

    async function runAgentStart({ useLocalEnv = false, forceNew = false } = {}) {
      const socket          = getSocket();
      const sessionTerminal = getSessionTerminalModule?.();
      if (!socket || !sessionTerminal) {
        throw new Error('当前环境未就绪，无法启动 Agent');
      }

      const providerId = providerSelectEl?.value || 'claude-code';

      bindSocketEvents();
      setStatus(useLocalEnv ? '本地启动中…' : '启动中…');

      let sandboxPreparedNow = false;
      try {
        if (!useLocalEnv) {
          await ensureProviderReadyForLaunch();
        }
        sandboxPreparedNow = await ensureMcpSetup();
      } catch (error) {
        setStatus(error.message || '启动 Agent 失败');
        maybeOpenCliSetup(error);
        throw error;
      }

      const sessionKey = `s${++state.sessionCounter}`;
      const providerMeta = state.providerMeta.get(providerId);
      const label = `${providerMeta?.label || providerId} #${state.sessionCounter}`;

      socket.emit('agent:start', {
        providerId,
        hostId:     'local',
        cols:       100,
        rows:       28,
        useLocalEnv,
      }, (result) => {
        if (!result?.ok) {
          setStatus(result?.error || '启动 Agent 失败');
          return;
        }

        const session = result.session;

        registerSession(sessionKey, {
          agentSessionId: session.id,
          providerId:     session.providerId,
          status:         session.status,
          providerLabel:  session.providerLabel,
          label,
          useLocalEnv:    Boolean(session.useLocalEnv),
        });

        const sess = state.sessions.get(sessionKey);
        if (sess?.terminal) {
          const { cols, rows } = sess.terminal;
          if (cols !== 100 || rows !== 28) {
            socket.emit('agent:resize', { agentSessionId: session.id, cols, rows });
          }
        }

        switchToSession(sessionKey);
        setStatus(`运行中 · ${session.providerLabel || 'Agent'}${useLocalEnv ? ' · 本地环境' : ''}`);
        syncButtons();
        renderAgentTabs();
      });
    }

    function handleProviderChange() {
      syncProviderRuntimeStatus([...state.providerMeta.values()]);
      checkMcpStatus();
    }

    function openCliSetupPage() {
      window.location.href = 'cli-setup.html';
    }

    function maybeOpenCliSetup(error) {
      const message = error?.message || '';
      if (!message.includes('未配置 API 渠道')) return;
      window.setTimeout(openCliSetupPage, 900);
    }

    // ─── Start / stop agent ────────────────────────────────────────────────

    async function startAgent() {
      return runAgentStart({ useLocalEnv: false });
    }

    async function startAgentLocal() {
      return runAgentStart({ useLocalEnv: true });
    }

    function stopAgent() {
      if (state.activeSessionKey) stopAndRemoveSession(state.activeSessionKey);
    }

    function clearTerminal() {
      const sess = state.activeSessionKey ? state.sessions.get(state.activeSessionKey) : null;
      sess?.terminal?.clear();
    }

    // ─── Socket lifecycle ──────────────────────────────────────────────────

    function handleSocketLifecycle(type) {
      if (type === 'socket-connect') {
        state.socketBound = false;
        bindSocketEvents();
        loadProviders();
      }
      if (type === 'socket-disconnect') {
        for (const sess of state.sessions.values()) sess.status = 'stopped';
        setStatus('未连接');
        renderAgentTabs();
        syncButtons();
      }
    }

    // ─── Initialize ────────────────────────────────────────────────────────

    function initialize() {
      if (state.initialized) return;
      state.initialized = true;

      openBtnEl?.addEventListener('click', () => {
        if (state.visible) {
          closePanel();
        } else {
          openPanel();
          bindSocketEvents();
          loadProviders();
        }
      });

      closeBtnEl?.addEventListener('click', closePanel);
      startBtnEl?.addEventListener('click', () => {
        Promise.resolve(startAgent()).catch(showErrorMessage);
      });
      startLocalBtnEl?.addEventListener('click', () => {
        Promise.resolve(startAgentLocal()).catch(showErrorMessage);
      });
      stopBtnEl?.addEventListener('click', stopAgent);
      clearBtnEl?.addEventListener('click', clearTerminal);
      providerSelectEl?.addEventListener('change', handleProviderChange);
      setupBtnEl?.addEventListener('click', handleSetup);

      const sessionTerminal = getSessionTerminalModule?.();
      sessionTerminal?.onLifecycle?.(({ type }) => handleSocketLifecycle(type));

      setStatus('未启动');
      syncButtons();
      renderAgentTabs();
    }

    return {
      closePanel,
      initialize,
    };
  }

  window.createAgentPanelModule = createAgentPanelModule;
})();
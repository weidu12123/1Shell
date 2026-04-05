(() => {
  'use strict';

  function createAgentPanelModule({
    getActiveHost,
    getSessionTerminalModule,
    showErrorMessage,
  }) {
    const openBtnEl = document.getElementById('agent-panel-btn');
    const panelEl = document.getElementById('agent-panel');
    const closeBtnEl = document.getElementById('agent-panel-close-btn');
    const startBtnEl = document.getElementById('agent-start-btn');
    const stopBtnEl = document.getElementById('agent-stop-btn');
    const clearBtnEl = document.getElementById('agent-clear-btn');
    const setupBtnEl = document.getElementById('agent-setup-btn');
    const providerSelectEl = document.getElementById('agent-provider-select');
    const targetTextEl = document.getElementById('agent-target-text');
    const statusTextEl = document.getElementById('agent-status-text');
    const terminalMountEl = document.getElementById('agent-terminal');

    const state = {
      initialized: false,
      providersLoaded: false,
      visible: false,
      terminal: null,
      fitAddon: null,
      resizeObserver: null,
      socketBound: false,
      currentAgentSessionId: null,
      currentProviderId: '',
      currentHostId: '',
      currentStatus: '未启动',
    };

    function getSocket() {
      return getSessionTerminalModule?.()?.getSocket?.() || null;
    }

    function renderTarget() {
      const host = getActiveHost?.();
      if (!host) {
        targetTextEl.textContent = '当前目标：未选择主机';
        return;
      }
      state.currentHostId = host.id;
      const meta = host.type === 'local'
        ? '本机 / 控制节点'
        : `${host.username}@${host.host}:${host.port}`;
      targetTextEl.textContent = `当前目标：${host.name} (${meta})`;
    }

    function setStatus(text) {
      state.currentStatus = text;
      statusTextEl.textContent = text;
    }

    function appendSystemLine(text) {
      state.terminal?.writeln(`\x1b[36m${text}\x1b[0m`);
    }

    function ensureTerminal() {
      if (state.terminal) return;
      state.terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 12,
        fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        lineHeight: 1.2,
        scrollback: 3000,
        theme: {
          background: '#09111f',
          foreground: '#dbeafe',
          cursor: '#7c3aed',
          selectionBackground: 'rgba(124, 58, 237, 0.28)',
        },
      });
      state.fitAddon = new FitAddon.FitAddon();
      state.terminal.loadAddon(state.fitAddon);
      state.terminal.open(terminalMountEl);
      state.fitAddon.fit();

      state.terminal.onData((data) => {
        if (!state.currentAgentSessionId) return;
        getSocket()?.emit('agent:input', {
          agentSessionId: state.currentAgentSessionId,
          data,
        });
      });

      state.terminal.onResize(({ cols, rows }) => {
        if (!state.currentAgentSessionId) return;
        getSocket()?.emit('agent:resize', {
          agentSessionId: state.currentAgentSessionId,
          cols,
          rows,
        });
      });

      state.terminal.onKey(({ domEvent }) => {
        if (domEvent.ctrlKey && domEvent.key.toLowerCase() === 'c') {
          return;
        }
      });

      state.resizeObserver = new ResizeObserver(() => {
        try {
          state.fitAddon?.fit();
        } catch {
          // ignore
        }
      });
      state.resizeObserver.observe(terminalMountEl);
    }

    function syncButtons() {
      const running = Boolean(state.currentAgentSessionId);
      startBtnEl.disabled = running;
      providerSelectEl.disabled = running;
      stopBtnEl.disabled = !running;
    }

    // ─── 一键 MCP 接入 ──────────────────────────────────────────────────────

    function syncSetupButton(configured) {
      if (!setupBtnEl) return;
      if (configured) {
        setupBtnEl.textContent = '✓ 已接入';
        setupBtnEl.classList.add('btn-link--done');
      } else {
        setupBtnEl.textContent = '⚡ 一键接入';
        setupBtnEl.classList.remove('btn-link--done');
      }
    }

    async function checkMcpStatus() {
      try {
        const res = await fetch('/api/agent/mcp-status');
        const json = await res.json();
        const provider = providerSelectEl.value || 'claude-code';
        const configured = json?.status?.providers?.[provider]?.configured || false;
        syncSetupButton(configured);
      } catch {
        // 静默忽略
      }
    }

    async function handleSetup() {
      const provider = providerSelectEl.value || 'claude-code';
      setupBtnEl.disabled = true;
      setupBtnEl.textContent = '配置中…';

      try {
        const res = await fetch('/api/agent/mcp-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const json = await res.json();

        if (!json.ok) {
          appendSystemLine(`[Setup] 配置失败：${json.error || '未知错误'}`);
          setupBtnEl.textContent = '⚡ 一键接入';
          return;
        }

        if (json.note) {
          appendSystemLine(`[Setup] ${json.note}`);
          syncSetupButton(true);
        } else {
          appendSystemLine(`[Setup] MCP 配置成功：${json.configFile || ''}`);
          appendSystemLine('[Setup] 下次启动 claude-code 时将自动接入 1Shell Bridge');
          syncSetupButton(true);
        }
      } catch (err) {
        appendSystemLine(`[Setup] 请求失败：${err.message}`);
        setupBtnEl.textContent = '⚡ 一键接入';
      } finally {
        setupBtnEl.disabled = false;
      }
    }

    function openPanel() {
      panelEl.classList.remove('hidden');
      state.visible = true;
      ensureTerminal();
      renderTarget();
      requestAnimationFrame(() => {
        state.fitAddon?.fit();
        state.terminal?.focus();
      });
    }

    function closePanel() {
      panelEl.classList.add('hidden');
      state.visible = false;
    }

    function bindSocketEvents() {
      if (state.socketBound) return;
      const socket = getSocket();
      if (!socket) return;

      socket.on('agent:status', (payload) => {
        if (!payload?.id) return;
        if (state.currentAgentSessionId && payload.id !== state.currentAgentSessionId) return;

        state.currentAgentSessionId = payload.status === 'stopped' || payload.status === 'error'
          ? null
          : payload.id;
        state.currentProviderId = payload.providerId || state.currentProviderId;
        state.currentHostId = payload.hostId || state.currentHostId;
        setStatus(payload.status === 'ready' ? `运行中 · ${payload.providerLabel}` : payload.status || '未知状态');

        if (payload.status === 'error' && payload.lastError) {
          appendSystemLine(`[Agent Error] ${payload.lastError}`);
        }
        if (payload.status === 'stopped') {
          appendSystemLine('[Agent] 会话已停止');
        }
        syncButtons();
      });

      socket.on('agent:output', (payload) => {
        if (!payload?.agentSessionId || payload.agentSessionId !== state.currentAgentSessionId) return;
        state.terminal?.write(payload.data || '');
      });

      state.socketBound = true;
    }

    function loadProviders() {
      const socket = getSocket();
      if (!socket || state.providersLoaded) return;

      socket.emit('agent:providers', (result) => {
        if (!result?.ok) {
          setStatus(result?.error || '加载 Agent Provider 失败');
          return;
        }

        providerSelectEl.innerHTML = (result.providers || []).map((provider) => `
          <option value="${provider.id}" ${provider.isDefault ? 'selected' : ''}>${provider.label}</option>
        `).join('');
        state.providersLoaded = true;
        state.currentProviderId = result.defaultProviderId || providerSelectEl.value || '';
        checkMcpStatus();
      });
    }

    function startAgent() {
      const socket = getSocket();
      const sessionTerminal = getSessionTerminalModule?.();
      const host = getActiveHost?.();
      if (!socket || !sessionTerminal || !host) {
        throw new Error('当前环境未就绪，无法启动 Agent');
      }

      ensureTerminal();
      bindSocketEvents();
      loadProviders();
      state.terminal.clear();
      setStatus('启动中…');

      socket.emit('agent:start', {
        providerId: providerSelectEl.value || state.currentProviderId || 'claude-code',
        hostId: host.id,
        cols: state.terminal.cols,
        rows: state.terminal.rows,
      }, (result) => {
        if (!result?.ok) {
          setStatus(result?.error || '启动 Agent 失败');
          appendSystemLine(`[Agent] ${result?.error || '启动失败'}`);
          syncButtons();
          return;
        }

        state.currentAgentSessionId = result.session?.id || null;
        state.currentProviderId = result.session?.providerId || providerSelectEl.value;
        setStatus(`运行中 · ${result.session?.providerLabel || 'Agent'}`);
        appendSystemLine(`[Agent] 已连接 ${result.session?.providerLabel || 'Agent'}`);
        syncButtons();
        state.terminal.focus();
      });
    }

    function stopAgent() {
      const socket = getSocket();
      if (!socket || !state.currentAgentSessionId) return;
      socket.emit('agent:stop', { agentSessionId: state.currentAgentSessionId });
    }

    function clearTerminal() {
      state.terminal?.clear();
    }

    function syncActiveHost() {
      renderTarget();
      const socket = getSocket();
      const host = getActiveHost?.();
      if (!socket || !host || !state.currentAgentSessionId) return;

      socket.emit('agent:focus-host', {
        agentSessionId: state.currentAgentSessionId,
        hostId: host.id,
      }, (result) => {
        if (!result?.ok) {
          appendSystemLine(`[Agent] 主机上下文同步失败：${result?.error || '未知错误'}`);
        }
      });
    }

    function handleSocketLifecycle(type) {
      if (type === 'socket-connect') {
        state.socketBound = false;
        bindSocketEvents();
        loadProviders();
      }
      if (type === 'socket-disconnect') {
        state.currentAgentSessionId = null;
        setStatus('未连接');
        syncButtons();
      }
    }

    function initialize() {
      if (state.initialized) return;
      state.initialized = true;

      openBtnEl.addEventListener('click', () => {
        if (state.visible) {
          closePanel();
        } else {
          openPanel();
          bindSocketEvents();
          loadProviders();
        }
      });
      closeBtnEl.addEventListener('click', closePanel);
      startBtnEl.addEventListener('click', () => {
        try {
          startAgent();
        } catch (error) {
          showErrorMessage(error);
        }
      });
      stopBtnEl.addEventListener('click', stopAgent);
      clearBtnEl.addEventListener('click', clearTerminal);
      providerSelectEl.addEventListener('change', () => {
        state.currentProviderId = providerSelectEl.value;
        checkMcpStatus();
      });

      if (setupBtnEl) {
        setupBtnEl.addEventListener('click', handleSetup);
      }

      const sessionTerminal = getSessionTerminalModule?.();
      sessionTerminal?.onLifecycle?.(({ type }) => {
        handleSocketLifecycle(type);
      });

      renderTarget();
      setStatus('未启动');
      syncButtons();
    }

    return {
      closePanel,
      initialize,
      syncActiveHost,
    };
  }

  window.createAgentPanelModule = createAgentPanelModule;
})();

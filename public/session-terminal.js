(() => {
  'use strict';

  function createSessionTerminalModule({
    LOCAL_HOST_ID,
    handleAuthExpired,
    loadHosts,
    loginErrorEl,
    renderHosts,
    setSessionStatus,
    state,
    terminalContainerEl,
    terminalHintEl,
    updateActiveHostUI,
  }) {
    const isDark = document.documentElement.classList.contains('dark');

    const DARK_THEME = {
      background: '#0f1729',
      foreground: '#dbeafe',
      cursor: '#4f8cff',
      selectionBackground: 'rgba(79, 140, 255, 0.28)',
      black: '#1f2937',   red: '#f87171',   green: '#4ade80',  yellow: '#fbbf24',
      blue: '#60a5fa',    magenta: '#c084fc', cyan: '#22d3ee',  white: '#e5eefc',
      brightBlack: '#4b5563',   brightRed: '#fca5a5',    brightGreen: '#86efac',
      brightYellow: '#fcd34d',  brightBlue: '#93c5fd',   brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',    brightWhite: '#f8fafc',
    };

    const LIGHT_THEME = {
      background: '#ffffff',
      foreground: '#1e293b',
      cursor: '#3b82f6',
      selectionBackground: 'rgba(59, 130, 246, 0.18)',
      black: '#374151',   red: '#dc2626',   green: '#16a34a',  yellow: '#ca8a04',
      blue: '#2563eb',    magenta: '#7c3aed', cyan: '#0891b2',  white: '#f8fafc',
      brightBlack: '#6b7280',   brightRed: '#ef4444',   brightGreen: '#22c55e',
      brightYellow: '#eab308',  brightBlue: '#3b82f6',  brightMagenta: '#a855f7',
      brightCyan: '#06b6d4',    brightWhite: '#ffffff',
    };

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      lineHeight: 1.25,
      scrollback: 5000,
      theme: isDark ? DARK_THEME : LIGHT_THEME,
    });

    // 监听主题切换，实时更新终端配色
    const themeObserver = new MutationObserver(() => {
      const nowDark = document.documentElement.classList.contains('dark');
      term.options.theme = nowDark ? DARK_THEME : LIGHT_THEME;
    });
    themeObserver.observe(document.documentElement, { attributeFilter: ['class'] });
    const fitAddon = new FitAddon.FitAddon();
    const inputListeners = new Set();
    const outputListeners = new Set();
    const lifecycleListeners = new Set();
    let socket = null;
    let initialized = false;

    term.loadAddon(fitAddon);

    function emitTo(listeners, payload) {
      listeners.forEach((listener) => {
        try {
          listener(payload);
        } catch (_) {
        }
      });
    }

    function notifyInput(data, meta = {}) {
      emitTo(inputListeners, {
        data: String(data || ''),
        meta,
      });
    }

    function notifyOutput(payload) {
      emitTo(outputListeners, payload);
    }

    function notifyLifecycle(type, payload = {}) {
      emitTo(lifecycleListeners, { type, ...payload });
    }

    function onInput(listener) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    }

    function onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    }

    function onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    }

    function clearTerminal() {
      term.clear();
      notifyLifecycle('clear');
      term.focus();
    }

    function resetTerminal() {
      term.clear();
      notifyLifecycle('reset');
    }

    function focusTerminal() {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          if (socket && state.activeSessionId) {
            socket.emit('session:resize', {
              sessionId: state.activeSessionId,
              cols: term.cols,
              rows: term.rows,
            });
          }
          term.focus();
        } catch (_) {
        }
      });
    }

    function disconnectSocket() {
      if (!socket) return;
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
      notifyLifecycle('socket-disconnect');
    }

    function attachSocketListeners() {
      if (!socket) return;

      socket.on('connect', async () => {
        loginErrorEl.textContent = '';
        terminalHintEl.textContent = 'Socket 已连接，正在进入默认本机会话…';
        notifyLifecycle('socket-connect');
        try {
          await loadHosts();
          await connectToHost(state.activeHostId || LOCAL_HOST_ID, true);
        } catch (error) {
          setSessionStatus('error', error.message);
          terminalHintEl.textContent = error.message;
        }
      });

      socket.on('disconnect', (reason) => {
        const disconnectedByLogout = reason === 'io client disconnect';
        setSessionStatus('closed', disconnectedByLogout ? '已退出登录' : '连接已断开');
        terminalHintEl.textContent = disconnectedByLogout
          ? '已退出登录'
          : 'Socket 连接断开，请刷新页面重试';
        notifyLifecycle('socket-disconnect', { reason });
      });

      socket.on('connect_error', (error) => {
        if (error?.message === 'UNAUTHORIZED') {
          handleAuthExpired('登录已失效，请重新登录');
          return;
        }

        setSessionStatus('error', error?.message || 'Socket 连接失败');
        terminalHintEl.textContent = error?.message || 'Socket 连接失败';
        notifyLifecycle('socket-error', { error: error?.message || 'Socket 连接失败' });
      });

      socket.on('session:output', ({ sessionId, data }) => {
        if (!sessionId) return;

        const output = String(data || '');
        const previous = state.sessionBuffers.get(sessionId) || '';
        const next = (previous + output).slice(-200000);
        state.sessionBuffers.set(sessionId, next);

        if (sessionId !== state.activeSessionId) return;
        notifyOutput({ sessionId, data: output });
        term.write(output);
      });

      socket.on('session:status', (session) => {
        state.sessionMap.set(session.id, session);
        notifyLifecycle('session-status', {
          hostId: session.hostId,
          sessionId: session.id,
          status: session.status,
        });

        if (session.id === state.activeSessionId) {
          const textMap = {
            connecting: '连接中…',
            ready: session.warning || '已连接',
            error: session.lastError || '连接失败',
            closed: '已关闭',
          };
          setSessionStatus(session.status, textMap[session.status] || session.status);
          if (session.status === 'ready') {
            if (session.hostId !== LOCAL_HOST_ID) {
              terminalHintEl.textContent = `当前终端已切换到 ${session.hostName}`;
              setTimeout(() => {
                if (terminalHintEl.textContent === `当前终端已切换到 ${session.hostName}`) {
                  terminalHintEl.textContent = '';
                }
              }, 3000);
            } else {
              terminalHintEl.textContent = '';
            }
          }
          if (session.status === 'error') {
            terminalHintEl.textContent = session.lastError || '会话错误';
          }
        }

        if (session.status === 'closed' || session.status === 'error') {
          if (session.id === state.activeSessionId && session.status === 'closed') {
            terminalHintEl.textContent = `${session.hostName} 会话已关闭`;
          }

          if (session.status === 'closed') {
            state.sessionBuffers.delete(session.id);
          }
        }

        renderHosts();
      });
    }

    function connectSocket() {
      if (socket) return;
      socket = io({
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      });

      socket.on('disconnect', (reason) => {
        setSessionStatus('error', `连接断开: ${reason}，正在重连…`);
      });

      socket.on('reconnect', () => {
        setSessionStatus('ready', '已重新连接');
        window.appShared.showToast?.('WebSocket 已重新连接', 'success');
        // 重连后自动恢复当前主机会话
        if (state.activeHostId) {
          connectToHost(state.activeHostId, true).catch(() => {});
        }
      });

      socket.on('reconnect_attempt', (attempt) => {
        setSessionStatus('error', `正在重连… (第 ${attempt} 次)`);
      });

      attachSocketListeners();
    }

    function findSessionByHost(hostId) {
      for (const session of state.sessionMap.values()) {
        if (session.hostId === hostId && session.status !== 'closed') return session;
      }
      return null;
    }

    function callSessionCreate(hostId) {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error('Socket 未连接'));
          return;
        }

        socket.emit('session:create', {
          hostId,
          cols: term.cols,
          rows: term.rows,
        }, (result) => {
          if (!result?.ok) {
            reject(new Error(result?.error || '会话创建失败'));
            return;
          }
          resolve(result.session);
        });
      });
    }

    async function connectToHost(hostId, forceReconnect = false) {
      const host = state.hostMap.get(hostId);
      if (!host) return;

      notifyLifecycle('host-switch-start', { hostId, forceReconnect });
      state.activeHostId = hostId;
      updateActiveHostUI();
      renderHosts();
      terminalHintEl.textContent = `正在连接 ${host.name}…`;
      setSessionStatus('connecting', '连接中…');
      clearTerminal();

      try {
        let session = null;

        if (forceReconnect) {
          const previous = findSessionByHost(hostId);
          if (previous) {
            socket?.emit('session:close', { sessionId: previous.id });
            state.sessionMap.delete(previous.id);
            state.sessionBuffers.delete(previous.id);
          }
        } else {
          session = findSessionByHost(hostId);
        }

        if (!session) {
          session = await callSessionCreate(hostId);
          state.sessionMap.set(session.id, session);
        }

        state.activeSessionId = session.id;
        notifyLifecycle('session-change', {
          hostId,
          sessionId: session.id,
          forceReconnect,
        });
        term.write(state.sessionBuffers.get(session.id) || '');
        if (hostId !== LOCAL_HOST_ID) {
          terminalHintEl.textContent = `当前终端已切换到 ${host.name}`;
          setTimeout(() => {
            if (terminalHintEl.textContent === `当前终端已切换到 ${host.name}`) {
              terminalHintEl.textContent = '';
            }
          }, 3000);
        } else {
          terminalHintEl.textContent = '';
        }
        setSessionStatus(session.status, session.status === 'ready' ? '已连接' : session.status);
        renderHosts();
        focusTerminal();
      } catch (error) {
        setSessionStatus('error', error.message);
        terminalHintEl.textContent = error.message;
        notifyLifecycle('session-error', { hostId, error: error.message });
      }
    }

    function sendSessionInput(data, meta = {}) {
      if (!socket || !state.activeSessionId) return false;
      const payload = String(data || '');
      if (!payload) return false;

      notifyInput(payload, meta);
      socket.emit('session:input', {
        sessionId: state.activeSessionId,
        data: payload,
      });
      return true;
    }

    function initialize() {
      if (initialized) return;
      initialized = true;

      // 延迟打开终端，等登录成功后再 open
      const appShell = document.getElementById('app-shell');
      if (appShell && !appShell.classList.contains('hidden')) {
        term.open(terminalContainerEl);
        fitAddon.fit();
      } else if (appShell) {
        const observer = new MutationObserver(() => {
          if (!appShell.classList.contains('hidden')) {
            term.open(terminalContainerEl);
            fitAddon.fit();
            observer.disconnect();
          }
        });
        observer.observe(appShell, { attributes: true, attributeFilter: ['class'] });
      }

      term.onData((data) => {
        sendSessionInput(data);
      });

      window.addEventListener('resize', focusTerminal);
    }

    return {
      clearTerminal,
      connectSocket,
      connectToHost,
      disconnectSocket,
      focusTerminal,
      getActiveBuffer: () => state.sessionBuffers.get(state.activeSessionId) || '',
      getActiveSessionId: () => state.activeSessionId,
      getSocket: () => socket,
      getTerminal: () => term,
      initialize,
      onInput,
      onLifecycle,
      onOutput,
      resetTerminal,
      sendSessionInput,
    };
  }

  window.createSessionTerminalModule = createSessionTerminalModule;
})();

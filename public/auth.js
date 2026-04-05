(() => {
  'use strict';

  function createAuthModule({
    getSessionTerminalModule,
    loginErrorEl,
    onAuthExpired,
    requestJson,
    setSessionStatus,
    showErrorMessage,
    state,
    terminalHintEl,
  }) {
    const loginScreenEl = document.getElementById('login-screen');
    const appShellEl = document.getElementById('app-shell');
    const loginFormEl = document.getElementById('login-form');
    const loginPasswordEl = document.getElementById('login-password');
    const logoutBtnEl = document.getElementById('logout-btn');
    let initialized = false;

    function getSessionTerminal() {
      return getSessionTerminalModule?.() || null;
    }

    function resetSessionRuntime() {
      state.authenticated = false;
      state.activeSessionId = null;
      state.sessionMap.clear();
      state.sessionBuffers.clear();
    }

    function renderAuthState() {
      loginScreenEl.classList.toggle('hidden', state.authenticated);
      appShellEl.classList.toggle('hidden', !state.authenticated);
      logoutBtnEl.classList.toggle('hidden', !state.authEnabled || !state.authenticated);

      if (!state.authenticated) {
        requestAnimationFrame(() => loginPasswordEl.focus());
      }
    }

    function handleAuthExpired(message = '未登录或登录已失效') {
      const sessionTerminalModule = getSessionTerminal();
      resetSessionRuntime();
      sessionTerminalModule?.disconnectSocket();
      onAuthExpired?.();
      renderAuthState();
      setSessionStatus('closed', '未登录');
      terminalHintEl.textContent = message;
      loginErrorEl.textContent = message;
      sessionTerminalModule?.resetTerminal();
    }

    async function checkAuthStatus() {
      const data = await requestJson('/api/auth/status');
      const sessionTerminalModule = getSessionTerminal();
      state.authEnabled = Boolean(data.enabled);
      state.authenticated = Boolean(data.authenticated);
      renderAuthState();

      if (state.authenticated) {
        sessionTerminalModule?.connectSocket();
        sessionTerminalModule?.focusTerminal();
      } else {
        sessionTerminalModule?.disconnectSocket();
      }
    }

    async function login(event) {
      event.preventDefault();
      loginErrorEl.textContent = '';

      try {
        await requestJson('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ password: loginPasswordEl.value }),
        });
        loginPasswordEl.value = '';
        await checkAuthStatus();
      } catch (error) {
        loginErrorEl.textContent = error.message;
      }
    }

    async function logout() {
      const sessionTerminalModule = getSessionTerminal();
      await requestJson('/api/auth/logout', { method: 'POST' });
      resetSessionRuntime();
      sessionTerminalModule?.disconnectSocket();
      onAuthExpired?.();
      loginErrorEl.textContent = '';
      setSessionStatus('closed', '已退出登录');
      terminalHintEl.textContent = '已退出登录';
      sessionTerminalModule?.resetTerminal();
      renderAuthState();
    }

    function initialize() {
      if (initialized) return;
      initialized = true;

      loginFormEl.addEventListener('submit', login);
      logoutBtnEl.addEventListener('click', () => {
        logout().catch(showErrorMessage);
      });
    }

    return {
      checkAuthStatus,
      handleAuthExpired,
      initialize,
      renderAuthState,
    };
  }

  window.createAuthModule = createAuthModule;
})();

(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showErrorMessage } = window.appShared;
  const LOCAL_HOST_ID = 'local';
  const loginErrorEl = document.getElementById('login-error');

  const state = {
    hosts: [],
    hostMap: new Map(),
    filteredKeyword: '',
    activeHostId: LOCAL_HOST_ID,
    activeSessionId: null,
    sessionMap: new Map(),
    sessionBuffers: new Map(),
    authEnabled: false,
    authenticated: false,
  };

  const activeHostNameEl = document.getElementById('active-host-name');
  const activeHostMetaEl = document.getElementById('active-host-meta');
  const aiContextTextEl = document.getElementById('ai-context-text');
  const sessionStatusDotEl = document.getElementById('session-status-dot');
  const sessionStatusTextEl = document.getElementById('session-status-text');
  const terminalHintEl = document.getElementById('terminal-hint');
  const terminalContainerEl = document.getElementById('terminal-container');
  let authModule = null;
  let aiChatModule = null;
  let terminalAiModule = null;
  let terminalAnalyzeModule = null;
  let fileBrowserModule = null;
  let agentPanelModule = null;

  function setSessionStatus(status, text) {
    sessionStatusDotEl.className = `status-dot ${status || ''}`.trim();
    sessionStatusTextEl.textContent = text;
  }

  function getActiveHost() {
    return state.hostMap.get(state.activeHostId) || state.hostMap.get(LOCAL_HOST_ID) || null;
  }

  function formatHostMeta(host) {
    if (!host) return '';
    if (host.type === 'local') return '部署节点 / 本地 Shell';
    return `${host.username}@${host.host}:${host.port}`;
  }

  function updateActiveHostUI() {
    const host = getActiveHost();
    activeHostNameEl.textContent = host?.name || '未选择';
    activeHostMetaEl.textContent = formatHostMeta(host);
    aiContextTextEl.textContent = `当前上下文：${host?.name || '未选择主机'}`;
    aiChatModule?.syncActiveHost();
    agentPanelModule?.syncActiveHost();
    fileBrowserModule?.syncActiveHost();
    // 事件总线广播，未来新模块只需 appBus.on('host:changed') 即可
    window.appBus?.emit('host:changed', host);
  }

  const requestJson = createRequestJson({
    onUnauthorized: (message, url) => {
      if (!String(url).startsWith('/api/auth/')) {
        authModule?.handleAuthExpired(message);
      }
    },
  });

  authModule = window.createAuthModule({
    getSessionTerminalModule: () => sessionTerminalModule,
    loginErrorEl,
    onAuthExpired: () => {
      agentPanelModule?.closePanel();
    },
    requestJson,
    setSessionStatus,
    showErrorMessage,
    state,
    terminalHintEl,
  });

  const hostsModule = window.createHostsModule({
    LOCAL_HOST_ID,
    escapeHtml,
    getSessionTerminalModule: () => sessionTerminalModule,
    requestJson,
    showErrorMessage,
    showToast: window.appShared.showToast,
    state,
    updateActiveHostUI,
  });

  const sessionTerminalModule = window.createSessionTerminalModule({
    LOCAL_HOST_ID,
    handleAuthExpired: authModule.handleAuthExpired,
    loadHosts: hostsModule.loadHosts,
    loginErrorEl,
    renderHosts: hostsModule.renderHosts,
    setSessionStatus,
    state,
    terminalContainerEl,
    terminalHintEl,
    updateActiveHostUI,
  });

  const probeModule = window.createProbeModule({
    escapeHtml,
    getSocket: () => sessionTerminalModule.getSocket(),
    requestJson,
    showErrorMessage,
  });

  terminalAiModule = window.createTerminalAiModule({
    getActiveHost,
    getSessionTerminalModule: () => sessionTerminalModule,
    requestJson,
  });

  aiChatModule = window.createAiChatModule({
    escapeHtml,
    getActiveHost,
    handleAuthExpired: authModule.handleAuthExpired,
    showErrorMessage,
  });

  agentPanelModule = window.createAgentPanelModule({
    getActiveHost,
    getSessionTerminalModule: () => sessionTerminalModule,
    showErrorMessage,
  });

  const commandSuggestionModule = window.createCommandSuggestionModule({
    getActiveHost,
    getSessionTerminalModule: () => sessionTerminalModule,
    requestJson,
    showErrorMessage,
  });

  terminalAnalyzeModule = window.createTerminalAnalyzeModule({
    escapeHtml,
    getActiveHost,
    getRecentCommands: () => terminalAiModule?.getRecentCommands?.() || [],
    getSessionTerminalModule: () => sessionTerminalModule,
    onCloseAiPanel: () => {
      // 修复3：打开分析面板时收起 AI Chat（避免视觉重叠）
      // ai-panel 本身是布局流中固定宽度列，分析面板 fixed 覆盖其上方
      // 通过暂时隐藏 ai-panel 的方式实现让位
      document.querySelector('.ai-panel')?.classList.add('ai-panel--hidden-by-analyze');
    },
    requestJson,
    showErrorMessage,
  });

  fileBrowserModule = window.createFileBrowserModule({
    escapeHtml,
    getActiveHost,
    requestJson,
    showErrorMessage,
    state,
  });

  sessionTerminalModule.initialize();
  authModule.initialize();
  hostsModule.initialize();
  probeModule.initialize();
  terminalAiModule.initialize();
  aiChatModule.initialize();
  agentPanelModule.initialize();
  commandSuggestionModule.initialize();
  terminalAnalyzeModule.initialize();
  fileBrowserModule.initialize();

  document.getElementById('clear-term-btn').addEventListener('click', () => {
    sessionTerminalModule.clearTerminal();
  });
  document.getElementById('reconnect-btn').addEventListener('click', () => {
    sessionTerminalModule.connectToHost(state.activeHostId, true).catch(showErrorMessage);
  });

  // 移动端侧边栏 toggle
  const sidebarEl = document.querySelector('.sidebar');
  const overlayEl = document.getElementById('mobile-overlay');
  const menuBtnEl = document.getElementById('mobile-menu-btn');

  function closeMobileSidebar() {
    sidebarEl.classList.remove('mobile-open');
    overlayEl.classList.remove('visible');
  }

  if (menuBtnEl) {
    menuBtnEl.addEventListener('click', () => {
      const isOpen = sidebarEl.classList.toggle('mobile-open');
      overlayEl.classList.toggle('visible', isOpen);
    });
  }
  if (overlayEl) {
    overlayEl.addEventListener('click', closeMobileSidebar);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hostsModule.closeHostModal();
      probeModule.closeProbeDrawer();
      commandSuggestionModule.closeCmdModal();
      terminalAnalyzeModule.closePanel();
      // 分析面板关闭时恢复 AI Chat 面板
      document.querySelector('.ai-panel')?.classList.remove('ai-panel--hidden-by-analyze');
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      commandSuggestionModule.openCmdModal();
    }
  });

  // 终端 Tabs 接入真实会话
  if (typeof window.initTerminalTabs === 'function') {
    window.initTerminalTabs(sessionTerminalModule, state);
  }

  setSessionStatus('closed', '初始化中…');
  terminalHintEl.textContent = '正在检查登录状态…';
  aiChatModule.resetChat();
  authModule.checkAuthStatus().catch((error) => {
    setSessionStatus('error', error.message);
    terminalHintEl.textContent = error.message;
    loginErrorEl.textContent = error.message;
    authModule.renderAuthState();
  });
})();

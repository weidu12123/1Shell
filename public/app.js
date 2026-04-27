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
  let idePanelModule = null;
  let scriptInjectModule = null;

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
      idePanelModule?.closePanel();
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

  terminalAiModule = window.createTerminalAiModule({
    escapeHtml,
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

  idePanelModule = window.createIdePanelModule({
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

  scriptInjectModule = window.createScriptInjectModule({
    escapeHtml,
    getActiveHost,
    getSessionTerminalModule: () => sessionTerminalModule,
    requestJson,
    showErrorMessage,
  });

  sessionTerminalModule.initialize();
  authModule.initialize();
  hostsModule.initialize();
  terminalAiModule.initialize();
  aiChatModule.initialize();
  agentPanelModule.initialize();
  idePanelModule.initialize();
  commandSuggestionModule.initialize();
  terminalAnalyzeModule.initialize();
  fileBrowserModule.initialize();
  scriptInjectModule.initialize();

  // 顶栏探针：延迟注入 socket（socket 在首次 connectToHost 时才创建）
  const _topbarProbeCheck = setInterval(() => {
    const s = sessionTerminalModule.getSocket();
    if (s) {
      clearInterval(_topbarProbeCheck);
      window.initTopbarProbe?.(s);
    }
  }, 1000);

  document.getElementById('clear-term-btn').addEventListener('click', () => {
    sessionTerminalModule.clearTerminal();
  });
  document.getElementById('reconnect-btn').addEventListener('click', () => {
    sessionTerminalModule.connectToHost(state.activeHostId, true).catch(showErrorMessage);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hostsModule.closeHostModal();
      commandSuggestionModule.closeCmdModal();
      terminalAnalyzeModule.closePanel();
      scriptInjectModule.closeScriptPanel();
      scriptInjectModule.closePlaybookPanel();
      document.getElementById('settings-modal')?.classList.add('hidden');
      document.getElementById('ai-api-modal')?.classList.add('hidden');
      // 分析面板关闭时恢复 AI Chat 面板
      document.querySelector('.ai-panel')?.classList.remove('ai-panel--hidden-by-analyze');
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      commandSuggestionModule.openCmdModal();
    }
  });

  // ── 设置弹窗 ──────────────────────────────────────────────
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsForm = document.getElementById('settings-form');
  const settingsCloseBtn = document.getElementById('settings-modal-close');
  const settingsErrorEl = document.getElementById('settings-error');

  // Tab 切换
  document.getElementById('settings-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.settings-tab-btn').forEach(b => {
      b.classList.toggle('bg-blue-500', b.dataset.tab === tab);
      b.classList.toggle('text-white', b.dataset.tab === tab);
      b.classList.toggle('border', b.dataset.tab !== tab);
      b.classList.toggle('border-slate-200', b.dataset.tab !== tab);
      b.classList.toggle('text-slate-500', b.dataset.tab !== tab);
    });
    document.querySelectorAll('.settings-tab-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== `settings-tab-${tab}`);
    });
    if (tab === 'ipfilter') ipFilterModule.load();
  });

  // ── IP 访问控制模块 ───────────────────────────────────────
  const ipFilterModule = (() => {
    let rules = [];

    function renderRules() {
      const listEl = document.getElementById('ipf-rules-list');
      const emptyEl = document.getElementById('ipf-empty-hint');
      if (!rules.length) {
        listEl.innerHTML = '';
        emptyEl?.classList.remove('hidden');
        listEl.appendChild(emptyEl);
        return;
      }
      emptyEl?.classList.add('hidden');
      listEl.innerHTML = rules.map(r => `
        <div class="flex items-center px-3 py-2 text-xs gap-2 hover:bg-slate-50" data-rule-id="${r.id}">
          <span class="w-16 shrink-0">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.type === 'allow' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}">
              ${r.type === 'allow' ? '白名单' : '黑名单'}
            </span>
          </span>
          <span class="flex-1 font-mono text-slate-700">${escapeHtml(r.cidr)}</span>
          <span class="w-24 text-slate-400 truncate">${escapeHtml(r.note || '')}</span>
          <button class="w-12 text-red-400 hover:text-red-600 transition-colors ipf-delete-btn" data-id="${r.id}" type="button">删除</button>
        </div>
      `).join('');

      listEl.querySelectorAll('.ipf-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await requestJson(`/api/ip-filter/rules/${btn.dataset.id}`, { method: 'DELETE' });
            await load();
            window.appShared.showToast('规则已删除', 'success');
          } catch (e) { window.appShared.showErrorMessage(e); }
        });
      });
    }

    async function load() {
      try {
        const data = await requestJson('/api/ip-filter');
        rules = data.rules || [];
        document.getElementById('ipf-allowlist-toggle').checked = !!data.allowlistEnabled;
        document.getElementById('ipf-denylist-toggle').checked = !!data.denylistEnabled;
        renderRules();
      } catch (e) { window.appShared.showErrorMessage(e); }
    }

    async function saveToggle(key, value) {
      try {
        await requestJson('/api/ip-filter/config', {
          method: 'PATCH',
          body: JSON.stringify({ [key]: value }),
        });
        window.appShared.showToast(value ? '已开启' : '已关闭', 'success');
      } catch (e) {
        window.appShared.showErrorMessage(e);
        await load(); // 失败时回滚开关状态
      }
    }

    document.getElementById('ipf-allowlist-toggle')?.addEventListener('change', e => {
      saveToggle('allowlistEnabled', e.target.checked);
    });
    document.getElementById('ipf-denylist-toggle')?.addEventListener('change', e => {
      saveToggle('denylistEnabled', e.target.checked);
    });

    document.getElementById('ipf-add-btn')?.addEventListener('click', async () => {
      const type = document.getElementById('ipf-new-type').value;
      const cidr = document.getElementById('ipf-new-cidr').value.trim();
      const note = document.getElementById('ipf-new-note').value.trim();
      if (!cidr) {
        window.appShared.showToast('请输入 IP 或 CIDR', 'warn');
        return;
      }
      try {
        await requestJson('/api/ip-filter/rules', {
          method: 'POST',
          body: JSON.stringify({ type, cidr, note }),
        });
        document.getElementById('ipf-new-cidr').value = '';
        document.getElementById('ipf-new-note').value = '';
        await load();
        window.appShared.showToast('规则已添加', 'success');
      } catch (e) { window.appShared.showErrorMessage(e); }
    });

    return { load };
  })();

  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => {
      settingsErrorEl.textContent = '';
      document.getElementById('settings-username').value = '';
      document.getElementById('settings-password').value = '';
      document.getElementById('settings-password-confirm').value = '';
      // 默认显示账号标签
      document.querySelectorAll('.settings-tab-btn').forEach(b => {
        const isAccount = b.dataset.tab === 'account';
        b.classList.toggle('bg-blue-500', isAccount);
        b.classList.toggle('text-white', isAccount);
        b.classList.toggle('border', !isAccount);
        b.classList.toggle('border-slate-200', !isAccount);
        b.classList.toggle('text-slate-500', !isAccount);
      });
      document.querySelectorAll('.settings-tab-panel').forEach(p => {
        p.classList.toggle('hidden', p.id !== 'settings-tab-account');
      });
      settingsModal.classList.remove('hidden');
    });

    settingsCloseBtn?.addEventListener('click', () => {
      settingsModal.classList.add('hidden');
    });

    settingsForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      settingsErrorEl.textContent = '';

      const username = document.getElementById('settings-username').value.trim();
      const password = document.getElementById('settings-password').value;
      const passwordConfirm = document.getElementById('settings-password-confirm').value;

      if (password && password !== passwordConfirm) {
        settingsErrorEl.textContent = '两次输入的口令不一致';
        return;
      }

      // 保存到 localStorage
      const newCreds = {};
      if (username) newCreds.username = username;
      if (password) newCreds.password = password;

      if (Object.keys(newCreds).length > 0) {
        const existing = JSON.parse(localStorage.getItem('1shell-settings-creds') || '{}');
        const merged = { ...existing, ...newCreds };
        localStorage.setItem('1shell-settings-creds', JSON.stringify(merged));
        settingsModal.classList.add('hidden');
        window.appShared?.showToast?.('设置已保存，下次登录生效', 'success', 2000);
      }
    });
  }

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

(() => {
  'use strict';

  // ── 移动端侧边栏关闭 ────────────────────────────────────────────────────
  const mobileCloseBtn = document.getElementById('mobile-sidebar-close-btn');
  const mobileOverlay = document.getElementById('mobile-overlay');
  const sidebarEl = document.querySelector('.sidebar.left-panel');

  function closeMobileSidebar() {
    if (sidebarEl) sidebarEl.classList.remove('mobile-open');
    if (mobileOverlay) mobileOverlay.classList.add('hidden');
  }

  function openMobileSidebar() {
    if (sidebarEl) sidebarEl.classList.add('mobile-open');
    if (mobileOverlay) mobileOverlay.classList.remove('hidden');
  }

  if (mobileCloseBtn) {
    mobileCloseBtn.addEventListener('click', closeMobileSidebar);
  }

  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', closeMobileSidebar);
  }

  // 同步 app.js 的 hamburger 按钮
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', openMobileSidebar);
  }

  // ── 左栏：VPS 列表 / 文件树 缩放切换 ───────────────────────────────────
  const vpsSection = document.getElementById('lp-vps-section');
  const fileSection = document.getElementById('lp-file-section');
  const vpsToggle = document.getElementById('lp-vps-toggle');
  const fileToggle = document.getElementById('lp-file-toggle');

  // 状态：'both' | 'vps-max' | 'file-max'
  let lpState = 'both';

  function setLpState(newState) {
    lpState = newState;
    if (newState === 'both') {
      vpsSection.style.flex = '5';
      vpsSection.style.minHeight = '';
      vpsSection.style.overflow = '';
      fileSection.style.flex = '5';
      fileSection.style.minHeight = '';
      fileSection.style.overflow = '';
      vpsToggle.textContent = '⇕';
      fileToggle.textContent = '⇕';
    } else if (newState === 'vps-max') {
      vpsSection.style.flex = '1';
      vpsSection.style.minHeight = '';
      fileSection.style.flex = '0';
      fileSection.style.minHeight = '32px';
      fileSection.style.overflow = 'hidden';
      vpsToggle.textContent = '⇕';
      fileToggle.textContent = '▼';
    } else if (newState === 'file-max') {
      vpsSection.style.flex = '0';
      vpsSection.style.minHeight = '36px';
      vpsSection.style.overflow = 'hidden';
      fileSection.style.flex = '1';
      fileSection.style.minHeight = '';
      fileSection.style.overflow = '';
      vpsToggle.textContent = '▼';
      fileToggle.textContent = '⇕';
    }
  }

  if (vpsToggle && fileToggle) {
    vpsToggle.addEventListener('click', () => {
      // VPS 按钮：当前 both → 最大化 VPS；当前 file-max → 恢复；当前 vps-max → 恢复
      if (lpState === 'both') setLpState('vps-max');
      else setLpState('both');
    });
    fileToggle.addEventListener('click', () => {
      if (lpState === 'both') setLpState('file-max');
      else setLpState('both');
    });
  }

  // ── 右侧 AI 面板折叠/展开 ──────────────────────────────────────────────
  const aiPanel = document.querySelector('.ai-panel');
  const toggleBtn = document.getElementById('ai-panel-toggle-btn');
  const mobileAiBackdrop = document.getElementById('mobile-ai-backdrop');

  function isMobileBreakpoint() {
    return window.matchMedia('(max-width: 1024px)').matches;
  }

  function closeMobileAiPanel() {
    aiPanel.classList.remove('mobile-ai-open');
    if (mobileAiBackdrop) mobileAiBackdrop.classList.remove('active');
    toggleBtn.textContent = 'AI 展开';
  }

  if (mobileAiBackdrop) {
    mobileAiBackdrop.addEventListener('click', closeMobileAiPanel);
  }

  if (toggleBtn && aiPanel) {
    toggleBtn.addEventListener('click', () => {
      if (isMobileBreakpoint()) {
        // 移动端：切换底部抽屉
        const isOpen = aiPanel.classList.contains('mobile-ai-open');
        if (isOpen) {
          closeMobileAiPanel();
        } else {
          aiPanel.classList.add('mobile-ai-open');
          if (mobileAiBackdrop) mobileAiBackdrop.classList.add('active');
          toggleBtn.textContent = 'AI 折叠';
        }
        return;
      }

      // 桌面端：原有折叠/展开逻辑
      const collapsed = aiPanel.getAttribute('data-collapsed') === 'true';

      if (collapsed) {
        aiPanel.style.width = '';
        aiPanel.style.minWidth = '';
        aiPanel.style.opacity = '1';
        aiPanel.style.pointerEvents = '';
        aiPanel.style.display = '';
        aiPanel.setAttribute('data-collapsed', 'false');
        toggleBtn.textContent = 'AI 折叠';
      } else {
        aiPanel.style.width = '0px';
        aiPanel.style.minWidth = '0px';
        aiPanel.style.opacity = '0';
        aiPanel.style.pointerEvents = 'none';
        aiPanel.style.display = 'none';
        aiPanel.setAttribute('data-collapsed', 'true');
        toggleBtn.textContent = 'AI 展开';
      }

      // 触发 xterm refit
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 320);
    });
  }

  // ── 终端标签页：真实会话联动 ─────────────────────────────────────────────
  const tabsContainer = document.getElementById('terminal-tabs');
  let _stm = null; // sessionTerminalModule
  let _state = null; // app state

  function getStatusColor(session) {
    if (!session) return 'bg-slate-300';
    if (session.status === 'ready') return 'bg-green-400';
    if (session.status === 'connecting') return 'bg-amber-400';
    if (session.status === 'error' || session.status === 'closed') return 'bg-red-400';
    return 'bg-slate-300';
  }

  function renderTabs() {
    if (!tabsContainer || !_state) return;

    // 收集所有活跃会话（非 closed）对应的主机
    const openHosts = [];
    const seen = new Set();

    // 确保当前活跃主机在列表中
    const activeId = _state.activeHostId || 'local';
    const activeHost = _state.hostMap.get(activeId);
    if (activeHost && !seen.has(activeId)) {
      seen.add(activeId);
      openHosts.push(activeHost);
    }

    // 添加有活跃会话的其他主机
    for (const session of _state.sessionMap.values()) {
      if (session.status === 'closed') continue;
      const hid = session.hostId;
      if (seen.has(hid)) continue;
      seen.add(hid);
      const host = _state.hostMap.get(hid);
      if (host) openHosts.push(host);
    }

    // 渲染 Tabs
    let html = '';
    for (const host of openHosts) {
      const isActive = host.id === activeId;
      const session = findSessionForHost(host.id);
      const dotColor = getStatusColor(session);
      const activeCls = isActive
        ? 'bg-white border-slate-200 shadow-sm text-slate-700'
        : 'bg-transparent border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600';
      const name = host.name || host.host || '未知';
      const shortMeta = host.type === 'local' ? '本地' : (host.host || '');

      html += `<div data-tab-host="${host.id}" class="flex items-center gap-1.5 h-7 px-3 rounded-lg border text-xs font-semibold cursor-pointer transition-all ${activeCls}">` +
        `<span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>` +
        `<span class="truncate max-w-[100px]">${escapeText(name)}</span>` +
        `<span class="text-[10px] text-slate-400 ml-0.5 hidden lg:inline">${escapeText(shortMeta)}</span>` +
        (openHosts.length > 1 && !isActive ? `<button data-tab-close="${host.id}" class="ml-1 text-slate-300 hover:text-red-400 text-[10px] leading-none">×</button>` : '') +
        `</div>`;
    }

    html += `<button class="h-7 px-2.5 rounded-lg border border-dashed border-slate-300 text-xs text-slate-400 hover:border-blue-300 hover:text-blue-500 transition-all" id="tab-new-terminal">+ 新终端</button>`;

    tabsContainer.innerHTML = html;
  }

  function findSessionForHost(hostId) {
    if (!_state) return null;
    for (const s of _state.sessionMap.values()) {
      if (s.hostId === hostId && s.status !== 'closed') return s;
    }
    return null;
  }

  function escapeText(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Tab 点击事件委托
  if (tabsContainer) {
    tabsContainer.addEventListener('click', (e) => {
      // 关闭 Tab
      const closeBtn = e.target.closest('[data-tab-close]');
      if (closeBtn && _stm) {
        const hostId = closeBtn.getAttribute('data-tab-close');
        const session = findSessionForHost(hostId);
        if (session) {
          _stm.getSocket()?.emit('session:close', { sessionId: session.id });
        }
        return;
      }

      // 切换 Tab
      const tab = e.target.closest('[data-tab-host]');
      if (tab && _stm) {
        const hostId = tab.getAttribute('data-tab-host');
        if (hostId !== _state.activeHostId) {
          _stm.connectToHost(hostId, false).catch(() => {});
        }
        return;
      }
    });
  }

  // 由 app.js 初始化后调用，注入 session 模块和 state
  window.initTerminalTabs = function (sessionTerminalModule, state) {
    _stm = sessionTerminalModule;
    _state = state;

    sessionTerminalModule.onLifecycle(() => {
      renderTabs();
    });

    renderTabs();

    // "新终端"按钮：弹出主机快选下拉
    if (tabsContainer) {
      tabsContainer.addEventListener('click', (e) => {
        if (!e.target.closest('#tab-new-terminal')) return;
        showHostQuickPicker(e.target.closest('#tab-new-terminal'));
      });
    }
  };

  // ── 主机快选浮层 ──────────────────────────────────────────────────────
  let pickerEl = null;

  function removeHostPicker() {
    pickerEl?.remove();
    pickerEl = null;
    document.removeEventListener('click', onPickerOutsideClick, true);
  }

  function onPickerOutsideClick(e) {
    if (pickerEl && !pickerEl.contains(e.target) && !e.target.closest('#tab-new-terminal')) {
      removeHostPicker();
    }
  }

  function showHostQuickPicker(anchorEl) {
    if (pickerEl) { removeHostPicker(); return; }
    if (!_state) return;

    const hosts = _state.hosts || [];
    if (!hosts.length) return;

    pickerEl = document.createElement('div');
    pickerEl.className = 'absolute top-full left-0 mt-1 w-56 py-1 bg-white rounded-lg shadow-xl border border-slate-200 z-50 max-h-60 overflow-y-auto';

    let html = '<div class="px-3 py-1.5 text-[10px] text-slate-400 uppercase tracking-wide">选择主机</div>';
    for (const h of hosts) {
      const name = escapeText(h.name || h.host || '未知');
      const meta = h.type === 'local' ? '本地 Shell' : (h.host || '');
      html += `<button data-pick-host="${h.id}" class="flex items-center gap-2 w-full px-3 py-2 text-left text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 transition-all">` +
        `<span class="truncate font-medium">${name}</span>` +
        `<span class="text-[10px] text-slate-400 ml-auto">${escapeText(meta)}</span>` +
        `</button>`;
    }
    pickerEl.innerHTML = html;

    // 定位
    const anchorRect = anchorEl.getBoundingClientRect();
    pickerEl.style.position = 'fixed';
    pickerEl.style.top = (anchorRect.bottom + 4) + 'px';
    pickerEl.style.left = anchorRect.left + 'px';
    document.body.appendChild(pickerEl);

    pickerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick-host]');
      if (!btn) return;
      const hostId = btn.getAttribute('data-pick-host');
      removeHostPicker();
      _stm?.connectToHost(hostId, true).catch(() => {});
    });

    setTimeout(() => document.addEventListener('click', onPickerOutsideClick, true), 0);
  }

  // ── 顶栏探针信息：显示当前活跃主机的数据 ──────────────────────────────────
  const probeInfoEl = document.getElementById('topbar-probe-info');
  let latestProbes = [];    // 最新一轮所有主机的探针数据
  let activeProbeHostId = 'local';

  function renderProbeInfo(data, hostName) {
    if (!probeInfoEl) return;
    const fmt = (v) => v != null ? v + '%' : '--';
    const nameLabel = hostName ? `<span class="font-semibold text-slate-600 dark:text-slate-300 truncate max-w-[120px]">${hostName}</span><span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>` : '';
    probeInfoEl.innerHTML =
      `<span class="topbar-slogan" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;font-style:italic;font-size:10px;letter-spacing:0.05em">One Shell to rule them all.</span>` +
      `<span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>` +
      nameLabel +
      `<span>CPU <b class="text-slate-700 dark:text-slate-200">${fmt(data.cpu)}</b></span>` +
      `<span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>` +
      `<span>内存 <b class="text-slate-700 dark:text-slate-200">${fmt(data.memory)}</b></span>` +
      `<span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>` +
      `<span>负载 <b class="text-slate-700 dark:text-slate-200">${fmt(data.load)}</b></span>` +
      `<span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>` +
      `<span>硬盘 <b class="text-slate-700 dark:text-slate-200">${fmt(data.disk)}</b></span>`;
  }

  function findProbeForHost(hostId) {
    const id = hostId || 'local';
    return latestProbes.find((p) => p.hostId === id) || null;
  }

  function refreshTopbarProbe() {
    const probe = findProbeForHost(activeProbeHostId);
    if (probe) {
      renderProbeInfo({
        cpu: probe.cpuUsage,
        memory: probe.memoryUsage,
        disk: probe.diskUsage,
        load: probe.load1 != null ? probe.load1 : null,
      }, probe.name || probe.hostname);
    }
  }

  // 从 /api/health/stats 获取本地数据（初始 fallback）
  async function pollLocalStats() {
    try {
      const resp = await fetch('/api/health/stats');
      if (!resp.ok) return;
      const data = await resp.json();
      // 如果还没有 probe:update 数据或当前是本机，用 /health/stats
      if (latestProbes.length === 0 || activeProbeHostId === 'local') {
        renderProbeInfo(data, '本机');
      }
    } catch { /* 静默 */ }
  }

  // 初始显示 Mock，登录成功后开始轮询
  let probeTimer = null;
  function startProbePolling() {
    if (probeTimer) return;
    pollLocalStats();
    probeTimer = setInterval(pollLocalStats, 8000);
  }

  // 监听 app-shell 从 hidden 变为可见（即登录成功后）
  const appShell = document.getElementById('app-shell');
  if (appShell) {
    const shellObserver = new MutationObserver(() => {
      if (!appShell.classList.contains('hidden')) {
        startProbePolling();
        shellObserver.disconnect();
      }
    });
    shellObserver.observe(appShell, { attributes: true, attributeFilter: ['class'] });
    if (!appShell.classList.contains('hidden')) {
      startProbePolling();
    }
  }

  // 主动获取一次探针快照（用于首次加载和主机切换时立即显示）
  async function fetchProbeSnapshot() {
    try {
      const resp = await fetch('/api/probes');
      if (!resp.ok) return;
      const snapshot = await resp.json();
      latestProbes = (snapshot && snapshot.probes) || [];
      refreshTopbarProbe();
    } catch { /* 静默 */ }
  }

  // 监听 Socket.IO probe:update（由 initTopbarProbe 注入 socket）
  window.initTopbarProbe = function (socket) {
    if (!socket) return;
    socket.on('probe:update', (snapshot) => {
      latestProbes = (snapshot && snapshot.probes) || [];
      refreshTopbarProbe();
    });
    // socket 就绪后立即拉一次
    fetchProbeSnapshot();
  };

  // 监听主机切换事件
  if (window.appBus) {
    window.appBus.on('host:changed', (host) => {
      activeProbeHostId = host?.id || 'local';
      // 已有数据则立即渲染，没有则主动拉取
      if (findProbeForHost(activeProbeHostId)) {
        refreshTopbarProbe();
      } else {
        fetchProbeSnapshot();
      }
    });
  }

  // ── Agent 面板：2:4:4 布局切换 ──────────────────────────────────────────
  const agentPanelEl   = document.getElementById('agent-panel');
  const idePanelEl     = document.getElementById('ide-panel');
  const terminalAreaEl = document.querySelector('.terminal-area');
  const aiPanelEl      = document.querySelector('.ai-panel');

  /**
   * 打开时：AI 面板隐藏，终端区收缩到 4，Agent 面板展开到 4（2:4:4 布局）
   * 关闭时：恢复 AI 面板（除非它之前已被手动折叠），终端区恢复 flex-1
   */
  window.setAgentPanelOpen = function (open) {
    if (!agentPanelEl || !terminalAreaEl || !aiPanelEl) return;

    if (open) {
      // 先关闭 IDE 面板（互斥）
      if (idePanelEl && !idePanelEl.classList.contains('hidden')) {
        window.setIdePanelOpen(false);
      }
      // 记住 AI 面板折叠状态，避免关闭 Agent 时错误恢复
      agentPanelEl._aiWasCollapsed = aiPanelEl.getAttribute('data-collapsed') === 'true';
      aiPanelEl.style.display = 'none';
      terminalAreaEl.style.flex = '4 4 0';
      terminalAreaEl.style.minWidth = '0';
      agentPanelEl.classList.remove('hidden');
      agentPanelEl.style.flex = '4 4 0';
      agentPanelEl.style.minWidth = '0';
    } else {
      if (!agentPanelEl._aiWasCollapsed) {
        aiPanelEl.style.display = '';
      }
      terminalAreaEl.style.flex = '';
      terminalAreaEl.style.minWidth = '';
      agentPanelEl.classList.add('hidden');
      agentPanelEl.style.flex = '';
      agentPanelEl.style.minWidth = '';
    }

    // 触发 xterm refit
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  };

  // ── 1Shell AI (IDE) 面板：布局切换 ─────────────────────────────────────

  window.setIdePanelOpen = function (open) {
    if (!idePanelEl || !terminalAreaEl || !aiPanelEl) return;

    // 先关闭 Agent 面板（互斥）
    if (open && agentPanelEl && !agentPanelEl.classList.contains('hidden')) {
      window.setAgentPanelOpen(false);
    }

    if (open) {
      idePanelEl._aiWasCollapsed = aiPanelEl.getAttribute('data-collapsed') === 'true';
      aiPanelEl.style.display = 'none';
      terminalAreaEl.style.flex = '4 4 0';
      terminalAreaEl.style.minWidth = '0';
      idePanelEl.classList.remove('hidden');
      idePanelEl.style.flex = '4 4 0';
      idePanelEl.style.minWidth = '0';
    } else {
      if (!idePanelEl._aiWasCollapsed) {
        aiPanelEl.style.display = '';
      }
      terminalAreaEl.style.flex = '';
      terminalAreaEl.style.minWidth = '';
      idePanelEl.classList.add('hidden');
      idePanelEl.style.flex = '';
      idePanelEl.style.minWidth = '';
    }

    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  };

  // ── 主题切换 + localStorage 持久化 ─────────────────────────────────────
  const themeBtn = document.getElementById('theme-toggle-btn');
  const htmlEl = document.documentElement;

  // 初始化：读取 localStorage
  const savedTheme = localStorage.getItem('1shell-theme');
  if (savedTheme === 'dark') {
    htmlEl.classList.add('dark');
    if (themeBtn) themeBtn.textContent = '☀';
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const isDark = htmlEl.classList.toggle('dark');
      themeBtn.textContent = isDark ? '☀' : '🌙';
      localStorage.setItem('1shell-theme', isDark ? 'dark' : 'light');
    });
  }

  // ── 终端全屏 ──────────────────────────────────────────────────────────────
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const terminalAreaEl2 = document.querySelector('.terminal-area');

  if (fullscreenBtn && terminalAreaEl2) {
    let isFullscreen = false;

    function enterFullscreen() {
      isFullscreen = true;
      // 隐藏顶栏、侧栏、AI面板，终端占满
      const topbar = document.querySelector('.topbar');
      const sidebar = document.querySelector('.sidebar.left-panel');
      const aiPanel2 = document.querySelector('.ai-panel');
      const agentPanel = document.getElementById('agent-panel');
      const idePanel = document.getElementById('ide-panel');
      const mainContent = document.querySelector('.main-content');
      const appShell2 = document.getElementById('app-shell');

      if (topbar) topbar.style.display = 'none';
      if (sidebar) sidebar.style.display = 'none';
      if (aiPanel2) aiPanel2.style.display = 'none';
      if (agentPanel) agentPanel.style.display = 'none';
      if (idePanel) idePanel.style.display = 'none';
      if (appShell2) { appShell2.style.padding = '0'; appShell2.style.gap = '0'; }
      if (mainContent) { mainContent.style.gap = '0'; }
      terminalAreaEl2.style.borderRadius = '0';
      fullscreenBtn.textContent = '退出';
      fullscreenBtn.title = '退出全屏';

      setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    }

    function exitFullscreen() {
      isFullscreen = false;
      const topbar = document.querySelector('.topbar');
      const sidebar = document.querySelector('.sidebar.left-panel');
      const aiPanel2 = document.querySelector('.ai-panel');
      const agentPanel = document.getElementById('agent-panel');
      const idePanel = document.getElementById('ide-panel');
      const mainContent = document.querySelector('.main-content');
      const appShell2 = document.getElementById('app-shell');

      if (topbar) topbar.style.display = '';
      // 恢复侧栏：如果之前是折叠状态则保持折叠
      if (sidebar && sidebar.getAttribute('data-collapsed') !== 'true') {
        sidebar.style.display = '';
      }
      // 恢复 AI 面板：如果之前是折叠状态则保持折叠
      if (aiPanel2 && aiPanel2.getAttribute('data-collapsed') !== 'true') {
        aiPanel2.style.display = '';
      }
      if (agentPanel && !agentPanel.classList.contains('hidden')) {
        agentPanel.style.display = '';
      }
      if (idePanel && !idePanel.classList.contains('hidden')) {
        idePanel.style.display = '';
      }
      if (appShell2) { appShell2.style.padding = ''; appShell2.style.gap = ''; }
      if (mainContent) { mainContent.style.gap = ''; }
      terminalAreaEl2.style.borderRadius = '';
      fullscreenBtn.textContent = '全屏';
      fullscreenBtn.title = '全屏终端';

      setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    }

    fullscreenBtn.addEventListener('click', () => {
      if (isFullscreen) exitFullscreen();
      else enterFullscreen();
    });

    // Esc 退出全屏
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isFullscreen) {
        exitFullscreen();
      }
    });
  }

  // ── 补全建议关闭按钮 ─────────────────────────────────────────────────────
  const suggestionCloseBtn = document.getElementById('suggestion-close-btn');
  const suggestionBox = document.getElementById('terminal-inline-suggestion-box');

  if (suggestionCloseBtn && suggestionBox) {
    suggestionCloseBtn.addEventListener('click', () => {
      suggestionBox.style.display = 'none';
      setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    });
  }

  // ── 左侧栏折叠/展开 ─────────────────────────────────────────────────────
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebarPanel = document.querySelector('.sidebar.left-panel');

  if (sidebarToggleBtn && sidebarPanel) {
    sidebarToggleBtn.addEventListener('click', () => {
      const collapsed = sidebarPanel.getAttribute('data-collapsed') === 'true';

      if (collapsed) {
        sidebarPanel.style.width = '';
        sidebarPanel.style.minWidth = '';
        sidebarPanel.style.display = '';
        sidebarPanel.setAttribute('data-collapsed', 'false');
        sidebarToggleBtn.textContent = '侧栏折叠';
      } else {
        sidebarPanel.style.width = '0px';
        sidebarPanel.style.minWidth = '0px';
        sidebarPanel.style.display = 'none';
        sidebarPanel.setAttribute('data-collapsed', 'true');
        sidebarToggleBtn.textContent = '侧栏展开';
      }

      setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
    });
  }
})();

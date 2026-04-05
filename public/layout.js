(() => {
  'use strict';

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

  if (toggleBtn && aiPanel) {
    toggleBtn.addEventListener('click', () => {
      const collapsed = aiPanel.getAttribute('data-collapsed') === 'true';

      if (collapsed) {
        aiPanel.style.width = '280px';
        aiPanel.style.minWidth = '280px';
        aiPanel.style.opacity = '1';
        aiPanel.style.pointerEvents = '';
        aiPanel.setAttribute('data-collapsed', 'false');
        toggleBtn.textContent = '›';
      } else {
        aiPanel.style.width = '0px';
        aiPanel.style.minWidth = '0px';
        aiPanel.style.opacity = '0';
        aiPanel.style.pointerEvents = 'none';
        aiPanel.setAttribute('data-collapsed', 'true');
        toggleBtn.textContent = '‹';
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
    const tabsRect = tabsContainer.getBoundingClientRect();
    pickerEl.style.position = 'fixed';
    pickerEl.style.top = (tabsRect.bottom + 4) + 'px';
    pickerEl.style.left = tabsRect.left + 'px';
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

  // ── 顶栏本机探针：轮询 /api/health/stats ────────────────────────────────
  const probeInfoEl = document.getElementById('topbar-probe-info');

  function renderProbeInfo(data) {
    if (!probeInfoEl) return;
    const fmt = (v) => v != null ? v + '%' : '--';
    probeInfoEl.innerHTML =
      `<span>CPU <b class="text-slate-700">${fmt(data.cpu)}</b></span>` +
      `<span class="w-px h-3 bg-slate-300"></span>` +
      `<span>内存 <b class="text-slate-700">${fmt(data.memory)}</b></span>` +
      `<span class="w-px h-3 bg-slate-300"></span>` +
      `<span>负载 <b class="text-slate-700">${fmt(data.load)}</b></span>` +
      `<span class="w-px h-3 bg-slate-300"></span>` +
      `<span>硬盘 <b class="text-slate-700">${fmt(data.disk)}</b></span>`;
  }

  async function pollLocalStats() {
    try {
      const resp = await fetch('/api/health/stats');
      if (!resp.ok) return;
      renderProbeInfo(await resp.json());
    } catch { /* 静默，下次重试 */ }
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
    // 如果已经可见（页面刷新时已登录）
    if (!appShell.classList.contains('hidden')) {
      startProbePolling();
    }
  }

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
})();

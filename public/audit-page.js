(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showErrorMessage } = window.appShared;
  const PAGE_SIZE = 20;
  const ACTION_LABELS = Object.freeze({
    bridge_exec: '命令执行',
    script_run: '脚本执行',
    host_create: '新增主机',
    host_update: '更新主机',
    host_delete: '删除主机',
    local_config_update: '本地配置',
    login: '登录',
  });

  const ACTION_BADGES = Object.freeze({
    bridge_exec: 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
    script_run: 'bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/20',
    host_create: 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20',
    host_update: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
    host_delete: 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20',
    local_config_update: 'bg-cyan-50 text-cyan-600 border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-300 dark:border-cyan-500/20',
    login: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20',
  });

  const state = {
    offset: 0,
    total: 0,
    source: '--',
    filters: { action: '', source: '', hostId: '', keyword: '' },
  };

  const auditListEl = document.getElementById('audit-list');
  const totalCountEl = document.getElementById('audit-total-count');
  const pageIndicatorEl = document.getElementById('audit-page-indicator');
  const sourceEl = document.getElementById('audit-source');
  const paginationMetaEl = document.getElementById('audit-pagination-meta');
  const prevBtnEl = document.getElementById('audit-prev-btn');
  const nextBtnEl = document.getElementById('audit-next-btn');
  const refreshBtnEl = document.getElementById('audit-refresh-btn');
  const filterActionEl = document.getElementById('audit-filter-action');
  const filterSourceEl = document.getElementById('audit-filter-source');
  const filterHostEl = document.getElementById('audit-filter-host');
  const filterKeywordEl = document.getElementById('audit-filter-keyword');
  const filterBtnEl = document.getElementById('audit-filter-btn');
  const filterResetBtnEl = document.getElementById('audit-filter-reset-btn');
  const themeBtn = document.getElementById('theme-toggle-btn');
  const themeIcon = document.getElementById('theme-icon');
  const htmlEl = document.documentElement;

  const requestJson = createRequestJson({
    onUnauthorized: () => {
      window.location.href = 'index.html';
    },
  });

  function formatTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(String(value));
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  }

  function getActionLabel(action) {
    return ACTION_LABELS[action] || action || '未知操作';
  }

  function getActionBadgeClass(action) {
    return ACTION_BADGES[action] || 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20';
  }

  function parseDetails(details) {
    if (!details) return '';
    try {
      const data = JSON.parse(details);
      return Object.entries(data)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' · ');
    } catch {
      return String(details);
    }
  }

  function formatSource(value) {
    if (!value) return '--';
    return String(value).replace(/_/g, ' ');
  }

  function formatExit(entry) {
    if (entry.exit_code === null || entry.exit_code === undefined) return '--';
    return String(entry.exit_code);
  }

  function formatDuration(entry) {
    if (entry.duration_ms === null || entry.duration_ms === undefined) return '--';
    return `${entry.duration_ms} ms`;
  }

  function renderAuditRow(entry) {
    const actionText = getActionLabel(entry.action);
    const badgeClass = getActionBadgeClass(entry.action);
    const hostText = entry.host_name || entry.host_id || '--';
    const detailsText = parseDetails(entry.details);
    const hasError = Boolean(entry.error);

    return `
      <article class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-4 shadow-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center px-2 py-0.5 rounded-lg border text-[11px] font-semibold ${badgeClass}">${escapeHtml(actionText)}</span>
          <span class="text-[11px] text-slate-400">#${entry.id}</span>
          <span class="text-[11px] text-slate-400 ml-auto">${escapeHtml(formatTime(entry.timestamp))}</span>
        </div>

        <div class="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
            <div class="text-[10px] text-slate-400">来源</div>
            <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">${escapeHtml(formatSource(entry.source))}</div>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
            <div class="text-[10px] text-slate-400">主机</div>
            <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-all">${escapeHtml(hostText)}</div>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
            <div class="text-[10px] text-slate-400">退出码</div>
            <div class="mt-1 font-semibold ${hasError ? 'text-rose-500 dark:text-rose-300' : 'text-slate-700 dark:text-slate-200'}">${escapeHtml(formatExit(entry))}</div>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
            <div class="text-[10px] text-slate-400">耗时</div>
            <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">${escapeHtml(formatDuration(entry))}</div>
          </div>
        </div>

        ${entry.command ? `
          <div class="mt-3">
            <div class="text-[10px] font-semibold text-slate-400 mb-1">命令</div>
            <pre class="rounded-xl bg-slate-100 dark:bg-slate-900 px-3 py-2 text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all max-h-36 overflow-auto">${escapeHtml(entry.command)}</pre>
          </div>
        ` : ''}

        ${detailsText ? `
          <div class="mt-3 text-[11px] text-slate-500 dark:text-slate-400 break-all">
            <span class="font-semibold text-slate-400">详情：</span>${escapeHtml(detailsText)}
          </div>
        ` : ''}

        ${entry.client_ip ? `
          <div class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">客户端 IP：${escapeHtml(entry.client_ip)}</div>
        ` : ''}

        ${entry.error ? `
          <div class="mt-3 rounded-xl border border-rose-200 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-300 break-all">
            ${escapeHtml(entry.error)}
          </div>
        ` : ''}
      </article>
    `;
  }

  function renderPagination() {
    totalCountEl.textContent = String(state.total);
    sourceEl.textContent = state.source;

    const page = Math.floor(state.offset / PAGE_SIZE) + 1;
    const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    pageIndicatorEl.textContent = `${page} / ${totalPages}`;
    paginationMetaEl.textContent = `每页 ${PAGE_SIZE} 条 · 共 ${state.total} 条记录`;

    prevBtnEl.disabled = state.offset <= 0;
    nextBtnEl.disabled = state.offset + PAGE_SIZE >= state.total;
  }

  function collectFilters() {
    state.filters.action = filterActionEl?.value || '';
    state.filters.source = filterSourceEl?.value || '';
    state.filters.hostId = filterHostEl?.value.trim() || '';
    state.filters.keyword = filterKeywordEl?.value.trim() || '';
  }

  function buildQueryString(offset) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (state.filters.action) params.set('action', state.filters.action);
    if (state.filters.source) params.set('source', state.filters.source);
    if (state.filters.hostId) params.set('hostId', state.filters.hostId);
    if (state.filters.keyword) params.set('keyword', state.filters.keyword);
    return params.toString();
  }

  async function loadAuditLogs(offset = state.offset) {
    state.offset = Math.max(offset, 0);
    auditListEl.innerHTML = '<div class="text-xs text-slate-400 text-center py-10">加载中...</div>';

    try {
      const resp = await requestJson(`/api/audit/logs?${buildQueryString(state.offset)}`);
      const logs = Array.isArray(resp.logs) ? resp.logs : [];
      state.total = Number(resp.total) || 0;
      state.source = resp.source || '--';
      renderPagination();

      if (!logs.length) {
        auditListEl.innerHTML = '<div class="text-xs text-slate-400 text-center py-10">暂无审计记录</div>';
        return;
      }

      auditListEl.innerHTML = logs.map(renderAuditRow).join('');
    } catch (error) {
      renderPagination();
      auditListEl.innerHTML = `<div class="text-xs text-rose-500 text-center py-10">加载失败：${escapeHtml(error.message)}</div>`;
      showErrorMessage(error);
    }
  }

  function applyFilters() {
    collectFilters();
    loadAuditLogs(0).catch(showErrorMessage);
  }

  function resetFilters() {
    if (filterActionEl) filterActionEl.value = '';
    if (filterSourceEl) filterSourceEl.value = '';
    if (filterHostEl) filterHostEl.value = '';
    if (filterKeywordEl) filterKeywordEl.value = '';
    state.filters = { action: '', source: '', hostId: '', keyword: '' };
    loadAuditLogs(0).catch(showErrorMessage);
  }

  function initializeTheme() {
    if (localStorage.getItem('1shell-theme') === 'dark') {
      htmlEl.classList.add('dark');
      if (themeIcon) themeIcon.textContent = '☀';
    } else if (themeIcon) {
      themeIcon.textContent = '🌙';
    }

    themeBtn?.addEventListener('click', () => {
      const isDark = htmlEl.classList.toggle('dark');
      if (themeIcon) themeIcon.textContent = isDark ? '☀' : '🌙';
      localStorage.setItem('1shell-theme', isDark ? 'dark' : 'light');
    });
  }

  refreshBtnEl?.addEventListener('click', () => { collectFilters(); loadAuditLogs(0).catch(showErrorMessage); });
  prevBtnEl?.addEventListener('click', () => loadAuditLogs(state.offset - PAGE_SIZE).catch(showErrorMessage));
  nextBtnEl?.addEventListener('click', () => loadAuditLogs(state.offset + PAGE_SIZE).catch(showErrorMessage));
  filterBtnEl?.addEventListener('click', applyFilters);
  filterResetBtnEl?.addEventListener('click', resetFilters);
  filterKeywordEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
  filterHostEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });

  initializeTheme();
  loadAuditLogs(0).catch(showErrorMessage);
})();

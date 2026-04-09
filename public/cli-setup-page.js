/* ══════════════════════════════════════════════════════════
   1Shell 2.0 — AI CLI 接入页面控制器
   对接 /api/agent/* 端点
   ══════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showErrorMessage, showToast } = window.appShared;
  const requestJson = createRequestJson({
    onUnauthorized: () => { window.location.href = 'index.html'; },
  });

  const $ = (id) => document.getElementById(id);
  const endpointsArea = $('endpoints-area');
  const cliList = $('cli-list');
  const filterBar = $('filter-bar');
  const searchEl = $('cli-search');
  const rescanBtn = $('rescan-btn');

  const state = {
    tools: [],
    counts: {},
    endpoints: null,
    diagnostics: [],
    filter: 'all',
    keyword: '',
  };

  const STATUS_LABELS = {
    connected: { text: '已接入', cls: 'status-connected', icon: '●' },
    detected:  { text: '已检测', cls: 'status-detected',  icon: '●' },
    missing:   { text: '未安装', cls: 'status-missing',    icon: '○' },
  };

  // ─── 初始化 ────────────────────────────────────────────────────────
  async function init() {
    bindEvents();
    await Promise.all([loadEndpoints(), loadScan(), loadDiagnostics()]);
  }

  function bindEvents() {
    rescanBtn.addEventListener('click', rescan);
    searchEl.addEventListener('input', () => {
      state.keyword = searchEl.value.trim().toLowerCase();
      renderTools();
    });
    filterBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;
      state.filter = btn.getAttribute('data-filter') || 'all';
      filterBar.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.remove('active', 'border-cyan-300', 'bg-cyan-50', 'text-cyan-600');
        b.classList.add('border-slate-200', 'bg-slate-50', 'text-slate-500');
      });
      btn.classList.add('active', 'border-cyan-300', 'bg-cyan-50', 'text-cyan-600');
      btn.classList.remove('border-slate-200', 'bg-slate-50', 'text-slate-500');
      renderTools();
    });
    // 卡片按钮委托
    cliList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (action === 'setup') onSetup(id);
      else if (action === 'remove') onRemove(id);
    });
  }

  async function rescan() {
    rescanBtn.textContent = '扫描中...';
    rescanBtn.disabled = true;
    await Promise.all([loadEndpoints(), loadScan(), loadDiagnostics()]);
    rescanBtn.textContent = '🔄 重新扫描';
    rescanBtn.disabled = false;
    showToast('扫描完成', 'success');
  }

  // ─── 数据加载 ──────────────────────────────────────────────────────
  async function loadEndpoints() {
    try {
      const resp = await requestJson('/api/agent/endpoints');
      state.endpoints = resp.endpoints;
      state.token = resp.token;
      renderEndpoints();
    } catch (err) {
      endpointsArea.innerHTML = `<div class="text-red-400 text-xs py-4">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadScan() {
    try {
      const resp = await requestJson('/api/agent/scan');
      state.tools = resp.tools || [];
      state.counts = resp.counts || {};
      updateFilterCounts();
      renderTools();
    } catch (err) {
      cliList.innerHTML = `<div class="text-red-400 text-xs py-8 text-center">扫描失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadDiagnostics() {
    try {
      const resp = await requestJson('/api/agent/diagnostics');
      state.diagnostics = resp.checks || [];
      renderDiagnostics();
    } catch { /* silent */ }
  }

  // ─── 左栏渲染 ──────────────────────────────────────────────────────
  function renderEndpoints() {
    const ep = state.endpoints;
    const token = state.token;
    if (!ep) return;

    endpointsArea.innerHTML = `
      ${endpointBlock('Bridge API', ep.bridge?.url, ep.bridge?.protocol)}
      ${endpointBlock('MCP Server', ep.mcp?.url, ep.mcp?.protocol)}
      <!-- Token -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Bridge Token</label>
          <span class="text-[10px] ${token?.ready ? 'text-emerald-600' : 'text-red-500'}">${token?.ready ? '✓ 已配置' : '✗ 未配置'}</span>
        </div>
        <div class="flex items-center gap-1">
          <input type="text" readonly value="${escapeHtml(token?.masked || '****')}" class="flex-1 h-8 px-2 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-mono outline-none" />
          <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value);window.appShared.showToast('已复制','success')" class="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-cyan-500 hover:border-cyan-300 text-xs" title="复制">📋</button>
        </div>
      </div>
      <!-- 诊断区（由 loadDiagnostics 填充） -->
      <div class="mt-2 flex flex-col gap-2">
        <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">连通性诊断</div>
        <div id="diagnostics-list" class="rounded-lg border border-slate-200 divide-y divide-slate-100 bg-white dark:bg-slate-800">
          <div class="p-2.5 text-[10px] text-slate-400 text-center">检测中...</div>
        </div>
      </div>
    `;
    // 诊断区可能已经加载完了
    if (state.diagnostics.length > 0) renderDiagnostics();
  }

  function endpointBlock(label, url, protocol) {
    return `
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">${escapeHtml(label)}</label>
          <span class="text-[10px] text-slate-400">${escapeHtml(protocol || '')}</span>
        </div>
        <div class="flex items-center gap-1">
          <input type="text" readonly value="${escapeHtml(url || '')}" class="flex-1 h-8 px-2 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-mono outline-none" />
          <button onclick="navigator.clipboard.writeText('${escapeHtml(url || '')}');window.appShared.showToast('已复制','success')" class="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-cyan-500 hover:border-cyan-300 text-xs" title="复制">📋</button>
        </div>
      </div>`;
  }

  function renderDiagnostics() {
    const el = document.getElementById('diagnostics-list');
    if (!el || state.diagnostics.length === 0) return;
    el.innerHTML = state.diagnostics.map((c) => {
      const dot = c.ok ? 'bg-emerald-500' : 'bg-red-500';
      const detail = c.ms != null ? `${c.ms}ms` : (c.detail || c.error || '');
      const detailCls = c.ok ? 'text-emerald-600' : 'text-red-500';
      return `
        <div class="p-2.5 flex items-center gap-2 text-xs">
          <span class="w-1.5 h-1.5 rounded-full ${dot} shrink-0"></span>
          <span class="flex-1 text-slate-600 dark:text-slate-300">${escapeHtml(c.name)}</span>
          <span class="text-[10px] ${detailCls}">${escapeHtml(detail)}</span>
        </div>`;
    }).join('');
  }

  // ─── 右栏渲染 ──────────────────────────────────────────────────────
  function updateFilterCounts() {
    const c = state.counts;
    filterBar.querySelectorAll('.filter-btn').forEach((btn) => {
      const f = btn.getAttribute('data-filter');
      const count = f === 'all' ? (c.total || 0) : (c[f] || 0);
      // 在按钮文字后追加计数
      const base = btn.textContent.replace(/\s*\d+$/, '').trim();
      btn.textContent = `${base} ${count}`;
    });
  }

  function renderTools() {
    const filtered = state.tools.filter((t) => {
      if (state.filter !== 'all' && t.status !== state.filter) return false;
      if (state.keyword) {
        const hay = `${t.name} ${t.description} ${t.repo}`.toLowerCase();
        if (!hay.includes(state.keyword)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      cliList.innerHTML = '<div class="text-center text-slate-400 text-xs py-12">没有匹配的 CLI 工具</div>';
      return;
    }

    const cards = filtered.map(toolCardHTML).join('');
    cliList.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">${cards}</div>
      <div class="mt-6 p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 text-center">
        <div class="text-sm font-semibold text-slate-600 dark:text-slate-300">+ 没找到你使用的 AI CLI？</div>
        <div class="mt-1 text-[11px] text-slate-400">1Shell 提供标准的 MCP / Bridge 接入协议，任意支持 HTTP 或 MCP 的 CLI 都可手动接入</div>
      </div>
    `;
  }

  function toolCardHTML(tool) {
    const st = STATUS_LABELS[tool.status] || STATUS_LABELS.missing;
    const opacityCls = tool.status === 'missing' ? 'opacity-70' : '';
    const connectedCls = tool.status === 'connected' ? 'connected' : '';
    const binaryInfo = tool.binary?.installed
      ? `<span class="text-emerald-600">✓ ${escapeHtml(tool.binary.path || tool.binary.name)}</span>`
      : (tool.binary?.name ? `<span>未检测到 ${escapeHtml(tool.binary.name)}</span>` : '<span>插件形式</span>');
    const configInfo = tool.config?.configured
      ? `<span class="text-emerald-600">MCP 已注册</span>`
      : (tool.config?.configPath ? `<span class="text-cyan-600">待配置</span>` : '<span>暂不支持自动配置</span>');

    let actions;
    if (tool.status === 'connected') {
      actions = `
        <button data-action="remove" data-id="${escapeHtml(tool.id)}" class="flex-1 h-7 rounded-lg border border-red-200 bg-red-50 text-red-500 text-[11px] font-semibold hover:bg-red-100">断开接入</button>`;
    } else if (tool.protocol === 'mcp' && tool.status !== 'missing') {
      actions = `
        <button data-action="setup" data-id="${escapeHtml(tool.id)}" class="flex-1 h-7 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-[11px] font-semibold shadow-md">⚡ 一键接入</button>`;
    } else if (tool.protocol === 'mcp' && tool.status === 'missing') {
      actions = `
        <button data-action="setup" data-id="${escapeHtml(tool.id)}" class="flex-1 h-7 rounded-lg border border-cyan-300 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100">⚡ 先安装后接入</button>`;
    } else {
      actions = `<span class="text-[10px] text-slate-400">暂不支持自动接入</span>`;
    }

    return `
      <div class="cli-card ${connectedCls} ${opacityCls} p-4 rounded-xl bg-white dark:bg-[#0b1324]">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-lg bg-gradient-to-br ${tool.gradient || 'from-slate-400 to-slate-500'} flex items-center justify-center text-white text-lg shrink-0">${escapeHtml(tool.icon)}</div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(tool.name)}</div>
              <div class="text-[10px] text-slate-400 font-mono">${escapeHtml(tool.repo)}</div>
            </div>
          </div>
          <span class="status-badge ${st.cls} shrink-0">${st.icon} ${st.text}</span>
        </div>
        <div class="mt-3 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">${escapeHtml(tool.description)}</div>
        <div class="mt-3 flex items-center gap-1 text-[10px] text-slate-400 flex-wrap">
          ${tool.config?.configPath ? `<span>📂 ${escapeHtml(tool.config.configPath)}</span><span>·</span>` : ''}
          ${configInfo}
          ${tool.binary?.name ? `<span>·</span>${binaryInfo}` : ''}
        </div>
        <div class="mt-3 flex items-center gap-1.5">${actions}</div>
      </div>`;
  }

  // ─── 操作：一键接入 / 断开 ─────────────────────────────────────────
  async function onSetup(providerId) {
    try {
      showToast(`正在配置 ${providerId}...`, 'info');
      const resp = await requestJson('/api/agent/mcp-setup', {
        method: 'POST',
        body: JSON.stringify({ provider: providerId }),
      });
      if (resp.ok) {
        showToast(`${providerId} 接入成功！配置已写入 ${resp.configFile || ''}`, 'success');
        await loadScan();
      } else {
        showToast(resp.error || '接入失败', 'error');
      }
    } catch (err) {
      showErrorMessage(err);
    }
  }

  async function onRemove(providerId) {
    if (!confirm(`确定要断开 ${providerId} 的 1Shell 接入吗？`)) return;
    try {
      const resp = await requestJson('/api/agent/mcp-remove', {
        method: 'POST',
        body: JSON.stringify({ provider: providerId }),
      });
      if (resp.ok) {
        showToast(`${providerId} 已断开`, 'success');
        await loadScan();
      }
    } catch (err) {
      showErrorMessage(err);
    }
  }

  // ─── 启动 ─────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

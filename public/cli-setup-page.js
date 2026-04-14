/* ══════════════════════════════════════════════════════════
   1Shell 3.0 — AI CLI 接入页面控制器（沙箱模型）
   对接 /api/agent/* 端点 — Sandbox + Multi-Provider
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

  const proxyModal = $('proxy-modal');
  const proxyModalTitle = $('proxy-modal-title');
  const proxyModalSubtitle = $('proxy-modal-subtitle');
  const proxyModalClose = $('proxy-modal-close');
  const pmProviderList = $('pm-provider-list');
  const pmAddBtn = $('pm-add-btn');
  const pmFormLabel = $('pm-form-label');
  const pmFormBadge = $('pm-form-badge');
  const pmName = $('pm-name');
  const pmUpstream = $('pm-upstream');
  const pmApiBase = $('pm-api-base');
  const pmApiKey = $('pm-api-key');
  const pmModel = $('pm-model');
  const pmSaveBtn = $('pm-save-btn');
  const pmCancelBtn = $('pm-cancel-btn');
  const pmEnvHint = $('pm-env-hint');
  const pmEnvCommand = $('pm-env-command');
  const pmEnvNote = $('pm-env-note');
  const pmStatus = $('pm-status');

  let editingCliId = null;
  let editingPid = null;
  let modalProviders = [];
  let modalActiveId = null;

  const UPSTREAM_LABELS = { openai: 'OpenAI 兼容', anthropic: 'Anthropic' };

  const state = {
    tools: [],
    counts: {},
    endpoints: null,
    diagnostics: [],
    filter: 'all',
    keyword: '',
    launchCommands: {},
  };

  const STATUS_LABELS = {
    sandboxed:  { text: '沙箱就绪', cls: 'status-connected', icon: '●' },
    detected:   { text: '已检测',   cls: 'status-detected',  icon: '●' },
    missing:    { text: '未安装',   cls: 'status-missing',    icon: '○' },
  };

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
    proxyModalClose.addEventListener('click', closeModal);
    pmCancelBtn.addEventListener('click', closeModal);
    pmSaveBtn.addEventListener('click', onSaveProvider);
    pmAddBtn.addEventListener('click', resetFormToAdd);
    proxyModal.addEventListener('click', (e) => {
      if (e.target === proxyModal) closeModal();
    });
    pmProviderList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-paction]');
      if (!btn) return;
      const action = btn.getAttribute('data-paction');
      const pid = btn.getAttribute('data-pid');
      if (action === 'edit') onEditProvider(pid);
      else if (action === 'delete') onDeleteProvider(pid);
      else if (action === 'activate') onActivateProvider(pid);
    });
    cliList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (action === 'ensure-sandbox') onEnsureSandbox(id);
      else if (action === 'reset-sandbox') onResetSandbox(id);
      else if (action === 'config') openModal(id);
      else if (action === 'copy-cmd') copyLaunchCommand(id);
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

      for (const tool of state.tools) {
        if (tool.status === 'sandboxed' || tool.status === 'detected') {
          loadLaunchCommand(tool.id);
        }
      }
    } catch (err) {
      cliList.innerHTML = `<div class="text-red-400 text-xs py-8 text-center">扫描失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadLaunchCommand(cliId) {
    try {
      const shell = navigator.platform.includes('Win') ? 'powershell' : 'bash';
      const resp = await requestJson(`/api/agent/launch-command/${encodeURIComponent(cliId)}?shell=${shell}`);
      if (resp.ok) {
        state.launchCommands[cliId] = resp.command;
      }
    } catch { /* silent */ }
  }

  async function loadDiagnostics() {
    try {
      const resp = await requestJson('/api/agent/diagnostics');
      state.diagnostics = resp.checks || [];
      renderDiagnostics();
    } catch { /* silent */ }
  }

  function renderEndpoints() {
    const ep = state.endpoints;
    const token = state.token;
    if (!ep) return;
    endpointsArea.innerHTML = `
      ${endpointBlock('Bridge API', ep.bridge?.url, ep.bridge?.protocol)}
      ${endpointBlock('MCP Server', ep.mcp?.url, ep.mcp?.protocol)}
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
      <div class="mt-2 flex flex-col gap-2">
        <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">连通性诊断</div>
        <div id="diagnostics-list" class="rounded-lg border border-slate-200 divide-y divide-slate-100 bg-white dark:bg-slate-800">
          <div class="p-2.5 text-[10px] text-slate-400 text-center">检测中...</div>
        </div>
      </div>
    `;
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

  function updateFilterCounts() {
    const c = state.counts;
    filterBar.querySelectorAll('.filter-btn').forEach((btn) => {
      const f = btn.getAttribute('data-filter');
      const count = f === 'all' ? (c.total || 0) : (c[f] || 0);
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

    cliList.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">${filtered.map(toolCardHTML).join('')}</div>
      <div class="mt-6 p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 text-center">
        <div class="text-sm font-semibold text-slate-600 dark:text-slate-300">+ 没找到你使用的 AI CLI？</div>
        <div class="mt-1 text-[11px] text-slate-400">1Shell 提供标准的 MCP / Bridge 接入协议，任意支持 HTTP 或 MCP 的 CLI 都可手动接入</div>
      </div>
    `;
  }

  function toolCardHTML(tool) {
    const st = STATUS_LABELS[tool.status] || STATUS_LABELS.missing;
    const opacityCls = tool.status === 'missing' ? 'opacity-70' : '';
    const sandboxedCls = tool.status === 'sandboxed' ? 'connected' : '';
    const binaryInfo = tool.binary?.installed
      ? `<span class="text-emerald-600">✓ ${escapeHtml(tool.binary.path || tool.binary.name)}</span>`
      : (tool.binary?.name ? `<span>未检测到 ${escapeHtml(tool.binary.name)}</span>` : '<span>插件形式</span>');

    const sandboxInfo = tool.sandbox?.sandboxed
      ? `<span class="text-emerald-600">sandbox ✓ ${escapeHtml(tool.sandbox.sandboxDir || '')}</span>`
      : `<span class="text-cyan-600">沙箱待创建</span>`;

    const proxy = tool.proxy || {};
    let proxyInfo;
    if (proxy.providerCount > 0 && proxy.activeProvider) {
      const ap = proxy.activeProvider;
      const upLabel = UPSTREAM_LABELS[ap.upstreamProtocol] || ap.upstreamProtocol;
      proxyInfo = `<span class="text-emerald-600">🔌 ${escapeHtml(ap.name || '默认')} · ${upLabel} ${ap.model ? '· ' + escapeHtml(ap.model) : ''}</span>`;
      if (proxy.providerCount > 1) {
        proxyInfo += `<span class="text-slate-400 ml-1">(+${proxy.providerCount - 1} 渠道)</span>`;
      }
    } else {
      proxyInfo = `<span class="text-amber-500">🔌 代理未配置</span>`;
    }

    let actions;
    if (tool.status === 'sandboxed') {
      actions = `
        <button data-action="config" data-id="${escapeHtml(tool.id)}" class="flex-1 h-7 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100">⚙ 配置 API</button>
        <button data-action="copy-cmd" data-id="${escapeHtml(tool.id)}" class="h-7 px-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-500 text-[11px] hover:border-cyan-300" title="复制启动命令">📋</button>
        <button data-action="reset-sandbox" data-id="${escapeHtml(tool.id)}" class="h-7 px-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 text-[11px] font-semibold hover:bg-amber-100" title="重置沙箱">🔄</button>`;
    } else if (tool.status === 'detected') {
      actions = `
        <button data-action="ensure-sandbox" data-id="${escapeHtml(tool.id)}" class="flex-1 h-7 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-[11px] font-semibold shadow-md">⚡ 创建沙箱</button>
        <button data-action="config" data-id="${escapeHtml(tool.id)}" class="h-7 px-2 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100" title="配置 API 代理">⚙</button>`;
    } else {
      actions = `
        <button data-action="ensure-sandbox" data-id="${escapeHtml(tool.id)}" class="flex-1 h-7 rounded-lg border border-cyan-300 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100">⚡ 先安装后创建</button>
        <button data-action="config" data-id="${escapeHtml(tool.id)}" class="h-7 px-2 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100" title="配置 API 代理">⚙</button>`;
    }

    return `
      <div class="cli-card ${sandboxedCls} ${opacityCls} p-4 rounded-xl bg-white dark:bg-[#0b1324]">
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
        <div class="mt-2 flex items-center gap-1 text-[10px] text-slate-400 flex-wrap">
          ${sandboxInfo}
          ${tool.binary?.name ? `<span>·</span>${binaryInfo}` : ''}
        </div>
        <div class="mt-1.5 text-[10px]">${proxyInfo}</div>
        <div class="mt-3 flex items-center gap-1.5">${actions}</div>
      </div>`;
  }

  async function onEnsureSandbox(cliId) {
    try {
      showToast(`正在创建 ${cliId} 沙箱...`, 'info');
      const resp = await requestJson(`/api/agent/sandbox/ensure/${encodeURIComponent(cliId)}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (resp.ok) {
        showToast(`${cliId} 沙箱已就绪`, 'success');
        await loadScan();
        await loadLaunchCommand(cliId);
      } else {
        showToast(resp.error || '创建失败', 'error');
      }
    } catch (err) { showErrorMessage(err); }
  }

  async function onResetSandbox(cliId) {
    if (!confirm(`确定要重置 ${cliId} 的沙箱吗？沙箱配置文件将被清除，下次启动时会自动重建。`)) return;
    try {
      const resp = await requestJson(`/api/agent/sandbox/reset/${encodeURIComponent(cliId)}`, {
        method: 'POST',
      });
      if (resp.ok) {
        showToast(`${cliId} 沙箱已重置`, 'success');
        delete state.launchCommands[cliId];
        await loadScan();
      } else {
        showToast(resp.error || '重置失败', 'error');
      }
    } catch (err) { showErrorMessage(err); }
  }

  async function copyLaunchCommand(cliId) {
    const command = state.launchCommands[cliId];
    if (!command) {
      showToast('启动命令尚未加载，请稍后重试', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      showToast(`已复制 ${cliId} 启动命令`, 'success');
    } catch { showToast('复制失败', 'error'); }
  }

  async function openModal(cliId) {
    const tool = state.tools.find((t) => t.id === cliId);
    if (!tool) return;
    editingCliId = cliId;
    editingPid = null;

    proxyModalTitle.textContent = `配置 ${tool.name} API 渠道`;
    const supportedLabels = (tool.supportedUpstream || ['openai']).map(u => UPSTREAM_LABELS[u] || u).join(' / ');
    proxyModalSubtitle.textContent = `支持上游协议: ${supportedLabels}`;

    const allowed = tool.supportedUpstream || ['openai'];
    Array.from(pmUpstream.options).forEach((opt) => {
      opt.disabled = !allowed.includes(opt.value);
      opt.hidden = !allowed.includes(opt.value);
    });
    pmUpstream.value = allowed[0];

    const command = state.launchCommands[cliId];
    if (command) {
      pmEnvCommand.textContent = command;
      pmEnvNote.textContent = '通过环境变量与沙箱目录启动，不修改本地配置';
      pmEnvHint.classList.remove('hidden');
    } else {
      pmEnvHint.classList.add('hidden');
    }

    proxyModal.classList.remove('hidden');
    proxyModal.classList.add('flex');
    await loadProviders();
    resetFormToAdd();
  }

  function closeModal() {
    proxyModal.classList.add('hidden');
    proxyModal.classList.remove('flex');
    editingCliId = null;
    editingPid = null;
  }

  async function loadProviders() {
    try {
      const resp = await requestJson(`/api/agent/providers/${encodeURIComponent(editingCliId)}`);
      modalProviders = resp.providers || [];
      modalActiveId = resp.activeProviderId;
      renderProviderList();
    } catch (err) {
      pmProviderList.innerHTML = `<div class="text-[10px] text-red-500 py-2">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderProviderList() {
    if (modalProviders.length === 0) {
      pmProviderList.innerHTML = '<div class="text-[10px] text-slate-400 text-center py-3">尚未添加任何 API 渠道</div>';
      return;
    }
    pmProviderList.innerHTML = modalProviders.map((p) => {
      const isActive = p.id === modalActiveId;
      const upLabel = UPSTREAM_LABELS[p.upstreamProtocol] || p.upstreamProtocol || 'openai';
      const activeCls = isActive
        ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20'
        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0b1324]';
      return `
        <div class="flex items-center gap-2 px-3 py-2 rounded-lg border ${activeCls} text-xs">
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-slate-700 dark:text-slate-200 truncate">
              ${isActive ? '<span class="text-emerald-500 mr-1">●</span>' : '<span class="text-slate-300 mr-1">○</span>'}
              ${escapeHtml(p.name || '未命名')}
            </div>
            <div class="text-[10px] text-slate-400 truncate">${escapeHtml(upLabel)} · ${escapeHtml(p.model || '默认模型')} · ${p.apiKeySet ? 'Key ✓' : 'Key ✗'}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            ${!isActive ? `<button data-paction="activate" data-pid="${escapeHtml(p.id)}" class="h-6 px-1.5 rounded text-[10px] border border-emerald-200 text-emerald-600 hover:bg-emerald-50" title="设为活跃">启用</button>` : ''}
            <button data-paction="edit" data-pid="${escapeHtml(p.id)}" class="h-6 px-1.5 rounded text-[10px] border border-slate-200 text-slate-500 hover:bg-slate-50" title="编辑">编辑</button>
            <button data-paction="delete" data-pid="${escapeHtml(p.id)}" class="h-6 px-1.5 rounded text-[10px] border border-red-200 text-red-400 hover:bg-red-50" title="删除">✕</button>
          </div>
        </div>`;
    }).join('');
  }

  function resetFormToAdd() {
    editingPid = null;
    pmFormLabel.textContent = '添加新渠道';
    pmFormBadge.classList.add('hidden');
    pmName.value = '';
    const tool = state.tools.find(t => t.id === editingCliId);
    const allowed = tool?.supportedUpstream || ['openai'];
    pmUpstream.value = allowed[0];
    pmApiBase.value = '';
    pmApiKey.value = '';
    pmApiKey.placeholder = 'sk-...';
    pmModel.value = '';
    pmStatus.classList.add('hidden');
    pmSaveBtn.textContent = '添加渠道';
  }

  function onEditProvider(pid) {
    const p = modalProviders.find(x => x.id === pid);
    if (!p) return;
    editingPid = pid;
    pmFormLabel.textContent = `编辑: ${p.name || '未命名'}`;
    pmFormBadge.classList.remove('hidden');
    pmName.value = p.name || '';
    pmUpstream.value = p.upstreamProtocol || 'openai';
    pmApiBase.value = p.apiBase || '';
    pmApiKey.value = '';
    pmApiKey.placeholder = p.apiKeySet ? p.apiKey : 'sk-...';
    pmModel.value = p.model || '';
    pmStatus.classList.add('hidden');
    pmSaveBtn.textContent = '保存修改';
  }

  async function onDeleteProvider(pid) {
    const p = modalProviders.find(x => x.id === pid);
    if (!confirm(`确定删除渠道「${p?.name || pid}」？`)) return;
    try {
      await requestJson(`/api/agent/providers/${encodeURIComponent(editingCliId)}/${pid}`, { method: 'DELETE' });
      showToast('已删除', 'success');
      await loadProviders();
      await loadScan();
      if (editingPid === pid) resetFormToAdd();
    } catch (err) { showErrorMessage(err); }
  }

  async function onActivateProvider(pid) {
    try {
      await requestJson(`/api/agent/providers/${encodeURIComponent(editingCliId)}/${pid}/activate`, { method: 'PUT' });
      showToast('已切换活跃渠道', 'success');
      await loadProviders();
      await loadScan();
    } catch (err) { showErrorMessage(err); }
  }

  async function onSaveProvider() {
    const body = {
      name: pmName.value.trim() || undefined,
      upstreamProtocol: pmUpstream.value,
      apiBase: pmApiBase.value.trim(),
      apiKey: pmApiKey.value.trim() || undefined,
      model: pmModel.value.trim() || undefined,
    };

    if (!body.apiBase) {
      pmStatus.textContent = '✗ API 基础地址不能为空';
      pmStatus.className = 'text-[10px] text-red-500';
      pmStatus.classList.remove('hidden');
      return;
    }

    try {
      pmSaveBtn.disabled = true;
      pmSaveBtn.textContent = '保存中...';

      if (editingPid) {
        await requestJson(`/api/agent/providers/${encodeURIComponent(editingCliId)}/${editingPid}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        pmStatus.textContent = '✓ 渠道已更新';
      } else {
        if (!body.apiKey) {
          pmStatus.textContent = '✗ 新渠道必须填写 API Key';
          pmStatus.className = 'text-[10px] text-red-500';
          pmStatus.classList.remove('hidden');
          return;
        }
        await requestJson(`/api/agent/providers/${encodeURIComponent(editingCliId)}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        pmStatus.textContent = '✓ 渠道已添加';
      }

      pmStatus.className = 'text-[10px] text-emerald-600';
      pmStatus.classList.remove('hidden');
      showToast(editingPid ? '渠道已更新' : '渠道已添加', 'success');
      await loadProviders();
      await loadScan();
      resetFormToAdd();
    } catch (err) {
      pmStatus.textContent = `✗ 保存失败: ${err.message}`;
      pmStatus.className = 'text-[10px] text-red-500';
      pmStatus.classList.remove('hidden');
      showErrorMessage(err);
    } finally {
      pmSaveBtn.disabled = false;
      pmSaveBtn.textContent = editingPid ? '保存修改' : '添加渠道';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
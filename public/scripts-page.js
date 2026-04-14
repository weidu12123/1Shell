/* ══════════════════════════════════════════════════════════
   1Shell 2.0 — 脚本库前端控制器
   对接 /api/scripts 和 /api/hosts
   ══════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showErrorMessage, showToast } = window.appShared;

  // ─── 状态 ──────────────────────────────────────────────────────────
  const state = {
    scripts: [],          // 所有脚本（服务端返回）
    hosts: [],            // 所有主机（用于执行弹窗）
    currentId: null,      // 当前选中的脚本 ID，null 表示新建草稿
    currentDraft: null,   // 当前编辑态对象
    filter: { category: 'all', keyword: '' },
    isNew: false,
    historyOffset: 0,
    historyTotal: 0,
    view: 'scripts', // 'scripts' | 'history' | 'playbook'
    playbooks: [],
    currentPlaybookId: null,
    currentPlaybookDraft: null,
    isNewPlaybook: false,
  };

  const requestJson = createRequestJson({
    onUnauthorized: () => {
      // 脚本库页面未登录 → 跳回主控台让 auth.js 处理
      window.location.href = 'index.html';
    },
  });

  // ─── DOM refs ──────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const listEl = $('script-list');
  const countEl = $('script-count');
  const searchEl = $('script-search');
  const emptyEl = $('detail-empty');
  const paneEl = $('detail-pane');

  const iconEl = $('detail-icon');
  const nameEl = $('detail-name');
  const metaEl = $('detail-meta');
  const riskBadgeEl = $('detail-risk-badge');

  const fIcon = $('field-icon');
  const fCategory = $('field-category');
  const fDescription = $('field-description');
  const fContent = $('field-content');
  const fTagsContainer = $('field-tags-container');
  const fTagsInput = $('field-tags-input');
  const paramsList = $('params-list');
  const paramsEmpty = $('params-empty');

  const btnNew = $('script-new-btn');
  const btnAiGen = $('script-ai-gen-btn');
  const btnDelete = $('btn-delete');
  const btnSave = $('btn-save');
  const btnRun = $('btn-run');
  const btnAddParam = $('btn-add-param');

  // 执行弹窗
  const runModal = $('run-modal');
  const runModalIcon = $('run-modal-icon');
  const runModalTitle = $('run-modal-title');
  const runModalSubtitle = $('run-modal-subtitle');
  const runModalRisk = $('run-modal-risk');
  const runHostSelect = $('run-host-select');
  const runParamsForm = $('run-params-form');
  const runPreview = $('run-preview-code');
  const runResultArea = $('run-result-area');
  const runResultMeta = $('run-result-meta');
  const runResultList = $('run-result-list');
  const runWarnings = $('run-warnings');
  const runConfirmLabel = $('run-confirm-label');
  const runConfirmCb = $('run-confirm-cb');
  const runExecuteBtn = $('run-execute-btn');
  const runCancelBtn = $('run-cancel-btn');
  const runCloseBtn = $('run-modal-close');
  const btnRefreshPreview = $('btn-refresh-preview');

  // 删除确认
  const confirmModal = $('confirm-modal');
  const confirmTitle = $('confirm-title');
  const confirmMessage = $('confirm-message');
  const confirmOk = $('confirm-ok');
  const confirmCancel = $('confirm-cancel');

  // 执行历史
  const historyPane = $('history-pane');
  const historyList = $('history-list');
  const historyCount = $('history-count');
  const historyPage = $('history-page');
  const historyPrev = $('history-prev');
  const historyNext = $('history-next');
  const historyBackBtn = $('history-back-btn');

  // Playbook
  const playbookPane = $('playbook-pane');
  const playbookListView = $('playbook-list-view');
  const playbookEditor = $('playbook-editor');
  const playbookNewBtn = $('playbook-new-btn');
  const playbookBackBtn = $('playbook-back-btn');
  const pbNameEl = $('pb-name');
  const pbIconEl = $('pb-icon');
  const pbDescEl = $('pb-desc');
  const pbStepsList = $('pb-steps-list');
  const pbAddStepBtn = $('pb-add-step-btn');
  const pbSaveBtn = $('pb-save-btn');
  const pbRunBtn = $('pb-run-btn');
  const pbDeleteBtn = $('pb-delete-btn');

  // 左栏底部按钮
  const btnViewHistory = $('btn-view-history');
  const btnViewPlaybook = $('btn-view-playbook');
  const btnViewExport = $('btn-view-export');

  // AI 生成弹窗
  const aiGenModal = $('ai-gen-modal');
  const aiGenPrompt = $('ai-gen-prompt');
  const aiGenStatus = $('ai-gen-status');
  const aiGenSubmit = $('ai-gen-submit');
  const aiGenCancel = $('ai-gen-cancel');
  const aiGenClose = $('ai-gen-close');

  // ─── 常量 ──────────────────────────────────────────────────────────
  const CATEGORY_LABELS = {
    system: '📊 系统',
    docker: '🐳 Docker',
    network: '🌐 网络',
    backup: '💾 备份',
    security: '🔒 安全',
    other: '📁 其他',
  };
  const CATEGORY_ICONS = {
    system: '📊', docker: '🐳', network: '🌐', backup: '💾', security: '🔒', other: '📁',
  };
  const RISK_BADGES = {
    safe: { text: '安全', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
    confirm: { text: '需确认', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
    danger: { text: '危险', cls: 'bg-red-50 text-red-600 border-red-200' },
  };

  // ─── 初始化 ────────────────────────────────────────────────────────
  async function init() {
    bindEvents();
    await Promise.all([loadScripts(), loadHosts()]);
  }

  function bindEvents() {
    // 分类筛选
    document.querySelectorAll('.script-cat').forEach((cat) => {
      cat.addEventListener('click', () => {
        const tag = cat.getAttribute('data-cat');
        state.filter.category = tag;
        document.querySelectorAll('.script-cat').forEach((c) => {
          c.classList.remove('active', 'text-purple-600', 'bg-purple-50', 'border-purple-200');
          c.classList.add('text-slate-500', 'border-transparent');
        });
        cat.classList.add('active', 'text-purple-600', 'bg-purple-50', 'border-purple-200');
        cat.classList.remove('text-slate-500', 'border-transparent');
        renderList();
      });
    });

    // 搜索
    searchEl.addEventListener('input', () => {
      state.filter.keyword = searchEl.value.trim().toLowerCase();
      renderList();
    });

    // 顶栏按钮
    btnNew.addEventListener('click', newScript);
    btnAiGen.addEventListener('click', openAiGenModal);

    // 详情区按钮
    btnDelete.addEventListener('click', onDelete);
    btnSave.addEventListener('click', onSave);
    btnRun.addEventListener('click', onOpenRunModal);
    btnAddParam.addEventListener('click', () => appendParamRow({}));

    // 列表点击委托
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.script-card');
      if (!card) return;
      const id = card.getAttribute('data-id');
      if (id) selectScript(id);
    });

    // 风险等级 radio
    document.querySelectorAll('input[name="risk"]').forEach((r) => {
      r.addEventListener('change', () => syncRiskLabels());
    });

    // 标签输入
    fTagsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = fTagsInput.value.trim();
        if (val) {
          addTag(val);
          fTagsInput.value = '';
        }
      } else if (e.key === 'Backspace' && fTagsInput.value === '') {
        // 删除最后一个标签
        const chips = fTagsContainer.querySelectorAll('.tag-chip');
        if (chips.length > 0) chips[chips.length - 1].remove();
      }
    });

    // 执行弹窗
    runModalClose();  // 初始化为隐藏
    runCloseBtn.addEventListener('click', runModalClose);
    runCancelBtn.addEventListener('click', runModalClose);
    runModal.addEventListener('click', (e) => {
      if (e.target === runModal) runModalClose();
    });
    runExecuteBtn.addEventListener('click', onExecute);
    btnRefreshPreview.addEventListener('click', refreshPreview);
    runHostSelect.addEventListener('change', refreshPreview);
    $('run-host-all').addEventListener('click', () => {
      Array.from(runHostSelect.options).forEach((o) => { o.selected = true; });
      refreshPreview();
    });
    $('run-host-none').addEventListener('click', () => {
      Array.from(runHostSelect.options).forEach((o) => { o.selected = false; });
    });

    // 删除确认弹窗
    confirmCancel.addEventListener('click', () => confirmModal.classList.add('hidden'));
    confirmModal.addEventListener('click', (e) => {
      if (e.target === confirmModal) confirmModal.classList.add('hidden');
    });

    // 左栏底部按钮
    btnViewHistory.addEventListener('click', () => showHistoryView());
    historyBackBtn.addEventListener('click', hideHistoryView);
    historyPrev.addEventListener('click', () => loadHistory(state.historyOffset - 20));
    historyNext.addEventListener('click', () => loadHistory(state.historyOffset + 20));
    btnViewPlaybook.addEventListener('click', () => showPlaybookView());
    playbookBackBtn.addEventListener('click', hidePlaybookView);
    playbookNewBtn.addEventListener('click', newPlaybook);
    pbAddStepBtn.addEventListener('click', () => appendPlaybookStep({}));
    pbSaveBtn.addEventListener('click', onSavePlaybook);
    pbRunBtn.addEventListener('click', onRunPlaybook);
    pbDeleteBtn.addEventListener('click', onDeletePlaybook);
    btnViewExport.addEventListener('click', () => showToast('导入/导出功能将在 P1 阶段上线', 'info'));

    // AI 生成弹窗
    aiGenClose.addEventListener('click', closeAiGenModal);
    aiGenCancel.addEventListener('click', closeAiGenModal);
    aiGenModal.addEventListener('click', (e) => { if (e.target === aiGenModal) closeAiGenModal(); });
    aiGenSubmit.addEventListener('click', onAiGenerate);
  }

  // ─── 数据加载 ──────────────────────────────────────────────────────
  async function loadScripts() {
    try {
      const resp = await requestJson('/api/scripts');
      state.scripts = resp.scripts || [];
      renderList();
    } catch (err) {
      listEl.innerHTML = `<div class="flex items-center justify-center py-8 text-red-400 text-xs">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadHosts() {
    try {
      const resp = await requestJson('/api/hosts');
      state.hosts = resp.hosts || [];
      // 填充执行弹窗的主机下拉
      populateHostSelect();
    } catch {
      // 静默失败，本机至少永远可用
    }
  }

  function populateHostSelect() {
    const options = ['<option value="local">🖥 本机（1Shell 宿主）</option>'];
    for (const h of state.hosts) {
      if (h.id === 'local') continue;
      const label = `${escapeHtml(h.name || h.host || h.id)}${h.host ? ` (${escapeHtml(h.host)})` : ''}`;
      options.push(`<option value="${escapeHtml(h.id)}">${label}</option>`);
    }
    runHostSelect.innerHTML = options.join('');
  }

  // ─── 列表渲染 ──────────────────────────────────────────────────────
  function renderList() {
    updateCategoryCounts();
    const { category, keyword } = state.filter;
    const filtered = state.scripts.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (keyword) {
        const hay = `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(keyword)) return false;
      }
      return true;
    });

    countEl.textContent = filtered.length;

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="flex flex-col items-center justify-center py-12 text-slate-400 text-xs gap-2">
        <div class="text-3xl opacity-40">📜</div>
        <div>${state.scripts.length === 0 ? '还没有脚本，点击"+ 新建脚本"开始' : '没有匹配的脚本'}</div>
      </div>`;
      return;
    }

    listEl.innerHTML = filtered.map((s) => cardHTML(s)).join('');
  }

  function updateCategoryCounts() {
    const counts = { all: state.scripts.length };
    for (const s of state.scripts) {
      const cat = s.category || 'other';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    document.querySelectorAll('.cat-count').forEach((el) => {
      const cat = el.getAttribute('data-count-cat');
      el.textContent = counts[cat] || 0;
    });
  }

  function cardHTML(script) {
    const risk = RISK_BADGES[script.riskLevel] || RISK_BADGES.safe;
    const icon = script.icon || CATEGORY_ICONS[script.category] || '📜';
    const activeCls = script.id === state.currentId ? 'active border-purple-300 bg-purple-50/50' : 'border-slate-200';
    const paramCount = (script.parameters || []).length;
    const paramText = paramCount === 0 ? '无参数' : `<span class="text-purple-500">${paramCount} 参数</span>`;
    const catLabel = CATEGORY_LABELS[script.category] || '其他';
    return `
      <div class="script-card cursor-pointer p-3 rounded-xl border bg-white dark:bg-[#0b1324] ${activeCls}" data-id="${escapeHtml(script.id)}">
        <div class="flex items-center gap-2">
          <span class="text-base">${escapeHtml(icon)}</span>
          <span class="flex-1 text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(script.name)}</span>
          <span class="shrink-0 text-[9px] px-1.5 py-0.5 rounded border ${risk.cls}">${risk.text}</span>
        </div>
        ${script.description ? `<div class="mt-1 text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2">${escapeHtml(script.description)}</div>` : ''}
        <div class="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
          <span class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700">${escapeHtml(catLabel)}</span>
          <span>·</span>
          ${paramText}
          <span>·</span>
          <span>${script.runCount || 0} 次</span>
        </div>
      </div>
    `;
  }

  // ─── 选中 / 新建 ───────────────────────────────────────────────────
  function selectScript(id) {
    const script = state.scripts.find((s) => s.id === id);
    if (!script) return;
    state.currentId = id;
    state.isNew = false;
    state.currentDraft = deepClone(script);
    // 如果在历史视图，切回详情
    if (state.view === 'history') hideHistoryView();
    renderDetail(state.currentDraft);
    renderList(); // 刷新 active 状态
  }

  function newScript() {
    // 如果在历史视图，切回
    if (state.view === 'history') hideHistoryView();
    state.currentId = null;
    state.isNew = true;
    state.currentDraft = {
      id: null,
      name: '未命名脚本',
      icon: '📜',
      category: 'other',
      tags: [],
      riskLevel: 'safe',
      description: '',
      content: '#!/bin/bash\necho hello\n',
      parameters: [],
      runCount: 0,
      createdAt: null,
      updatedAt: null,
    };
    renderDetail(state.currentDraft);
    renderList();
    // 聚焦到名称
    setTimeout(() => nameEl.focus(), 50);
  }

  // ─── 详情渲染 ──────────────────────────────────────────────────────
  function renderDetail(script) {
    if (!script) {
      emptyEl.classList.remove('hidden');
      paneEl.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    paneEl.classList.remove('hidden');

    iconEl.textContent = script.icon || CATEGORY_ICONS[script.category] || '📜';
    nameEl.value = script.name || '';

    if (state.isNew) {
      metaEl.textContent = '草稿（尚未保存）';
      btnDelete.style.display = 'none';
      btnRun.style.display = 'none';
    } else {
      metaEl.textContent = `ID: ${script.id} · 创建于 ${script.createdAt || '-'} · 更新 ${script.updatedAt || '-'} · 运行 ${script.runCount || 0} 次`;
      btnDelete.style.display = '';
      btnRun.style.display = '';
    }

    const risk = RISK_BADGES[script.riskLevel] || RISK_BADGES.safe;
    riskBadgeEl.textContent = risk.text;
    riskBadgeEl.className = `shrink-0 text-[9px] px-1.5 py-0.5 rounded border ${risk.cls}`;

    fIcon.value = script.icon || '';
    fCategory.value = script.category || 'other';
    fDescription.value = script.description || '';
    fContent.value = script.content || '';

    // risk radio
    document.querySelectorAll('input[name="risk"]').forEach((r) => {
      r.checked = r.value === script.riskLevel;
    });
    syncRiskLabels();

    // tags
    renderTags(script.tags || []);

    // params
    renderParams(script.parameters || []);
  }

  function syncRiskLabels() {
    document.querySelectorAll('.risk-label').forEach((label) => {
      const riskVal = label.getAttribute('data-risk');
      const input = label.querySelector('input[type="radio"]');
      const active = input?.checked;
      if (active) {
        label.classList.remove('border-slate-200', 'bg-slate-50');
        if (riskVal === 'safe') label.classList.add('border-emerald-300', 'bg-emerald-50');
        else if (riskVal === 'confirm') label.classList.add('border-amber-300', 'bg-amber-50');
        else label.classList.add('border-red-300', 'bg-red-50');
      } else {
        label.classList.remove('border-emerald-300', 'bg-emerald-50',
          'border-amber-300', 'bg-amber-50',
          'border-red-300', 'bg-red-50');
        label.classList.add('border-slate-200', 'bg-slate-50');
      }
    });
  }

  function renderTags(tags) {
    // 清空除输入框外的内容
    fTagsContainer.querySelectorAll('.tag-chip').forEach((el) => el.remove());
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip h-6 px-2 rounded-full border border-purple-200 bg-purple-50 text-purple-600 text-[10px] font-medium flex items-center gap-1';
      chip.innerHTML = `${escapeHtml(tag)} <button type="button" class="text-purple-400 hover:text-red-500" data-action="remove-tag">✕</button>`;
      chip.setAttribute('data-tag', tag);
      chip.querySelector('button').addEventListener('click', () => chip.remove());
      fTagsContainer.insertBefore(chip, fTagsInput);
    }
  }

  function addTag(tag) {
    const exists = Array.from(fTagsContainer.querySelectorAll('.tag-chip'))
      .some((el) => el.getAttribute('data-tag') === tag);
    if (exists) return;
    const chip = document.createElement('span');
    chip.className = 'tag-chip h-6 px-2 rounded-full border border-purple-200 bg-purple-50 text-purple-600 text-[10px] font-medium flex items-center gap-1';
    chip.innerHTML = `${escapeHtml(tag)} <button type="button" class="text-purple-400 hover:text-red-500">✕</button>`;
    chip.setAttribute('data-tag', tag);
    chip.querySelector('button').addEventListener('click', () => chip.remove());
    fTagsContainer.insertBefore(chip, fTagsInput);
  }

  function collectTags() {
    return Array.from(fTagsContainer.querySelectorAll('.tag-chip'))
      .map((el) => el.getAttribute('data-tag'))
      .filter(Boolean);
  }

  // ─── 参数定义行 ────────────────────────────────────────────────────
  function renderParams(params) {
    paramsList.querySelectorAll('.param-row').forEach((el) => el.remove());
    if (params.length === 0) {
      paramsEmpty.style.display = '';
      return;
    }
    paramsEmpty.style.display = 'none';
    params.forEach((p) => appendParamRow(p));
  }

  function appendParamRow(p) {
    paramsEmpty.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'param-row p-2.5 flex items-center gap-2';
    row.innerHTML = `
      <input type="text" class="p-name w-32 h-7 px-2 rounded border border-slate-200 bg-slate-50 text-xs font-mono outline-none focus:border-purple-400" placeholder="变量名" />
      <select class="p-type h-7 px-2 rounded border border-slate-200 bg-slate-50 text-xs outline-none">
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
        <option value="select">select</option>
      </select>
      <input type="text" class="p-label flex-1 h-7 px-2 rounded border border-slate-200 bg-slate-50 text-xs outline-none" placeholder="显示名" />
      <input type="text" class="p-default w-28 h-7 px-2 rounded border border-slate-200 bg-slate-50 text-xs outline-none" placeholder="默认值" />
      <label class="flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
        <input type="checkbox" class="p-required accent-purple-500" /> 必填
      </label>
      <button type="button" class="p-delete h-7 w-7 flex items-center justify-center rounded border border-slate-200 text-slate-400 hover:text-red-500 text-xs">✕</button>
    `;
    row.querySelector('.p-name').value = p.name || '';
    row.querySelector('.p-type').value = p.type || 'string';
    row.querySelector('.p-label').value = p.label || '';
    row.querySelector('.p-default').value = p.default || '';
    row.querySelector('.p-required').checked = !!p.required;
    row.querySelector('.p-delete').addEventListener('click', () => {
      row.remove();
      if (paramsList.querySelectorAll('.param-row').length === 0) {
        paramsEmpty.style.display = '';
      }
    });
    paramsList.appendChild(row);
  }

  function collectParams() {
    return Array.from(paramsList.querySelectorAll('.param-row')).map((row) => {
      const obj = {
        name: row.querySelector('.p-name').value.trim(),
        type: row.querySelector('.p-type').value,
        label: row.querySelector('.p-label').value.trim(),
        default: row.querySelector('.p-default').value,
        required: row.querySelector('.p-required').checked,
      };
      return obj;
    }).filter((p) => p.name);
  }

  function collectFormPayload() {
    const risk = document.querySelector('input[name="risk"]:checked');
    return {
      name: nameEl.value.trim() || '未命名脚本',
      icon: fIcon.value.trim(),
      category: fCategory.value,
      tags: collectTags(),
      riskLevel: risk ? risk.value : 'safe',
      description: fDescription.value.trim(),
      content: fContent.value,
      parameters: collectParams(),
    };
  }

  // ─── 保存 ─────────────────────────────────────────────────────────
  async function onSave() {
    const payload = collectFormPayload();
    if (!payload.name) {
      showToast('请填写脚本名称', 'warn');
      return;
    }
    if (!payload.content.trim()) {
      showToast('请填写脚本内容', 'warn');
      return;
    }

    try {
      btnSave.disabled = true;
      btnSave.textContent = '保存中...';
      if (state.isNew) {
        const resp = await requestJson('/api/scripts', { method: 'POST', body: JSON.stringify(payload) });
        showToast('脚本已创建', 'success');
        state.scripts.unshift(resp.script);
        state.isNew = false;
        state.currentId = resp.script.id;
        state.currentDraft = deepClone(resp.script);
        renderDetail(state.currentDraft);
      } else {
        const resp = await requestJson(`/api/scripts/${encodeURIComponent(state.currentId)}`, {
          method: 'PUT', body: JSON.stringify(payload),
        });
        showToast('脚本已保存', 'success');
        const idx = state.scripts.findIndex((s) => s.id === state.currentId);
        if (idx !== -1) state.scripts[idx] = resp.script;
        state.currentDraft = deepClone(resp.script);
        renderDetail(state.currentDraft);
      }
      renderList();
    } catch (err) {
      showErrorMessage(err);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = '保存';
    }
  }

  // ─── 删除 ─────────────────────────────────────────────────────────
  function onDelete() {
    if (state.isNew || !state.currentId) {
      // 草稿：直接清空
      state.isNew = false;
      state.currentId = null;
      state.currentDraft = null;
      renderDetail(null);
      return;
    }
    const script = state.scripts.find((s) => s.id === state.currentId);
    confirmTitle.textContent = '确认删除脚本';
    confirmMessage.textContent = `此操作不可撤销，确定要删除脚本"${script?.name || state.currentId}"吗？`;
    confirmModal.classList.remove('hidden');

    // 绑定一次性的 ok 处理
    const handler = async () => {
      confirmOk.removeEventListener('click', handler);
      try {
        await requestJson(`/api/scripts/${encodeURIComponent(state.currentId)}`, { method: 'DELETE' });
        showToast('脚本已删除', 'success');
        state.scripts = state.scripts.filter((s) => s.id !== state.currentId);
        state.currentId = null;
        state.currentDraft = null;
        renderDetail(null);
        renderList();
      } catch (err) {
        showErrorMessage(err);
      } finally {
        confirmModal.classList.add('hidden');
      }
    };
    confirmOk.addEventListener('click', handler);
  }

  // ─── 执行弹窗 ──────────────────────────────────────────────────────
  function onOpenRunModal() {
    if (state.isNew || !state.currentId) {
      showToast('请先保存脚本后再执行', 'warn');
      return;
    }
    const script = state.scripts.find((s) => s.id === state.currentId);
    if (!script) return;

    runModalIcon.textContent = script.icon || CATEGORY_ICONS[script.category] || '📜';
    runModalTitle.textContent = script.name;
    const paramCount = (script.parameters || []).length;
    runModalSubtitle.textContent = paramCount > 0 ? `填写 ${paramCount} 个参数并选择目标主机` : '选择目标主机';

    const risk = RISK_BADGES[script.riskLevel] || RISK_BADGES.safe;
    runModalRisk.textContent = risk.text;
    runModalRisk.className = `shrink-0 text-[9px] px-1.5 py-0.5 rounded border ${risk.cls}`;

    // 渲染参数表单
    runParamsForm.innerHTML = '';
    for (const def of script.parameters || []) {
      runParamsForm.appendChild(buildParamInput(def));
    }

    // 风险确认行
    if (script.riskLevel === 'safe') {
      runConfirmLabel.classList.add('hidden');
      runConfirmCb.checked = false;
    } else {
      runConfirmLabel.classList.remove('hidden');
      runConfirmCb.checked = false;
    }

    // 结果区重置
    runResultArea.classList.add('hidden');
    runResultList.innerHTML = '';
    runWarnings.classList.add('hidden');
    runWarnings.innerHTML = '';

    runModal.classList.remove('hidden');
    // 自动刷新一次预览
    refreshPreview();
  }

  function buildParamInput(def) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-1';
    wrap.setAttribute('data-param', def.name);

    const label = document.createElement('label');
    label.className = 'text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1';
    label.innerHTML = `${escapeHtml(def.label || def.name)} <span class="font-mono normal-case text-[9px] text-slate-400">{{${escapeHtml(def.name)}}}</span>${def.required ? '<span class="text-red-500">*</span>' : ''}`;
    wrap.appendChild(label);

    let input;
    if (def.type === 'boolean') {
      input = document.createElement('select');
      input.innerHTML = '<option value="false">false</option><option value="true">true</option>';
    } else if (def.type === 'select') {
      input = document.createElement('select');
      (def.options || []).forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label || o.value;
        input.appendChild(opt);
      });
    } else {
      input = document.createElement('input');
      input.type = def.type === 'number' ? 'number' : 'text';
    }
    input.className = 'h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs outline-none focus:border-purple-400';
    input.value = def.default != null ? def.default : '';
    input.setAttribute('data-pname', def.name);
    input.addEventListener('change', refreshPreview);
    input.addEventListener('input', debounce(refreshPreview, 400));
    wrap.appendChild(input);

    return wrap;
  }

  function collectRunParams() {
    const params = {};
    runParamsForm.querySelectorAll('[data-pname]').forEach((el) => {
      params[el.getAttribute('data-pname')] = el.value;
    });
    return params;
  }

  async function refreshPreview() {
    if (!state.currentId) return;
    const hostIds = getSelectedHostIds();
    const hostId = hostIds[0] || 'local';
    const params = collectRunParams();
    try {
      const resp = await requestJson(`/api/scripts/${encodeURIComponent(state.currentId)}/preview`, {
        method: 'POST', body: JSON.stringify({ hostId, params }),
      });
      runPreview.textContent = resp.renderedCommand || '（空）';
      if (resp.warnings && resp.warnings.length > 0) {
        runWarnings.classList.remove('hidden');
        runWarnings.innerHTML = resp.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br>');
      } else {
        runWarnings.classList.add('hidden');
      }
    } catch (err) {
      runPreview.textContent = `预览失败: ${err.message}`;
    }
  }

  function getSelectedHostIds() {
    return Array.from(runHostSelect.selectedOptions).map((o) => o.value).filter(Boolean);
  }

  async function onExecute() {
    if (!state.currentId) return;
    const script = state.scripts.find((s) => s.id === state.currentId);
    const needConfirm = script && script.riskLevel !== 'safe';
    if (needConfirm && !runConfirmCb.checked) {
      showToast('请勾选风险确认复选框', 'warn');
      return;
    }

    const hostIds = getSelectedHostIds();
    if (hostIds.length === 0) {
      showToast('请至少选择一台主机', 'warn');
      return;
    }

    const params = collectRunParams();
    const isBatch = hostIds.length > 1;

    try {
      runExecuteBtn.disabled = true;
      runExecuteBtn.textContent = isBatch ? `执行中（0/${hostIds.length}）...` : '执行中...';
      runResultArea.classList.remove('hidden');
      runResultList.innerHTML = '<div class="text-xs text-slate-400 py-2">正在运行...</div>';

      let results;
      if (isBatch) {
        const resp = await requestJson(`/api/scripts/${encodeURIComponent(state.currentId)}/run-batch`, {
          method: 'POST',
          body: JSON.stringify({ hostIds, params, confirmed: true }),
        });
        runResultMeta.textContent = `共 ${resp.total} 台 · ✅ ${resp.success} 成功 · ❌ ${resp.failed} 失败`;
        results = resp.results || [];
      } else {
        const resp = await requestJson(`/api/scripts/${encodeURIComponent(state.currentId)}/run`, {
          method: 'POST',
          body: JSON.stringify({ hostId: hostIds[0], params, confirmed: true }),
        });
        results = [{ hostId: hostIds[0], ...resp, ok: true }];
        const icon = resp.status === 'success' ? '✅' : '❌';
        runResultMeta.textContent = `${icon} exit=${resp.exitCode} · ${resp.durationMs}ms`;
      }

      // 渲染每台主机的结果
      runResultList.innerHTML = results.map((r) => resultCardHTML(r)).join('');

      const successCount = results.filter((r) => r.ok && r.status === 'success').length;
      if (successCount === results.length) {
        showToast(isBatch ? `全部 ${successCount} 台执行成功` : '执行成功', 'success');
      } else {
        showToast(`${successCount}/${results.length} 台成功`, successCount > 0 ? 'warn' : 'error');
      }

      // 刷新运行次数
      const idx = state.scripts.findIndex((s) => s.id === state.currentId);
      if (idx !== -1) state.scripts[idx].runCount = (state.scripts[idx].runCount || 0) + results.length;
      renderList();
    } catch (err) {
      runResultMeta.textContent = '❌ 执行失败';
      runResultList.innerHTML = `<div class="text-xs text-red-500 py-2">${escapeHtml(err.message)}</div>`;
      showErrorMessage(err);
    } finally {
      runExecuteBtn.disabled = false;
      runExecuteBtn.textContent = '▶ 执行';
    }
  }

  function resultCardHTML(r) {
    const icon = r.ok && r.status === 'success' ? '🟢' : '🔴';
    const hostLabel = escapeHtml(r.hostName || r.hostId || '');
    const meta = [
      r.exitCode != null ? `exit=${r.exitCode}` : '',
      r.durationMs != null ? `${r.durationMs}ms` : '',
      r.runId ? `#${r.runId}` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] overflow-hidden">
        <div class="flex items-center gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 text-[11px]">
          <span>${icon}</span>
          <span class="font-semibold text-slate-700 dark:text-slate-200">${hostLabel}</span>
          <span class="ml-auto text-slate-400">${meta}</span>
        </div>
        ${r.stdout ? `<pre class="px-3 py-1.5 bg-slate-900 text-emerald-300 font-mono text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-auto">${escapeHtml(r.stdout)}</pre>` : ''}
        ${r.stderr ? `<pre class="px-3 py-1.5 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300 font-mono text-[10px] whitespace-pre-wrap break-all max-h-20 overflow-auto">${escapeHtml(r.stderr)}</pre>` : ''}
        ${r.error && !r.stderr ? `<div class="px-3 py-1.5 text-[10px] text-red-500">${escapeHtml(r.error)}</div>` : ''}
      </div>
    `;
  }

  function runModalClose() {
    runModal.classList.add('hidden');
  }

  // ─── AI 生成脚本 ───────────────────────────────────────────────────
  function openAiGenModal() {
    aiGenPrompt.value = '';
    aiGenStatus.classList.add('hidden');
    aiGenStatus.textContent = '';
    aiGenSubmit.disabled = false;
    aiGenSubmit.textContent = '✦ 生成';
    aiGenModal.classList.remove('hidden');
    setTimeout(() => aiGenPrompt.focus(), 50);
  }

  function closeAiGenModal() {
    aiGenModal.classList.add('hidden');
  }

  async function onAiGenerate() {
    const prompt = aiGenPrompt.value.trim();
    if (!prompt) {
      showToast('请描述你想要的脚本', 'warn');
      return;
    }

    aiGenSubmit.disabled = true;
    aiGenSubmit.textContent = '生成中...';
    aiGenStatus.textContent = '正在调用 AI，请稍候...';
    aiGenStatus.classList.remove('hidden');

    try {
      const resp = await requestJson('/api/scripts/ai-generate', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });

      if (!resp.ok || !resp.script) {
        aiGenStatus.textContent = resp.error || 'AI 返回异常，请重试';
        return;
      }

      closeAiGenModal();

      // 用 AI 返回的内容填充新建表单
      state.currentId = null;
      state.isNew = true;
      state.currentDraft = {
        id: null,
        name: resp.script.name || '未命名脚本',
        icon: resp.script.icon || '📜',
        category: resp.script.category || 'other',
        tags: resp.script.tags || [],
        riskLevel: resp.script.riskLevel || 'safe',
        description: resp.script.description || '',
        content: resp.script.content || '',
        parameters: resp.script.parameters || [],
        runCount: 0,
        createdAt: null,
        updatedAt: null,
      };

      if (state.view === 'history') hideHistoryView();
      renderDetail(state.currentDraft);
      renderList();
      showToast('AI 已生成脚本草稿，请检查后点击"保存"', 'success');
    } catch (err) {
      aiGenStatus.textContent = '生成失败: ' + err.message;
      showErrorMessage(err);
    } finally {
      aiGenSubmit.disabled = false;
      aiGenSubmit.textContent = '✦ 生成';
    }
  }

  // ─── 执行历史视图 ──────────────────────────────────────────────────
  function showHistoryView() {
    state.view = 'history';
    state.historyOffset = 0;
    emptyEl.classList.add('hidden');
    paneEl.classList.add('hidden');
    playbookPane.classList.add('hidden');
    historyPane.classList.remove('hidden');
    loadHistory(0);
  }

  function hideHistoryView() {
    state.view = 'scripts';
    historyPane.classList.add('hidden');
    if (state.currentDraft) {
      paneEl.classList.remove('hidden');
    } else {
      emptyEl.classList.remove('hidden');
    }
  }

  async function loadHistory(offset) {
    offset = Math.max(offset || 0, 0);
    state.historyOffset = offset;
    const limit = 20;
    try {
      const resp = await requestJson(`/api/script-runs?limit=${limit}&offset=${offset}`);
      state.historyTotal = resp.total || 0;
      historyCount.textContent = `共 ${resp.total} 条记录`;

      const page = Math.floor(offset / limit) + 1;
      const totalPages = Math.max(1, Math.ceil(resp.total / limit));
      historyPage.textContent = `${page} / ${totalPages}`;
      historyPrev.disabled = offset === 0;
      historyNext.disabled = offset + limit >= resp.total;

      const runs = resp.runs || [];
      if (runs.length === 0) {
        historyList.innerHTML = '<div class="text-center text-slate-400 text-xs py-12">暂无执行记录</div>';
        return;
      }
      historyList.innerHTML = runs.map(runRowHTML).join('');
    } catch (err) {
      historyList.innerHTML = `<div class="text-center text-red-400 text-xs py-8">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  function runRowHTML(run) {
    const statusIcon = run.status === 'success' ? '🟢' : run.status === 'running' ? '🟡' : '🔴';
    const exitText = run.exitCode != null ? `exit=${run.exitCode}` : '';
    const durationText = run.durationMs != null ? `${run.durationMs}ms` : '';
    return `
      <div class="p-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] mb-2">
        <div class="flex items-center gap-2 text-xs">
          <span>${statusIcon}</span>
          <span class="font-semibold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(run.scriptName || run.scriptId)}</span>
          <span class="text-slate-400">→</span>
          <span class="text-slate-500">${escapeHtml(run.hostName || run.hostId)}</span>
          <span class="ml-auto text-[10px] text-slate-400 shrink-0">${escapeHtml(run.startedAt || '')} ${exitText ? '· ' + exitText : ''} ${durationText ? '· ' + durationText : ''}</span>
        </div>
        ${run.renderedCommand ? `<pre class="mt-1.5 px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-mono text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-all max-h-16 overflow-auto">${escapeHtml(run.renderedCommand)}</pre>` : ''}
        ${run.stdout ? `<pre class="mt-1 px-2 py-1 rounded bg-slate-900 text-emerald-300 text-[10px] font-mono whitespace-pre-wrap break-all max-h-24 overflow-auto">${escapeHtml(run.stdout.substring(0, 2000))}</pre>` : ''}
        ${run.error ? `<div class="mt-1 text-[10px] text-red-500">${escapeHtml(run.error)}</div>` : ''}
      </div>
    `;
  }

  // ─── helpers ───────────────────────────────────────────────────────
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  // ─── Playbook ─────────────────────────────────────────────────────
  function showPlaybookView() {
    state.view = 'playbook';
    emptyEl.classList.add('hidden');
    paneEl.classList.add('hidden');
    historyPane.classList.add('hidden');
    playbookPane.classList.remove('hidden');
    playbookEditor.classList.add('hidden');
    playbookListView.classList.remove('hidden');
    loadPlaybooks();
  }

  function hidePlaybookView() {
    state.view = 'scripts';
    playbookPane.classList.add('hidden');
    state.currentPlaybookId = null;
    state.currentPlaybookDraft = null;
    state.isNewPlaybook = false;
    if (state.currentDraft) {
      paneEl.classList.remove('hidden');
    } else {
      emptyEl.classList.remove('hidden');
    }
  }

  async function loadPlaybooks() {
    playbookListView.innerHTML = '<div class="text-center text-slate-400 text-xs py-8">加载中...</div>';
    try {
      const resp = await requestJson('/api/playbooks');
      state.playbooks = resp.playbooks || [];
      renderPlaybookList();
    } catch (err) {
      playbookListView.innerHTML = `<div class="text-center text-red-400 text-xs py-8">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderPlaybookList() {
    if (!state.playbooks.length) {
      playbookListView.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
          <div class="text-4xl opacity-40">📘</div>
          <div class="text-xs">暂无 Playbook，点击右上角创建</div>
        </div>
      `;
      return;
    }
    playbookListView.innerHTML = state.playbooks.map((pb) => `
      <div class="p-4 rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] mb-3 cursor-pointer hover:border-purple-300 transition-all playbook-card" data-pb-id="${escapeHtml(pb.id)}">
        <div class="flex items-center gap-3">
          <span class="text-xl">${escapeHtml(pb.icon || '📘')}</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(pb.name)}</div>
            <div class="text-[10px] text-slate-400 truncate">${escapeHtml(pb.description || '无描述')}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-[10px] text-slate-400">${pb.steps.length} 步</div>
            <div class="text-[10px] text-slate-400">${escapeHtml(pb.updatedAt || '')}</div>
          </div>
        </div>
        ${pb.steps.length ? `
          <div class="mt-2 flex flex-wrap gap-1">
            ${pb.steps.map((s, i) => `<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">${i + 1}. ${escapeHtml(s.scriptName || s.scriptId || '?')}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');

    playbookListView.querySelectorAll('.playbook-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.pbId;
        const pb = state.playbooks.find((p) => p.id === id);
        if (pb) openPlaybookEditor(pb);
      });
    });
  }

  function newPlaybook() {
    state.isNewPlaybook = true;
    state.currentPlaybookId = null;
    state.currentPlaybookDraft = { name: '', icon: '📘', description: '', steps: [] };
    renderPlaybookEditor();
  }

  function openPlaybookEditor(pb) {
    state.isNewPlaybook = false;
    state.currentPlaybookId = pb.id;
    state.currentPlaybookDraft = deepClone(pb);
    renderPlaybookEditor();
  }

  function renderPlaybookEditor() {
    const draft = state.currentPlaybookDraft;
    if (!draft) return;
    playbookListView.classList.add('hidden');
    playbookEditor.classList.remove('hidden');
    pbNameEl.value = draft.name || '';
    pbIconEl.value = draft.icon || '📘';
    pbDescEl.value = draft.description || '';
    pbDeleteBtn.classList.toggle('hidden', state.isNewPlaybook);
    renderPlaybookSteps();
  }

  function buildHostOptions(selectedId, { optional = false } = {}) {
    const opts = state.hosts.map((h) => `<option value="${escapeHtml(h.id)}" ${h.id === selectedId ? 'selected' : ''}>${escapeHtml(h.name)} (${escapeHtml(h.host || '本机')})</option>`);
    if (optional) {
      return `<option value="" ${!selectedId ? 'selected' : ''}>选择主机（可选）</option><option value="local" ${selectedId === 'local' ? 'selected' : ''}>本机</option>${opts.join('')}`;
    }
    return `<option value="local" ${selectedId === 'local' || !selectedId ? 'selected' : ''}>本机</option>${opts.join('')}`;
  }

  function buildScriptOptions(selectedId) {
    return state.scripts.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.icon || '📜')} ${escapeHtml(s.name)}</option>`).join('');
  }

  function renderPlaybookSteps() {
    const draft = state.currentPlaybookDraft;
    if (!draft) return;
    if (!draft.steps.length) {
      pbStepsList.innerHTML = '<div class="text-center text-slate-400 text-xs py-6">点击"+ 添加步骤"来组装编排</div>';
      return;
    }
    pbStepsList.innerHTML = draft.steps.map((step, index) => `
      <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3" data-step-idx="${index}">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-[10px] font-bold text-slate-400 w-5 text-center shrink-0">${index + 1}</span>
          <select class="pb-step-script flex-1 h-7 px-2 rounded border border-slate-200 bg-slate-50 dark:bg-[#0b1324] dark:border-[#1e293b] text-xs outline-none">
            <option value="">选择脚本</option>
            ${buildScriptOptions(step.scriptId)}
          </select>
          <select class="pb-step-host w-36 h-7 px-2 rounded border border-slate-200 bg-slate-50 dark:bg-[#0b1324] dark:border-[#1e293b] text-xs outline-none">
            ${buildHostOptions(step.hostId, { optional: true })}
          </select>
          <button class="pb-step-up w-6 h-6 flex items-center justify-center rounded border border-slate-200 text-[10px] text-slate-400 hover:text-blue-500 ${index === 0 ? 'opacity-30' : ''}" type="button" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="pb-step-down w-6 h-6 flex items-center justify-center rounded border border-slate-200 text-[10px] text-slate-400 hover:text-blue-500 ${index === draft.steps.length - 1 ? 'opacity-30' : ''}" type="button" ${index === draft.steps.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="pb-step-remove w-6 h-6 flex items-center justify-center rounded border border-slate-200 text-[10px] text-red-400 hover:text-red-600" type="button">✕</button>
        </div>
        <div class="pl-7 text-[10px] text-slate-400">${escapeHtml(step.scriptName || '')}${step.hostId ? ' → ' + escapeHtml(step.hostId) : ''}</div>
      </div>
    `).join('');

    // 事件委托
    pbStepsList.querySelectorAll('[data-step-idx]').forEach((el) => {
      const idx = Number(el.dataset.stepIdx);
      el.querySelector('.pb-step-script')?.addEventListener('change', (e) => {
        const s = state.scripts.find((sc) => sc.id === e.target.value);
        draft.steps[idx].scriptId = e.target.value;
        draft.steps[idx].scriptName = s?.name || '';
      });
      el.querySelector('.pb-step-host')?.addEventListener('change', (e) => {
        draft.steps[idx].hostId = e.target.value;
      });
      el.querySelector('.pb-step-up')?.addEventListener('click', () => {
        if (idx > 0) { [draft.steps[idx - 1], draft.steps[idx]] = [draft.steps[idx], draft.steps[idx - 1]]; renderPlaybookSteps(); }
      });
      el.querySelector('.pb-step-down')?.addEventListener('click', () => {
        if (idx < draft.steps.length - 1) { [draft.steps[idx], draft.steps[idx + 1]] = [draft.steps[idx + 1], draft.steps[idx]]; renderPlaybookSteps(); }
      });
      el.querySelector('.pb-step-remove')?.addEventListener('click', () => {
        draft.steps.splice(idx, 1);
        renderPlaybookSteps();
      });
    });
  }

  function appendPlaybookStep(step) {
    const draft = state.currentPlaybookDraft;
    if (!draft) return;
    draft.steps.push({ scriptId: step.scriptId || '', scriptName: step.scriptName || '', hostId: step.hostId || '', params: step.params || {}, stopOnFail: true });
    renderPlaybookSteps();
  }

  function collectPlaybookDraft() {
    const draft = state.currentPlaybookDraft;
    if (!draft) return null;
    draft.name = pbNameEl.value.trim();
    draft.icon = pbIconEl.value.trim() || '📘';
    draft.description = pbDescEl.value.trim();
    return draft;
  }

  async function onSavePlaybook() {
    const draft = collectPlaybookDraft();
    if (!draft) return;
    if (!draft.name) { showToast('请输入 Playbook 名称', 'warn'); return; }
    if (!draft.steps.length) { showToast('请至少添加一个步骤', 'warn'); return; }
    for (const step of draft.steps) {
      if (!step.scriptId) { showToast('有步骤未选择脚本', 'warn'); return; }
    }

    pbSaveBtn.disabled = true;
    pbSaveBtn.textContent = '保存中...';
    try {
      if (state.isNewPlaybook) {
        const resp = await requestJson('/api/playbooks', { method: 'POST', body: JSON.stringify(draft) });
        state.currentPlaybookId = resp.playbook.id;
        state.isNewPlaybook = false;
        state.currentPlaybookDraft = deepClone(resp.playbook);
        showToast('Playbook 已创建', 'success');
      } else {
        const resp = await requestJson(`/api/playbooks/${encodeURIComponent(state.currentPlaybookId)}`, { method: 'PUT', body: JSON.stringify(draft) });
        state.currentPlaybookDraft = deepClone(resp.playbook);
        showToast('Playbook 已保存', 'success');
      }
      pbDeleteBtn.classList.remove('hidden');
      await loadPlaybooks();
    } catch (err) {
      showErrorMessage(err);
    } finally {
      pbSaveBtn.disabled = false;
      pbSaveBtn.textContent = '保存';
    }
  }

  async function onRunPlaybook() {
    if (state.isNewPlaybook || !state.currentPlaybookId) {
      showToast('请先保存 Playbook', 'warn');
      return;
    }
    pbRunBtn.disabled = true;
    pbRunBtn.textContent = '执行中...';
    try {
      const resp = await requestJson(`/api/playbooks/${encodeURIComponent(state.currentPlaybookId)}/run`, { method: 'POST' });
      const run = resp.run;
      if (run.status === 'success') {
        showToast(`Playbook 执行成功，完成 ${run.completedSteps}/${run.totalSteps} 步`, 'success');
      } else {
        showToast(`Playbook 执行失败：${run.error || '部分步骤未通过'}`, 'error');
      }
    } catch (err) {
      showErrorMessage(err);
    } finally {
      pbRunBtn.disabled = false;
      pbRunBtn.textContent = '▶ 执行';
    }
  }

  async function onDeletePlaybook() {
    if (state.isNewPlaybook || !state.currentPlaybookId) return;
    const pb = state.playbooks.find((p) => p.id === state.currentPlaybookId);
    confirmTitle.textContent = '确认删除 Playbook';
    confirmMessage.textContent = `此操作不可撤销，确定要删除"${pb?.name || state.currentPlaybookId}"吗？`;
    confirmModal.classList.remove('hidden');

    const handler = async () => {
      confirmOk.removeEventListener('click', handler);
      try {
        await requestJson(`/api/playbooks/${encodeURIComponent(state.currentPlaybookId)}`, { method: 'DELETE' });
        showToast('Playbook 已删除', 'success');
        state.currentPlaybookId = null;
        state.currentPlaybookDraft = null;
        state.isNewPlaybook = false;
        playbookEditor.classList.add('hidden');
        playbookListView.classList.remove('hidden');
        await loadPlaybooks();
      } catch (err) {
        showErrorMessage(err);
      } finally {
        confirmModal.classList.add('hidden');
      }
    };
    confirmOk.addEventListener('click', handler);
  }

  // ─── 启动 ─────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

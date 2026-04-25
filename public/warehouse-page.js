(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast, showErrorMessage } = window.appShared;
  const requestJson = createRequestJson({
    onUnauthorized: () => { window.location.href = 'index.html'; },
  });

  let skills = [];
  let mcps = [];
  let allMcpServers = [];
  let editingMcpId = null; // null = 新建；id = 编辑

  const $tabSkill = document.getElementById('tab-skill');
  const $tabMcp = document.getElementById('tab-mcp');
  const $tabLocal = document.getElementById('tab-local');
  const $paneSkill = document.getElementById('pane-skill');
  const $paneMcp = document.getElementById('pane-mcp');
  const $paneLocal = document.getElementById('pane-local');
  const $btnNewMcp = document.getElementById('btn-new-mcp');
  const $btnNewLocal = document.getElementById('btn-new-local');
  const $btnAiDeploy = document.getElementById('btn-ai-deploy');
  const $skillCount = document.getElementById('skill-count');
  const $mcpCount = document.getElementById('mcp-count');
  const $localCount = document.getElementById('local-count');

  const $modal = document.getElementById('mcp-modal');
  const $fName = document.getElementById('mcp-f-name');
  const $fUrl = document.getElementById('mcp-f-url');
  const $fToken = document.getElementById('mcp-f-token');
  const $fDesc = document.getElementById('mcp-f-desc');
  const $fTags = document.getElementById('mcp-f-tags');
  const $btnSave = document.getElementById('mcp-modal-save');
  const $btnCancel = document.getElementById('mcp-modal-cancel');
  const $btnClose = document.getElementById('mcp-modal-close');
  const $title = document.getElementById('mcp-modal-title');

  async function init() {
    bindEvents();
    await Promise.all([loadSkills(), loadMcps()]);
  }

  function bindEvents() {
    $tabSkill.addEventListener('click', () => switchTab('skill'));
    $tabMcp.addEventListener('click', () => switchTab('mcp'));
    $tabLocal.addEventListener('click', () => switchTab('local'));
    $btnNewMcp.addEventListener('click', () => openMcpModal(null));
    $btnNewLocal.addEventListener('click', openLocalModal);
    $btnAiDeploy.addEventListener('click', openDeployModal);
    $btnCancel.addEventListener('click', closeMcpModal);
    $btnClose.addEventListener('click', closeMcpModal);
    $btnSave.addEventListener('click', saveMcp);
    $modal.addEventListener('click', (e) => { if (e.target === $modal) closeMcpModal(); });
    bindLocalModal();
    bindDeployModal();
  }

  function switchTab(which) {
    const tabs = { skill: $tabSkill, mcp: $tabMcp, local: $tabLocal };
    const panes = { skill: $paneSkill, mcp: $paneMcp, local: $paneLocal };
    for (const [k, tab] of Object.entries(tabs)) {
      tab.classList.toggle('active', k === which);
    }
    for (const [k, pane] of Object.entries(panes)) {
      pane.classList.toggle('hidden', k !== which);
      pane.classList.toggle('grid', k === which);
    }
    $btnNewMcp.classList.toggle('hidden', which !== 'mcp');
    $btnNewLocal.classList.toggle('hidden', which !== 'local');
    $btnAiDeploy.classList.toggle('hidden', which !== 'local');
  }

  // ─── Skill ────────────────────────────────────────
  async function loadSkills() {
    try {
      const data = await requestJson('/api/skills');
      skills = data.skills || [];
      $skillCount.textContent = String(skills.length);
      renderSkills();
    } catch (err) {
      $paneSkill.innerHTML = `<div class="col-span-full text-red-500 text-center py-10 text-xs">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderSkills() {
    if (skills.length === 0) {
      $paneSkill.innerHTML = `<div class="col-span-full text-[12px] text-slate-400 text-center py-10">
        暂无 Skill。Skill 是"可复用能力"，创作台生成的是剧本而非 Skill。<br/>
        将来可从外部 import。
      </div>`;
      return;
    }
    $paneSkill.innerHTML = skills.map(s => {
      const isSystem = s.category === 'system';
      const deleteBtn = isSystem
        ? ''
        : `<button class="text-[10px] py-1 px-2 rounded border border-red-200 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" data-del-skill="${escapeHtml(s.id)}">删除</button>`;
      return `
      <div class="item-card flex flex-col gap-2">
        <div class="flex items-start gap-2">
          <span class="text-2xl">${escapeHtml(s.icon || '🔧')}</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold truncate">${escapeHtml(s.name || s.id)}</div>
            <div class="text-[10px] text-slate-400 font-mono truncate">${escapeHtml(s.id)}</div>
          </div>
          ${s.hasPlaybook ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">⚡直跑</span>' : ''}
          ${isSystem ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">系统</span>' : ''}
        </div>
        <div class="text-[11px] text-slate-500 line-clamp-3 min-h-[36px]">${escapeHtml(String(s.description || '').slice(0, 200))}</div>
        <div class="flex flex-wrap gap-1">
          ${(s.tags || []).slice(0, 4).map(t => `<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#1e293b] text-slate-500">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="flex gap-1 pt-1 border-t border-slate-100 dark:border-[#1e293b]">
          ${deleteBtn}
        </div>
      </div>`;
    }).join('');
    $paneSkill.querySelectorAll('[data-del-skill]').forEach(el =>
      el.addEventListener('click', () => deleteSkill(el.dataset.delSkill))
    );
  }

  // ─── MCP ────────────────────────────────────────
  async function loadMcps() {
    try {
      const data = await requestJson('/api/mcp-servers');
      const all = data.servers || [];
      allMcpServers = all;
      mcps = all.filter(m => m.type !== 'local' && !m.command);
      const locals = all.filter(m => m.type === 'local' || m.command);
      $mcpCount.textContent = String(mcps.length);
      $localCount.textContent = String(locals.length);
      renderMcps();
      renderLocals(locals);
    } catch (err) {
      $paneMcp.innerHTML = `<div class="col-span-full text-red-500 text-center py-10 text-xs">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderMcps() {
    if (mcps.length === 0) {
      $paneMcp.innerHTML = `<div class="col-span-full text-[12px] text-slate-400 text-center py-10">
        尚未登记 MCP Server。<br/>
        点右上角 "+ 添加 MCP" 登记一个远程 URL 类 MCP，创作台就能在"工具"里选到它。
      </div>`;
      return;
    }
    $paneMcp.innerHTML = mcps.map(m => `
      <div class="item-card flex flex-col gap-2">
        <div class="flex items-start gap-2">
          <span class="text-2xl">🔌</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold truncate">${escapeHtml(m.name)}</div>
            <div class="text-[10px] text-slate-400 font-mono truncate" title="${escapeHtml(m.url)}">${escapeHtml(m.url)}</div>
          </div>
          ${m.authTokenSet ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600" title="已配置鉴权">🔒</span>' : ''}
        </div>
        <div class="text-[11px] text-slate-500 line-clamp-2 min-h-[24px]">${escapeHtml(m.description || '')}</div>
        <div class="flex flex-wrap gap-1">
          ${(m.tags || []).slice(0, 4).map(t => `<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#1e293b] text-slate-500">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="flex gap-1 pt-1 border-t border-slate-100 dark:border-[#1e293b]">
          <button class="flex-1 text-[10px] py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b]" data-edit="${escapeHtml(m.id)}">编辑</button>
          <button class="text-[10px] py-1 px-2 rounded border border-red-200 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" data-del="${escapeHtml(m.id)}">删除</button>
        </div>
      </div>
    `).join('');
    $paneMcp.querySelectorAll('[data-edit]').forEach(el =>
      el.addEventListener('click', () => openMcpModal(el.dataset.edit))
    );
    $paneMcp.querySelectorAll('[data-del]').forEach(el =>
      el.addEventListener('click', () => deleteMcp(el.dataset.del))
    );
  }

  function openMcpModal(id) {
    editingMcpId = id;
    if (id) {
      const m = mcps.find(x => x.id === id);
      if (!m) return;
      $title.textContent = `编辑 MCP · ${m.name}`;
      $fName.value = m.name || '';
      $fUrl.value = m.url || '';
      $fToken.value = '';
      $fToken.placeholder = m.authTokenSet ? '已有 token，留空则不修改' : '（可选）';
      $fDesc.value = m.description || '';
      $fTags.value = (m.tags || []).join(', ');
    } else {
      $title.textContent = '添加 MCP Server';
      $fName.value = '';
      $fUrl.value = '';
      $fToken.value = '';
      $fToken.placeholder = '（可选）';
      $fDesc.value = '';
      $fTags.value = '';
    }
    $modal.classList.remove('hidden');
  }

  function closeMcpModal() {
    $modal.classList.add('hidden');
    editingMcpId = null;
  }

  async function saveMcp() {
    const name = $fName.value.trim();
    const url = $fUrl.value.trim();
    if (!name) { showToast?.('请填写名称', 'error'); return; }
    if (!url) { showToast?.('请填写 URL', 'error'); return; }
    const payload = {
      name, url,
      description: $fDesc.value.trim(),
      tags: $fTags.value.split(',').map(t => t.trim()).filter(Boolean),
    };
    const token = $fToken.value.trim();
    // 编辑时空 token 表示不修改；新建时空 token 表示没有 token
    if (editingMcpId && token) payload.authToken = token;
    if (!editingMcpId) payload.authToken = token;

    try {
      if (editingMcpId) {
        await requestJson(`/api/mcp-servers/${encodeURIComponent(editingMcpId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        showToast?.('已更新', 'success');
      } else {
        await requestJson('/api/mcp-servers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast?.('已添加', 'success');
      }
      closeMcpModal();
      await loadMcps();
    } catch (err) {
      showErrorMessage?.(err);
    }
  }

  async function deleteMcp(id) {
    const m = allMcpServers.find(x => x.id === id);
    if (!m) return;
    if (!confirm(`删除 MCP "${m.name}"？\n（已在 Playbook 中使用的引用会失效）`)) return;
    try {
      await requestJson(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast?.('已删除', 'success');
      await loadMcps();
    } catch (err) {
      showErrorMessage?.(err);
    }
  }

  async function deleteSkill(id) {
    const s = skills.find(x => x.id === id);
    if (!s) return;
    if (!confirm(`删除 Skill "${s.name || id}"？\n整个目录（SKILL.md + rules/ + workflows/ + references/）将被删除，不可恢复。`)) return;
    try {
      await requestJson(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast?.('已删除', 'success');
      await loadSkills();
    } catch (err) {
      showErrorMessage?.(err);
    }
  }

  // ─── 本地 MCP 渲染 ────────────────────────────────
  function renderLocals(locals) {
    if (locals.length === 0) {
      $paneLocal.innerHTML = `<div class="col-span-full text-[12px] text-slate-400 text-center py-10">
        尚未添加本地 MCP。<br/>
        点 "📦 + 添加本地 MCP" 手动注册，或 "🤖 AI 部署" 从 GitHub 一键部署。
      </div>`;
      return;
    }
    $paneLocal.innerHTML = locals.map(m => `
      <div class="item-card flex flex-col gap-2">
        <div class="flex items-start gap-2">
          <span class="text-2xl">📦</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold truncate">${escapeHtml(m.name)}</div>
            <div class="text-[10px] text-slate-400 font-mono truncate" title="${escapeHtml(m.command || '')}">${escapeHtml(m.command || '')}</div>
          </div>
          <span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">本地</span>
        </div>
        <div class="text-[11px] text-slate-500 line-clamp-2 min-h-[24px]">${escapeHtml(m.description || '')}</div>
        ${m.installDir ? `<div class="text-[10px] text-slate-400 truncate" title="${escapeHtml(m.installDir)}">📁 ${escapeHtml(m.installDir)}</div>` : ''}
        <div class="flex flex-wrap gap-1">
          ${(m.tags || []).slice(0, 4).map(t => `<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#1e293b] text-slate-500">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="flex gap-1 pt-1 border-t border-slate-100 dark:border-[#1e293b]">
          <button class="text-[10px] py-1 px-2 rounded border border-red-200 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" data-del="${escapeHtml(m.id)}">删除</button>
        </div>
      </div>
    `).join('');
    $paneLocal.querySelectorAll('[data-del]').forEach(el =>
      el.addEventListener('click', () => deleteMcp(el.dataset.del))
    );
  }

  // ─── 本地 MCP 添加模态 ────────────────────────────
  function bindLocalModal() {
    const $m = document.getElementById('local-modal');
    document.getElementById('local-modal-close').addEventListener('click', () => $m.classList.add('hidden'));
    document.getElementById('local-modal-cancel').addEventListener('click', () => $m.classList.add('hidden'));
    $m.addEventListener('click', (e) => { if (e.target === $m) $m.classList.add('hidden'); });
    document.getElementById('local-modal-save').addEventListener('click', async () => {
      const name = document.getElementById('local-f-name').value.trim();
      const command = document.getElementById('local-f-cmd').value.trim();
      if (!name) { showToast?.('请填写名称', 'error'); return; }
      if (!command) { showToast?.('请填写启动命令', 'error'); return; }
      try {
        await requestJson('/api/mcp-servers', {
          method: 'POST',
          body: JSON.stringify({
            name, command,
            description: document.getElementById('local-f-desc').value.trim(),
            tags: document.getElementById('local-f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
          }),
        });
        showToast?.('本地 MCP 已添加', 'success');
        $m.classList.add('hidden');
        await loadMcps();
      } catch (err) { showErrorMessage?.(err); }
    });
  }
  function openLocalModal() {
    document.getElementById('local-f-name').value = '';
    document.getElementById('local-f-cmd').value = '';
    document.getElementById('local-f-desc').value = '';
    document.getElementById('local-f-tags').value = '';
    document.getElementById('local-modal').classList.remove('hidden');
  }

  // ─── AI 部署模态 ────────────────────────────────
  function bindDeployModal() {
    const $m = document.getElementById('deploy-modal');
    document.getElementById('deploy-modal-close').addEventListener('click', () => $m.classList.add('hidden'));
    document.getElementById('deploy-modal-cancel').addEventListener('click', () => $m.classList.add('hidden'));
    $m.addEventListener('click', (e) => { if (e.target === $m) $m.classList.add('hidden'); });
    document.getElementById('deploy-modal-go').addEventListener('click', startAiDeploy);
  }
  function openDeployModal() {
    document.getElementById('deploy-f-url').value = '';
    const $status = document.getElementById('deploy-status');
    $status.textContent = '';
    $status.classList.add('hidden');
    document.getElementById('deploy-modal').classList.remove('hidden');
  }
  async function startAiDeploy() {
    const url = document.getElementById('deploy-f-url').value.trim();
    if (!url) { showToast?.('请粘贴 GitHub 链接', 'error'); return; }
    const $status = document.getElementById('deploy-status');
    const $btn = document.getElementById('deploy-modal-go');
    $status.classList.remove('hidden');
    $status.textContent = '正在跳转到创作台，AI 将自动部署...\n';
    $btn.disabled = true;
    $btn.textContent = '部署中...';
    setTimeout(() => {
      window.location.href = `skill-studio.html?deploy_mcp=${encodeURIComponent(url)}`;
    }, 500);
  }

  init();
})();
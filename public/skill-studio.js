(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast, showErrorMessage } = window.appShared;
  const requestJson = createRequestJson({
    onUnauthorized: () => { window.location.href = 'index.html'; },
  });

  // ─── 状态 ─────────────────────────────────────────────────────────
  let hosts = [];
  let skillList = [];          // /api/skills — 可引用的 Skill（不含 skill-authoring 自身）
  let mcpList = [];            // /api/mcp-servers — 仓库里的 MCP
  let playbookList = [];       // /api/playbooks — refine 下拉可选的目标 Playbook

  const selectedHosts = new Map();      // id → host
  const selectedPaths = [];             // [{hostId, path}]
  const selectedContainers = new Map(); // `${hostId}::${name}` → {hostId, name, image}
  const selectedTools = new Set();      // `skill:<id>` 或 `mcp:<id>`

  let socket = null;
  let currentRunId = null;
  let pendingErrorContext = '';         // refine 模式下从 sessionStorage 读入的错误摘要
  let toolFilter = 'all';               // 'all' | 'skill' | 'mcp'

  // ─── DOM ──────────────────────────────────────────────────────────
  const $hostList  = document.getElementById('host-list');
  const $hostCount = document.getElementById('host-count');
  const $pathList  = document.getElementById('path-list');
  const $pathInput = document.getElementById('path-input');
  const $btnBrowsePath = document.getElementById('btn-browse-path');
  const $btnAddPath = document.getElementById('btn-add-path');
  const $containerScanList  = document.getElementById('container-scan-list');
  const $containerPinned    = document.getElementById('container-pinned');
  const $containerSelCount  = document.getElementById('container-selected-count');
  const $scanHostSelect     = document.getElementById('scan-host-select');
  const $btnRefreshContainers = document.getElementById('btn-refresh-containers');
  const $toolList  = document.getElementById('tool-list');
  const $toolCount = document.getElementById('tool-count');
  const $task       = document.getElementById('task-input');
  const $btnCreate  = document.getElementById('btn-create');
  const $btnStop    = document.getElementById('btn-stop');
  const $runStream  = document.getElementById('run-stream') || document.getElementById('chat-area');
  const $runStatus  = document.getElementById('run-status');
  const $summary    = document.getElementById('summary-chip');
  const $refineWrap = document.getElementById('refine-target-wrap');
  const $refineTarget = document.getElementById('refine-target');

  // ─── 对话 / 历史 DOM + 状态 ───────────────────────────────────────
  const $chatArea         = document.getElementById('chat-area');
  const $historyDrawer    = document.getElementById('history-drawer');
  const $btnToggleHistory = document.getElementById('btn-toggle-history');
  const $btnNewSession    = document.getElementById('btn-new-session');
  const $historyList      = document.getElementById('history-list');
  const $btnClearChat     = document.getElementById('btn-clear-chat');

  const HISTORY_KEY = '1shell.studio.sessions.v1';
  let sessions = [];            // [{id, title, createdAt, messages:[{role, kind?, content}]}]
  let currentSessionId = null;
  let currentAiTurnBody = null; // AI 气泡当前的正文容器（同一轮创作的所有 AI 行都塞进去）

  // ─── 模式切换 DOM + 状态 ─────────────────────────────────────────
  const $btnModeClassify  = document.getElementById('btn-mode-classify');
  const $btnModeSkill     = document.getElementById('btn-mode-skill');
  const $btnModeProgram   = document.getElementById('btn-mode-program');
  const $btnModeBundle    = document.getElementById('btn-mode-bundle');
  const $btnModePlaybook  = document.getElementById('btn-mode-playbook');
  const $btnModeImprove   = document.getElementById('btn-mode-improve');
  const $studioSubtitle    = document.getElementById('studio-subtitle');
  const $targetPlaybookCard = document.getElementById('target-playbook-card');
  const $targetPlaybookSel  = document.getElementById('target-playbook-select');
  const $improveTargetCard  = document.getElementById('improve-target-card');
  const $improveTargetList  = document.getElementById('improve-target-list');
  const $improveSearch      = document.getElementById('improve-search');
  const $programConfigCard  = document.getElementById('program-config-card');
  const $cronInput          = document.getElementById('cron-input');
  const $guardianSkillList  = document.getElementById('guardian-skill-list');
  let improveSelected = new Set(); // 已选中的 id
  let guardianSelected = new Set(); // 已选中的 rescue skill id

  let studioMode = 'classify'; // 'classify'|'create-skill'|'create-program'|'create-bundle'|'create-playbook'|'improve'
  let sessionCreatedSkillId = ''; // 本次会话第一轮创作出的产物 ID，后续追问用于 refine
  let pendingAskState = null; // { runId, toolUseId } — 等待 ask_user 回复时设置

  // ─── 初始化 ───────────────────────────────────────────────────────
  async function init() {
    initSocket();
    loadSessions();
    renderHistoryList();
    await Promise.all([loadContext(), loadSkills()]);
    bindEvents();
    renderHosts();
    renderPaths();
    renderContainerPinned();
    refreshScanHostSelect();
    setStudioMode('classify'); // 初始化 Tab 样式与文案
    applyUrlParams();
    updateSummary();
  }

  // 处理 URL 参数 ?mode=refine&target=<id>&withError=1
  // withError=1 时从 sessionStorage 读取 '1shell.studio.errorContext'
  function applyUrlParams() {
    const qs = new URLSearchParams(window.location.search);
    const mode = qs.get('mode');
    const target = qs.get('target');
    const withError = qs.get('withError') === '1';

    if (mode === 'refine' && target) {
      setStudioMode('improve');
      // pre-select the target in improveSelected
      improveSelected.add(target);
      renderImproveTargetOptions();
    }

    if (withError) {
      try {
        pendingErrorContext = sessionStorage.getItem('1shell.studio.errorContext') || '';
        sessionStorage.removeItem('1shell.studio.errorContext');
      } catch { pendingErrorContext = ''; }
      if (pendingErrorContext) {
        showErrorBanner(pendingErrorContext);
        // 自动触发 AI 修复，无需用户再次点击
        $task.value = '上次执行失败，请分析错误并修复。';
        // 等 refine target 下拉选中后再触发（最多等 600ms）
        const autoFix = (retry = 0) => {
          const targetReady = !target || Array.from($refineTarget.options).some(o => o.value === target && $refineTarget.value === target);
          if (targetReady || retry >= 6) {
            newSession(`修复: ${target || '未命名'}`);
            onSend();
          } else {
            setTimeout(() => autoFix(retry + 1), 100);
          }
        };
        setTimeout(() => autoFix(), 100);
      }
    }
  }

  function showErrorBanner(text) {
    let banner = document.getElementById('err-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'err-banner';
      banner.className = 'studio-input';
      banner.style.background = '#fef2f2';
      banner.style.borderColor = '#fecaca';
      banner.style.color = '#991b1b';
      banner.style.fontFamily = '"Cascadia Code",monospace';
      banner.style.whiteSpace = 'pre-wrap';
      banner.style.maxHeight = '120px';
      banner.style.overflow = 'auto';
      $task.parentElement.insertBefore(banner, $task);
    }
    banner.textContent = '上次执行错误摘要（refine 时会带给 AI）：\n\n' + text.slice(0, 1500);
  }

  async function loadContext() {
    try {
      const data = await requestJson('/api/skill-studio/context');
      hosts = data.hosts || [];
      refreshScanHostSelect();
    } catch (err) {
      showErrorMessage?.(err);
    }
  }

  async function loadSkills() {
    try {
      const [skillRes, pbRes, mcpRes] = await Promise.all([
        requestJson('/api/skills').catch(() => ({ skills: [] })),
        requestJson('/api/playbooks').catch(() => ({ playbooks: [] })),
        requestJson('/api/mcp-servers').catch(() => ({ servers: [] })),
      ]);
      skillList = (skillRes.skills || []).filter(s => s.id !== 'skill-authoring');
      playbookList = pbRes.playbooks || [];
      mcpList = mcpRes.servers || [];

      $refineTarget.innerHTML = '<option value="">-- 选择要修改的 Playbook --</option>' +
        playbookList.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`).join('');
      renderTargetPlaybookOptions();
      renderImproveTargetOptions();
      renderGuardianSkillList();
      renderTools();
    } catch {
      $refineTarget.innerHTML = '<option value="">加载失败</option>';
    }
  }

  function renderTargetPlaybookOptions() {
    if (!$targetPlaybookSel) return;
    if (playbookList.length === 0) {
      $targetPlaybookSel.innerHTML = '<option value="">（暂无 Playbook — 先在仓库创建一个）</option>';
      return;
    }
    $targetPlaybookSel.innerHTML = '<option value="">-- 选择要救援的 Playbook --</option>' +
      playbookList.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${escapeHtml(p.id)}</option>`).join('');
  }

  function renderImproveTargetOptions(filter = '') {
    if (!$improveTargetList) return;
    const fl = filter.toLowerCase();
    const all = [
      ...playbookList.map(p => ({ id: p.id, label: `[Playbook] ${p.name}`, kind: 'playbook' })),
      ...skillList.map(s => ({ id: s.id, label: `[Skill] ${s.name}`, kind: 'skill' })),
    ].filter(item => !fl || item.label.toLowerCase().includes(fl) || item.id.toLowerCase().includes(fl));

    if (all.length === 0) {
      $improveTargetList.innerHTML = '<div class="text-[11px] text-slate-400 px-1 py-2">无匹配项</div>';
      return;
    }
    $improveTargetList.innerHTML = all.map(item => `
      <label class="flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer hover:bg-amber-50 dark:hover:bg-amber-900/20 text-[11px] ${improveSelected.has(item.id) ? 'bg-amber-50 dark:bg-amber-900/20 font-semibold' : ''}">
        <input type="checkbox" class="improve-cb accent-amber-500" value="${escapeHtml(item.id)}" data-kind="${item.kind}" ${improveSelected.has(item.id) ? 'checked' : ''} />
        <span class="truncate text-slate-700 dark:text-slate-200">${escapeHtml(item.label)}</span>
      </label>
    `).join('');
    $improveTargetList.querySelectorAll('.improve-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) improveSelected.add(cb.value);
        else improveSelected.delete(cb.value);
        renderImproveTargetOptions(($improveSearch?.value || ''));
      });
    });
  }

  function renderGuardianSkillList() {
    if (!$guardianSkillList) return;
    const rescueSkills = skillList.filter(s => s.category === 'rescue' || (s.id || '').endsWith('-rescue'));
    if (rescueSkills.length === 0) {
      $guardianSkillList.innerHTML = '<div class="text-[10px] text-slate-400 px-1 py-1">暂无 Rescue Skill（先创作一个 Bundle）</div>';
      return;
    }
    $guardianSkillList.innerHTML = rescueSkills.map(s => `
      <label class="flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer hover:bg-green-50 dark:hover:bg-green-900/20 text-[10px] ${guardianSelected.has(s.id) ? 'bg-green-50 dark:bg-green-900/20 font-semibold' : ''}">
        <input type="checkbox" class="guardian-cb accent-green-500" value="${escapeHtml(s.id)}" ${guardianSelected.has(s.id) ? 'checked' : ''} />
        <span class="truncate text-slate-700 dark:text-slate-200">${escapeHtml(s.name || s.id)}</span>
      </label>
    `).join('');
    $guardianSkillList.querySelectorAll('.guardian-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) guardianSelected.add(cb.value);
        else guardianSelected.delete(cb.value);
        renderGuardianSkillList();
      });
    });
  }

  // ─── 模式切换 ─────────────────────────────────────────────────────
  function setStudioMode(mode) {
    const VALID = ['classify', 'create-skill', 'create-program', 'create-bundle', 'create-playbook', 'improve'];
    if (!VALID.includes(mode)) return;
    studioMode = mode;

    // Tab 按钮高亮
    const activeCls = ['bg-gradient-to-r', 'from-blue-500', 'to-purple-500', 'text-white'];
    const idleCls   = ['bg-slate-100', 'dark:bg-[#1e293b]', 'text-slate-500', 'dark:text-slate-300', 'hover:bg-slate-200', 'dark:hover:bg-[#2a3a4d]'];
    const btnMap = {
      'classify':        $btnModeClassify,
      'create-skill':    $btnModeSkill,
      'create-program':  $btnModeProgram,
      'create-bundle':   $btnModeBundle,
      'create-playbook': $btnModePlaybook,
      'improve':         $btnModeImprove,
    };
    for (const [m, btn] of Object.entries(btnMap)) {
      if (!btn) continue;
      btn.classList.remove(...activeCls, ...idleCls);
      btn.classList.add(...(m === mode ? activeCls : idleCls));
      btn.classList.toggle('active', m === mode);
    }

    // 左栏辅助卡片显隐
    if ($targetPlaybookCard) $targetPlaybookCard.classList.add('hidden');
    if ($improveTargetCard)  $improveTargetCard.classList.add('hidden');
    if ($programConfigCard)  $programConfigCard.classList.add('hidden');

    if (mode === 'improve')          $improveTargetCard?.classList.remove('hidden');
    if (mode === 'create-program' || mode === 'create-bundle')
                                      $programConfigCard?.classList.remove('hidden');

    // 副标题 / placeholder / CTA
    const subtitles = {
      'classify':        '描述你想要的功能 → AI 分析后推荐产物类型，确认后开始生成',
      'create-skill':    '创建用户主动触发的 AI 工具（交互型操作：删除、修改、查询等复杂场景）',
      'create-program':  '创建长驻后台守护程序 — cron 调度 + Guardian AI 自愈',
      'create-bundle':   '同时生成 Program + Rescue Skill — AI 监控 + 出问题自动诊断',
      'create-playbook': '创建一次性确定性剧本 — 步骤固定、零 token 执行',
      'improve':         '选要改进的 Skill / Playbook / Program · 用自然语言描述改进方向',
    };
    if ($studioSubtitle) $studioSubtitle.textContent = subtitles[mode] || '';

    const placeholders = {
      'classify':        '例如：每 5 分钟检查 Nginx 状态，挂了自动重启并告警…',
      'create-skill':    '例如：帮我做一个删除网站的 AI 工具，需要探测容器、确认后删除、重载 nginx…',
      'create-program':  '例如：每小时检查所有 VPS 磁盘占用，超 90% 时清理旧日志…',
      'create-bundle':   '例如：持续监控容器内存，超阈值时 AI 介入分析并重启异常容器…',
      'create-playbook': '例如：列出所有容器及其状态、端口映射，渲染成表格…',
      'improve':         '例如：把第 2 步改成并行执行 / 增加一个输出参数 / 修复刚才的 YAML 错误…',
    };
    if ($task) $task.placeholder = placeholders[mode] || '';

    const ctaLabels = {
      'classify':        '🤖 AI 推荐 →',
      'create-skill':    '创建 AI 工具 →',
      'create-program':  '生成 Program →',
      'create-bundle':   '生成 Bundle →',
      'create-playbook': '生成 Playbook →',
      'improve':         '开始改进 →',
    };
    if ($btnCreate) $btnCreate.textContent = ctaLabels[mode] || '开始 →';
  }

  function toolItems() {
    const items = [];
    for (const s of skillList) items.push({ kind: 'skill', id: s.id, name: s.name, icon: s.icon || '🔧', meta: truncate160(s.description) });
    for (const m of mcpList)  items.push({ kind: 'mcp',   id: m.id, name: m.name, icon: '🔌',        meta: truncate160(m.description || m.url) });
    return items;
  }
  function truncate160(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 60); }

  function renderTools() {
    if (!$toolList) return;
    const items = toolItems().filter(it => toolFilter === 'all' || it.kind === toolFilter);
    $toolCount.textContent = `${selectedTools.size} / ${toolItems().length}`;
    if (items.length === 0) {
      $toolList.innerHTML = `<div class="text-[11px] text-slate-400 text-center py-4">
        仓库里暂无${toolFilter === 'mcp' ? ' MCP Server' : toolFilter === 'skill' ? ' Skill' : '工具'}。<br/>
        点右上"↗ 管理"跳转仓库添加。
      </div>`;
      return;
    }
    $toolList.innerHTML = items.map(it => {
      const key = `${it.kind}:${it.id}`;
      const sel = selectedTools.has(key) ? 'selected' : '';
      const kindPill = it.kind === 'skill'
        ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">Skill</span>'
        : '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600">MCP</span>';
      return `<div class="item-row ${sel}" data-key="${escapeHtml(key)}">
        <span class="text-[14px]">${escapeHtml(it.icon)}</span>
        <span class="flex-1 truncate" title="${escapeHtml(it.meta || '')}">${escapeHtml(it.name)}</span>
        ${kindPill}
      </div>`;
    }).join('');
    $toolList.querySelectorAll('.item-row').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.key;
        if (selectedTools.has(k)) selectedTools.delete(k);
        else selectedTools.add(k);
        renderTools();
        updateSummary();
      });
    });
  }


  // ─── Socket ───────────────────────────────────────────────────────
  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('skill:run-started', (msg) => {
      if (msg.runId !== currentRunId) return;
      setStatus('running', `创作中 · ${msg.mode || 'ai-loop'}`);
      appendLine('info', `→ 运行开始`);
    });
    socket.on('skill:thinking', () => setStatus('running', '思考中...'));
    socket.on('skill:thought', (msg) => {
      if (msg.runId !== currentRunId || !msg.text) return;
      appendLine('thought', msg.text);
    });
    socket.on('skill:exec', (msg) => {
      if (msg.runId !== currentRunId) return;
      appendLine('info', `$ ${msg.command}`);
      // 从 AI 写文件的命令路径里提取本次创建的 skill/playbook id
      if (!sessionCreatedSkillId && msg.command) {
        const m = msg.command.match(/\/data\/(?:playbooks|skills)\/([a-z0-9][a-z0-9-]+)/);
        if (m) sessionCreatedSkillId = m[1];
      }
    });
    socket.on('skill:exec-result', (msg) => {
      if (msg.runId !== currentRunId) return;
      if (msg.stdout) appendLine('stdout', truncate(msg.stdout));
      if (msg.stderr) appendLine('stderr', truncate(msg.stderr));
      appendLine('info', `  exit=${msg.exitCode ?? '?'} · ${msg.durationMs ?? 0}ms`);
    });
    socket.on('skill:info', (msg) => {
      if (msg.runId !== currentRunId) return;
      appendLine('info', msg.message || '');
    });
    socket.on('skill:render', (msg) => {
      if (msg.runId !== currentRunId) return;
      const card = window.appShared.renderResultCard(msg.payload, {
        onRowAction: (_rowIndex, _action, _payload) => {
          // Studio 的 rowAction：暂不支持，提示用户去 Skills 页操作
          showToast?.('行操作请在「Skill 仓库」页执行', 'info');
        },
      });
      if (!currentAiTurnBody) renderAiTurn();
      currentAiTurnBody.appendChild(card);
      $chatArea.scrollTop = $chatArea.scrollHeight;
      saveMessageToCurrent({ role: 'ai', kind: 'render', content: JSON.stringify(msg.payload) });
    });
    socket.on('skill:done', (msg) => {
      if (msg.runId !== currentRunId) return;
      setStatus('done', '完成');
      appendLine('success', `✔ 完成 (${msg.turns ?? 0} 轮)`);
      finalize();
    });
    socket.on('skill:error', (msg) => {
      if (msg.runId !== currentRunId) return;
      setStatus('error', '出错');
      appendLine('error', `✘ ${msg.error || '未知错误'}`);
      finalize();
    });
    socket.on('skill:cancelled', () => {
      setStatus('cancelled', '已取消');
      appendLine('error', '已取消');
      finalize();
    });

    // AI 调用了 ask_user — 仅 confirm/select 用内联 UI；input 类型接管主文本框
    socket.on('skill:ask', (msg) => {
      if (msg.runId !== currentRunId) return;
      const payload = {
        runId:      msg.runId,
        toolUseId:  msg.toolUseId,
        type:       msg.payload?.type || 'input',
        question:   msg.payload?.question || msg.payload?.prompt || '请回复',
        options:    msg.payload?.options,
        placeholder: msg.payload?.placeholder,
        danger:     msg.payload?.danger,
      };
      if (payload.type === 'input') {
        // 直接用主文本框接管，不再弹内联 input
        pendingAskState = { runId: msg.runId, toolUseId: msg.toolUseId };
        appendLine('info', `🤖 ${payload.question}`);
        $task.placeholder = payload.placeholder || '在此输入回复，Enter 或点击发送…';
        $task.focus();
        $btnCreate.disabled = false;
        $btnCreate.textContent = '发送回复 →';
      } else {
        // confirm / select 仍用内联 UI
        renderAskUser(payload);
      }
    });
  }

  function truncate(s) {
    const t = String(s || '').trim();
    return t.length > 2000 ? t.slice(0, 2000) + '\n...[truncated]' : t;
  }

  // ─── 渲染：主机 ───────────────────────────────────────────────────
  function renderHosts() {
    const all = [{ id: 'local', name: '本机', host: '127.0.0.1' }, ...hosts.filter(h => h.id !== 'local')];
    $hostCount.textContent = `${selectedHosts.size}/${all.length}`;
    if (all.length === 0) {
      $hostList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-4">未配置主机</div>';
      return;
    }
    $hostList.innerHTML = all.map(h => {
      const sel = selectedHosts.has(h.id) ? 'selected' : '';
      const meta = h.id === 'local' ? '本地' : `${h.username || 'root'}@${h.host}`;
      return `<div class="item-row ${sel}" data-id="${escapeHtml(h.id)}">
        <span class="text-[14px]">${h.id === 'local' ? '🖥' : '☁'}</span>
        <span class="truncate">${escapeHtml(h.name)}</span>
        <span class="meta">${escapeHtml(meta)}</span>
      </div>`;
    }).join('');
    $hostList.querySelectorAll('.item-row').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (selectedHosts.has(id)) selectedHosts.delete(id);
        else {
          const h = all.find(x => x.id === id);
          if (h) selectedHosts.set(id, h);
        }
        renderHosts();
        updateSummary();
      });
    });
  }

  // ─── 渲染：路径 ───────────────────────────────────────────────────
  function renderPaths() {
    if (selectedPaths.length === 0) {
      $pathList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-4">暂未添加路径</div>';
      return;
    }
    $pathList.innerHTML = selectedPaths.map((p, i) => `
      <div class="item-row selected" data-i="${i}">
        <span class="text-[13px]">📁</span>
        <span class="truncate font-mono text-[11px]">${escapeHtml(p.path)}</span>
        <span class="meta">${escapeHtml(hostName(p.hostId))}</span>
        <span class="text-red-500 cursor-pointer px-1" data-del="${i}">✕</span>
      </div>
    `).join('');
    $pathList.querySelectorAll('[data-del]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedPaths.splice(+el.dataset.del, 1);
        renderPaths();
        updateSummary();
      });
    });
  }

  function hostName(hostId) {
    if (hostId === 'local') return '本机';
    const h = hosts.find(x => x.id === hostId);
    return h ? h.name : hostId;
  }

  function addPath() {
    const p = $pathInput.value.trim();
    if (!p) return;
    if (selectedHosts.size === 0) {
      showToast?.('请先在左上角选中至少一台主机', 'error');
      return;
    }
    // 附加到每台已选主机（若只选了一台就只加一条）
    for (const h of selectedHosts.values()) {
      selectedPaths.push({ hostId: h.id, path: p });
    }
    $pathInput.value = '';
    renderPaths();
    updateSummary();
  }

  // ─── 渲染：容器 ───────────────────────────────────────────────────
  // 渲染"已选摘要"固定区（始终可见，可单项取消）
  function renderContainerPinned() {
    const count = selectedContainers.size;
    if (count === 0) {
      $containerPinned.classList.add('hidden');
      $containerSelCount.classList.add('hidden');
      return;
    }
    $containerPinned.classList.remove('hidden');
    $containerSelCount.classList.remove('hidden');
    $containerSelCount.textContent = `已选 ${count}`;
    $containerPinned.innerHTML = [...selectedContainers.values()].map(c => `
      <div class="item-row selected" style="padding:5px 8px;">
        <span class="text-[12px]">🐳</span>
        <span class="truncate text-[11px]">${escapeHtml(c.name)}</span>
        <span class="meta">${escapeHtml(hostName(c.hostId))}</span>
        <span class="text-red-400 hover:text-red-600 cursor-pointer px-1 ml-auto shrink-0"
              data-unpin="${escapeHtml(c.hostId + '::' + c.name)}" title="取消选择">✕</span>
      </div>
    `).join('');
    $containerPinned.querySelectorAll('[data-unpin]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedContainers.delete(el.dataset.unpin);
        renderContainerPinned();
        // 同步更新扫描列表里的选中状态
        const row = $containerScanList.querySelector(`[data-key="${CSS.escape(el.dataset.unpin)}"]`);
        if (row) row.classList.remove('selected');
        updateSummary();
      });
    });
  }

  // 渲染扫描结果列表
  function renderContainerScanList(items, hostId) {
    if (!items) {
      $containerScanList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-4">在头部下拉选主机，点"↻ 扫描"</div>';
      return;
    }
    if (items.length === 0) {
      $containerScanList.innerHTML = `<div class="text-[11px] text-slate-400 text-center py-4">${escapeHtml(hostName(hostId))} 上没有容器</div>`;
      return;
    }
    $containerScanList.innerHTML = items.map(c => {
      const key = `${hostId}::${c.name}`;
      const sel = selectedContainers.has(key) ? 'selected' : '';
      const running = (c.status || '').toLowerCase().startsWith('up');
      const statusDot = running
        ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 inline-block"></span>'
        : '<span class="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0 inline-block"></span>';
      return `<div class="item-row ${sel}" data-key="${escapeHtml(key)}"
                   data-name="${escapeHtml(c.name)}" data-image="${escapeHtml(c.image)}" data-hostid="${escapeHtml(hostId)}">
        <span class="text-[13px]">🐳</span>
        <span class="flex-1 truncate">${escapeHtml(c.name)}</span>
        ${statusDot}
        <span class="meta">${escapeHtml((c.image || '').split(':')[0] || c.image)}</span>
      </div>`;
    }).join('');
    $containerScanList.querySelectorAll('.item-row').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        if (selectedContainers.has(key)) {
          selectedContainers.delete(key);
          el.classList.remove('selected');
        } else {
          selectedContainers.set(key, {
            hostId: el.dataset.hostid,
            name: el.dataset.name,
            image: el.dataset.image,
          });
          el.classList.add('selected');
        }
        renderContainerPinned();
        updateSummary();
      });
    });
  }

  // 更新扫描主机下拉（随 selectedHosts 变化而更新，也允许独立选择任何已知主机）
  function refreshScanHostSelect() {
    const allHosts = [{ id: 'local', name: '本机' }, ...hosts.filter(h => h.id !== 'local')];
    const current = $scanHostSelect.value;
    $scanHostSelect.innerHTML = allHosts.map(h =>
      `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`
    ).join('');
    // 保持上次选中；若上次选中的主机仍存在则还原
    if (current && allHosts.find(h => h.id === current)) {
      $scanHostSelect.value = current;
    }
  }

  async function scanContainers() {
    const hostId = $scanHostSelect.value || 'local';
    const btn = $btnRefreshContainers;
    const origText = btn.textContent;
    btn.textContent = '扫描中…';
    btn.disabled = true;

    $containerScanList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-4">扫描中…</div>';

    // 超时策略：先用 10s 快速尝试；若超时则展示提示并提供重试
    // 命令使用 timeout 包裹避免 docker 挂死；2>/dev/null || true 保证非 docker 主机静默
    const cmd = 'timeout 8 docker ps -a --format "{{.Names}}|{{.Image}}|{{.Status}}" 2>/dev/null || echo "__docker_unavailable__"';

    const tryExec = async () => {
      const res = await requestJson('/api/exec', {
        method: 'POST',
        body: JSON.stringify({ hostId, command: cmd, timeout: 12000 }),
      });
      return res;
    };

    let res;
    try {
      res = await tryExec();
    } catch (err) {
      // 第一次失败：等 800ms 自动重试一次
      await new Promise(r => setTimeout(r, 800));
      try {
        res = await tryExec();
      } catch (err2) {
        $containerScanList.innerHTML = `
          <div class="text-[11px] text-red-400 text-center py-4 flex flex-col gap-2">
            <span>扫描失败：${escapeHtml(err2.message.slice(0, 80))}</span>
            <button id="btn-retry-scan" class="text-blue-500 underline">点此重试</button>
          </div>`;
        const retryBtn = document.getElementById('btn-retry-scan');
        retryBtn?.addEventListener('click', scanContainers);
        btn.textContent = origText;
        btn.disabled = false;
        return;
      }
    }

    btn.textContent = origText;
    btn.disabled = false;

    const out = String(res.stdout || '').trim();
    if (!out || out === '__docker_unavailable__') {
      $containerScanList.innerHTML = `<div class="text-[11px] text-slate-400 text-center py-4">${escapeHtml(hostName(hostId))} 上未检测到 Docker</div>`;
      return;
    }

    const items = out.split('\n').map(line => {
      const [name, image, ...rest] = line.split('|');
      return { name: (name || '').trim(), image: (image || '').trim(), status: rest.join('|').trim() };
    }).filter(x => x.name && x.name !== '__docker_unavailable__');

    renderContainerScanList(items, hostId);
  }

  // ─── 事件 ─────────────────────────────────────────────────────────
  function bindEvents() {
    $btnAddPath.addEventListener('click', addPath);
    $btnBrowsePath.addEventListener('click', openFilePicker);
    $pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPath(); });

    $btnRefreshContainers.addEventListener('click', scanContainers);

    // 工具过滤按钮
    const $filterAll   = document.getElementById('tool-filter-all');
    const $filterSkill = document.getElementById('tool-filter-skill');
    const $filterMcp   = document.getElementById('tool-filter-mcp');
    if ($filterAll)   $filterAll.addEventListener('click',   () => { toolFilter = 'all';   renderTools(); });
    if ($filterSkill) $filterSkill.addEventListener('click', () => { toolFilter = 'skill'; renderTools(); });
    if ($filterMcp)   $filterMcp.addEventListener('click',   () => { toolFilter = 'mcp';   renderTools(); });

    document.querySelectorAll('input[name="studio-mode"]').forEach(r =>
      r.addEventListener('change', () => {
        const mode = document.querySelector('input[name="studio-mode"]:checked')?.value;
        if (mode) setStudioMode(mode === 'refine' ? 'improve' : mode);
      })
    );

    $btnCreate.addEventListener('click', onSend);
    $task.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && pendingAskState) { e.preventDefault(); onSend(); } });
    $btnStop.addEventListener('click', onStop);

    // 模式 Tab
    $btnModeClassify?.addEventListener('click',  () => setStudioMode('classify'));
    $btnModeSkill?.addEventListener('click',     () => setStudioMode('create-skill'));
    $btnModeProgram?.addEventListener('click',   () => setStudioMode('create-program'));
    $btnModeBundle?.addEventListener('click',    () => setStudioMode('create-bundle'));
    $btnModePlaybook?.addEventListener('click',  () => setStudioMode('create-playbook'));
    $btnModeImprove?.addEventListener('click',   () => setStudioMode('improve'));
    $improveSearch?.addEventListener('input', () => renderImproveTargetOptions($improveSearch.value));

    // 历史抽屉 + 新建 + 清空
    $btnToggleHistory?.addEventListener('click', toggleHistoryDrawer);
    $btnNewSession?.addEventListener('click', startNewChat);
    $btnClearChat?.addEventListener('click', () => {
      const s = getSession(currentSessionId);
      if (!s) return;
      if (!window.confirm('清空当前对话的消息？')) return;
      s.messages = [];
      saveSessions();
      currentAiTurnBody = null;
      showEmptyState();
      $btnClearChat.classList.add('hidden');
      renderHistoryList();
    });

    bindFilePicker();
  }

  // ─── 文件浏览器 ────────────────────────────────────────────────────
  const $fpModal = document.getElementById('fp-modal');
  const $fpHostSelect = document.getElementById('fp-host-select');
  const $fpPathCrumb = document.getElementById('fp-path-breadcrumb');
  const $fpPathInput = document.getElementById('fp-path-input');
  const $fpList = document.getElementById('fp-list');
  const $fpUp = document.getElementById('fp-up');
  const $fpClose = document.getElementById('fp-close');
  const $fpDone = document.getElementById('fp-done');

  let fpCurrentHostId = 'local';
  let fpCurrentPath = '';
  let fpParentPath = null;

  function openFilePicker() {
    if (!$fpModal) return;
    // 填充主机下拉：选中的主机优先；否则全部可选
    const pool = selectedHosts.size > 0
      ? [...selectedHosts.values()]
      : [{ id: 'local', name: '本机' }, ...hosts.filter(h => h.id !== 'local')];
    $fpHostSelect.innerHTML = pool.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`).join('');
    fpCurrentHostId = pool[0]?.id || 'local';
    fpCurrentPath = '';
    $fpModal.classList.remove('hidden');
    loadFpDir('');
  }

  function closeFilePicker() {
    $fpModal.classList.add('hidden');
  }

  async function loadFpDir(dirPath) {
    $fpList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-10">加载中...</div>';
    try {
      const url = `/api/files/list?hostId=${encodeURIComponent(fpCurrentHostId)}&path=${encodeURIComponent(dirPath || '')}`;
      const data = await requestJson(url);
      fpCurrentPath = data.path || dirPath || '';
      fpParentPath = data.parent || null;
      $fpPathCrumb.textContent = fpCurrentPath || '/';
      $fpPathInput.value = fpCurrentPath;
      renderFpList(data.items || []);
    } catch (err) {
      $fpList.innerHTML = `<div class="text-[11px] text-red-500 text-center py-10">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderFpList(items) {
    if (items.length === 0) {
      $fpList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-10">(空目录)</div>';
      return;
    }
    $fpList.innerHTML = items.map(it => {
      const icon = it.isDir ? '📁' : '📄';
      const size = it.isDir ? '' : humanSize(it.size);
      return `<div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-[#1e293b]">
        <span>${icon}</span>
        <span class="flex-1 truncate fp-name cursor-pointer font-mono" data-path="${escapeHtml(it.path)}" data-dir="${it.isDir ? '1' : '0'}">${escapeHtml(it.name)}</span>
        <span class="text-[10px] text-slate-400 w-20 text-right">${size}</span>
        <button class="fp-pick text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 px-2 rounded" data-path="${escapeHtml(it.path)}" title="加入已选">➕</button>
      </div>`;
    }).join('');
    $fpList.querySelectorAll('.fp-name').forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.dir === '1') loadFpDir(el.dataset.path);
      });
    });
    $fpList.querySelectorAll('.fp-pick').forEach(el => {
      el.addEventListener('click', () => {
        const p = el.dataset.path;
        // 主机策略：当前浏览器里选的 host 作为挂载 host
        if (!selectedPaths.find(x => x.hostId === fpCurrentHostId && x.path === p)) {
          selectedPaths.push({ hostId: fpCurrentHostId, path: p });
          renderPaths();
          updateSummary();
        }
        el.textContent = '✓';
        el.classList.remove('text-blue-500');
        el.classList.add('text-emerald-500');
        setTimeout(() => {
          el.textContent = '➕';
          el.classList.add('text-blue-500');
          el.classList.remove('text-emerald-500');
        }, 800);
      });
    });
  }

  function humanSize(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + 'B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'M';
    return (b / 1024 / 1024 / 1024).toFixed(1) + 'G';
  }

  function bindFilePicker() {
    if (!$fpModal) return;
    $fpClose.addEventListener('click', closeFilePicker);
    $fpDone.addEventListener('click', closeFilePicker);
    $fpUp.addEventListener('click', () => {
      if (fpParentPath !== null && fpParentPath !== undefined) loadFpDir(fpParentPath);
    });
    $fpHostSelect.addEventListener('change', () => {
      fpCurrentHostId = $fpHostSelect.value;
      loadFpDir('');
    });
    $fpPathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadFpDir($fpPathInput.value.trim());
    });
    // 点模态外层背景关闭
    $fpModal.addEventListener('click', (e) => {
      if (e.target === $fpModal) closeFilePicker();
    });
  }

  function updateSummary() {
    $summary.textContent = `主机: ${selectedHosts.size} · 路径: ${selectedPaths.length} · 容器: ${selectedContainers.size} · 工具: ${selectedTools.size}`;
  }

  async function onSend() {
    // 如果 AI 正在等待 ask_user(input) 回复，走 skill:continue 通道
    if (pendingAskState) {
      const value = $task.value.trim();
      const { runId, toolUseId } = pendingAskState;
      pendingAskState = null;
      $task.value = '';
      $task.placeholder = '继续描述…';
      $btnCreate.disabled = true;
      $btnCreate.textContent = '开始创作 →';
      if (value) appendUserMessage(value);
      socket.emit('skill:continue', { runId, toolUseId, answer: value || null });
      return;
    }
    return onCreate();
  }

  async function onCreate() {
    const task = $task.value.trim();
    if (!task) { showToast?.('请输入自然语言描述', 'error'); return; }

    // 根据 Tab 决定 mode 和目标 id
    let mode;
    let targetSkillId = '';
    let targetPlaybookId = '';

    if (studioMode === 'improve') {
      if (improveSelected.size === 0) {
        showToast?.('请在左栏勾选要改进的 Playbook、Skill 或 Program', 'error');
        return;
      }
      targetSkillId = [...improveSelected].join(',');
      mode = 'refine';
    } else {
      // classify / create-skill / create-program / create-bundle / create-playbook
      mode = studioMode;
    }

    // 追问检测：当前会话已有消息 + 已知本次创作的目标 ID → 自动切 refine
    const currentSession = getSession(currentSessionId);
    const prevUserMessages = (currentSession?.messages || []).filter(m => m.role === 'user');
    const isFollowUp = prevUserMessages.length > 0 && sessionCreatedSkillId &&
      ['classify', 'create-skill', 'create-program', 'create-bundle', 'create-playbook'].includes(studioMode);
    if (isFollowUp) {
      mode = 'refine';
      targetSkillId = sessionCreatedSkillId;
    }

    // 1) 用户气泡 + 清空输入框（立即反馈）
    appendUserMessage(task);
    $task.value = '';

    // 从 selectedTools Set 中分离出 Skill 引用和 MCP 引用
    const referencedSkills = [...selectedTools]
      .filter(k => k.startsWith('skill:'))
      .map(k => k.slice(6));
    const mcpServersPayload = [...selectedTools]
      .filter(k => k.startsWith('mcp:'))
      .map(k => ({ id: k.slice(4) })); // 后端 compose 路由会按 id 从 registry 展开

    // 追问时将之前的用户消息拼进 task，让 AI 知道对话上下文
    let effectiveTask = task;
    if (isFollowUp && prevUserMessages.length > 0) {
      const historyLines = ['# 对话背景（本次是在已有产物基础上的追问/修改）'];
      historyLines.push(`已创作的产物 ID: \`${sessionCreatedSkillId}\``);
      historyLines.push('\n之前的用户指令（按时间顺序）：');
      prevUserMessages.forEach((m, i) => historyLines.push(`${i + 1}. ${m.content}`));
      historyLines.push('\n用户的新指令：' + task);
      effectiveTask = historyLines.join('\n');
    }

    const payload = {
      mode,
      targetSkillId: targetSkillId || undefined,
      targetPlaybookId: targetPlaybookId || undefined,
      task: effectiveTask,
      hosts: [...selectedHosts.values()].map(h => ({ id: h.id, name: h.name })),
      containers: [...selectedContainers.values()],
      files: selectedPaths.map(p => ({ hostId: p.hostId, path: p.path })),
      mcpServers: mcpServersPayload,
      referencedSkills,
      errorContext: pendingErrorContext || '',
      cronSchedule: ($cronInput?.value || '').trim() || undefined,
      guardianSkills: guardianSelected.size > 0 ? [...guardianSelected] : undefined,
    };

    let composed;
    try {
      composed = await requestJson('/api/skill-studio/compose', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      showErrorMessage?.(err);
      appendLine('error', `✘ 组装请求失败：${err.message || err}`);
      return;
    }

    // 2) 开启一个新的 AI 气泡，后续 socket 事件都会塞进去
    renderAiTurn();
    currentRunId = 'studio-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    setStatus('starting', '启动中...');
    $btnCreate.disabled = true;
    $btnStop.classList.remove('hidden');

    // skill-authoring 的 inputs.skill_id：
    //   - refine 模式：要修改的 Playbook id
    //   - create-rescue-skill 模式：建议的新 Rescue Skill id（可空，让 AI 自起名）
    //   - generate 模式：空
    let skillIdInput = '';
    if (mode === 'refine') skillIdInput = targetSkillId;
    else if (mode === 'create-rescue-skill') skillIdInput = targetSkillId || '';

    // 根据 mode 决定运行哪个 Skill
    // create-program / create-bundle → program-authoring（有硬约束 rules/）
    // 其他 → skill-authoring
    const SKILL_ID_MAP = {
      'create-program': 'program-authoring',
      'create-bundle':  'program-authoring',
    };
    const runSkillId = SKILL_ID_MAP[mode] || 'skill-authoring';

    socket.emit('skill:run', {
      runId: currentRunId,
      skillId: runSkillId,
      hostId: 'local',
      inputs: {
        mode,
        task: composed.composedTask,
        skill_id: skillIdInput,
      },
    }, (ack) => {
      if (!ack?.ok) {
        setStatus('error', '启动失败');
        appendLine('error', ack?.error || 'skill:run 被拒绝');
        finalize();
      }
    });
  }

  function onStop() {
    if (!currentRunId) return;
    socket.emit('skill:stop', { runId: currentRunId });
  }

  function finalize() {
    pendingAskState = null;
    $btnCreate.disabled = false;
    $btnCreate.textContent = studioMode === 'rescue-skill' ? '生成 Rescue Skill →' : '开始创作 →';
    $task.placeholder = '描述你想要的…';
    $btnStop.classList.add('hidden');
    currentAiTurnBody = null;
    // 把检测到的创作 ID 持久化到会话，切换回来时能继续追问
    if (sessionCreatedSkillId && currentSessionId) {
      const s = getSession(currentSessionId);
      if (s) { s.createdSkillId = sessionCreatedSkillId; saveSessions(); }
    }
    // 主动触发后端 reload，确保新创建的 Playbook 立即出现在剧本库
    requestJson('/api/playbooks/reload', { method: 'POST' }).catch(() => {});
    loadSkills();
  }

  function setStatus(kind, text) {
    $runStatus.textContent = text;
    $runStatus.className = 'text-[10px] font-normal normal-case ' + ({
      running: 'text-blue-500',
      starting: 'text-blue-400',
      done: 'text-emerald-500',
      error: 'text-red-500',
      cancelled: 'text-amber-500',
    }[kind] || 'text-slate-400');
  }

  // ─── AI 问答内联 UI ─────────────────────────────────────────────
  function renderAskUser(msg) {
    const isDark = document.documentElement.classList.contains('dark');
    const wrap = document.createElement('div');
    wrap.className = 'ask-card-studio';

    const q = document.createElement('div');
    q.className = 'ask-card-studio-question';
    q.textContent = '🤖 ' + (msg.question || '请回复');
    wrap.appendChild(q);

    const submit = (value) => {
      socket.emit('skill:continue', { runId: msg.runId, toolUseId: msg.toolUseId, answer: value });
      wrap.style.opacity = '0.5';
      wrap.style.pointerEvents = 'none';
      appendLine('info', `✓ 已回复：${String(value).slice(0, 80)}`);
    };

    if (msg.type === 'confirm') {
      const row = document.createElement('div');
      row.className = 'ask-card-studio-row';
      const yes = document.createElement('button');
      yes.textContent = '✓ 确认';
      yes.className = msg.danger ? 'ask-btn ask-btn-danger' : 'ask-btn ask-btn-primary';
      yes.addEventListener('click', () => submit('yes'));
      const no = document.createElement('button');
      no.textContent = '✕ 取消';
      no.className = 'ask-btn ask-btn-cancel';
      no.addEventListener('click', () => submit('no'));
      row.appendChild(yes);
      row.appendChild(no);
      wrap.appendChild(row);

    } else if (msg.type === 'select' && Array.isArray(msg.options)) {
      const row = document.createElement('div');
      row.className = 'ask-card-studio-options';
      for (const opt of msg.options) {
        const btn = document.createElement('button');
        btn.textContent = typeof opt === 'object' ? (opt.label || opt.value) : opt;
        btn.className = 'ask-option-btn';
        if (opt.description) {
          const desc = document.createElement('div');
          desc.className = 'ask-option-desc';
          desc.textContent = opt.description;
          btn.appendChild(desc);
        }
        btn.addEventListener('click', () => submit(typeof opt === 'object' ? opt.value : opt));
        row.appendChild(btn);
      }
      wrap.appendChild(row);

    } else {
      // input
      const row = document.createElement('div');
      row.className = 'ask-card-studio-row';
      const inp = document.createElement('input');
      inp.placeholder = msg.placeholder || '请输入…';
      inp.className = 'ask-input';
      const btn = document.createElement('button');
      btn.textContent = '提交';
      btn.className = 'ask-btn ask-btn-primary';
      btn.addEventListener('click', () => { if (inp.value.trim()) submit(inp.value.trim()); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) submit(inp.value.trim()); });
      row.appendChild(inp);
      row.appendChild(btn);
      wrap.appendChild(row);
      setTimeout(() => inp.focus(), 50);
    }

    if (!currentAiTurnBody) renderAiTurn();
    currentAiTurnBody.appendChild(wrap);
    $chatArea.scrollTop = $chatArea.scrollHeight;
    setStatus('running', '等待你的回复…');
  }
  function loadSessions() {
    try { sessions = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { sessions = []; }
  }
  function saveSessions() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.slice(0, 50))); }
    catch {}
  }
  function getSession(id) { return sessions.find(s => s.id === id) || null; }
  function newSession(title) {
    const id = 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const s = { id, title: (title || '未命名').slice(0, 60), createdAt: Date.now(), messages: [] };
    sessions.unshift(s);
    currentSessionId = id;
    saveSessions();
    renderHistoryList();
    return s;
  }
  function saveMessageToCurrent(msg) {
    const s = getSession(currentSessionId);
    if (!s) return;
    s.messages.push(msg);
    // 更新 session 标题：如果还是默认，用第一条用户消息填
    if (msg.role === 'user' && (!s.title || s.title === '未命名') && s.messages.filter(m => m.role === 'user').length === 1) {
      s.title = msg.content.slice(0, 40);
    }
    saveSessions();
  }
  function renderHistoryList() {
    if (!$historyList) return;
    if (sessions.length === 0) {
      $historyList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-10">暂无历史</div>';
      return;
    }
    const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    $historyList.innerHTML = sessions.map(s => `
      <div class="history-item ${s.id === currentSessionId ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
        <div class="hi-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title || '(无标题)')}</div>
        <div class="hi-meta flex items-center gap-1">
          <span>${fmt(s.createdAt)}</span>
          <span class="flex-1"></span>
          <span class="text-red-400 hover:text-red-600 cursor-pointer px-1" data-del="${escapeHtml(s.id)}" title="删除">✕</span>
        </div>
      </div>
    `).join('');
    $historyList.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        switchSession(el.dataset.id);
      });
    });
    $historyList.querySelectorAll('[data-del]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.del;
        sessions = sessions.filter(s => s.id !== id);
        if (currentSessionId === id) startNewChat();
        saveSessions();
        renderHistoryList();
      });
    });
  }
  function toggleHistoryDrawer() {
    if (!$historyDrawer) return;
    const cur = $historyDrawer.style.width;
    const open = cur && cur !== '0' && cur !== '0px';
    $historyDrawer.style.width = open ? '0' : '220px';
  }
  function switchSession(id) {
    const s = getSession(id);
    if (!s) return;
    currentSessionId = id;
    currentAiTurnBody = null;
    sessionCreatedSkillId = s.createdSkillId || ''; // 恢复该会话追踪的 ID
    $chatArea.innerHTML = '';
    for (const m of s.messages) {
      if (m.role === 'user') {
        currentAiTurnBody = null;
        renderUserBubble(m.content);
      } else if (m.role === 'ai') {
        renderAiLine(m.kind || 'info', m.content);
      }
    }
    if (s.messages.length === 0) showEmptyState();
    renderHistoryList();
    if ($btnClearChat) $btnClearChat.classList.toggle('hidden', s.messages.length === 0);
  }
  function startNewChat() {
    currentSessionId = null;
    currentAiTurnBody = null;
    sessionCreatedSkillId = '';
    showEmptyState();
    renderHistoryList();
    if ($btnClearChat) $btnClearChat.classList.add('hidden');
  }
  function showEmptyState() {
    if (!$chatArea) return;
    $chatArea.innerHTML = `
      <div id="chat-placeholder" class="text-[11px] text-slate-400 text-center py-10 flex flex-col items-center gap-2">
        <span class="text-3xl">✍️</span>
        <span>在下方输入框描述你想要的 Playbook<br/>AI 会逐步生成，支持后续对话修改</span>
      </div>
    `;
  }
  function hidePlaceholder() {
    const ph = document.getElementById('chat-placeholder');
    if (ph) ph.remove();
  }
  function renderUserBubble(text) {
    hidePlaceholder();
    const div = document.createElement('div');
    div.className = 'chat-bubble-user';
    div.textContent = text;
    $chatArea.appendChild(div);
    $chatArea.scrollTop = $chatArea.scrollHeight;
  }
  function renderAiTurn() {
    hidePlaceholder();
    const wrap = document.createElement('div');
    wrap.className = 'chat-turn-ai';
    wrap.innerHTML = `<div class="turn-header"><span>🤖</span><span>AI</span></div><div class="turn-body"></div>`;
    $chatArea.appendChild(wrap);
    currentAiTurnBody = wrap.querySelector('.turn-body');
    $chatArea.scrollTop = $chatArea.scrollHeight;
  }
  function renderAiLine(kind, text) {
    if (!currentAiTurnBody) renderAiTurn();
    const line = document.createElement('div');
    line.className = 'run-line ' + kind;
    line.textContent = text;
    currentAiTurnBody.appendChild(line);
    $chatArea.scrollTop = $chatArea.scrollHeight;
  }
  function appendUserMessage(text) {
    if (!currentSessionId) newSession(text.slice(0, 40));
    renderUserBubble(text);
    saveMessageToCurrent({ role: 'user', content: text });
    if ($btnClearChat) $btnClearChat.classList.remove('hidden');
  }

  function appendLine(kind, text) {
    renderAiLine(kind, text);
    saveMessageToCurrent({ role: 'ai', kind, content: text });
  }

  (() => {})(); // 占位，保持下方 init() 调用点不变

  init();
})();
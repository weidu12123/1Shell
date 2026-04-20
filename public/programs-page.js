(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast, showErrorMessage } = window.appShared;
  const requestJson = createRequestJson({
    onUnauthorized: () => { window.location.href = 'index.html'; },
  });

  // ─── 状态 ───────────────────────────────────────────────────────────
  let programs = [];
  let hosts = [];
  let activeProgramId = null;
  let currentTab = 'instances';
  const socket = io({ transports: ['websocket', 'polling'] });

  // 活跃 run 集合：runId → { programId, hostId, startedAt }
  const activeRuns = new Map();
  // 活跃 Guardian session：sessionId → { programId, hostId, runId }
  const guardianSessions = new Map();
  // 当前弹窗的 ask：{ sessionId, toolUseId, payload }
  let currentAsk = null;

  // ─── DOM ────────────────────────────────────────────────────────────
  const $list = document.getElementById('programs-list');
  const $count = document.getElementById('programs-count');
  const $detailEmpty = document.getElementById('detail-empty');
  const $detailBody = document.getElementById('detail-body');
  const $detailName = document.getElementById('detail-name');
  const $detailDesc = document.getElementById('detail-desc');
  const $detailTriggers = document.getElementById('detail-triggers');
  const $detailEnabled = document.getElementById('detail-enabled-badge');
  const $instancesBody = document.getElementById('instances-body');
  const $runsBody = document.getElementById('runs-body');
  const $eventsStream    = document.getElementById('events-stream');
  const $guardianStream  = document.getElementById('guardian-stream');
  const $resultsStream   = document.getElementById('results-stream');
  const $resultsEmpty    = document.getElementById('results-empty');
  const $resultsHostLabel = document.getElementById('results-host-label');
  const $askModal = document.getElementById('guardian-ask-modal');
  const $askIcon = document.getElementById('guardian-ask-icon');
  const $askTitle = document.getElementById('guardian-ask-title');
  const $askSubtitle = document.getElementById('guardian-ask-subtitle');
  const $askDesc = document.getElementById('guardian-ask-desc');
  const $askBody = document.getElementById('guardian-ask-body');
  const $askConfirm = document.getElementById('guardian-ask-confirm');
  const $askCancel = document.getElementById('guardian-ask-cancel');
  const $statPrograms = document.getElementById('stat-programs');
  const $statEnabled = document.getElementById('stat-enabled');
  const $statActive = document.getElementById('stat-active');
  const $statFailed = document.getElementById('stat-failed');

  // ─── 初始化 ─────────────────────────────────────────────────────────
  async function init() {
    bindEvents();
    bindSocket();
    bindAskModal();
    await Promise.all([loadPrograms(), loadHosts()]);
    await loadActiveRuns();
    renderList();
    updateStats();
  }

  function bindEvents() {
    document.getElementById('btn-reload').addEventListener('click', async () => {
      try {
        await requestJson('/api/programs/reload', { method: 'POST' });
        showToast('已重扫 data/programs/', 'success');
        await loadPrograms();
        renderList();
        if (activeProgramId) selectProgram(activeProgramId);
        updateStats();
      } catch (err) { showErrorMessage(err); }
    });
    document.getElementById('btn-refresh').addEventListener('click', async () => {
      await loadPrograms();
      renderList();
      if (activeProgramId) {
        await refreshDetail();
      }
      await loadActiveRuns();
      updateStats();
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function bindSocket() {
    socket.on('program:run-started', (msg) => {
      activeRuns.set(msg.runId, { programId: msg.programId, hostId: msg.hostId, startedAt: Date.now() });
      pushEvent({ runId: msg.runId, type: 'run-started', ...msg });
      updateStats();
      if (msg.programId === activeProgramId) {
        clearResults(msg.hostId);  // 新 run 开始时清空结果
        if (currentTab === 'instances') refreshInstances();
      }
    });
    socket.on('program:render', (msg) => {
      if (msg.programId !== activeProgramId) return;
      pushResult(msg);
      // 有结果时自动切换到结果 Tab（仅当用户在实例/事件 tab 时）
      if (currentTab === 'events' || currentTab === 'instances') switchTab('results');
    });
    socket.on('program:step-started', (msg) => {
      pushEvent({ runId: msg.runId, type: 'step-started', ...msg });
    });
    socket.on('program:step-ended', (msg) => {
      pushEvent({ runId: msg.runId, type: 'step-ended', ...msg });
    });
    socket.on('program:run-ended', (msg) => {
      activeRuns.delete(msg.runId);
      pushEvent({ runId: msg.runId, type: 'run-ended', ...msg });
      updateStats();
      if (msg.programId === activeProgramId) {
        if (currentTab === 'instances') refreshInstances();
        if (currentTab === 'runs') refreshRuns();
      }
    });

    // ─── Guardian 事件 ──────────────────────────────────────────
    socket.on('guardian:session-started', (msg) => {
      guardianSessions.set(msg.sessionId, { programId: msg.programId, hostId: msg.hostId, runId: msg.runId });
      pushGuardian({
        type: 'session-started', sessionId: msg.sessionId,
        programId: msg.programId, hostId: msg.hostId, runId: msg.runId,
        stepId: msg.failingStep?.id,
        allowedSkills: (msg.allowedSkills || []).map((s) => s.id).join(', ') || '（无白名单）',
      });
    });
    socket.on('guardian:thinking', (msg) => {
      pushGuardian({ type: 'thinking', sessionId: msg.sessionId, turn: msg.turn });
    });
    socket.on('guardian:thought', (msg) => {
      pushGuardian({ type: 'thought', sessionId: msg.sessionId, text: msg.text });
    });
    socket.on('guardian:exec', (msg) => {
      pushGuardian({ type: 'exec', sessionId: msg.sessionId, command: msg.command });
    });
    socket.on('guardian:exec-result', (msg) => {
      pushGuardian({
        type: 'exec-result', sessionId: msg.sessionId,
        exitCode: msg.exitCode, durationMs: msg.durationMs,
        stderrSnippet: (msg.stderr || '').trimEnd().slice(-160),
        stdoutSnippet: (msg.stdout || '').trimEnd().slice(-160),
      });
    });
    socket.on('guardian:render', (msg) => {
      pushGuardian({
        type: 'render', sessionId: msg.sessionId,
        level: msg.payload?.level || 'info',
        title: msg.payload?.title || '(render)',
        content: msg.payload?.content || msg.payload?.subtitle || '',
      });
    });
    socket.on('guardian:info', (msg) => {
      pushGuardian({ type: 'info', sessionId: msg.sessionId, message: msg.message });
    });
    socket.on('guardian:ask', (msg) => {
      pushGuardian({ type: 'ask', sessionId: msg.sessionId, payload: msg.payload });
      openAskModal(msg.sessionId, msg.toolUseId, msg.payload || {});
    });
    socket.on('guardian:session-ended', (msg) => {
      guardianSessions.delete(msg.sessionId);
      pushGuardian({
        type: 'session-ended', sessionId: msg.sessionId,
        resolution: msg.resolution, summary: msg.summary, ok: msg.ok,
      });
      // 若 modal 是这个 session 的，自动关
      if (currentAsk && currentAsk.sessionId === msg.sessionId) closeAskModal();
    });
  }

  // ─── 数据加载 ────────────────────────────────────────────────────────
  async function loadPrograms() {
    try {
      const data = await requestJson('/api/programs');
      programs = data.programs || [];
    } catch (err) {
      showErrorMessage(err);
      programs = [];
    }
  }

  async function loadHosts() {
    try {
      const data = await requestJson('/api/hosts');
      hosts = data.hosts || data || [];
    } catch { hosts = []; }
  }

  async function loadActiveRuns() {
    try {
      const data = await requestJson('/api/program-runs/active');
      activeRuns.clear();
      for (const r of (data.runs || [])) {
        activeRuns.set(r.runId, { programId: r.programId, hostId: r.hostId, startedAt: Date.now() });
      }
    } catch { /* 静默 */ }
  }

  async function refreshDetail() {
    if (!activeProgramId) return;
    try {
      const data = await requestJson(`/api/programs/${encodeURIComponent(activeProgramId)}`);
      if (data.ok) {
        const idx = programs.findIndex((p) => p.id === activeProgramId);
        if (idx >= 0) programs[idx] = { ...data.program, instances: data.instances };
        renderDetail();
      }
    } catch (err) { showErrorMessage(err); }
  }

  // ─── 列表渲染 ────────────────────────────────────────────────────────
  function renderList() {
    $count.textContent = programs.length;
    if (!programs.length) {
      $list.innerHTML = '<div class="text-center text-slate-400 text-xs py-8">尚未定义任何 Program。<br>放到 <code>data/programs/&lt;id&gt;/program.yaml</code> 并点"重扫"</div>';
      return;
    }
    $list.innerHTML = programs.map((p) => {
      const enabledBadge = p.enabled
        ? '<span class="badge badge-ok">已启用</span>'
        : '<span class="badge badge-idle">未启用</span>';
      const triggerTypes = [...new Set((p.triggers || []).map((t) => t.type))].join(' · ');
      const hostLabel = p.hosts === 'all' ? '所有主机' : (Array.isArray(p.hosts) ? `${p.hosts.length} 台主机` : '—');
      return `
        <div class="program-card ${p.id === activeProgramId ? 'active' : ''}" data-id="${escapeHtml(p.id)}">
          <div class="flex items-center gap-2">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200 flex-1 min-w-0 truncate">${escapeHtml(p.name)}</div>
            ${enabledBadge}
            <button class="btn-delete-program shrink-0 text-[11px] font-medium px-2 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600 hover:border-red-400 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30 dark:hover:text-red-300 transition-colors ml-1" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="删除 Program" onclick="event.stopPropagation()">删除</button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1 flex items-center gap-2">
            <span>${escapeHtml(triggerTypes || '无 trigger')}</span>
            <span class="text-slate-300 dark:text-slate-600">·</span>
            <span>${escapeHtml(hostLabel)}</span>
          </div>
        </div>
      `;
    }).join('');
    $list.querySelectorAll('.program-card').forEach((el) => {
      el.addEventListener('click', () => selectProgram(el.dataset.id));
    });
    $list.querySelectorAll('.btn-delete-program').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProgram(btn.dataset.id, btn.dataset.name); });
    });
  }

  async function deleteProgram(id, name) {
    if (!confirm(`确认删除 Program「${name}」？\n\n此操作会删除 data/programs/${id}/ 目录下的所有文件，不可撤销。`)) return;
    try {
      await requestJson(`/api/programs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (activeProgramId === id) {
        activeProgramId = null;
        $detailBody.classList.add('hidden');
        $detailEmpty.classList.remove('hidden');
      }
      await loadPrograms();
      showToast?.(`Program「${name}」已删除`, 'success');
    } catch (err) {
      showErrorMessage(err);
    }
  }

  function selectProgram(id) {
    activeProgramId = id;
    $list.querySelectorAll('.program-card').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });
    $detailEmpty.classList.add('hidden');
    $detailBody.classList.remove('hidden');
    // 切換 program 時清空結果面板，然後嘗試加載歷史 renders
    if ($resultsStream) $resultsStream.innerHTML = '';
    if ($resultsEmpty) $resultsEmpty.classList.remove('hidden');
    if ($resultsHostLabel) $resultsHostLabel.classList.add('hidden');
    renderDetail();
    switchTab('instances');
    refreshRuns().catch(() => {});
    // 加載歷史 render 輸出（異步，不阻塞主流程）
    loadLastRenders(id).catch(() => {});
  }

  // 加載某 Program 最近一次 run 的 render 輸出並顯示在結果面板
  async function loadLastRenders(programId) {
    const p = programs.find((x) => x.id === programId);
    if (!p) return;
    // 取所有主機中最近有 render 輸出的那個
    const hostIds = p.hosts === 'all'
      ? hosts.map((h) => h.id)
      : (Array.isArray(p.hosts) ? p.hosts : []);
    for (const hostId of hostIds) {
      try {
        const data = await requestJson(
          `/api/programs/${encodeURIComponent(programId)}/instances/${encodeURIComponent(hostId)}/renders`
        );
        if (data.ok && Array.isArray(data.renders) && data.renders.length > 0) {
          clearResults(hostId);
          for (const item of data.renders) {
            pushResult({ programId, hostId, stepId: item.stepId, payload: item.payload });
          }
          // 有歷史數據，在 label 上加「歷史」提示
          if ($resultsHostLabel) {
            $resultsHostLabel.textContent += ' (歷史數據)';
          }
          return; // 找到第一個有數據的主機即停止
        }
      } catch { /* 忽略單個主機的加載失敗 */ }
    }
  }

  // ─── 详情渲染 ────────────────────────────────────────────────────────
  function renderDetail() {
    const p = programs.find((x) => x.id === activeProgramId);
    if (!p) return;
    $detailName.textContent = `${p.name}`;
    $detailDesc.textContent = p.description || '';
    $detailEnabled.className = 'badge ' + (p.enabled ? 'badge-ok' : 'badge-idle');
    $detailEnabled.textContent = p.enabled ? '已启用' : '未启用';

    $detailTriggers.innerHTML = (p.triggers || []).map((t) => {
      const colorCls = t.type === 'cron' ? 'badge-ok' : 'badge-idle';
      const extra = t.type === 'cron' ? ` <code class="text-[10px]">${escapeHtml(t.schedule)}</code>` : '';
      return `<span class="badge ${colorCls}">${escapeHtml(t.id)} · ${escapeHtml(t.type)}${extra} → ${escapeHtml(t.action)}</span>`;
    }).join('');

    renderInstances(p);
  }

  function refreshInstances() {
    const p = programs.find((x) => x.id === activeProgramId);
    if (!p) return;
    // 再拉一次最新 instance
    requestJson(`/api/programs/${encodeURIComponent(p.id)}/instances`).then((data) => {
      if (data.ok) {
        p.instances = data.instances || [];
        renderInstances(p);
      }
    }).catch(() => {});
  }

  function renderInstances(p) {
    const instances = p.instances || [];
    const expectedHosts = p.hosts === 'all'
      ? hosts.map((h) => h.id)
      : (Array.isArray(p.hosts) ? p.hosts : []);

    // 合并：expectedHosts 与 instances
    const map = new Map();
    for (const hid of expectedHosts) {
      map.set(hid, { host_id: hid, program_id: p.id, enabled: 1 });
    }
    for (const inst of instances) map.set(inst.host_id, inst);

    const rows = [...map.values()];
    if (rows.length === 0) {
      $instancesBody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-400 py-8">无可用主机</td></tr>';
      return;
    }

    $instancesBody.innerHTML = rows.map((inst) => {
      const host = hosts.find((h) => h.id === inst.host_id);
      const hostName = host ? host.name : inst.host_id;
      const isActive = [...activeRuns.values()].some((r) => r.programId === p.id && r.hostId === inst.host_id);
      const statusBadge = isActive
        ? '<span class="badge badge-run">运行中</span>'
        : renderStatusBadge(inst.last_status);
      const enabled = inst.enabled === 1 || inst.enabled === undefined;
      const enableBtn = enabled
        ? `<button class="act-btn act-btn-danger btn-disable" data-hid="${escapeHtml(inst.host_id)}">停用</button>`
        : `<button class="act-btn act-btn-success btn-enable" data-hid="${escapeHtml(inst.host_id)}">启用</button>`;
      return `
        <tr>
          <td><span class="font-semibold">${escapeHtml(hostName)}</span> <span class="text-[10px] text-slate-400">${escapeHtml(inst.host_id)}</span></td>
          <td>${enabled ? '<span class="badge badge-ok">开</span>' : '<span class="badge badge-idle">关</span>'}</td>
          <td>${statusBadge}</td>
          <td class="text-[10px] text-slate-500 dark:text-slate-400">${escapeHtml(inst.last_run_at || '—')}</td>
          <td class="text-[10px] text-slate-500 dark:text-slate-400">${escapeHtml(inst.last_trigger_id || '—')}</td>
          <td class="text-right">
            <button class="act-btn act-btn-primary btn-trigger" data-hid="${escapeHtml(inst.host_id)}" ${isActive ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>&#9654; 触发</button>
            ${enableBtn}
          </td>
        </tr>
      `;
    }).join('');

    $instancesBody.querySelectorAll('.btn-trigger').forEach((btn) => {
      btn.addEventListener('click', () => triggerInstance(p.id, btn.dataset.hid));
    });
    $instancesBody.querySelectorAll('.btn-enable').forEach((btn) => {
      btn.addEventListener('click', () => toggleInstance(p.id, btn.dataset.hid, true));
    });
    $instancesBody.querySelectorAll('.btn-disable').forEach((btn) => {
      btn.addEventListener('click', () => toggleInstance(p.id, btn.dataset.hid, false));
    });
  }

  function renderStatusBadge(status) {
    if (!status) return '<span class="badge badge-idle">未运行</span>';
    if (status === 'success') return '<span class="badge badge-ok">成功</span>';
    if (status === 'running') return '<span class="badge badge-run">运行中</span>';
    if (status === 'failed') return '<span class="badge badge-err">失败</span>';
    if (status === 'cancelled') return '<span class="badge badge-warn">已取消</span>';
    return `<span class="badge badge-idle">${escapeHtml(status)}</span>`;
  }

  async function triggerInstance(programId, hostId) {
    try {
      const res = await requestJson(`/api/programs/${encodeURIComponent(programId)}/trigger`, {
        method: 'POST',
        body: JSON.stringify({ hostId }),
      });
      showToast(`已触发（run #${(res.runIds || []).join(', ')}）`, 'success');
    } catch (err) { showErrorMessage(err); }
  }

  async function toggleInstance(programId, hostId, enable) {
    const endpoint = enable ? 'enable' : 'disable';
    try {
      await requestJson(`/api/programs/${encodeURIComponent(programId)}/instances/${encodeURIComponent(hostId)}/${endpoint}`, {
        method: 'POST',
      });
      showToast(enable ? '已启用' : '已停用', 'success');
      await refreshDetail();
    } catch (err) { showErrorMessage(err); }
  }

  // ─── 运行历史 ───────────────────────────────────────────────────────
  async function refreshRuns() {
    if (!activeProgramId) return;
    try {
      const data = await requestJson(`/api/program-runs?programId=${encodeURIComponent(activeProgramId)}&limit=100`);
      renderRuns(data.runs || []);
    } catch (err) { showErrorMessage(err); }
  }

  function renderRuns(runs) {
    if (!runs.length) {
      $runsBody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-400 py-8">暂无运行记录</td></tr>';
      return;
    }
    $runsBody.innerHTML = runs.map((r) => {
      const host = hosts.find((h) => h.id === r.host_id);
      const hostName = host ? host.name : r.host_id;
      const duration = r.started_at && r.finished_at
        ? `${Math.max(0, (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
        : '—';
      return `
        <tr>
          <td class="text-slate-400 text-[10px]">#${r.id}</td>
          <td>${escapeHtml(hostName)}</td>
          <td class="text-[10px]">${escapeHtml(r.trigger_id)} <span class="text-slate-400">(${escapeHtml(r.trigger_type)})</span></td>
          <td class="text-[10px]">${escapeHtml(r.action)}</td>
          <td>${renderStatusBadge(r.status)}</td>
          <td class="text-[10px]">${r.steps_completed}/${r.steps_total}</td>
          <td class="text-[10px] text-slate-500 dark:text-slate-400">${escapeHtml(r.started_at)}</td>
          <td class="text-[10px]">${duration}</td>
        </tr>
      `;
    }).join('');
  }

  // ─── 结果面板 ────────────────────────────────────────────────────────
  function clearResults(hostId) {
    if (!$resultsStream) return;
    $resultsStream.innerHTML = '';
    if ($resultsEmpty) $resultsEmpty.classList.add('hidden');
    if ($resultsHostLabel && hostId) {
      const host = hosts.find((h) => h.id === hostId);
      $resultsHostLabel.textContent = `主机：${host ? host.name : hostId}`;
      $resultsHostLabel.classList.remove('hidden');
    }
  }

  function pushResult(msg) {
    if (!$resultsStream || !window.appShared?.renderResultCard) return;
    const card = window.appShared.renderResultCard(msg.payload || {});
    // 加时间戳标签
    const ts = document.createElement('div');
    ts.className = 'text-[10px] text-slate-400 mb-1';
    ts.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  · ' + (msg.stepId || '');
    const wrap = document.createElement('div');
    wrap.appendChild(ts);
    wrap.appendChild(card);
    $resultsStream.appendChild(wrap);
    if ($resultsEmpty) $resultsEmpty.classList.add('hidden');
  }

  // ─── 实时事件 ───────────────────────────────────────────────────────
  function pushEvent(ev) {
    if (activeProgramId && ev.programId && ev.programId !== activeProgramId) return;
    const empty = $eventsStream.querySelector('.text-center');
    if (empty) $eventsStream.innerHTML = '';

    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    let icon = '·', colorCls = 'text-slate-500';
    let msg = '';

    if (ev.type === 'run-started') {
      icon = '▶'; colorCls = 'text-blue-500';
      msg = `run #${ev.runId} 启动 — ${ev.triggerId} / ${ev.action} · ${ev.hostId}`;
    } else if (ev.type === 'step-started') {
      icon = '→'; colorCls = 'text-slate-500';
      msg = `run #${ev.runId} step "${ev.stepId}" 开始`;
    } else if (ev.type === 'step-ended') {
      const ok = ev.status === 'verified';
      icon = ok ? '✓' : (ev.status === 'skipped' ? '◌' : '✗');
      colorCls = ok ? 'text-emerald-500' : (ev.status === 'skipped' ? 'text-slate-400' : 'text-red-500');
      msg = `run #${ev.runId} step "${ev.stepId}" ${ev.status} ${ev.durationMs ? `(${ev.durationMs}ms)` : ''}${ev.reason ? ` — ${ev.reason}` : ''}`;
    } else if (ev.type === 'run-ended') {
      const ok = ev.status === 'success';
      icon = ok ? '●' : '■';
      colorCls = ok ? 'text-emerald-500' : 'text-red-500';
      msg = `run #${ev.runId} 结束 — ${ev.status}${ev.error ? ` · ${ev.error}` : ''}`;
    }

    const row = document.createElement('div');
    row.className = 'event-row pulse';
    row.innerHTML = `
      <span class="text-[10px] text-slate-400 shrink-0 font-mono">${escapeHtml(ts)}</span>
      <span class="${colorCls} shrink-0">${icon}</span>
      <span class="flex-1">${escapeHtml(msg)}</span>
    `;
    $eventsStream.prepend(row);

    // 最多保留 200 条
    while ($eventsStream.children.length > 200) $eventsStream.removeChild($eventsStream.lastChild);
  }

  // ─── Tab 切换 ───────────────────────────────────────────────────────
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('border-blue-500', active);
      b.classList.toggle('text-blue-600', active);
      b.classList.toggle('dark:text-blue-400', active);
      b.classList.toggle('border-transparent', !active);
      b.classList.toggle('text-slate-400', !active);
    });
    document.getElementById('panel-instances').classList.toggle('hidden', tab !== 'instances');
    document.getElementById('panel-results').classList.toggle('hidden', tab !== 'results');
    document.getElementById('panel-runs').classList.toggle('hidden', tab !== 'runs');
    document.getElementById('panel-events').classList.toggle('hidden', tab !== 'events');
    document.getElementById('panel-guardian').classList.toggle('hidden', tab !== 'guardian');
    if (tab === 'runs') refreshRuns().catch(() => {});
  }

  // ─── Guardian 事件流 ────────────────────────────────────────────────
  function pushGuardian(ev) {
    // 若绑定了 activeProgramId 就过滤，否则显示全部
    if (activeProgramId) {
      const ses = guardianSessions.get(ev.sessionId);
      if (ses && ses.programId !== activeProgramId) return;
    }
    const empty = $guardianStream.querySelector('.text-center');
    if (empty) $guardianStream.innerHTML = '';

    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    let icon = '·', colorCls = 'text-slate-500';
    let msg = '';

    if (ev.type === 'session-started') {
      icon = '🛡'; colorCls = 'text-amber-500';
      msg = `Guardian 唤起 · ${ev.sessionId.slice(0, 16)} · step=${ev.stepId} · skills=[${ev.allowedSkills}]`;
    } else if (ev.type === 'thinking') {
      icon = '💭'; colorCls = 'text-slate-400';
      msg = `思考 · 第 ${ev.turn} 轮`;
    } else if (ev.type === 'thought') {
      icon = '🤖'; colorCls = 'text-slate-500';
      msg = ev.text;
    } else if (ev.type === 'exec') {
      icon = '→'; colorCls = 'text-blue-500';
      msg = `exec: ${ev.command}`;
    } else if (ev.type === 'exec-result') {
      const ok = ev.exitCode === 0;
      icon = ok ? '✓' : '✗';
      colorCls = ok ? 'text-emerald-500' : 'text-red-500';
      msg = `exit=${ev.exitCode} · ${ev.durationMs}ms` +
        (ev.stderrSnippet ? ` · err: ${ev.stderrSnippet}` : '') +
        (ok && ev.stdoutSnippet ? ` · out: ${ev.stdoutSnippet}` : '');
    } else if (ev.type === 'render') {
      const lvlMap = { success: '✓', error: '✗', warning: '!', info: 'i' };
      icon = lvlMap[ev.level] || '◉'; colorCls = {
        success: 'text-emerald-500', error: 'text-red-500', warning: 'text-amber-500'
      }[ev.level] || 'text-blue-500';
      msg = `${ev.title}${ev.content ? ' — ' + ev.content : ''}`;
    } else if (ev.type === 'info') {
      icon = 'ℹ'; colorCls = 'text-slate-500';
      msg = ev.message;
    } else if (ev.type === 'ask') {
      icon = '❓'; colorCls = 'text-amber-500';
      msg = `ask_user · ${ev.payload?.type} · ${ev.payload?.title || ''}`;
    } else if (ev.type === 'session-ended') {
      icon = ev.ok ? '●' : '■';
      colorCls = ev.ok ? 'text-emerald-500' : 'text-red-500';
      msg = `结束 · ${ev.resolution} — ${ev.summary}`;
    }

    const row = document.createElement('div');
    row.className = 'event-row pulse';
    row.innerHTML = `
      <span class="text-[10px] text-slate-400 shrink-0 font-mono">${escapeHtml(ts)}</span>
      <span class="${colorCls} shrink-0">${icon}</span>
      <span class="flex-1 break-all">${escapeHtml(msg)}</span>
    `;
    $guardianStream.prepend(row);

    while ($guardianStream.children.length > 200) $guardianStream.removeChild($guardianStream.lastChild);
  }

  // ─── Guardian ask modal ─────────────────────────────────────────────
  function openAskModal(sessionId, toolUseId, payload) {
    currentAsk = { sessionId, toolUseId, payload };
    $askTitle.textContent = payload.title || '请确认';
    $askSubtitle.textContent = `session ${sessionId.slice(0, 16)}`;
    $askDesc.textContent = payload.description || '';
    $askIcon.textContent = payload.danger ? '⚠️' : '🤖';

    const type = payload.type || 'confirm';
    if (type === 'select') {
      const opts = Array.isArray(payload.options) ? payload.options : [];
      $askBody.innerHTML = opts.map((o, i) => `
        <label class="flex items-start gap-2 p-2 border border-slate-200 dark:border-[#1e293b] rounded-lg mb-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-[#0d1629]">
          <input type="radio" name="guardian-ask-opt" value="${escapeHtml(o.value)}" ${i === 0 ? 'checked' : ''} class="mt-0.5" />
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold">${escapeHtml(o.label || o.value)}</div>
            ${o.description ? `<div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(o.description)}</div>` : ''}
          </div>
        </label>
      `).join('');
      $askConfirm.textContent = payload.confirmLabel || '选择';
      $askConfirm.className = 'act-btn act-btn-primary';
    } else if (type === 'input') {
      $askBody.innerHTML = `
        <input id="guardian-ask-input" type="text"
               placeholder="${escapeHtml(payload.placeholder || '')}"
               value="${escapeHtml(payload.defaultValue || '')}"
               class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs outline-none focus:border-blue-400" />
      `;
      $askConfirm.textContent = payload.confirmLabel || '提交';
      $askConfirm.className = 'act-btn act-btn-primary';
      setTimeout(() => document.getElementById('guardian-ask-input')?.focus(), 30);
    } else {
      // confirm
      $askBody.innerHTML = '';
      $askConfirm.textContent = payload.confirmLabel || '确认';
      $askConfirm.className = payload.danger ? 'act-btn act-btn-danger' : 'act-btn act-btn-primary';
    }
    $askCancel.textContent = payload.cancelLabel || '取消';

    $askModal.style.display = 'flex';
    $askModal.classList.remove('hidden');
  }

  function closeAskModal() {
    $askModal.style.display = 'none';
    $askModal.classList.add('hidden');
    currentAsk = null;
  }

  function bindAskModal() {
    $askConfirm.addEventListener('click', () => {
      if (!currentAsk) return;
      const { sessionId, toolUseId, payload } = currentAsk;
      let answer;
      const type = payload.type || 'confirm';
      if (type === 'select') {
        const selected = document.querySelector('input[name="guardian-ask-opt"]:checked');
        if (!selected) { showToast('请选择一项', 'warn'); return; }
        const opt = (payload.options || []).find((o) => o.value === selected.value);
        answer = { value: selected.value, label: opt?.label || selected.value };
      } else if (type === 'input') {
        const val = document.getElementById('guardian-ask-input')?.value || '';
        answer = { value: val };
      } else {
        answer = { confirmed: true };
      }
      socket.emit('guardian:answer', { sessionId, toolUseId, answer }, () => {});
      closeAskModal();
    });
    $askCancel.addEventListener('click', () => {
      if (!currentAsk) { closeAskModal(); return; }
      const { sessionId, toolUseId, payload } = currentAsk;
      const type = payload.type || 'confirm';
      const answer = type === 'confirm' ? { confirmed: false } : { cancelled: true };
      socket.emit('guardian:answer', { sessionId, toolUseId, answer }, () => {});
      closeAskModal();
    });
  }

  // ─── 统计 ──────────────────────────────────────────────────────────
  async function updateStats() {
    $statPrograms.textContent = programs.length;
    const allInstances = programs.flatMap((p) => p.instances || []);
    const enabledCount = allInstances.filter((i) => i.enabled === 1).length;
    $statEnabled.textContent = enabledCount;
    $statActive.textContent = activeRuns.size;

    try {
      // 粗略计算近 24h 失败
      const data = await requestJson('/api/program-runs?limit=500');
      const since = Date.now() - 86400000;
      const failed = (data.runs || []).filter((r) =>
        r.status === 'failed' && new Date(r.started_at).getTime() >= since
      ).length;
      $statFailed.textContent = failed;
    } catch { $statFailed.textContent = '—'; }
  }

  init().catch(showErrorMessage);
})();
(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast, showErrorMessage } = window.appShared;
  const requestJson = createRequestJson({
    onUnauthorized: () => { window.location.href = 'index.html'; },
  });

  // ─── 状态 ───────────────────────────────────────────────────────────
  let skills = [];
  let allSkillsAndPlaybooks = []; // 所有 skills + playbooks，供 rowAction 选择器用
  let hosts = [];
  let activeSkill = null;
  let socket = null;
  let currentRunId = null;
  const errorLog = [];   // Playbook 运行过程中的错误摘要，供"AI 改进"带回创作台
  let elapsedTimer = null;
  let elapsedSeconds = 0;
  let currentTurn = 0;
  let currentMode = 'ai-loop';    // 'playbook' | 'ai-loop' | 'ai-rescue'
  let stepsDone = 0;              // playbook 模式：已完成步骤数
  let stepsTotal = 0;             // playbook 模式：总步骤数（exec+render）
  let rescueCount = 0;            // Rescuer 介入次数
  // stepId → { el, type, data }
  const stepIndex = new Map();

  // ─── DOM ────────────────────────────────────────────────────────────
  const $skillList       = document.getElementById('skill-list');
  const $skillEmpty      = document.getElementById('skill-empty');
  const $skillConfig     = document.getElementById('skill-config');
  const $btnCreateSkill   = document.getElementById('btn-create-skill');
  const $skillIcon       = document.getElementById('skill-icon');
  const $skillName       = document.getElementById('skill-name');
  const $skillDesc       = document.getElementById('skill-desc');
  const $skillInputs     = document.getElementById('skill-inputs');
  const $hostSelect      = document.getElementById('skill-host-select');
  const $btnRun          = document.getElementById('btn-skill-run');
  const $btnStop         = document.getElementById('btn-skill-stop');
  const $btnNew          = document.getElementById('btn-skill-new');
  const $formArea        = document.getElementById('skill-form-area');
  const $runArea         = document.getElementById('skill-run-area');
  const $runStream       = document.getElementById('skill-run-stream');
  const $runStatusDot    = document.getElementById('run-status-dot');
  const $runStatusText   = document.getElementById('run-status-text');
  const $runElapsed      = document.getElementById('run-elapsed');
  const $runTurn         = document.getElementById('run-turn');
  const $runModeBadge    = document.getElementById('run-mode-badge');
  const $providerStatus  = document.getElementById('skill-provider-status');
  const $rescuerSelect   = document.getElementById('rescuer-skill-select'); // 仅 playbooks.html 有

  // ─── 初始化 ─────────────────────────────────────────────────────────
  async function init() {
    initSocket();
    await Promise.all([loadSkills(), loadHosts(), loadProviderStatus(), loadRescuerSkillOptions()]);
    bindEvents();
  }

  // 剧本仓库模式：HTML 中设置 window.LIBRARY_KIND = 'playbook' 时切换 URL 集
  const LIBRARY_KIND = (window.LIBRARY_KIND === 'playbook') ? 'playbook' : 'skill';
  const LIST_URL   = LIBRARY_KIND === 'playbook' ? '/api/playbooks' : '/api/skills';
  const RELOAD_URL = LIBRARY_KIND === 'playbook' ? '/api/playbooks/reload' : '/api/skills/reload';
  const LIST_KEY   = LIBRARY_KIND === 'playbook' ? 'playbooks' : 'skills';

  async function loadSkills() {
    try {
      // 先 reload 再 list，确保拿到最新创建的 Playbook
      await requestJson(RELOAD_URL, { method: 'POST' }).catch(() => {});
      const data = await requestJson(LIST_URL);
      skills = data[LIST_KEY] || [];
      renderSkillList();

      // 同时加载另一侧列表，供 rowAction 选择器使用（两侧都需要）
      const otherUrl = LIBRARY_KIND === 'playbook' ? '/api/skills' : '/api/playbooks';
      const otherKey = LIBRARY_KIND === 'playbook' ? 'skills' : 'playbooks';
      const otherData = await requestJson(otherUrl).catch(() => ({ [otherKey]: [] }));
      allSkillsAndPlaybooks = [
        ...skills.map(s => ({ ...s, _kind: LIBRARY_KIND })),
        ...(otherData[otherKey] || []).map(s => ({ ...s, _kind: otherKey.replace('s', '') })),
      ];
    } catch (err) {
      showErrorMessage(err);
    }
  }

  async function loadHosts() {
    try {
      const data = await requestJson('/api/hosts');
      hosts = data.hosts || data || [];
      renderHostSelect();
    } catch {
      // 静默
    }
  }

  // 加载 Rescue Skill 候选（仅 playbooks.html 有下拉时生效）
  async function loadRescuerSkillOptions() {
    if (!$rescuerSelect) return;
    try {
      const data = await requestJson('/api/skills');
      const all = data.skills || [];
      const rescues = all.filter(s => s.category === 'rescue');
      const current = $rescuerSelect.value;
      $rescuerSelect.innerHTML =
        '<option value="">默认救援（按 Playbook）</option>' +
        rescues.map(s =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.icon || '🛟')} ${escapeHtml(s.name)}</option>`
        ).join('');
      if (current && rescues.find(s => s.id === current)) {
        $rescuerSelect.value = current;
      }
      if (rescues.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.textContent = '—（仓库里暂无 Rescue Skill）';
        $rescuerSelect.appendChild(opt);
      }
    } catch {
      // 静默：下拉保留默认选项
    }
  }

  async function loadProviderStatus() {
    try {
      const data = await requestJson('/api/agent/providers/claude-code').catch(() => null);
      if (data && data.ok && data.activeProviderId) {
        const active = (data.providers || []).find(p => p.id === data.activeProviderId);
        if (active && active.apiKeySet) {
          $providerStatus.textContent = `Provider: ${active.name || 'default'} · ${active.model || ''}`;
          $providerStatus.className = 'text-[10px] text-emerald-600 dark:text-emerald-400';
          return;
        }
      }
      $providerStatus.innerHTML = '<a href="cli-setup.html" class="underline hover:text-blue-500">未配置 Provider，点击配置</a>';
      $providerStatus.className = 'text-[10px] text-amber-600 dark:text-amber-400';
    } catch {
      // 静默
    }
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────
  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('skill:run-started', (msg) => {
      if (msg.runId !== currentRunId) return;
      currentMode = msg.mode || 'ai-loop';
      setModeBadge(currentMode);
      setRunStatus('running', currentMode === 'playbook' ? '执行中' : 'AI 思考中');
    });

    socket.on('skill:mode', (msg) => {
      if (msg.runId !== currentRunId) return;
      currentMode = msg.mode || 'ai-loop';
      setModeBadge(currentMode);
      if (msg.mode === 'ai-rescue') {
        appendRescueBanner(msg.stepId);
        setRunStatus('running', 'AI 介入修复中');
      } else if (msg.mode === 'playbook') {
        setRunStatus('running', '继续执行');
      }
    });

    socket.on('skill:step-started', (msg) => {
      if (msg.runId !== currentRunId) return;
      if (msg.type === 'render') return; // render step 无需单独展示行
      appendPlaybookStep(msg);
    });

    socket.on('skill:step-verified', (msg) => {
      if (msg.runId !== currentRunId) return;
      stepsDone++;
      updateStepProgress();
      markPlaybookStep(msg.stepId, 'verified', msg.durationMs);
    });

    socket.on('skill:step-failed', (msg) => {
      if (msg.runId !== currentRunId) return;
      markPlaybookStep(msg.stepId, 'failed', null, msg.reason);
    });

    socket.on('skill:thinking', (msg) => {
      if (msg.runId !== currentRunId) return;
      currentTurn = msg.turn || currentTurn + 1;
      $runTurn.textContent = `第 ${currentTurn} 轮`;
      setRunStatus('running', 'AI 思考中');
    });

    socket.on('skill:thought', (msg) => {
      if (msg.runId !== currentRunId) return;
      appendThought(msg.text);
    });

    socket.on('skill:exec', (msg) => {
      if (msg.runId !== currentRunId) return;
      appendExec(msg);
    });

    socket.on('skill:exec-result', (msg) => {
      if (msg.runId !== currentRunId) return;
      updateExecResult(msg);
      if (msg.exitCode !== undefined && msg.exitCode !== 0) {
        const cmdLog = `exit=${msg.exitCode}${msg.stderr ? `\nstderr: ${String(msg.stderr).trim().slice(0, 500)}` : ''}`;
        errorLog.push(cmdLog);
      }
    });

    socket.on('skill:render', (msg) => {
      if (msg.runId !== currentRunId) return;
      appendRender(msg);
    });

    socket.on('skill:ask', (msg) => {
      if (msg.runId !== currentRunId) return;
      appendAsk(msg);
    });

    socket.on('skill:done', (msg) => {
      if (msg?.runId && msg.runId !== currentRunId) return;
      appendRunSummary(msg);
      finalizeRun('done');
    });

    socket.on('skill:error', (msg) => {
      if (msg?.runId && msg.runId !== currentRunId) return;
      appendSystemMessage(msg.error || '执行出错', 'error');
      errorLog.push(`FATAL: ${msg.error || '执行出错'}`);
      finalizeRun('error');
    });

    socket.on('skill:cancelled', (msg) => {
      if (msg?.runId && msg.runId !== currentRunId) return;
      finalizeRun('cancelled');
    });
  }

  // ─── 渲染 Skill 列表 ────────────────────────────────────────────────
  function renderSkillList() {
    if (!skills.length) {
      $skillList.innerHTML = '<div class="text-center text-slate-400 text-xs py-8">暂无可用 Skill</div>';
      return;
    }

    $skillList.innerHTML = skills.map((s) => `
      <div class="skill-card rounded-xl p-4 bg-white dark:bg-[#0b1324] ${activeSkill?.id === s.id ? 'active' : ''}"
           data-skill-id="${escapeHtml(s.id)}">
        <div class="flex items-start gap-3">
          <span class="text-2xl shrink-0">${escapeHtml(s.icon)}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <div class="text-sm font-bold text-slate-700 dark:text-slate-200">${escapeHtml(s.name)}</div>
              ${s.forceLocal ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900 text-sky-600 dark:text-sky-400 shrink-0">本机执行</span>' : ''}
              ${s.executionMode === 'playbook' ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 shrink-0" title="确定性执行，0 token">⚡ Playbook</span>' : ''}
              <button class="btn-delete-item ml-auto text-[11px] text-slate-300 hover:text-red-500 transition-colors" data-id="${escapeHtml(s.id)}" data-kind="${escapeHtml(s.kind || LIBRARY_KIND)}" data-name="${escapeHtml(s.name)}" title="删除" style="display:none">🗑</button>
            </div>
            <div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(s.description)}</div>
            <div class="flex flex-wrap gap-1 mt-2">
              ${(s.tags || []).map(t => `<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
        </div>
      </div>
    `).join('');

    // 悬停时显示删除按钮
    $skillList.querySelectorAll('.skill-card').forEach((card) => {
      card.addEventListener('mouseenter', () => { card.querySelector('.btn-delete-item').style.display = ''; });
      card.addEventListener('mouseleave', () => { card.querySelector('.btn-delete-item').style.display = 'none'; });
    });

    // 删除按钮点击
    $skillList.querySelectorAll('.btn-delete-item').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { id, kind, name } = btn.dataset;
        if (!confirm(`确认删除「${name}」？此操作不可恢复。`)) return;
        const endpoint = kind === 'playbook' ? `/api/playbooks/${encodeURIComponent(id)}` : `/api/skills/${encodeURIComponent(id)}`;
        try {
          await requestJson(endpoint, { method: 'DELETE' });
          showToast?.(`已删除「${name}」`, 'success');
          loadSkills();
        } catch (err) {
          showToast?.(err.message || '删除失败', 'error');
        }
      });
    });
  }

  function renderHostSelect() {
    const prev = $hostSelect.value;
    $hostSelect.innerHTML = '<option value="local">\u{1F5A5} 本机（1Shell 宿主）</option>';
    for (const h of hosts) {
      if (h.id === 'local') continue;
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = `${h.name} (${h.host})`;
      $hostSelect.appendChild(opt);
    }
    if (prev) $hostSelect.value = prev;
  }

  function selectSkill(skillId) {
    if (currentRunId) {
      showToast('请先停止当前任务', 'warn');
      return;
    }

    activeSkill = skills.find(s => s.id === skillId);
    if (!activeSkill) return;

    $skillList.querySelectorAll('.skill-card').forEach((el) => {
      el.classList.toggle('active', el.dataset.skillId === skillId);
    });

    $skillEmpty.classList.add('hidden');
    $skillConfig.classList.remove('hidden');
    $skillIcon.textContent = activeSkill.icon;
    $skillName.textContent = activeSkill.name;
    $skillDesc.textContent = activeSkill.description;

    resetToForm();
    renderInputForm();
  }

  function resetToForm() {
    $formArea.classList.remove('hidden');
    $runArea.classList.add('hidden');
    $btnRun.classList.remove('hidden');
    $btnStop.classList.add('hidden');
    $btnNew.classList.add('hidden');
    $runStream.innerHTML = '';
    stepIndex.clear();
    lastRenderedTable = null;
    stopElapsedTimer();
    currentRunId = null;
    currentTurn = 0;
    currentMode = 'ai-loop';
    stepsDone = 0;
    stepsTotal = 0;
    rescueCount = 0;
    $runTurn.textContent = '第 0 轮';
    $runModeBadge.className = 'hidden';
  }

  function renderInputForm() {
    const inputs = activeSkill.inputs || [];
    if (!inputs.length) {
      $skillInputs.innerHTML = '<div class="text-[11px] text-slate-400">此 Skill 无需额外参数</div>';
      return;
    }

    $skillInputs.innerHTML = inputs.map((inp) => {
      const requiredMark = inp.required ? '<span class="text-red-400">*</span>' : '';
      const visibleAttr = inp.visibleWhen
        ? `data-visible-field="${escapeHtml(inp.visibleWhen.field)}" data-visible-value="${escapeHtml(Array.isArray(inp.visibleWhen.value) ? inp.visibleWhen.value.join(',') : inp.visibleWhen.value)}"`
        : '';

      let fieldHtml = '';
      if (inp.type === 'select') {
        const opts = (inp.options || []).map((o) =>
          `<option value="${escapeHtml(o.value)}" ${o.value === inp.default ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
        ).join('');
        fieldHtml = `<select id="skill-input-${escapeHtml(inp.name)}" data-input-name="${escapeHtml(inp.name)}"
          class="w-full h-9 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400">${opts}</select>`;
      } else {
        fieldHtml = `<input id="skill-input-${escapeHtml(inp.name)}" data-input-name="${escapeHtml(inp.name)}"
          type="text" placeholder="${escapeHtml(inp.placeholder || '')}"
          value="${escapeHtml(inp.default || '')}"
          class="w-full h-9 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400" />`;
      }

      return `<div class="skill-input-group" ${visibleAttr}>
        <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 block">
          ${escapeHtml(inp.label)} ${requiredMark}
        </label>
        ${fieldHtml}
      </div>`;
    }).join('');

    updateInputVisibility();
    $skillInputs.querySelectorAll('select, input').forEach((el) => {
      el.addEventListener('change', updateInputVisibility);
      el.addEventListener('input', updateInputVisibility);
    });
  }

  function updateInputVisibility() {
    $skillInputs.querySelectorAll('.skill-input-group[data-visible-field]').forEach((group) => {
      const field = group.dataset.visibleField;
      const allowedValues = (group.dataset.visibleValue || '').split(',');
      const fieldEl = $skillInputs.querySelector(`[data-input-name="${field}"]`);
      const currentValue = fieldEl ? fieldEl.value : '';
      group.style.display = allowedValues.includes(currentValue) ? '' : 'none';
    });
  }

  function collectInputs() {
    const inputs = {};
    $skillInputs.querySelectorAll('[data-input-name]').forEach((el) => {
      const group = el.closest('.skill-input-group');
      if (group && group.style.display === 'none') return;
      inputs[el.dataset.inputName] = el.value;
    });
    return inputs;
  }

  function validateInputs() {
    if (!activeSkill) return false;
    for (const inp of activeSkill.inputs || []) {
      if (!inp.required) continue;
      if (inp.visibleWhen) {
        const depEl = $skillInputs.querySelector(`[data-input-name="${inp.visibleWhen.field}"]`);
        const depVal = depEl ? depEl.value : '';
        const allowed = Array.isArray(inp.visibleWhen.value) ? inp.visibleWhen.value : [inp.visibleWhen.value];
        if (!allowed.includes(depVal)) continue;
      }
      const el = $skillInputs.querySelector(`[data-input-name="${inp.name}"]`);
      if (!el || !el.value.trim()) {
        showToast(`请填写 ${inp.label}`, 'warn');
        el?.focus();
        return false;
      }
    }
    return true;
  }

  // ─── 计时器 ─────────────────────────────────────────────────────────
  function startElapsedTimer() {
    stopElapsedTimer();
    elapsedSeconds = 0;
    updateElapsedDisplay();
    elapsedTimer = setInterval(() => {
      elapsedSeconds++;
      updateElapsedDisplay();
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function updateElapsedDisplay() {
    const m = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const s = String(elapsedSeconds % 60).padStart(2, '0');
    $runElapsed.textContent = `${m}:${s}`;
  }

  // ─── 执行 Skill ─────────────────────────────────────────────────────
  function executeSkill() {
    if (!activeSkill) return;
    if (!validateInputs()) return;

    const inputs = collectInputs();
    const hostId = $hostSelect.value;
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    $formArea.classList.add('hidden');
    $runArea.classList.remove('hidden');
    $btnRun.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    $btnNew.classList.add('hidden');
    $runStream.innerHTML = '';
    stepIndex.clear();
    errorLog.length = 0;
    // 清理上一次失败留下的改进按钮
    const oldBtn = document.getElementById('btn-ai-improve');
    if (oldBtn) oldBtn.remove();
    currentTurn = 0;
    $runTurn.textContent = '第 0 轮';

    setRunStatus('starting', activeSkill.executionMode === 'playbook' ? '执行器启动中' : 'AI 启动中');
    startElapsedTimer();
    currentRunId = runId;

    socket.emit('skill:run', {
      runId,
      skillId: activeSkill.id,
      hostId,
      inputs,
      rescuerSkillId: $rescuerSelect?.value || '',
    }, (res) => {
      if (!res.ok) {
        appendSystemMessage(`启动失败: ${res.error}`, 'error');
        finalizeRun('error');
      }
    });
  }

  function stopRun() {
    if (!currentRunId) return;
    socket.emit('skill:stop', { runId: currentRunId });
    // 乐观 UI：立刻切换到已取消状态，不等服务端回传 skill:cancelled
    finalizeRun('cancelled');
  }

  // ─── 运行状态 ───────────────────────────────────────────────────────
  function setRunStatus(status, text) {
    const map = {
      starting: { dot: 'bg-yellow-400 animate-pulse', txt: 'text-amber-600 dark:text-amber-400' },
      running:  { dot: 'bg-blue-500 animate-pulse', txt: 'text-blue-600 dark:text-blue-400' },
      waiting:  { dot: 'bg-amber-400 animate-pulse', txt: 'text-amber-600 dark:text-amber-400' },
      done:     { dot: 'bg-emerald-500', txt: 'text-emerald-600 dark:text-emerald-400' },
      error:    { dot: 'bg-red-500', txt: 'text-red-600 dark:text-red-400' },
      cancelled:{ dot: 'bg-slate-400', txt: 'text-slate-500 dark:text-slate-400' },
    };
    const m = map[status] || map.running;
    $runStatusDot.className = `w-2 h-2 rounded-full ${m.dot}`;
    $runStatusText.className = `text-[11px] ${m.txt}`;
    $runStatusText.textContent = text;
  }

  function finalizeRun(status) {
    stopElapsedTimer();
    $btnStop.classList.add('hidden');
    $btnNew.classList.remove('hidden');
    currentRunId = null;
    if (status === 'done') {
      setRunStatus('done', '任务完成');
      // 如果是 skill-authoring 完成，重新加载列表
      if (activeSkill?.id === 'skill-authoring') {
        requestJson(RELOAD_URL, { method: 'POST' })
          .then(() => loadSkills())
          .catch(() => {});
      }
    }
    else if (status === 'error') {
      setRunStatus('error', '执行出错');
      // 剧本库里 Playbook 运行失败 → 显示"AI 改进"按钮
      if (LIBRARY_KIND === 'playbook' && activeSkill?.id) {
        showImproveButton(activeSkill.id, errorLog.slice());
      }
    }
    else setRunStatus('cancelled', '已取消');
  }

  function showImproveButton(playbookId, errors) {
    // 避免重复插入
    const existing = document.getElementById('btn-ai-improve');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = 'btn-ai-improve';
    btn.className = 'mt-3 px-4 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs font-semibold hover:opacity-90 shadow-md';
    btn.innerHTML = '✨ 让 AI 分析错误并改进这个 Playbook';
    btn.addEventListener('click', () => {
      const ctx = errors.length > 0
        ? errors.join('\n---\n')
        : '(运行时未捕获具体错误信息)';
      try {
        sessionStorage.setItem('1shell.studio.errorContext', ctx);
      } catch { /* ignore quota */ }
      const url = `skill-studio.html?mode=refine&target=${encodeURIComponent(playbookId)}&withError=1`;
      window.location.href = url;
    });
    // 挂到运行流底下
    if ($runStream && $runStream.parentElement) {
      $runStream.parentElement.appendChild(btn);
    }
  }

  // ─── 步骤流渲染 ────────────────────────────────────────────────────
  function scrollToBottom() {
    requestAnimationFrame(() => {
      $runStream.scrollTop = $runStream.scrollHeight;
    });
  }

  function appendThought(text) {
    const el = document.createElement('div');
    el.className = 'step-item step-thought';
    el.innerHTML = `
      <div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1">
        <span>&#128161;</span> AI 判断
      </div>
      <div class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">${escapeHtml(text)}</div>
    `;
    $runStream.appendChild(el);
    scrollToBottom();
  }

  function appendExec(msg) {
    const el = document.createElement('div');
    el.className = 'step-item step-exec running';
    el.dataset.toolUseId = msg.toolUseId;
    el.innerHTML = `
      <div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1">
        <span class="thinking-pulse">&#9881;</span>
        <span class="step-title">执行命令中…</span>
        <span class="ml-auto text-slate-400 step-duration"></span>
      </div>
      <pre class="exec-cmd">${escapeHtml(msg.command || '')}</pre>
      <div class="exec-output hidden"></div>
    `;
    $runStream.appendChild(el);
    stepIndex.set(msg.toolUseId, { el, type: 'exec', data: msg });
    scrollToBottom();
  }

  function updateExecResult(msg) {
    const entry = stepIndex.get(msg.toolUseId);
    if (!entry) return;
    const el = entry.el;
    el.classList.remove('running');

    const isError = msg.exitCode != null ? msg.exitCode !== 0 : Boolean(msg.error);
    if (isError) el.classList.add('error');

    const title = el.querySelector('.step-title');
    if (title) title.textContent = isError ? '执行失败' : '执行完成';

    const durEl = el.querySelector('.step-duration');
    if (durEl && msg.durationMs != null) durEl.textContent = `${msg.durationMs} ms`;

    const icon = el.querySelector('.thinking-pulse');
    if (icon) {
      icon.classList.remove('thinking-pulse');
      icon.textContent = isError ? '\u2718' : '\u2714';
    }

    const outEl = el.querySelector('.exec-output');
    if (outEl) {
      const parts = [];
      if (msg.error) parts.push(`[error] ${msg.error}`);
      if (msg.stdout) parts.push(`[stdout]\n${msg.stdout.trimEnd()}`);
      if (msg.stderr) parts.push(`[stderr]\n${msg.stderr.trimEnd()}`);
      if (msg.exitCode != null) parts.push(`[exitCode] ${msg.exitCode}`);
      if (parts.length > 0) {
        outEl.textContent = parts.join('\n\n');
        outEl.classList.remove('hidden');
      }
    }
    scrollToBottom();
  }

  // ─── render_result 渲染 ───────────────────────────────────────────
  // 保存最近 render 的表格数据，供 rowAction 点击时构造下一轮 inputs
  let lastRenderedTable = null;

  function appendRender(msg) {
    const p = msg.payload || {};
    if (p.format === 'table') lastRenderedTable = p;

    const el = window.appShared.renderResultCard(p, {
      onRowAction: (rowIndex, actionValue) => handleRowAction(rowIndex, actionValue),
    });

    $runStream.appendChild(el);

    // 当表格有操作按钮时，在下方插入 Skill 选择器
    if (p.format === 'table' && Array.isArray(p.rowActions) && p.rowActions.length > 0) {
      const picker = document.createElement('div');
      picker.className = 'flex items-center gap-2 mt-2 px-1';
      picker.innerHTML = `
        <span class="text-[11px] text-slate-500 shrink-0">点击操作时调用：</span>
        <select id="row-action-skill-sel" class="text-[11px] border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-1 bg-white dark:bg-[#0b1324] text-slate-700 dark:text-slate-200 flex-1">
          <option value="">— 自动（按 Playbook 指定）</option>
          ${allSkillsAndPlaybooks.map(s => `<option value="${escapeHtml(s.id)}" ${s.id === p.rowActionSkill ? 'selected' : ''}>[${s._kind === 'playbook' ? 'Playbook' : 'Skill'}] ${escapeHtml(s.name || s.id)}</option>`).join('')}
        </select>
      `;
      el.appendChild(picker);
    }

    scrollToBottom();
  }

  function renderTable(p) {
    const cols = Array.isArray(p.columns) ? p.columns : [];
    const rows = Array.isArray(p.rows) ? p.rows : [];
    const actions = Array.isArray(p.rowActions) ? p.rowActions : [];

    if (rows.length === 0) {
      return '<div class="text-xs text-slate-400 italic">（空）</div>';
    }

    const thead = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('') + (actions.length ? '<th class="text-right">操作</th>' : '');
    const tbody = rows.map((row, rowIndex) => {
      const cells = Array.isArray(row)
        ? row.map(c => `<td class="align-middle">${escapeHtml(String(c == null ? '' : c))}</td>`).join('')
        : `<td colspan="${cols.length}" class="text-slate-400">${escapeHtml(String(row))}</td>`;

      // 第一列是容器名，检测 1shell 保护
      const name = Array.isArray(row) ? String(row[0] || '') : '';
      const isProtected = /1shell/i.test(name);

      const actionCell = actions.length ? `<td class="text-right align-middle whitespace-nowrap">${
        isProtected
          ? '<span class="text-[10px] text-slate-400 italic">受保护</span>'
          : actions.map(a => `<button class="text-[10px] px-2 py-1 rounded border border-slate-200 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 hover:border-blue-400 text-slate-600 dark:text-slate-300 mr-1 transition-all"
              data-row-index="${rowIndex}" data-row-action="${escapeHtml(a.value || '')}">${escapeHtml(a.label || a.value || '执行')}</button>`).join('')
      }</td>` : '';
      return `<tr>${cells}${actionCell}</tr>`;
    }).join('');

    return `
      <div class="overflow-x-auto">
        <table class="result-table">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;
  }

  /**
   * rowAction 点击处理：在当前流中追加启动新一轮 skill 执行。
   * 用第一列（容器名）作为 container 参数，action value 作为 action 参数。
   * 若 lastRenderedTable.rowActionSkill 有值，则用该 skill 而非当前 skill。
   */
  function handleRowAction(rowIndex, actionValue) {
    if (!activeSkill) {
      showToast('请先选择一个 Skill 或 Playbook', 'warn');
      return;
    }
    if (!lastRenderedTable) {
      showToast('未找到表格数据，请重新运行后再试', 'warn');
      return;
    }
    if (currentRunId) {
      showToast('当前有任务在执行中，请等待完成后再点击', 'warn');
      return;
    }

    const rows = lastRenderedTable.rows || [];
    const row = rows[rowIndex];
    if (!row || !Array.isArray(row)) {
      showToast('行数据无效', 'warn');
      return;
    }

    const containerName = String(row[0] || '').trim();
    if (!containerName) {
      showToast('第一列为空，无法确定操作目标', 'warn');
      return;
    }

    // 确定目标 skill id：优先读行操作 Skill 选择器，其次 rowActionSkill
    const pickerSel = document.getElementById('row-action-skill-sel');
    const pickerVal = pickerSel?.value?.trim();
    const rowSkill = lastRenderedTable.rowActionSkill;
    const targetSkillId = (pickerVal || rowSkill || '').trim();

    // 如果没有指定 rowActionSkill，且当前是 Playbook，绝不能 fallback 到 Playbook 本身
    if (!targetSkillId) {
      showToast(
        '此表格未配置行操作 Skill（rowActionSkill 未设置）。' +
        '请在剧本的 render step 里加上 rowActionSkill: <skill-id>',
        'error', 6000,
      );
      return;
    }

    // 检查目标 skill 是否在已知列表中
    const foundInList = allSkillsAndPlaybooks.find(s => s.id === targetSkillId)
      || skills.find(s => s.id === targetSkillId);
    if (!foundInList) {
      showToast(
        `行操作 Skill「${targetSkillId}」不存在，请先在创作台创建该 Skill`,
        'error', 6000,
      );
      return;
    }

    // rowInputKey 指定第一列映射的 input 参数名（默认 container）
    const inputKey = lastRenderedTable.rowInputKey || 'container';

    // 在流中插入一条分隔
    const divider = document.createElement('div');
    divider.className = 'flex items-center gap-3 py-2';
    divider.innerHTML = `
      <div class="flex-1 h-px bg-slate-200 dark:bg-slate-700"></div>
      <span class="text-[10px] text-slate-400 shrink-0">${escapeHtml(containerName)} · ${escapeHtml(actionValue)} · ${escapeHtml(foundInList.name || targetSkillId)}</span>
      <div class="flex-1 h-px bg-slate-200 dark:bg-slate-700"></div>
    `;
    $runStream.appendChild(divider);
    scrollToBottom();

    const inputs = { action: actionValue, [inputKey]: containerName };
    const hostId = $hostSelect.value;
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // 切换到运行态（不清除 stream）
    $btnRun.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    $btnNew.classList.add('hidden');
    currentTurn = 0;
    $runTurn.textContent = '第 0 轮';
    setRunStatus('starting', 'AI 启动中');
    startElapsedTimer();
    currentRunId = runId;

    socket.emit('skill:run', {
      runId,
      skillId: targetSkillId,
      hostId,
      inputs,
      rescuerSkillId: $rescuerSelect?.value || '',
    }, (res) => {
      if (!res.ok) {
        appendSystemMessage(`启动失败: ${res.error}`, 'error');
        finalizeRun('error');
      }
    });
  }

  function renderKeyValue(p) {
    const items = Array.isArray(p.items) ? p.items : [];
    if (items.length === 0) return '<div class="text-xs text-slate-400 italic">（无内容）</div>';
    return `
      <div class="grid grid-cols-1 gap-1.5">
        ${items.map(item => `
          <div class="flex items-start gap-3 text-xs">
            <div class="w-24 shrink-0 text-slate-500 dark:text-slate-400">${escapeHtml(item.key || '')}</div>
            <div class="flex-1 text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap break-all">${escapeHtml(String(item.value == null ? '' : item.value))}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderList(p) {
    const items = Array.isArray(p.listItems) ? p.listItems : [];
    if (items.length === 0) return '<div class="text-xs text-slate-400 italic">（空）</div>';
    return `
      <div class="flex flex-col gap-2">
        ${items.map(item => `
          <div class="border-l-2 border-blue-300 dark:border-blue-500/60 pl-3">
            <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escapeHtml(item.title || '')}</div>
            ${item.description ? `<div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(item.description)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderMessage(p) {
    return `<div class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">${escapeHtml(p.content || '')}</div>`;
  }

  // ─── ask_user 渲染 ────────────────────────────────────────────────
  function appendAsk(msg) {
    const p = msg.payload || {};
    const el = document.createElement('div');
    el.className = 'ask-card';
    el.dataset.toolUseId = msg.toolUseId;
    setRunStatus('waiting', '等待你回复');

    let bodyHtml = '';
    if (p.type === 'select') {
      bodyHtml = renderAskSelect(p, msg.toolUseId);
    } else if (p.type === 'confirm') {
      bodyHtml = renderAskConfirm(p, msg.toolUseId);
    } else if (p.type === 'input') {
      bodyHtml = renderAskInput(p, msg.toolUseId);
    } else {
      bodyHtml = `<div class="text-xs text-slate-400">未知交互类型: ${escapeHtml(p.type)}</div>`;
    }

    el.innerHTML = `
      <div class="flex items-center gap-2 text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-2">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
        等待你的操作
      </div>
      <div class="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">${escapeHtml(p.title || '请选择')}</div>
      ${p.description ? `<div class="text-[11px] text-slate-500 dark:text-slate-400 whitespace-pre-wrap mb-3">${escapeHtml(p.description)}</div>` : '<div class="mb-3"></div>'}
      ${bodyHtml}
    `;
    $runStream.appendChild(el);
    scrollToBottom();
    bindAskHandlers(el, msg.toolUseId, p);
  }

  function renderAskSelect(p, toolUseId) {
    const options = Array.isArray(p.options) ? p.options : [];
    if (options.length === 0) {
      return '<div class="text-xs text-red-400">选项为空</div>';
    }
    return `
      <div class="flex flex-col gap-2 max-w-xl">
        ${options.map((opt, i) => `
          <button class="interact-option" data-opt-index="${i}">
            <div class="text-xs font-bold text-slate-700 dark:text-slate-200">${escapeHtml(opt.label || opt.value || '')}</div>
            ${opt.description ? `<div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(opt.description)}</div>` : ''}
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderAskConfirm(p, toolUseId) {
    const confirmLabel = p.confirmLabel || '确认';
    const cancelLabel = p.cancelLabel || '取消';
    const confirmClass = p.danger
      ? 'bg-red-500 hover:bg-red-600 text-white'
      : 'bg-gradient-to-r from-blue-500 to-purple-500 hover:shadow-lg text-white';
    return `
      <div class="flex items-center gap-2 max-w-xl">
        <button class="ask-confirm h-9 px-4 rounded-lg ${confirmClass} text-xs font-semibold shadow-md transition-all">${escapeHtml(confirmLabel)}</button>
        <button class="ask-cancel h-9 px-4 rounded-lg border border-slate-300 dark:border-slate-600 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">${escapeHtml(cancelLabel)}</button>
      </div>
    `;
  }

  function renderAskInput(p, toolUseId) {
    return `
      <div class="flex items-center gap-2 max-w-xl">
        <input class="ask-input flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-[#0b1324] text-xs outline-none focus:border-blue-400"
          type="text" placeholder="${escapeHtml(p.placeholder || '')}" value="${escapeHtml(p.defaultValue || '')}" />
        <button class="ask-submit h-9 px-4 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all">提交</button>
      </div>
    `;
  }

  function bindAskHandlers(el, toolUseId, p) {
    if (p.type === 'select') {
      el.querySelectorAll('.interact-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.optIndex, 10);
          const opt = (p.options || [])[i];
          if (!opt) return;
          submitAnswer(el, toolUseId, { value: opt.value, label: opt.label });
        });
      });
    } else if (p.type === 'confirm') {
      el.querySelector('.ask-confirm')?.addEventListener('click', () => {
        submitAnswer(el, toolUseId, { confirmed: true });
      });
      el.querySelector('.ask-cancel')?.addEventListener('click', () => {
        submitAnswer(el, toolUseId, { confirmed: false });
      });
    } else if (p.type === 'input') {
      const input = el.querySelector('.ask-input');
      const submit = () => submitAnswer(el, toolUseId, { value: input?.value || '' });
      el.querySelector('.ask-submit')?.addEventListener('click', submit);
      input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      input?.focus();
    }
  }

  function submitAnswer(el, toolUseId, answer) {
    if (!currentRunId) return;
    socket.emit('skill:continue', { runId: currentRunId, toolUseId, answer }, (res) => {
      if (!res.ok) {
        showToast(`提交失败: ${res.error || '未知错误'}`, 'error');
        return;
      }
      // 锁定卡片
      el.classList.add('answered');
      el.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
      // 追加已回复摘要
      const summary = document.createElement('div');
      summary.className = 'mt-3 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1';
      let answerText = '';
      if (answer.value) answerText = String(answer.label || answer.value);
      else if (answer.confirmed === true) answerText = '已确认';
      else if (answer.confirmed === false) answerText = '已取消';
      summary.innerHTML = `<span class="text-emerald-500">\u2714</span> 你的回复：<strong class="text-slate-700 dark:text-slate-200">${escapeHtml(answerText)}</strong>`;
      el.appendChild(summary);
      setRunStatus('running', 'AI 思考中');
    });
  }

  // ─── Playbook 模式渲染 ─────────────────────────────────────────────

  function setModeBadge(mode) {
    $runModeBadge.classList.remove('hidden');
    const configs = {
      'playbook':   { text: '⚡ Playbook',  cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' },
      'ai-loop':    { text: '🤖 AI-loop',   cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' },
      'ai-rescue':  { text: '🛠 AI-Rescue', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' },
    };
    const cfg = configs[mode] || configs['ai-loop'];
    $runModeBadge.textContent = cfg.text;
    $runModeBadge.className = `text-[9px] px-1.5 py-0.5 rounded font-semibold ${cfg.cls}`;
  }

  function updateStepProgress() {
    if (currentMode === 'playbook' || currentMode === 'ai-rescue') {
      $runTurn.textContent = `步骤 ${stepsDone}`;
    }
  }

  // playbook exec step 开始时插入一个轻量行
  function appendPlaybookStep(msg) {
    const el = document.createElement('div');
    el.className = 'step-item step-playbook';
    el.dataset.stepId = msg.stepId;
    el.innerHTML = `
      <div class="flex items-center gap-2 text-[11px]">
        <span class="thinking-pulse text-slate-400">⋯</span>
        <span class="step-pb-label text-slate-500 dark:text-slate-400">${escapeHtml(msg.label || msg.stepId)}</span>
        <span class="ml-auto text-slate-400 step-pb-dur tabular-nums"></span>
      </div>
    `;
    $runStream.appendChild(el);
    stepIndex.set(msg.stepId, { el, type: 'playbook-step' });
    scrollToBottom();
  }

  function markPlaybookStep(stepId, state, durationMs, reason) {
    const entry = stepIndex.get(stepId);
    if (!entry) return;
    const el = entry.el;
    const pulse = el.querySelector('.thinking-pulse');
    const durEl = el.querySelector('.step-pb-dur');

    el.classList.remove('running');
    if (state === 'verified') {
      el.classList.add('verified');
      if (pulse) { pulse.classList.remove('thinking-pulse'); pulse.textContent = '✔'; pulse.className = 'text-emerald-500'; }
      if (durEl && durationMs != null) durEl.textContent = `${durationMs} ms`;
    } else {
      el.classList.add('failed');
      if (pulse) { pulse.classList.remove('thinking-pulse'); pulse.textContent = '✘'; pulse.className = 'text-red-400'; }
      if (reason) {
        const reasonEl = document.createElement('div');
        reasonEl.className = 'text-[10px] text-red-500 dark:text-red-400 mt-1 pl-4';
        reasonEl.textContent = reason;
        el.appendChild(reasonEl);
      }
    }
    scrollToBottom();
  }

  function appendRescueBanner(stepId) {
    const entry = stepId ? stepIndex.get(stepId) : null;
    const label = entry ? entry.el.querySelector('.step-pb-label')?.textContent : stepId;
    const el = document.createElement('div');
    el.className = 'rescue-banner';
    el.innerHTML = `
      <span class="text-base">🛠</span>
      <span>AI Rescue 已介入${label ? `（步骤：${escapeHtml(label)}）` : ''}，正在分析错误并修复…</span>
    `;
    $runStream.appendChild(el);
    scrollToBottom();
  }

  function appendRunSummary(msg) {
    const elapsed = elapsedSeconds;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const isPlaybook = msg.reason === 'playbook_complete';

    const el = document.createElement('div');
    el.className = 'run-summary';

    const tokenText = isPlaybook
      ? '<span class="text-emerald-600 dark:text-emerald-400 font-semibold">0 token</span>'
      : `<span class="text-blue-600 dark:text-blue-400 font-semibold">${msg.turns || 0} 轮 AI 调用</span>`;

    const rescueText = (msg.rescueCount > 0)
      ? `<span class="text-amber-600 dark:text-amber-400">· AI Rescue ${msg.rescueCount} 次</span>`
      : '';

    const modeText = isPlaybook
      ? '<span class="text-emerald-600 dark:text-emerald-400">⚡ Playbook</span>'
      : '<span class="text-blue-600 dark:text-blue-400">🤖 AI-loop</span>';

    el.innerHTML = `
      <span class="text-slate-300 dark:text-slate-600">──</span>
      ${modeText}
      <span class="text-slate-300 dark:text-slate-600 mx-1">·</span>
      耗时 ${mm}:${ss}
      <span class="text-slate-300 dark:text-slate-600 mx-1">·</span>
      ${tokenText}
      ${rescueText}
    `;
    $runStream.appendChild(el);
    scrollToBottom();
  }

  // ─── 系统消息 ──────────────────────────────────────────────────────
  function appendSystemMessage(text, level = 'info') {
    const el = document.createElement('div');
    el.className = `render-card level-${level} p-3`;
    el.innerHTML = `<div class="text-xs ${level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}">${escapeHtml(text)}</div>`;
    $runStream.appendChild(el);
    scrollToBottom();
  }

  // ─── 事件绑定 ───────────────────────────────────────────────────────
  function bindEvents() {
    $skillList.addEventListener('click', (e) => {
      const card = e.target.closest('.skill-card');
      if (!card) return;
      selectSkill(card.dataset.skillId);
    });

    $btnRun.addEventListener('click', executeSkill);
    $btnStop.addEventListener('click', stopRun);
    $btnNew.addEventListener('click', () => {
      resetToForm();
      renderInputForm();
    });

    // ─── 创建 Skill 按钮 → 触发 skill-authoring ──────────────────
    $btnCreateSkill?.addEventListener('click', () => openSkillAuthoringModal());
  }

  // ─── Skill 创作台 Modal ──────────────────────────────────────────
  function openSkillAuthoringModal() {
    const modalRoot = document.getElementById('modal-root') || document.body;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center';
    el.style.animation = 'fadein 0.15s ease';
    el.innerHTML = `<div class="bg-white dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-2xl w-full max-w-lg mx-4" style="animation:slideup 0.2s ease">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">✍️ Skill 创作台</div>
        <div class="text-[11px] text-slate-400">描述你想自动化的任务，AI 帮你生成完整的 Skill</div>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3">
        <div>
          <label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">你想自动化什么？ <span class="text-red-400">*</span></label>
          <textarea id="author-task" rows="3" placeholder="例如：备份 MySQL 数据库到 /var/backups，保留最近 7 天&#10;例如：部署 Node.js 应用，拉取代码、安装依赖、用 pm2 重启&#10;例如：检查磁盘使用率，超过 90% 时发邮件告警" class="w-full px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 dark:bg-[#0b1324] dark:border-[#1e293b] text-xs outline-none focus:border-blue-400 resize-none"></textarea>
        </div>
        <div>
          <label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">操作</label>
          <select id="author-mode" class="w-full h-8 px-2 rounded-lg border border-slate-200 bg-slate-50 dark:bg-[#0b1324] dark:border-[#1e293b] text-xs outline-none focus:border-blue-400">
            <option value="generate">创建新 Skill</option>
            <option value="refine">修改已有 Skill</option>
            <option value="explain">解释某个 Skill</option>
          </select>
        </div>
        <div id="author-skill-id-row" class="hidden">
          <label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Skill ID</label>
          <input id="author-skill-id" type="text" placeholder="例如：deploy-app" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 dark:bg-[#0b1324] dark:border-[#1e293b] text-xs font-mono outline-none focus:border-blue-400" />
        </div>
        <div class="text-[10px] text-slate-400 bg-blue-50 dark:bg-blue-500/10 rounded-lg px-3 py-2">
          AI 将在目标主机的 <code class="font-mono">data/skills/</code> 目录下生成完整的 Skill 文件，生成后可在此页面直接运行。
        </div>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2 justify-end">
        <button class="inline-flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer author-cancel">取消</button>
        <button class="inline-flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 text-white font-semibold hover:opacity-90 cursor-pointer author-start">✍️ 开始创作</button>
      </div>
    </div>`;

    modalRoot.appendChild(el);
    el.querySelector('.author-cancel').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    const modeSelect = el.querySelector('#author-mode');
    const skillIdRow = el.querySelector('#author-skill-id-row');
    modeSelect.addEventListener('change', () => {
      skillIdRow.classList.toggle('hidden', modeSelect.value === 'generate');
    });

    el.querySelector('.author-start').addEventListener('click', () => {
      const task = el.querySelector('#author-task').value.trim();
      const mode = modeSelect.value;
      const skillId = el.querySelector('#author-skill-id')?.value.trim() || '';

      if (!task && mode === 'generate') { showToast('请描述你想自动化的任务', 'warn'); return; }
      if (mode !== 'generate' && !skillId) { showToast('请输入 Skill ID', 'warn'); return; }

      el.remove();

      // 选中 skill-authoring 并填入参数后直接运行
      const authoringSkill = skills.find(s => s.id === 'skill-authoring');
      if (!authoringSkill) {
        showToast('skill-authoring 未找到，请刷新页面重试', 'error');
        return;
      }

      // selectSkill + renderInputForm 是同步的，rAF 确保 DOM 已刷新
      selectSkill('skill-authoring');
      requestAnimationFrame(() => {
        const taskEl = document.querySelector('[data-input-name="task"]');
        const modeEl = document.querySelector('[data-input-name="mode"]');
        const sidEl  = document.querySelector('[data-input-name="skill_id"]');
        if (taskEl) { taskEl.value = task; taskEl.dispatchEvent(new Event('input')); }
        if (modeEl) { modeEl.value = mode; modeEl.dispatchEvent(new Event('change')); }
        if (sidEl && skillId) sidEl.value = skillId;
        executeSkill();
      });
    });
  }

  init();
})();
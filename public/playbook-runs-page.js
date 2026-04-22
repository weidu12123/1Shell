(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast, showErrorMessage } = window.appShared;
  const requestJson = createRequestJson({
    onUnauthorized: () => { window.location.href = 'index.html'; },
  });

  // 每个 run 的聚合状态
  // runId → { meta, status: running|done|error|cancelled, events: [], lastTouched }
  const runs = new Map();
  let focusedRunId = null;
  let socket = null;

  const $runList   = document.getElementById('run-list');
  const $runCount  = document.getElementById('run-count');
  const $stream    = document.getElementById('event-stream');
  const $focusTitle = document.getElementById('focus-title');
  const $btnStop   = document.getElementById('btn-stop');
  const $btnRefresh = document.getElementById('btn-refresh');

  async function init() {
    initSocket();
    await loadActive();
    bindEvents();
    setInterval(loadActive, 10000); // 慢速兜底轮询
  }

  async function loadActive() {
    try {
      const data = await requestJson('/api/runs/active');
      const active = data.runs || [];
      // 合并：服务端在跑的 run 如果本地没有，就补一条
      for (const r of active) {
        if (!runs.has(r.runId)) {
          runs.set(r.runId, {
            meta: r,
            status: 'running',
            events: [],
            lastTouched: Date.now(),
          });
        } else {
          // 补充缺失的 meta
          Object.assign(runs.get(r.runId).meta, r);
        }
      }
      renderRunList();
    } catch { /* 静默 */ }
  }

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('skill:run-started', (msg) => {
      ensureRun(msg.runId, {
        itemId: msg.skillId,
        itemName: msg.skillId,
        hostId: msg.hostId,
        hostName: msg.hostName,
        mode: msg.mode || 'ai-loop',
        startedAt: Date.now(),
      });
      touch(msg.runId, 'info', `→ 运行开始 (${msg.mode || 'ai-loop'})`);
    });

    socket.on('skill:thinking', (msg) => touch(msg.runId, 'info', `· 第 ${msg.turn ?? '?'} 轮思考`));
    socket.on('skill:thought', (msg) => { if (msg.text?.trim()) touch(msg.runId, 'thought', msg.text); });

    socket.on('skill:exec', (msg) => touch(msg.runId, 'info', `$ ${msg.command || ''}`));
    socket.on('skill:exec-result', (msg) => {
      if (msg.stdout) touch(msg.runId, 'stdout', truncate(msg.stdout));
      if (msg.stderr) touch(msg.runId, 'stderr', truncate(msg.stderr));
      touch(msg.runId, 'info', `  exit=${msg.exitCode ?? '?'} · ${msg.durationMs ?? 0}ms`);
    });
    socket.on('skill:render', (msg) => {
      const p = msg.payload || {};
      touch(msg.runId, 'success', `▣ ${p.title || p.format || 'render'}${p.subtitle ? ' — ' + p.subtitle : ''}`);
    });
    socket.on('skill:info', (msg) => touch(msg.runId, 'info', msg.message || ''));
    socket.on('skill:step-started', (msg) => touch(msg.runId, 'info', `▸ step ${msg.stepId || ''} ${msg.type || ''}`));
    socket.on('skill:step-verified', (msg) => touch(msg.runId, 'success', `✓ step ${msg.stepId || ''}`));
    socket.on('skill:step-failed', (msg) => touch(msg.runId, 'error', `✘ step ${msg.stepId || ''}: ${msg.error || ''}`));

    socket.on('skill:done', (msg) => { setStatus(msg.runId, 'done'); touch(msg.runId, 'success', `✔ 完成 (${msg.turns ?? 0} 轮)`); });
    socket.on('skill:error', (msg) => { setStatus(msg.runId, 'error'); touch(msg.runId, 'error', `✘ ${msg.error || '未知错误'}`); });
    socket.on('skill:cancelled', (msg) => { setStatus(msg.runId, 'cancelled'); touch(msg.runId, 'error', '已取消'); });
  }

  function ensureRun(runId, partialMeta) {
    if (!runId) return;
    if (!runs.has(runId)) {
      runs.set(runId, {
        meta: partialMeta || {},
        status: 'running',
        events: [],
        lastTouched: Date.now(),
      });
      renderRunList();
    } else if (partialMeta) {
      Object.assign(runs.get(runId).meta, partialMeta);
    }
  }

  function setStatus(runId, status) {
    if (!runId) return;
    ensureRun(runId);
    const r = runs.get(runId);
    r.status = status;
    r.endedAt = Date.now();
    renderRunList();
    if (runId === focusedRunId) updateStopButtonVisibility();
  }

  function touch(runId, kind, text) {
    if (!runId) return;
    ensureRun(runId);
    const r = runs.get(runId);
    r.events.push({ kind, text, t: Date.now() });
    r.lastTouched = Date.now();
    // 限制单 run 事件数量
    if (r.events.length > 500) r.events.splice(0, r.events.length - 500);
    if (runId === focusedRunId) appendEventLine(kind, text);
  }

  function truncate(s) {
    const t = String(s || '').trim();
    return t.length > 1000 ? t.slice(0, 1000) + '\n...[truncated]' : t;
  }

  // ─── 渲染 ───
  function renderRunList() {
    const entries = [...runs.entries()].sort((a, b) => (b[1].lastTouched || 0) - (a[1].lastTouched || 0));
    $runCount.textContent = String(entries.length);
    if (entries.length === 0) {
      $runList.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-10">暂无运行。<br/>从"剧本库"或"素材库"启动 Skill/Playbook 会出现在这里。</div>';
      return;
    }
    $runList.innerHTML = entries.map(([runId, r]) => {
      const m = r.meta || {};
      const active = focusedRunId === runId ? 'active' : '';
      const statusPill = {
        running: '<span class="pill pill-running">运行中</span>',
        done: '<span class="pill pill-success">完成</span>',
        error: '<span class="pill pill-error">出错</span>',
        cancelled: '<span class="pill pill-cancelled">取消</span>',
      }[r.status] || '<span class="pill pill-running">—</span>';
      const modeBadge = m.mode === 'playbook'
        ? '<span class="pill pill-success">⚡ 直跑</span>'
        : '<span class="pill pill-running">🤖 AI</span>';
      const elapsed = m.startedAt ? Math.max(0, (r.endedAt || Date.now()) - m.startedAt) : 0;
      return `<div class="run-card ${active} p-3 cursor-pointer" data-run-id="${escapeHtml(runId)}">
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="text-xs font-semibold truncate">${escapeHtml(m.itemName || m.itemId || runId)}</div>
            <div class="text-[10px] text-slate-400 font-mono mt-0.5">
              ${escapeHtml(String(m.hostName || m.hostId || '?'))} · ${formatElapsed(elapsed)}
            </div>
          </div>
          <div class="flex flex-col items-end gap-1">
            ${statusPill}
            ${modeBadge}
          </div>
        </div>
      </div>`;
    }).join('');
    $runList.querySelectorAll('[data-run-id]').forEach(el => {
      el.addEventListener('click', () => focus(el.dataset.runId));
    });
  }

  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60}s`;
    return `${Math.floor(m / 60)}h${m % 60}m`;
  }

  function focus(runId) {
    focusedRunId = runId;
    const r = runs.get(runId);
    if (!r) return;
    const m = r.meta || {};
    $focusTitle.textContent = `${m.itemName || m.itemId || runId}  ·  ${m.hostName || m.hostId || ''}  ·  ${runId}`;
    $stream.innerHTML = '';
    for (const ev of r.events) appendEventLine(ev.kind, ev.text);
    renderRunList();
    updateStopButtonVisibility();
  }

  function appendEventLine(kind, text) {
    const line = document.createElement('div');
    line.className = 'ev ' + kind;
    line.textContent = text;
    $stream.appendChild(line);
    $stream.scrollTop = $stream.scrollHeight;
  }

  function updateStopButtonVisibility() {
    const r = focusedRunId ? runs.get(focusedRunId) : null;
    if (r && r.status === 'running') $btnStop.classList.remove('hidden');
    else $btnStop.classList.add('hidden');
  }

  function bindEvents() {
    $btnRefresh.addEventListener('click', loadActive);
    $btnStop.addEventListener('click', async () => {
      if (!focusedRunId) return;
      try {
        await requestJson(`/api/runs/${encodeURIComponent(focusedRunId)}/cancel`, { method: 'POST' });
        showToast?.('已请求停止', 'info');
      } catch (err) {
        showErrorMessage?.(err);
      }
    });
    // 定时刷新运行列表的 elapsed 秒数
    setInterval(renderRunList, 1000);
  }

  init();
})();
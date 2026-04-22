(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast } = window.appShared;
  const requestJson = createRequestJson({ onUnauthorized: () => { window.location.href = 'index.html'; } });

  // ─── DOM ────────────────────────────────────────────────────────────
  const $hostSelect  = document.getElementById('host-select');
  const $btnRefresh  = document.getElementById('btn-refresh');
  const $tableBody   = document.getElementById('table-body');
  const $tableStatus = document.getElementById('table-status');
  const $filterInput = document.getElementById('filter-input');
  const $modalRoot   = document.getElementById('modal-root');
  const $slideRoot   = document.getElementById('slide-root');

  const $statRunning = document.getElementById('stat-running');
  const $statStopped = document.getElementById('stat-stopped');
  const $statTotal   = document.getElementById('stat-total');
  const $statImages  = document.getElementById('stat-images');

  // ─── 状态 ───────────────────────────────────────────────────────────
  let hosts = [];
  let containers = [];   // 解析后的容器对象数组
  let loading = false;

  // ─── 直接执行 ───────────────────────────────────────────────────────
  async function exec(command, timeout) {
    const hostId = getHostId();
    const res = await requestJson('/api/exec', {
      method: 'POST',
      body: JSON.stringify({ hostId, command, timeout: timeout || 30000 }),
    });
    return res;
  }

  // ─── 初始化 ─────────────────────────────────────────────────────────
  async function init() {
    await loadHosts();
    bindEvents();
    // 尝试从缓存渲染
    const cached = loadCache();
    if (cached) {
      containers = cached;
      renderTable();
      $tableStatus.textContent = `缓存 · 共 ${containers.length} 个容器（正在刷新…）`;
      // 有缓存也在后台静默刷新，避免数据陈旧
      loadContainerList();
    } else {
      // 无缓存：直接拉取，否则页面会一直空白等用户手动点刷新
      loadContainerList();
    }
  }

  async function loadHosts() {
    try {
      const data = await requestJson('/api/hosts');
      hosts = data.hosts || data || [];
      $hostSelect.innerHTML = '<option value="local">\u{1F5A5} 本机</option>';
      for (const h of hosts) {
        if (h.id === 'local') continue;
        const opt = document.createElement('option');
        opt.value = h.id;
        opt.textContent = `${h.name} (${h.host})`;
        $hostSelect.appendChild(opt);
      }
      const last = localStorage.getItem('1shell-last-host');
      if (last && $hostSelect.querySelector(`option[value="${last}"]`)) {
        $hostSelect.value = last;
      }
    } catch { /* 静默 */ }
  }

  function getHostId() { return $hostSelect.value || 'local'; }

  // ─── 缓存 ─────────────────────────────────────────────────────────
  function cacheKey() { return `1shell-ct:${getHostId()}`; }
  function saveCache(data) {
    try { sessionStorage.setItem(cacheKey(), JSON.stringify(data)); } catch {}
  }
  function loadCache() {
    try { const r = sessionStorage.getItem(cacheKey()); return r ? JSON.parse(r) : null; } catch { return null; }
  }

  // ─── 加载容器列表（直接执行，不经过 AI）────────────────────────────
  async function loadContainerList() {
    if (loading) return;
    loading = true;
    $btnRefresh.disabled = true;
    $btnRefresh.textContent = '加载中…';

    // 如果还没有数据就显示骨架
    if (containers.length === 0) showSkeleton();
    $tableStatus.textContent = '加载中…';

    try {
      const res = await exec("docker ps -a --format '{{json .}}'");

      if (res.exitCode !== 0) {
        // 可能需要 sudo
        if (/permission denied/i.test(res.stderr || '')) {
          const retry = await exec("sudo docker ps -a --format '{{json .}}'");
          if (retry.exitCode === 0) {
            containers = parseDockerPs(retry.stdout);
          } else {
            throw new Error(retry.stderr || '权限不足，请将用户加入 docker 组');
          }
        } else if (/not found|not recognized/i.test(res.stderr || res.stdout || '')) {
          throw new Error('Docker 未安装');
        } else {
          throw new Error(res.stderr || `exitCode: ${res.exitCode}`);
        }
      } else {
        containers = parseDockerPs(res.stdout);
      }

      saveCache(containers);
      renderTable();
      $tableStatus.textContent = `共 ${containers.length} 个容器`;
    } catch (err) {
      showTableError(err.message || '加载失败');
    } finally {
      loading = false;
      $btnRefresh.disabled = false;
      $btnRefresh.textContent = '\u21BB 刷新';
    }
  }

  function parseDockerPs(stdout) {
    if (!stdout || !stdout.trim()) return [];
    return stdout.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  // ─── 表格渲染 ───────────────────────────────────────────────────────
  function renderTable() {
    const filter = ($filterInput.value || '').toLowerCase().trim();
    const filtered = filter
      ? containers.filter(c => (c.Names || '').toLowerCase().includes(filter) || (c.Image || '').toLowerCase().includes(filter))
      : containers;

    // 统计
    let running = 0, stopped = 0;
    const imageSet = new Set();
    for (const c of containers) {
      if (/^Up /i.test(c.Status || '')) running++; else stopped++;
      if (c.Image) imageSet.add(c.Image);
    }
    $statRunning.textContent = running;
    $statStopped.textContent = stopped;
    $statTotal.textContent = containers.length;
    $statImages.textContent = imageSet.size;

    if (filtered.length === 0) {
      $tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-slate-400 py-8">${
        filter ? '没有匹配的容器' : '当前无容器'
      }</td></tr>`;
      return;
    }

    // 排序：running 在前
    filtered.sort((a, b) => {
      const aUp = /^Up /i.test(a.Status || '') ? 0 : 1;
      const bUp = /^Up /i.test(b.Status || '') ? 0 : 1;
      return aUp - bUp || (a.Names || '').localeCompare(b.Names || '');
    });

    $tableBody.innerHTML = filtered.map(c => {
      const name = c.Names || c.ID || '';
      const image = c.Image || '';
      const status = c.Status || '';
      const ports = c.Ports || '';
      const created = c.CreatedAt || '';
      const isProtected = /1shell/i.test(name);
      const isRunning = /^Up /i.test(status);

      const badgeClass = isRunning ? 'badge-running' : 'badge-exited';
      const badgeText = isRunning ? 'Running' : 'Stopped';

      const actions = isProtected
        ? `<span class="badge badge-protected">&#128737; 受保护</span>`
        : `<button class="act-btn act-btn-default" data-act="inspect" data-name="${escapeHtml(name)}" title="详情">&#128269;</button>
           <button class="act-btn act-btn-default" data-act="logs" data-name="${escapeHtml(name)}" title="日志">&#128196;</button>
           ${isRunning
             ? `<button class="act-btn act-btn-default" data-act="restart" data-name="${escapeHtml(name)}" title="重启">&#8635;</button>
                <button class="act-btn act-btn-default" data-act="stop" data-name="${escapeHtml(name)}" title="停止">&#9632;</button>`
             : `<button class="act-btn act-btn-primary" data-act="start" data-name="${escapeHtml(name)}" title="启动">&#9654;</button>`
           }
           <button class="act-btn act-btn-danger" data-act="remove" data-name="${escapeHtml(name)}" title="删除">&#128465;</button>`;

      return `<tr data-container="${escapeHtml(name)}">
        <td class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(name)}</td>
        <td class="font-mono text-[11px] text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title="${escapeHtml(image)}">${escapeHtml(image)}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
        <td class="text-[11px] text-slate-500 dark:text-slate-400 max-w-[180px] truncate" title="${escapeHtml(ports)}">${escapeHtml(ports) || '-'}</td>
        <td class="text-[11px] text-slate-400 whitespace-nowrap">${escapeHtml(created)}</td>
        <td class="text-right whitespace-nowrap">${actions}</td>
      </tr>`;
    }).join('');
  }

  function showSkeleton() {
    const row = `<tr><td><div class="skeleton h-4 w-32"></div></td><td><div class="skeleton h-4 w-40"></div></td><td><div class="skeleton h-4 w-20"></div></td><td><div class="skeleton h-4 w-28"></div></td><td><div class="skeleton h-4 w-24"></div></td><td><div class="skeleton h-4 w-32 ml-auto"></div></td></tr>`;
    $tableBody.innerHTML = row.repeat(5);
  }

  function showTableError(error) {
    $tableBody.innerHTML = `<tr><td colspan="6" class="text-center py-8">
      <div class="text-red-500 dark:text-red-400 mb-2">${escapeHtml(error)}</div>
      <button class="act-btn act-btn-primary" id="retry-btn">重试</button>
    </td></tr>`;
    $tableStatus.textContent = '加载失败';
    document.getElementById('retry-btn')?.addEventListener('click', loadContainerList);
  }

  // ─── 行操作 ─────────────────────────────────────────────────────────
  function handleAction(action, name) {
    if (loading) { showToast('正在加载中', 'warn'); return; }
    if (action === 'inspect') { openInspectPanel(name); return; }
    if (action === 'logs') { openLogsModal(name); return; }
    if (action === 'remove') { openRemoveConfirm(name); return; }
    // start / stop / restart
    doLifecycle(action, name);
  }

  // ─── 生命周期操作（start/stop/restart）─────────────────────────────
  async function doLifecycle(action, name) {
    const labels = { start: '启动', stop: '停止', restart: '重启' };
    const label = labels[action] || action;

    // 乐观更新状态
    const row = $tableBody.querySelector(`tr[data-container="${CSS.escape(name)}"]`);
    const badge = row?.querySelector('.badge');
    if (badge) { badge.className = 'badge badge-loading'; badge.textContent = label + '中…'; }

    // 禁用该行按钮
    row?.querySelectorAll('.act-btn').forEach(b => { b.disabled = true; });

    try {
      const res = await exec(`docker ${action} ${shellEscape(name)}`);
      if (res.exitCode !== 0) {
        throw new Error(res.stderr || `${label}失败 (exitCode: ${res.exitCode})`);
      }
      showToast(`${name} 已${label}`, 'success');
    } catch (err) {
      showToast(`${label}失败: ${err.message}`, 'error');
    }

    // 刷新列表
    await loadContainerList();
  }

  // ─── 删除确认 ──────────────────────────────────────────────────────
  function openRemoveConfirm(name) {
    // 先检查保护
    if (/1shell/i.test(name)) {
      showToast('受保护容器，禁止删除', 'error');
      return;
    }

    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-red-600 dark:text-red-400">&#9888; 确认删除容器</div>
      </div>
      <div class="px-5 py-5">
        <p class="text-xs text-slate-600 dark:text-slate-300 mb-4">即将删除容器 <strong>${escapeHtml(name)}</strong>。此操作不可撤销。挂载卷数据仍在宿主机上，需手动清理。</p>
        <div class="flex gap-2 justify-end">
          <button class="act-btn act-btn-default modal-cancel">取消</button>
          <button class="act-btn act-btn-danger modal-confirm">确认删除</button>
        </div>
      </div>
    </div>`;

    $modalRoot.appendChild(el);
    el.querySelector('.modal-cancel').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    el.querySelector('.modal-confirm').addEventListener('click', async () => {
      const body = el.querySelector('.modal-box > div:last-child');
      body.innerHTML = `<div class="flex flex-col items-center gap-3 py-4">
        <div class="relative w-10 h-10"><div class="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700"></div><div class="absolute inset-0 rounded-full border-4 border-transparent border-t-red-500 animate-spin"></div></div>
        <div class="text-xs text-slate-500">正在删除…</div>
      </div>`;

      try {
        // 先停止（忽略错误）
        await exec(`docker stop ${shellEscape(name)}`, 15000).catch(() => {});
        const res = await exec(`docker rm ${shellEscape(name)}`);
        if (res.exitCode !== 0) throw new Error(res.stderr || '删除失败');
        showToast(`${name} 已删除`, 'success');
        el.remove();
        await loadContainerList();
      } catch (err) {
        body.innerHTML = `<div class="flex flex-col items-center gap-3 py-4">
          <div class="text-red-500 text-2xl">&#10007;</div>
          <div class="text-xs text-red-500">${escapeHtml(err.message)}</div>
          <button class="act-btn act-btn-default modal-ok">关闭</button>
        </div>`;
        body.querySelector('.modal-ok')?.addEventListener('click', () => el.remove());
      }
    });
  }

  // ─── 查看详情（右滑面板）──────────────────────────────────────────
  async function openInspectPanel(name) {
    closeSlidePanel();

    const backdrop = document.createElement('div');
    backdrop.className = 'slide-backdrop';
    const panel = document.createElement('div');
    panel.className = 'slide-panel flex flex-col';
    panel.innerHTML = `
      <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-3">
        <span class="text-xl">&#128269;</span>
        <div><div class="text-sm font-bold text-slate-700 dark:text-slate-200">容器详情</div><div class="text-[11px] text-slate-400">${escapeHtml(name)}</div></div>
        <div class="flex-1"></div>
        <button class="slide-close text-slate-400 hover:text-slate-600 text-lg">&times;</button>
      </div>
      <div class="flex-1 overflow-y-auto p-5 slide-body">
        ${Array.from({length: 8}, () => `<div class="flex gap-3 mb-2"><div class="skeleton h-4 w-24"></div><div class="skeleton h-4 flex-1"></div></div>`).join('')}
      </div>`;

    $slideRoot.appendChild(backdrop);
    $slideRoot.appendChild(panel);
    backdrop.addEventListener('click', closeSlidePanel);
    panel.querySelector('.slide-close').addEventListener('click', closeSlidePanel);

    try {
      // inspect 是必须的，stats 是可选的（可能超时或失败）
      const inspectRes = await exec(`docker inspect ${shellEscape(name)} --format '{{json .}}'`, 15000);

      let info = {};
      let stats = {};
      try { info = JSON.parse(inspectRes.stdout?.trim() || '{}'); } catch {}

      // stats 单独拉，5 秒超时，失败不阻塞
      try {
        const statsRes = await exec(`docker stats ${shellEscape(name)} --no-stream --format '{{json .}}'`, 8000);
        if (statsRes.exitCode === 0 && statsRes.stdout?.trim()) {
          stats = JSON.parse(statsRes.stdout.trim());
        }
      } catch { /* stats 超时或失败，跳过 */ }
      const items = [
        { key: '名称', value: info.Name || name },
        { key: '镜像', value: info.Config?.Image || '' },
        { key: '状态', value: info.State?.Status || '' },
        { key: '启动时间', value: info.State?.StartedAt || '' },
        { key: '重启次数', value: String(info.RestartCount ?? '') },
        { key: '端口映射', value: formatPorts(info.NetworkSettings?.Ports) },
        { key: 'CPU', value: stats.CPUPerc || '-' },
        { key: '内存', value: stats.MemUsage || '-' },
        { key: '网络 I/O', value: stats.NetIO || '-' },
        { key: '磁盘 I/O', value: stats.BlockIO || '-' },
        { key: '挂载卷', value: formatMounts(info.Mounts) },
        { key: 'PID', value: String(stats.PIDs || '') },
      ];

      const body = panel.querySelector('.slide-body');
      body.innerHTML = items.map(i => `
        <div class="flex items-start gap-3 text-xs mb-2.5">
          <div class="w-28 shrink-0 text-slate-500 dark:text-slate-400 font-medium">${escapeHtml(i.key)}</div>
          <div class="flex-1 text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap break-all">${escapeHtml(String(i.value || '-'))}</div>
        </div>
      `).join('');
    } catch (err) {
      const body = panel.querySelector('.slide-body');
      body.innerHTML = `<div class="text-red-500 text-xs">${escapeHtml(err.message)}</div>`;
    }
  }

  function formatPorts(ports) {
    if (!ports) return '-';
    const parts = [];
    for (const [container, bindings] of Object.entries(ports)) {
      if (!bindings) { parts.push(container); continue; }
      for (const b of bindings) {
        parts.push(`${b.HostIp || '0.0.0.0'}:${b.HostPort} -> ${container}`);
      }
    }
    return parts.join('\n') || '-';
  }

  function formatMounts(mounts) {
    if (!Array.isArray(mounts) || mounts.length === 0) return '-';
    return mounts.map(m => `${m.Type || ''}: ${m.Source || ''} -> ${m.Destination || ''}`).join('\n');
  }

  function closeSlidePanel() { $slideRoot.innerHTML = ''; }

  // ─── 查看日志（Modal）─────────────────────────────────────────────
  function openLogsModal(name) {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box" style="max-width:48rem;">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-3">
        <span class="text-xl">&#128196;</span>
        <div><div class="text-sm font-bold text-slate-700 dark:text-slate-200">容器日志</div><div class="text-[11px] text-slate-400">${escapeHtml(name)}</div></div>
        <div class="flex-1"></div>
        <select class="logs-lines h-7 px-2 rounded border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-[#0b1324] text-[10px]">
          <option value="50">50 行</option>
          <option value="100" selected>100 行</option>
          <option value="200">200 行</option>
          <option value="500">500 行</option>
        </select>
        <button class="act-btn act-btn-primary logs-refresh">&#8635;</button>
        <button class="modal-close text-slate-400 hover:text-slate-600 text-lg">&times;</button>
      </div>
      <div class="logs-body bg-[#0d1117] text-slate-300 font-mono text-[11px] p-4 overflow-auto whitespace-pre-wrap" style="height:400px;">
        <div class="text-slate-500">加载日志中…</div>
      </div>
    </div>`;

    $modalRoot.appendChild(el);
    const logsBody = el.querySelector('.logs-body');
    const linesSelect = el.querySelector('.logs-lines');

    el.querySelector('.modal-close').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    async function loadLogs() {
      logsBody.innerHTML = '<div class="text-slate-500">加载中…</div>';
      try {
        const res = await exec(`docker logs --tail ${linesSelect.value} ${shellEscape(name)} 2>&1`);
        logsBody.textContent = res.stdout || res.stderr || '（空）';
        logsBody.scrollTop = logsBody.scrollHeight;
      } catch (err) {
        logsBody.innerHTML = `<div class="text-red-400">${escapeHtml(err.message)}</div>`;
      }
    }

    el.querySelector('.logs-refresh').addEventListener('click', loadLogs);
    linesSelect.addEventListener('change', loadLogs);
    loadLogs();
  }

  // ─── 工具 ──────────────────────────────────────────────────────────
  function shellEscape(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  // ─── 事件绑定 ───────────────────────────────────────────────────────
  function bindEvents() {
    $tableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      handleAction(btn.dataset.act, btn.dataset.name);
    });

    $btnRefresh.addEventListener('click', loadContainerList);

    $hostSelect.addEventListener('change', () => {
      localStorage.setItem('1shell-last-host', getHostId());
      containers = [];
      const cached = loadCache();
      if (cached) {
        containers = cached;
        renderTable();
        $tableStatus.textContent = `缓存 · 点击刷新更新`;
      } else {
        showSkeleton();
        $tableStatus.textContent = '点击刷新加载';
      }
    });

    $filterInput.addEventListener('input', () => {
      if (containers.length > 0) renderTable();
    });
  }

  init();
})();
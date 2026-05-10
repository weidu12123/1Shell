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
  const selectedHosts = new Map();      // id → host
  const selectedPaths = [];             // [{hostId, path}]
  const selectedContainers = new Map(); // `${hostId}::${name}` → {hostId, name, image}
  const selectedTools = new Set();      // `skill:<id>` 或 `mcp:<id>`

  let socket = null;
  let currentSessionId = null;    // IDE session ID (for backend)
  let isRunning = false;

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
  const $runStatus  = document.getElementById('run-status');
  const $summary    = document.getElementById('summary-chip');

  // ─── 对话 / 历史 DOM + 状态 ───────────────────────────────────────
  const $chatArea         = document.getElementById('chat-area');
  const $historyDrawer    = document.getElementById('history-drawer');
  const $btnToggleHistory = document.getElementById('btn-toggle-history');
  const $btnNewSession    = document.getElementById('btn-new-session');
  const $historyList      = document.getElementById('history-list');
  const $btnClearChat     = document.getElementById('btn-clear-chat');

  const HISTORY_KEY = '1shell.ide.sessions.v1';
  let sessions = [];            // [{id, title, createdAt, messages:[{role, kind?, content}]}]
  let localSessionId = null;    // local UI session tracker
  let currentAiTurnBody = null;
  let toolFilter = 'all';
  let safeMode = true;

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
    updateSummary();

    // 从仓库页 AI 部署跳转过来
    const params = new URLSearchParams(window.location.search);
    const deployUrl = params.get('deploy_mcp');
    if (deployUrl) {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => {
        $task.value = `帮我部署这个 MCP Server 到本地：${deployUrl}\n请 clone 仓库、安装依赖、识别启动命令，然后用 deploy_local_mcp 注册。`;
        onSend();
      }, 500);
    }
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
      const [skillRes, mcpRes] = await Promise.all([
        requestJson('/api/skills').catch(() => ({ skills: [] })),
        requestJson('/api/mcp-servers').catch(() => ({ servers: [] })),
      ]);
      skillList = (skillRes.skills || []).filter(s => s.id !== 'skill-authoring');
      mcpList = mcpRes.servers || [];
      renderTools();
    } catch {}
  }







  const localMcpStatus = new Map();

  function toolItems() {
    const items = [];
    for (const s of skillList) items.push({ kind: 'skill', id: s.id, name: s.name, icon: s.icon || '🔧', meta: truncate160(s.description) });
    for (const m of mcpList) {
      const isLocal = m.type === 'local' || Boolean(m.command);
      const status = localMcpStatus.get(m.id);
      const statusDot = isLocal ? (status?.status === 'running' ? ' 🟢' : status?.status === 'starting' ? ' 🟡' : '') : '';
      items.push({ kind: isLocal ? 'local' : 'mcp', id: m.id, name: m.name, icon: isLocal ? '📦' : '🔌', meta: truncate160(m.description || m.url || m.command), isLocal, statusDot });
    }
    return items;
  }
  function truncate160(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 60); }

  function renderTools() {
    if (!$toolList) return;
    const items = toolItems().filter(it => toolFilter === 'all' || it.kind === toolFilter);
    $toolCount.textContent = `${selectedTools.size} / ${toolItems().length}`;
    if (items.length === 0) {
      $toolList.innerHTML = `<div class="text-[11px] text-slate-400 text-center py-4">
        仓库里暂无${toolFilter === 'local' ? '本地 MCP' : toolFilter === 'mcp' ? '远程 MCP' : toolFilter === 'skill' ? ' Skill' : '工具'}。<br/>
        点右上"↗ 管理"跳转仓库添加。
      </div>`;
      return;
    }
    $toolList.innerHTML = items.map(it => {
      const selKey = it.isLocal ? `mcp:${it.id}` : `${it.kind}:${it.id}`;
      const sel = selectedTools.has(selKey) ? 'selected' : '';
      let kindPill;
      if (it.kind === 'skill') {
        kindPill = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">Skill</span>';
      } else if (it.isLocal) {
        kindPill = `<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">本地${it.statusDot}</span>`;
      } else {
        kindPill = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600">远程</span>';
      }
      return `<div class="item-row ${sel}" data-key="${escapeHtml(selKey)}" data-local="${it.isLocal ? '1' : '0'}">
        <span class="text-[14px]">${escapeHtml(it.icon)}</span>
        <span class="flex-1 truncate" title="${escapeHtml(it.meta || '')}">${escapeHtml(it.name)}</span>
        ${kindPill}
      </div>`;
    }).join('');
    $toolList.querySelectorAll('.item-row').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.key;
        const isLocal = el.dataset.local === '1';
        const mcpId = k.startsWith('mcp:') ? k.slice(4) : null;

        if (selectedTools.has(k)) {
          selectedTools.delete(k);
          if (isLocal && mcpId) {
            socket.emit('ide:mcp-stop', { mcpId });
          }
        } else {
          selectedTools.add(k);
          if (isLocal && mcpId) {
            socket.emit('ide:mcp-start', { mcpId }, (ack) => {
              if (!ack?.ok) showToast?.(`MCP 启动失败: ${ack?.error || '未知错误'}`, 'error');
            });
          }
        }
        renderTools();
        updateSummary();
      });
    });
  }


  // ─── Socket ───────────────────────────────────────────────────────
  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('ide:thinking', (msg) => {
      if (msg.sessionId !== currentSessionId) return;
      setStatus('running', '思考中...');
    });
    socket.on('ide:text', (msg) => {
      if (msg.sessionId !== currentSessionId || !msg.text) return;
      appendLine('stdout', msg.text);
    });
    socket.on('ide:tool-start', (msg) => {
      if (msg.sessionId !== currentSessionId) return;
      const inputStr = msg.input ? ` ${JSON.stringify(msg.input).slice(0, 120)}` : '';
      appendLine('info', `⚙ ${msg.name}${inputStr}`);
    });
    socket.on('ide:tool-end', (msg) => {
      if (msg.sessionId !== currentSessionId) return;
      if (msg.is_error) {
        appendLine('stderr', truncate(msg.result || ''));
      } else {
        appendLine('stdout', truncate(msg.result || ''));
      }
    });
    socket.on('ide:done', (msg) => {
      if (msg.sessionId !== currentSessionId) return;
      setStatus('done', `完成 (${msg.round ?? 0} 轮)`);
      finalize();
    });
    socket.on('ide:error', (msg) => {
      if (msg.sessionId !== currentSessionId) return;
      setStatus('error', '出错');
      appendLine('error', `✘ ${msg.error || '未知错误'}`);
      finalize();
    });
    socket.on('ide:cancelled', (msg) => {
      if (msg.sessionId !== currentSessionId) return;
      setStatus('cancelled', '已取消');
      appendLine('error', '已取消');
      finalize();
    });

    socket.on('ide:mcp-status', (msg) => {
      if (!msg?.mcpId) return;
      localMcpStatus.set(msg.mcpId, { status: msg.status, toolCount: (msg.tools || []).length });
      renderTools();
    });

    // ─── 安全模式审批条 ──────────────────────────────────
    socket.on('ide:approve-request', (msg) => {
      const $bar = document.getElementById('approve-bar');
      const $title = document.getElementById('approve-title');
      const $desc = document.getElementById('approve-desc');
      const $detail = document.getElementById('approve-detail');
      const $allow = document.getElementById('approve-allow');
      const $deny = document.getElementById('approve-deny');
      const $customInput = document.getElementById('approve-custom-input');
      const $customBtn = document.getElementById('approve-custom-btn');
      const $countdown = document.getElementById('approve-countdown');
      if (!$bar) return;

      $title.textContent = msg.title || '安全模式';
      $desc.textContent = `AI 要执行 ${msg.toolName || '操作'}：`;
      $detail.textContent = msg.detail || '';
      $customInput.value = '';
      $bar.classList.remove('hidden');

      let remaining = 120;
      $countdown.textContent = `${remaining}s`;
      const tick = setInterval(() => {
        remaining--;
        $countdown.textContent = `${remaining}s`;
        if (remaining <= 0) { respond('deny'); }
      }, 1000);

      const respond = (action, text) => {
        clearInterval(tick);
        $bar.classList.add('hidden');
        socket.emit('ide:approve-response', {
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          action,
          text: text || '',
        });
      };

      $deny.onclick = () => respond('deny');
      $allow.onclick = () => respond('allow');
      $customBtn.onclick = () => {
        const text = $customInput.value.trim();
        if (!text) { showToast?.('请输入自定义回复', 'error'); return; }
        respond('custom', text);
      };
      $customInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          $customBtn.click();
        }
      };
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
    const $filterLocal = document.getElementById('tool-filter-local');
    if ($filterAll)   $filterAll.addEventListener('click',   () => { toolFilter = 'all';   renderTools(); });
    if ($filterSkill) $filterSkill.addEventListener('click', () => { toolFilter = 'skill'; renderTools(); });
    if ($filterMcp)   $filterMcp.addEventListener('click',   () => { toolFilter = 'mcp';   renderTools(); });
    if ($filterLocal) $filterLocal.addEventListener('click', () => { toolFilter = 'local'; renderTools(); });

    $btnCreate.addEventListener('click', onSend);
    $task.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });
    $btnStop.addEventListener('click', onStop);

    const $chkSafe = document.getElementById('chk-safe-mode');
    const $safeLabel = document.getElementById('safe-mode-label');
    if ($chkSafe) {
      $chkSafe.addEventListener('change', () => {
        safeMode = $chkSafe.checked;
        if ($safeLabel) {
          $safeLabel.textContent = safeMode ? '🛡 安全模式' : '安全模式';
          $safeLabel.className = safeMode ? 'text-amber-500' : 'text-slate-400';
        }
        if (currentSessionId) {
          socket.emit('ide:safe-mode', { sessionId: currentSessionId, enabled: safeMode });
        }
      });
    }

    const $chkUnlimited = document.getElementById('chk-unlimited-turns');
    const $unlimitedLabel = document.getElementById('unlimited-turns-label');
    if ($chkUnlimited) {
      $chkUnlimited.addEventListener('change', () => {
        const enabled = $chkUnlimited.checked;
        if ($unlimitedLabel) {
          $unlimitedLabel.className = enabled ? 'text-blue-500' : 'text-slate-400';
        }
        if (currentSessionId) {
          socket.emit('ide:unlimited-turns', { sessionId: currentSessionId, enabled });
        }
      });
    }

    const $chkCC = document.getElementById('chk-cc-collab');
    const $ccLabel = document.getElementById('cc-collab-label');
    if ($chkCC) {
      $chkCC.addEventListener('change', () => {
        const enabled = $chkCC.checked;
        if ($ccLabel) {
          $ccLabel.className = enabled ? 'text-purple-500' : 'text-slate-400';
        }
        if (currentSessionId) {
          socket.emit('ide:claude-code-collab', { sessionId: currentSessionId, enabled });
        }
      });
    }

    // 历史抽屉 + 新建 + 清空
    $btnToggleHistory?.addEventListener('click', toggleHistoryDrawer);
    $btnNewSession?.addEventListener('click', startNewChat);
    document.getElementById('btn-new-chat')?.addEventListener('click', startNewChat);
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
    const task = $task.value.trim();
    if (!task) { showToast?.('请输入自然语言描述', 'error'); return; }
    if (isRunning) return;

    appendUserMessage(task);
    $task.value = '';

    renderAiTurn();
    isRunning = true;
    setStatus('starting', '启动中...');
    $btnCreate.disabled = true;
    $btnStop.classList.remove('hidden');

    const context = {
      hosts: [...selectedHosts.values()].map(h => ({ id: h.id, name: h.name, host: h.host, username: h.username, port: h.port })),
      containers: [...selectedContainers.values()],
      files: selectedPaths.map(p => ({ hostId: p.hostId, path: p.path })),
      mcpServers: [...selectedTools].filter(k => k.startsWith('mcp:')).map(k => {
        const srv = mcpList.find(m => m.id === k.slice(4));
        return srv ? { id: srv.id, name: srv.name, url: srv.url } : { id: k.slice(4) };
      }),
    };

    socket.emit('ide:message', {
      sessionId: currentSessionId,
      message: task,
      context,
      safeMode,
    }, (ack) => {
      if (!ack?.ok) {
        setStatus('error', '启动失败');
        appendLine('error', ack?.error || 'ide:message 被拒绝');
        finalize();
      } else {
        socket.emit('ide:safe-mode', { sessionId: currentSessionId, enabled: safeMode });
        if (document.getElementById('chk-unlimited-turns')?.checked) {
          socket.emit('ide:unlimited-turns', { sessionId: currentSessionId, enabled: true });
        }
        if (document.getElementById('chk-cc-collab')?.checked) {
          socket.emit('ide:claude-code-collab', { sessionId: currentSessionId, enabled: true });
        }
      }
    });
  }

  function onStop() {
    if (!currentSessionId) return;
    socket.emit('ide:stop', { sessionId: currentSessionId });
  }

  function finalize() {
    isRunning = false;
    $btnCreate.disabled = false;
    $btnCreate.textContent = '发送 →';
    $task.placeholder = '用自然语言描述你的需求…';
    $btnStop.classList.add('hidden');
    currentAiTurnBody = null;
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
    showEmptyState();
    renderHistoryList();
    if ($btnClearChat) $btnClearChat.classList.add('hidden');
  }
  function showEmptyState() {
    if (!$chatArea) return;
    $chatArea.innerHTML = `
      <div id="chat-placeholder" class="text-[11px] text-slate-400 text-center py-10 flex flex-col items-center gap-2">
        <span class="text-3xl">&#128187;</span>
        <span>选好主机和上下文后，在下方输入你的需求<br/>AI 会自由探索、创建、测试、迭代，支持多轮对话</span>
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

  init();
})();
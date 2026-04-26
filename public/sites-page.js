(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showToast } = window.appShared;
  const requestJson = createRequestJson({ onUnauthorized: () => { window.location.href = 'index.html'; } });

  // ─── DOM ────────────────────────────────────────────────────────────
  const $hostSelect   = document.getElementById('host-select');
  const $btnRefresh   = document.getElementById('btn-refresh');
  const $btnAddSite   = document.getElementById('btn-add-site');
  const $btnApplyCert = document.getElementById('btn-apply-cert');
  const $tabStatus    = document.getElementById('tab-status');
  const $sitesBody    = document.getElementById('sites-body');
  const $certsBody    = document.getElementById('certs-body');
  const $panelSites   = document.getElementById('panel-sites');
  const $panelCerts   = document.getElementById('panel-certs');
  const $modalRoot    = document.getElementById('modal-root');

  const $statSites    = document.getElementById('stat-sites');
  const $statSsl      = document.getElementById('stat-ssl');
  const $statExpiring = document.getElementById('stat-expiring');
  const $statNginx       = document.getElementById('stat-nginx');
  const $statServerLabel = document.getElementById('stat-server-label');
  const $headerSubtitle  = document.getElementById('header-subtitle');
  const $panelDns     = document.getElementById('panel-dns');
  const $dnsBody      = document.getElementById('dns-body');
  const $btnAddDns    = document.getElementById('btn-add-dns');

  let activeTab = 'sites';
  let sites = [];
  let certs = [];
  let dnsProviders = [];  // [{id, domain, provider, token, tokenSet, note}]
  let loading = false;
  let serverType = null;    // 'nginx' | 'openresty' | 'caddy' | null
  let serverVersion = '';

  // ─── 直接执行 ─────────────────────────────────────────────────────
  async function exec(command, timeout) {
    return requestJson('/api/exec', {
      method: 'POST',
      body: JSON.stringify({ hostId: getHostId(), command, timeout: timeout || 30000 }),
    });
  }

  function getHostId() { return $hostSelect.value || 'local'; }

  // ─── 初始化 ─────────────────────────────────────────────────────────
  async function init() {
    await loadHosts();
    bindEvents();
  }

  async function loadHosts() {
    try {
      const data = await requestJson('/api/hosts');
      const hosts = data.hosts || data || [];
      $hostSelect.innerHTML = '<option value="local">\u{1F5A5} 本机</option>';
      for (const h of hosts) {
        if (h.id === 'local') continue;
        const opt = document.createElement('option');
        opt.value = h.id;
        opt.textContent = `${h.name} (${h.host})`;
        $hostSelect.appendChild(opt);
      }
      const last = localStorage.getItem('1shell-last-host');
      if (last && $hostSelect.querySelector(`option[value="${last}"]`)) $hostSelect.value = last;
    } catch {}
  }

  // ─── Tab 切换 ─────────────────────────────────────────────────────
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $panelSites.classList.toggle('hidden', tab !== 'sites');
    $panelCerts.classList.toggle('hidden', tab !== 'certs');
    $panelDns.classList.toggle('hidden', tab !== 'dns');
    $btnAddSite.classList.toggle('hidden', tab !== 'sites');
    $btnApplyCert.classList.toggle('hidden', tab !== 'certs');
    $btnAddDns.classList.toggle('hidden', tab !== 'dns');
    if (tab === 'dns') loadDnsProviders();
  }

  // ─── 加载站点列表 ─────────────────────────────────────────────────
  async function loadAll() {
    if (loading) return;
    loading = true;
    $btnRefresh.disabled = true;
    $btnRefresh.textContent = '加载中…';
    $tabStatus.textContent = '加载中…';

    showSkeleton($sitesBody, 6);
    showSkeleton($certsBody, 7);

    try {
      const res = await requestJson('/api/sites/scan', {
        method: 'POST',
        body: JSON.stringify({ hostId: getHostId() }),
      });

      if (!res.ok) {
        throw new Error(res.error || '扫描失败');
      }

      // 解析服务器信息
      const servers = res.servers || [];
      if (servers.length > 0) {
        const primary = servers[0];
        serverType = primary.name;
        serverVersion = `${primary.name} ${primary.version}`;

        const nameMap = { nginx: 'Nginx', openresty: 'OpenResty', caddy: 'Caddy', apache: 'Apache' };
        const label = nameMap[serverType] || 'Web 服务';
        if ($statServerLabel) $statServerLabel.textContent = label;
        if ($headerSubtitle) $headerSubtitle.textContent = `${label} 站点 · SSL 证书`;
        if ($statNginx) {
          $statNginx.textContent = primary.running ? 'Running' : 'Stopped';
          $statNginx.title = serverVersion;
        }
      } else {
        serverType = null;
        serverVersion = '';
        if ($statServerLabel) $statServerLabel.textContent = 'Web 服务';
        if ($headerSubtitle) $headerSubtitle.textContent = '站点 · SSL 证书';
        if ($statNginx) {
          $statNginx.textContent = '未安装';
          $statNginx.title = '';
        }
      }

      // 解析站点和证书
      sites = (res.sites || []).map(s => ({
        domain: s.domain,
        upstream: s.root || '-',
        hasSSL: s.ssl,
        file: s.configPath || `${s.server} config`,
        configPath: (s.configPath && s.configPath.startsWith('/')) ? s.configPath : null,
      }));

      certs = (res.certs || []).map(c => ({
        domain: c.domain,
        issuer: c.issuer,
        notBefore: c.notBefore,
        notAfter: c.notAfter,
        expiryDate: c.notAfter ? new Date(c.notAfter).toLocaleDateString('zh-CN') : '-',
        daysLeft: c.daysLeft,
        tool: c.path.includes('acme.sh') ? 'acme.sh' : c.path.includes('letsencrypt') ? 'certbot' : '未知',
        path: c.path,
        autoRenew: false,
      }));

      // 自动续期标记
      const renewConfig = res.renewConfig || '';
      const hasAcmeCron = /acme/i.test(renewConfig);
      const hasCertbotTimer = /enabled/i.test(renewConfig);
      for (const c of certs) {
        if (c.tool === 'acme.sh') c.autoRenew = hasAcmeCron;
        else if (c.tool === 'certbot') c.autoRenew = hasCertbotTimer;
      }

      renderSitesTable();
      renderCertsTable();
      updateStats();
      $tabStatus.textContent = `共 ${sites.length} 个站点 · ${certs.length} 张证书`;
    } catch (err) {
      $tabStatus.textContent = '加载失败';
      showToast(err.message || '扫描失败', 'error');
    } finally {
      loading = false;
      $btnRefresh.disabled = false;
      $btnRefresh.textContent = '\u21BB 刷新';
    }
  }

  // ─── Web 服务器安装 ────────────────────────────────────────────────
  async function installWebServer(type) {
    const btns = document.querySelectorAll('.install-ws-btn');
    const $log = document.getElementById('ws-install-log');
    if (!$log) return;

    btns.forEach(b => { b.disabled = true; });
    const activeBtn = document.querySelector(`.install-ws-btn[data-ws="${type}"]`);
    if (activeBtn) activeBtn.textContent = '安装中…';
    $log.classList.remove('hidden');

    const labels = { nginx: 'Nginx', openresty: 'OpenResty', caddy: 'Caddy' };
    $log.textContent = `正在安装 ${labels[type]}，请稍候…\n`;

    const cmds = {
      nginx: 'apt-get update && apt-get install -y nginx || yum install -y nginx',
      openresty: 'apt-get update && apt-get -y install --no-install-recommends wget gnupg ca-certificates lsb-release && wget -O - https://openresty.org/package/pubkey.gpg | apt-key add - && echo "deb http://openresty.org/package/$(. /etc/os-release && echo $ID) $(lsb_release -sc) main" > /etc/apt/sources.list.d/openresty.list && apt-get update && apt-get -y install openresty || yum install -y yum-utils && yum-config-manager --add-repo https://openresty.org/package/centos/openresty.repo && yum install -y openresty',
      caddy: 'apt-get update && apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl && curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/setup.deb.sh" | bash && apt-get install -y caddy || yum install -y yum-plugin-copr && yum copr enable -y @caddy/caddy && yum install -y caddy',
    };

    try {
      const res = await exec(cmds[type], 300000);
      $log.textContent += (res.stdout || '') + '\n' + (res.stderr || '');
      $log.scrollTop = $log.scrollHeight;

      if (res.exitCode !== 0) {
        $log.textContent += `\n安装失败 (exitCode: ${res.exitCode})`;
        btns.forEach(b => { b.disabled = false; });
        if (activeBtn) activeBtn.textContent = labels[type];
        return;
      }

      const startCmds = {
        nginx: 'systemctl enable nginx && systemctl start nginx',
        openresty: 'systemctl enable openresty && systemctl start openresty',
        caddy: 'systemctl enable caddy && systemctl start caddy',
      };
      await exec(startCmds[type], 15000);

      $log.textContent += `\n✓ ${labels[type]} 安装完成！正在刷新…`;
      showToast(`${labels[type]} 安装成功`, 'success');
      setTimeout(() => loadAll(), 1000);
    } catch (err) {
      $log.textContent += `\n安装异常: ${err.message}`;
      btns.forEach(b => { b.disabled = false; });
      if (activeBtn) activeBtn.textContent = labels[type];
    }
  }

  // ─── 容错执行：超时或失败返回空结果，不抛异常 ───────────────────
  async function safeExec(command, timeout) {
    try {
      const res = await exec(command, timeout || 8000);
      return res;
    } catch {
      return { ok: false, stdout: '', stderr: '', exitCode: -1, durationMs: 0 };
    }
  }

  function renderSitesTable() {
    if (!serverType && sites.length === 0) {
      $sitesBody.innerHTML = `<tr><td colspan="6" class="text-center py-10">
        <div class="flex flex-col items-center gap-4 max-w-md mx-auto">
          <div class="text-3xl">🌐</div>
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200">未检测到 Web 服务器</div>
          <div class="text-[11px] text-slate-400 text-center">安装 Web 服务器后即可管理站点和 SSL 证书，请选择一个：</div>
          <div class="flex gap-3">
            <button class="act-btn act-btn-primary install-ws-btn" data-ws="nginx">Nginx</button>
            <button class="act-btn act-btn-primary install-ws-btn" data-ws="openresty">OpenResty</button>
            <button class="act-btn act-btn-primary install-ws-btn" data-ws="caddy">Caddy</button>
          </div>
          <div id="ws-install-log" class="hidden w-full text-left bg-slate-900 text-emerald-400 rounded-lg p-3 font-mono text-[11px] max-h-[200px] overflow-auto whitespace-pre-wrap"></div>
        </div>
      </td></tr>`;
      $sitesBody.querySelectorAll('.install-ws-btn').forEach(btn => {
        btn.addEventListener('click', () => installWebServer(btn.dataset.ws));
      });
      return;
    }

    if (sites.length === 0) {
      const serverName = { nginx: 'Nginx', openresty: 'OpenResty', caddy: 'Caddy', apache: 'Apache' }[serverType];
      $sitesBody.innerHTML = `<tr><td colspan="6" class="text-center text-slate-400 py-8">${
        serverType ? `未找到 ${serverName} 站点配置` : '未检测到 Web 服务器'
      }</td></tr>`;
      return;
    }

    $sitesBody.innerHTML = sites.map(s => {
      const sslBadge = s.hasSSL
        ? '<span class="badge badge-ok">&#128274; SSL</span>'
        : '<span class="badge badge-none">无 SSL</span>';

      // 在 certs 中查找对应的到期信息
      const cert = certs.find(c => c.domain === s.domain || c.domain === '*.' + s.domain);
      let expiryText = '-';
      if (cert) {
        expiryText = cert.daysLeft != null
          ? `${cert.expiryDate} (${cert.daysLeft}天)`
          : cert.expiryDate || '-';
      }

      const shortFile = s.file.split('/').pop();

      return `<tr>
        <td class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(s.domain)}</td>
        <td class="font-mono text-[11px] text-slate-500 dark:text-slate-400 max-w-[180px] truncate" title="${escapeHtml(s.upstream)}">${escapeHtml(s.upstream)}</td>
        <td>${sslBadge}</td>
        <td class="text-[11px] text-slate-400">${escapeHtml(expiryText)}</td>
        <td class="text-[11px] text-slate-400 font-mono" title="${escapeHtml(s.file)}">${escapeHtml(shortFile)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="act-btn act-btn-default" data-act="view-conf" data-file="${escapeHtml(s.file)}" title="查看配置">&#128196;</button>
          ${!s.hasSSL ? `<button class="act-btn act-btn-success" data-act="apply-cert" data-domain="${escapeHtml(s.domain)}" title="申请证书">&#128274;</button>` : ''}
          <button class="act-btn act-btn-danger" data-act="delete-site" data-domain="${escapeHtml(s.domain)}" data-file="${escapeHtml(s.configPath || '')}" title="删除站点（清理所有残留）">&#128465;</button>
        </td>
      </tr>`;
    }).join('');
  }

  // ─── 证书表格渲染 ─────────────────────────────────────────────────

  function renderCertsTable() {
    if (certs.length === 0) {
      $certsBody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-400 py-8">未找到 SSL 证书</td></tr>';
      return;
    }

    $certsBody.innerHTML = certs.map(c => {
      let daysClass = 'badge-ok', daysText = `${c.daysLeft} 天`;
      if (c.daysLeft == null) { daysClass = 'badge-none'; daysText = '-'; }
      else if (c.daysLeft < 0) { daysClass = 'badge-err'; daysText = '已过期'; }
      else if (c.daysLeft < 7) { daysClass = 'badge-err'; daysText = `${c.daysLeft} 天`; }
      else if (c.daysLeft < 30) { daysClass = 'badge-warn'; daysText = `${c.daysLeft} 天`; }

      const renewBadge = c.autoRenew
        ? '<span class="badge badge-ok">已配置</span>'
        : '<span class="badge badge-none">未配置</span>';

      return `<tr>
        <td class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(c.domain)}</td>
        <td class="text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(c.issuer)}</td>
        <td class="text-[11px] text-slate-400">${escapeHtml(c.expiryDate)}</td>
        <td><span class="badge ${daysClass}">${daysText}</span></td>
        <td>${renewBadge}</td>
        <td class="text-[11px] text-slate-400">${escapeHtml(c.tool)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="act-btn act-btn-default" data-act="renew-cert" data-domain="${escapeHtml(c.domain)}" data-tool="${escapeHtml(c.tool)}" title="续期">&#8635;</button>
          <button class="act-btn act-btn-danger" data-act="delete-cert" data-domain="${escapeHtml(c.domain)}" data-path="${escapeHtml(c.path)}" title="删除证书">&#128465;</button>
        </td>
      </tr>`;
    }).join('');
  }

  function updateStats() {
    $statSites.textContent = sites.length;
    $statSsl.textContent = sites.filter(s => s.hasSSL).length;
    $statExpiring.textContent = certs.filter(c => c.daysLeft != null && c.daysLeft < 30 && c.daysLeft >= 0).length;
  }

  // ─── 查看配置（Modal）───────────────────────────────────────────
  async function viewConfig(file) {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box" style="max-width:48rem;">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
        <div><div class="text-sm font-bold text-slate-700 dark:text-slate-200">Nginx 配置</div><div class="text-[11px] text-slate-400 font-mono">${escapeHtml(file)}</div></div>
        <button class="modal-close text-slate-400 hover:text-slate-600 text-lg">&times;</button>
      </div>
      <pre class="bg-[#0d1117] text-slate-300 font-mono text-[11px] p-4 overflow-auto whitespace-pre-wrap" style="max-height:400px;">加载中…</pre>
    </div>`;
    $modalRoot.appendChild(el);
    el.querySelector('.modal-close').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    try {
      const res = await exec(`cat '${file}'`);
      el.querySelector('pre').textContent = res.stdout || '（空）';
    } catch (err) {
      el.querySelector('pre').textContent = `Error: ${err.message}`;
    }
  }

  // ─── 申请证书（通过 SkillClient）──────────────────────────────────
  async function openCertApplyModal(prefillDomain) {
    // 预加载已保存的 DNS 凭据
    let savedProviders = [];
    try {
      const data = await requestJson('/api/dns-providers');
      savedProviders = (data.providers || []).filter(p => p.tokenSet);
    } catch {}

    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">&#128274; 申请 SSL 证书</div>
        <div class="text-[11px] text-slate-400">通过 AI 自动完成 Let's Encrypt 证书申请</div>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3 cert-form">
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">域名 <span class="text-red-400">*</span></label>
          <input id="cert-domain" type="text" value="${escapeHtml(prefillDomain || '')}" placeholder="example.com" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400" /></div>
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">邮箱 <span class="text-red-400">*</span></label>
          <input id="cert-email" type="text" placeholder="admin@example.com" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400" /></div>
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">验证方式</label>
          <select id="cert-provider" class="w-full h-8 px-2 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400">
            <option value="standalone">HTTP-01（需 80 端口空闲）</option>
            <option value="cloudflare">Cloudflare DNS-01（支持泛域名）</option>
          </select></div>
        <div id="cert-cf-row" class="hidden flex flex-col gap-3">
          <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">DNS 凭据</label>
            <select id="cert-dns-select" class="w-full h-8 px-2 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400">
              ${savedProviders.length > 0
                ? savedProviders.map(p => `<option value="${escapeHtml(p.domain)}">${escapeHtml(p.domain)} (${escapeHtml(p.token)})</option>`).join('')
                  + '<option value="__manual__">手动输入 Token…</option>'
                : '<option value="__manual__">手动输入 Token…</option>'}
            </select>
            ${savedProviders.length === 0 ? '<div class="text-[10px] text-amber-500 mt-1">尚未保存 DNS 凭据，请前往"DNS 凭据"Tab 添加，或在下方手动输入</div>' : ''}
          </div>
          <div id="cert-manual-row" class="${savedProviders.length > 0 ? 'hidden' : ''}"><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Cloudflare API Token</label>
            <input id="cert-cf-token" type="text" placeholder="CF API Token" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono outline-none focus:border-blue-400" /></div>
        </div>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2 justify-end">
        <button class="act-btn act-btn-default modal-cancel">取消</button>
        <button class="act-btn act-btn-success cert-submit">&#128274; 开始申请</button>
      </div>
    </div>`;

    $modalRoot.appendChild(el);
    el.querySelector('.modal-cancel').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    const providerSelect = el.querySelector('#cert-provider');
    const cfRow = el.querySelector('#cert-cf-row');
    const dnsSelect = el.querySelector('#cert-dns-select');
    const manualRow = el.querySelector('#cert-manual-row');

    providerSelect.addEventListener('change', () => {
      cfRow.classList.toggle('hidden', providerSelect.value !== 'cloudflare');
    });

    dnsSelect.addEventListener('change', () => {
      manualRow.classList.toggle('hidden', dnsSelect.value !== '__manual__');
    });

    el.querySelector('.cert-submit').addEventListener('click', async () => {
      const domain = el.querySelector('#cert-domain').value.trim();
      const email = el.querySelector('#cert-email').value.trim();
      const provider = providerSelect.value;

      if (!domain) { showToast('请输入域名', 'warn'); return; }
      if (!email) { showToast('请输入邮箱', 'warn'); return; }

      let cfToken = '';
      if (provider === 'cloudflare') {
        if (dnsSelect.value === '__manual__') {
          cfToken = el.querySelector('#cert-cf-token')?.value.trim() || '';
          if (!cfToken) { showToast('请输入 Cloudflare API Token', 'warn'); return; }
        } else {
          // 从已保存的凭据中自动获取 token
          try {
            const tokenData = await requestJson(`/api/dns-providers/token/${encodeURIComponent(dnsSelect.value)}`);
            cfToken = tokenData.token || '';
          } catch {
            showToast('获取 DNS 凭据失败，请检查配置', 'error');
            return;
          }
          if (!cfToken) { showToast('该域名的 API Token 为空', 'error'); return; }
        }
      }

      el.remove();
      runCertApply({ domain, email, provider, cf_token: cfToken });
    });
  }

  function runCertApply(inputs) {
    // 创建 SkillClient 执行证书申请（这是需要 AI 推理的多步操作）
    const progressEl = document.createElement('div');
    progressEl.className = 'modal-backdrop';
    progressEl.innerHTML = `<div class="modal-box">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">&#128274; 正在申请证书</div>
        <div class="text-[11px] text-slate-400">${escapeHtml(inputs.domain)}</div>
      </div>
      <div class="px-5 py-6 flex flex-col items-center gap-3 modal-body">
        <div class="relative w-12 h-12">
          <div class="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700"></div>
          <div class="absolute inset-0 rounded-full border-4 border-transparent border-t-emerald-500 animate-spin"></div>
        </div>
        <div class="text-xs text-slate-500 cert-status">AI 正在执行证书申请流程…</div>
        <div class="text-[10px] text-slate-400 font-mono cert-phase"></div>
      </div>
    </div>`;
    $modalRoot.appendChild(progressEl);

    const statusEl = progressEl.querySelector('.cert-status');
    const phaseEl = progressEl.querySelector('.cert-phase');
    const bodyEl = progressEl.querySelector('.modal-body');

    const client = SkillClient.create({
      skillId: 'cert-management',
      hostId: getHostId(),
      onExec(cmd) {
        phaseEl.textContent = (cmd.command || '').substring(0, 80);
      },
      onRender(payload) {
        if (payload.level === 'success') {
          bodyEl.innerHTML = `<div class="text-emerald-500 text-3xl">&#10003;</div>
            <div class="text-sm font-bold text-emerald-600 dark:text-emerald-400">${escapeHtml(payload.title || '证书申请成功')}</div>
            ${payload.content ? `<div class="text-xs text-slate-500 text-center max-w-sm whitespace-pre-wrap">${escapeHtml(payload.content)}</div>` : ''}`;
          setTimeout(() => { progressEl.remove(); client.destroy(); loadAll(); }, 2000);
        } else if (payload.level === 'error') {
          bodyEl.innerHTML = `<div class="text-red-500 text-3xl">&#10007;</div>
            <div class="text-sm font-bold text-red-600 dark:text-red-400">${escapeHtml(payload.title || '申请失败')}</div>
            <div class="text-xs text-slate-500 text-center max-w-sm whitespace-pre-wrap">${escapeHtml(payload.content || '')}</div>
            <button class="act-btn act-btn-default mt-2 close-btn">关闭</button>`;
          bodyEl.querySelector('.close-btn')?.addEventListener('click', () => { progressEl.remove(); client.destroy(); });
        }
      },
      onAsk(payload, answerFn) {
        // 在 modal 内渲染确认
        if (payload.type === 'confirm') {
          bodyEl.innerHTML = `<div class="text-amber-500 text-3xl">&#9888;</div>
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200">${escapeHtml(payload.title)}</div>
            ${payload.description ? `<div class="text-xs text-slate-500 text-center max-w-sm whitespace-pre-wrap">${escapeHtml(payload.description)}</div>` : ''}
            <div class="flex gap-2 mt-2">
              <button class="act-btn act-btn-primary ask-yes">${escapeHtml(payload.confirmLabel || '确认')}</button>
              <button class="act-btn act-btn-default ask-no">${escapeHtml(payload.cancelLabel || '取消')}</button>
            </div>`;
          bodyEl.querySelector('.ask-yes')?.addEventListener('click', () => {
            answerFn({ confirmed: true });
            bodyEl.innerHTML = `<div class="relative w-12 h-12"><div class="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700"></div><div class="absolute inset-0 rounded-full border-4 border-transparent border-t-emerald-500 animate-spin"></div></div><div class="text-xs text-slate-500">继续执行中…</div><div class="text-[10px] text-slate-400 font-mono cert-phase"></div>`;
          });
          bodyEl.querySelector('.ask-no')?.addEventListener('click', () => {
            answerFn({ confirmed: false });
            progressEl.remove();
            client.destroy();
          });
        }
      },
      onDone() {
        setTimeout(() => { if (progressEl.parentNode) progressEl.remove(); client.destroy(); loadAll(); }, 1500);
      },
      onError(error) {
        bodyEl.innerHTML = `<div class="text-red-500 text-3xl">&#10007;</div>
          <div class="text-sm font-bold text-red-600">${escapeHtml(error)}</div>
          <button class="act-btn act-btn-default mt-2 close-btn">关闭</button>`;
        bodyEl.querySelector('.close-btn')?.addEventListener('click', () => { progressEl.remove(); client.destroy(); });
      },
      onThinking() { statusEl.textContent = 'AI 思考中…'; },
      onThought() {},
      onExecResult() {},
      onCancelled() { progressEl.remove(); client.destroy(); },
      onRunStarted() { statusEl.textContent = 'AI 正在执行…'; },
    });

    client.run({ ...inputs, server_type: serverType || 'nginx' });
  }

  // ─── 证书续期（直接执行）──────────────────────────────────────────
  async function renewCert(domain, tool) {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">&#8635; 续期证书</div>
        <div class="text-[11px] text-slate-400">${escapeHtml(domain)} · ${escapeHtml(tool)}</div>
      </div>
      <div class="px-5 py-6 flex flex-col items-center gap-3 modal-body">
        <div class="relative w-10 h-10"><div class="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700"></div><div class="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-500 animate-spin"></div></div>
        <div class="text-xs text-slate-500">正在续期…</div>
      </div>
    </div>`;
    $modalRoot.appendChild(el);

    const body = el.querySelector('.modal-body');

    try {
      let cmd;
      if (tool === 'acme.sh') {
        cmd = `~/.acme.sh/acme.sh --renew -d '${domain}' --force`;
      } else if (tool === 'certbot') {
        cmd = `certbot renew --cert-name '${domain}' --force-renewal`;
      } else {
        throw new Error('未知的证书管理工具');
      }

      const res = await exec(cmd, 120000);
      if (res.exitCode === 0) {
        body.innerHTML = `<div class="text-emerald-500 text-3xl">&#10003;</div><div class="text-sm font-bold text-emerald-600">续期成功</div>`;
        setTimeout(() => { el.remove(); loadAll(); }, 1500);
      } else {
        throw new Error(res.stderr || res.stdout || '续期失败');
      }
    } catch (err) {
      body.innerHTML = `<div class="text-red-500 text-3xl">&#10007;</div><div class="text-sm font-bold text-red-600">续期失败</div>
        <div class="text-xs text-slate-500 text-center max-w-sm whitespace-pre-wrap">${escapeHtml(err.message)}</div>
        <button class="act-btn act-btn-default mt-2 close-btn">关闭</button>`;
      body.querySelector('.close-btn')?.addEventListener('click', () => el.remove());
    }
  }

  // ─── 删除站点/证书（带残留预览）───────────────────────────────────
  function fmtBytes(n) {
    n = Number(n || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n/1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n/1048576).toFixed(1)} MB`;
    return `${(n/1073741824).toFixed(2)} GB`;
  }

  function classifyTarget(path) {
    if (/\.(conf|vhost)$/.test(path) && !/\/ssl\//.test(path)) return 'conf';
    if (/\/www\/sites\/|\/openresty\/www\/sites\//.test(path) && !/\/ssl\//.test(path)) return 'webRoot';
    if (/\.acme\.sh\//.test(path)) return 'acme';
    if (/letsencrypt\//.test(path)) return 'letsencrypt';
    if (/\/ssl\/|\/cert\//.test(path)) return 'cert';
    return 'other';
  }

  async function openDeleteModal({ kind, domain, confPath, certPath }) {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box" style="max-width:44rem;">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-red-500">&#9888; 删除 ${kind === 'cert' ? '证书' : '站点'}：${escapeHtml(domain)}</div>
        <div class="text-[11px] text-slate-400">扫描所有残留路径中…</div>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3 delete-body">
        <div class="flex items-center gap-2 text-xs text-slate-500">
          <div class="relative w-4 h-4"><div class="absolute inset-0 rounded-full border-2 border-slate-200 dark:border-slate-700"></div><div class="absolute inset-0 rounded-full border-2 border-transparent border-t-red-500 animate-spin"></div></div>
          <span>正在查找残留…</span>
        </div>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2 justify-end delete-footer hidden">
        <button class="act-btn act-btn-default modal-cancel">取消</button>
        <button class="act-btn act-btn-danger delete-confirm">&#128465; 确认删除</button>
      </div>
    </div>`;
    $modalRoot.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    let preview;
    try {
      preview = await requestJson('/api/sites/delete/preview', {
        method: 'POST',
        body: JSON.stringify({ hostId: getHostId(), domain, confPath: kind === 'site' ? confPath : undefined }),
      });
    } catch (err) {
      el.querySelector('.delete-body').innerHTML = `<div class="text-xs text-red-500">扫描失败：${escapeHtml(err.message)}</div>`;
      el.querySelector('.delete-footer').classList.remove('hidden');
      el.querySelector('.delete-confirm').classList.add('hidden');
      el.querySelector('.modal-cancel').addEventListener('click', () => el.remove());
      return;
    }

    const targets = preview.targets || [];
    const flags = preview.flags || {};

    // 按分类分组
    const groups = { conf: [], webRoot: [], cert: [], acme: [], letsencrypt: [], other: [] };
    for (const t of targets) groups[classifyTarget(t.path)].push(t);

    // 证书删除模式：关 site/web 相关分类
    const isCertOnly = kind === 'cert';
    const defaults = {
      removeConf: !isCertOnly,
      removeWebRoot: !isCertOnly,
      removeCert: true,
      removeAcme: flags.acmeRegistered || groups.acme.length > 0,
      removeLetsEncrypt: flags.certbotRegistered || groups.letsencrypt.length > 0,
      reloadServer: !isCertOnly,
    };

    function renderGroup(title, key, items, extra) {
      const count = items.length + (extra ? 1 : 0);
      const disabled = count === 0;
      const total = items.reduce((a, t) => a + (t.size || 0), 0);
      const paths = items.map(t =>
        `<div class="text-[10px] text-slate-400 font-mono truncate" title="${escapeHtml(t.path)}">· ${escapeHtml(t.path)} <span class="text-slate-500">(${fmtBytes(t.size)})</span></div>`
      ).join('');
      return `<label class="flex flex-col gap-1 p-2 rounded-lg border border-slate-200 dark:border-slate-700 ${disabled ? 'opacity-40' : ''}">
        <div class="flex items-center gap-2">
          <input type="checkbox" data-key="${key}" ${defaults[key] && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} class="accent-red-500" />
          <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${title}</span>
          <span class="text-[10px] text-slate-400">${count > 0 ? `${count} 项 · ${fmtBytes(total)}` : '未发现'}</span>
        </div>
        ${extra ? `<div class="text-[10px] text-slate-400 pl-5">· ${extra}</div>` : ''}
        ${paths ? `<div class="pl-5">${paths}</div>` : ''}
      </label>`;
    }

    const acmeExtra = flags.acmeRegistered ? `acme.sh 注册项（将执行 --remove）` : '';
    const certbotExtra = flags.certbotRegistered ? `certbot 注册项（将执行 certbot delete）` : '';
    const reloadLine = flags.onepanelContainer
      ? `1Panel 容器：${flags.onepanelContainer}`
      : '使用宿主 openresty/nginx -s reload';

    el.querySelector('.delete-body').innerHTML = `
      <div class="text-[11px] text-slate-500 mb-2">扫描发现以下残留，勾选要清理的项（已自动备份到 <code class="text-[10px]">/tmp/1shell-backup-*</code>）</div>
      ${isCertOnly ? '' : renderGroup('Nginx 配置文件', 'removeConf', groups.conf)}
      ${isCertOnly ? '' : renderGroup('站点目录（含日志）', 'removeWebRoot', groups.webRoot)}
      ${renderGroup('SSL 证书/密钥', 'removeCert', groups.cert)}
      ${renderGroup('acme.sh 证书', 'removeAcme', groups.acme, acmeExtra)}
      ${renderGroup("Let's Encrypt / certbot", 'removeLetsEncrypt', groups.letsencrypt, certbotExtra)}
      ${isCertOnly ? '' : `<label class="flex items-center gap-2 px-2">
        <input type="checkbox" data-key="reloadServer" ${defaults.reloadServer ? 'checked' : ''} class="accent-blue-500" />
        <span class="text-xs text-slate-600 dark:text-slate-300">删除后重载 Web 服务</span>
        <span class="text-[10px] text-slate-400">${escapeHtml(reloadLine)}</span>
      </label>`}
    `;

    const footer = el.querySelector('.delete-footer');
    footer.classList.remove('hidden');
    el.querySelector('.modal-cancel').addEventListener('click', () => el.remove());

    el.querySelector('.delete-confirm').addEventListener('click', async () => {
      const options = {};
      for (const inp of el.querySelectorAll('input[type=checkbox][data-key]')) {
        if (!inp.disabled) options[inp.dataset.key] = inp.checked;
      }
      const body = el.querySelector('.delete-body');
      body.innerHTML = `<div class="flex items-center gap-2 text-xs text-slate-500 py-4">
        <div class="relative w-4 h-4"><div class="absolute inset-0 rounded-full border-2 border-slate-200 dark:border-slate-700"></div><div class="absolute inset-0 rounded-full border-2 border-transparent border-t-red-500 animate-spin"></div></div>
        <span>正在删除…</span>
      </div>`;
      footer.classList.add('hidden');

      try {
        const r = await requestJson('/api/sites/delete', {
          method: 'POST',
          body: JSON.stringify({
            hostId: getHostId(),
            domain,
            confPath: kind === 'site' ? confPath : undefined,
            options,
            flags,
          }),
        });
        if (!r.ok) throw new Error(r.stderr || r.error || `exitCode=${r.exitCode}`);
        body.innerHTML = `<div class="text-emerald-500 text-2xl text-center">&#10003;</div>
          <div class="text-sm font-bold text-emerald-600 text-center">删除完成</div>
          <pre class="bg-slate-900 text-slate-300 font-mono text-[10px] p-3 rounded-lg max-h-60 overflow-auto whitespace-pre-wrap">${escapeHtml(r.stdout || '')}</pre>
          <button class="act-btn act-btn-default self-center close-btn">关闭</button>`;
        body.querySelector('.close-btn')?.addEventListener('click', () => { el.remove(); loadAll(); });
        showToast(`${kind === 'cert' ? '证书' : '站点'} ${domain} 已删除`, 'success');
      } catch (err) {
        body.innerHTML = `<div class="text-red-500 text-2xl text-center">&#10007;</div>
          <div class="text-sm font-bold text-red-600 text-center">删除失败</div>
          <div class="text-xs text-slate-500 text-center whitespace-pre-wrap">${escapeHtml(err.message)}</div>
          <button class="act-btn act-btn-default self-center close-btn">关闭</button>`;
        body.querySelector('.close-btn')?.addEventListener('click', () => el.remove());
      }
    });
  }

  // ─── 工具 ──────────────────────────────────────────────────────────
  function showSkeleton(tbody, cols) {
    const row = `<tr>${Array.from({length: cols}, (_, i) => `<td><div class="skeleton h-4 w-${20 + i * 4}"></div></td>`).join('')}</tr>`;
    tbody.innerHTML = row.repeat(4);
  }

  // ─── 事件绑定 ───────────────────────────────────────────────────────
  function bindEvents() {
    $btnRefresh.addEventListener('click', loadAll);

    $hostSelect.addEventListener('change', () => {
      localStorage.setItem('1shell-last-host', getHostId());
      sites = []; certs = [];
    });

    // Tab 切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $btnAddSite.addEventListener('click', () => openAddSiteModal());

    $btnApplyCert.addEventListener('click', () => openCertApplyModal(''));

    $btnAddDns.addEventListener('click', () => openDnsFormModal());

    // 表格操作（事件委托）
    $sitesBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'view-conf') viewConfig(btn.dataset.file);
      if (btn.dataset.act === 'apply-cert') openCertApplyModal(btn.dataset.domain);
      if (btn.dataset.act === 'delete-site') openDeleteModal({
        kind: 'site',
        domain: btn.dataset.domain,
        confPath: btn.dataset.file && btn.dataset.file.startsWith('/') ? btn.dataset.file : undefined,
      });
    });

    $certsBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'renew-cert') renewCert(btn.dataset.domain, btn.dataset.tool);
      if (btn.dataset.act === 'delete-cert') openDeleteModal({
        kind: 'cert',
        domain: btn.dataset.domain,
        certPath: btn.dataset.path,
      });
    });

    // DNS 表格操作
    $dnsBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'edit-dns') openDnsFormModal(btn.dataset.id);
      if (btn.dataset.act === 'delete-dns') deleteDnsProvider(btn.dataset.id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  添加站点 Modal
  // ═══════════════════════════════════════════════════════════════════

  // ─── 生成各服务器配置文件内容 ─────────────────────────────────────
  function buildSiteConf(server, domain, upstream, websocket) {
    const upstreamUrl = upstream.startsWith('http') ? upstream : `http://${upstream}`;

    if (server === 'caddy') {
      const wsLine = websocket ? '\n        header_up Connection {>Connection}\n        header_up Upgrade {>Upgrade}' : '';
      return `${domain} {\n    reverse_proxy ${upstream} {${wsLine}\n    }\n}\n`;
    }

    // nginx or openresty — identical directive syntax
    const wsBlock = websocket
      ? '\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";'
      : '';
    return `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass ${upstreamUrl};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;${wsBlock}
    }
}
`;
  }

  // 返回 { confPath, testCmd, reloadCmd } for a given server type
  function serverDeployMeta(server, domain) {
    if (server === 'caddy') {
      const confPath = `/etc/caddy/conf.d/${domain}.caddy`;
      return {
        confPath,
        testCmd: `caddy validate --config /etc/caddy/Caddyfile 2>&1 || caddy adapt --config '${confPath}' 2>&1`,
        reloadCmd: `systemctl reload caddy 2>/dev/null || caddy reload --config /etc/caddy/Caddyfile 2>/dev/null`,
        testErrPrefix: 'Caddy 配置检测失败',
        // Caddy conf.d is not always set up; ensure dir
        ensureDir: 'mkdir -p /etc/caddy/conf.d && grep -q "import conf.d" /etc/caddy/Caddyfile 2>/dev/null || echo "import conf.d/*.caddy" >> /etc/caddy/Caddyfile',
      };
    }
    const confDir = server === 'openresty'
      ? '/usr/local/openresty/nginx/conf/conf.d'
      : '/etc/nginx/sites-enabled';
    const bin = server === 'openresty' ? 'openresty' : 'nginx';
    return {
      confPath: `${confDir}/${domain}.conf`,
      testCmd: `${bin} -t 2>&1`,
      reloadCmd: `systemctl reload ${bin} 2>/dev/null || ${bin} -s reload 2>/dev/null`,
      testErrPrefix: `${bin} 配置检测失败`,
      ensureDir: `mkdir -p '${confDir}'`,
    };
  }

  function openAddSiteModal() {
    const sv = serverType || 'nginx';
    const svLabel = { nginx: 'Nginx', openresty: 'OpenResty', caddy: 'Caddy' }[sv] || sv;

    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">+ 添加反向代理站点</div>
        <div class="text-[11px] text-slate-400">生成 ${svLabel} 反向代理配置并部署到远程主机</div>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3">
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">域名 <span class="text-red-400">*</span></label>
          <input id="site-domain" type="text" placeholder="example.com" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400" /></div>
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">上游地址 <span class="text-red-400">*</span></label>
          <input id="site-upstream" type="text" placeholder="127.0.0.1:3000" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono outline-none focus:border-blue-400" /></div>
        <div class="flex items-center gap-2">
          <input id="site-websocket" type="checkbox" class="accent-blue-500" />
          <label for="site-websocket" class="text-xs text-slate-600 dark:text-slate-300">启用 WebSocket 支持</label>
        </div>
        <div class="text-[10px] text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-3 py-2">
          当前服务器：<span class="font-semibold text-slate-600 dark:text-slate-300">${svLabel}</span>
          ${serverVersion ? `<span class="ml-2 text-slate-400">${escapeHtml(serverVersion.split('/').pop() || serverVersion)}</span>` : ''}
        </div>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2 justify-end">
        <button class="act-btn act-btn-default modal-cancel">取消</button>
        <button class="act-btn act-btn-primary site-submit">&#9654; 部署站点</button>
      </div>
    </div>`;

    $modalRoot.appendChild(el);
    el.querySelector('.modal-cancel').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    el.querySelector('.site-submit').addEventListener('click', async () => {
      const domain = el.querySelector('#site-domain').value.trim();
      const upstream = el.querySelector('#site-upstream').value.trim();
      const websocket = el.querySelector('#site-websocket').checked;

      if (!domain) { showToast('请输入域名', 'warn'); return; }
      if (!upstream) { showToast('请输入上游地址', 'warn'); return; }

      const conf = buildSiteConf(sv, domain, upstream, websocket);
      const { confPath, testCmd, reloadCmd, testErrPrefix, ensureDir } = serverDeployMeta(sv, domain);

      const body = el.querySelector('.modal-box > div:last-child');
      body.innerHTML = `<div class="flex items-center gap-3 px-5 py-4"><div class="relative w-8 h-8"><div class="absolute inset-0 rounded-full border-2 border-slate-200 dark:border-slate-700"></div><div class="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-500 animate-spin"></div></div><span class="text-xs text-slate-500 deploy-status">准备部署…</span></div>`;
      const statusTxt = body.querySelector('.deploy-status');

      try {
        // 确保 conf 目录存在（Caddy conf.d / openresty conf.d 可能不存在）
        if (ensureDir) await safeExec(ensureDir, 5000);

        // 写入配置文件（用 tee 代替 echo 规避单引号转义问题）
        statusTxt.textContent = '写入配置文件…';
        const writeRes = await exec(`cat > '${confPath}' << '__EOFCONF__'\n${conf}__EOFCONF__`, 8000);
        if (writeRes.exitCode !== 0) throw new Error(writeRes.stderr || '写入配置失败');

        // 测试配置
        statusTxt.textContent = '检测配置语法…';
        const testRes = await exec(testCmd, 10000);
        if (testRes.exitCode !== 0) {
          await safeExec(`rm -f '${confPath}'`, 5000);
          throw new Error(`${testErrPrefix}: ` + (testRes.stdout || testRes.stderr));
        }

        // 重载
        statusTxt.textContent = '重载服务…';
        await exec(reloadCmd, 10000);

        showToast(`站点 ${domain} 已部署`, 'success');
        el.remove();
        await loadAll();
      } catch (err) {
        body.innerHTML = `<div class="flex flex-col items-center gap-2 px-5 py-4">
          <div class="text-red-500 text-xl">&#10007;</div>
          <div class="text-xs text-red-500 text-center">${escapeHtml(err.message)}</div>
          <button class="act-btn act-btn-default mt-1 close-btn">关闭</button>
        </div>`;
        body.querySelector('.close-btn')?.addEventListener('click', () => el.remove());
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  DNS 凭据管理
  // ═══════════════════════════════════════════════════════════════════

  async function loadDnsProviders() {
    try {
      const data = await requestJson('/api/dns-providers');
      dnsProviders = data.providers || [];
      renderDnsTable();
    } catch (err) {
      $dnsBody.innerHTML = `<tr><td colspan="6" class="text-center text-red-400 py-6">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderDnsTable() {
    if (dnsProviders.length === 0) {
      $dnsBody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-400 py-8">暂无 DNS 凭据，点击"+ 添加凭据"配置 Cloudflare API Token</td></tr>';
      return;
    }

    $dnsBody.innerHTML = dnsProviders.map(p => `<tr>
      <td class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(p.domain)}</td>
      <td class="text-[11px] text-slate-500">${escapeHtml(p.provider || 'cloudflare')}</td>
      <td class="font-mono text-[11px] text-slate-400">${escapeHtml(p.token)}</td>
      <td class="text-[11px] text-slate-400">${escapeHtml(p.note || '-')}</td>
      <td class="text-[11px] text-slate-400">${p.createdAt ? new Date(p.createdAt).toLocaleDateString('zh-CN') : '-'}</td>
      <td class="text-right whitespace-nowrap">
        <button class="act-btn act-btn-default" data-act="edit-dns" data-id="${escapeHtml(p.id)}">&#9998;</button>
        <button class="act-btn act-btn-danger" data-act="delete-dns" data-id="${escapeHtml(p.id)}">&#128465;</button>
      </td>
    </tr>`).join('');
  }

  function openDnsFormModal(editId) {
    const existing = editId ? dnsProviders.find(p => p.id === editId) : null;
    const isEdit = Boolean(existing);

    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal-box">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">${isEdit ? '编辑 DNS 凭据' : '添加 DNS 凭据'}</div>
        <div class="text-[11px] text-slate-400">保存后，申请证书时可直接选择域名，无需重复填写 Token</div>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3">
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">域名 <span class="text-red-400">*</span></label>
          <input id="dns-domain" type="text" placeholder="example.com（支持根域名）" value="${escapeHtml(existing?.domain || '')}" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400" /></div>
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">DNS 提供商</label>
          <select id="dns-provider-type" class="w-full h-8 px-2 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400">
            <option value="cloudflare" selected>Cloudflare</option>
          </select></div>
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">API Token <span class="text-red-400">*</span></label>
          <input id="dns-token" type="password" placeholder="${isEdit ? '留空不修改' : 'Cloudflare API Token'}" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono outline-none focus:border-blue-400" /></div>
        <div><label class="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">备注</label>
          <input id="dns-note" type="text" placeholder="可选" value="${escapeHtml(existing?.note || '')}" class="w-full h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs outline-none focus:border-blue-400" /></div>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2 justify-end">
        <button class="act-btn act-btn-default modal-cancel">取消</button>
        <button class="act-btn act-btn-primary dns-save">${isEdit ? '保存修改' : '添加'}</button>
      </div>
    </div>`;

    $modalRoot.appendChild(el);
    el.querySelector('.modal-cancel').addEventListener('click', () => el.remove());
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });

    el.querySelector('.dns-save').addEventListener('click', async () => {
      const domain = el.querySelector('#dns-domain').value.trim();
      const provider = el.querySelector('#dns-provider-type').value;
      const token = el.querySelector('#dns-token').value.trim();
      const note = el.querySelector('#dns-note').value.trim();

      if (!domain) { showToast('请输入域名', 'warn'); return; }
      if (!isEdit && !token) { showToast('请输入 API Token', 'warn'); return; }

      try {
        if (isEdit) {
          const body = { domain, provider, note };
          if (token) body.token = token;
          await requestJson(`/api/dns-providers/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
          showToast('凭据已更新', 'success');
        } else {
          await requestJson('/api/dns-providers', { method: 'POST', body: JSON.stringify({ domain, provider, token, note }) });
          showToast('凭据已添加', 'success');
        }
        el.remove();
        await loadDnsProviders();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  async function deleteDnsProvider(id) {
    if (!confirm('确认删除该 DNS 凭据？')) return;
    try {
      await requestJson(`/api/dns-providers/${id}`, { method: 'DELETE' });
      showToast('已删除', 'success');
      await loadDnsProviders();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  init();
})();
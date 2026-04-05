(() => {
  'use strict';

  function createHostsModule({
    LOCAL_HOST_ID,
    escapeHtml,
    getSessionTerminalModule,
    requestJson,
    showErrorMessage,
    showToast,
    state,
    updateActiveHostUI,
  }) {
    const hostListEl = document.getElementById('host-list');
    const hostSearchEl = document.getElementById('host-search');
    const secretWarningEl = document.getElementById('secret-warning');
    const hostModalEl = document.getElementById('host-modal');
    const hostFormEl = document.getElementById('host-form');
    const hostFormTitleEl = document.getElementById('host-form-title');
    const hostFormErrorEl = document.getElementById('host-form-error');
    const hostIdEl = document.getElementById('host-id');
    const hostNameEl = document.getElementById('host-name');
    const hostAddressEl = document.getElementById('host-address');
    const hostPortEl = document.getElementById('host-port');
    const hostUsernameEl = document.getElementById('host-username');
    const hostPasswordEl = document.getElementById('host-password');
    const hostPrivateKeyEl = document.getElementById('host-private-key');
    const hostPassphraseEl = document.getElementById('host-passphrase');
    const authPasswordPanelEl = document.getElementById('auth-password-panel');
    const authKeyPanelEl = document.getElementById('auth-key-panel');
    const hostLinksListEl = document.getElementById('host-links-list');
    const addLinkBtnEl = document.getElementById('add-link-btn');
    const hostProxyEl = document.getElementById('host-proxy');
    let authType = 'password';

    function renderLinkRows(links = []) {
      const normalizedLinks = Array.isArray(links) && links.length ? links : [{ id: '', name: '', url: '', description: '' }];

      hostLinksListEl.innerHTML = normalizedLinks.map((link, index) => `
        <div class="link-row" data-link-index="${index}" data-link-id="${escapeHtml(link.id || '')}">
          <div class="form-row two-cols">
            <div class="form-group">
              <label for="host-link-name-${index}">链接名称</label>
              <input id="host-link-name-${index}" data-link-field="name" type="text" placeholder="例如：官网" value="${escapeHtml(link.name || '')}" />
            </div>
            <div class="form-group">
              <label for="host-link-url-${index}">链接地址</label>
              <input id="host-link-url-${index}" data-link-field="url" type="text" placeholder="https://example.com" value="${escapeHtml(link.url || '')}" />
            </div>
          </div>
          <div class="form-row link-row-footer">
            <div class="form-group">
              <label for="host-link-description-${index}">描述</label>
              <input id="host-link-description-${index}" data-link-field="description" type="text" placeholder="例如：业务后台" value="${escapeHtml(link.description || '')}" />
            </div>
            <button class="host-action-btn link-remove-btn" data-action="remove-link" data-link-index="${index}" type="button">删除链接</button>
          </div>
        </div>
      `).join('');
    }

    function collectLinkRows({ keepEmpty = false } = {}) {
      const links = [...hostLinksListEl.querySelectorAll('.link-row')].map((row) => ({
        id: row.dataset.linkId || '',
        name: row.querySelector('[data-link-field="name"]')?.value.trim() || '',
        url: row.querySelector('[data-link-field="url"]')?.value.trim() || '',
        description: row.querySelector('[data-link-field="description"]')?.value.trim() || '',
      }));

      return keepEmpty ? links : links.filter((link) => link.name || link.url || link.description);
    }

    function readLinksFromForm() {
      return collectLinkRows();
    }

    function addLinkRow() {
      const links = collectLinkRows({ keepEmpty: true });
      links.push({ id: '', name: '', url: '', description: '' });
      renderLinkRows(links);
    }

    function removeLinkRow(index) {
      const links = collectLinkRows({ keepEmpty: true }).filter((_, currentIndex) => currentIndex !== index);
      renderLinkRows(links);
    }

    function renderHostLinks(host) {
      renderLinkRows(host?.links || []);
    }

    function withSessionTerminal() {
      const sessionTerminalModule = getSessionTerminalModule?.();
      if (!sessionTerminalModule) {
        throw new Error('终端模块未初始化');
      }
      return sessionTerminalModule;
    }

    function renderHosts() {
      const keyword = state.filteredKeyword.trim().toLowerCase();
      const hosts = state.hosts.filter((host) => {
        if (!keyword) return true;
        return [host.name, host.host, host.username]
          .filter(Boolean)
          .some((item) => String(item).toLowerCase().includes(keyword));
      });

      if (!hosts.length) {
        hostListEl.innerHTML = '<div class="host-empty">没有匹配的主机</div>';
        return;
      }

      hostListEl.innerHTML = hosts.map((host) => {
        const isActive = host.id === state.activeHostId;
        const session = [...state.sessionMap.values()].find((item) => item.hostId === host.id && item.status !== 'closed');
        const statusText = session ? session.status : '未连接';

        return `
          <div class="host-item ${isActive ? 'active' : ''}" data-host-id="${host.id}">
            <div class="host-main">
              <div class="host-name">${escapeHtml(host.name)}</div>
              <div class="host-meta">
                <span>${escapeHtml(host.type === 'local' ? '本地 Shell' : `${host.username}@${host.host}:${host.port}`)}</span>
                ${host.proxyHostId ? `<span class="host-proxy-badge">经 ${escapeHtml(state.hostMap.get(host.proxyHostId)?.name || '跳板机')} 中继</span>` : ''}
                <span>状态：${escapeHtml(statusText)}</span>
              </div>
              ${Array.isArray(host.links) && host.links.length ? `
                <div class="host-links">
                  <div class="host-links-title">网站任意门</div>
                  <div class="host-links-list">
                    ${host.links.map((link) => `
                      <a
                        class="host-link-chip"
                        href="${escapeHtml(link.url)}"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="${escapeHtml(link.description || link.url)}"
                      >${escapeHtml(link.name)}</a>
                    `).join('')}
                  </div>
                </div>
              ` : ''}
            </div>
            <div class="host-actions">
              <button class="host-action-btn" data-action="connect" data-host-id="${host.id}" type="button">切换</button>
              ${host.id === LOCAL_HOST_ID ? '' : `<button class="host-action-btn" data-action="edit" data-host-id="${host.id}" type="button">编辑</button><button class="host-action-btn" data-action="delete" data-host-id="${host.id}" type="button">删除</button>`}
            </div>
          </div>
        `;
      }).join('');
    }

    async function loadHosts() {
      const data = await requestJson('/api/hosts');
      state.hosts = data.hosts || [];
      state.hostMap = new Map(state.hosts.map((host) => [host.id, host]));
      secretWarningEl.classList.toggle('hidden', !data.warnings?.usingFallbackSecret);

      if (!state.hostMap.has(state.activeHostId)) {
        state.activeHostId = LOCAL_HOST_ID;
        state.activeSessionId = null;
      }

      updateActiveHostUI();
      renderHosts();
    }

    function populateProxyDropdown(editingHostId = null) {
      const sshHosts = state.hosts.filter((h) => h.type === 'ssh' && h.id !== editingHostId && !h.proxyHostId);
      hostProxyEl.innerHTML = '<option value="">直连（无跳板）</option>'
        + sshHosts.map((h) => `<option value="${h.id}">${escapeHtml(h.name)} (${escapeHtml(h.host)})</option>`).join('');
    }

    function openHostModal(host = null) {
      hostFormErrorEl.textContent = '';
      hostFormEl.reset();
      hostIdEl.value = host?.id || '';
      hostNameEl.value = host?.name || '';
      hostAddressEl.value = host?.host || '';
      hostPortEl.value = host?.port || 22;
      hostUsernameEl.value = host?.username || '';
      hostPasswordEl.value = '';
      hostPrivateKeyEl.value = '';
      hostPassphraseEl.value = '';
      populateProxyDropdown(host?.id || null);
      hostProxyEl.value = host?.proxyHostId || '';
      renderHostLinks(host);
      authType = host?.authType === 'privateKey' ? 'privateKey' : 'password';
      hostFormTitleEl.textContent = host ? '编辑主机' : '新增主机';
      syncAuthTabs();
      hostModalEl.classList.remove('hidden');
    }

    function closeHostModal() {
      hostModalEl.classList.add('hidden');
    }

    function syncAuthTabs() {
      document.querySelectorAll('.auth-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.auth === authType);
      });

      authPasswordPanelEl.classList.toggle('hidden', authType !== 'password');
      authKeyPanelEl.classList.toggle('hidden', authType !== 'privateKey');
    }

    async function saveHost(event) {
      event.preventDefault();
      hostFormErrorEl.textContent = '';

      const hostId = hostIdEl.value.trim();
      const isEditing = Boolean(hostId);
      const payload = {
        name: hostNameEl.value.trim(),
        host: hostAddressEl.value.trim(),
        port: Number(hostPortEl.value) || 22,
        username: hostUsernameEl.value.trim(),
        authType,
        proxyHostId: hostProxyEl.value || null,
        links: readLinksFromForm(),
      };

      if (authType === 'password') {
        if (!isEditing || hostPasswordEl.value) {
          payload.password = hostPasswordEl.value;
        }
      } else {
        if (!isEditing || hostPrivateKeyEl.value.trim()) {
          payload.privateKey = hostPrivateKeyEl.value;
        }
        if (!isEditing || hostPassphraseEl.value) {
          payload.passphrase = hostPassphraseEl.value;
        }
      }

      try {
        if (hostId) {
          await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          });
        } else {
          await requestJson('/api/hosts', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }

        await loadHosts();
        closeHostModal();
        showToast?.(hostId ? '主机已更新' : '主机已添加', 'success');
      } catch (error) {
        hostFormErrorEl.textContent = error.message;
      }
    }

    async function deleteHost(hostId) {
      const host = state.hostMap.get(hostId);
      if (!host) return;
      if (!window.confirm(`确认删除主机“${host.name}”吗？`)) return;

      await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, {
        method: 'DELETE',
      });

      if (state.activeHostId === hostId) {
        state.activeHostId = LOCAL_HOST_ID;
        state.activeSessionId = null;
      }

      await loadHosts();
      await withSessionTerminal().connectToHost(state.activeHostId, true);
    }

    function initialize() {
      syncAuthTabs();

      document.getElementById('add-host-btn').addEventListener('click', () => openHostModal());
      document.getElementById('refresh-hosts-btn').addEventListener('click', () => {
        loadHosts().catch(showErrorMessage);
      });
      document.getElementById('host-modal-close').addEventListener('click', closeHostModal);

      hostSearchEl.addEventListener('input', () => {
        state.filteredKeyword = hostSearchEl.value;
        renderHosts();
      });

      hostFormEl.addEventListener('submit', saveHost);
      addLinkBtnEl.addEventListener('click', addLinkRow);

      document.querySelectorAll('.auth-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          authType = tab.dataset.auth;
          syncAuthTabs();
        });
      });

      hostListEl.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action]');
        if (!target) return;

        const hostId = target.dataset.hostId;
        const action = target.dataset.action;

        if (action === 'connect') {
          withSessionTerminal().connectToHost(hostId).catch(showErrorMessage);
          return;
        }

        if (action === 'edit') {
          openHostModal(state.hostMap.get(hostId));
          return;
        }

        if (action === 'delete') {
          deleteHost(hostId).catch(showErrorMessage);
        }
      });

      hostLinksListEl.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action="remove-link"]');
        if (!target) return;
        removeLinkRow(Number(target.dataset.linkIndex));
      });
    }

    return {
      closeHostModal,
      initialize,
      loadHosts,
      renderHosts,
    };
  }

  window.createHostsModule = createHostsModule;
})();

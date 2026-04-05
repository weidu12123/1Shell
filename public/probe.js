(() => {
  'use strict';

  function createProbeModule({
    escapeHtml,
    getSocket,
    requestJson,
    showErrorMessage,
  }) {
    const probeBtnEl = document.getElementById('probe-btn');
    const probeCloseBtnEl = document.getElementById('probe-close-btn');
    const probeRefreshBtnEl = document.getElementById('probe-refresh-btn');
    const probeDrawerEl = document.getElementById('probe-drawer');
    const probeSummaryEl = document.getElementById('probe-summary');
    const drawerProbeSummaryEl = document.getElementById('drawer-probe-summary');
    const probeListEl = document.getElementById('probe-list');
    const expandedProbeIds = new Set();
    const ERROR_CODE_LABELS = Object.freeze({
      AUTH_FAILED: '认证失败',
      CONNECTION_REFUSED: '端口拒绝',
      DNS_ERROR: 'DNS 解析失败',
      EXEC_ERROR: '远端执行失败',
      NETWORK_UNREACHABLE: '网络不可达',
      NO_ROUTE: '无路由',
      REMOTE_ERROR: '远端错误',
      SSH_ERROR: 'SSH 错误',
      TIMEOUT: '连接超时',
      UNKNOWN: '未知错误',
    });

    function formatPercent(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
      return `${Number(value).toFixed(1)}%`;
    }

    function formatLatency(value) {
      if (value === null || value === undefined) return '--';
      return `${value} ms`;
    }

    function formatBandwidth(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
      const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
      let size = Number(value);
      let unitIndex = 0;

      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
      }

      const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
      return `${size.toFixed(precision)} ${units[unitIndex]}`;
    }

    function formatTime(value) {
      if (!value) return '--';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '--';
      return date.toLocaleTimeString();
    }

    function formatUptime(seconds) {
      if (!seconds && seconds !== 0) return '--';
      const day = Math.floor(seconds / 86400);
      const hour = Math.floor((seconds % 86400) / 3600);
      const minute = Math.floor((seconds % 3600) / 60);
      if (day > 0) return `${day}天 ${hour}小时`;
      if (hour > 0) return `${hour}小时 ${minute}分钟`;
      return `${minute}分钟`;
    }
    let initialized = false;
    let lastSnapshot = {
      generatedAt: null,
      probes: [],
      sampleIntervalMs: null,
    };

    function ensureSocket() {
      const currentSocket = getSocket?.();
      if (!currentSocket) {
        throw new Error('Socket 未连接');
      }
      return currentSocket;
    }

    function detachSocketListeners() {
      const currentSocket = getSocket?.();
      currentSocket?.off('probe:update');
    }

    function getProbeStatusText(probe) {
      if (probe.online) return '在线';
      return probe.stale ? '离线（沿用旧指标）' : '离线';
    }

    function getErrorCodeText(errorCode) {
      if (!errorCode) return '--';
      return ERROR_CODE_LABELS[errorCode] || errorCode;
    }

    function renderSummary(total, onlineCount, offlineCount, staleCount, generatedAt, sampleIntervalMs) {
      probeSummaryEl.innerHTML = [
        ['总主机数', total],
        ['在线', onlineCount],
        ['离线', offlineCount],
        ['旧数据主机', staleCount],
        ['最近推送', formatTime(generatedAt)],
        ['采样间隔', sampleIntervalMs ? `${Math.round(sampleIntervalMs / 1000)} 秒` : '--'],
      ].map(([label, value]) => `
        <div class="probe-summary-item">
          <span class="probe-stat-label">${label}</span>
          <span class="probe-stat-value">${value}</span>
        </div>
      `).join('');
    }

    function renderPerformanceStats(probe) {
      return [
        ['磁盘使用', formatPercent(probe.diskUsage)],
        ['Load 1m', probe.load1 ?? '--'],
        ['Load 5m', probe.load5 ?? '--'],
        ['Load 15m', probe.load15 ?? '--'],
        ['磁盘读', formatBandwidth(probe.diskReadBps)],
        ['磁盘写', formatBandwidth(probe.diskWriteBps)],
      ].map(([label, value]) => `
        <div class="probe-stat probe-detail-stat">
          <span class="probe-stat-label">${escapeHtml(label)}</span>
          <span class="probe-stat-value">${escapeHtml(String(value))}</span>
        </div>
      `).join('');
    }

    function renderStatusStats(probe) {
      return [
        ['失败分类', getErrorCodeText(probe.errorCode)],
        ['数据来源', probe.stale ? '最近一次成功快照' : probe.online ? '实时采样' : '本次失败'],
        ['最后更新', formatTime(probe.checkedAt)],
        ['最后成功', probe.lastSuccessAt ? formatTime(probe.lastSuccessAt) : '--'],
      ].map(([label, value]) => `
        <div class="probe-stat probe-detail-stat">
          <span class="probe-stat-label">${escapeHtml(label)}</span>
          <span class="probe-stat-value">${escapeHtml(String(value))}</span>
        </div>
      `).join('');
    }

    function renderDetailStats(probe) {
      return `
        <div class="probe-detail-section">
          <div class="probe-detail-title">关键进程</div>
          ${renderKeyProcesses(probe)}
        </div>
        <div class="probe-detail-section">
          <div class="probe-detail-title">性能</div>
          <div class="probe-detail-grid">
            ${renderPerformanceStats(probe)}
          </div>
        </div>
        <div class="probe-detail-section">
          <div class="probe-detail-title">异常与来源</div>
          <div class="probe-detail-grid">
            ${renderStatusStats(probe)}
          </div>
        </div>
      `;
    }

    function renderKeyProcesses(probe) {
      if (!Array.isArray(probe.keyProcesses) || !probe.keyProcesses.length) {
        return '<div class="probe-detail-empty">暂无关键进程摘要</div>';
      }

      return `
        <div class="probe-process-list">
          ${probe.keyProcesses.map((item) => `
            <span class="probe-process-chip ${item.running ? 'running' : 'stopped'}">
              ${escapeHtml(item.name)}
              <span class="probe-process-count">${escapeHtml(String(item.count ?? 0))}</span>
            </span>
          `).join('')}
        </div>
      `;
    }

    function renderProbeCard(probe) {
      const expanded = expandedProbeIds.has(probe.hostId);

      return `
        <div class="probe-card ${probe.online ? '' : 'offline'} ${probe.stale ? 'stale' : ''}">
          <div class="probe-card-top">
            <div>
              <div class="probe-name">${escapeHtml(probe.name)}</div>
              <div class="probe-meta">${escapeHtml(probe.hostname || '--')}</div>
            </div>
            <div>
              <div class="status-dot ${probe.online ? 'online' : 'offline'}"></div>
              <div class="probe-status-text">${getProbeStatusText(probe)}</div>
            </div>
          </div>
          ${probe.error ? `<div class="probe-error">${escapeHtml(probe.error)}</div>` : ''}
          <div class="probe-bandwidth probe-stat">
            <div class="probe-bandwidth-item">
              <span class="probe-stat-label">↑ 上行</span>
              <span class="probe-bandwidth-value">${formatBandwidth(probe.bandwidthTxBps)}</span>
            </div>
            <div class="probe-bandwidth-item">
              <span class="probe-stat-label">↓ 下行</span>
              <span class="probe-bandwidth-value">${formatBandwidth(probe.bandwidthRxBps)}</span>
            </div>
          </div>
          <div class="probe-stats probe-stats-core">
            <div class="probe-stat"><span class="probe-stat-label">延迟</span><span class="probe-stat-value">${formatLatency(probe.latencyMs)}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">CPU</span><span class="probe-stat-value">${formatPercent(probe.cpuUsage)}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">内存</span><span class="probe-stat-value">${formatPercent(probe.memoryUsage)}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">进程</span><span class="probe-stat-value">${probe.processCount ?? '--'}</span></div>
          </div>
          <div class="probe-footer-meta">
            <span>最后更新 ${formatTime(probe.checkedAt)}</span>
            <span>${probe.lastSuccessAt ? `最后成功 ${formatTime(probe.lastSuccessAt)}` : '暂无成功采样'}</span>
          </div>
          <div class="probe-card-actions">
            <button class="probe-detail-toggle ${expanded ? 'expanded' : ''}" data-host-id="${escapeHtml(probe.hostId)}" type="button">
              <span class="probe-detail-toggle-icon">${expanded ? '▾' : '▸'}</span>
              <span>${expanded ? '收起详情' : '查看详情'}</span>
            </button>
          </div>
          ${expanded ? `
            <div class="probe-detail-panel">
              ${renderDetailStats(probe)}
            </div>
          ` : ''}
        </div>
      `;
    }

    async function loadProbes(forceRefresh = false) {
      if(probeSummaryEl) probeSummaryEl.innerHTML = '';
      if(drawerProbeSummaryEl) drawerProbeSummaryEl.innerHTML = '';
      const data = await requestJson(forceRefresh ? '/api/probes?refresh=1' : '/api/probes');
      renderProbes(data.probes || [], data.generatedAt, data.sampleIntervalMs);
    }

    function renderProbes(probes, generatedAt, sampleIntervalMs) {
      lastSnapshot = {
        probes,
        generatedAt,
        sampleIntervalMs,
      };

      const total = probes.length;
      const onlineCount = probes.filter((item) => item.online).length;
      const offlineCount = total - onlineCount;
      const staleCount = probes.filter((item) => item.stale).length;

      renderSummary(total, onlineCount, offlineCount, staleCount, generatedAt, sampleIntervalMs);

      if (!probes.length) {
        probeListEl.innerHTML = '<div class="probe-empty">暂无探针数据</div>';
        return;
      }

      probeListEl.innerHTML = probes.map((probe) => renderProbeCard(probe)).join('');
    }

    function toggleProbeDetails(hostId) {
      if (!hostId) return;

      if (expandedProbeIds.has(hostId)) {
        expandedProbeIds.delete(hostId);
      } else {
        expandedProbeIds.add(hostId);
      }

      renderProbes(lastSnapshot.probes || [], lastSnapshot.generatedAt, lastSnapshot.sampleIntervalMs);
    }

    function attachSocketListeners() {
      const currentSocket = ensureSocket();
      currentSocket.off('probe:update');
      currentSocket.on('probe:update', (snapshot = {}) => {
        if (probeDrawerEl.classList.contains('hidden')) return;
        renderProbes(snapshot.probes || [], snapshot.generatedAt, snapshot.sampleIntervalMs);
      });
    }

    function openProbeDrawer() {
      probeDrawerEl.classList.remove('hidden');
      attachSocketListeners();
      loadProbes().catch((error) => {
        if(probeSummaryEl) probeSummaryEl.innerHTML = '';
      if(drawerProbeSummaryEl) drawerProbeSummaryEl.innerHTML = '';
        probeListEl.innerHTML = '';
      });
    }

    function closeProbeDrawer() {
      probeDrawerEl.classList.add('hidden');
      detachSocketListeners();
    }

    function initialize() {
      if (initialized) return;
      initialized = true;

      probeBtnEl.addEventListener('click', openProbeDrawer);
      probeCloseBtnEl.addEventListener('click', closeProbeDrawer);
      probeRefreshBtnEl.addEventListener('click', () => {
        loadProbes(true).catch(showErrorMessage);
      });
      probeListEl.addEventListener('click', (event) => {
        const toggleButton = event.target.closest('.probe-detail-toggle');
        if (!toggleButton) return;
        toggleProbeDetails(toggleButton.dataset.hostId || '');
      });
    }

    return {
      closeProbeDrawer,
      initialize,
      loadProbes,
      openProbeDrawer,
    };
  }

  window.createProbeModule = createProbeModule;
})();

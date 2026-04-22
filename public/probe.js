(() => {
  'use strict';

  function createProbeModule({
    escapeHtml,
    getSocket,
    requestJson,
    showErrorMessage,
    onSnapshot,
  }) {
    const probeBtnEl = document.getElementById('probe-btn');
    const probeCloseBtnEl = document.getElementById('probe-close-btn');
    const probeRefreshBtnEl = document.getElementById('probe-refresh-btn');
    const probeDrawerEl = document.getElementById('probe-drawer');
    const probeSummaryEl = document.getElementById('probe-summary');
    const probeListEl = document.getElementById('probe-list');
    const hasDrawerMode = Boolean(probeDrawerEl);
    const hasProbeView = Boolean(probeSummaryEl && probeListEl);
    const expandedProbeIds = new Set();
    const expandedTrendProbeIds = new Set();
    const probeHistoryMap = new Map();
    const MAX_TREND_POINTS = 24;
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

    function formatTrendTime(value) {
      if (!value) return '--';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '--';
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function normalizeBandwidthValue(value) {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return 0;
      return num;
    }

    function buildTickIndexes(length, tickCount = 4) {
      if (length <= 1) return [0];
      const indexes = new Set();
      for (let i = 0; i < tickCount; i += 1) {
        indexes.add(Math.round((i / (tickCount - 1)) * (length - 1)));
      }
      return [...indexes].sort((a, b) => a - b);
    }

    function buildTrendPath(points, valueGetter, getX, getY) {
      return points.map((point, index) => {
        const command = index === 0 ? 'M' : 'L';
        return `${command}${getX(index).toFixed(2)},${getY(valueGetter(point)).toFixed(2)}`;
      }).join(' ');
    }

    function renderTrendDots(points, valueGetter, getX, getY, className) {
      return points.map((point, index) => `
        <circle class="${className}" cx="${getX(index).toFixed(2)}" cy="${getY(valueGetter(point)).toFixed(2)}" r="2.8"></circle>
      `).join('');
    }

    function updateProbeHistory(probes = [], generatedAt) {
      const activeHostIds = new Set();

      for (const probe of probes) {
        if (!probe?.hostId) continue;
        activeHostIds.add(probe.hostId);

        const fallbackTime = probe.checkedAt || probe.lastSuccessAt || generatedAt || Date.now();
        const time = new Date(fallbackTime).getTime();
        const point = {
          time: Number.isFinite(time) ? time : Date.now(),
          rx: normalizeBandwidthValue(probe.bandwidthRxBps),
          tx: normalizeBandwidthValue(probe.bandwidthTxBps),
        };

        const history = probeHistoryMap.get(probe.hostId) || [];
        const lastPoint = history[history.length - 1];
        if (lastPoint && lastPoint.time === point.time) {
          history[history.length - 1] = point;
        } else {
          history.push(point);
        }

        if (history.length > MAX_TREND_POINTS) {
          history.splice(0, history.length - MAX_TREND_POINTS);
        }

        probeHistoryMap.set(probe.hostId, history);
      }

      for (const hostId of probeHistoryMap.keys()) {
        if (!activeHostIds.has(hostId)) {
          probeHistoryMap.delete(hostId);
        }
      }
    }

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
      if (!probeSummaryEl) return;
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

    function renderTrendChart(probe) {
      const history = probeHistoryMap.get(probe.hostId) || [];
      if (!history.length) {
        return `
          <div class="probe-trend-chart-wrap">
            <div class="probe-trend-chart-header">
              <div>
                <div class="probe-detail-title">带宽趋势</div>
                <div class="probe-trend-chart-meta">等待采样数据</div>
              </div>
            </div>
            <div class="probe-trend-empty">暂无带宽采样历史</div>
          </div>
        `;
      }

      const points = history.slice(-MAX_TREND_POINTS);
      const chartWidth = 360;
      const chartHeight = 180;
      const marginTop = 10;
      const marginRight = 14;
      const marginBottom = 28;
      const marginLeft = 52;
      const plotWidth = chartWidth - marginLeft - marginRight;
      const plotHeight = chartHeight - marginTop - marginBottom;
      const maxValue = Math.max(1, ...points.flatMap((point) => [point.rx, point.tx]));
      const getX = (index) => {
        if (points.length === 1) return marginLeft + (plotWidth / 2);
        return marginLeft + (index / (points.length - 1)) * plotWidth;
      };
      const getY = (value) => marginTop + plotHeight - ((value / maxValue) * plotHeight);
      const yTickValues = [maxValue, maxValue * (2 / 3), maxValue * (1 / 3), 0];
      const xTickIndexes = buildTickIndexes(points.length);
      const rxPath = buildTrendPath(points, (point) => point.rx, getX, getY);
      const txPath = buildTrendPath(points, (point) => point.tx, getX, getY);
      const lastPoint = points[points.length - 1];

      const horizontalGrid = yTickValues.map((tickValue) => {
        const y = getY(tickValue);
        return `
          <g>
            <line class="probe-trend-grid" x1="${marginLeft}" y1="${y.toFixed(2)}" x2="${(marginLeft + plotWidth).toFixed(2)}" y2="${y.toFixed(2)}"></line>
            <text class="probe-trend-label" x="${marginLeft - 8}" y="${(y + 3).toFixed(2)}" text-anchor="end">${escapeHtml(formatBandwidth(tickValue))}</text>
          </g>
        `;
      }).join('');

      const verticalGrid = xTickIndexes.map((index) => {
        const x = getX(index);
        return `
          <g>
            <line class="probe-trend-grid" x1="${x.toFixed(2)}" y1="${marginTop}" x2="${x.toFixed(2)}" y2="${(marginTop + plotHeight).toFixed(2)}"></line>
            <text class="probe-trend-label" x="${x.toFixed(2)}" y="${(marginTop + plotHeight + 18).toFixed(2)}" text-anchor="middle">${escapeHtml(formatTrendTime(points[index].time))}</text>
          </g>
        `;
      }).join('');

      return `
        <div class="probe-trend-chart-wrap">
          <div class="probe-trend-chart-header">
            <div>
              <div class="probe-detail-title">带宽趋势</div>
              <div class="probe-trend-chart-meta">最近 ${points.length} 次采样 · 最新 ${escapeHtml(formatTrendTime(lastPoint.time))}</div>
            </div>
            <div class="probe-trend-legend">
              <span class="probe-trend-legend-item"><span class="probe-trend-legend-line probe-trend-line-rx"></span><span>下行 Rx</span></span>
              <span class="probe-trend-legend-item"><span class="probe-trend-legend-line probe-trend-line-tx"></span><span>上行 Tx</span></span>
            </div>
          </div>
          ${points.length < 2 ? '<div class="probe-trend-empty">已记录 1 次采样，等待更多采样后显示完整折线。</div>' : ''}
          <svg class="probe-trend-svg" viewBox="0 0 360 180" role="img" aria-label="带宽趋势图">
            ${horizontalGrid}
            ${verticalGrid}
            <line class="probe-trend-axis" x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${(marginTop + plotHeight).toFixed(2)}"></line>
            <line class="probe-trend-axis" x1="${marginLeft}" y1="${(marginTop + plotHeight).toFixed(2)}" x2="${(marginLeft + plotWidth).toFixed(2)}" y2="${(marginTop + plotHeight).toFixed(2)}"></line>
            <path class="probe-trend-line-rx" d="${rxPath}"></path>
            <path class="probe-trend-line-tx" d="${txPath}"></path>
            ${renderTrendDots(points, (point) => point.rx, getX, getY, 'probe-trend-point-rx')}
            ${renderTrendDots(points, (point) => point.tx, getX, getY, 'probe-trend-point-tx')}
          </svg>
        </div>
      `;
    }

    function renderProbeCard(probe) {
      const detailExpanded = expandedProbeIds.has(probe.hostId);
      const trendExpanded = expandedTrendProbeIds.has(probe.hostId);
      const name = probe.name || probe.hostId || '未命名主机';

      return `
        <div class="probe-card ${probe.online ? '' : 'offline'} ${probe.stale ? 'stale' : ''}">
          <div class="probe-card-top">
            <div>
              <div class="probe-name">${escapeHtml(name)}</div>
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
            <button class="probe-trend-expand-btn ${trendExpanded ? 'expanded' : ''}" data-host-id="${escapeHtml(probe.hostId)}" type="button">
              <span class="probe-detail-toggle-icon">${trendExpanded ? '▾' : '▸'}</span>
              <span>${trendExpanded ? '收起趋势' : '带宽趋势'}</span>
            </button>
            <button class="probe-detail-toggle ${detailExpanded ? 'expanded' : ''}" data-host-id="${escapeHtml(probe.hostId)}" type="button">
              <span class="probe-detail-toggle-icon">${detailExpanded ? '▾' : '▸'}</span>
              <span>${detailExpanded ? '收起详情' : '查看详情'}</span>
            </button>
          </div>
          ${(detailExpanded || trendExpanded) ? `
            <div class="probe-detail-panel">
              ${trendExpanded ? renderTrendChart(probe) : ''}
              ${detailExpanded ? renderDetailStats(probe) : ''}
            </div>
          ` : ''}
        </div>
      `;
    }

    function applySnapshot(snapshot = {}) {
      const probes = snapshot.probes || [];
      updateProbeHistory(probes, snapshot.generatedAt);
      renderProbes(probes, snapshot.generatedAt, snapshot.sampleIntervalMs);
      onSnapshot?.(snapshot);
    }

    async function loadProbes(forceRefresh = false) {
      if (probeSummaryEl) probeSummaryEl.innerHTML = '';
      if (probeListEl) probeListEl.innerHTML = '';
      const data = await requestJson(forceRefresh ? '/api/probes?refresh=1' : '/api/probes');
      applySnapshot(data);
      return data;
    }

    function renderProbes(probes, generatedAt, sampleIntervalMs) {
      if (!hasProbeView) return;

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

    function toggleProbeTrend(hostId) {
      if (!hostId) return;

      if (expandedTrendProbeIds.has(hostId)) {
        expandedTrendProbeIds.delete(hostId);
      } else {
        expandedTrendProbeIds.add(hostId);
      }

      renderProbes(lastSnapshot.probes || [], lastSnapshot.generatedAt, lastSnapshot.sampleIntervalMs);
    }

    function shouldApplyRealtimeUpdates() {
      if (!hasProbeView) return false;
      if (!hasDrawerMode) return true;
      return !probeDrawerEl.classList.contains('hidden');
    }

    function attachSocketListeners() {
      let currentSocket;
      try {
        currentSocket = ensureSocket();
      } catch {
        return;
      }

      currentSocket.off('probe:update');
      currentSocket.on('probe:update', (snapshot = {}) => {
        if (!shouldApplyRealtimeUpdates()) return;
        applySnapshot(snapshot);
      });
    }

    function clearProbeView(message = '') {
      if (probeSummaryEl) probeSummaryEl.innerHTML = '';
      if (probeListEl) {
        probeListEl.innerHTML = message
          ? `<div class="probe-empty">${escapeHtml(message)}</div>`
          : '';
      }
    }

    function openProbeDrawer() {
      if (!hasDrawerMode) return;
      probeDrawerEl.classList.remove('hidden');
      attachSocketListeners();
      loadProbes().catch((error) => {
        clearProbeView(error.message || '加载探针失败');
      });
    }

    function closeProbeDrawer() {
      if (!hasDrawerMode) return;
      probeDrawerEl.classList.add('hidden');
      detachSocketListeners();
    }

    let initialized = false;
    let lastSnapshot = {
      generatedAt: null,
      probes: [],
      sampleIntervalMs: null,
    };

    function initialize() {
      if (initialized) return;
      initialized = true;

      if (hasDrawerMode && probeBtnEl) {
        probeBtnEl.addEventListener('click', (event) => {
          event.preventDefault();
          openProbeDrawer();
        });
      }
      if (hasDrawerMode && probeCloseBtnEl) {
        probeCloseBtnEl.addEventListener('click', closeProbeDrawer);
      }
      if (probeRefreshBtnEl) {
        probeRefreshBtnEl.addEventListener('click', () => {
          loadProbes(true).catch(showErrorMessage);
        });
      }
      if (probeListEl) {
        probeListEl.addEventListener('click', (event) => {
          const trendButton = event.target.closest('.probe-trend-expand-btn');
          if (trendButton) {
            toggleProbeTrend(trendButton.dataset.hostId || '');
            return;
          }

          const toggleButton = event.target.closest('.probe-detail-toggle');
          if (!toggleButton) return;
          toggleProbeDetails(toggleButton.dataset.hostId || '');
        });
      }

      if (!hasDrawerMode && hasProbeView) {
        attachSocketListeners();
        loadProbes().catch(showErrorMessage);
      }
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

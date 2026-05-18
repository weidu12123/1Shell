<script setup lang="ts">
import { computed } from 'vue';
import ProbeTrendChart from '@/components/ProbeTrendChart.vue';
import {
  type ProbeEntry,
  type ProbeSample,
  type MetricKey,
  type TimeWindow,
  METRIC_LABELS,
  TIME_WINDOW_LABELS,
  formatBandwidth,
  formatBytes,
  formatLatency,
  formatPercent,
  formatTime,
  getProbeStatusText,
  getErrorCodeText,
  getDataSourceText,
  getPlatformText,
  getAgentStatusText,
  getTrafficLevel,
  hasTrafficData,
} from '@/utils/probe';

const props = defineProps<{
  probe: ProbeEntry;
  samples: ProbeSample[];
  samplesLoading?: boolean;
  detailExpanded: boolean;
  metric: MetricKey;
  timeWindow: TimeWindow;
  agentActionLoading?: boolean;
}>();

const emit = defineEmits<{
  toggleDetail: [hostId: string];
  setMetric: [hostId: string, metric: MetricKey];
  setTimeWindow: [hostId: string, window: TimeWindow];
  installAgent: [hostId: string];
  uninstallAgent: [hostId: string];
  restartAgent: [hostId: string];
  viewAgentLogs: [hostId: string];
  diagnose: [hostId: string];
}>();

const displayName = computed(() => props.probe.name || props.probe.hostId || '未命名主机');

const trendAvailable = computed(() => {
  if (props.probe.source !== 'agent' && props.probe.source !== 'relay_agent') return false;
  return Boolean(
    props.probe.agentInstalled
    || props.probe.agentOnline
    || props.probe.agentTrusted
    || props.samples.length > 0
    || props.probe.cpuUsage != null
    || props.probe.memoryUsage != null
    || props.probe.bandwidthRxBps != null
    || props.probe.bandwidthTxBps != null,
  );
});

const metricTabs: MetricKey[] = ['bandwidth', 'cpuUsage', 'memoryUsage', 'diskUsage', 'load'];
const timeWindows: TimeWindow[] = ['1h', '6h', '24h', '7d', '30d'];

function onDetailClick(): void { emit('toggleDetail', props.probe.hostId); }
function onMetricClick(metric: MetricKey): void { emit('setMetric', props.probe.hostId, metric); }
function onTimeWindowClick(w: TimeWindow): void { emit('setTimeWindow', props.probe.hostId, w); }
function onInstallAgentClick(): void { emit('installAgent', props.probe.hostId); }
function onUninstallAgentClick(): void { emit('uninstallAgent', props.probe.hostId); }
function onRestartAgentClick(): void { emit('restartAgent', props.probe.hostId); }
function onViewAgentLogsClick(): void { emit('viewAgentLogs', props.probe.hostId); }
function onDiagnoseClick(): void { emit('diagnose', props.probe.hostId); }

const trafficVisible = computed(() => hasTrafficData(props.probe));
const trafficLevel = computed(() => getTrafficLevel(props.probe));
const trafficBarWidth = computed(() => {
  const p = props.probe.trafficPercent;
  if (p === null || p === undefined) return 0;
  return Math.max(0, Math.min(100, p));
});
const trafficLimitText = computed(() => {
  const limit = props.probe.trafficLimitBytes;
  return (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) ? formatBytes(limit) : '未设配额';
});
</script>

<template>
  <div
    class="probe-card"
    :class="{ offline: !probe.online, stale: probe.stale }"
  >
    <!-- 顶部：名字 + 状态 -->
    <div class="probe-card-top">
      <div>
        <div class="probe-name">{{ displayName }}</div>
        <div class="probe-meta">{{ probe.hostname || '--' }}</div>
      </div>
      <div class="text-right">
        <div class="status-dot inline-block" :class="probe.online ? 'online' : 'offline'"></div>
        <div class="probe-status-text">{{ getProbeStatusText(probe) }}</div>
        <div
          class="probe-agent-badge"
          :class="probe.agentTrusted ? 'online' : probe.agentOnline ? 'pending' : probe.agentInstalled ? 'stale' : 'missing'"
        >
          {{ getAgentStatusText(probe) }}
        </div>
      </div>
    </div>

    <!-- 错误 -->
    <div v-if="probe.error" class="probe-error">{{ probe.error }}</div>

    <!-- 带宽 -->
    <div class="probe-bandwidth probe-stat">
      <div class="probe-bandwidth-item">
        <span class="probe-stat-label">↑ 上行</span>
        <span class="probe-bandwidth-value">{{ formatBandwidth(probe.bandwidthTxBps) }}</span>
      </div>
      <div class="probe-bandwidth-item">
        <span class="probe-stat-label">↓ 下行</span>
        <span class="probe-bandwidth-value">{{ formatBandwidth(probe.bandwidthRxBps) }}</span>
      </div>
    </div>

    <!-- 月度流量 -->
    <div v-if="trafficVisible" class="probe-traffic" :class="`level-${trafficLevel}`">
      <div class="probe-traffic-head">
        <span class="probe-stat-label">本月流量</span>
        <span class="probe-traffic-value">
          {{ formatBytes(probe.trafficUsedBytes) }} / {{ trafficLimitText }}
          <span v-if="probe.trafficPercent !== null && probe.trafficPercent !== undefined" class="probe-traffic-percent">
            ({{ probe.trafficPercent.toFixed(1) }}%)
          </span>
        </span>
      </div>
      <div v-if="probe.trafficLimitBytes" class="probe-traffic-bar">
        <div class="probe-traffic-bar-fill" :style="{ width: `${trafficBarWidth}%` }"></div>
      </div>
    </div>

    <!-- 核心指标 -->
    <div class="probe-stats probe-stats-core">
      <div class="probe-stat"><span class="probe-stat-label">延迟</span><span class="probe-stat-value">{{ formatLatency(probe.latencyMs) }}</span></div>
      <div class="probe-stat"><span class="probe-stat-label">CPU</span><span class="probe-stat-value">{{ formatPercent(probe.cpuUsage) }}</span></div>
      <div class="probe-stat"><span class="probe-stat-label">内存</span><span class="probe-stat-value">{{ formatPercent(probe.memoryUsage) }}</span></div>
      <div class="probe-stat"><span class="probe-stat-label">进程</span><span class="probe-stat-value">{{ probe.processCount ?? '--' }}</span></div>
    </div>

    <!-- 趋势图（默认显示，不折叠） -->
    <div v-if="trendAvailable" class="probe-trend-section">
      <div class="probe-trend-toolbar">
        <div class="probe-trend-tabs">
          <button
            v-for="tab in metricTabs"
            :key="tab"
            type="button"
            class="probe-trend-tab"
            :class="{ active: metric === tab }"
            @click="onMetricClick(tab)"
          >{{ METRIC_LABELS[tab] }}</button>
        </div>
        <div class="probe-trend-windows">
          <button
            v-for="w in timeWindows"
            :key="w"
            type="button"
            class="probe-trend-window"
            :class="{ active: timeWindow === w }"
            :title="TIME_WINDOW_LABELS[w]"
            @click="onTimeWindowClick(w)"
          >{{ w }}</button>
        </div>
      </div>
      <ProbeTrendChart :samples="samples" :metric="metric" :loading="samplesLoading" />
    </div>

    <!-- 底部时间 -->
    <div class="probe-footer-meta">
      <span>最后更新 {{ formatTime(probe.checkedAt) }}</span>
      <span v-if="probe.lastSuccessAt">最后成功 {{ formatTime(probe.lastSuccessAt) }}</span>
      <span v-else>暂无成功采样</span>
    </div>

    <!-- 操作按钮 -->
    <div class="probe-card-actions">
      <button
        v-if="probe.hostId !== 'local'"
        type="button"
        class="probe-agent-action-btn"
        @click="onDiagnoseClick"
      >
        网络诊断
      </button>
      <button
        v-if="!probe.agentInstalled && probe.hostId !== 'local'"
        type="button"
        class="probe-agent-action-btn"
        :disabled="agentActionLoading"
        @click="onInstallAgentClick"
      >
        {{ agentActionLoading ? '安装中...' : '一键安装 Agent' }}
      </button>
      <template v-else-if="probe.hostId !== 'local'">
        <button
          type="button"
          class="probe-agent-action-btn"
          :disabled="agentActionLoading"
          @click="onRestartAgentClick"
        >
          {{ agentActionLoading ? '处理中...' : '重启 Agent' }}
        </button>
        <button
          type="button"
          class="probe-agent-action-btn"
          :disabled="agentActionLoading"
          @click="onViewAgentLogsClick"
        >
          查看日志
        </button>
        <button
          type="button"
          class="probe-agent-action-btn danger"
          :disabled="agentActionLoading"
          @click="onUninstallAgentClick"
        >
          {{ agentActionLoading ? '处理中...' : '卸载 Agent' }}
        </button>
      </template>
      <button
        type="button"
        class="probe-detail-toggle"
        :class="{ expanded: detailExpanded }"
        @click="onDetailClick"
      >
        <span class="probe-detail-toggle-icon">{{ detailExpanded ? '▾' : '▸' }}</span>
        <span>{{ detailExpanded ? '收起详情' : '查看详情' }}</span>
      </button>
    </div>

    <!-- 详情展开面板 -->
    <div v-if="detailExpanded" class="probe-detail-panel">
      <!-- 详情：关键进程 -->
      <div class="probe-detail-section">
        <div class="probe-detail-title">关键进程</div>
        <div v-if="!probe.keyProcesses || probe.keyProcesses.length === 0" class="probe-detail-empty">暂无关键进程摘要</div>
        <div v-else class="probe-process-list">
          <span
            v-for="(item, i) in probe.keyProcesses"
            :key="i"
            class="probe-process-chip"
            :class="item.running ? 'running' : 'stopped'"
          >
            {{ item.name }}
            <span class="probe-process-count">{{ item.count ?? 0 }}</span>
          </span>
        </div>
      </div>

      <!-- 详情：性能 -->
      <div class="probe-detail-section">
        <div class="probe-detail-title">性能</div>
        <div class="probe-detail-grid">
          <div class="probe-stat"><span class="probe-stat-label">系统</span><span class="probe-stat-value">{{ getPlatformText(probe) }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">磁盘使用</span><span class="probe-stat-value">{{ formatPercent(probe.diskUsage) }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">Load 1m</span><span class="probe-stat-value">{{ probe.load1 ?? '--' }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">Load 5m</span><span class="probe-stat-value">{{ probe.load5 ?? '--' }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">Load 15m</span><span class="probe-stat-value">{{ probe.load15 ?? '--' }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">磁盘读</span><span class="probe-stat-value">{{ formatBandwidth(probe.diskReadBps) }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">磁盘写</span><span class="probe-stat-value">{{ formatBandwidth(probe.diskWriteBps) }}</span></div>
        </div>
      </div>

      <!-- 详情：异常与来源 -->
      <div class="probe-detail-section">
        <div class="probe-detail-title">异常与来源</div>
        <div class="probe-detail-grid">
          <div class="probe-stat"><span class="probe-stat-label">失败分类</span><span class="probe-stat-value">{{ getErrorCodeText(probe.errorCode) }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">数据来源</span><span class="probe-stat-value">{{ getDataSourceText(probe) }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">Agent 版本</span><span class="probe-stat-value">{{ probe.agentVersion || '--' }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">Agent 心跳</span><span class="probe-stat-value">{{ probe.agentLastSeenAt ? formatTime(probe.agentLastSeenAt) : '--' }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">最后更新</span><span class="probe-stat-value">{{ formatTime(probe.checkedAt) }}</span></div>
          <div class="probe-stat"><span class="probe-stat-label">最后成功</span><span class="probe-stat-value">{{ probe.lastSuccessAt ? formatTime(probe.lastSuccessAt) : '--' }}</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

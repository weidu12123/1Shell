<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import ProbeCard from '@/components/ProbeCard.vue';
import DiagModal from '@/components/DiagModal.vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useSocket } from '@/composables/useSocket';
import { captureElementScroll, getCachedPageState, isPageStateFresh, readStorageState, restoreElementScroll, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import { PROBE_CACHE_KEY, PROBE_CACHE_TTL_MS, type ProbePageCache } from '@/composables/useProbePrefetch';
import { useNotifyStore } from '@/stores/notify';
import {
  type ProbeEntry,
  type ProbeSnapshot,
  type ProbeSample,
  type MetricKey,
  type TimeWindow,
  type TimeseriesPoint,
  TIME_WINDOW_MS,
  MAX_TREND_POINTS,
  formatTime,
  normalizeBandwidthValue,
  timeseriesToSamples,
} from '@/utils/probe';

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const socket = useSocket();
const router = useRouter();

interface BridgeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface AgentInstallResponse {
  ok: boolean;
  hostId: string;
  expiresAt: string;
  serverUrl: string;
  relayUpstreamId?: string | null;
  result: BridgeExecResult;
}

interface RelayUpstream {
  id: string;
  name: string;
  relayHostId?: string;
  relayPort?: string | null;
  serverUrl: string;
  syncTokenMasked: string;
  enabled: boolean;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

interface HostSummary {
  id: string;
  type: string;
  name: string;
  host?: string;
  port?: number;
}

interface AgentActionDialog {
  title: string;
  hostId: string;
  serverUrl?: string;
  result: BridgeExecResult;
  pending?: boolean;
}

interface AgentLogsDialog {
  hostId: string;
  lines: number;
  result: BridgeExecResult;
}

interface AlertEvent {
  id: number;
  ruleId: string;
  ruleName: string;
  ruleKind: string;
  hostId: string;
  hostName?: string | null;
  level: 'info' | 'warn' | 'critical' | string;
  message: string;
  startedAt: string;
  resolvedAt?: string | null;
  ackAt?: string | null;
  snapshot?: Record<string, unknown> | null;
}

interface ProbePagePrefs {
  expandedDetailIds: string[];
  metrics: Array<[string, MetricKey]>;
  timeWindows: Array<[string, TimeWindow]>;
}

const PROBE_PREFS_KEY = '1shell.probe.page.prefs.v1';

const probes = shallowRef<ProbeEntry[]>([]);
const generatedAt = ref<string | number | null>(null);
const sampleIntervalMs = ref<number | null>(null);
const refreshing = ref(false);
const agentActionDialog = ref<AgentActionDialog | null>(null);
const agentLogsDialog = ref<AgentLogsDialog | null>(null);
const agentActionLoading = ref<string | null>(null);
const relayModalOpen = ref(false);
const relayLoading = ref(false);
const RELAY_SELECTION_STORAGE_KEY = '1shell.probe.installRelayUpstreamId';

const relayUpstreams = ref<RelayUpstream[]>([]);
const relayHosts = ref<HostSummary[]>([]);
const selectedRelayUpstreamId = ref<string>(localStorage.getItem(RELAY_SELECTION_STORAGE_KEY) || '');
const relayForm = reactive({
  id: '',
  name: 'Probe Relay',
  relayHostId: '',
  relayPort: '3301',
  syncToken: '',
  enabled: true,
});
const generatedRelayToken = ref<string>('');

// 告警中心
const alertEvents = ref<AlertEvent[]>([]);
const alertOpenCount = ref(0);
const alertDropdownOpen = ref(false);
const alertLoading = ref(false);

// 网络诊断 modal
const diagTarget = ref<{ hostId: string; hostName?: string } | null>(null);
const pageScrollRef = ref<HTMLElement | null>(null);

function onDiagnose(hostId: string): void {
  const probe = probes.value.find((p) => p.hostId === hostId);
  diagTarget.value = { hostId, hostName: probe?.name || probe?.hostname || hostId };
}
function closeDiagModal(): void { diagTarget.value = null; }

// 每主机最多 MAX_TREND_POINTS 个带宽采样点；用 reactive Map 以便模板自动追踪
const historyMap = reactive<Map<string, ProbeSample[]>>(new Map());
const samplesLoading = ref(false);
const metricMap = reactive<Map<string, MetricKey>>(new Map());
const timeWindowMap = reactive<Map<string, TimeWindow>>(new Map());

const expandedDetailIds = reactive<Set<string>>(new Set());

function saveProbePrefs(): void {
  writeStorageState<ProbePagePrefs>(PROBE_PREFS_KEY, {
    expandedDetailIds: [...expandedDetailIds],
    metrics: [...metricMap],
    timeWindows: [...timeWindowMap],
  });
}

function restoreProbePrefs(): void {
  const prefs = readStorageState<ProbePagePrefs>(PROBE_PREFS_KEY, {
    expandedDetailIds: [],
    metrics: [],
    timeWindows: [],
  });
  expandedDetailIds.clear();
  for (const id of prefs.expandedDetailIds || []) expandedDetailIds.add(id);
  metricMap.clear();
  for (const [hostId, metric] of prefs.metrics || []) metricMap.set(hostId, metric);
  timeWindowMap.clear();
  for (const [hostId, win] of prefs.timeWindows || []) timeWindowMap.set(hostId, win);
}

function saveProbeCache(): void {
  setCachedPageState<ProbePageCache>(PROBE_CACHE_KEY, {
    probes: probes.value,
    generatedAt: generatedAt.value,
    sampleIntervalMs: sampleIntervalMs.value,
    history: [...historyMap.entries()],
    alertEvents: alertEvents.value,
    alertOpenCount: alertOpenCount.value,
  });
}

function restoreProbeCache(): boolean {
  const entry = getCachedPageState<ProbePageCache>(PROBE_CACHE_KEY);
  if (!entry) return false;
  probes.value = entry.value.probes || [];
  generatedAt.value = entry.value.generatedAt ?? null;
  sampleIntervalMs.value = entry.value.sampleIntervalMs ?? null;
  historyMap.clear();
  for (const [hostId, samples] of entry.value.history || []) {
    historyMap.set(hostId, Array.isArray(samples) ? samples : []);
  }
  alertEvents.value = entry.value.alertEvents || [];
  alertOpenCount.value = Number(entry.value.alertOpenCount) || 0;
  return true;
}

// ── 统计区 ───────────────────────────────────────────────────
const total = computed(() => probes.value.length);
const onlineCount = computed(() => probes.value.filter((p) => p.online).length);
const offlineCount = computed(() => total.value - onlineCount.value);
const staleCount = computed(() => probes.value.filter((p) => p.stale).length);
const lastPushText = computed(() => formatTime(generatedAt.value));
const intervalText = computed(() => sampleIntervalMs.value
  ? `${Math.round(sampleIntervalMs.value / 1000)} 秒`
  : '--');
const activeRelayUpstream = computed(() => relayUpstreams.value.find((item) => item.id === selectedRelayUpstreamId.value && item.enabled) || null);
const selectedRelayHost = computed(() => relayHosts.value.find((host) => host.id === relayForm.relayHostId) || null);

function isAgentProbe(p: ProbeEntry): boolean {
  if (p.source !== 'agent' && p.source !== 'relay_agent') return false;
  return Boolean(p.agentInstalled || p.agentOnline || p.agentTrusted || p.cpuUsage != null || p.memoryUsage != null || p.bandwidthRxBps != null || p.bandwidthTxBps != null);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForAgentReady(hostId: string): Promise<ProbeEntry | null> {
  for (let i = 0; i < 20; i += 1) {
    await loadProbes(true);
    const probe = probes.value.find((p) => p.hostId === hostId) || null;
    if (probe?.agentOnline || probe?.agentTrusted) return probe;
    await delay(i < 6 ? 500 : 1000);
  }
  return probes.value.find((p) => p.hostId === hostId) || null;
}

// ── 历史点维护 ───────────────────────────────────────────────
// 把 socket 推送的实时 probe 转成一个 ProbeSample 行，追加到历史 buffer 末尾
// 仅当 host 当前时间窗为 1h 时追加；其他窗口显示的是聚合数据，不应被实时点污染
function appendLiveSample(list: ProbeEntry[], snapshotTime: string | number | null): void {
  const active = new Set<string>();
  for (const p of list) {
    if (!p.hostId) continue;
    active.add(p.hostId);
    if (!isAgentProbe(p)) continue;
    if (getTimeWindow(p.hostId) !== '1h') continue;

    const fallback = p.checkedAt ?? p.lastSuccessAt ?? snapshotTime ?? Date.now();
    const t = new Date(fallback as string | number);
    const reportedAt = Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();

    const sample: ProbeSample = {
      host_id: p.hostId,
      source: p.source === 'relay_agent' ? 'relay_agent' : 'agent',
      reported_at: reportedAt,
      cpu_usage: p.cpuUsage ?? null,
      memory_usage: p.memoryUsage ?? null,
      swap_usage: p.swapUsage ?? null,
      disk_usage: p.diskUsage ?? null,
      load1: p.load1 ?? null,
      load5: p.load5 ?? null,
      load15: p.load15 ?? null,
      rx_bps: normalizeBandwidthValue(p.bandwidthRxBps),
      tx_bps: normalizeBandwidthValue(p.bandwidthTxBps),
      rx_bytes: p.networkRxBytes ?? null,
      tx_bytes: p.networkTxBytes ?? null,
      process_count: p.processCount ?? null,
      uptime_sec: p.uptimeSec ?? null,
    };

    const existing = historyMap.get(p.hostId) ?? [];
    const next = existing.slice();
    const last = next[next.length - 1];
    if (last && last.reported_at === sample.reported_at) next[next.length - 1] = sample;
    else next.push(sample);

    if (next.length > MAX_TREND_POINTS) next.splice(0, next.length - MAX_TREND_POINTS);

    historyMap.set(p.hostId, next);
  }
  // 清理已不存在的主机
  for (const id of Array.from(historyMap.keys())) {
    if (!active.has(id)) historyMap.delete(id);
  }
}

// 拉持久化历史（一次性，加在内存增量前）
async function loadPersistedSamples(probesList: ProbeEntry[]): Promise<void> {
  const hostIds = probesList
    .filter((p) => isAgentProbe(p))
    .map((p) => p.hostId);
  if (hostIds.length === 0) return;
  samplesLoading.value = true;
  try {
    const resp = await requestJson<{ ok: boolean; samples: Record<string, ProbeSample[]> }>('/api/probe-agents/samples-bulk', {
      method: 'POST',
      body: JSON.stringify({ hostIds, minutes: 60 }),
    });
    if (!resp.samples) return;
    for (const [hostId, list] of Object.entries(resp.samples)) {
      if (!Array.isArray(list)) continue;
      // 与已有内存增量合并：去重 by reported_at
      const existing = historyMap.get(hostId) ?? [];
      const seen = new Set(existing.map((s) => s.reported_at));
      const merged = [...list.filter((s) => !seen.has(s.reported_at)), ...existing];
      merged.sort((a, b) => new Date(a.reported_at).getTime() - new Date(b.reported_at).getTime());
      if (merged.length > MAX_TREND_POINTS) merged.splice(0, merged.length - MAX_TREND_POINTS);
      historyMap.set(hostId, merged);
    }
    saveProbeCache();
  } catch {
    /* ignore — 没有持久化历史不影响 UI */
  } finally {
    samplesLoading.value = false;
  }
}

function applySnapshot(snap: ProbeSnapshot): void {
  const list = Array.isArray(snap.probes) ? snap.probes : [];
  generatedAt.value = snap.generatedAt ?? null;
  sampleIntervalMs.value = typeof snap.sampleIntervalMs === 'number' ? snap.sampleIntervalMs : null;
  appendLiveSample(list, generatedAt.value);
  probes.value = list;
  saveProbeCache();
}

async function loadRelayHosts(): Promise<void> {
  try {
    const response = await requestJson<{ hosts: HostSummary[] }>('/api/hosts');
    relayHosts.value = Array.isArray(response.hosts)
      ? response.hosts.filter((host) => host.type !== 'local')
      : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.warn(`加载 VPS 列表失败：${msg}`, 4000);
  }
}

async function loadRelayUpstreams(): Promise<void> {
  try {
    const response = await requestJson<{ ok: boolean; upstreams: RelayUpstream[] }>('/api/probe-relay/upstreams');
    relayUpstreams.value = Array.isArray(response.upstreams) ? response.upstreams : [];
    if (selectedRelayUpstreamId.value && !relayUpstreams.value.some((item) => item.id === selectedRelayUpstreamId.value && item.enabled)) {
      selectRelayForInstall('');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.warn(`加载 Relay 配置失败：${msg}`, 4000);
  }
}

async function loadProbes(forceRefresh = false): Promise<void> {
  refreshing.value = true;
  try {
    const url = forceRefresh ? '/api/probes?refresh=1' : '/api/probes';
    const snap = await requestJson<ProbeSnapshot>(url);
    applySnapshot(snap);
    // 加载持久化历史（一次性），与内存增量合并
    await loadPersistedSamples(snap.probes || []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`加载探针失败：${msg}`, 5000);
  } finally {
    refreshing.value = false;
  }
}

// ── 卡片交互 ─────────────────────────────────────────────────
function onToggleDetail(hostId: string): void {
  if (expandedDetailIds.has(hostId)) expandedDetailIds.delete(hostId);
  else expandedDetailIds.add(hostId);
  saveProbePrefs();
}
function onSetMetric(hostId: string, metric: MetricKey): void {
  metricMap.set(hostId, metric);
  saveProbePrefs();
}
function getMetric(hostId: string): MetricKey {
  return metricMap.get(hostId) ?? 'bandwidth';
}
function getTimeWindow(hostId: string): TimeWindow {
  return timeWindowMap.get(hostId) ?? '1h';
}
async function onSetTimeWindow(hostId: string, w: TimeWindow): Promise<void> {
  timeWindowMap.set(hostId, w);
  saveProbePrefs();
  // 1h 用持久化 samples + socket 实时增量；其他窗口直接拉 timeseries 聚合表
  if (w === '1h') {
    await loadPersistedSamples(probes.value.filter((p) => p.hostId === hostId));
  } else {
    await loadTimeseries(hostId, w);
  }
}

async function loadTimeseries(hostId: string, w: TimeWindow): Promise<void> {
  const to = Date.now();
  const from = to - TIME_WINDOW_MS[w];
  samplesLoading.value = true;
  try {
    const resp = await requestJson<{ ok: boolean; points: TimeseriesPoint[]; resolution: string }>(
      `/api/probe-agents/${encodeURIComponent(hostId)}/timeseries?from=${from}&to=${to}&resolution=auto`,
    );
    if (Array.isArray(resp.points)) {
      historyMap.set(hostId, timeseriesToSamples(hostId, resp.points));
      saveProbeCache();
    }
  } catch {
    /* ignore */
  } finally {
    samplesLoading.value = false;
  }
}

async function onInstallAgent(hostId: string): Promise<void> {
  agentActionLoading.value = hostId;
  agentActionDialog.value = {
    title: 'Agent 安装中',
    hostId,
    result: {
      stdout: '正在下载、注册并启动 1Shell Probe Agent...',
      stderr: '',
      exitCode: -1,
      durationMs: 0,
    },
    pending: true,
  };
  try {
    const relay = activeRelayUpstream.value;
    const response = await requestJson<AgentInstallResponse>(`/api/probe-agents/${encodeURIComponent(hostId)}/install`, {
      method: 'POST',
      body: JSON.stringify(relay ? { relayUpstreamId: relay.id } : {}),
    });
    const success = response.result.exitCode === 0;
    agentActionDialog.value = {
      title: success ? '等待 Agent 上报' : 'Agent 安装失败',
      hostId: response.hostId,
      serverUrl: response.serverUrl,
      result: response.result,
      pending: success,
    };
    if (success) {
      notify.info('安装命令已执行，正在等待 Agent 首次上报', 3000);
      waitForAgentReady(response.hostId)
        .then((probe) => {
          if (probe?.agentOnline || probe?.agentTrusted) {
            agentActionDialog.value = {
              title: 'Agent 已上线',
              hostId: response.hostId,
              serverUrl: response.serverUrl,
              result: response.result,
            };
            notify.success('Agent 已上线', 2500);
            return;
          }
          agentActionDialog.value = {
            title: '未收到 Agent 上报',
            hostId: response.hostId,
            serverUrl: response.serverUrl,
            result: {
              ...response.result,
              stderr: `${response.result.stderr || ''}${response.result.stderr ? '\n' : ''}安装命令已结束，但后端暂未收到该主机 Agent 上报。`,
            },
          };
          notify.warn('安装命令已结束，但暂未收到 Agent 上报', 5000);
        })
        .catch(() => {});
    } else {
      notify.error('Agent 安装命令执行失败，请查看输出', 5000);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentActionDialog.value = {
      title: 'Agent 安装失败',
      hostId,
      result: { stdout: '', stderr: msg, exitCode: -1, durationMs: 0 },
    };
    notify.error(`安装 Agent 失败：${msg}`, 5000);
  } finally {
    agentActionLoading.value = null;
  }
}

async function onUninstallAgent(hostId: string): Promise<void> {
  if (!window.confirm('确认卸载该主机上的 1Shell Agent？')) return;
  agentActionLoading.value = hostId;
  agentActionDialog.value = {
    title: 'Agent 卸载中',
    hostId,
    result: {
      stdout: '正在停止服务、删除文件并验证卸载结果...',
      stderr: '',
      exitCode: -1,
      durationMs: 0,
    },
    pending: true,
  };
  try {
    const response = await requestJson<{ ok: boolean; result: BridgeExecResult }>(`/api/probe-agents/${encodeURIComponent(hostId)}/uninstall`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const success = response.result.exitCode === 0;
    agentActionDialog.value = {
      title: success ? 'Agent 已卸载并验证' : 'Agent 卸载失败',
      hostId,
      result: response.result,
    };
    if (success) {
      notify.success('Agent 已卸载并验证', 3000);
      await loadProbes(true);
    } else {
      notify.error('Agent 卸载或验证失败，请查看输出', 5000);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentActionDialog.value = {
      title: 'Agent 卸载失败',
      hostId,
      result: { stdout: '', stderr: msg, exitCode: -1, durationMs: 0 },
    };
    notify.error(`卸载 Agent 失败：${msg}`, 5000);
  } finally {
    agentActionLoading.value = null;
  }
}

function closeAgentActionDialog(): void {
  agentActionDialog.value = null;
}

async function onRestartAgent(hostId: string): Promise<void> {
  agentActionLoading.value = hostId;
  agentActionDialog.value = {
    title: 'Agent 更新重启中',
    hostId,
    result: {
      stdout: '正在检查新版二进制、重启服务并验证运行状态...',
      stderr: '',
      exitCode: -1,
      durationMs: 0,
    },
    pending: true,
  };
  try {
    const response = await requestJson<{ ok: boolean; result: BridgeExecResult }>(`/api/probe-agents/${encodeURIComponent(hostId)}/restart`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const success = response.result.exitCode === 0;
    agentActionDialog.value = {
      title: success ? '等待 Agent 上报' : 'Agent 重启失败',
      hostId,
      result: response.result,
      pending: success,
    };
    if (success) {
      notify.info('Agent 服务已重启，正在等待最新上报', 3000);
      const probe = await waitForAgentReady(hostId);
      if (probe?.agentOnline || probe?.agentTrusted) {
        agentActionDialog.value = {
          title: 'Agent 已重启并上线',
          hostId,
          result: response.result,
        };
        notify.success('Agent 已重启并上线', 2500);
      } else {
        agentActionDialog.value = {
          title: '未收到 Agent 上报',
          hostId,
          result: {
            ...response.result,
            stderr: `${response.result.stderr || ''}${response.result.stderr ? '\n' : ''}Agent 服务已通过运行状态验证，但后端暂未收到最新上报。`,
          },
        };
        notify.warn('Agent 已重启，但暂未收到最新上报', 5000);
      }
    } else {
      notify.error('Agent 重启或验证失败，请查看输出', 5000);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentActionDialog.value = {
      title: 'Agent 重启失败',
      hostId,
      result: { stdout: '', stderr: msg, exitCode: -1, durationMs: 0 },
    };
    notify.error(`重启 Agent 失败：${msg}`, 5000);
  } finally {
    agentActionLoading.value = null;
  }
}

async function onViewAgentLogs(hostId: string): Promise<void> {
  agentActionLoading.value = hostId;
  try {
    const response = await requestJson<{ ok: boolean; result: BridgeExecResult; lines: number }>(`/api/probe-agents/${encodeURIComponent(hostId)}/logs?lines=200`);
    agentLogsDialog.value = {
      hostId,
      lines: response.lines,
      result: response.result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`查看 Agent 日志失败：${msg}`, 5000);
  } finally {
    agentActionLoading.value = null;
  }
}

function closeAgentLogsDialog(): void {
  agentLogsDialog.value = null;
}

async function openRelayModal(): Promise<void> {
  relayModalOpen.value = true;
  generatedRelayToken.value = '';
  await Promise.all([loadRelayHosts(), loadRelayUpstreams()]);
}

function closeRelayModal(): void {
  relayModalOpen.value = false;
}

function editRelay(upstream: RelayUpstream): void {
  relayForm.id = upstream.id;
  relayForm.name = upstream.name;
  relayForm.relayHostId = upstream.relayHostId || '';
  relayForm.relayPort = upstream.relayPort || '3301';
  relayForm.syncToken = '';
  relayForm.enabled = upstream.enabled;
}

function resetRelayForm(): void {
  relayForm.id = '';
  relayForm.name = 'Probe Relay';
  relayForm.relayHostId = '';
  relayForm.relayPort = '3301';
  relayForm.syncToken = '';
  relayForm.enabled = true;
}

function selectRelayForInstall(id: string): void {
  selectedRelayUpstreamId.value = id;
  if (id) localStorage.setItem(RELAY_SELECTION_STORAGE_KEY, id);
  else localStorage.removeItem(RELAY_SELECTION_STORAGE_KEY);
}

async function syncRelayUpstream(id: string): Promise<void> {
  relayLoading.value = true;
  try {
    const response = await requestJson<{ ok: boolean; count: number }>(`/api/probe-relay/upstreams/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    notify.success(`Relay 同步成功：${response.count || 0} 台 Agent`, 3000);
    await loadRelayUpstreams();
    await loadProbes(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`Relay 同步失败：${msg}`, 5000);
    await loadRelayUpstreams();
  } finally {
    relayLoading.value = false;
  }
}

async function deleteRelayUpstream(id: string): Promise<void> {
  if (!window.confirm('确认删除这个 Relay 上游配置？')) return;
  relayLoading.value = true;
  try {
    await requestJson(`/api/probe-relay/upstreams/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (selectedRelayUpstreamId.value === id) selectRelayForInstall('');
    notify.success('Relay 配置已删除', 2500);
    await loadRelayUpstreams();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`删除 Relay 配置失败：${msg}`, 5000);
  } finally {
    relayLoading.value = false;
  }
}

async function installRelayAgent(): Promise<void> {
  if (!relayForm.relayHostId) {
    notify.warn('请先选择一台 VPS 作为 Relay', 3000);
    return;
  }
  relayLoading.value = true;
  try {
    const response = await requestJson<{ ok: boolean; upstream: RelayUpstream | null; result: BridgeExecResult }>('/api/probe-relay/upstreams/install', {
      method: 'POST',
      body: JSON.stringify({
        id: relayForm.id || undefined,
        name: relayForm.name || selectedRelayHost.value?.name || 'Probe Relay',
        relayHostId: relayForm.relayHostId,
        relayPort: Number(relayForm.relayPort) || 3301,
        enabled: relayForm.enabled,
      }),
    });
    if (response.result?.exitCode !== 0 || !response.upstream) {
      notify.error(`Relay Agent 安装失败：${response.result?.stderr || response.result?.stdout || '远端命令失败'}`, 6000);
      return;
    }
    notify.success('Relay Agent 已安装并保存为上游', 3000);
    selectRelayForInstall(response.upstream.id);
    resetRelayForm();
    await loadRelayUpstreams();
    await syncRelayUpstream(response.upstream.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`安装 Relay Agent 失败：${msg}`, 6000);
  } finally {
    relayLoading.value = false;
  }
}

async function saveRelayUpstream(): Promise<void> {
  relayLoading.value = true;
  try {
    const payload: Record<string, unknown> = {
      name: relayForm.name || selectedRelayHost.value?.name || 'Probe Relay',
      relayHostId: relayForm.relayHostId,
      relayPort: Number(relayForm.relayPort) || 3301,
      syncToken: relayForm.syncToken,
      enabled: relayForm.enabled,
    };
    if (relayForm.id) payload.id = relayForm.id;
    const response = await requestJson<{ ok: boolean; upstream: RelayUpstream }>('/api/probe-relay/upstreams', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    notify.success('Relay 配置已保存', 2500);
    resetRelayForm();
    await loadRelayUpstreams();
    if (response.upstream.enabled) await loadProbes(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`保存 Relay 配置失败：${msg}`, 5000);
  } finally {
    relayLoading.value = false;
  }
}

async function generateRelayToken(): Promise<void> {
  relayLoading.value = true;
  try {
    const response = await requestJson<{ ok: boolean; token: string }>('/api/probe-relay/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'Probe Relay Sync' }),
    });
    generatedRelayToken.value = response.token;
    notify.success('Relay token 已生成，请保存后配置到本机 1Shell', 5000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`生成 Relay token 失败：${msg}`, 5000);
  } finally {
    relayLoading.value = false;
  }
}

// ── Socket 实时 ──────────────────────────────────────────────
const onProbeUpdate = (snap: ProbeSnapshot) => applySnapshot(snap);
const onProbeAlerts = (_payload: unknown) => { loadAlerts(); };

async function loadAlerts(): Promise<void> {
  alertLoading.value = true;
  try {
    const response = await requestJson<{ ok: boolean; events: AlertEvent[]; openCount: number }>('/api/probe-alerts/events?status=open&limit=50');
    alertEvents.value = Array.isArray(response.events) ? response.events : [];
    alertOpenCount.value = Number(response.openCount) || 0;
    saveProbeCache();
  } catch {
    /* ignore，告警拉取失败不阻塞探针页 */
  } finally {
    alertLoading.value = false;
  }
}

async function ackAlert(id: number): Promise<void> {
  try {
    await requestJson(`/api/probe-alerts/events/${id}/ack`, { method: 'POST', body: JSON.stringify({}) });
    alertEvents.value = alertEvents.value.filter((e) => e.id !== id);
    alertOpenCount.value = Math.max(0, alertOpenCount.value - 1);
    saveProbeCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`忽略告警失败：${msg}`, 4000);
  }
}

async function ackAllAlerts(): Promise<void> {
  if (alertOpenCount.value <= 0) return;
  try {
    const response = await requestJson<{ ok: boolean; count: number }>('/api/probe-alerts/events/ack-all', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    alertEvents.value = [];
    alertOpenCount.value = 0;
    saveProbeCache();
    notify.success(`已忽略 ${response.count || 0} 条告警`, 2500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`一键忽略告警失败：${msg}`, 4000);
  }
}

function toggleAlertDropdown(): void {
  alertDropdownOpen.value = !alertDropdownOpen.value;
  if (alertDropdownOpen.value) loadAlerts();
}

function alertLevelClass(level: string): string {
  if (level === 'critical') return 'text-red-600 dark:text-red-400 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10';
  if (level === 'warn') return 'text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10';
  return 'text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-500/40 bg-slate-50 dark:bg-slate-700/40';
}

// ── 告警 → 一键介入 (C3 操控闭环 v1) ─────────────────────────
function diagnoseFromAlert(ev: AlertEvent): void {
  alertDropdownOpen.value = false;
  onDiagnose(ev.hostId);
}
function openConsoleFromAlert(ev: AlertEvent): void {
  alertDropdownOpen.value = false;
  router.push({ path: '/console', query: { host: ev.hostId } });
}
function viewAgentLogsFromAlert(ev: AlertEvent): void {
  alertDropdownOpen.value = false;
  onViewAgentLogs(ev.hostId);
}

let activatedAfterMount = false;

function refreshProbePageIfNeeded(restored: boolean): void {
  if (!restored) {
    void loadProbes(true);
    void loadAlerts();
    return;
  }
  if (!isPageStateFresh(PROBE_CACHE_KEY, PROBE_CACHE_TTL_MS)) {
    void loadProbes(false);
    void loadAlerts();
  }
}

onMounted(() => {
  socket.on('probe:update', onProbeUpdate);
  socket.on('probe:alerts', onProbeAlerts);
  restoreProbePrefs();
  const restored = restoreProbeCache();
  restoreElementScroll(PROBE_CACHE_KEY, pageScrollRef.value);
  loadRelayHosts();
  loadRelayUpstreams();
  refreshProbePageIfNeeded(restored);
});

onActivated(() => {
  restoreElementScroll(PROBE_CACHE_KEY, pageScrollRef.value);
  if (!activatedAfterMount) {
    activatedAfterMount = true;
    return;
  }
  refreshProbePageIfNeeded(true);
});

onDeactivated(() => {
  captureElementScroll(PROBE_CACHE_KEY, pageScrollRef.value);
  saveProbePrefs();
  saveProbeCache();
});

onBeforeUnmount(() => {
  captureElementScroll(PROBE_CACHE_KEY, pageScrollRef.value);
  socket.off('probe:update', onProbeUpdate);
  socket.off('probe:alerts', onProbeAlerts);
});
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <!-- 顶栏 -->
    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300 flex items-center justify-center">
          <AppIcon name="radio" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200">探针中心</div>
          <div class="text-[11px] text-slate-400">查看全部主机在线状态与资源指标</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <div v-if="activeRelayUpstream" class="hidden sm:block mr-2 text-[11px] text-emerald-600 dark:text-emerald-400">
        安装 Relay: {{ activeRelayUpstream.name }}
      </div>
      <div class="relative mr-2">
        <button
          type="button"
          class="h-8 px-3 rounded-lg border text-xs font-semibold transition-all flex items-center gap-1.5"
          :class="alertOpenCount > 0
            ? 'border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20'
            : 'border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:border-slate-300'"
          @click="toggleAlertDropdown"
        >
          <AppIcon name="alert" :size="14" />
          <span>告警</span>
          <span
            v-if="alertOpenCount > 0"
            class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none"
          >{{ alertOpenCount }}</span>
        </button>
        <div
          v-if="alertDropdownOpen"
          class="absolute right-0 top-10 z-40 w-[360px] max-h-[420px] overflow-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl"
        >
          <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
            <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">告警事件 · {{ alertOpenCount }} 条未处理</div>
            <div class="flex items-center gap-2">
              <button
                v-if="alertOpenCount > 0"
                type="button"
                class="text-xs font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50"
                :disabled="alertLoading"
                @click="ackAllAlerts"
              >一键忽略</button>
              <button type="button" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-xs" @click="alertDropdownOpen = false">收起</button>
            </div>
          </div>
          <div v-if="alertLoading && alertEvents.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">加载中...</div>
          <div v-else-if="alertEvents.length === 0" class="px-4 py-8 text-center text-xs text-slate-400 inline-flex items-center justify-center gap-1.5 w-full">
            <AppIcon name="check" :size="12" class="text-emerald-500" />
            <span>暂无未处理告警</span>
          </div>
          <div v-else class="divide-y divide-slate-100 dark:divide-slate-800">
            <div
              v-for="ev in alertEvents"
              :key="ev.id"
              class="px-4 py-3 flex flex-col gap-1.5"
            >
              <div class="flex items-center gap-2">
                <span
                  class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border"
                  :class="alertLevelClass(ev.level)"
                >{{ ev.level === 'critical' ? '严重' : ev.level === 'warn' ? '警告' : '通知' }}</span>
                <span class="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate flex-1">{{ ev.ruleName }}</span>
                <span class="text-[10px] text-slate-400">{{ formatTime(ev.startedAt) }}</span>
              </div>
              <div class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{{ ev.message }}</div>
              <div class="flex items-center justify-between gap-2 pt-1">
                <span class="text-[10px] text-slate-400 truncate">{{ ev.resolvedAt ? '已自愈，可忽略' : '持续中' }}</span>
                <div class="flex items-center gap-1 flex-wrap justify-end">
                  <button
                    type="button"
                    class="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-blue-600 dark:text-blue-400 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10"
                    title="在该主机执行 ping / HTTP / DNS"
                    @click="diagnoseFromAlert(ev)"
                  >诊断</button>
                  <button
                    type="button"
                    class="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-emerald-600 dark:text-emerald-400 hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                    title="打开 1Shell 终端并自动连接该主机"
                    @click="openConsoleFromAlert(ev)"
                  >终端</button>
                  <button
                    v-if="ev.ruleKind === 'offline'"
                    type="button"
                    class="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-amber-600 dark:text-amber-400 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10"
                    title="查看 Agent systemd 日志"
                    @click="viewAgentLogsFromAlert(ev)"
                  >日志</button>
                  <button
                    type="button"
                    class="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 hover:border-slate-400"
                    title="标记为已处理"
                    @click="ackAlert(ev.id)"
                  >忽略</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        class="h-8 px-3 mr-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-emerald-300 hover:text-emerald-500 transition-all"
        @click="openRelayModal"
      >
        中继设置
      </button>
      <button
        type="button"
        :disabled="refreshing"
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        @click="loadProbes(true)"
      >
        {{ refreshing ? '刷新中...' : '立即刷新' }}
      </button>
    </header>

    <!-- 主面板 -->
    <main class="flex-1 min-h-0 overflow-hidden">
      <div ref="pageScrollRef" class="h-full flex flex-col min-h-0 overflow-y-auto">
        <!-- 统计区（6 项） -->
        <div class="probe-summary p-4">
          <div class="probe-summary-item">
            <span class="probe-stat-label">总主机数</span>
            <span class="probe-stat-value">{{ total }}</span>
          </div>
          <div class="probe-summary-item">
            <span class="probe-stat-label">在线</span>
            <span class="probe-stat-value">{{ onlineCount }}</span>
          </div>
          <div class="probe-summary-item">
            <span class="probe-stat-label">离线</span>
            <span class="probe-stat-value">{{ offlineCount }}</span>
          </div>
          <div class="probe-summary-item">
            <span class="probe-stat-label">旧数据主机</span>
            <span class="probe-stat-value">{{ staleCount }}</span>
          </div>
          <div class="probe-summary-item">
            <span class="probe-stat-label">最近推送</span>
            <span class="probe-stat-value">{{ lastPushText }}</span>
          </div>
          <div class="probe-summary-item">
            <span class="probe-stat-label">采样间隔</span>
            <span class="probe-stat-value">{{ intervalText }}</span>
          </div>
        </div>

        <!-- 卡片网格 -->
        <div class="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <div v-if="probes.length === 0" class="col-span-full probe-empty">暂无探针数据</div>
          <ProbeCard
            v-for="probe in probes"
            v-else
            :key="probe.hostId"
            :probe="probe"
            :samples="historyMap.get(probe.hostId) ?? []"
            :samples-loading="samplesLoading"
            :detail-expanded="expandedDetailIds.has(probe.hostId)"
            :metric="getMetric(probe.hostId)"
            :time-window="getTimeWindow(probe.hostId)"
            :agent-action-loading="agentActionLoading === probe.hostId"
            @toggle-detail="onToggleDetail"
            @set-metric="onSetMetric"
            @set-time-window="onSetTimeWindow"
            @install-agent="onInstallAgent"
            @uninstall-agent="onUninstallAgent"
            @restart-agent="onRestartAgent"
            @view-agent-logs="onViewAgentLogs"
            @diagnose="onDiagnose"
          />
        </div>
      </div>
    </main>

    <div v-if="relayModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div class="w-full max-w-3xl rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        <div class="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div class="text-sm font-bold text-slate-800 dark:text-slate-100">探针 Relay 中继</div>
            <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">无公网主控使用；把轻量 Relay Agent 注入一台公网 VPS 作为探针上报入口。</div>
          </div>
          <button type="button" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" @click="closeRelayModal">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="space-y-3">
              <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">本机拉取的 Relay 上游</div>
              <div v-if="relayUpstreams.length === 0" class="probe-detail-empty">未配置 Relay，上报将默认直连当前 1Shell Server。</div>
              <div
                v-for="upstream in relayUpstreams"
                :key="upstream.id"
                class="probe-stat text-xs"
                :class="selectedRelayUpstreamId === upstream.id ? 'ring-1 ring-emerald-400/70' : ''"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="probe-stat-value">{{ upstream.name }}</span>
                  <span v-if="selectedRelayUpstreamId === upstream.id" class="text-[10px] text-emerald-600 dark:text-emerald-400">已选为上报入口</span>
                </div>
                <div class="mt-1 break-all text-slate-500 dark:text-slate-400">{{ upstream.serverUrl }}</div>
                <div class="mt-1 text-slate-400">VPS {{ upstream.relayHostId || '自定义' }} · Token {{ upstream.syncTokenMasked }} · {{ upstream.enabled ? '启用' : '停用' }}</div>
                <div v-if="upstream.lastError" class="mt-1 text-red-500">{{ upstream.lastError }}</div>
                <div v-else-if="upstream.lastSyncAt" class="mt-1 text-slate-400">最近同步 {{ formatTime(upstream.lastSyncAt) }}</div>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="text-[11px] px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-700 text-emerald-600 dark:text-emerald-300 disabled:opacity-50"
                    :disabled="!upstream.enabled"
                    @click="selectRelayForInstall(selectedRelayUpstreamId === upstream.id ? '' : upstream.id)"
                  >{{ selectedRelayUpstreamId === upstream.id ? '取消入口' : '设为入口' }}</button>
                  <button type="button" class="text-[11px] px-2 py-0.5 rounded border border-blue-200 dark:border-blue-700 text-blue-600 dark:text-blue-300 disabled:opacity-50" :disabled="relayLoading || !upstream.enabled" @click="syncRelayUpstream(upstream.id)">同步测试</button>
                  <button type="button" class="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300" @click="editRelay(upstream)">编辑</button>
                  <button type="button" class="text-[11px] px-2 py-0.5 rounded border border-red-200 dark:border-red-700 text-red-600 dark:text-red-300 disabled:opacity-50" :disabled="relayLoading" @click="deleteRelayUpstream(upstream.id)">删除</button>
                </div>
              </div>
            </div>
            <div class="space-y-3">
              <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">添加 / 更新 Relay 上游</div>
              <input v-model="relayForm.name" class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" placeholder="名称，例如 香港 Relay" />
              <select v-model="relayForm.relayHostId" class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200">
                <option value="">选择一台已添加的 VPS</option>
                <option v-for="host in relayHosts" :key="host.id" :value="host.id">{{ host.name }} · {{ host.host }}:{{ host.port || 22 }}</option>
              </select>
              <div class="grid grid-cols-3 gap-2">
                <input v-model="relayForm.relayPort" class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" placeholder="3301" />
                <div class="col-span-2 h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 flex items-center truncate">
                  {{ selectedRelayHost ? `http://${selectedRelayHost.host}:${relayForm.relayPort || 3301}` : '选择 VPS 后自动生成 Relay 地址' }}
                </div>
              </div>
              <input v-model="relayForm.syncToken" class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" :placeholder="relayForm.id ? '手动模式 token（留空保留原 token）' : '手动模式 token；一键安装 Relay Agent 可留空'" />
              <label class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <input v-model="relayForm.enabled" type="checkbox" />
                启用该 Relay；安装/升级会自动生成 token，点左侧“设为入口”后目标 Agent 才会上报到它
              </label>
              <div class="flex flex-wrap justify-end gap-2">
                <button type="button" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300" @click="resetRelayForm">清空</button>
                <button type="button" class="h-8 px-3 rounded-lg border border-emerald-200 dark:border-emerald-700 text-xs font-semibold text-emerald-600 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 disabled:opacity-60" :disabled="relayLoading || !relayForm.relayHostId" @click="installRelayAgent">安装/升级 Relay Agent</button>
                <button type="button" class="h-8 px-3 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500 disabled:opacity-60" :disabled="relayLoading" @click="saveRelayUpstream">手动保存上游</button>
              </div>
            </div>
          </div>
          <div class="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 p-4 space-y-3">
            <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">兼容模式：把完整 1Shell 当作 Relay</div>
            <div class="text-xs text-slate-500 dark:text-slate-400">正常不需要用这里；只有当公网 VPS 已经运行完整 1Shell 时，才生成 token 并手动保存为上游。</div>
            <div class="flex justify-end">
              <button type="button" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-300" :disabled="relayLoading" @click="generateRelayToken">生成兼容模式 token</button>
            </div>
            <pre v-if="generatedRelayToken" class="max-h-28 overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 text-slate-100 p-3 text-xs leading-relaxed">{{ generatedRelayToken }}</pre>
          </div>
        </div>
      </div>
    </div>

    <div v-if="agentActionDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div class="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        <div class="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div class="text-sm font-bold text-slate-800 dark:text-slate-100">{{ agentActionDialog.title }}</div>
            <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">通过 1Shell SSH 操控在目标主机执行命令。</div>
          </div>
          <button type="button" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" @click="closeAgentActionDialog">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div class="probe-stat"><span class="probe-stat-label">Host ID</span><span class="probe-stat-value break-all">{{ agentActionDialog.hostId }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">Exit Code</span><span class="probe-stat-value">{{ agentActionDialog.pending ? '执行中' : agentActionDialog.result.exitCode }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">耗时</span><span class="probe-stat-value">{{ agentActionDialog.pending ? '--' : `${agentActionDialog.result.durationMs} ms` }}</span></div>
          </div>
          <div v-if="agentActionDialog.serverUrl" class="probe-stat text-xs">
            <span class="probe-stat-label">Server</span>
            <span class="probe-stat-value break-all">{{ agentActionDialog.serverUrl }}</span>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">stdout</div>
              <pre class="max-h-72 overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 text-slate-100 p-4 text-xs leading-relaxed">{{ agentActionDialog.result.stdout || '无输出' }}</pre>
            </div>
            <div>
              <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">stderr</div>
              <pre class="max-h-72 overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 text-slate-100 p-4 text-xs leading-relaxed">{{ agentActionDialog.result.stderr || '无输出' }}</pre>
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300" @click="closeAgentActionDialog">关闭</button>
          </div>
        </div>
      </div>
    </div>

    <DiagModal
      v-if="diagTarget"
      :host-id="diagTarget.hostId"
      :host-name="diagTarget.hostName"
      @close="closeDiagModal"
    />

    <div v-if="agentLogsDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div class="w-full max-w-3xl rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        <div class="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div class="text-sm font-bold text-slate-800 dark:text-slate-100">Agent 日志</div>
            <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">journalctl -u 1shell-probe-agent.service · 最近 {{ agentLogsDialog.lines }} 行</div>
          </div>
          <button type="button" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" @click="closeAgentLogsDialog">✕</button>
        </div>
        <div class="p-5 space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div class="probe-stat"><span class="probe-stat-label">Host ID</span><span class="probe-stat-value break-all">{{ agentLogsDialog.hostId }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">Exit Code</span><span class="probe-stat-value">{{ agentLogsDialog.result.exitCode }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">耗时</span><span class="probe-stat-value">{{ agentLogsDialog.result.durationMs }} ms</span></div>
          </div>
          <pre class="max-h-[28rem] overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 text-slate-100 p-4 text-xs leading-relaxed">{{ agentLogsDialog.result.stdout || agentLogsDialog.result.stderr || '无日志输出' }}</pre>
          <div class="flex justify-end gap-2">
            <button type="button" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300" @click="closeAgentLogsDialog">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

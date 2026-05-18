// Probe 共享类型与纯函数（无 Vue 依赖）
// 与老 public/probe.js 的逻辑 1:1 对应。

export interface KeyProcess {
  name: string;
  count?: number;
  running?: boolean;
}

export interface ProbeEntry {
  hostId: string;
  name?: string;
  hostname?: string;
  platform?: string | null;
  platformInfo?: {
    os?: string;
    arch?: string;
    kernel?: string;
    distroId?: string;
    versionId?: string;
    prettyName?: string;
  } | null;
  online: boolean;
  stale?: boolean;
  error?: string;
  errorCode?: string;
  checkedAt?: string | number;
  lastSuccessAt?: string | number;

  latencyMs?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  processCount?: number;

  bandwidthRxBps?: number;
  bandwidthTxBps?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  uptimeSec?: number;

  diskUsage?: number;
  load1?: number; load5?: number; load15?: number;
  diskReadBps?: number; diskWriteBps?: number;

  keyProcesses?: KeyProcess[];

  source?: 'ssh' | 'agent' | string;
  sshOnline?: boolean;
  agentInstalled?: boolean;
  agentOnline?: boolean;
  agentTrusted?: boolean;
  agentConsecutiveOk?: number;
  agentFirstHealthyAt?: string | number | null;
  agentStatus?: 'online' | 'pending' | 'stale' | 'revoked' | 'missing' | string;
  agentVersion?: string | null;
  agentLastSeenAt?: string | number | null;
  swapUsage?: number;
  cpuCores?: number[];
  diskPartitions?: unknown[];
  networkInterfaces?: unknown[];
  relaySource?: boolean;
  relayId?: string;
  relayName?: string;
  sshSkipped?: boolean;
  sshSkipReason?: string;

  // 月度流量（B2）
  trafficUsedBytes?: number;
  trafficLimitBytes?: number | null;
  trafficPercent?: number | null;
  trafficResetDay?: number;
  trafficAlertPercent?: number;
  trafficLastResetAt?: string | number | null;
  trafficLastSampleAt?: string | number | null;
}

export interface ProbeSnapshot {
  probes: ProbeEntry[];
  generatedAt?: string | number;
  sampleIntervalMs?: number;
}

export interface BandwidthPoint {
  time: number;
  rx: number;
  tx: number;
  source?: string;
}

// 后端 /api/probe-agents/:hostId/samples 返回的行
export interface ProbeSample {
  host_id: string;
  source: string;
  reported_at: string;
  cpu_usage: number | null;
  memory_usage: number | null;
  swap_usage: number | null;
  disk_usage: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  rx_bytes: number | null;
  tx_bytes: number | null;
  process_count: number | null;
  uptime_sec: number | null;
}

// B1 时序聚合表的一行（来自 /api/probe-agents/:hostId/timeseries）
export interface TimeseriesPoint {
  bucket_at: string;
  cpu_avg: number | null;
  cpu_max: number | null;
  memory_avg: number | null;
  memory_max: number | null;
  swap_avg: number | null;
  disk_avg: number | null;
  disk_max: number | null;
  load1_avg: number | null;
  load1_max: number | null;
  rx_bps_avg: number | null;
  rx_bps_max: number | null;
  tx_bps_avg: number | null;
  tx_bps_max: number | null;
  sample_count: number;
}

export type Resolution = '1m' | '1h' | '1d';
export type TimeWindow = '1h' | '6h' | '24h' | '7d' | '30d';

export const TIME_WINDOW_MS: Readonly<Record<TimeWindow, number>> = Object.freeze({
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

export const TIME_WINDOW_LABELS: Readonly<Record<TimeWindow, string>> = Object.freeze({
  '1h': '1 小时',
  '6h': '6 小时',
  '24h': '24 小时',
  '7d': '7 天',
  '30d': '30 天',
});

// 把 TimeseriesPoint 转成 ProbeSample（用 _avg 字段，让 ProbeTrendChart 复用）
export function timeseriesToSamples(hostId: string, points: TimeseriesPoint[]): ProbeSample[] {
  return points.map((p) => ({
    host_id: hostId,
    source: 'agent',
    reported_at: p.bucket_at,
    cpu_usage: p.cpu_avg,
    memory_usage: p.memory_avg,
    swap_usage: p.swap_avg,
    disk_usage: p.disk_avg,
    load1: p.load1_avg,
    load5: null,
    load15: null,
    rx_bps: p.rx_bps_avg,
    tx_bps: p.tx_bps_avg,
    rx_bytes: null,
    tx_bytes: null,
    process_count: null,
    uptime_sec: null,
  }));
}

export type MetricKey = 'bandwidth' | 'cpuUsage' | 'memoryUsage' | 'diskUsage' | 'load';

export const METRIC_LABELS: Readonly<Record<MetricKey, string>> = Object.freeze({
  bandwidth: '带宽',
  cpuUsage: 'CPU',
  memoryUsage: '内存',
  diskUsage: '磁盘',
  load: 'Load 1m',
});

export function getSampleValue(sample: ProbeSample, metric: MetricKey): number | null {
  let v: number | null = null;
  if (metric === 'cpuUsage') v = sample.cpu_usage;
  else if (metric === 'memoryUsage') v = sample.memory_usage;
  else if (metric === 'diskUsage') v = sample.disk_usage;
  else if (metric === 'load') v = sample.load1;
  return v !== null && Number.isFinite(v) ? v : null;
}

export const MAX_TREND_POINTS = 120;

export const ERROR_CODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
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

export function formatPercent(value: number | undefined | null): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(1)}%`;
}

export function formatLatency(value: number | undefined | null): string {
  if (value === null || value === undefined) return '--';
  return `${value} ms`;
}

export function formatBandwidth(value: number | undefined | null): string {
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

export function formatTime(value: string | number | undefined | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString();
}

export function formatTrendTime(value: string | number | undefined | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function normalizeBandwidthValue(value: number | undefined | null): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

/** 在 [0, length-1] 范围内均匀分 tickCount 个索引（去重保序） */
export function buildTickIndexes(length: number, tickCount = 4): number[] {
  if (length <= 1) return [0];
  const indexes = new Set<number>();
  for (let i = 0; i < tickCount; i += 1) {
    indexes.add(Math.round((i / (tickCount - 1)) * (length - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

export function getProbeStatusText(probe: ProbeEntry): string {
  if (probe.online) return '在线';
  return probe.stale ? '离线（沿用旧指标）' : '离线';
}

export function getErrorCodeText(errorCode: string | undefined): string {
  if (!errorCode) return '--';
  return ERROR_CODE_LABELS[errorCode] || errorCode;
}

export function getPlatformText(probe: ProbeEntry): string {
  if (probe.platform) return probe.platform;
  const info = probe.platformInfo;
  if (!info) return '--';
  const name = info.prettyName || [info.distroId, info.versionId].filter(Boolean).join(' ') || info.os;
  const suffix = [info.arch, info.kernel].filter(Boolean).join(' / ');
  return [name, suffix].filter(Boolean).join(' / ') || '--';
}

export function getDataSourceText(probe: ProbeEntry): string {
  if (probe.source === 'relay_agent') return probe.stale ? 'Relay Agent 旧快照' : 'Relay Agent';
  if (probe.source === 'agent') return probe.stale ? 'Agent 旧快照' : '1Shell Agent';
  if (probe.stale) return '最近一次成功快照';
  return probe.online ? 'SSH 实时采样' : '本次失败';
}

export function getAgentStatusText(probe: ProbeEntry): string {
  if (probe.agentTrusted) return 'Agent 在线';
  if (probe.agentOnline) return 'Agent 建立中';
  if (probe.agentInstalled) return 'Agent 离线';
  return '未安装 Agent';
}

export function formatBytes(value: number | undefined | null): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Number(value);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

export type TrafficLevel = 'normal' | 'warn' | 'over';

export function getTrafficLevel(probe: ProbeEntry): TrafficLevel {
  const percent = probe.trafficPercent;
  if (percent === null || percent === undefined) return 'normal';
  const alert = probe.trafficAlertPercent ?? 80;
  if (percent >= 100) return 'over';
  if (percent >= alert) return 'warn';
  return 'normal';
}

export function hasTrafficData(probe: ProbeEntry): boolean {
  const used = probe.trafficUsedBytes;
  const limit = probe.trafficLimitBytes;
  const hasUsed = typeof used === 'number' && Number.isFinite(used);
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
  return hasLimit || (hasUsed && (used as number) > 0);
}

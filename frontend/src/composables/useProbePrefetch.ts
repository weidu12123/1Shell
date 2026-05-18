import type { RequestOptions } from '@/composables/useApiClient';
import { isPageStateFresh, setCachedPageState } from '@/composables/usePageState';
import { MAX_TREND_POINTS, normalizeBandwidthValue, type ProbeEntry, type ProbeSample, type ProbeSnapshot } from '@/utils/probe';

export interface AlertEventCacheEntry {
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

export interface ProbePageCache {
  probes: ProbeEntry[];
  generatedAt: string | number | null;
  sampleIntervalMs: number | null;
  history: Array<[string, ProbeSample[]]>;
  alertEvents: AlertEventCacheEntry[];
  alertOpenCount: number;
}

export const PROBE_CACHE_KEY = 'probe.page.cache.v1';
export const PROBE_CACHE_TTL_MS = 45_000;

type RequestJson = <T>(url: string, options?: RequestOptions) => Promise<T>;

let prefetchInFlight: Promise<void> | null = null;

function isAgentProbe(p: ProbeEntry): boolean {
  if (p.source !== 'agent' && p.source !== 'relay_agent') return false;
  return Boolean(p.agentInstalled || p.agentOnline || p.agentTrusted || p.cpuUsage != null || p.memoryUsage != null || p.bandwidthRxBps != null || p.bandwidthTxBps != null);
}

function appendLiveSample(history: Map<string, ProbeSample[]>, list: ProbeEntry[], snapshotTime: string | number | null): void {
  for (const p of list) {
    if (!p.hostId || !isAgentProbe(p)) continue;
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
    const next = history.get(p.hostId)?.slice() || [];
    const last = next[next.length - 1];
    if (last?.reported_at === sample.reported_at) next[next.length - 1] = sample;
    else next.push(sample);
    if (next.length > MAX_TREND_POINTS) next.splice(0, next.length - MAX_TREND_POINTS);
    history.set(p.hostId, next);
  }
}

export function prefetchProbePageState(requestJson: RequestJson, force = false): Promise<void> {
  if (!force && isPageStateFresh(PROBE_CACHE_KEY, PROBE_CACHE_TTL_MS)) return Promise.resolve();
  if (prefetchInFlight) return prefetchInFlight;

  prefetchInFlight = (async () => {
    const snap = await requestJson<ProbeSnapshot>(force ? '/api/probes?refresh=1' : '/api/probes');
    const probes = Array.isArray(snap.probes) ? snap.probes : [];
    const history = new Map<string, ProbeSample[]>();
    const hostIds = probes.filter(isAgentProbe).map((p) => p.hostId);

    if (hostIds.length > 0) {
      try {
        const resp = await requestJson<{ ok: boolean; samples: Record<string, ProbeSample[]> }>('/api/probe-agents/samples-bulk', {
          method: 'POST',
          body: JSON.stringify({ hostIds, minutes: 60 }),
        });
        for (const [hostId, samples] of Object.entries(resp.samples || {})) {
          if (Array.isArray(samples)) history.set(hostId, samples.slice(-MAX_TREND_POINTS));
        }
      } catch {
        /* samples cache is best-effort */
      }
    }

    appendLiveSample(history, probes, snap.generatedAt ?? null);

    let alertEvents: AlertEventCacheEntry[] = [];
    let alertOpenCount = 0;
    try {
      const response = await requestJson<{ ok: boolean; events: AlertEventCacheEntry[]; openCount: number }>('/api/probe-alerts/events?status=open&limit=50');
      alertEvents = Array.isArray(response.events) ? response.events : [];
      alertOpenCount = Number(response.openCount) || 0;
    } catch {
      /* alerts cache is best-effort */
    }

    setCachedPageState<ProbePageCache>(PROBE_CACHE_KEY, {
      probes,
      generatedAt: snap.generatedAt ?? null,
      sampleIntervalMs: typeof snap.sampleIntervalMs === 'number' ? snap.sampleIntervalMs : null,
      history: [...history.entries()],
      alertEvents,
      alertOpenCount,
    });
  })().finally(() => {
    prefetchInFlight = null;
  });

  return prefetchInFlight;
}

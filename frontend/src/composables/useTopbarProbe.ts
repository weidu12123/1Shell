// useTopbarProbe.ts — 顶栏探针 4 字段（CPU / 内存 / 负载 / 硬盘）
// 与老 [public/layout.js#L333-L428](public/layout.js#L333-L428) 1:1：8s 轮询 /api/health/stats（本机 fallback）+ /api/probes 快照 + probe:update socket

import { ref, computed, onMounted, onBeforeUnmount, watch, type Ref } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useSocket } from '@/composables/useSocket';
import { useAuthStore } from '@/stores/auth';
import type { ProbeStats } from '@/utils/mainConsole';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';

interface ProbeEntry {
  hostId: string;
  name?: string;
  hostname?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  load1?: number;
}

interface HealthStatsResponse {
  cpu?: number;
  memory?: number;
  load?: number;
  disk?: number;
}

interface ProbeSnapshot {
  probes?: ProbeEntry[];
}

const POLL_INTERVAL_MS = 8000;

export function useTopbarProbe(activeHostId: Ref<string>) {
  const { requestJson } = useApiClient();
  const socket = useSocket();
  const auth = useAuthStore();

  const stats = ref<ProbeStats>({});
  const displayName = ref<string>('本机');
  const latestProbes = ref<ProbeEntry[]>([]);
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  function findProbeForHost(hostId: string): ProbeEntry | null {
    return latestProbes.value.find((p) => p.hostId === (hostId || LOCAL_HOST_ID)) || null;
  }

  function refresh(): void {
    const p = findProbeForHost(activeHostId.value);
    if (p) {
      stats.value = {
        cpu: p.cpuUsage,
        memory: p.memoryUsage,
        load: p.load1,
        disk: p.diskUsage,
      };
      displayName.value = p.name || p.hostname || '主机';
    }
  }

  async function pollLocalStats(): Promise<void> {
    try {
      const data = await requestJson<HealthStatsResponse>('/api/health/stats');
      if (latestProbes.value.length === 0 || activeHostId.value === LOCAL_HOST_ID) {
        stats.value = {
          cpu: data.cpu,
          memory: data.memory,
          load: data.load,
          disk: data.disk,
        };
        displayName.value = '本机';
      }
    } catch { /* 静默 */ }
  }

  async function fetchProbeSnapshot(): Promise<void> {
    try {
      const snap = await requestJson<ProbeSnapshot>('/api/probes');
      latestProbes.value = snap.probes || [];
      refresh();
    } catch { /* 静默 */ }
  }

  function onProbeUpdate(snapshot: unknown): void {
    const s = snapshot as ProbeSnapshot;
    latestProbes.value = s?.probes || [];
    refresh();
  }

  function start(): void {
    if (pollHandle) return;
    void pollLocalStats();
    void fetchProbeSnapshot();
    pollHandle = setInterval(() => { void pollLocalStats(); }, POLL_INTERVAL_MS);
  }

  function stop(): void {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  onMounted(() => {
    socket.on('probe:update', onProbeUpdate);
    // 登录成功后才轮询；watch authenticated
    if (auth.authenticated) start();
  });

  watch(() => auth.authenticated, (v) => {
    if (v) start();
    else stop();
  });

  watch(() => activeHostId.value, () => refresh());

  onBeforeUnmount(() => {
    stop();
    socket.off('probe:update', onProbeUpdate);
  });

  const fmt = (v: number | undefined): string => (v != null ? v + '%' : '--');
  const fmtLoad = (v: number | undefined): string => (v != null ? String(v) : '--');

  const cpuText = computed(() => fmt(stats.value.cpu));
  const memoryText = computed(() => fmt(stats.value.memory));
  const loadText = computed(() => fmtLoad(stats.value.load));
  const diskText = computed(() => fmt(stats.value.disk));

  return {
    stats, displayName,
    cpuText, memoryText, loadText, diskText,
    start, stop,
  };
}

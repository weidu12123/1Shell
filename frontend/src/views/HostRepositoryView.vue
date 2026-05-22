<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import FileBrowserPanel from '@/components/main/FileBrowserPanel.vue';
import ProbeTrendChart from '@/components/ProbeTrendChart.vue';
import type { HostPreference, HostRole } from '@/utils/mainConsole';
import { LOCAL_HOST_ID, formatHostMeta } from '@/utils/mainConsole';
import { formatBandwidth, type ProbeSample } from '@/utils/probe';

interface ProbeSummary {
  status: 'online' | 'offline' | 'unknown';
  mode: 'agentless' | 'agent' | 'relay' | 'none';
  cpu?: number | null;
  cpuIowait?: number | null;
  cpuSteal?: number | null;
  memory?: number | null;
  disk?: number | null;
  load?: number | null;
  trafficMonth?: number | null;
  trafficPercent?: number | null;
  lastSampleAt?: string | number | null;
  alertCount?: number | null;
  platform?: string | null;
}

interface RepositoryHost {
  id: string;
  name: string;
  type?: 'local' | 'ssh';
  host: string;
  user?: string;
  username: string;
  port: number | null;
  authType?: string;
  proxyHostId?: string | null;
  links?: { id?: string; name: string; url: string; description?: string }[];
  manualLocation?: unknown;
  preference: HostPreference;
  probe?: ProbeSummary | null;
}

interface RepositoryResponse {
  hosts?: RepositoryHost[];
}

interface ProbeSamplesBulkResponse {
  ok?: boolean;
  samples?: Record<string, ProbeSample[]>;
}

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const router = useRouter();

const loading = ref(false);
const hosts = ref<RepositoryHost[]>([]);
const selectedHostId = ref<string | null>(null);
const search = ref('');
const roleFilter = ref<'all' | HostRole | 'none'>('all');
const statusFilter = ref<'all' | 'online' | 'offline' | 'unknown' | 'no-probe' | 'alerts'>('all');
const archiveFilter = ref<'active' | 'archived' | 'all'>('active');
const activeTab = ref<'detail' | 'probe' | 'files'>('detail');
const tagDraft = ref('');
const draggingHostId = ref<string | null>(null);
const draggingFromConsole = ref(false);
const dragOverHostId = ref<string | null>(null);
const consoleDropActive = ref(false);
const repositoryDropActive = ref(false);
const hideDropActive = ref(false);
const bandwidthSamples = ref<ProbeSample[]>([]);
const bandwidthLoading = ref(false);
const bandwidthHostId = ref<string | null>(null);

const roleLabels: Record<HostRole, string> = {
  primary: '主力',
  project: '项目',
  probe: '探针',
  proxy: '代理',
  relay: '中继',
  test: '测试',
  archive: '归档',
};

const roleOptions: { value: 'all' | HostRole | 'none'; label: string }[] = [
  { value: 'all', label: '全部角色' },
  { value: 'none', label: '未标记' },
  { value: 'primary', label: '主力' },
  { value: 'project', label: '项目' },
  { value: 'probe', label: '探针' },
  { value: 'proxy', label: '代理' },
  { value: 'relay', label: '中继' },
  { value: 'test', label: '测试' },
  { value: 'archive', label: '归档' },
];

const editableRoleOptions: { value: HostRole | ''; label: string }[] = [
  { value: '', label: '未标记' },
  { value: 'primary', label: '主力' },
  { value: 'project', label: '项目' },
  { value: 'probe', label: '探针' },
  { value: 'proxy', label: '代理' },
  { value: 'relay', label: '中继' },
  { value: 'test', label: '测试' },
  { value: 'archive', label: '归档' },
];

const statusOptions: { value: typeof statusFilter.value; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'online', label: '在线' },
  { value: 'offline', label: '离线' },
  { value: 'unknown', label: '未知' },
  { value: 'no-probe', label: '未启用探针' },
  { value: 'alerts', label: '有告警' },
];

const archiveOptions: { value: typeof archiveFilter.value; label: string }[] = [
  { value: 'active', label: '活跃资产' },
  { value: 'archived', label: '归档资产' },
  { value: 'all', label: '全部资产' },
];

const selectedHost = computed(() => hosts.value.find((host) => host.id === selectedHostId.value) || hosts.value[0] || null);
const consoleHosts = computed(() => hosts.value
  .filter((host) => host.preference.showInConsole && !host.preference.archived)
  .slice()
  .sort(sortConsoleHosts));

const filteredHosts = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return hosts.value.filter((host) => {
    if (archiveFilter.value === 'active' && host.preference.archived) return false;
    if (archiveFilter.value === 'archived' && !host.preference.archived) return false;
    if (roleFilter.value === 'none' && host.preference.role) return false;
    if (roleFilter.value !== 'all' && roleFilter.value !== 'none' && host.preference.role !== roleFilter.value) return false;
    if (!matchesStatusFilter(host)) return false;
    if (!kw) return true;
    const haystack = [
      host.name,
      host.host,
      host.username,
      host.user,
      host.preference.role ? roleLabels[host.preference.role] : '',
      ...host.preference.tags,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(kw);
  });
});

function sortConsoleHosts(a: RepositoryHost, b: RepositoryHost): number {
  if (a.preference.pinned !== b.preference.pinned) return a.preference.pinned ? -1 : 1;
  if (a.preference.consoleOrder !== b.preference.consoleOrder) return a.preference.consoleOrder - b.preference.consoleOrder;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

function matchesStatusFilter(host: RepositoryHost): boolean {
  if (statusFilter.value === 'all') return true;
  if (statusFilter.value === 'alerts') return (host.probe?.alertCount || 0) > 0;
  if (statusFilter.value === 'no-probe') return !host.probe || host.probe.mode === 'none';
  return host.probe?.status === statusFilter.value;
}

function statusLabel(host: RepositoryHost): string {
  if (!host.probe || host.probe.mode === 'none') return '未启用探针';
  if (host.probe.status === 'online') return '在线';
  if (host.probe.status === 'offline') return '离线';
  return '未知';
}

function statusClass(host: RepositoryHost): string {
  if (host.probe?.status === 'online') return 'bg-emerald-400 shadow-emerald-400/40';
  if (host.probe?.status === 'offline') return 'bg-rose-400 shadow-rose-400/40';
  return 'bg-slate-400 shadow-slate-400/30';
}

function modeLabel(host: RepositoryHost): string {
  if (!host.probe) return '未启用';
  if (host.probe.mode === 'agent') return 'probe-agent';
  if (host.probe.mode === 'relay') return 'relay-agent';
  if (host.probe.mode === 'agentless') return 'Agentless';
  return '未启用';
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(1)}%`;
}

function formatLoad(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toFixed(2);
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(value);
  let index = 0;
  while (Math.abs(size) >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function latestBandwidthValue(kind: 'rx_bps' | 'tx_bps'): number | null {
  const sample = bandwidthSamples.value[bandwidthSamples.value.length - 1];
  const value = sample?.[kind];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatTime(value: string | number | null | undefined): string {
  if (!value) return '--';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return time.toLocaleString();
}

function roleText(host: RepositoryHost): string {
  return host.preference.role ? roleLabels[host.preference.role] : '未标记';
}

function hostMeta(host: RepositoryHost): string {
  return formatHostMeta({
    id: host.id,
    name: host.name,
    host: host.host,
    port: host.port || 22,
    username: host.username || host.user || 'root',
    type: host.type,
  });
}

function platformText(host: RepositoryHost): string {
  const text = host.probe?.platform;
  return text && text !== '--' ? text : '--';
}

async function loadHosts(): Promise<void> {
  loading.value = true;
  try {
    const repositoryData = await requestJson<RepositoryResponse>('/api/hosts/repository');
    const nextHosts = repositoryData.hosts || [];
    hosts.value = nextHosts;
    if (!selectedHostId.value || !hosts.value.some((host) => host.id === selectedHostId.value)) {
      selectedHostId.value = hosts.value[0]?.id || null;
    }
  } catch (err) {
    notify.error((err as Error).message || '加载 VPS 仓库失败');
  } finally {
    loading.value = false;
  }
}

async function loadBandwidthSamples(host: RepositoryHost | null): Promise<void> {
  if (!host || host.probe?.mode === 'none') {
    bandwidthSamples.value = [];
    bandwidthHostId.value = host?.id || null;
    return;
  }
  const hostId = host.id;
  bandwidthHostId.value = hostId;
  bandwidthLoading.value = true;
  try {
    const response = await requestJson<ProbeSamplesBulkResponse>('/api/probe-agents/samples-bulk', {
      method: 'POST',
      body: JSON.stringify({ hostIds: [hostId], minutes: 60 }),
    });
    if (bandwidthHostId.value !== hostId) return;
    const samples = response.samples?.[hostId];
    bandwidthSamples.value = Array.isArray(samples) ? samples : [];
  } catch {
    if (bandwidthHostId.value === hostId) bandwidthSamples.value = [];
  } finally {
    if (bandwidthHostId.value === hostId) bandwidthLoading.value = false;
  }
}

async function patchPreferenceOnly(hostId: string, patch: Partial<HostPreference>): Promise<void> {
  await requestJson(`/api/hosts/${encodeURIComponent(hostId)}/preference`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

async function patchPreference(hostId: string, patch: Partial<HostPreference>): Promise<void> {
  await patchPreferenceOnly(hostId, patch);
  await loadHosts();
}

async function saveConsoleOrder(hostIds: string[]): Promise<void> {
  await requestJson('/api/hosts/console-order', {
    method: 'POST',
    body: JSON.stringify({ hostIds }),
  });
  await loadHosts();
}

async function addToConsole(host: RepositoryHost): Promise<void> {
  const maxOrder = consoleHosts.value.reduce((max, item) => Math.max(max, item.preference.consoleOrder), -1);
  try {
    await patchPreference(host.id, { showInConsole: true, archived: false, consoleOrder: maxOrder + 1 });
    notify.success('已加入主控显示');
  } catch (err) {
    notify.error((err as Error).message || '加入主控失败');
  }
}

async function pinToConsole(host: RepositoryHost): Promise<void> {
  try {
    await patchPreference(host.id, { showInConsole: true, archived: false, pinned: true, consoleOrder: 0 });
    notify.success('已顶置到主控');
  } catch (err) {
    notify.error((err as Error).message || '顶置失败');
  }
}

async function hideFromConsole(host: RepositoryHost): Promise<void> {
  if (host.id === LOCAL_HOST_ID) {
    notify.warn('本机保留在主控中');
    return;
  }
  try {
    await patchPreference(host.id, { showInConsole: false, pinned: false });
    notify.success('已从主控隐藏');
  } catch (err) {
    notify.error((err as Error).message || '隐藏失败');
  }
}

async function updateHostRole(event: Event, host: RepositoryHost): Promise<void> {
  const value = (event.target as HTMLSelectElement).value as HostRole | '';
  try {
    await patchPreference(host.id, { role: value || null });
    notify.success('角色已更新');
  } catch (err) {
    notify.error((err as Error).message || '角色更新失败');
  }
}

function parseTagDraft(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of tagDraft.value.split(/[\s,，、]+/)) {
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

async function addTags(host: RepositoryHost): Promise<void> {
  const nextTags = parseTagDraft();
  if (!nextTags.length) {
    notify.warn('请输入标签');
    return;
  }
  const merged = [...host.preference.tags];
  for (const tag of nextTags) {
    if (!merged.includes(tag)) merged.push(tag);
  }
  try {
    await patchPreference(host.id, { tags: merged });
    tagDraft.value = '';
    notify.success('标签已更新');
  } catch (err) {
    notify.error((err as Error).message || '标签更新失败');
  }
}

async function removeTag(host: RepositoryHost, tag: string): Promise<void> {
  try {
    await patchPreference(host.id, { tags: host.preference.tags.filter((item) => item !== tag) });
    notify.success('标签已移除');
  } catch (err) {
    notify.error((err as Error).message || '标签移除失败');
  }
}

async function deleteHost(host: RepositoryHost): Promise<void> {
  if (host.id === LOCAL_HOST_ID) {
    notify.warn('本机不能删除');
    return;
  }
  const ok = window.confirm(`确认删除 VPS「${host.name}」吗？删除后会同步清理探针、流量和告警数据。`);
  if (!ok) return;
  try {
    await requestJson(`/api/hosts/${encodeURIComponent(host.id)}`, { method: 'DELETE' });
    notify.success('VPS 已删除');
    await loadHosts();
  } catch (err) {
    notify.error((err as Error).message || '删除失败');
  }
}

async function moveConsoleHost(host: RepositoryHost, direction: -1 | 1): Promise<void> {
  const ordered = consoleHosts.value.slice();
  const index = ordered.findIndex((item) => item.id === host.id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
  const [item] = ordered.splice(index, 1);
  ordered.splice(nextIndex, 0, item);
  try {
    await saveConsoleOrder(ordered.map((item) => item.id));
  } catch (err) {
    notify.error((err as Error).message || '排序失败');
  }
}

function getDraggedHostId(event: DragEvent): string | null {
  return event.dataTransfer?.getData('application/x-1shell-host-id') || event.dataTransfer?.getData('text/plain') || draggingHostId.value;
}

function onHostDragStart(event: DragEvent, host: RepositoryHost, fromConsole: boolean): void {
  draggingHostId.value = host.id;
  draggingFromConsole.value = fromConsole;
  selectedHostId.value = host.id;
  event.dataTransfer?.setData('application/x-1shell-host-id', host.id);
  event.dataTransfer?.setData('text/plain', host.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(): void {
  draggingHostId.value = null;
  draggingFromConsole.value = false;
  dragOverHostId.value = null;
  consoleDropActive.value = false;
  repositoryDropActive.value = false;
  hideDropActive.value = false;
}

function onConsoleDragOver(event: DragEvent, targetHost: RepositoryHost | null = null): void {
  if (!draggingHostId.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  consoleDropActive.value = true;
  dragOverHostId.value = targetHost?.id || null;
}

function buildConsoleOrder(draggedHostId: string, targetHostId: string | null): string[] {
  const ordered = consoleHosts.value.map((host) => host.id).filter((id) => id !== draggedHostId);
  const targetIndex = targetHostId ? ordered.indexOf(targetHostId) : -1;
  if (targetIndex >= 0) {
    ordered.splice(targetIndex, 0, draggedHostId);
  } else {
    ordered.push(draggedHostId);
  }
  return ordered;
}

async function onConsoleDrop(event: DragEvent, targetHost: RepositoryHost | null = null): Promise<void> {
  event.preventDefault();
  const hostId = getDraggedHostId(event);
  const host = hosts.value.find((item) => item.id === hostId);
  if (!host) {
    onDragEnd();
    return;
  }

  const orderedIds = buildConsoleOrder(host.id, targetHost?.id || null);
  try {
    if (!host.preference.showInConsole || host.preference.archived) {
      await patchPreferenceOnly(host.id, { showInConsole: true, archived: false });
    }
    await saveConsoleOrder(orderedIds);
    notify.success(draggingFromConsole.value ? '主控顺序已更新' : '已拖入主控显示');
  } catch (err) {
    notify.error((err as Error).message || '拖拽更新失败');
  } finally {
    onDragEnd();
  }
}

function onHideDragOver(event: DragEvent): void {
  if (!draggingHostId.value) return;
  event.preventDefault();
  hideDropActive.value = true;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

function onHideDragLeave(event: DragEvent): void {
  if (event.target === event.currentTarget) hideDropActive.value = false;
}

async function onHideDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const hostId = getDraggedHostId(event);
  const host = hosts.value.find((item) => item.id === hostId);
  if (!host) {
    onDragEnd();
    return;
  }
  try {
    if (!host.preference.showInConsole) {
      notify.warn('这台主机未在主控显示');
    } else {
      await hideFromConsole(host);
    }
  } finally {
    onDragEnd();
  }
}

function onRepositoryDragOver(event: DragEvent): void {
  if (!draggingFromConsole.value) return;
  event.preventDefault();
  repositoryDropActive.value = true;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

function onRepositoryDragLeave(event: DragEvent): void {
  if (event.target === event.currentTarget) repositoryDropActive.value = false;
}

async function onRepositoryDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const hostId = getDraggedHostId(event);
  const host = hosts.value.find((item) => item.id === hostId);
  if (!draggingFromConsole.value || !host) {
    onDragEnd();
    return;
  }
  try {
    await hideFromConsole(host);
  } finally {
    onDragEnd();
  }
}

function openConsole(host: RepositoryHost): void {
  router.push({ path: '/console', query: { host: host.id } });
}

function openProbe(host?: RepositoryHost): void {
  if (host?.id) {
    router.push({ path: '/probe', query: { hostId: host.id } });
    return;
  }
  router.push('/probe');
}

function selectHost(host: RepositoryHost): void {
  selectedHostId.value = host.id;
}

watch(
  () => [selectedHost.value?.id, selectedHost.value?.probe?.mode, activeTab.value] as const,
  ([hostId]) => {
    if (!hostId || activeTab.value !== 'probe') return;
    void loadBandwidthSamples(selectedHost.value);
  },
);

onMounted(() => { void loadHosts(); });
</script>

<template>
  <div class="h-screen min-h-0 overflow-hidden p-3 bg-slate-100 text-slate-900 dark:bg-[#07111f] dark:text-slate-100">
    <div class="h-full min-h-0 flex flex-col gap-3">
      <header class="shrink-0 flex items-center justify-between rounded-2xl border border-white/70 bg-white/80 px-4 py-2 shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-950/70 dark:shadow-black/20">
        <h1 class="text-xl font-semibold">VPS 仓库</h1>
        <button
          type="button"
          class="rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-100 dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-200"
          @click="loadHosts"
        >刷新</button>
      </header>

      <main class="grid flex-1 min-h-0 grid-cols-[20%_30%_50%] gap-3">
        <section class="min-w-0 min-h-0 rounded-3xl border border-white/70 bg-white/82 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#0b1324]/86 flex flex-col overflow-hidden">
          <div class="shrink-0 border-b border-slate-200/70 px-4 py-3 dark:border-white/10">
            <div class="flex items-center justify-between gap-2">
              <div>
                <h2 class="text-base font-semibold">主控显示</h2>
                <p class="text-xs text-slate-500 dark:text-slate-400">{{ consoleHosts.length }} 台会出现在主控左栏</p>
              </div>
            </div>
          </div>
          <div
            class="flex-1 min-h-0 overflow-y-auto p-3 space-y-2"
            @dragover.prevent="onConsoleDragOver($event)"
            @drop.prevent="onConsoleDrop($event)"
          >
            <div
              v-if="!consoleHosts.length"
              class="rounded-2xl border border-dashed p-4 text-center text-xs transition"
              :class="consoleDropActive ? 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-400/50 dark:bg-blue-400/10 dark:text-blue-200' : 'border-slate-300 text-slate-500 dark:border-white/15 dark:text-slate-400'"
            >
              暂无主控显示主机，可从中间列表拖入或点击加入。
            </div>
            <article
              v-for="(host, index) in consoleHosts"
              :key="host.id"
              draggable="true"
              class="rounded-2xl border p-3 transition cursor-grab active:cursor-grabbing"
              :class="[
                host.id === selectedHost?.id ? 'border-blue-400 bg-blue-50/80 dark:border-blue-400/70 dark:bg-blue-400/10' : 'border-slate-200 bg-white/70 hover:border-blue-200 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-blue-400/40',
                draggingHostId === host.id ? 'opacity-50' : '',
                dragOverHostId === host.id ? 'ring-2 ring-blue-300 dark:ring-blue-400/40' : '',
              ]"
              @click="selectHost(host)"
              @dragstart="onHostDragStart($event, host, true)"
              @dragend="onDragEnd"
              @dragover.stop.prevent="onConsoleDragOver($event, host)"
              @drop.stop.prevent="onConsoleDrop($event, host)"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full shadow" :class="statusClass(host)" />
                    <h3 class="truncate text-sm font-semibold">{{ host.name }}</h3>
                    <span v-if="host.preference.pinned" class="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-400/15 dark:text-amber-200">置顶</span>
                  </div>
                  <p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{{ hostMeta(host) }}</p>
                  <p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">CPU {{ formatPercent(host.probe?.cpu) }} · MEM {{ formatPercent(host.probe?.memory) }} · 告警 {{ host.probe?.alertCount || 0 }}</p>
                  <div class="mt-2 flex flex-wrap gap-1">
                    <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-white/8 dark:text-slate-300">{{ roleText(host) }}</span>
                    <span v-for="tag in host.preference.tags" :key="tag" class="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-600 dark:bg-blue-400/10 dark:text-blue-200">{{ tag }}</span>
                  </div>
                </div>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-1.5 text-[11px]">
                <button type="button" class="rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/8" :disabled="index === 0" @click.stop="moveConsoleHost(host, -1)">上移</button>
                <button type="button" class="rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/8" :disabled="index === consoleHosts.length - 1" @click.stop="moveConsoleHost(host, 1)">下移</button>
                <button type="button" class="rounded-lg border border-amber-200 px-2 py-1 text-amber-700 hover:bg-amber-50 dark:border-amber-400/20 dark:text-amber-200 dark:hover:bg-amber-400/10" @click.stop="pinToConsole(host)">顶置</button>
                <button type="button" class="rounded-lg border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-200 dark:hover:bg-rose-400/10" @click.stop="hideFromConsole(host)">隐藏</button>
              </div>
            </article>
            <div
              class="rounded-2xl border border-dashed p-3 text-center text-xs transition"
              :class="hideDropActive ? 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-400/50 dark:bg-rose-400/10 dark:text-rose-200' : 'border-slate-300 text-slate-500 dark:border-white/15 dark:text-slate-400'"
              @dragover.stop.prevent="onHideDragOver($event)"
              @dragleave="onHideDragLeave($event)"
              @drop.stop.prevent="onHideDrop($event)"
            >
              拖到这里从主控隐藏
            </div>
          </div>
        </section>

        <section
          class="min-w-0 min-h-0 rounded-3xl border bg-white/82 shadow-sm backdrop-blur dark:bg-[#0b1324]/86 flex flex-col overflow-hidden transition"
          :class="repositoryDropActive ? 'border-rose-400 ring-2 ring-rose-200 dark:border-rose-400/60 dark:ring-rose-400/20' : 'border-white/70 dark:border-white/10'"
          @dragover="onRepositoryDragOver($event)"
          @dragleave="onRepositoryDragLeave($event)"
          @drop="onRepositoryDrop($event)"
        >
          <div class="shrink-0 border-b border-slate-200/70 p-3 dark:border-white/10">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-base font-semibold">全部 VPS</h2>
              <span v-if="repositoryDropActive" class="rounded-full bg-rose-50 px-2 py-1 text-[11px] text-rose-600 dark:bg-rose-400/10 dark:text-rose-200">松手取消主控显示</span>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <input
                v-model="search"
                type="text"
                placeholder="搜索名称 / IP / 用户 / 标签"
                class="col-span-2 min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-blue-400 dark:border-white/10 dark:bg-[#07111f]"
              />
              <select
                v-model="roleFilter"
                class="rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs outline-none focus:border-blue-400 dark:border-white/10 dark:bg-[#07111f]"
              >
                <option v-for="option in roleOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <select
                v-model="statusFilter"
                class="rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs outline-none focus:border-blue-400 dark:border-white/10 dark:bg-[#07111f]"
              >
                <option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <select
                v-model="archiveFilter"
                class="col-span-2 rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs outline-none focus:border-blue-400 dark:border-white/10 dark:bg-[#07111f]"
              >
                <option v-for="option in archiveOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </div>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            <div v-if="loading" class="py-8 text-center text-xs text-slate-500">加载中…</div>
            <template v-else>
              <article
                v-for="host in filteredHosts"
                :key="host.id"
                draggable="true"
                class="rounded-2xl border p-3 transition cursor-grab active:cursor-grabbing"
                :class="[
                  host.id === selectedHost?.id ? 'border-blue-400 bg-blue-50/80 dark:border-blue-400/70 dark:bg-blue-400/10' : 'border-slate-200 bg-white/70 hover:border-blue-200 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-blue-400/40',
                  draggingHostId === host.id ? 'opacity-50' : '',
                ]"
                @click="selectHost(host)"
                @dragstart="onHostDragStart($event, host, false)"
                @dragend="onDragEnd"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="h-2 w-2 rounded-full shadow" :class="statusClass(host)" />
                      <h3 class="truncate text-sm font-semibold">{{ host.name }}</h3>
                      <span v-if="host.preference.showInConsole" class="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200">已在主控</span>
                      <span v-if="host.preference.archived" class="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-white/10 dark:text-slate-300">已归档</span>
                    </div>
                    <p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{{ hostMeta(host) }}</p>
                    <p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">{{ statusLabel(host) }} · {{ modeLabel(host) }} · {{ roleText(host) }}</p>
                    <p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">CPU {{ formatPercent(host.probe?.cpu) }} · MEM {{ formatPercent(host.probe?.memory) }} · 流量 {{ formatBytes(host.probe?.trafficMonth) }}</p>
                  </div>
                </div>
                <div class="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                  <button type="button" class="rounded-lg border border-blue-200 px-2 py-1 text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:border-blue-400/20 dark:text-blue-200 dark:hover:bg-blue-400/10" :disabled="host.preference.showInConsole" @click.stop="addToConsole(host)">加入主控</button>
                  <button type="button" class="rounded-lg border border-amber-200 px-2 py-1 text-amber-700 hover:bg-amber-50 dark:border-amber-400/20 dark:text-amber-200 dark:hover:bg-amber-400/10" @click.stop="pinToConsole(host)">顶置到主控</button>
                  <button type="button" class="rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/8" @click.stop="selectHost(host)">查看详情</button>
                  <button type="button" class="rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/8" @click.stop="openConsole(host)">打开终端</button>
                  <button v-if="host.id !== LOCAL_HOST_ID" type="button" class="rounded-lg border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-200 dark:hover:bg-rose-400/10" @click.stop="deleteHost(host)">删除</button>
                </div>
              </article>
            </template>
          </div>
        </section>

        <section class="min-w-0 min-h-0 rounded-3xl border border-white/70 bg-white/82 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#0b1324]/86 flex flex-col overflow-hidden">
          <div v-if="selectedHost" class="shrink-0 border-b border-slate-200/70 p-4 dark:border-white/10">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full shadow" :class="statusClass(selectedHost)" />
                  <h2 class="truncate text-xl font-semibold">{{ selectedHost.name }}</h2>
                </div>
                <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">{{ hostMeta(selectedHost) }}</p>
              </div>
              <button type="button" class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500" @click="openConsole(selectedHost)">打开主控终端</button>
            </div>
            <div class="mt-4 flex gap-2 text-sm">
              <button type="button" class="rounded-xl px-3 py-1.5" :class="activeTab === 'detail' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/8 dark:text-slate-300'" @click="activeTab = 'detail'">详情</button>
              <button type="button" class="rounded-xl px-3 py-1.5" :class="activeTab === 'probe' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/8 dark:text-slate-300'" @click="activeTab = 'probe'">运行情况</button>
              <button type="button" class="rounded-xl px-3 py-1.5" :class="activeTab === 'files' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/8 dark:text-slate-300'" @click="activeTab = 'files'">文件</button>
            </div>
          </div>

          <div v-if="selectedHost" class="flex-1 min-h-0 overflow-y-auto p-4">
            <div v-if="activeTab === 'detail'" class="space-y-4">
              <div class="grid grid-cols-2 gap-3">
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]"><p class="text-xs text-slate-500">SSH 用户</p><p class="mt-1 font-medium">{{ selectedHost.username || selectedHost.user || '-' }}</p></div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]"><p class="text-xs text-slate-500">地址 / 端口</p><p class="mt-1 font-medium">{{ selectedHost.host }}:{{ selectedHost.port || 22 }}</p></div>
                <div class="col-span-2 rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]"><p class="text-xs text-slate-500">操作系统</p><p class="mt-1 font-medium">{{ platformText(selectedHost) }}</p></div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">角色</p>
                  <select
                    :value="selectedHost.preference.role || ''"
                    class="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/10 dark:bg-[#07111f]"
                    @change="updateHostRole($event, selectedHost)"
                  >
                    <option v-for="option in editableRoleOptions" :key="option.value || 'none'" :value="option.value">{{ option.label }}</option>
                  </select>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]"><p class="text-xs text-slate-500">主控排序</p><p class="mt-1 font-medium">{{ selectedHost.preference.showInConsole ? selectedHost.preference.consoleOrder : '未显示' }}</p></div>
              </div>
              <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-sm font-semibold">标签</p>
                  <p class="text-xs text-slate-400">空格 / 逗号分隔</p>
                </div>
                <div class="mt-3 flex flex-wrap gap-1.5">
                  <span v-if="!selectedHost.preference.tags.length" class="text-sm text-slate-400">暂无标签</span>
                  <button
                    v-for="tag in selectedHost.preference.tags"
                    :key="tag"
                    type="button"
                    class="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-600 transition hover:bg-blue-100 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/20"
                    title="点击移除标签"
                    @click="removeTag(selectedHost, tag)"
                  >{{ tag }} ×</button>
                </div>
                <div class="mt-3 flex gap-2">
                  <input
                    v-model="tagDraft"
                    type="text"
                    placeholder="输入标签，如 prod web"
                    class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/10 dark:bg-[#07111f]"
                    @keydown.enter.prevent="addTags(selectedHost)"
                  />
                  <button type="button" class="rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500" @click="addTags(selectedHost)">添加</button>
                </div>
              </div>
              <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <p class="text-sm font-semibold">快捷动作</p>
                <div class="mt-3 flex flex-wrap gap-2 text-sm">
                  <button type="button" class="rounded-xl bg-blue-600 px-3 py-2 text-white hover:bg-blue-500" @click="openConsole(selectedHost)">打开主控终端</button>
                  <button type="button" class="rounded-xl border border-blue-200 px-3 py-2 text-blue-700 hover:bg-blue-50 dark:border-blue-400/20 dark:text-blue-200 dark:hover:bg-blue-400/10" @click="addToConsole(selectedHost)">加入主控</button>
                  <button type="button" class="rounded-xl border border-amber-200 px-3 py-2 text-amber-700 hover:bg-amber-50 dark:border-amber-400/20 dark:text-amber-200 dark:hover:bg-amber-400/10" @click="pinToConsole(selectedHost)">顶置</button>
                  <button v-if="selectedHost.id !== LOCAL_HOST_ID" type="button" class="rounded-xl border border-rose-200 px-3 py-2 text-rose-600 hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-200 dark:hover:bg-rose-400/10" @click="hideFromConsole(selectedHost)">从主控隐藏</button>
                  <button v-if="selectedHost.id !== LOCAL_HOST_ID" type="button" class="rounded-xl border border-rose-200 px-3 py-2 text-rose-600 hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-200 dark:hover:bg-rose-400/10" @click="deleteHost(selectedHost)">删除 VPS</button>
                </div>
              </div>
            </div>

            <div v-else-if="activeTab === 'probe'" class="space-y-4">
              <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">状态</p>
                  <p class="mt-1 font-semibold" :class="selectedHost.probe?.status === 'online' ? 'text-emerald-600 dark:text-emerald-300' : selectedHost.probe?.status === 'offline' ? 'text-rose-600 dark:text-rose-300' : ''">{{ statusLabel(selectedHost) }}</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">探针模式</p>
                  <p class="mt-1 font-semibold">{{ modeLabel(selectedHost) }}</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">告警</p>
                  <p class="mt-1 font-semibold" :class="(selectedHost.probe?.alertCount || 0) > 0 ? 'text-amber-600 dark:text-amber-300' : ''">{{ selectedHost.probe?.alertCount || 0 }} 个</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">最近采样</p>
                  <p class="mt-1 text-sm font-medium">{{ formatTime(selectedHost.probe?.lastSampleAt) }}</p>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">CPU</p>
                  <p class="mt-2 text-2xl font-semibold">{{ formatPercent(selectedHost.probe?.cpu) }}</p>
                  <p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">IO wait {{ formatPercent(selectedHost.probe?.cpuIowait) }} · steal {{ formatPercent(selectedHost.probe?.cpuSteal) }}</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">内存</p>
                  <p class="mt-2 text-2xl font-semibold">{{ formatPercent(selectedHost.probe?.memory) }}</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">磁盘</p>
                  <p class="mt-2 text-2xl font-semibold">{{ formatPercent(selectedHost.probe?.disk) }}</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">Load 1m</p>
                  <p class="mt-2 text-2xl font-semibold">{{ formatLoad(selectedHost.probe?.load) }}</p>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-xs text-slate-500">月度流量</p>
                  <p class="mt-2 text-xl font-semibold">{{ formatBytes(selectedHost.probe?.trafficMonth) }}</p>
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">配额占比 {{ formatPercent(selectedHost.probe?.trafficPercent) }}</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p class="text-sm font-semibold">诊断入口</p>
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Ping / DNS / HTTP 诊断沿用探针页能力。</p>
                  <button type="button" class="mt-3 rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500" @click="openProbe(selectedHost)">打开探针页</button>
                </div>
              </div>

              <div class="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p class="text-sm font-semibold">带宽趋势</p>
                    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">复用探针页最近 1 小时 Agent 采样。</p>
                  </div>
                  <div class="flex gap-2 text-xs">
                    <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200">↓ {{ formatBandwidth(latestBandwidthValue('rx_bps')) }}</span>
                    <span class="rounded-full bg-blue-50 px-2.5 py-1 text-blue-700 dark:bg-blue-400/10 dark:text-blue-200">↑ {{ formatBandwidth(latestBandwidthValue('tx_bps')) }}</span>
                  </div>
                </div>
                <ProbeTrendChart :samples="bandwidthSamples" metric="bandwidth" :loading="bandwidthLoading" />
              </div>

              <div v-if="selectedHost.probe?.mode === 'none'" class="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-500 dark:border-white/15 dark:text-slate-400">
                这台主机暂无探针数据。可以在探针页启用 agentless 探测或安装 probe-agent。
              </div>
            </div>

            <div v-else class="h-full min-h-[520px] overflow-hidden rounded-2xl border border-slate-200 bg-white/70 dark:border-white/10 dark:bg-white/[0.03]">
              <FileBrowserPanel :host-id="selectedHost.id" title="当前 VPS 文件" />
            </div>
          </div>

          <div v-else class="flex flex-1 items-center justify-center text-sm text-slate-500">暂无主机</div>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
// 主页两侧功能卡：左 = 跳转（最近主机 / 探针），右 = 主机总览统计
// 数据源：/api/hosts + /api/probes（与 useTopbarProbe 同接口，8s 轮询）
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useApiClient } from '@/composables/useApiClient';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { MainHost } from '@/utils/mainConsole';
import AppIcon from '@/components/AppIcon.vue';

interface ProbeEntry {
  hostId: string;
  name?: string;
  hostname?: string;
  online?: boolean;
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  diskUsage?: number | null;
}

interface ProbeSnapshot {
  probes?: ProbeEntry[];
}

interface HostsListResponse {
  hosts?: MainHost[];
}

const router = useRouter();
const { requestJson } = useApiClient();

const hosts = ref<MainHost[]>([]);
const probes = ref<ProbeEntry[]>([]);
const loaded = ref(false);

const POLL_MS = 8000;
let pollHandle: ReturnType<typeof setInterval> | null = null;

const sshHosts = computed(() => hosts.value.filter((h) => h.id !== LOCAL_HOST_ID));

const probeMap = computed<Map<string, ProbeEntry>>(() => {
  const m = new Map<string, ProbeEntry>();
  for (const p of probes.value) m.set(p.hostId, p);
  return m;
});

// 最近主机：localStorage 优先，否则取首台 SSH 主机
const recentHost = computed<MainHost | null>(() => {
  let id: string | null = null;
  try { id = localStorage.getItem('1shell-last-host'); } catch { /* ignore */ }
  if (id) {
    const h = hosts.value.find((x) => x.id === id);
    if (h) return h;
  }
  return sshHosts.value[0] || null;
});

const recentHostProbe = computed(() => {
  const h = recentHost.value;
  if (!h) return null;
  return probeMap.value.get(h.id) || null;
});

const totalCount = computed(() => sshHosts.value.length);

const onlineCount = computed(() =>
  sshHosts.value.filter((h) => probeMap.value.get(h.id)?.online === true).length,
);

// 异常 = 离线 OR CPU/内存/磁盘 ≥ 90%
function isAbnormal(h: MainHost): boolean {
  const p = probeMap.value.get(h.id);
  if (!p) return false;
  if (p.online === false) return true;
  const high = (v: number | null | undefined) => typeof v === 'number' && v >= 90;
  return high(p.cpuUsage) || high(p.memoryUsage) || high(p.diskUsage);
}

const abnormalHosts = computed(() => sshHosts.value.filter(isAbnormal));
const abnormalCount = computed(() => abnormalHosts.value.length);

function abnormalReason(h: MainHost): string {
  const p = probeMap.value.get(h.id);
  if (!p) return '未知';
  if (p.online === false) return '离线';
  const tags: string[] = [];
  if (typeof p.cpuUsage === 'number' && p.cpuUsage >= 90) tags.push(`CPU ${Math.round(p.cpuUsage)}%`);
  if (typeof p.memoryUsage === 'number' && p.memoryUsage >= 90) tags.push(`内存 ${Math.round(p.memoryUsage)}%`);
  if (typeof p.diskUsage === 'number' && p.diskUsage >= 90) tags.push(`磁盘 ${Math.round(p.diskUsage)}%`);
  return tags.join(' · ') || '异常';
}

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<HostsListResponse>('/api/hosts');
    hosts.value = data.hosts || [];
  } catch { /* 静默：未登录 / 网络错误 */ }
}

async function loadProbes(): Promise<void> {
  try {
    const snap = await requestJson<ProbeSnapshot>('/api/probes');
    probes.value = snap.probes || [];
  } catch { /* 静默 */ }
}

async function refresh(): Promise<void> {
  await Promise.all([loadHosts(), loadProbes()]);
  loaded.value = true;
}

onMounted(() => {
  void refresh();
  pollHandle = setInterval(() => { void loadProbes(); }, POLL_MS);
});

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
});

function gotoRecentHost(): void {
  const h = recentHost.value;
  if (!h) {
    router.push('/console');
    return;
  }
  router.push({ path: '/console', query: { host: h.id } });
}

function gotoProbe(): void {
  router.push('/probe');
}
</script>

<template>
  <!-- 左侧：跳转卡（最近主机 / 探针）—— 与右侧统计卡左右对称居中 -->
  <div class="home-side home-side-left" @click.stop>
    <button
      type="button"
      class="side-card jump-card"
      :disabled="!recentHost"
      @click="gotoRecentHost"
    >
      <div class="card-head">
        <AppIcon name="recent-host" :size="18" class="card-icon" />
        <span class="card-title">最近主机</span>
        <AppIcon name="arrow-right" :size="14" class="card-arrow" />
      </div>
      <div v-if="recentHost" class="card-body">
        <div class="recent-name">{{ recentHost.name }}</div>
        <div class="recent-host">{{ recentHost.username }}@{{ recentHost.host }}</div>
        <div class="recent-status">
          <span
            class="status-dot"
            :class="recentHostProbe?.online ? 'online' : 'offline'"
          />
          <span class="status-text">
            {{ recentHostProbe?.online ? '在线' : (recentHostProbe ? '离线' : '未探测') }}
          </span>
        </div>
      </div>
      <div v-else class="card-body card-empty">
        <span>还没有 VPS</span>
        <span class="empty-hint">点击去主控添加</span>
      </div>
    </button>

    <button type="button" class="side-card jump-card" @click="gotoProbe">
      <div class="card-head">
        <AppIcon name="radio" :size="18" class="card-icon" />
        <span class="card-title">探针</span>
        <AppIcon name="arrow-right" :size="14" class="card-arrow" />
      </div>
      <div class="card-body probe-body">
        <div class="probe-num">
          <span class="num-online">{{ onlineCount }}</span>
          <span class="num-total">/ {{ totalCount }}</span>
        </div>
        <div class="probe-label">主机在线</div>
      </div>
    </button>
  </div>

  <!-- 右侧：主机总览统计卡 -->
  <div class="home-side home-side-right" @click.stop>
    <div class="side-card stats-card">
      <div class="card-head">
        <AppIcon name="chart" :size="18" class="card-icon" />
        <span class="card-title">主机总览</span>
      </div>

      <div class="stats-row">
        <div class="stat-cell">
          <div class="stat-num">{{ totalCount }}</div>
          <div class="stat-label">总数</div>
        </div>
        <div class="stat-cell">
          <div class="stat-num stat-online">{{ onlineCount }}</div>
          <div class="stat-label">在线</div>
        </div>
        <div class="stat-cell">
          <div class="stat-num" :class="{ 'stat-bad': abnormalCount > 0 }">{{ abnormalCount }}</div>
          <div class="stat-label">异常</div>
        </div>
      </div>

      <div class="stats-divider" />

      <div v-if="abnormalCount > 0" class="abnormal-section">
        <div class="section-title">异常主机</div>
        <ul class="abnormal-list">
          <li
            v-for="h in abnormalHosts.slice(0, 5)"
            :key="h.id"
            class="abnormal-item"
          >
            <span class="abnormal-name">{{ h.name }}</span>
            <span class="abnormal-reason">{{ abnormalReason(h) }}</span>
          </li>
        </ul>
        <div v-if="abnormalCount > 5" class="more-hint">还有 {{ abnormalCount - 5 }} 台 …</div>
      </div>
      <div v-else class="abnormal-section ok-section">
        <span class="ok-icon"><AppIcon name="check" :size="12" :stroke-width="2.4" /></span>
        <span class="ok-text">{{ totalCount > 0 ? '全部主机运行正常' : '暂无主机' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-side {
  position: absolute;
  top: 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 6;
  pointer-events: none;
}
.home-side-left  { left: 24px;  width: 230px; }
.home-side-right { right: 24px; width: 250px; }

/* ── 毛玻璃 ── */
.side-card {
  pointer-events: auto;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 16px;
  /* 浅色：高光 + 主底色叠加，让花瓣透得过 */
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.30) 0%, rgba(255, 255, 255, 0) 40%),
    rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.55) inset,
    0 8px 28px rgba(30, 58, 95, 0.10);
  backdrop-filter: blur(4px) saturate(140%);
  -webkit-backdrop-filter: blur(4px) saturate(140%);
  text-align: left;
  color: #1e293b;
  transition: transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease, background 200ms ease;
}
:global(html.dark .side-card) {
  /* 深色：高光 + 深底色都用 background 叠加，避免伪元素覆盖文字 */
  background:
    linear-gradient(180deg, rgba(96, 165, 250, 0.10) 0%, rgba(139, 92, 246, 0.04) 30%, rgba(96, 165, 250, 0) 55%),
    linear-gradient(180deg, rgba(30, 41, 59, 0.80) 0%, rgba(15, 23, 42, 0.88) 100%);
  border-color: rgba(96, 165, 250, 0.30);
  color: #ffffff;
  box-shadow:
    0 0 0 1px rgba(99, 102, 241, 0.12) inset,
    0 8px 32px rgba(0, 0, 0, 0.5),
    0 0 24px rgba(56, 189, 248, 0.08);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}

.jump-card {
  cursor: pointer;
  font: inherit;
}
.jump-card:hover:not(:disabled) {
  transform: translateY(-2px);
  border-color: rgba(59, 130, 246, 0.55);
  box-shadow: 0 12px 30px rgba(59, 130, 246, 0.18);
}
.jump-card:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.card-icon { font-size: 16px; }
.card-title { flex: 1; }
.card-arrow {
  color: #64748b;
  font-size: 14px;
  transition: transform 160ms ease, color 160ms ease;
}
.jump-card:hover:not(:disabled) .card-arrow {
  color: #3b82f6;
  transform: translateX(2px);
}
:global(html.dark .card-arrow) { color: #ffffff; }

.card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.recent-name {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}
:global(html.dark .recent-name) { color: #ffffff; }
.recent-host {
  font-family: 'Cascadia Code', 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #64748b;
  word-break: break-all;
}
:global(html.dark .recent-host) { color: #ffffff; }
.recent-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.status-dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}
.status-dot.online  { background: #059669; box-shadow: 0 0 8px rgba(5,150,105,0.55); }
.status-dot.offline { background: #dc2626; }
.status-text { font-size: 11px; color: #64748b; }
:global(html.dark .status-text) { color: #ffffff; }

.card-empty {
  font-size: 12px;
  color: #64748b;
}
.empty-hint {
  font-size: 11px;
  color: #94a3b8;
}

.probe-body {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}
.probe-num {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.num-online {
  font-size: 22px;
  font-weight: 800;
  color: #059669;
  font-family: 'Cascadia Code', monospace;
}
.num-total {
  font-size: 13px;
  color: #94a3b8;
  font-family: 'Cascadia Code', monospace;
}
.probe-label {
  font-size: 11px;
  color: #64748b;
}
:global(html.dark .probe-label) { color: #ffffff; }
:global(html.dark .num-online) { color: #ffffff; }
:global(html.dark .num-total) { color: #ffffff; }

/* ── 右侧统计卡 ── */
.stats-card {
  gap: 10px;
}
.stats-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}
.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 4px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.35);
}
:global(html.dark .stat-cell) {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(148, 197, 255, 0.10);
}
.stat-num {
  font-size: 20px;
  font-weight: 800;
  font-family: 'Cascadia Code', monospace;
  color: #1e293b;
  line-height: 1.1;
}
:global(html.dark .stat-num) { color: #ffffff; }
:global(html.dark .stat-num.stat-online) { color: #ffffff; }
.stat-num.stat-online { color: #059669; }
.stat-num.stat-bad    { color: #dc2626; }
.stat-label {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
}
:global(html.dark .stat-label) { color: #ffffff; }

.stats-divider {
  height: 1px;
  background: rgba(148, 163, 184, 0.3);
  margin: 2px 0;
}

.section-title {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 4px;
}
:global(html.dark .section-title) { color: #ffffff; }
:global(html.dark .ok-section) { color: #ffffff; }
.abnormal-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0; padding: 0;
}
.abnormal-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.10);
  border: 1px solid rgba(239, 68, 68, 0.22);
  font-size: 11px;
}
:global(html.dark .abnormal-item) {
  background: rgba(248, 113, 113, 0.10);
  border-color: rgba(248, 113, 113, 0.22);
}
.abnormal-name {
  font-weight: 600;
  color: #b91c1c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:global(html.dark .abnormal-name) { color: #fca5a5; }
.abnormal-reason {
  color: #ef4444;
  flex-shrink: 0;
  font-family: 'Cascadia Code', monospace;
  font-size: 10px;
}
:global(html.dark .abnormal-reason) { color: #fca5a5; }
.more-hint {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 4px;
  text-align: center;
}

.ok-section {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 0 4px;
  font-size: 12px;
  color: #059669;
}
:global(html.dark .ok-section) { color: #ffffff; }
.ok-icon {
  display: inline-flex;
  width: 18px; height: 18px;
  border-radius: 50%;
  background: rgba(5, 150, 105, 0.15);
  align-items: center;
  justify-content: center;
  font-weight: 700;
}

/* 小屏幕收起 */
@media (max-width: 1100px) {
  .home-side { display: none; }
}
</style>

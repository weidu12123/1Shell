<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import { useNotifyStore } from '@/stores/notify';

const PAGE_SIZE = 20;

const ACTION_LABELS: Record<string, string> = {
  bridge_exec: '命令执行',
  script_run: '脚本执行',
  host_create: '新增主机',
  host_update: '更新主机',
  host_delete: '删除主机',
  local_config_update: '本地配置',
  login: '登录',
};

const ACTION_BADGES: Record<string, string> = {
  bridge_exec:         'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
  script_run:          'bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/20',
  host_create:         'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20',
  host_update:         'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  host_delete:         'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20',
  local_config_update: 'bg-cyan-50 text-cyan-600 border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-300 dark:border-cyan-500/20',
  login:               'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20',
};

const DEFAULT_BADGE = 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20';

interface AuditEntry {
  id: number;
  action: string;
  timestamp: string;
  source?: string;
  host_id?: string;
  host_name?: string;
  exit_code?: number | null;
  duration_ms?: number | null;
  command?: string;
  details?: string;
  client_ip?: string;
  error?: string;
}

interface AuditResponse {
  logs: AuditEntry[];
  total: number;
  source: string;
}

interface AuditPrefs {
  action: string;
  source: string;
  host: string;
  keyword: string;
  applied: { action: string; source: string; hostId: string; keyword: string };
  offset: number;
}

interface AuditCache {
  logs: AuditEntry[];
  total: number;
  dataSource: string;
  offset: number;
}

const AUDIT_PREFS_KEY = '1shell.audit.prefs.v1';
const AUDIT_CACHE_KEY = 'audit.page.cache.v1';
const AUDIT_CACHE_TTL_MS = 45_000;

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const savedPrefs = readStorageState<AuditPrefs>(AUDIT_PREFS_KEY, {
  action: '',
  source: '',
  host: '',
  keyword: '',
  applied: { action: '', source: '', hostId: '', keyword: '' },
  offset: 0,
});

// 表单 UI 状态
const filterAction = ref(savedPrefs.action);
const filterSource = ref(savedPrefs.source);
const filterHost = ref(savedPrefs.host);
const filterKeyword = ref(savedPrefs.keyword);

// 实际生效的查询参数（仅在 筛选 / 重置 / Enter / 刷新 时同步）
const appliedFilters = ref(savedPrefs.applied);

const offset = ref(savedPrefs.offset);
const total = ref(0);
const dataSource = ref('--');
const logs = ref<AuditEntry[]>([]);
const loading = ref(false);
const errorText = ref<string | null>(null);

function saveAuditPrefs(): void {
  writeStorageState<AuditPrefs>(AUDIT_PREFS_KEY, {
    action: filterAction.value,
    source: filterSource.value,
    host: filterHost.value,
    keyword: filterKeyword.value,
    applied: appliedFilters.value,
    offset: offset.value,
  });
}

function saveAuditCache(): void {
  setCachedPageState<AuditCache>(AUDIT_CACHE_KEY, {
    logs: logs.value,
    total: total.value,
    dataSource: dataSource.value,
    offset: offset.value,
  });
}

function restoreAuditCache(): boolean {
  const entry = getCachedPageState<AuditCache>(AUDIT_CACHE_KEY);
  if (!entry) return false;
  logs.value = entry.value.logs || [];
  total.value = Number(entry.value.total) || 0;
  dataSource.value = entry.value.dataSource || '--';
  offset.value = Number(entry.value.offset) || 0;
  return true;
}

const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const prevDisabled = computed(() => offset.value <= 0);
const nextDisabled = computed(() => offset.value + PAGE_SIZE >= total.value);

function buildQuery(off: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(off));
  const f = appliedFilters.value;
  if (f.action)  params.set('action', f.action);
  if (f.source)  params.set('source', f.source);
  if (f.hostId)  params.set('hostId', f.hostId);
  if (f.keyword) params.set('keyword', f.keyword);
  return params.toString();
}

async function loadAuditLogs(targetOffset: number = offset.value): Promise<void> {
  offset.value = Math.max(targetOffset, 0);
  loading.value = true;
  errorText.value = null;
  try {
    const resp = await requestJson<AuditResponse>(`/api/audit/logs?${buildQuery(offset.value)}`);
    logs.value = Array.isArray(resp.logs) ? resp.logs : [];
    total.value = Number(resp.total) || 0;
    dataSource.value = resp.source || '--';
    saveAuditPrefs();
    saveAuditCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText.value = msg;
    notify.error(`加载失败：${msg}`, 5000);
    logs.value = [];
  } finally {
    loading.value = false;
  }
}

function collectFilters(): void {
  appliedFilters.value = {
    action: filterAction.value,
    source: filterSource.value,
    hostId: filterHost.value.trim(),
    keyword: filterKeyword.value.trim(),
  };
}

function applyFilters(): void {
  collectFilters();
  loadAuditLogs(0);
}

function resetFilters(): void {
  filterAction.value = '';
  filterSource.value = '';
  filterHost.value = '';
  filterKeyword.value = '';
  appliedFilters.value = { action: '', source: '', hostId: '', keyword: '' };
  loadAuditLogs(0);
}

function refresh(): void {
  collectFilters();
  loadAuditLogs(0);
}

function gotoPrev(): void {
  if (!prevDisabled.value) loadAuditLogs(offset.value - PAGE_SIZE);
}
function gotoNext(): void {
  if (!nextDisabled.value) loadAuditLogs(offset.value + PAGE_SIZE);
}

function onFilterEnter(e: KeyboardEvent): void {
  if (e.key === 'Enter') applyFilters();
}

// ── 格式化辅助 ────────────────────────────────────────

function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action || '未知操作';
}
function badgeClass(action: string): string {
  return ACTION_BADGES[action] || DEFAULT_BADGE;
}
function formatTime(value: string | undefined): string {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}
function formatSource(value: string | undefined): string {
  if (!value) return '--';
  return String(value).replace(/_/g, ' ');
}
function formatExit(entry: AuditEntry): string {
  if (entry.exit_code === null || entry.exit_code === undefined) return '--';
  return String(entry.exit_code);
}
function formatDuration(entry: AuditEntry): string {
  if (entry.duration_ms === null || entry.duration_ms === undefined) return '--';
  return `${entry.duration_ms} ms`;
}
function parseDetails(details: string | undefined): string {
  if (!details) return '';
  try {
    const data: unknown = JSON.parse(details);
    if (data && typeof data === 'object') {
      return Object.entries(data as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ');
    }
  } catch { /* fall through */ }
  return String(details);
}

onMounted(() => {
  const restored = restoreAuditCache();
  if (!restored || !isPageStateFresh(AUDIT_CACHE_KEY, AUDIT_CACHE_TTL_MS)) {
    loadAuditLogs(restored ? offset.value : 0);
  }
});
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <!-- 顶栏 -->
    <header class="topbar shrink-0 h-14 flex items-center px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">
          <AppIcon name="clipboard" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200">审计日志</div>
          <div class="text-[11px] text-slate-400">查看主机操作、脚本执行与配置变更记录</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <button
        type="button"
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-all"
        @click="refresh"
      >
        立即刷新
      </button>
    </header>

    <!-- 主面板 -->
    <main class="main-panel flex-1 min-h-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
      <div class="h-full flex flex-col min-h-0">
        <!-- 筛选栏 -->
        <div class="shrink-0 px-4 pt-4 pb-2 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">操作类型</label>
              <select
                v-model="filterAction"
                class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              >
                <option value="">全部</option>
                <option v-for="(label, key) in ACTION_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">来源</label>
              <select
                v-model="filterSource"
                class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              >
                <option value="">全部</option>
                <option value="web_ui">Web UI</option>
                <option value="bridge_api">Bridge API</option>
                <option value="mcp">MCP</option>
                <option value="script_run">脚本执行</option>
                <option value="socket">Socket</option>
              </select>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">主机</label>
              <input
                v-model="filterHost"
                @keydown="onFilterEnter"
                type="text"
                placeholder="主机名 / ID"
                class="h-8 w-32 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">关键词</label>
              <input
                v-model="filterKeyword"
                @keydown="onFilterEnter"
                type="text"
                placeholder="搜索命令 / 错误 / 详情"
                class="h-8 w-44 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <button
              @click="applyFilters"
              type="button"
              class="h-8 px-4 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-600 transition-colors"
            >筛选</button>
            <button
              @click="resetFilters"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:border-blue-300 dark:hover:text-blue-400 dark:hover:border-blue-400 transition-all"
            >重置</button>
          </div>
        </div>

        <!-- 统计 -->
        <div class="shrink-0 p-4 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">日志总数</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ total }}</div>
            </div>
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">当前页</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ page }} / {{ totalPages }}</div>
            </div>
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">数据源</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ dataSource }}</div>
            </div>
          </div>
        </div>

        <!-- 列表 -->
        <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <div v-if="loading" class="text-xs text-slate-400 text-center py-10">加载中...</div>
          <div v-else-if="errorText" class="text-xs text-rose-500 dark:text-rose-400 text-center py-10">加载失败：{{ errorText }}</div>
          <div v-else-if="logs.length === 0" class="text-xs text-slate-400 text-center py-10">暂无审计记录</div>
          <article
            v-for="entry in logs"
            v-else
            :key="entry.id"
            class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-4 shadow-sm"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded-lg border text-[11px] font-semibold" :class="badgeClass(entry.action)">{{ actionLabel(entry.action) }}</span>
              <span class="text-[11px] text-slate-400">#{{ entry.id }}</span>
              <span class="text-[11px] text-slate-400 ml-auto">{{ formatTime(entry.timestamp) }}</span>
            </div>

            <div class="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">来源</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">{{ formatSource(entry.source) }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">主机</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-all">{{ entry.host_name || entry.host_id || '--' }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">退出码</div>
                <div class="mt-1 font-semibold" :class="entry.error ? 'text-rose-500 dark:text-rose-300' : 'text-slate-700 dark:text-slate-200'">{{ formatExit(entry) }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">耗时</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">{{ formatDuration(entry) }}</div>
              </div>
            </div>

            <div v-if="entry.command" class="mt-3">
              <div class="text-[10px] font-semibold text-slate-400 mb-1">命令</div>
              <pre class="rounded-xl bg-slate-100 dark:bg-slate-900 px-3 py-2 text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all max-h-36 overflow-auto">{{ entry.command }}</pre>
            </div>

            <div v-if="parseDetails(entry.details)" class="mt-3 text-[11px] text-slate-500 dark:text-slate-400 break-all">
              <span class="font-semibold text-slate-400">详情：</span>{{ parseDetails(entry.details) }}
            </div>

            <div v-if="entry.client_ip" class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">客户端 IP：{{ entry.client_ip }}</div>

            <div v-if="entry.error" class="mt-3 rounded-xl border border-rose-200 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-300 break-all">
              {{ entry.error }}
            </div>
          </article>
        </div>

        <!-- 分页 -->
        <div class="shrink-0 px-4 py-3 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between gap-3">
          <div class="text-[11px] text-slate-400">每页 {{ PAGE_SIZE }} 条 · 共 {{ total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button
              @click="gotoPrev"
              :disabled="prevDisabled"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:border-blue-300 enabled:hover:text-blue-500"
            >上一页</button>
            <button
              @click="gotoNext"
              :disabled="nextDisabled"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:border-blue-300 enabled:hover:text-blue-500"
            >下一页</button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

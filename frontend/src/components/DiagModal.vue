<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';

const props = defineProps<{
  hostId: string;
  hostName?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

type DiagKind = 'ping' | 'http' | 'dns';
const activeTab = ref<DiagKind>('ping');
const loading = ref(false);

const pingForm = reactive({ target: '1.1.1.1', count: 4 });
const httpForm = reactive({ url: 'https://www.cloudflare.com/', method: 'GET' as 'GET' | 'HEAD' });
const dnsForm = reactive({ name: 'www.cloudflare.com' });

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface PingParsed {
  samples: number[];
  transmitted: number | null;
  received: number | null;
  lossPercent: number | null;
  rttMinMs: number | null;
  rttAvgMs: number | null;
  rttMaxMs: number | null;
}

interface HttpParsed {
  statusCode: number | null;
  nameLookupMs: number | null;
  connectMs: number | null;
  firstByteMs: number | null;
  totalMs: number | null;
  sizeBytes: number | null;
}

interface DnsParsed { records: string[] }

interface DiagResult<TParsed> {
  ok: boolean;
  kind: DiagKind;
  exec: ExecResult;
  parsed: TParsed;
  // 其他字段透传
  [key: string]: unknown;
}

const result = ref<DiagResult<PingParsed | HttpParsed | DnsParsed> | null>(null);

async function runPing(): Promise<void> {
  loading.value = true;
  try {
    const r = await requestJson<DiagResult<PingParsed>>(`/api/probe-diag/${encodeURIComponent(props.hostId)}/ping`, {
      method: 'POST',
      body: JSON.stringify({ target: pingForm.target, count: pingForm.count }),
    });
    result.value = r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`Ping 失败：${msg}`, 5000);
  } finally {
    loading.value = false;
  }
}

async function runHttp(): Promise<void> {
  loading.value = true;
  try {
    const r = await requestJson<DiagResult<HttpParsed>>(`/api/probe-diag/${encodeURIComponent(props.hostId)}/http`, {
      method: 'POST',
      body: JSON.stringify({ url: httpForm.url, method: httpForm.method }),
    });
    result.value = r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`HTTP 探活失败：${msg}`, 5000);
  } finally {
    loading.value = false;
  }
}

async function runDns(): Promise<void> {
  loading.value = true;
  try {
    const r = await requestJson<DiagResult<DnsParsed>>(`/api/probe-diag/${encodeURIComponent(props.hostId)}/dns`, {
      method: 'POST',
      body: JSON.stringify({ name: dnsForm.name }),
    });
    result.value = r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify.error(`DNS 查询失败：${msg}`, 5000);
  } finally {
    loading.value = false;
  }
}

function run(): void {
  result.value = null;
  if (activeTab.value === 'ping') runPing();
  else if (activeTab.value === 'http') runHttp();
  else runDns();
}

function switchTab(tab: DiagKind): void {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  result.value = null;
}

function asPing(r: typeof result.value): DiagResult<PingParsed> | null {
  return r && r.kind === 'ping' ? r as DiagResult<PingParsed> : null;
}
function asHttp(r: typeof result.value): DiagResult<HttpParsed> | null {
  return r && r.kind === 'http' ? r as DiagResult<HttpParsed> : null;
}
function asDns(r: typeof result.value): DiagResult<DnsParsed> | null {
  return r && r.kind === 'dns' ? r as DiagResult<DnsParsed> : null;
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" @click.self="emit('close')">
    <div class="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
      <div class="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <div class="text-sm font-bold text-slate-800 dark:text-slate-100">网络诊断 · {{ hostName || hostId }}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">通过 1Shell SSH 通道在目标主机执行 ping / curl / DNS 查询。</div>
        </div>
        <button type="button" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" @click="emit('close')">✕</button>
      </div>

      <div class="px-5 pt-4">
        <div class="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-800">
          <button
            v-for="tab in (['ping','http','dns'] as DiagKind[])"
            :key="tab"
            type="button"
            class="px-3 py-1 text-xs font-semibold rounded-md transition-all"
            :class="activeTab === tab
              ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'"
            @click="switchTab(tab)"
          >{{ tab === 'ping' ? 'Ping' : tab === 'http' ? 'HTTP' : 'DNS' }}</button>
        </div>
      </div>

      <div class="p-5 space-y-4">
        <!-- Ping 表单 -->
        <div v-if="activeTab === 'ping'" class="space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-[1fr,90px,auto] gap-2">
            <input v-model="pingForm.target" placeholder="目标主机名或 IP（例如 1.1.1.1）" class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" />
            <input v-model.number="pingForm.count" type="number" min="1" max="20" placeholder="次数" class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" />
            <button type="button" :disabled="loading || !pingForm.target" class="h-9 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50" @click="run">{{ loading ? '执行中...' : '执行 Ping' }}</button>
          </div>
          <div v-if="asPing(result)" class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="probe-stat"><span class="probe-stat-label">发送/接收</span><span class="probe-stat-value">{{ asPing(result)!.parsed.transmitted ?? '--' }} / {{ asPing(result)!.parsed.received ?? '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">丢包率</span><span class="probe-stat-value">{{ asPing(result)!.parsed.lossPercent !== null ? `${asPing(result)!.parsed.lossPercent}%` : '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">RTT 平均</span><span class="probe-stat-value">{{ asPing(result)!.parsed.rttAvgMs !== null ? `${asPing(result)!.parsed.rttAvgMs} ms` : '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">RTT 最大</span><span class="probe-stat-value">{{ asPing(result)!.parsed.rttMaxMs !== null ? `${asPing(result)!.parsed.rttMaxMs} ms` : '--' }}</span></div>
          </div>
        </div>

        <!-- HTTP 表单 -->
        <div v-if="activeTab === 'http'" class="space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-[1fr,90px,auto] gap-2">
            <input v-model="httpForm.url" placeholder="https://example.com/" class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" />
            <select v-model="httpForm.method" class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200">
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
            <button type="button" :disabled="loading || !httpForm.url" class="h-9 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50" @click="run">{{ loading ? '执行中...' : '执行 HTTP' }}</button>
          </div>
          <div v-if="asHttp(result)" class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <div class="probe-stat"><span class="probe-stat-label">HTTP 状态码</span><span class="probe-stat-value">{{ asHttp(result)!.parsed.statusCode ?? '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">DNS 解析</span><span class="probe-stat-value">{{ asHttp(result)!.parsed.nameLookupMs !== null ? `${asHttp(result)!.parsed.nameLookupMs} ms` : '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">TCP 连接</span><span class="probe-stat-value">{{ asHttp(result)!.parsed.connectMs !== null ? `${asHttp(result)!.parsed.connectMs} ms` : '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">首字节</span><span class="probe-stat-value">{{ asHttp(result)!.parsed.firstByteMs !== null ? `${asHttp(result)!.parsed.firstByteMs} ms` : '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">总耗时</span><span class="probe-stat-value">{{ asHttp(result)!.parsed.totalMs !== null ? `${asHttp(result)!.parsed.totalMs} ms` : '--' }}</span></div>
            <div class="probe-stat"><span class="probe-stat-label">响应大小</span><span class="probe-stat-value">{{ asHttp(result)!.parsed.sizeBytes ?? '--' }} B</span></div>
          </div>
        </div>

        <!-- DNS 表单 -->
        <div v-if="activeTab === 'dns'" class="space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-[1fr,auto] gap-2">
            <input v-model="dnsForm.name" placeholder="要解析的主机名（例如 www.cloudflare.com）" class="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200" />
            <button type="button" :disabled="loading || !dnsForm.name" class="h-9 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50" @click="run">{{ loading ? '执行中...' : '执行 DNS' }}</button>
          </div>
          <div v-if="asDns(result)" class="text-xs">
            <div class="text-slate-500 dark:text-slate-400 mb-1">解析到 {{ asDns(result)!.parsed.records.length }} 条记录</div>
            <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-3 font-mono text-slate-700 dark:text-slate-200">
              <div v-if="asDns(result)!.parsed.records.length === 0" class="text-slate-400">无记录</div>
              <div v-else v-for="r in asDns(result)!.parsed.records" :key="r">{{ r }}</div>
            </div>
          </div>
        </div>

        <!-- 原始 stdout / stderr -->
        <div v-if="result" class="space-y-2">
          <div class="flex items-center gap-3 text-[11px] text-slate-400">
            <span>exit {{ result.exec.exitCode }}</span>
            <span>耗时 {{ result.exec.durationMs }} ms</span>
          </div>
          <pre class="max-h-48 overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 text-slate-100 p-3 text-[11px] leading-relaxed">{{ result.exec.stdout || result.exec.stderr || '无输出' }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

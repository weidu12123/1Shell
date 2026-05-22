<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import type { ActiveRun, EventEntry, HostInfo, ProgramInfo, RenderResultEntry, RunRecord } from '@/utils/programs';
import reactSource from '../../../node_modules/react/umd/react.development.js?raw';
import reactDomSource from '../../../node_modules/react-dom/umd/react-dom.development.js?raw';
import babelSource from '../../../node_modules/@babel/standalone/babel.js?raw';

interface UiArtifactValidation {
  ok: boolean;
  status: string;
  issues: string[];
  warnings: string[];
}

interface UiArtifactPreviewCheck {
  ok: boolean;
  status: string;
  mode: string;
  issues: string[];
  warnings: string[];
  checks: Array<{ name: string; ok: boolean; message: string; details?: Record<string, unknown> }>;
}

interface UiArtifactResponse {
  ok: boolean;
  error?: string;
  manifest?: Record<string, unknown> | null;
  entry?: string | null;
  styles?: Array<{ path: string; content: string }>;
  design?: string;
  validation?: UiArtifactValidation;
  previewCheck?: UiArtifactPreviewCheck;
  snapshot?: Record<string, unknown>;
}

const props = defineProps<{
  program: ProgramInfo;
  hosts: HostInfo[];
  activeRuns: ActiveRun[];
  resultEntries: RenderResultEntry[];
  eventEntries: EventEntry[];
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const { requestJson } = useApiClient();
const { confirm } = useConfirm();
const artifact = ref<UiArtifactResponse | null>(null);
const loading = ref(false);
const errors = ref<string[]>([]);
const runtimeErrors = ref<string[]>([]);
const iframeRef = ref<HTMLIFrameElement | null>(null);
const iframeSeq = ref(0);

const previewPassed = computed(() => artifact.value?.previewCheck?.ok !== false);
const hasArtifact = computed(() => artifact.value?.validation?.ok && previewPassed.value && artifact.value.entry);
const artifactIssues = computed(() => [
  ...(artifact.value?.validation?.issues || []),
  ...(artifact.value?.previewCheck?.issues || []),
]);
const previewChecks = computed(() => artifact.value?.previewCheck?.checks || []);
const srcdoc = computed(() => {
  if (!hasArtifact.value || !artifact.value) return '';
  const styles = (artifact.value.styles || []).map((item) => item.content).join('\n\n');
  const snapshot = JSON.stringify(artifact.value.snapshot || {});
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${escapeStyle(styles)}</style>
</head>
<body>
<div id="root"></div>
<script>${safeScript(reactSource)}<\/script>
<script>${safeScript(reactDomSource)}<\/script>
<script>${safeScript(babelSource)}<\/script>
<script>${bridgeClientSource(snapshot)}<\/script>
<script type="text/babel" data-presets="env,react">${safeScript(artifact.value.entry || '')}<\/script>
</body>
</html>`;
});

watch(() => props.program.id, () => loadArtifact(), { immediate: true });
watch(() => [props.activeRuns, props.resultEntries, props.eventEntries], () => {
  postEvent('runs', props.activeRuns);
  postEvent('results', props.resultEntries);
  postEvent('events', props.eventEntries);
}, { deep: true });

window.addEventListener('message', handleMessage);
onBeforeUnmount(() => window.removeEventListener('message', handleMessage));

async function loadArtifact(): Promise<void> {
  loading.value = true;
  errors.value = [];
  runtimeErrors.value = [];
  artifact.value = null;
  try {
    artifact.value = await requestJson<UiArtifactResponse>(`/api/programs/${encodeURIComponent(props.program.id)}/ui/artifact`);
  } catch (err) {
    errors.value = [(err as Error).message || '加载 UI artifact 失败'];
  } finally {
    loading.value = false;
  }
}

function safeScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

function escapeStyle(source: string): string {
  return source.replace(/<\/style/gi, '<\\/style');
}

function bridgeClientSource(snapshot: string): string {
  return `
window.__ONE_SHELL_SNAPSHOT__ = ${snapshot};
(function () {
  var pending = new Map();
  var subscribers = new Map();
  var requestSeq = 0;
  function send(method, args) {
    requestSeq += 1;
    var id = 'bridge_' + requestSeq;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({ source: 'program-artifact', id: id, method: method, args: args || [] }, '*');
    });
  }
  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.source !== 'oneshell-host') return;
    if (msg.type === 'response') {
      var item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.ok) item.resolve(msg.result);
      else item.reject(new Error(msg.error || 'bridge call failed'));
    } else if (msg.type === 'event') {
      var handlers = subscribers.get(msg.eventName) || [];
      handlers.forEach(function (handler) {
        try { handler(msg.payload); } catch (err) { console.error(err); }
      });
    }
  });
  var originalError = console.error;
  console.error = function () {
    try { window.parent.postMessage({ source: 'program-artifact', method: 'artifact:error', args: [Array.prototype.join.call(arguments, ' ')] }, '*'); } catch (err) {}
    return originalError.apply(console, arguments);
  };
  window.onerror = function (message, file, line, col) {
    window.parent.postMessage({ source: 'program-artifact', method: 'artifact:error', args: [String(message) + ' @ ' + line + ':' + col] }, '*');
  };
  window.onunhandledrejection = function (event) {
    window.parent.postMessage({ source: 'program-artifact', method: 'artifact:error', args: [event.reason && event.reason.message ? event.reason.message : String(event.reason)] }, '*');
  };
  window.$oneShell = {
    useProgram: function () { return window.__ONE_SHELL_SNAPSHOT__; },
    runAction: function (actionName, request) { return send('runAction', [actionName, request]); },
    getRuns: function (query) { return send('getRuns', [query || {}]); },
    getResults: function (query) { return send('getResults', [query || {}]); },
    getEvents: function (query) { return send('getEvents', [query || {}]); },
    requestL2Help: function (request) { return send('requestL2Help', [request || {}]); },
    requestL3Escalation: function (request) { return send('requestL3Escalation', [request || {}]); },
    subscribe: function (eventName, handler) {
      var list = subscribers.get(eventName) || [];
      list.push(handler);
      subscribers.set(eventName, list);
      return function () { subscribers.set(eventName, (subscribers.get(eventName) || []).filter(function (item) { return item !== handler; })); };
    }
  };
})();`;
}

async function handleMessage(event: MessageEvent): Promise<void> {
  const msg = event.data as { source?: string; id?: string; method?: string; args?: unknown[] };
  if (!msg || msg.source !== 'program-artifact') return;
  if (msg.method === 'artifact:error') {
    const text = String(msg.args?.[0] || 'artifact runtime error');
    runtimeErrors.value = [text, ...runtimeErrors.value].slice(0, 8);
    return;
  }
  if (!msg.id || !msg.method) return;
  try {
    const result = await callBridge(msg.method, msg.args || []);
    respond(msg.id, true, result);
  } catch (err) {
    respond(msg.id, false, null, (err as Error).message || 'bridge call failed');
  }
}

async function callBridge(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'runAction': return runAction(String(args[0] || ''), (args[1] || {}) as Record<string, unknown>);
    case 'getRuns': return getRuns((args[0] || {}) as Record<string, unknown>);
    case 'getResults': return getResults((args[0] || {}) as Record<string, unknown>);
    case 'getEvents': return getEvents((args[0] || {}) as Record<string, unknown>);
    case 'requestL2Help': throw new Error('L2 请求入口尚未接入宿主流程');
    case 'requestL3Escalation': throw new Error('L3 升级只能通过宿主策略触发');
    default: throw new Error(`未知 bridge 方法: ${method}`);
  }
}

async function runAction(actionName: string, request: Record<string, unknown>): Promise<unknown> {
  try {
    const result = await requestJson(`/api/programs/${encodeURIComponent(props.program.id)}/actions/${encodeURIComponent(actionName)}/run`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    emit('refresh');
    return result;
  } catch (err) {
    const body = err instanceof ApiError && err.body && typeof err.body === 'object' ? err.body as { requiresConfirm?: boolean; confirmText?: string } : null;
    if (!body?.requiresConfirm) throw err;
    const ok = await confirm({ title: '确认执行 Program Action', message: body.confirmText || `确认执行 ${actionName}？`, okText: '确认执行' });
    if (!ok) throw new Error('用户取消执行');
    const result = await requestJson(`/api/programs/${encodeURIComponent(props.program.id)}/actions/${encodeURIComponent(actionName)}/run`, {
      method: 'POST',
      body: JSON.stringify({ ...request, confirmToken: `confirmed:${props.program.id}:${actionName}` }),
    });
    emit('refresh');
    return result;
  }
}

async function getRuns(query: Record<string, unknown>): Promise<RunRecord[]> {
  const limit = Number(query.limit) || 50;
  const data = await requestJson<{ runs?: RunRecord[] }>(`/api/programs/${encodeURIComponent(props.program.id)}/runs?limit=${encodeURIComponent(String(limit))}`);
  return data.runs || [];
}

async function getResults(query: Record<string, unknown>): Promise<unknown[]> {
  const limit = Number(query.limit) || 50;
  const data = await requestJson<{ results?: unknown[] }>(`/api/programs/${encodeURIComponent(props.program.id)}/results?limit=${encodeURIComponent(String(limit))}`);
  return (data.results || []).slice(0, limit);
}

async function getEvents(_query: Record<string, unknown>): Promise<EventEntry[]> {
  return props.eventEntries;
}

function respond(id: string, ok: boolean, result?: unknown, error?: string): void {
  iframeRef.value?.contentWindow?.postMessage({ source: 'oneshell-host', type: 'response', id, ok, result, error }, '*');
}

function postEvent(eventName: string, payload: unknown): void {
  iframeRef.value?.contentWindow?.postMessage({ source: 'oneshell-host', type: 'event', eventName, payload }, '*');
}

function refreshArtifact(): void {
  iframeSeq.value += 1;
  loadArtifact();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-slate-50/60 dark:bg-slate-950/20">
    <div class="shrink-0 border-b border-slate-100 px-5 py-3 dark:border-[#1e293b]">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200">Program Artifact Host</div>
            <span
              v-if="artifact?.previewCheck"
              class="rounded-full px-2 py-0.5 text-[10px] font-bold"
              :class="artifact.previewCheck.ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'"
            >preview {{ artifact.previewCheck.status }}</span>
          </div>
          <div class="text-[11px] text-slate-400">data/programs/{{ program.id }}/ui · sandbox iframe · bridge API</div>
        </div>
        <button class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-blue-300 hover:text-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" @click="refreshArtifact">刷新 artifact</button>
      </div>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center text-sm text-slate-400">正在加载 UI artifact...</div>

    <div v-else-if="errors.length || !artifact" class="m-5 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
      <div class="font-bold">UI artifact 加载失败</div>
      <ul class="mt-2 list-disc pl-5"><li v-for="err in errors" :key="err">{{ err }}</li></ul>
    </div>

    <div v-else-if="!hasArtifact" class="m-5 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
      <div class="font-bold">该 Program 还没有可运行的 UI artifact</div>
      <div class="mt-1 text-xs opacity-80">需要 ui/manifest.json、App.jsx、style.css、DESIGN.md，并通过 artifact validator 与 sandbox preview-check。</div>
      <ul class="mt-3 list-disc pl-5">
        <li v-for="issue in artifactIssues.length ? artifactIssues : ['artifact 缺失']" :key="issue">{{ issue }}</li>
      </ul>
      <div v-if="previewChecks.length" class="mt-4 grid gap-2 text-xs">
        <div
          v-for="check in previewChecks"
          :key="check.name"
          class="rounded-lg border px-3 py-2"
          :class="check.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300'"
        >
          <span class="font-bold">{{ check.name }}</span> · {{ check.message }}
        </div>
      </div>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col">
      <iframe
        :key="`${program.id}-${iframeSeq}`"
        ref="iframeRef"
        class="min-h-0 flex-1 border-0 bg-transparent"
        sandbox="allow-scripts"
        :srcdoc="srcdoc"
      />
      <div v-if="runtimeErrors.length" class="shrink-0 border-t border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
        <div class="font-bold">Artifact Runtime Error</div>
        <ul class="mt-1 list-disc pl-5"><li v-for="err in runtimeErrors" :key="err">{{ err }}</li></ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import {
  CATEGORY_ICONS,
  RISK_BADGES,
  debounce,
  isEmojiIcon,
  type HostInfo,
  type PreviewResponse,
  type RunBatchResponse,
  type RunSingleResponse,
  type ScriptInfo,
} from '@/utils/scripts';

interface Props {
  open: boolean;
  script: ScriptInfo | null;
  hosts: HostInfo[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  ran: [scriptId: string, runs: number];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const paramValues = ref<Record<string, string>>({});
const selectedHostIds = ref<string[]>(['local']);
const riskConfirmed = ref(false);
const previewText = ref('（等待预览）');
const warnings = ref<string[]>([]);
const resultMeta = ref('');
const results = ref<RunSingleResponse[]>([]);
const showResults = ref(false);
const running = ref(false);
const lastScriptId = ref<string | null>(null);

const riskBadge = computed(() => props.script ? RISK_BADGES[props.script.riskLevel] : RISK_BADGES.safe);
const headerIcon = computed(() => {
  if (!props.script) return 'terminal';
  return props.script.icon || CATEGORY_ICONS[props.script.category] || 'terminal';
});
const subtitle = computed(() => {
  if (!props.script) return '';
  const n = (props.script.parameters || []).length;
  return n > 0 ? `填写 ${n} 个参数并选择目标主机` : '选择目标主机';
});
const needConfirm = computed(() => props.script && props.script.riskLevel !== 'safe');
const hostOptions = computed<HostInfo[]>(() => {
  const list: HostInfo[] = [{ id: 'local', name: '🖥 本机（1Shell 宿主）' }];
  for (const h of props.hosts) {
    if (h.id === 'local') continue;
    list.push(h);
  }
  return list;
});

function resetForNewScript(): void {
  const s = props.script;
  if (!s) return;
  paramValues.value = {};
  for (const p of s.parameters || []) {
    paramValues.value[p.name] = p.default != null ? String(p.default) : '';
  }
  selectedHostIds.value = ['local'];
  riskConfirmed.value = false;
  showResults.value = false;
  results.value = [];
  resultMeta.value = '';
  warnings.value = [];
  previewText.value = '（等待预览）';
}

async function refreshPreview(): Promise<void> {
  if (!props.script || !props.script.id) return;
  const hostId = selectedHostIds.value[0] || 'local';
  try {
    const resp = await requestJson<PreviewResponse>(`/api/scripts/${encodeURIComponent(props.script.id)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ hostId, params: paramValues.value }),
    });
    previewText.value = resp.renderedCommand || '（空）';
    warnings.value = resp.warnings || [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    previewText.value = `预览失败: ${msg}`;
    warnings.value = [];
  }
}

const debouncedRefresh = debounce(() => { void refreshPreview(); }, 400);

function onParamInput(): void {
  debouncedRefresh();
}

function selectAllHosts(): void {
  selectedHostIds.value = hostOptions.value.map((h) => h.id);
}
function selectNoneHosts(): void {
  selectedHostIds.value = [];
}

async function onExecute(): Promise<void> {
  if (!props.script) return;
  if (needConfirm.value && !riskConfirmed.value) {
    notify.warn('请勾选风险确认复选框');
    return;
  }
  if (selectedHostIds.value.length === 0) {
    notify.warn('请至少选择一台主机');
    return;
  }

  const hostIds = [...selectedHostIds.value];
  const isBatch = hostIds.length > 1;

  running.value = true;
  showResults.value = true;
  results.value = [];
  resultMeta.value = '正在运行...';

  try {
    let list: RunSingleResponse[];
    if (isBatch) {
      const resp = await requestJson<RunBatchResponse>(
        `/api/scripts/${encodeURIComponent(props.script.id)}/run-batch`,
        { method: 'POST', body: JSON.stringify({ hostIds, params: paramValues.value, confirmed: true }) },
      );
      resultMeta.value = `共 ${resp.total} 台 · ✅ ${resp.success} 成功 · ❌ ${resp.failed} 失败`;
      list = resp.results || [];
    } else {
      const resp = await requestJson<RunSingleResponse>(
        `/api/scripts/${encodeURIComponent(props.script.id)}/run`,
        { method: 'POST', body: JSON.stringify({ hostId: hostIds[0], params: paramValues.value, confirmed: true }) },
      );
      list = [{ hostId: hostIds[0], ...resp, ok: true }];
      const icon = resp.status === 'success' ? '✅' : '❌';
      resultMeta.value = `${icon} exit=${resp.exitCode} · ${resp.durationMs}ms`;
    }

    results.value = list;
    const successCount = list.filter((r) => r.ok && r.status === 'success').length;
    if (successCount === list.length) {
      notify.success(isBatch ? `全部 ${successCount} 台执行成功` : '执行成功');
    } else if (successCount > 0) {
      notify.warn(`${successCount}/${list.length} 台成功`);
    } else {
      notify.error(`${successCount}/${list.length} 台成功`, 5000);
    }
    emit('ran', props.script.id, list.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    resultMeta.value = '❌ 执行失败';
    results.value = [];
    notify.error(msg, 5000);
  } finally {
    running.value = false;
  }
}

function statusIcon(r: RunSingleResponse): string {
  return r.ok && r.status === 'success' ? '🟢' : '🔴';
}

function metaOf(r: RunSingleResponse): string {
  return [
    r.exitCode != null ? `exit=${r.exitCode}` : '',
    r.durationMs != null ? `${r.durationMs}ms` : '',
    r.runId != null ? `#${r.runId}` : '',
  ].filter(Boolean).join(' · ');
}

function close(): void {
  emit('update:open', false);
}

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

watch(() => props.open, async (v) => {
  if (!v) return;
  const s = props.script;
  if (!s) return;
  // 12.3 决策：脚本切换才重置；同一脚本重新打开保留 state
  if (lastScriptId.value !== s.id) {
    lastScriptId.value = s.id;
    resetForNewScript();
  }
  await nextTick();
  void refreshPreview();
});

watch(selectedHostIds, () => {
  if (props.open) void refreshPreview();
});
</script>

<template>
  <div
    v-if="open && script"
    class="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
    @click="onBackdropClick"
  >
    <div class="w-full max-w-2xl max-h-[calc(100vh-32px)] bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-[#1e293b] flex flex-col overflow-hidden">
      <!-- 头部 -->
      <div class="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="flex items-center gap-2 min-w-0">
          <span v-if="isEmojiIcon(headerIcon)" class="text-lg">{{ headerIcon }}</span>
          <AppIcon v-else :name="headerIcon" :size="18" class="text-slate-500 dark:text-slate-300" />
          <div class="min-w-0">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{{ script.name }}</div>
            <div class="text-[10px] text-slate-400">{{ subtitle }}</div>
          </div>
          <span class="shrink-0 text-[9px] px-1.5 py-0.5 rounded border" :class="riskBadge.cls">{{ riskBadge.text }}</span>
        </div>
        <button type="button" class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:text-red-500 hover:border-red-200" @click="close">关闭</button>
      </div>

      <!-- 表单区 -->
      <div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
        <!-- 目标主机 -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">目标主机</label>
            <div class="flex items-center gap-1.5">
              <button type="button" class="text-[10px] text-purple-500 hover:underline" @click="selectAllHosts">全选</button>
              <span class="text-slate-300">|</span>
              <button type="button" class="text-[10px] text-slate-400 hover:underline" @click="selectNoneHosts">取消全选</button>
            </div>
          </div>
          <select
            v-model="selectedHostIds"
            multiple
            size="4"
            class="h-auto min-h-[72px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
          >
            <option v-for="h in hostOptions" :key="h.id" :value="h.id">
              {{ h.name }}<span v-if="h.host"> ({{ h.host }})</span>
            </option>
          </select>
          <div class="text-[10px] text-slate-400">按住 Ctrl / Cmd 可多选，选中多台将批量执行</div>
        </div>

        <!-- 参数表单 -->
        <div v-if="(script.parameters || []).length > 0" class="flex flex-col gap-2">
          <div
            v-for="def in script.parameters"
            :key="def.name"
            class="flex flex-col gap-1"
          >
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
              {{ def.label || def.name }}
              <span class="font-mono normal-case text-[9px] text-slate-400" v-text="'{{' + def.name + '}}'"></span>
              <span v-if="def.required" class="text-red-500">*</span>
            </label>
            <select
              v-if="def.type === 'boolean'"
              v-model="paramValues[def.name]"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
              @change="onParamInput"
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
            <select
              v-else-if="def.type === 'select'"
              v-model="paramValues[def.name]"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
              @change="onParamInput"
            >
              <option v-for="o in (def.options || [])" :key="o.value" :value="o.value">{{ o.label || o.value }}</option>
            </select>
            <input
              v-else
              v-model="paramValues[def.name]"
              :type="def.type === 'number' ? 'number' : 'text'"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
              @input="onParamInput"
            />
          </div>
        </div>

        <!-- 预览 -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">命令预览</label>
            <button type="button" class="text-[10px] text-purple-500 hover:underline" @click="refreshPreview">🔄 刷新预览</button>
          </div>
          <pre class="px-3 py-2 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] whitespace-pre-wrap break-all max-h-40 overflow-auto min-h-[48px]">{{ previewText }}</pre>
        </div>

        <!-- 警告 -->
        <div v-if="warnings.length > 0" class="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-400 text-[11px]">
          <div v-for="(w, i) in warnings" :key="i">⚠ {{ w }}</div>
        </div>

        <!-- 结果区 -->
        <div v-if="showResults" class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">执行结果</label>
            <div class="text-[10px] text-slate-400">{{ resultMeta }}</div>
          </div>
          <div class="flex flex-col gap-2 max-h-80 overflow-y-auto">
            <div v-if="results.length === 0 && running" class="text-xs text-slate-400 py-2">正在运行...</div>
            <div
              v-for="(r, i) in results"
              :key="i"
              class="rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] overflow-hidden"
            >
              <div class="flex items-center gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 text-[11px]">
                <span>{{ statusIcon(r) }}</span>
                <span class="font-semibold text-slate-700 dark:text-slate-200">{{ r.hostName || r.hostId || '' }}</span>
                <span class="ml-auto text-slate-400">{{ metaOf(r) }}</span>
              </div>
              <pre v-if="r.stdout" class="px-3 py-1.5 bg-slate-900 text-emerald-300 font-mono text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-auto">{{ r.stdout }}</pre>
              <pre v-if="r.stderr" class="px-3 py-1.5 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300 font-mono text-[10px] whitespace-pre-wrap break-all max-h-20 overflow-auto">{{ r.stderr }}</pre>
              <div v-if="r.error && !r.stderr" class="px-3 py-1.5 text-[10px] text-red-500">{{ r.error }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部 -->
      <div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] bg-slate-50/50 dark:bg-slate-800/30">
        <label v-if="needConfirm" class="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 mr-auto">
          <input v-model="riskConfirmed" type="checkbox" class="accent-amber-500" />
          我已确认执行该脚本的风险
        </label>
        <button type="button" class="h-8 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:border-slate-400" @click="close">取消</button>
        <button
          type="button"
          :disabled="running"
          class="h-8 px-4 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
          @click="onExecute"
        >{{ running ? '执行中...' : '▶ 执行' }}</button>
      </div>
    </div>
  </div>
</template>

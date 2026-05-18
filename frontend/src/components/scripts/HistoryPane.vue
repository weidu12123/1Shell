<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { PAGE_SIZE_HISTORY, type RunHistoryEntry, type RunHistoryResponse } from '@/utils/scripts';

const emit = defineEmits<{
  back: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const runs = ref<RunHistoryEntry[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const errorText = ref<string | null>(null);

const page = computed(() => Math.floor(offset.value / PAGE_SIZE_HISTORY) + 1);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE_HISTORY)));
const prevDisabled = computed(() => offset.value <= 0);
const nextDisabled = computed(() => offset.value + PAGE_SIZE_HISTORY >= total.value);

async function load(targetOffset = 0): Promise<void> {
  const off = Math.max(targetOffset, 0);
  offset.value = off;
  loading.value = true;
  errorText.value = null;
  try {
    const resp = await requestJson<RunHistoryResponse>(`/api/script-runs?limit=${PAGE_SIZE_HISTORY}&offset=${off}`);
    runs.value = Array.isArray(resp.runs) ? resp.runs : [];
    total.value = Number(resp.total) || 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText.value = msg;
    notify.error(`加载历史失败：${msg}`, 5000);
    runs.value = [];
  } finally {
    loading.value = false;
  }
}

function statusIcon(s: RunHistoryEntry['status']): string {
  if (s === 'success') return '🟢';
  if (s === 'running') return '🟡';
  return '🔴';
}

function truncate(text: string | undefined, max = 2000): string {
  if (!text) return '';
  return text.length > max ? text.substring(0, max) : text;
}

function gotoPrev(): void { if (!prevDisabled.value) load(offset.value - PAGE_SIZE_HISTORY); }
function gotoNext(): void { if (!nextDisabled.value) load(offset.value + PAGE_SIZE_HISTORY); }

onMounted(() => { load(0); });
defineExpose({ reload: () => load(offset.value) });
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <div class="shrink-0 px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
      <div class="flex items-center gap-2">
        <AppIcon name="history" :size="18" class="text-slate-500 dark:text-slate-300" />
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">全局执行历史</div>
      </div>
      <button
        type="button"
        class="h-7 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:border-purple-300 hover:text-purple-500"
        @click="emit('back')"
      >← 返回脚本列表</button>
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      <div v-if="loading" class="text-center text-slate-400 text-xs py-8">加载中...</div>
      <div v-else-if="errorText" class="text-center text-red-400 text-xs py-8">加载失败: {{ errorText }}</div>
      <div v-else-if="runs.length === 0" class="text-center text-slate-400 text-xs py-12">暂无执行记录</div>
      <template v-else>
        <div
          v-for="run in runs"
          :key="run.runId"
          class="p-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] mb-2"
        >
          <div class="flex items-center gap-2 text-xs flex-wrap">
            <span>{{ statusIcon(run.status) }}</span>
            <span class="font-semibold text-slate-700 dark:text-slate-200 truncate">{{ run.scriptName || run.scriptId }}</span>
            <span class="text-slate-400">→</span>
            <span class="text-slate-500 dark:text-slate-400">{{ run.hostName || run.hostId }}</span>
            <span class="ml-auto text-[10px] text-slate-400 shrink-0">
              {{ run.startedAt || '' }}
              <template v-if="run.exitCode != null"> · exit={{ run.exitCode }}</template>
              <template v-if="run.durationMs != null"> · {{ run.durationMs }}ms</template>
            </span>
          </div>
          <pre
            v-if="run.renderedCommand"
            class="mt-1.5 px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-mono text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-all max-h-16 overflow-auto"
          >{{ run.renderedCommand }}</pre>
          <pre
            v-if="run.stdout"
            class="mt-1 px-2 py-1 rounded bg-slate-900 text-emerald-300 text-[10px] font-mono whitespace-pre-wrap break-all max-h-24 overflow-auto"
          >{{ truncate(run.stdout) }}</pre>
          <div v-if="run.error" class="mt-1 text-[10px] text-red-500">{{ run.error }}</div>
        </div>
      </template>
    </div>

    <div class="shrink-0 px-4 py-2 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between text-[10px] text-slate-400">
      <span>共 {{ total }} 条记录</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          :disabled="prevDisabled"
          class="px-2 py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:border-purple-300 disabled:opacity-50 disabled:cursor-not-allowed"
          @click="gotoPrev"
        >上一页</button>
        <span>{{ page }} / {{ totalPages }}</span>
        <button
          type="button"
          :disabled="nextDisabled"
          class="px-2 py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:border-purple-300 disabled:opacity-50 disabled:cursor-not-allowed"
          @click="gotoNext"
        >下一页</button>
      </div>
    </div>
  </div>
</template>

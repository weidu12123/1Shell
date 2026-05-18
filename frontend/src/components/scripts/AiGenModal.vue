<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import type { AiGenerateResponse, ScriptInfo } from '@/utils/scripts';

interface Props {
  open: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  generated: [script: Partial<ScriptInfo>];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const prompt = ref('');
const status = ref('');
const statusKind = ref<'info' | 'error'>('info');
const submitting = ref(false);
const promptRef = ref<HTMLTextAreaElement | null>(null);

function close(): void {
  emit('update:open', false);
}

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

async function onSubmit(): Promise<void> {
  const text = prompt.value.trim();
  if (!text) {
    notify.warn('请描述你想要的脚本');
    return;
  }
  submitting.value = true;
  status.value = '正在调用 AI，请稍候...';
  statusKind.value = 'info';
  try {
    const resp = await requestJson<AiGenerateResponse>('/api/scripts/ai-generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: text }),
    });
    if (!resp.ok || !resp.script) {
      status.value = resp.error || 'AI 返回异常，请重试';
      statusKind.value = 'error';
      return;
    }
    close();
    emit('generated', resp.script);
    notify.success('AI 已生成脚本草稿，请检查后点击"保存"');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    status.value = `生成失败: ${msg}`;
    statusKind.value = 'error';
    notify.error(msg, 5000);
  } finally {
    submitting.value = false;
  }
}

watch(() => props.open, async (v) => {
  if (v) {
    prompt.value = '';
    status.value = '';
    statusKind.value = 'info';
    submitting.value = false;
    await nextTick();
    promptRef.value?.focus();
  }
});
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
    @click="onBackdropClick"
  >
    <div class="w-full max-w-lg bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-[#1e293b] flex flex-col overflow-hidden">
      <div class="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="flex items-center gap-2">
          <span class="text-lg">✦</span>
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200">AI 生成脚本</div>
        </div>
        <button
          type="button"
          class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:text-red-500 hover:border-red-200"
          @click="close"
        >关闭</button>
      </div>

      <div class="p-5 flex flex-col gap-3">
        <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">描述你想要的脚本</label>
        <textarea
          ref="promptRef"
          v-model="prompt"
          rows="3"
          placeholder="例如：检查 Docker 容器的健康状态，如果不健康就重启..."
          class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none resize-none focus:border-purple-400"
        ></textarea>
        <div
          v-if="status"
          class="text-[11px]"
          :class="statusKind === 'error' ? 'text-red-500' : 'text-slate-400'"
        >{{ status }}</div>
      </div>

      <div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] bg-slate-50/50 dark:bg-slate-800/30">
        <button
          type="button"
          class="h-8 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 dark:text-slate-300 hover:border-slate-400"
          @click="close"
        >取消</button>
        <button
          type="button"
          :disabled="submitting"
          class="h-8 px-4 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
          @click="onSubmit"
        >{{ submitting ? '生成中...' : '✦ 生成' }}</button>
      </div>
    </div>
  </div>
</template>

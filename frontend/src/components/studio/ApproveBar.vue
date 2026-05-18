<script setup lang="ts">
// 安全模式审批条 — 底部浮出（120s 倒计时 + deny/allow/custom）
// 与老 [public/skill-studio.html#L472-L490](public/skill-studio.html) + [public/skill-studio.js#L228-L279](public/skill-studio.js) 1:1
import { ref, watch, nextTick } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { ApprovePayload, ApproveAction } from '@/utils/studio';

interface Props {
  payload: ApprovePayload | null;
  countdown: number;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  respond: [action: ApproveAction, text: string];
}>();

const customInput = ref<HTMLInputElement | null>(null);
const customText = ref('');

// 新 request 来时清空文本框（与老版 $customInput.value = '' 一致）
watch(() => props.payload?.requestId, async (id) => {
  if (id) {
    customText.value = '';
    await nextTick();
    customInput.value?.focus();
  }
});

function onAllow(): void { emit('respond', 'allow', ''); }
function onDeny():  void { emit('respond', 'deny', ''); }
function onCustom(): void { emit('respond', 'custom', customText.value); }

function onCustomKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onCustom();
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="payload"
      class="approve-bar-slide fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[600px] max-w-[90vw] bg-white dark:bg-[#1e293b] rounded-xl border border-amber-300 dark:border-amber-500/40 shadow-2xl overflow-hidden"
    >
      <div class="px-4 py-2 flex items-center gap-2 border-b border-amber-100 dark:border-amber-500/20">
        <AppIcon name="shield" :size="12" class="text-amber-600 dark:text-amber-400" />
        <span class="text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex-1">
          {{ payload.title || '安全模式' }}
        </span>
        <span class="text-[10px] text-slate-400">{{ countdown }}s</span>
      </div>
      <div class="px-4 py-3">
        <div class="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
          AI 要执行 {{ payload.toolName || '操作' }}：
        </div>
        <pre class="w-full text-[11px] p-2 rounded-lg bg-slate-900 text-emerald-400 font-mono whitespace-pre-wrap break-all max-h-[120px] overflow-auto border border-slate-700">{{ payload.detail || '' }}</pre>
      </div>
      <div class="px-4 pb-3 flex items-center gap-2">
        <button
          class="px-4 py-1.5 rounded-lg border border-red-200 dark:border-red-500/30 text-red-500 text-[11px] font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 inline-flex items-center gap-1"
          @click="onDeny"
        >
          <AppIcon name="close" :size="11" />
          <span>拒绝</span>
        </button>
        <div class="flex-1 flex gap-1.5">
          <input
            ref="customInput"
            v-model="customText"
            class="flex-1 text-[11px] px-2 py-1 rounded-lg border border-slate-200 dark:border-[#334155] dark:bg-[#0f172a] dark:text-slate-200 focus:outline-none focus:border-blue-400"
            placeholder="自定义回复..."
            @keydown="onCustomKeydown"
          />
          <button
            class="px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-500/30 text-blue-500 text-[11px] font-semibold hover:bg-blue-50 dark:hover:bg-blue-900/20"
            @click="onCustom"
          >回复</button>
        </div>
        <button
          class="px-4 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-semibold hover:bg-emerald-600 inline-flex items-center gap-1"
          @click="onAllow"
        >
          <AppIcon name="check" :size="11" />
          <span>允许</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

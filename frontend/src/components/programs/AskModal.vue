<script setup lang="ts">
// Guardian ask_user 模态 — 三态：confirm / select / input
// 1:1 沿用老版：不支持 Esc / backdrop click 关闭；input 不支持 Enter 提交；select 默认选第 0 个
import { computed, nextTick, ref, watch } from 'vue';
import type { CurrentAsk, AskAnswer } from '@/utils/programs';

interface Props {
  ask: CurrentAsk | null;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  answer: [answer: AskAnswer];
  cancel: [];
}>();

const type = computed(() => props.ask?.payload.type || 'confirm');
const sessionLabel = computed(() => props.ask ? props.ask.sessionId.slice(0, 16) : '');
const iconText = computed(() => props.ask?.payload.danger ? '⚠️' : '🤖');
const titleText = computed(() => props.ask?.payload.title || '请确认');
const descText = computed(() => props.ask?.payload.description || '');
const confirmLabel = computed(() => props.ask?.payload.confirmLabel
  || (type.value === 'select' ? '选择' : (type.value === 'input' ? '提交' : '确认')));
const cancelLabel = computed(() => props.ask?.payload.cancelLabel || '取消');
const confirmCls = computed(() => {
  if (type.value === 'confirm' && props.ask?.payload.danger) return 'act-btn act-btn-danger';
  return 'act-btn act-btn-primary';
});

// select 状态（默认第 0 个）
const selectValue = ref<string>('');
// input 状态
const inputValue = ref<string>('');
const inputRef = ref<HTMLInputElement | null>(null);

watch(() => props.ask, async (now) => {
  if (!now) return;
  if (now.payload.type === 'select') {
    const first = now.payload.options?.[0]?.value || '';
    selectValue.value = first;
  } else if (now.payload.type === 'input') {
    inputValue.value = now.payload.defaultValue || '';
    await nextTick();
    // 与老版 setTimeout 30ms 等价
    setTimeout(() => inputRef.value?.focus(), 30);
  }
}, { immediate: true });

function onConfirm(): void {
  if (!props.ask) return;
  const payload = props.ask.payload;
  if (payload.type === 'select') {
    const opt = payload.options?.find((o) => o.value === selectValue.value);
    emit('answer', { value: selectValue.value, label: opt?.label || selectValue.value });
  } else if (payload.type === 'input') {
    emit('answer', { value: inputValue.value });
  } else {
    emit('answer', { confirmed: true });
  }
}

function onCancel(): void {
  emit('cancel');
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ask"
      class="modal-backdrop"
      style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;"
    >
      <div class="modal-box bg-white dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-2xl w-full max-w-lg mx-4 p-6">
        <div class="flex items-start gap-3 mb-3">
          <span class="text-2xl shrink-0">{{ iconText }}</span>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200">{{ titleText }}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">session {{ sessionLabel }}</div>
          </div>
        </div>
        <div class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap mb-4">{{ descText }}</div>
        <div class="mb-4">
          <!-- select -->
          <template v-if="type === 'select'">
            <label
              v-for="o in ask?.payload.type === 'select' ? (ask.payload.options || []) : []"
              :key="o.value"
              class="flex items-start gap-2 p-2 border border-slate-200 dark:border-[#1e293b] rounded-lg mb-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-[#0d1629]"
            >
              <input
                type="radio"
                name="guardian-ask-opt"
                :value="o.value"
                v-model="selectValue"
                class="mt-0.5"
              />
              <div class="min-w-0 flex-1">
                <div class="text-xs font-semibold">{{ o.label || o.value }}</div>
                <div v-if="o.description" class="text-[10px] text-slate-400 mt-0.5">{{ o.description }}</div>
              </div>
            </label>
          </template>
          <!-- input -->
          <template v-else-if="type === 'input' && ask?.payload.type === 'input'">
            <input
              ref="inputRef"
              v-model="inputValue"
              type="text"
              :placeholder="ask.payload.placeholder || ''"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs outline-none focus:border-blue-400"
            />
          </template>
          <!-- confirm: 无 body -->
        </div>
        <div class="flex gap-2 justify-end">
          <button class="act-btn act-btn-default" @click="onCancel">{{ cancelLabel }}</button>
          <button :class="confirmCls" @click="onConfirm">{{ confirmLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

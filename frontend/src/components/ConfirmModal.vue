<script setup lang="ts">
import { useConfirmState, resolveConfirm } from '@/composables/useConfirm';

const state = useConfirmState();

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) resolveConfirm(false);
}
</script>

<template>
  <div
    v-if="state"
    class="fixed inset-0 z-[2100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
    @click="onBackdropClick"
  >
    <div class="w-full max-w-sm bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-[#1e293b] p-5">
      <div class="text-sm font-bold text-slate-700 dark:text-slate-200 mb-2">{{ state.title }}</div>
      <div class="text-xs text-slate-500 dark:text-slate-400 mb-4 whitespace-pre-wrap">{{ state.message }}</div>
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="h-8 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          @click="resolveConfirm(false)"
        >取消</button>
        <button
          type="button"
          class="h-8 px-4 rounded-lg text-xs font-semibold transition-colors"
          :class="state.okClass"
          @click="resolveConfirm(true)"
        >{{ state.okText }}</button>
      </div>
    </div>
  </div>
</template>

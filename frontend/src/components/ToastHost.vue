<script setup lang="ts">
import { useNotifyStore } from '@/stores/notify';
const notify = useNotifyStore();

const kindClass: Record<string, string> = {
  info:    'bg-blue-500/15  text-blue-200  border-blue-400/30',
  success: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/30',
  warn:    'bg-amber-500/15 text-amber-200 border-amber-400/30',
  error:   'bg-rose-500/15  text-rose-200  border-rose-400/30',
};
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
    <div
      v-for="t in notify.toasts"
      :key="t.id"
      class="pointer-events-auto px-3 py-2 rounded-lg border text-sm shadow-lg backdrop-blur"
      :class="kindClass[t.kind]"
      @click="notify.dismiss(t.id)"
    >
      {{ t.text }}
    </div>
  </div>
</template>

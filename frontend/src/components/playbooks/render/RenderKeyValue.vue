<script setup lang="ts">
import { computed } from 'vue';
import type { RenderKeyValuePayload } from '@/utils/playbooks';

interface Props { payload: RenderKeyValuePayload }
const props = defineProps<Props>();

const items = computed<Array<{ key: string; value: unknown }>>(() => {
  if (Array.isArray(props.payload.items) && props.payload.items.length > 0) {
    return props.payload.items;
  }
  if (props.payload.data && typeof props.payload.data === 'object') {
    return Object.entries(props.payload.data).map(([key, value]) => ({ key, value }));
  }
  return [];
});

function vtext(v: unknown): string {
  return String(v == null ? '' : v);
}
</script>

<template>
  <div v-if="items.length === 0" class="text-xs text-slate-400 italic">（无内容）</div>
  <div v-else class="grid grid-cols-1 gap-1.5">
    <div v-for="(it, i) in items" :key="i" class="flex items-start gap-3 text-xs">
      <div class="w-24 shrink-0 text-slate-500 dark:text-slate-400">{{ it.key }}</div>
      <div class="flex-1 text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap break-all">{{ vtext(it.value) }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RenderListPayload } from '@/utils/playbooks';

interface Props { payload: RenderListPayload }
const props = defineProps<Props>();

const items = computed(() => props.payload.listItems || []);
</script>

<template>
  <div v-if="items.length === 0" class="text-xs text-slate-400 italic">（空）</div>
  <div v-else class="flex flex-col gap-2">
    <div v-for="(it, i) in items" :key="i" class="border-l-2 border-blue-300 dark:border-blue-500/60 pl-3">
      <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">{{ it.title || '' }}</div>
      <div v-if="it.description" class="text-[11px] text-slate-400 mt-0.5">{{ it.description }}</div>
    </div>
  </div>
</template>

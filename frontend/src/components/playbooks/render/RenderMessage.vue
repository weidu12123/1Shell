<script setup lang="ts">
import { computed } from 'vue';
import type { RenderMessagePayload, RenderLevel } from '@/utils/playbooks';

interface Props { payload: RenderMessagePayload }
const props = defineProps<Props>();

const ICONS: Record<RenderLevel, string> = {
  success: '✓',
  error:   '✗',
  warning: '⚠',
  info:    'ℹ',
};

const icon = computed(() => {
  const lv = props.payload.level;
  return lv ? ICONS[lv] : '';
});
</script>

<template>
  <div class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap flex items-start gap-2">
    <span v-if="icon" class="shrink-0 font-bold">{{ icon }}</span>
    <div>{{ payload.content || '' }}</div>
  </div>
</template>

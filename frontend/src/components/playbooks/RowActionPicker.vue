<script setup lang="ts">
import type { PlaybookInfo } from '@/utils/playbooks';

interface Props {
  modelValue: string;
  options: PlaybookInfo[];
}

defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

function onChange(e: Event): void {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="flex items-center gap-2 mt-2 px-1">
    <span class="text-[11px] text-slate-500 shrink-0">点击操作时调用：</span>
    <select
      :value="modelValue"
      class="text-[11px] border border-slate-200 dark:border-slate-600 rounded-lg px-2 py-1 bg-white dark:bg-[#0b1324] text-slate-700 dark:text-slate-200 flex-1"
      @change="onChange"
    >
      <option value="">— 自动（按 Playbook 指定）</option>
      <option v-for="s in options" :key="s.id" :value="s.id">
        [{{ s.kind === 'playbook' ? 'Playbook' : 'Skill' }}] {{ s.name || s.id }}
      </option>
    </select>
  </div>
</template>

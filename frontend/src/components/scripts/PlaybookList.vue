<script setup lang="ts">
import type { WorkflowInfo } from '@/utils/scripts';

interface Props {
  playbooks: WorkflowInfo[];
  loading: boolean;
  errorText: string | null;
}

defineProps<Props>();

const emit = defineEmits<{
  select: [id: string];
}>();
</script>

<template>
  <div class="flex-1 overflow-y-auto p-4">
    <div v-if="loading" class="text-center text-slate-400 text-xs py-8">加载中...</div>
    <div v-else-if="errorText" class="text-center text-red-400 text-xs py-8">加载失败: {{ errorText }}</div>
    <div
      v-else-if="playbooks.length === 0"
      class="flex flex-col items-center justify-center py-12 text-slate-400 gap-3"
    >
      <div class="text-4xl opacity-40">📘</div>
      <div class="text-xs">暂无 Playbook，点击右上角创建</div>
    </div>
    <template v-else>
      <div
        v-for="pb in playbooks"
        :key="pb.id"
        class="p-4 rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] mb-3 cursor-pointer hover:border-purple-300 transition-all"
        @click="emit('select', pb.id)"
      >
        <div class="flex items-center gap-3">
          <span class="text-xl">{{ pb.icon || '📘' }}</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{{ pb.name }}</div>
            <div class="text-[10px] text-slate-400 truncate">{{ pb.description || '无描述' }}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-[10px] text-slate-400">{{ (pb.steps || []).length }} 步</div>
            <div class="text-[10px] text-slate-400">{{ pb.updatedAt || '' }}</div>
          </div>
        </div>
        <div v-if="(pb.steps || []).length > 0" class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="(s, i) in pb.steps"
            :key="i"
            class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
          >{{ i + 1 }}. {{ s.scriptName || s.scriptId || '?' }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// 左栏 Program 列表 — 老 programs-list
import { computed } from 'vue';
import type { ProgramInfo } from '@/utils/programs';

interface Props {
  programs: ProgramInfo[];
  activeProgramId: string | null;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  select: [id: string];
  delete: [id: string, name: string];
}>();

const count = computed(() => props.programs.length);

function triggerTypes(p: ProgramInfo): string {
  return [...new Set((p.triggers || []).map((t) => t.type))].join(' · ') || '无 trigger';
}

function hostLabel(p: ProgramInfo): string {
  if (p.hosts === 'all') return '所有主机';
  if (Array.isArray(p.hosts)) return `${p.hosts.length} 台主机`;
  return '—';
}
</script>

<template>
  <div class="shrink-0 w-72 border-r border-slate-100 dark:border-[#1e293b] flex flex-col min-h-0">
    <div class="shrink-0 px-4 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-2">
      <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">Programs</div>
      <div class="flex-1"></div>
      <span class="text-[10px] text-slate-400">{{ count }}</span>
    </div>
    <div class="flex-1 overflow-auto p-2 flex flex-col gap-2">
      <div v-if="programs.length === 0" class="text-center text-slate-400 text-xs py-8">
        尚未定义任何 Program。<br>放到 <code>data/programs/&lt;id&gt;/program.yaml</code> 并点"重扫"
      </div>
      <div
        v-for="p in programs"
        :key="p.id"
        class="program-card"
        :class="{ active: p.id === activeProgramId }"
        @click="emit('select', p.id)"
      >
        <div class="flex items-center gap-2">
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200 flex-1 min-w-0 truncate">{{ p.name }}</div>
          <span class="badge" :class="p.enabled ? 'badge-ok' : 'badge-idle'">{{ p.enabled ? '已启用' : '未启用' }}</span>
          <button
            class="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600 hover:border-red-400 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30 dark:hover:text-red-300 transition-colors ml-1"
            title="删除 Program"
            @click.stop="emit('delete', p.id, p.name)"
          >删除</button>
        </div>
        <div class="text-[10px] text-slate-400 mt-1 flex items-center gap-2">
          <span>{{ triggerTypes(p) }}</span>
          <span class="text-slate-300 dark:text-slate-600">·</span>
          <span>{{ hostLabel(p) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

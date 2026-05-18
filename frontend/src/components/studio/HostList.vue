<script setup lang="ts">
// 左栏 - 主机列表 — 老 host-list
// 默认 local 顶部固定；点选 toggle selected
import AppIcon from '@/components/AppIcon.vue';
import type { HostInfo } from '@/utils/studio';

interface Props {
  hosts: HostInfo[]; // allHosts (含 local 顶部)
  selectedIds: Set<string>;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  toggle: [id: string];
}>();

function meta(h: HostInfo): string {
  if (h.id === 'local') return '本地';
  return `${h.username || 'root'}@${h.host || ''}`;
}
</script>

<template>
  <div class="bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] flex flex-col overflow-hidden" style="flex:1 1 0">
    <div class="col-header">
      <span>主机（VPS）</span>
      <span class="text-[10px] text-slate-400 font-normal normal-case">{{ selectedIds.size }}/{{ hosts.length }}</span>
    </div>
    <div class="flex-1 overflow-auto p-2 flex flex-col gap-1">
      <div v-if="hosts.length === 0" class="text-[11px] text-slate-400 text-center py-4">未配置主机</div>
      <div
        v-for="h in hosts"
        :key="h.id"
        class="item-row"
        :class="{ selected: selectedIds.has(h.id) }"
        @click="emit('toggle', h.id)"
      >
        <AppIcon :name="h.id === 'local' ? 'server' : 'cloud'" :size="14" class="text-slate-500 dark:text-slate-300" />
        <span class="truncate text-slate-700 dark:text-slate-200">{{ h.name }}</span>
        <span class="meta">{{ meta(h) }}</span>
      </div>
    </div>
  </div>
</template>

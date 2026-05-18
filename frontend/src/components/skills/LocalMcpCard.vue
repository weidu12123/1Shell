<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { McpInfo } from '@/utils/skills';

interface Props {
  mcp: McpInfo;
}

defineProps<Props>();
const emit = defineEmits<{
  update: [id: string, patch: Partial<McpInfo>];
  delete: [id: string];
}>();
</script>

<template>
  <div class="item-card flex flex-col gap-2">
    <div class="flex items-start gap-2">
      <span class="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300 flex items-center justify-center shrink-0">
        <AppIcon name="box" :size="18" />
      </span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold truncate">{{ mcp.name }}</div>
        <div class="text-[10px] text-slate-400 font-mono truncate" :title="mcp.command || ''">{{ mcp.command || '' }}</div>
      </div>
      <span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">本地</span>
    </div>
    <div class="text-[11px] text-slate-500 line-clamp-2 min-h-[24px]">{{ mcp.description || '' }}</div>
    <div class="flex flex-wrap gap-1 text-[9px]">
      <span class="px-1.5 py-0.5 rounded" :class="mcp.enabled === false ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-600'">
        {{ mcp.enabled === false ? 'disabled' : 'enabled' }}
      </span>
      <span class="px-1.5 py-0.5 rounded" :class="mcp.runtimeStatus === 'running' ? 'bg-emerald-100 text-emerald-600' : mcp.runtimeStatus === 'error' ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-500'">
        {{ mcp.runtimeStatus || 'stopped' }} · {{ mcp.toolCount || 0 }} tools
      </span>
      <span class="px-1.5 py-0.5 rounded" :class="mcp.autoStart ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-500'">auto {{ mcp.autoStart ? 'on' : 'off' }}</span>
      <span class="px-1.5 py-0.5 rounded" :class="mcp.exposeToIde === false ? 'bg-slate-100 text-slate-500' : 'bg-blue-100 text-blue-600'">IDE {{ mcp.exposeToIde === false ? 'off' : 'on' }}</span>
    </div>
    <div v-if="mcp.installDir" class="text-[10px] text-slate-400 truncate flex items-center gap-1" :title="mcp.installDir">
      <AppIcon name="folder" :size="10" />
      <span class="truncate">{{ mcp.installDir }}</span>
    </div>
    <div class="flex flex-wrap gap-1">
      <span
        v-for="t in (mcp.tags || []).slice(0, 4)"
        :key="t"
        class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#1e293b] text-slate-500"
      >{{ t }}</span>
    </div>
    <div class="grid grid-cols-4 gap-1 pt-1 border-t border-slate-100 dark:border-[#1e293b]">
      <button
        class="text-[10px] py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b]"
        @click="emit('update', mcp.id, { enabled: mcp.enabled === false })"
      >{{ mcp.enabled === false ? '启用' : '禁用' }}</button>
      <button
        class="text-[10px] py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b]"
        @click="emit('update', mcp.id, { autoStart: !mcp.autoStart })"
      >自启</button>
      <button
        class="text-[10px] py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b]"
        @click="emit('update', mcp.id, { exposeToIde: mcp.exposeToIde === false })"
      >IDE</button>
      <button
        class="text-[10px] py-1 rounded border border-red-200 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
        @click="emit('delete', mcp.id)"
      >删除</button>
    </div>
  </div>
</template>

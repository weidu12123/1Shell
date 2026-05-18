<script setup lang="ts">
// 右栏 - 工具（Skill + MCP） — 老 tool-* 组合
// 4 个 filter button + tool list；状态点来自 toolItem.statusDot
import AppIcon from '@/components/AppIcon.vue';
import { isEmojiIcon } from '@/utils/scripts';
import type { ToolFilter, ToolItem } from '@/utils/studio';

interface Props {
  filter: ToolFilter;
  items: ToolItem[];          // 已 filter 过的 items
  totalCount: number;         // 未 filter 总数
  selectedCount: number;
  selectedKeys: Set<string>;
  itemKey: (it: ToolItem) => string;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  'update:filter': [v: ToolFilter];
  toggle: [it: ToolItem];
}>();

const FILTERS: Array<{ key: ToolFilter; label: string; icon?: string }> = [
  { key: 'all',   label: '全部' },
  { key: 'skill', label: 'Skill', icon: 'package' },
  { key: 'mcp',   label: '远程', icon: 'plug' },
  { key: 'local', label: '本地', icon: 'box' },
];

function pillCls(it: ToolItem): string {
  if (it.kind === 'skill') return 'text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600';
  if (it.isLocal) return 'text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600';
  return 'text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600';
}

function pillText(it: ToolItem): string {
  if (it.kind === 'skill') return 'Skill';
  if (it.isLocal) return '本地' + it.statusDot;
  return '远程';
}

function emptyText(filter: ToolFilter): string {
  if (filter === 'local') return '本地 MCP';
  if (filter === 'mcp')   return '远程 MCP';
  if (filter === 'skill') return ' Skill';
  return '工具';
}
</script>

<template>
  <div class="bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] flex flex-col overflow-hidden" style="flex:1 1 0">
    <div class="col-header">
      <span>工具（Skill + MCP）</span>
      <div class="flex items-center gap-1">
        <span class="text-[10px] text-slate-400 font-normal normal-case">{{ selectedCount }} / {{ totalCount }}</span>
        <a
          href="/app/skills"
          class="text-[10px] normal-case font-normal text-slate-400 hover:text-blue-500"
          title="去仓库管理"
        >↗ 管理</a>
      </div>
    </div>

    <div class="px-3 pt-2 flex gap-1 text-[10px]">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="px-2 py-0.5 rounded inline-flex items-center gap-1"
        :class="filter === f.key ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-[#1e293b] text-slate-700 dark:text-slate-200'"
        @click="emit('update:filter', f.key)"
      >
        <AppIcon v-if="f.icon" :name="f.icon" :size="11" />
        <span>{{ f.label }}</span>
      </button>
    </div>

    <div class="flex-1 overflow-auto p-2 flex flex-col gap-1">
      <div v-if="items.length === 0" class="text-[11px] text-slate-400 text-center py-4">
        仓库里暂无{{ emptyText(filter) }}。<br/>
        点右上"↗ 管理"跳转仓库添加。
      </div>
      <div
        v-for="it in items"
        :key="itemKey(it)"
        class="item-row"
        :class="{ selected: selectedKeys.has(itemKey(it)) }"
        @click="emit('toggle', it)"
      >
        <span v-if="isEmojiIcon(it.icon)" class="text-[14px]">{{ it.icon }}</span>
        <AppIcon v-else-if="it.icon" :name="it.icon" :size="14" class="text-slate-500 dark:text-slate-300" />
        <AppIcon v-else name="wrench" :size="14" class="text-slate-400" />
        <span class="flex-1 truncate text-slate-700 dark:text-slate-200" :title="it.meta">{{ it.name }}</span>
        <span :class="pillCls(it)">{{ pillText(it) }}</span>
      </div>
    </div>

    <div class="px-3 py-2 border-t border-slate-100 dark:border-[#1e293b] text-[10px] text-amber-600 dark:text-amber-400">
      使用 MCP 需 Provider 上游为 Anthropic 直连
    </div>
  </div>
</template>

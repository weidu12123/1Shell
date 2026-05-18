<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { CATEGORY_ICONS, CATEGORY_LABELS, RISK_BADGES, isEmojiIcon, type ScriptInfo } from '@/utils/scripts';

interface Props {
  scripts: ScriptInfo[];
  currentId: string | null;
  category: string;
  keyword: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  select: [id: string];
}>();

const filtered = computed<ScriptInfo[]>(() => {
  const kw = props.keyword.trim().toLowerCase();
  return props.scripts.filter((s) => {
    if (props.category !== 'all' && s.category !== props.category) return false;
    if (!kw) return true;
    const hay = `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
    return hay.includes(kw);
  });
});

function iconOf(s: ScriptInfo): string {
  return s.icon || CATEGORY_ICONS[s.category] || 'terminal';
}

function catLabelOf(s: ScriptInfo): string {
  return CATEGORY_LABELS[s.category] || '其他';
}
</script>

<template>
  <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
    <div v-if="filtered.length === 0" class="flex flex-col items-center justify-center py-12 text-slate-400 text-xs gap-2">
      <AppIcon name="terminal" :size="32" class="opacity-40" />
      <div>{{ scripts.length === 0 ? '还没有脚本，点击"+ 新建脚本"开始' : '没有匹配的脚本' }}</div>
    </div>
    <div
      v-for="s in filtered"
      :key="s.id"
      class="script-card cursor-pointer p-3 rounded-xl border bg-white dark:bg-[#0b1324]"
      :class="s.id === currentId ? 'active border-purple-300' : 'border-slate-200 dark:border-[#1e293b]'"
      @click="emit('select', s.id)"
    >
      <div class="flex items-center gap-2">
        <span v-if="isEmojiIcon(iconOf(s))" class="text-base">{{ iconOf(s) }}</span>
        <AppIcon v-else :name="iconOf(s)" :size="16" class="text-slate-500 dark:text-slate-300" />
        <span class="flex-1 text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">{{ s.name }}</span>
        <span class="shrink-0 text-[9px] px-1.5 py-0.5 rounded border" :class="RISK_BADGES[s.riskLevel].cls">{{ RISK_BADGES[s.riskLevel].text }}</span>
      </div>
      <div v-if="s.description" class="mt-1 text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2">{{ s.description }}</div>
      <div class="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400 flex-wrap">
        <span class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700">{{ catLabelOf(s) }}</span>
        <span>·</span>
        <span v-if="(s.parameters || []).length === 0">无参数</span>
        <span v-else class="text-purple-500 dark:text-purple-300">{{ (s.parameters || []).length }} 参数</span>
        <span>·</span>
        <span>{{ s.runCount || 0 }} 次</span>
      </div>
    </div>
  </div>
</template>

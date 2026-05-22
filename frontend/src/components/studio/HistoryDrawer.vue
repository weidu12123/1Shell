<script setup lang="ts">
// 历史抽屉 — 老 history-drawer
// 0 ↔ 220px width 切换 + sessions[] 列表 + 删除单条
import type { ChatSession } from '@/utils/studio';
import { formatSessionTime } from '@/utils/studio';

interface Props {
  open: boolean;
  sessions: ChatSession[];
  currentSessionId: string | null;
  residualCountForSession?: (session: ChatSession) => number;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  newSession: [];
  switchTo: [id: string];
  delete: [id: string];
  cleanupResiduals: [id: string];
}>();

function residualCount(session: ChatSession): number {
  return props.residualCountForSession?.(session) || 0;
}
</script>

<template>
  <div
    class="shrink-0 flex flex-col bg-[#f8fafc] dark:bg-[#0f172a] border-r border-slate-200 dark:border-[#1e293b] overflow-hidden transition-all duration-200"
    :style="{ width: open ? '220px' : '0px' }"
  >
    <div class="col-header shrink-0" style="min-width:192px">
      <span>创作历史</span>
      <button
        class="text-[10px] normal-case font-normal text-blue-500 hover:text-blue-700"
        @click="emit('newSession')"
      >+ 新建</button>
    </div>
    <div class="flex-1 overflow-auto p-2 flex flex-col gap-1" style="min-width:192px">
      <div v-if="sessions.length === 0" class="text-[11px] text-slate-400 text-center py-10">暂无历史</div>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="history-item"
        :class="{ active: s.id === currentSessionId }"
        @click="emit('switchTo', s.id)"
      >
        <div class="hi-title" :title="s.title">{{ s.title || '(无标题)' }}</div>
        <div class="hi-meta flex items-center gap-1">
          <span>{{ formatSessionTime(s.createdAt) }}</span>
          <span class="flex-1"></span>
          <button
            v-if="residualCount(s) > 0"
            class="rounded px-1 text-[10px] text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:text-amber-300 dark:hover:bg-amber-500/10"
            :title="`只清理文件残留（${residualCount(s)} 个）`"
            @click.stop="emit('cleanupResiduals', s.id)"
          >清残留</button>
          <span
            class="text-red-400 hover:text-red-600 cursor-pointer px-1"
            title="删除历史并清理残留"
            @click.stop="emit('delete', s.id)"
          >✕</span>
        </div>
      </div>
    </div>
  </div>
</template>

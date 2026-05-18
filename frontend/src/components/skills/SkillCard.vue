<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { SkillInfo } from '@/utils/skills';

interface Props {
  skill: SkillInfo;
}

const props = defineProps<Props>();
const emit = defineEmits<{ delete: [id: string] }>();

const isSystem = (): boolean => props.skill.category === 'system';
function truncDesc(s: string | undefined): string {
  return String(s || '').slice(0, 200);
}
function isEmojiIcon(s: string | undefined): boolean {
  if (!s) return false;
  // 简单判断：有非 ASCII 视为 emoji；纯 ASCII 视为 SVG name
  return /[^\x00-\x7F]/.test(s);
}
</script>

<template>
  <div class="item-card flex flex-col gap-2">
    <div class="flex items-start gap-2">
      <span v-if="isEmojiIcon(skill.icon)" class="text-2xl">{{ skill.icon }}</span>
      <span v-else class="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center shrink-0">
        <AppIcon :name="skill.icon || 'wrench'" :size="18" />
      </span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold truncate">{{ skill.name || skill.id }}</div>
        <div class="text-[10px] text-slate-400 font-mono truncate">{{ skill.id }}</div>
      </div>
      <span v-if="isSystem()" class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">系统</span>
    </div>
    <div class="text-[11px] text-slate-500 line-clamp-3 min-h-[36px]">{{ truncDesc(skill.description) }}</div>
    <div class="flex flex-wrap gap-1">
      <span
        v-for="t in (skill.tags || []).slice(0, 4)"
        :key="t"
        class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#1e293b] text-slate-500"
      >{{ t }}</span>
    </div>
    <div class="flex gap-1 pt-1 border-t border-slate-100 dark:border-[#1e293b]">
      <button
        v-if="!isSystem()"
        class="text-[10px] py-1 px-2 rounded border border-red-200 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
        @click="emit('delete', skill.id)"
      >删除</button>
    </div>
  </div>
</template>

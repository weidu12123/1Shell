<script setup lang="ts">
// 结果 Tab — 老 results-stream（复用 playbooks RenderCard，不传 allSkillsAndPlaybooks 让 picker 静默隐藏）
import type { RenderResultEntry } from '@/utils/programs';
import RenderCard from '@/components/playbooks/render/RenderCard.vue';

interface Props {
  entries: RenderResultEntry[];
  hostLabel: string | null;
}
defineProps<Props>();
</script>

<template>
  <div class="flex-1 overflow-auto p-4 flex flex-col gap-3">
    <div v-if="entries.length === 0" class="text-center text-slate-400 text-xs py-12">
      <div class="text-2xl mb-2">📊</div>
      <div>运行一次后，render step 的结果会显示在这里</div>
      <div class="text-[10px] mt-1 text-slate-300 dark:text-slate-500">点「触发」或等待 cron 自动运行</div>
    </div>
    <div v-if="hostLabel && entries.length > 0" class="text-[10px] text-slate-400 font-medium">{{ hostLabel }}</div>
    <div class="flex flex-col gap-3">
      <div v-for="e in entries" :key="e.key">
        <div class="text-[10px] text-slate-400 mb-1">{{ e.ts }}  · {{ e.stepId }}</div>
        <RenderCard :payload="e.payload" />
      </div>
    </div>
  </div>
</template>

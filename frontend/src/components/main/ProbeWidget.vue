<script setup lang="ts">
// 顶栏探针 4 字段（CPU / 内存 / 负载 / 硬盘）— 老 [public/index.html#L259-L269](public/index.html#L259-L269) + [public/layout.js#L338-L352](public/layout.js#L338-L352) 1:1
interface Props {
  hostName: string;
  cpu: string;
  memory: string;
  load: string;
  disk: string;
}
defineProps<Props>();
</script>

<template>
  <div class="flex-1 flex items-center justify-center gap-4 text-xs text-slate-500 font-mono min-w-0">
    <span class="font-semibold text-slate-600 dark:text-slate-300 truncate max-w-[120px]">{{ hostName }}</span>
    <span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
    <span>CPU <b class="text-slate-700 dark:text-slate-200">{{ cpu }}</b></span>
    <span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
    <span>内存 <b class="text-slate-700 dark:text-slate-200">{{ memory }}</b></span>
    <span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
    <span>负载 <b class="text-slate-700 dark:text-slate-200">{{ load }}</b></span>
    <span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
    <span>硬盘 <b class="text-slate-700 dark:text-slate-200">{{ disk }}</b></span>
  </div>
</template>

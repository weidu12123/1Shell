<script setup lang="ts">
// 左栏 - 路径列表 — 老 path-list + path-input + 添加/浏览按钮
import { ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { SelectedPath } from '@/utils/studio';

interface Props {
  paths: SelectedPath[];
  hostName: (hostId: string) => string;
}
defineProps<Props>();
const emit = defineEmits<{
  add: [path: string];
  remove: [index: number];
  browse: [];
}>();

const inputValue = ref('');

function doAdd(): void {
  if (!inputValue.value.trim()) return;
  emit('add', inputValue.value);
  inputValue.value = '';
}
</script>

<template>
  <div class="bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] flex flex-col overflow-hidden" style="flex:1 1 0">
    <div class="col-header">
      <span>文件 / 路径</span>
      <div class="flex gap-1">
        <button class="text-[10px] px-2 py-0.5 rounded bg-slate-200 dark:bg-[#1e293b] normal-case font-normal hover:bg-slate-300 text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"
          title="从远程主机浏览文件"
          @click="emit('browse')"
        >
          <AppIcon name="folder" :size="11" />
          <span>浏览</span>
        </button>
        <button class="text-[10px] px-2 py-0.5 rounded bg-blue-500 text-white normal-case font-normal hover:bg-blue-600"
          @click="doAdd"
        >+ 添加</button>
      </div>
    </div>
    <div class="px-2 pt-2">
      <input
        v-model="inputValue"
        class="studio-input"
        placeholder="输入路径，如 /etc/nginx/nginx.conf 或 /data/app/"
        @keydown.enter="doAdd"
      />
    </div>
    <div class="flex-1 overflow-auto p-2 flex flex-col gap-1">
      <div v-if="paths.length === 0" class="text-[11px] text-slate-400 text-center py-4">暂未添加路径</div>
      <div
        v-for="(p, i) in paths"
        :key="`${p.hostId}::${p.path}::${i}`"
        class="item-row selected"
      >
        <AppIcon name="folder" :size="13" class="text-slate-500 dark:text-slate-300" />
        <span class="truncate font-mono text-[11px] text-slate-700 dark:text-slate-200">{{ p.path }}</span>
        <span class="meta">{{ hostName(p.hostId) }}</span>
        <span class="text-red-500 cursor-pointer px-1" @click.stop="emit('remove', i)">✕</span>
      </div>
    </div>
  </div>
</template>

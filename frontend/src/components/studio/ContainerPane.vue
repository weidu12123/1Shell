<script setup lang="ts">
// 右栏 - 项目（容器） — 老 container-* 组合
// scan-host-select + 扫描按钮 + pinned 固定区 + scan-list 扫描结果
import AppIcon from '@/components/AppIcon.vue';
import type { ContainerScanResult, HostInfo, SelectedContainer, ContainerScanItem } from '@/utils/studio';

interface Props {
  allHosts: HostInfo[];      // 含 local 顶部
  hostName: (id: string) => string;
  scanHostId: string;
  scanning: boolean;
  scanResult: ContainerScanResult | null;
  pinnedMap: Map<string, SelectedContainer>;
  isSelected: (hostId: string, name: string) => boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  'update:scanHostId': [v: string];
  scan: [];
  toggle: [hostId: string, c: ContainerScanItem];
  unpin: [key: string];
}>();

function dotCls(status: string): string {
  return status.toLowerCase().startsWith('up')
    ? 'w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 inline-block'
    : 'w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0 inline-block';
}

function shortImage(image: string): string {
  return (image || '').split(':')[0] || image;
}
</script>

<template>
  <div class="bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] flex flex-col overflow-hidden" style="flex:1 1 0">
    <div class="col-header">
      <span>
        项目（容器）
        <span
          v-if="pinnedMap.size > 0"
          class="ml-1 text-[9px] px-1 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300 font-normal normal-case"
        >已选 {{ pinnedMap.size }}</span>
      </span>
      <div class="flex items-center gap-1">
        <select
          :value="scanHostId"
          class="text-[10px] py-0.5 px-1 rounded border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0a0f1c] normal-case font-normal max-w-[90px] truncate"
          title="选择要扫描的主机"
          @change="emit('update:scanHostId', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="h in allHosts" :key="h.id" :value="h.id">{{ h.name }}</option>
        </select>
        <button
          class="text-[10px] normal-case font-normal text-slate-400 hover:text-blue-500"
          title="扫描选中主机的容器"
          :disabled="scanning"
          @click="emit('scan')"
        >{{ scanning ? '扫描中…' : '↻ 扫描' }}</button>
      </div>
    </div>

    <!-- 已选容器固定区 -->
    <div
      v-if="pinnedMap.size > 0"
      class="px-2 pt-2 flex flex-col gap-1 border-b border-slate-100 dark:border-[#1e293b] pb-2"
    >
      <div
        v-for="c in [...pinnedMap.values()]"
        :key="c.hostId + '::' + c.name"
        class="item-row selected"
        style="padding:5px 8px;"
      >
        <AppIcon name="container" :size="13" class="text-slate-500 dark:text-slate-300" />
        <span class="truncate text-[11px] text-slate-700 dark:text-slate-200">{{ c.name }}</span>
        <span class="meta">{{ hostName(c.hostId) }}</span>
        <span
          class="text-red-400 hover:text-red-600 cursor-pointer px-1 ml-auto shrink-0"
          title="取消选择"
          @click.stop="emit('unpin', c.hostId + '::' + c.name)"
        >✕</span>
      </div>
    </div>

    <!-- 扫描结果区 -->
    <div class="flex-1 overflow-auto p-2 flex flex-col gap-1">
      <div v-if="scanning" class="text-[11px] text-slate-400 text-center py-4">扫描中…</div>
      <template v-else-if="scanResult === null">
        <div class="text-[11px] text-slate-400 text-center py-4">
          在头部下拉选主机，点"↻ 扫描"
        </div>
      </template>
      <template v-else-if="scanResult.kind === 'no-docker'">
        <div class="text-[11px] text-slate-400 text-center py-4">
          {{ hostName(scanHostId) }} 上未检测到 Docker
        </div>
      </template>
      <template v-else-if="scanResult.kind === 'error'">
        <div class="text-[11px] text-red-400 text-center py-4 flex flex-col gap-2">
          <span>扫描失败：{{ scanResult.message }}</span>
          <button class="text-blue-500 underline" @click="emit('scan')">点此重试</button>
        </div>
      </template>
      <template v-else-if="scanResult.items.length === 0">
        <div class="text-[11px] text-slate-400 text-center py-4">{{ hostName(scanHostId) }} 上没有容器</div>
      </template>
      <template v-else>
        <div
          v-for="c in scanResult.items"
          :key="scanHostId + '::' + c.name"
          class="item-row"
          :class="{ selected: isSelected(scanHostId, c.name) }"
          @click="emit('toggle', scanHostId, c)"
        >
          <AppIcon name="container" :size="14" class="text-slate-500 dark:text-slate-300" />
          <span class="flex-1 truncate text-slate-700 dark:text-slate-200">{{ c.name }}</span>
          <span :class="dotCls(c.status)"></span>
          <span class="meta">{{ shortImage(c.image) }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

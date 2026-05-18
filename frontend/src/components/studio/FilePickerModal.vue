<script setup lang="ts">
// 文件浏览器模态 — 老 fp-modal
// host select + 路径输入 + ⬆ 上级 + 文件夹点击进入 + ➕ 添加（800ms ✓ 反馈）
// backdrop click 关闭（与老版一致；这一点 ask modal 没有）
import { ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { FpItem, HostInfo, SelectedPath } from '@/utils/studio';
import { humanSize } from '@/utils/studio';

interface Props {
  open: boolean;
  pool: HostInfo[];               // selectedHosts > 0 则用 selected；否则 allHosts
  selectedPaths: SelectedPath[];  // 用于判重
  loadDir: (hostId: string, path: string) => Promise<{ path: string; parent: string | null; items: FpItem[] } | null>;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  pick: [hostId: string, path: string];
}>();

const hostId = ref<string>('local');
const currentPath = ref<string>('');
const parentPath = ref<string | null>(null);
const items = ref<FpItem[]>([]);
const loading = ref(false);
const errorMsg = ref<string | null>(null);
const pathInputValue = ref<string>('');
const pickedFlash = ref<Set<string>>(new Set()); // path → 显示 ✓ 800ms

async function loadDir(p: string): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  const res = await props.loadDir(hostId.value, p || '');
  loading.value = false;
  if (!res) {
    errorMsg.value = '加载失败';
    return;
  }
  currentPath.value = res.path;
  parentPath.value = res.parent;
  items.value = res.items;
  pathInputValue.value = res.path || '';
}

// 打开时初始化
watch(() => props.open, async (now) => {
  if (!now) return;
  hostId.value = props.pool[0]?.id || 'local';
  currentPath.value = '';
  await loadDir('');
});

// 切主机时重新加载
function onHostChange(e: Event): void {
  hostId.value = (e.target as HTMLSelectElement).value;
  void loadDir('');
}

function onPathInputKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') void loadDir(pathInputValue.value.trim());
}

function goUp(): void {
  if (parentPath.value !== null && parentPath.value !== undefined) {
    void loadDir(parentPath.value);
  }
}

function onClickItem(it: FpItem): void {
  if (it.isDir) void loadDir(it.path);
}

function onPickItem(it: FpItem): void {
  // 去重交给 composable 内部 addPickedPath，但这里给 UI 反馈
  emit('pick', hostId.value, it.path);
  const k = it.path;
  pickedFlash.value = new Set([...pickedFlash.value, k]);
  setTimeout(() => {
    const s = new Set(pickedFlash.value);
    s.delete(k);
    pickedFlash.value = s;
  }, 800);
}

function onBackdropClick(e: MouseEvent): void {
  // 仅点击外层背景时关闭
  if ((e.target as HTMLElement).dataset.backdrop === '1') emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-backdrop="1"
      class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      @click="onBackdropClick"
    >
      <div class="bg-white dark:bg-[#0f172a] rounded-2xl border border-slate-200 dark:border-[#1e293b] w-[720px] max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
        <div class="px-4 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-2">
          <span class="text-sm font-semibold text-slate-700 dark:text-slate-200">远程文件浏览</span>
          <select
            :value="hostId"
            class="studio-input"
            style="width:auto;min-width:180px;"
            @change="onHostChange"
          >
            <option v-for="h in pool" :key="h.id" :value="h.id">{{ h.name }}</option>
          </select>
          <div class="flex-1 font-mono text-[11px] text-slate-500 truncate px-2">{{ currentPath || '/' }}</div>
          <button
            class="text-[11px] px-2 py-1 rounded border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b] text-slate-700 dark:text-slate-200"
            title="上级"
            @click="goUp"
          >⬆</button>
          <button class="text-xl text-slate-400 hover:text-red-500 px-1" title="关闭" @click="emit('close')">✕</button>
        </div>

        <div class="px-4 py-2 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-2">
          <input
            v-model="pathInputValue"
            class="studio-input flex-1"
            placeholder="直接输入路径回车跳转，如 /etc/nginx"
            @keydown="onPathInputKeydown"
          />
        </div>

        <div class="flex-1 overflow-auto p-2 flex flex-col gap-0.5 text-[12px]">
          <div v-if="loading" class="text-[11px] text-slate-400 text-center py-10">加载中...</div>
          <div v-else-if="errorMsg" class="text-[11px] text-red-500 text-center py-10">{{ errorMsg }}</div>
          <div v-else-if="items.length === 0" class="text-[11px] text-slate-400 text-center py-10">(空目录)</div>
          <div
            v-for="it in items"
            :key="it.path"
            class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-[#1e293b]"
          >
            <AppIcon :name="it.isDir ? 'folder' : 'file'" :size="13" class="text-slate-500 dark:text-slate-300" />
            <span
              class="flex-1 truncate cursor-pointer font-mono text-slate-700 dark:text-slate-200"
              @click="onClickItem(it)"
            >{{ it.name }}</span>
            <span class="text-[10px] text-slate-400 w-20 text-right">{{ it.isDir ? '' : humanSize(it.size) }}</span>
            <button
              class="px-2 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 inline-flex items-center justify-center"
              :class="pickedFlash.has(it.path) ? 'text-emerald-500' : 'text-blue-500'"
              title="加入已选"
              @click="onPickItem(it)"
            >
              <AppIcon :name="pickedFlash.has(it.path) ? 'check' : 'plus'" :size="12" />
            </button>
          </div>
        </div>

        <div class="px-4 py-3 border-t border-slate-100 dark:border-[#1e293b] flex items-center gap-2">
          <span class="text-[11px] text-slate-400 flex-1">点击目录进入 · 点击右侧加号加入已选</span>
          <button
            class="px-3 py-1.5 rounded-lg bg-blue-500 text-white text-xs font-semibold"
            @click="emit('close')"
          >完成</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

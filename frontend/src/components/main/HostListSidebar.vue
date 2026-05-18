<script setup lang="ts">
// 左栏 - 主机列表 — 老 [public/index.html#L294-L308](public/index.html#L294-L308) + [public/hosts.js#L100-L152](public/hosts.js#L100-L152) 1:1
// 含搜索 + 折叠 + 主机卡片（切换/编辑/删除/快捷链接）
import type { MainHost } from '@/utils/mainConsole';
import { isLocalHost } from '@/utils/mainConsole';

interface Props {
  hosts: MainHost[];
  activeHostId: string | null;
  searchKeyword: string;
  showSecretWarning: boolean;
  /** 折叠状态：0 = 默认，1 = 仅本区，-1 = 收起 */
  collapsed?: boolean;
  /** 左栏内本块占比（与文件浏览器分配 aside 垂直空间，默认 5） */
  flex?: number;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  'update:searchKeyword': [v: string];
  connect: [hostId: string];
  edit: [hostId: string];
  delete: [hostId: string];
  'toggle-collapsed': [];
}>();

function onSearchInput(e: Event): void {
  emit('update:searchKeyword', (e.target as HTMLInputElement).value);
}

function metaText(h: MainHost): string {
  if (isLocalHost(h)) return '本地 Shell';
  return `${h.username || 'root'}@${h.host}:${h.port || 22}`;
}
</script>

<template>
  <div
    id="lp-vps-section"
    class="rounded-2xl flex flex-col overflow-hidden transition-all duration-300"
    :style="{ flex: props.flex ?? 5, minHeight: 0 }"
  >
    <!-- 搜索 + 缩放按钮 -->
    <div class="flex items-center gap-1.5 p-2 border-b border-slate-100 dark:border-[#1e293b]">
      <input
        :value="searchKeyword"
        type="text"
        placeholder="搜索主机…"
        autocomplete="off"
        class="flex-1 h-7 px-2.5 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
        @input="onSearchInput"
      />
      <button
        class="shrink-0 h-6 w-6 flex items-center justify-center rounded-md border border-slate-200 dark:border-[#1e293b] text-slate-400 hover:text-blue-500 hover:border-blue-300 text-[10px] transition-all"
        title="最小化/最大化"
        @click="emit('toggle-collapsed')"
      >⇕</button>
    </div>

    <!-- 默认 secret 警告 -->
    <div
      v-if="showSecretWarning"
      class="text-xs text-amber-600 bg-amber-50 px-3 py-2 border-b border-amber-100 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700/40"
    >
      当前使用默认 APP_SECRET，上线前请配置强随机密钥。
    </div>

    <!-- 主机卡片列表 -->
    <div class="host-list flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
      <div
        v-if="!hosts.length"
        class="text-[11px] text-slate-400 text-center py-4"
      >没有匹配的主机</div>

      <div
        v-for="h in hosts"
        :key="h.id"
        class="host-item"
        :class="{ active: h.id === activeHostId }"
      >
        <div class="host-main">
          <div class="host-name">{{ h.name }}</div>
          <div class="host-meta">
            <span>{{ metaText(h) }}</span>
            <span v-if="h.proxyHostId" class="host-proxy-badge">经跳板机中继</span>
          </div>
          <div v-if="h.links && h.links.length" class="host-links">
            <div class="host-links-title">网站任意门</div>
            <div class="host-links-list">
              <a
                v-for="(lk, idx) in h.links"
                :key="idx"
                class="host-link-chip"
                :href="lk.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="lk.description || lk.url"
              >{{ lk.name }}</a>
            </div>
          </div>
        </div>
        <div class="host-actions">
          <button
            class="host-action-btn"
            type="button"
            @click="emit('connect', h.id)"
          >切换</button>
          <button
            class="host-action-btn"
            type="button"
            @click="emit('edit', h.id)"
          >编辑</button>
          <button
            v-if="!isLocalHost(h)"
            class="host-action-btn"
            type="button"
            @click="emit('delete', h.id)"
          >删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

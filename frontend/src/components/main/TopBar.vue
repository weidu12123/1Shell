<script setup lang="ts">
// 顶栏 — 老 [public/index.html#L244-L282](public/index.html#L244-L282) + [public/layout.js](public/layout.js)
// 范围：标题 + 添加主机 + 侧栏折叠 + AI Agent / 1Shell AI / AI 配置 / AI 折叠 / 设置 / 主题 + ProbeWidget
// dead button 不渲染（按决策章）：logout-btn（hidden）/ refresh-hosts-btn（hidden）
import ProbeWidget from '@/components/main/ProbeWidget.vue';

interface Props {
  hostName: string;
  cpu: string;
  memory: string;
  load: string;
  disk: string;
  darkMode: boolean;
}
defineProps<Props>();
const emit = defineEmits<{
  'add-host': [];
  'toggle-sidebar': [];
  'toggle-ai-panel': [];
  'open-settings': [];
  'toggle-theme': [];
  'mobile-menu': [];
}>();
</script>

<template>
  <header class="topbar shrink-0 h-14 flex items-center px-5 rounded-2xl">
    <!-- 左：标题 + 添加主机 + 侧栏折叠 -->
    <div class="flex items-center gap-3 flex-1">
      <button
        class="mobile-menu-btn md:hidden h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-[#1e293b] text-lg text-slate-700 dark:text-slate-200"
        type="button"
        @click="emit('mobile-menu')"
      >☰</button>
      <span class="text-2xl text-slate-700 dark:text-slate-200">🖥</span>
      <div>
        <div class="text-base font-bold text-slate-700 dark:text-slate-200">主控台</div>
        <div class="text-[11px] text-slate-400 italic">One Shell to rule them all.</div>
      </div>
      <button
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all ml-2"
        type="button"
        @click="emit('add-host')"
      >+ 添加主机</button>
      <button
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all"
        type="button"
        title="折叠/展开左侧栏"
        @click="emit('toggle-sidebar')"
      >侧栏折叠</button>
    </div>

    <!-- 中：当前主机探针 -->
    <ProbeWidget
      :host-name="hostName"
      :cpu="cpu"
      :memory="memory"
      :load="load"
      :disk="disk"
    />

    <!-- 右：操作按钮 -->
    <div class="topbar-actions flex items-center gap-2 flex-1 justify-end">
      <button
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all"
        type="button"
        title="折叠/展开 AI 面板"
        @click="emit('toggle-ai-panel')"
      >AI</button>
      <button
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-slate-400 transition-all"
        type="button"
        title="系统设置"
        @click="emit('open-settings')"
      >⚙ 设置</button>
      <button
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-slate-400 transition-all"
        type="button"
        title="切换主题"
        @click="emit('toggle-theme')"
      >{{ darkMode ? '🌙' : '☀' }}</button>
    </div>
  </header>
</template>

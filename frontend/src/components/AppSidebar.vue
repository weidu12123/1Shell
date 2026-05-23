<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from './AppIcon.vue';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  title: string;
}

const navItems: NavItem[] = [
  { to: '/',             label: '主页', icon: 'globe',      title: '世界地图主页' },
  { to: '/console',      label: '主控', icon: 'console',    title: '主控台' },
  { to: '/programs',     label: '程序', icon: 'cog',        title: '长驻程序' },
  { to: '/scripts',      label: '脚本', icon: 'terminal',   title: '脚本库' },
  { to: '/skills',       label: '仓库', icon: 'package',    title: '技能仓库' },
  { to: '/skill-studio', label: '创作', icon: 'wand',       title: '创作台' },
  { to: '/cli-setup',    label: 'AI',   icon: 'spark',      title: 'AI 配置' },
  { to: '/probe',        label: '探针', icon: 'radio',      title: '探针' },
  { to: '/audit',        label: '审计', icon: 'clipboard',  title: '审计日志' },
];

const emit = defineEmits<{ 'open-settings': [] }>();

const isDark = ref(true);
const themeIcon = ref<'sun' | 'moon'>('sun');

function syncFromDom(): void {
  isDark.value = document.documentElement.classList.contains('dark');
  themeIcon.value = isDark.value ? 'sun' : 'moon';
}

function toggleTheme(): void {
  const html = document.documentElement;
  const next = !html.classList.contains('dark');
  if (next) html.classList.add('dark');
  else html.classList.remove('dark');
  localStorage.setItem('1shell-theme', next ? 'dark' : 'light');
  syncFromDom();
}

onMounted(syncFromDom);
</script>

<template>
  <aside
    class="sidebar-aside shrink-0 w-16 flex flex-col items-stretch py-3"
  >
    <RouterLink
      to="/"
      class="sidebar-logo shrink-0 mx-auto mb-3 w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center transition-all"
      title="1Shell"
    >
      <img src="/logo.png" alt="1Shell" class="w-full h-full object-cover" />
    </RouterLink>
    <div class="sidebar-divider mx-3 h-px mb-2"></div>

    <nav class="flex-1 flex flex-col gap-1 px-1">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="side-nav-item"
        :title="item.title"
      >
        <AppIcon :name="item.icon" :size="20" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

    <div class="shrink-0 flex flex-col gap-1 px-1">
      <div class="sidebar-divider mx-3 h-px mb-1"></div>
      <button
        type="button"
        class="side-nav-item"
        title="主题切换"
        @click="toggleTheme"
      >
        <AppIcon :name="themeIcon" :size="18" />
        <span>主题</span>
      </button>
      <button
        type="button"
        class="side-nav-item"
        title="系统设置"
        @click="emit('open-settings')"
      >
        <AppIcon name="cog" :size="18" />
        <span>设置</span>
      </button>
    </div>
  </aside>
</template>

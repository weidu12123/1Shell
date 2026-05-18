<script setup lang="ts">
// 统一线性 SVG 图标库（1.5px stroke、currentColor、跟随主题色）
// 用法：<AppIcon name="console" :size="20" />
import { computed } from 'vue';

interface Props {
  name: string;
  size?: number | string;
  strokeWidth?: number | string;
}

const props = withDefaults(defineProps<Props>(), {
  size: 20,
  strokeWidth: 1.6,
});

const sizePx = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
  <svg
    :width="sizePx"
    :height="sizePx"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="strokeWidth"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="app-icon"
    aria-hidden="true"
  >
    <!-- 主页：地球 -->
    <template v-if="name === 'globe'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </template>

    <!-- 主控：显示器 -->
    <template v-else-if="name === 'console'">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
      <path d="M7 9l2 2-2 2M11 13h4" />
    </template>

    <!-- 程序：齿轮 -->
    <template v-else-if="name === 'cog'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </template>

    <!-- 脚本：终端 / 命令行 -->
    <template v-else-if="name === 'terminal'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </template>

    <!-- 仓库：堆叠盒子 / 工具箱 -->
    <template v-else-if="name === 'package'">
      <path d="M21 8L12 3 3 8v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </template>

    <!-- 创作：魔法棒 -->
    <template v-else-if="name === 'wand'">
      <path d="M15 4l1.5 3 3 1.5-3 1.5L15 13l-1.5-3-3-1.5 3-1.5L15 4z" />
      <path d="M5 19l8-8" />
      <path d="M5 19l-1 1M13 11l1-1" />
    </template>

    <!-- AI：六边形 + 节点 -->
    <template v-else-if="name === 'spark'">
      <path d="M12 3l8 4.6v8.8L12 21l-8-4.6V7.6L12 3z" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 7v3M12 14v3M9.5 13.5L7.5 14.7M14.5 13.5l2 1.2M9.5 10.5L7.5 9.3M14.5 10.5l2-1.2" />
    </template>

    <!-- 探针：信号塔 -->
    <template v-else-if="name === 'radio'">
      <circle cx="12" cy="12" r="1.5" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
    </template>

    <!-- 审计：清单 -->
    <template v-else-if="name === 'clipboard'">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" />
    </template>

    <!-- 太阳 -->
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </template>

    <!-- 月亮 -->
    <template v-else-if="name === 'moon'">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </template>

    <!-- 最近主机：显示器 + 时钟 小角标 -->
    <template v-else-if="name === 'recent-host'">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
      <circle cx="17.5" cy="6.5" r="3" fill="currentColor" stroke="none" opacity="0.18" />
      <circle cx="17.5" cy="6.5" r="3" />
      <path d="M17.5 5v1.5l1 .8" />
    </template>

    <!-- 统计：柱图 -->
    <template v-else-if="name === 'chart'">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </template>

    <!-- 警告 / 异常 -->
    <template v-else-if="name === 'alert'">
      <path d="M12 3l10 17H2L12 3z" />
      <path d="M12 10v4M12 17v.5" />
    </template>

    <!-- 勾 -->
    <template v-else-if="name === 'check'">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </template>

    <!-- 箭头 -->
    <template v-else-if="name === 'arrow-right'">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </template>

    <!-- 历史 / 时钟 -->
    <template v-else-if="name === 'history'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </template>

    <!-- 导入 / 收件箱（下箭头入盒） -->
    <template v-else-if="name === 'download'">
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      <path d="M12 4v11M7 10l5 5 5-5" />
    </template>

    <!-- 文件夹 -->
    <template v-else-if="name === 'folder'">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </template>

    <!-- 锁 -->
    <template v-else-if="name === 'lock'">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </template>

    <!-- 软盘 / 备份 -->
    <template v-else-if="name === 'save'">
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <rect x="8" y="4" width="8" height="5" />
      <rect x="7" y="13" width="10" height="7" rx="1" />
    </template>

    <!-- 集装箱 / Docker -->
    <template v-else-if="name === 'container'">
      <rect x="3" y="7" width="18" height="11" rx="1.5" />
      <path d="M8 7v11M12 7v11M16 7v11" />
      <path d="M3 7l2-2h14l2 2" />
    </template>

    <!-- 书堆 / 全部 -->
    <template v-else-if="name === 'library'">
      <path d="M5 4v16M9 4v16" />
      <rect x="3" y="4" width="8" height="16" rx="1" />
      <rect x="13" y="6" width="3" height="14" rx="0.5" />
      <path d="M17 6l3 13-2 .5-3-13z" />
    </template>

    <!-- 拼图 / Skill -->
    <template v-else-if="name === 'puzzle'">
      <path d="M9 4a1.5 1.5 0 0 1 3 0c0 .8.6 1 1.2 1H16a1 1 0 0 1 1 1v2.8c0 .6.3 1.2 1.1 1.2a1.5 1.5 0 0 1 0 3c-.8 0-1.1.6-1.1 1.2V18a1 1 0 0 1-1 1h-2.8c-.6 0-1.2.3-1.2 1.1a1.5 1.5 0 0 1-3 0c0-.8-.6-1.1-1.2-1.1H5a1 1 0 0 1-1-1v-3c0-.4.4-.8.8-.8.4 0 .8.3 1.2.3a1.5 1.5 0 0 0 0-3c-.4 0-.8.3-1.2.3-.4 0-.8-.4-.8-.8V6a1 1 0 0 1 1-1h2.8c.6 0 1.2-.2 1.2-1z" />
    </template>

    <!-- 插头 / MCP -->
    <template v-else-if="name === 'plug'">
      <path d="M9 2v4M15 2v4" />
      <path d="M7 6h10v4a5 5 0 0 1-10 0V6z" />
      <path d="M12 15v3a3 3 0 0 0 3 3h2" />
    </template>

    <!-- 简单盒子 / 本地 MCP -->
    <template v-else-if="name === 'box'">
      <rect x="3.5" y="6.5" width="17" height="13" rx="1.5" />
      <path d="M3.5 10.5h17M9 6.5v-2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </template>

    <!-- 笔 / 创作 -->
    <template v-else-if="name === 'pen'">
      <path d="M14.5 4.5l5 5L8 21H3v-5L14.5 4.5z" />
      <path d="M13 6l5 5" />
    </template>

    <!-- 机器人 / AI -->
    <template v-else-if="name === 'robot'">
      <rect x="4" y="8" width="16" height="11" rx="2" />
      <path d="M12 4v4M9 4h6" />
      <circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
      <path d="M2 13v3M22 13v3" />
    </template>

    <!-- 扳手 / 工具 -->
    <template v-else-if="name === 'wrench'">
      <path d="M21 7a4 4 0 0 1-5.5 4l-7.3 7.3a2 2 0 1 1-2.8-2.8L12.7 8a4 4 0 0 1 5.4-5.4l-3 3 .6 2.4 2.4.6 3-3A4 4 0 0 1 21 7z" />
    </template>

    <!-- 加号 -->
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>

    <!-- 服务器 / 本机 -->
    <template v-else-if="name === 'server'">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </template>

    <!-- 云 / 远程主机 -->
    <template v-else-if="name === 'cloud'">
      <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A4.5 4.5 0 0 1 17 18H7z" />
    </template>

    <!-- 盾 / 安全 -->
    <template v-else-if="name === 'shield'">
      <path d="M12 3l8 3v6c0 4.5-3.5 8.5-8 9-4.5-.5-8-4.5-8-9V6l8-3z" />
    </template>

    <!-- 文件 -->
    <template v-else-if="name === 'file'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </template>

    <!-- 上箭头 -->
    <template v-else-if="name === 'arrow-up'">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </template>

    <!-- 关闭 X -->
    <template v-else-if="name === 'close'">
      <path d="M6 6l12 12M18 6l-6 6-6 6" />
    </template>

    <!-- fallback -->
    <template v-else>
      <circle cx="12" cy="12" r="9" />
    </template>
  </svg>
</template>

<style scoped>
.app-icon {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>

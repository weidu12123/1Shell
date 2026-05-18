<script setup lang="ts">
// 中栏 - 输入区 — 老 task-input + 3 checkbox + send/stop
import AppIcon from '@/components/AppIcon.vue';
interface Props {
  taskValue: string;
  summary: string;
  safeMode: boolean;
  unlimitedTurns: boolean;
  ccCollab: boolean;
  isRunning: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  'update:taskValue': [v: string];
  send: [];
  stop: [];
  'update:safeMode': [v: boolean];
  'update:unlimitedTurns': [v: boolean];
  'update:ccCollab': [v: boolean];
}>();

function onTaskInput(e: Event): void {
  emit('update:taskValue', (e.target as HTMLTextAreaElement).value);
}

function onTaskKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    emit('send');
  }
}
</script>

<template>
  <div class="shrink-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] p-3 flex flex-col gap-2">
    <textarea
      :value="taskValue"
      class="studio-input"
      rows="3"
      placeholder="用自然语言描述你的需求。例如：帮我写一个每5分钟监控证书过期的程序；列出所有容器并显示状态表格；写一个删除网站的 Skill。"
      @input="onTaskInput"
      @keydown="onTaskKeydown"
    ></textarea>
    <div class="flex items-center gap-2">
      <div class="text-[10px] text-slate-400 flex-1 flex items-center gap-3">
        <span>{{ summary }}</span>
        <label class="flex items-center gap-1 cursor-pointer select-none" title="安全模式：开启后本机写操作需确认">
          <input
            type="checkbox"
            :checked="safeMode"
            class="accent-amber-500 w-3 h-3"
            @change="emit('update:safeMode', ($event.target as HTMLInputElement).checked)"
          />
          <span :class="safeMode ? 'text-amber-500 inline-flex items-center gap-1' : 'text-slate-400 inline-flex items-center gap-1'">
            <AppIcon v-if="safeMode" name="shield" :size="11" />
            <span>安全模式</span>
          </span>
        </label>
        <label class="flex items-center gap-1 cursor-pointer select-none" title="不限轮次：关闭后 AI 工具调用轮数无上限">
          <input
            type="checkbox"
            :checked="unlimitedTurns"
            class="accent-blue-500 w-3 h-3"
            @change="emit('update:unlimitedTurns', ($event.target as HTMLInputElement).checked)"
          />
          <span :class="unlimitedTurns ? 'text-blue-500' : 'text-slate-400'">∞ 不限轮次</span>
        </label>
        <label class="flex items-center gap-1 cursor-pointer select-none" title="Claude Code 协作：允许调用 Claude Code 处理复杂创作任务">
          <input
            type="checkbox"
            :checked="ccCollab"
            class="accent-purple-500 w-3 h-3"
            @change="emit('update:ccCollab', ($event.target as HTMLInputElement).checked)"
          />
          <span :class="ccCollab ? 'text-purple-500' : 'text-slate-400'">✦ CC 协作</span>
        </label>
      </div>
      <button
        v-if="!isRunning"
        class="px-5 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 text-white text-xs font-semibold hover:opacity-90"
        @click="emit('send')"
      >发送 →</button>
      <button
        v-else
        class="px-4 py-2 rounded-lg bg-red-500 text-white text-xs font-semibold hover:bg-red-600"
        @click="emit('stop')"
      >停止</button>
    </div>
  </div>
</template>

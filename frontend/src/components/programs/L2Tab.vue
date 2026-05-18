<script setup lang="ts">
// L2 Skill Tab — 老 l2-stream + 不限轮次 + "AI 改进"按钮
// 6 子型：l2-started / l2-thinking / exec / exec-result / info / l2-ended
import type { L2Entry } from '@/utils/programs';
import EventStreamRow from './EventStreamRow.vue';

interface Props {
  entries: L2Entry[];
  unlimited: boolean;
  improvePending: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  setUnlimited: [enabled: boolean];
  improve: [];
}>();

function format(ev: L2Entry): { icon: string; colorCls: string; msg: string; breakAll?: boolean } {
  if (ev.type === 'l2-started') {
    return {
      icon: '⚡', colorCls: 'text-violet-500',
      msg: `${ev.mode === 'repair' ? '维护修复启动' : 'Skill 步骤启动'} · step=${ev.stepId} · skill=${ev.skillId}${ev.attempt ? ` · attempt=${ev.attempt}` : ''} · ${ev.goal}`,
    };
  }
  if (ev.type === 'l2-thinking') {
    return { icon: '💭', colorCls: 'text-violet-400', msg: `思考 · 第 ${ev.turn} 轮` };
  }
  if (ev.type === 'exec') {
    return { icon: '→', colorCls: 'text-blue-500', msg: `exec: ${ev.command}`, breakAll: true };
  }
  if (ev.type === 'exec-result') {
    const ok = ev.exitCode === 0;
    return {
      icon: ok ? '✓' : '✗',
      colorCls: ok ? 'text-emerald-500' : 'text-red-500',
      msg: `exit=${ev.exitCode} · ${ev.durationMs}ms`
        + (ev.stderrSnippet ? ` · err: ${ev.stderrSnippet}` : '')
        + (ok && ev.stdoutSnippet ? ` · out: ${ev.stdoutSnippet}` : ''),
      breakAll: true,
    };
  }
  if (ev.type === 'info') {
    return { icon: 'ℹ', colorCls: 'text-slate-500', msg: ev.message };
  }
  // l2-ended
  return {
    icon: ev.ok ? '●' : '■',
    colorCls: ev.ok ? 'text-emerald-500' : 'text-red-500',
    msg: `结束 · ${ev.ok ? '成功' : '失败'}${ev.disposition ? ` · ${ev.disposition}` : ''} — ${ev.summary} · ${ev.durationMs}ms`,
  };
}

function onUnlimitedChange(e: Event): void {
  emit('setUnlimited', (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="flex-1 overflow-auto">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-[#1e293b]">
      <label class="flex items-center gap-1.5 cursor-pointer select-none text-[11px]" title="开启后 L2 Skill 步骤不限轮次，直到完成任务">
        <input
          type="checkbox"
          :checked="unlimited"
          @change="onUnlimitedChange"
          class="accent-violet-500 w-3 h-3"
        />
        <span :class="unlimited ? 'text-violet-500' : 'text-slate-400'">不限轮次</span>
      </label>
      <button
        class="ml-auto px-2 py-0.5 text-[10px] rounded border border-violet-300 dark:border-violet-600 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="将 L2 执行日志发送给 1Shell AI，让它优化 Skill 和 Program"
        :disabled="improvePending"
        @click="emit('improve')"
      >{{ improvePending ? '⏳ 改进中...' : '🔧 AI 改进' }}</button>
    </div>
    <div class="flex flex-col divide-y divide-slate-100 dark:divide-[#1e293b]">
      <div v-if="entries.length === 0" class="text-center text-slate-400 text-xs py-8">
        L2 Skill 事件流为空。<br>
        当 Program 的 <code>type: skill</code> 步骤执行时，AI 的操作过程会显示在这里。
      </div>
      <template v-else>
        <EventStreamRow
          v-for="ev in entries"
          :key="ev.key"
          :ts="ev.ts"
          :icon="format(ev).icon"
          :color-cls="format(ev).colorCls"
          :msg="format(ev).msg"
          :break-all="format(ev).breakAll"
        />
      </template>
    </div>
  </div>
</template>

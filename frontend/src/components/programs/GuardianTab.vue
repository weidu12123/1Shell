<script setup lang="ts">
// Guardian Tab — 老 guardian-stream + 不限轮次
// 10 子型：session-started / monitor-triggered / thinking / thought / exec / exec-result / render / info / ask / session-ended
import type { GuardianEntry } from '@/utils/programs';
import EventStreamRow from './EventStreamRow.vue';

interface Props {
  entries: GuardianEntry[];
  unlimited: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  setUnlimited: [enabled: boolean];
}>();

function format(ev: GuardianEntry): { icon: string; colorCls: string; msg: string; breakAll?: boolean } {
  if (ev.type === 'session-started') {
    return {
      icon: '🛡', colorCls: 'text-amber-500',
      msg: `Guardian 唤起 · ${ev.sessionId.slice(0, 16)} · step=${ev.stepId} · skills=[${ev.allowedSkills}]`,
    };
  }
  if (ev.type === 'monitor-triggered') {
    return {
      icon: '📡', colorCls: 'text-orange-500',
      msg: `Monitor 触发 · ${ev.monitorId} · program=${ev.programId} · host=${ev.hostId}`,
    };
  }
  if (ev.type === 'thinking') {
    return { icon: '💭', colorCls: 'text-slate-400', msg: `思考 · 第 ${ev.turn} 轮` };
  }
  if (ev.type === 'thought') {
    return { icon: '🤖', colorCls: 'text-slate-500', msg: ev.text, breakAll: true };
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
  if (ev.type === 'render') {
    const lvlMap: Record<string, string> = { success: '✓', error: '✗', warning: '!', info: 'i' };
    const cls = ev.level === 'success' ? 'text-emerald-500'
      : ev.level === 'error' ? 'text-red-500'
      : ev.level === 'warning' ? 'text-amber-500'
      : 'text-blue-500';
    return {
      icon: lvlMap[ev.level || ''] || '◉',
      colorCls: cls,
      msg: `${ev.title}${ev.content ? ' — ' + ev.content : ''}`,
      breakAll: true,
    };
  }
  if (ev.type === 'info') {
    return { icon: 'ℹ', colorCls: 'text-slate-500', msg: ev.message };
  }
  if (ev.type === 'ask') {
    return {
      icon: '❓', colorCls: 'text-amber-500',
      msg: `ask_user · ${ev.payload?.type} · ${ev.payload?.title || ''}`,
    };
  }
  // session-ended
  return {
    icon: ev.ok ? '●' : '■',
    colorCls: ev.ok ? 'text-emerald-500' : 'text-red-500',
    msg: `结束 · ${ev.resolution} — ${ev.summary}`,
    breakAll: true,
  };
}

function onUnlimitedChange(e: Event): void {
  emit('setUnlimited', (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="flex-1 overflow-auto">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-[#1e293b]">
      <label class="flex items-center gap-1.5 cursor-pointer select-none text-[11px]" title="开启后 Guardian 不限轮次，直到完成任务或手动取消">
        <input
          type="checkbox"
          :checked="unlimited"
          @change="onUnlimitedChange"
          class="accent-amber-500 w-3 h-3"
        />
        <span :class="unlimited ? 'text-amber-500' : 'text-slate-400'">不限轮次</span>
      </label>
    </div>
    <div class="flex flex-col divide-y divide-slate-100 dark:divide-[#1e293b]">
      <div v-if="entries.length === 0" class="text-center text-slate-400 text-xs py-8">
        L3 Guardian 事件流为空。<br>
        当 Program 步骤失败且 <code>on_fail: escalate</code> 时，Guardian AI 的诊断过程会显示在这里。
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

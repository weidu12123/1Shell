<script setup lang="ts">
// 实时事件 Tab — 老 events-stream
// 4 子型：run-started / step-started / step-ended / run-ended
import type { EventEntry } from '@/utils/programs';
import EventStreamRow from './EventStreamRow.vue';

interface Props {
  entries: EventEntry[];
}
defineProps<Props>();

function format(ev: EventEntry): { icon: string; colorCls: string; msg: string } {
  if (ev.type === 'run-started') {
    return {
      icon: '▶', colorCls: 'text-blue-500',
      msg: `run #${ev.runId} 启动 — ${ev.triggerId} / ${ev.action} · ${ev.hostId}`,
    };
  }
  if (ev.type === 'step-started') {
    return {
      icon: '→', colorCls: 'text-slate-500',
      msg: `run #${ev.runId} step "${ev.stepId}" 开始`,
    };
  }
  if (ev.type === 'step-ended') {
    const ok = ev.status === 'verified';
    return {
      icon: ok ? '✓' : (ev.status === 'skipped' ? '◌' : '✗'),
      colorCls: ok ? 'text-emerald-500' : (ev.status === 'skipped' ? 'text-slate-400' : 'text-red-500'),
      msg: `run #${ev.runId} step "${ev.stepId}" ${ev.status} ${ev.durationMs ? `(${ev.durationMs}ms)` : ''}${ev.reason ? ` — ${ev.reason}` : ''}`,
    };
  }
  if (ev.type === 'phase') {
    const color = ev.layer === 'L3' ? 'text-orange-500' : ev.layer === 'L2' ? 'text-violet-500' : 'text-sky-500';
    const icon = ev.layer === 'L3' ? '▲' : ev.layer === 'L2' ? '◆' : '◇';
    return {
      icon,
      colorCls: color,
      msg: `[${ev.layer || '-'}] ${ev.phase || ''}${ev.stepId ? ` · step "${ev.stepId}"` : ''}${ev.attempt ? ` · attempt ${ev.attempt}` : ''}${ev.incidentId ? ` · incident ${ev.incidentId}` : ''}${ev.reason ? ` — ${ev.reason}` : ''}`,
    };
  }
  // run-ended
  const ok = ev.status === 'success';
  const warn = ev.status === 'warning';
  return {
    icon: ok ? '●' : (warn ? '◉' : '■'),
    colorCls: ok ? 'text-emerald-500' : (warn ? 'text-amber-500' : 'text-red-500'),
    msg: `run #${ev.runId} 结束 — ${ev.status}${ev.error ? ` · ${ev.error}` : ''}`,
  };
}
</script>

<template>
  <div class="flex-1 overflow-auto">
    <div class="flex flex-col divide-y divide-slate-100 dark:divide-[#1e293b]">
      <div v-if="entries.length === 0" class="text-center text-slate-400 text-xs py-8">等待事件…</div>
      <template v-else>
        <EventStreamRow
          v-for="ev in entries"
          :key="ev.key"
          :ts="ev.ts"
          :icon="format(ev).icon"
          :color-cls="format(ev).colorCls"
          :msg="format(ev).msg"
        />
      </template>
    </div>
  </div>
</template>

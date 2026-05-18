<script setup lang="ts">
// 通用单条事件行（events / l2 / guardian 三流共用）
// 1:1 复刻老版 div.event-row.pulse 结构
interface Props {
  ts: string;
  icon: string;
  colorCls: string;
  msg: string;
  breakAll?: boolean;
}
withDefaults(defineProps<Props>(), { breakAll: false });
</script>

<template>
  <div class="event-row pulse">
    <span class="text-[10px] text-slate-400 shrink-0 font-mono">{{ ts }}</span>
    <span :class="['shrink-0', colorCls]">{{ icon }}</span>
    <span :class="['flex-1', breakAll ? 'break-all' : '']">{{ msg }}</span>
  </div>
</template>

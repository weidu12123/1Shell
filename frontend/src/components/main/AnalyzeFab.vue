<script setup lang="ts">
// AnalyzeFab.vue — MainConsole 刀 3 阶段 1 · 选区分析悬浮按钮
// 1:1 复刻 [public/index.html](public/index.html) row 424 #analyze-fab
// 放在 terminal-main 内,absolute 与 GhostOverlay 同级
import { useTerminalAnalyze } from '@/composables/useTerminalAnalyze';

const analyze = useTerminalAnalyze();
</script>

<template>
  <button
    v-show="analyze.fabVisible.value"
    type="button"
    class="analyze-fab"
    title="AI 分析选区"
    @click="analyze.triggerAnalysis"
  >分析</button>
</template>

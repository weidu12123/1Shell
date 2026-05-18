<script setup lang="ts">
// AnalyzePanel.vue — MainConsole 刀 3 阶段 1 · 选区分析结果面板
// [[feedback-analyze-panel-bottom-dock]]: 底部 docked 横向条,与 terminal-main 同列
import { useTerminalAnalyze } from '@/composables/useTerminalAnalyze';

const analyze = useTerminalAnalyze();
</script>

<template>
  <div v-if="analyze.panelOpen.value" class="analyze-panel">
    <div class="analyze-panel-header">
      <span class="analyze-panel-title">🔍 终端选区 AI 分析</span>
      <div class="analyze-panel-header-actions">
        <button
          type="button"
          class="analyze-action-btn"
          :disabled="analyze.loading.value"
          @click="analyze.triggerAnalysis"
        >{{ analyze.loading.value ? '分析中…' : '重新分析' }}</button>
        <button type="button" class="analyze-panel-close" @click="analyze.closePanel">关闭</button>
      </div>
    </div>

    <div class="analyze-panel-body">
      <!-- 选中内容 -->
      <div class="analyze-section analyze-section-preview">
        <div class="analyze-section-label">选中内容</div>
        <pre class="analyze-preview-text">{{ analyze.previewText.value }}</pre>
        <button
          v-if="analyze.previewToggleVisible.value"
          type="button"
          class="analyze-preview-toggle"
          @click="analyze.togglePreview"
        >{{ analyze.previewToggleLabel.value }}</button>
      </div>

      <!-- loading / result -->
      <div v-if="analyze.loading.value" class="analyze-section analyze-loading">
        <span class="analyze-loading-dot" />
        正在分析…
      </div>

      <template v-else-if="analyze.result.value">
        <div class="analyze-section">
          <div class="analyze-section-label">摘要</div>
          <div class="analyze-summary">{{ analyze.result.value.summary || '--' }}</div>
          <div v-if="analyze.errorTypeLabel.value" class="analyze-error-type">{{ analyze.errorTypeLabel.value }}</div>
        </div>

        <div v-if="analyze.result.value.fixSuggestion" class="analyze-section analyze-section-fix">
          <div class="analyze-section-fix-head">
            <div class="analyze-section-label">建议命令</div>
            <span v-if="analyze.riskLabel.value" class="analyze-risk-badge" :class="analyze.riskLabel.value.cls">
              {{ analyze.riskLabel.value.text }}
            </span>
          </div>
          <pre class="analyze-fix-cmd">{{ analyze.result.value.fixSuggestion }}</pre>
          <div class="analyze-fix-actions">
            <button type="button" class="analyze-action-btn" @click="analyze.copyCommand">复制命令</button>
            <button
              v-if="analyze.insertVisible.value"
              type="button"
              class="analyze-action-btn analyze-action-btn-primary"
              @click="analyze.handleInsertClick"
            >注入终端</button>
          </div>

          <!-- caution 确认浮层（无倒计时,22.3 节定调） -->
          <div v-if="analyze.confirmVisible.value" class="analyze-fix-confirm">
            <span>此命令风险中等，确认注入终端？</span>
            <button type="button" class="analyze-action-btn analyze-action-btn-primary" @click="analyze.confirmInsert">确认注入</button>
            <button type="button" class="analyze-action-btn" @click="analyze.cancelInsert">取消</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

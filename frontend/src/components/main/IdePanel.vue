<script setup lang="ts">
// IdePanel.vue — MainConsole 刀 5a · 1Shell AI 右栏（与 AiChatPanel 在右栏 tab 切换）
// 1:1 复刻 [public/ide-panel.js](public/ide-panel.js) UI + [public/index.html:495-532](public/index.html#L495-L532)
//
// feedback-right-aside-tabs：右栏用 tab 切换不是 toggle，故 close 按钮不渲染（关闭=切回 AI Chat tab）
// feedback-migration-no-improvements：tool picker 不做（老版 DOM 缺失，行为对齐）
import { nextTick, onMounted, ref, watch } from 'vue';

import { useIdePanel } from '@/composables/useIdePanel';

const ide = useIdePanel();
const chatAreaEl = ref<HTMLElement | null>(null);

onMounted(() => { ide.initialize(); });

watch(() => ide.turns.value.length, () => { void nextTick(scrollToBottom); });
watch(() => ide.turns.value, () => { void nextTick(scrollToBottom); }, { deep: true });

function scrollToBottom(): void {
  const el = chatAreaEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ide.sendMessage();
  }
}

function lineClass(kind: string): string {
  return {
    stdout: 'ide-line-stdout',
    stderr: 'ide-line-stderr',
    info: 'ide-line-info',
    error: 'ide-line-error',
    success: 'ide-line-success',
    stream: 'ide-line-stdout',
  }[kind] || 'ide-line-stdout';
}
</script>

<template>
  <div class="ide-panel">
    <!-- header -->
    <div class="ide-panel-header">
      <div class="ide-panel-title-block">
        <span class="ide-panel-title">1Shell AI</span>
        <span class="ide-panel-badge">IDE</span>
      </div>
      <div class="ide-panel-toggles">
        <label
          class="ide-toggle ide-toggle-safe"
          :class="{ 'ide-toggle--active': ide.safeMode.value }"
          title="安全模式：写操作需审批"
        >
          <input
            type="checkbox"
            :checked="ide.safeMode.value"
            @change="(e) => ide.setSafeMode((e.target as HTMLInputElement).checked)"
          />
          <span>🛡 安全</span>
        </label>
        <label
          class="ide-toggle ide-toggle-cc"
          :class="{ 'ide-toggle--active': ide.claudeCodeEnabled.value }"
          title="Claude Code 协作：允许调用 Claude Code 处理复杂创作任务"
        >
          <input
            type="checkbox"
            :checked="ide.claudeCodeEnabled.value"
            @change="(e) => ide.setClaudeCodeEnabled((e.target as HTMLInputElement).checked)"
          />
          <span>✦ CC</span>
        </label>
        <label
          class="ide-toggle ide-toggle-unlimited"
          :class="{ 'ide-toggle--active': ide.unlimitedTurns.value }"
          title="不限轮次：取消 AI 工具调用 30 轮上限"
        >
          <input
            type="checkbox"
            :checked="ide.unlimitedTurns.value"
            @change="(e) => ide.setUnlimitedTurns((e.target as HTMLInputElement).checked)"
          />
          <span>∞ 轮次</span>
        </label>
        <button
          type="button"
          class="ide-panel-clear-btn"
          :disabled="ide.isRunning.value"
          title="清空对话"
          @click="ide.resetChat"
        >清空</button>
      </div>
    </div>

    <!-- chat area -->
    <div ref="chatAreaEl" class="ide-panel-chat">
      <div v-if="!ide.hasMessages.value" class="ide-panel-placeholder">
        <span class="ide-panel-placeholder-icon">💻</span>
        <span>1Shell AI 助手<br />输入需求，AI 会在你的主机上执行操作</span>
      </div>
      <template v-for="(turn, i) in ide.turns.value" :key="i">
        <div v-if="turn.role === 'user'" class="ide-turn ide-turn-user">
          <div class="ide-bubble-user">{{ turn.text }}</div>
        </div>
        <div v-else class="ide-turn ide-turn-assistant">
          <div class="ide-turn-meta"><span>🤖</span><span>1Shell AI</span></div>
          <div class="ide-bubble-assistant">
            <div
              v-for="(line, j) in turn.lines || []"
              :key="j"
              :class="['ide-line', lineClass(line.kind)]"
            >{{ line.text }}</div>
          </div>
        </div>
      </template>
    </div>

    <!-- input -->
    <div class="ide-panel-input-area">
      <textarea
        v-model="ide.inputText.value"
        rows="2"
        placeholder="描述你的需求，如：查看所有容器状态、检查磁盘占用..."
        class="ide-panel-input"
        spellcheck="false"
        @keydown="onInputKeydown"
      />
      <div class="ide-panel-input-row">
        <span class="ide-panel-status">{{ ide.statusText.value }}</span>
        <button
          v-if="!ide.isRunning.value"
          type="button"
          class="ide-panel-send-btn"
          :disabled="!ide.inputText.value.trim()"
          @click="ide.sendMessage"
        >发送 →</button>
        <button
          v-else
          type="button"
          class="ide-panel-stop-btn"
          @click="ide.stop"
        >停止</button>
      </div>
    </div>
  </div>
</template>

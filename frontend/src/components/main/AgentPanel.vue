<script setup lang="ts">
// AgentPanel.vue — MainConsole 刀 5b · AI Agent 右栏（与 AI Chat / 1Shell AI 在右栏 tab 切换）
// 1:1 复刻 [public/agent-panel.js](public/agent-panel.js) UI + [public/index.html:460-492](public/index.html#L460-L492)
//
// feedback-right-aside-tabs：右栏用 tab 切换，Agent 激活时右栏 w-[40%]（2:4:4）
import { onMounted, ref } from 'vue';

import { useAgentPanel } from '@/composables/useAgentPanel';
import { useNotifyStore } from '@/stores/notify';

const agent = useAgentPanel();
const notify = useNotifyStore();
const terminalWrapEl = ref<HTMLElement | null>(null);

onMounted(() => {
  if (terminalWrapEl.value) {
    agent.initialize(terminalWrapEl.value);
  }
});

async function handleStart(): Promise<void> {
  try {
    await agent.startAgent(false);
  } catch (err) {
    notify.error((err as Error).message || '启动 Agent 失败');
  }
}

async function handleStartLocal(): Promise<void> {
  try {
    await agent.startAgent(true);
  } catch (err) {
    notify.error((err as Error).message || '本地启动 Agent 失败');
  }
}

async function handleNewSession(): Promise<void> {
  try {
    await agent.newSession();
  } catch (err) {
    notify.error((err as Error).message || '新建会话失败');
  }
}

async function handleSetup(): Promise<void> {
  try {
    await agent.setupMcp();
    notify.success('MCP 沙箱已就绪');
  } catch (err) {
    notify.error((err as Error).message || 'MCP 配置失败');
  }
}

function getSessionDotColor(status: string): string {
  if (status === 'ready') return 'bg-purple-400';
  if (status === 'starting') return 'bg-amber-400';
  return 'bg-red-400';
}
</script>

<template>
  <div class="agent-panel">
    <!-- 会话标签页（类似终端 tabs） -->
    <div class="agent-tabs">
      <div
        v-for="[sessionKey, sess] in agent.sessions.value"
        :key="sessionKey"
        class="agent-tab"
        :class="{ 'agent-tab--active': agent.activeSessionKey.value === sessionKey }"
        @click="agent.switchToSession(sessionKey)"
      >
        <span class="agent-tab-dot" :class="getSessionDotColor(sess.status)" />
        <span class="agent-tab-label">{{ sess.label }}</span>
        <button
          type="button"
          class="agent-tab-close"
          title="停止并关闭"
          @click.stop="agent.closeSession(sessionKey)"
        >×</button>
      </div>
      <button
        type="button"
        class="agent-new-session-btn"
        @click="handleNewSession"
      >+ 新会话</button>
    </div>

    <!-- 标题栏 -->
    <div class="agent-panel-header">
      <div class="agent-panel-title-block">
        <span class="agent-panel-title">AI Agent</span>
      </div>
    </div>

    <!-- Provider 选择 + 状态 -->
    <div class="agent-toolbar">
      <select
        :value="agent.selectedProviderId.value"
        class="agent-provider-select"
        @change="(e) => agent.setSelectedProvider((e.target as HTMLSelectElement).value)"
      >
        <option
          v-for="p in agent.providers.value"
          :key="p.id"
          :value="p.id"
        >
          {{ p.label }}{{ p.configured ? (p.activeProviderName ? ` · ${p.activeProviderName}` : '') + (p.model ? ` · ${p.model}` : '') : ' · 未配置 API' }}
        </option>
      </select>
      <button
        type="button"
        class="agent-setup-btn"
        :class="{ 'agent-setup-btn--done': agent.mcpConfigured.value }"
        title="一键将当前 AI CLI 工具接入 1Shell MCP"
        @click="handleSetup"
      >{{ agent.mcpConfigured.value ? '✓ 沙箱就绪' : '⚡ 创建沙箱' }}</button>
      <span class="agent-status-text">{{ agent.statusText.value }}</span>
    </div>

    <!-- 终端区（多会话，useAgentXterm 动态渲染） -->
    <div ref="terminalWrapEl" class="agent-terminal-wrap" />

    <!-- 操作按钮 -->
    <div class="agent-panel-footer">
      <button
        type="button"
        class="agent-btn agent-btn-start"
        @click="handleStart"
      >启动</button>
      <button
        type="button"
        class="agent-btn agent-btn-start-local"
        @click="handleStartLocal"
      >本地启动</button>
      <button
        type="button"
        class="agent-btn agent-btn-stop"
        :disabled="!agent.activeSessionKey.value"
        @click="agent.stopAgent"
      >停止</button>
      <button
        type="button"
        class="agent-btn agent-btn-clear"
        :disabled="!agent.activeSessionKey.value"
        @click="agent.clearTerminal"
      >清屏</button>
    </div>
  </div>
</template>

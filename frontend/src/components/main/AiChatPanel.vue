<script setup lang="ts">
// AiChatPanel.vue — MainConsole 刀 4 · AI Chat 右栏
// 1:1 复刻 [public/ai-chat.js](public/ai-chat.js) UI + [public/index.html:428-458](public/index.html#L428-L458)
import { nextTick, onMounted, ref, watch } from 'vue';

import { useAiChat } from '@/composables/useAiChat';

const chat = useAiChat();
const messagesEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

onMounted(() => {
  chat.initialize();
  scrollToBottom();
});

// 消息列表变化 / 流式增量 → 滚到底（保留用户主动上滚行为：仅在原先就在底部时跟随）
watch(() => chat.displayMessages.value.length, () => { void nextTick(scrollToBottom); });
watch(() => chat.displayMessages.value, () => { void nextTick(scrollToBottom); }, { deep: true });

function scrollToBottom(): void {
  const el = messagesEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    void chat.sendMessage();
  }
}
</script>

<template>
  <div class="ai-chat-panel">
    <!-- header -->
    <div class="ai-chat-header">
      <span class="ai-chat-title">AI 运维助手</span>
      <button
        type="button"
        class="ai-chat-clear-btn"
        :disabled="chat.isStreaming.value"
        @click="chat.resetCurrentChat"
      >清空</button>
    </div>

    <!-- messages -->
    <div ref="messagesEl" class="ai-chat-messages">
      <div
        v-for="(msg, i) in chat.displayMessages.value"
        :key="i"
        class="ai-chat-message"
        :class="[`ai-chat-message-${msg.role}`, { 'ai-chat-message-pending': msg.pending }]"
      >
        <div class="ai-chat-avatar">{{ msg.role === 'user' ? '你' : 'AI' }}</div>
        <!-- html 已 escapeHtml + 安全 Markdown 转换 -->
        <div class="ai-chat-bubble" v-html="msg.html" />
      </div>
    </div>

    <!-- input -->
    <div class="ai-chat-input-area">
      <textarea
        ref="inputEl"
        v-model="chat.inputText.value"
        rows="3"
        placeholder="输入问题，Ctrl+Enter 发送"
        autocomplete="off"
        spellcheck="false"
        class="ai-chat-input"
        :disabled="chat.isStreaming.value"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="ai-chat-send-btn"
        :disabled="chat.isStreaming.value || !chat.inputText.value.trim()"
        @click="chat.sendMessage"
      >{{ chat.isStreaming.value ? '发送中…' : '发送' }}</button>
    </div>
  </div>
</template>

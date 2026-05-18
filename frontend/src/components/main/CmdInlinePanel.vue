<script setup lang="ts">
// CmdInlinePanel.vue — 老 #cmd-inline-panel AI 命令生成面板
import { nextTick, watch, ref } from 'vue';
import { useCommandSuggestion } from '@/composables/useCommandSuggestion';

const cmd = useCommandSuggestion();
const promptEl = ref<HTMLTextAreaElement | null>(null);

watch(cmd.isOpen, async (open) => {
  if (!open) return;
  await nextTick();
  promptEl.value?.focus();
});
</script>

<template>
  <section
    id="cmd-inline-panel"
    class="cmd-inline-panel"
    :class="{ hidden: !cmd.isOpen.value }"
  >
    <div class="cmd-inline-header">
      <div>
        <div class="cmd-inline-title">AI 命令建议</div>
        <div class="cmd-inline-subtitle">描述你想执行的操作，AI 会生成可插入当前终端的命令。</div>
      </div>
      <button
        id="cmd-close-btn"
        class="terminal-mini-btn"
        type="button"
        @click="cmd.closeCmdModal"
      >×</button>
    </div>

    <div class="cmd-inline-body">
      <textarea
        id="cmd-prompt"
        ref="promptEl"
        v-model="cmd.prompt.value"
        class="cmd-prompt"
        placeholder="例如：查看当前目录下最大的 10 个文件"
        @keydown.enter.prevent="cmd.generateCommandSuggestion"
      ></textarea>
      <button
        id="cmd-generate-btn"
        type="button"
        class="cmd-primary-btn"
        :disabled="cmd.isGenerating.value"
        @click="cmd.generateCommandSuggestion"
      >{{ cmd.isGenerating.value ? '生成中…' : '生成命令' }}</button>
    </div>

    <div
      id="cmd-result"
      class="cmd-result"
      :class="{ hidden: !cmd.result.value }"
    >
      <pre id="cmd-result-code" class="cmd-result-code">{{ cmd.result.value }}</pre>
      <div class="cmd-result-actions">
        <button id="cmd-copy-btn" type="button" class="cmd-secondary-btn" @click="cmd.copyCommandSuggestion">复制</button>
        <button id="cmd-insert-btn" type="button" class="cmd-primary-btn" @click="cmd.insertCommandSuggestion">插入终端</button>
      </div>
    </div>
  </section>
</template>

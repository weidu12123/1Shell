<script setup lang="ts">
// SuggestionBox.vue — 老 #terminal-inline-suggestion-box
interface Props {
  text: string;
  visible: boolean;
}
defineProps<Props>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div
    id="terminal-inline-suggestion-box"
    class="terminal-inline-suggestion-box"
    :class="{ hidden: !visible }"
  >
    <div class="terminal-inline-suggestion-head">
      <span>AI 补全建议</span>
      <button
        id="suggestion-close-btn"
        type="button"
        class="terminal-mini-btn"
        @click="emit('close')"
      >×</button>
    </div>
    <pre id="terminal-inline-suggestion-text" class="terminal-inline-suggestion-text">{{ text }}</pre>
  </div>
</template>

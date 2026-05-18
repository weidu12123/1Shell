<script setup lang="ts">
// GhostOverlay.vue — 老 #terminal-ai-overlay / #terminal-ghost-text / #terminal-ghost-hint
interface Props {
  visible: boolean;
  text: string;
  hint: string;
}
defineProps<Props>();
</script>

<template>
  <div
    class="terminal-ai-overlay"
    :class="{ hidden: !visible }"
    :aria-hidden="visible ? 'false' : 'true'"
  >
    <span v-if="text" id="terminal-ghost-text" class="terminal-ghost-text">{{ text }}</span>
    <span id="terminal-ghost-hint" class="terminal-ghost-hint">{{ hint }}</span>
  </div>
</template>

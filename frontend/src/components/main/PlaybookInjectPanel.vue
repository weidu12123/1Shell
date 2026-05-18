<script setup lang="ts">
// PlaybookInjectPanel.vue — MainConsole 刀 3 阶段 1 · Playbook 注入面板
// 1:1 复刻 [public/index.html](public/index.html) row 402-414 + [public/script-inject.js](public/script-inject.js)
import { computed } from 'vue';
import { useScriptInject } from '@/composables/useScriptInject';

const script = useScriptInject();

const stepsPreviewVisible = computed(() => {
  const pb = script.selectedPlaybook.value;
  return Boolean(pb && (pb.steps?.length ?? 0) > 0);
});
const runDisabled = computed(() =>
  script.playbookRunning.value || !script.selectedPlaybook.value || !(script.selectedPlaybook.value.steps?.length)
);
</script>

<template>
  <div v-if="script.playbookOpen.value" class="inject-panel">
    <div class="inject-panel-row">
      <span class="inject-panel-title">📘 Playbook</span>
      <select
        class="inject-select"
        :value="script.selectedPlaybookId.value"
        @change="script.onPlaybookChange(($event.target as HTMLSelectElement).value)"
      >
        <option value="">选择 Playbook…</option>
        <option v-for="p in script.playbooks.value" :key="p.id" :value="p.id">
          {{ p.icon || '📘' }} {{ p.name }}
        </option>
      </select>
      <button
        type="button"
        class="inject-primary-btn inject-primary-btn-sm"
        :disabled="runDisabled"
        @click="script.runPlaybook"
      >{{ script.playbookRunning.value ? '渲染中…' : '执行' }}</button>
      <button type="button" class="inject-close-btn" @click="script.closePlaybookPanel">✕</button>
    </div>

    <div v-if="stepsPreviewVisible" class="inject-steps-preview">
      <span class="inject-steps-count">{{ script.selectedPlaybook.value!.steps!.length }} 个步骤：</span>
      <template v-for="(step, i) in script.selectedPlaybook.value!.steps!" :key="i">
        <span class="inject-step-item">
          {{ i + 1 }}. {{ step.scriptName || step.scriptId }} →
          <span v-if="step.hostId">{{ step.hostId }}</span>
          <span v-else class="inject-step-current-host">当前主机</span>
        </span>
        <span v-if="i < (script.selectedPlaybook.value!.steps!.length - 1)" class="inject-step-sep">›</span>
      </template>
    </div>

    <!-- 1:1 沿用老版：通过 v-html 渲染拼接结果(含 pre/类名),旧 js 也是 innerHTML -->
    <div v-if="script.playbookResultVisible.value" class="inject-result-row" v-html="script.playbookResultHtml.value" />
  </div>
</template>

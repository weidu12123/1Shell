<script setup lang="ts">
// ScriptInjectPanel.vue — MainConsole 刀 3 阶段 1 · 脚本注入面板
// 1:1 复刻 [public/index.html](public/index.html) row 384-400 + [public/script-inject.js](public/script-inject.js)
// 22.3 节定调：class 用 .inject-panel，border-bottom（面板在终端上方）
import { computed } from 'vue';
import { useScriptInject } from '@/composables/useScriptInject';

const script = useScriptInject();

const paramDefs = computed(() => script.selectedScript.value?.parameters || []);
const showParams = computed(() => paramDefs.value.length > 0);
const showPreview = computed(() => Boolean(script.selectedScript.value));
</script>

<template>
  <div v-if="script.scriptOpen.value" class="inject-panel">
    <div class="inject-panel-row">
      <span class="inject-panel-title">📜 脚本注入</span>
      <select
        class="inject-select"
        :value="script.selectedScriptId.value"
        @change="script.onScriptChange(($event.target as HTMLSelectElement).value)"
      >
        <option value="">选择脚本…</option>
        <option v-for="s in script.scripts.value" :key="s.id" :value="s.id">
          {{ s.icon || '📜' }} {{ s.name }}
        </option>
      </select>
      <button type="button" class="inject-close-btn" @click="script.closeScriptPanel">✕</button>
    </div>

    <div v-if="showParams" class="inject-params-row">
      <label v-for="def in paramDefs" :key="def.name" class="inject-param">
        <span class="inject-param-label">
          {{ def.label || def.name }}<span v-if="def.required" class="inject-param-required">*</span>
        </span>
        <select
          v-if="def.type === 'boolean'"
          class="inject-param-input"
          :value="script.params[def.name] ?? 'false'"
          @change="script.updateParam(def.name, ($event.target as HTMLSelectElement).value)"
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
        <select
          v-else-if="def.type === 'select'"
          class="inject-param-input"
          :value="script.params[def.name] ?? ''"
          @change="script.updateParam(def.name, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="opt in (def.options || [])" :key="opt.value" :value="opt.value">
            {{ opt.label || opt.value }}
          </option>
        </select>
        <input
          v-else
          :type="def.type === 'number' ? 'number' : 'text'"
          class="inject-param-input inject-param-input-text"
          :value="script.params[def.name] ?? ''"
          :placeholder="def.label || def.name"
          @input="script.updateParam(def.name, ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <div v-if="showPreview" class="inject-preview-row">
      <pre class="inject-preview-code">{{ script.previewCommand.value || '（空）' }}</pre>
      <div class="inject-preview-actions">
        <button type="button" class="inject-primary-btn" @click="script.injectScript">注入终端</button>
        <button type="button" class="inject-secondary-btn" @click="script.copyScript">复制</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// AiApiConfigModal.vue — MainConsole 刀 4 · AI API 配置 modal
// 1:1 复刻 [public/index.html:659-696](public/index.html#L659-L696) + [public/ai-chat.js:247-353](public/ai-chat.js#L247-L353)
import { ref, watch } from 'vue';

import { useAiChat } from '@/composables/useAiChat';

const chat = useAiChat();

const apiBase = ref('');
const apiKey = ref('');
const model = ref('');
const errorText = ref('');
const fetching = ref(false);
const modelsHints = ref<string[]>([]);

// 打开时回填当前配置
watch(() => chat.configModalOpen.value, (open) => {
  if (!open) return;
  apiBase.value = chat.config.value.apiBase;
  apiKey.value = chat.config.value.apiKey;
  model.value = chat.config.value.model;
  errorText.value = '';
  modelsHints.value = [];
});

async function onFetchModels(): Promise<void> {
  errorText.value = '';
  if (!apiBase.value.trim() || !apiKey.value.trim()) {
    errorText.value = '请先填写 API 地址和 Key';
    return;
  }
  fetching.value = true;
  try {
    const list = await chat.fetchModels(apiBase.value, apiKey.value);
    if (!list.length) {
      errorText.value = '未能获取到模型列表，请手动输入';
      return;
    }
    modelsHints.value = list;
  } catch (err) {
    errorText.value = '获取模型失败: ' + (err as Error).message;
  } finally {
    fetching.value = false;
  }
}

function onSubmit(event: Event): void {
  event.preventDefault();
  errorText.value = '';
  const cleanBase = apiBase.value.trim().replace(/\/$/, '');
  if (!cleanBase) {
    errorText.value = 'API 基础地址不能为空';
    return;
  }
  try { new URL(cleanBase); } catch {
    errorText.value = 'API 基础地址格式不正确';
    return;
  }
  chat.saveConfig({
    apiBase: cleanBase,
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
  });
  chat.closeConfigModal();
}

function onMaskClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) chat.closeConfigModal();
}
</script>

<template>
  <div v-if="chat.configModalOpen.value" class="ai-api-modal-mask" @click="onMaskClick">
    <div class="ai-api-modal-box">
      <div class="ai-api-modal-header">
        <div>
          <div class="ai-api-modal-title">AI API 配置</div>
          <div class="ai-api-modal-subtitle">配置 OpenAI 兼容的 API 中转站地址和密钥</div>
        </div>
        <button type="button" class="ai-api-modal-close" @click="chat.closeConfigModal">关闭</button>
      </div>
      <form class="ai-api-modal-form" autocomplete="off" @submit="onSubmit">
        <div class="ai-api-form-group">
          <label for="ai-api-base-input" class="ai-api-form-label">API 基础地址</label>
          <input
            id="ai-api-base-input"
            v-model="apiBase"
            type="text"
            placeholder="https://api.openai.com/v1"
            required
            class="ai-api-form-input"
          />
          <div class="ai-api-form-help">不含 /chat/completions 的完整地址</div>
        </div>
        <div class="ai-api-form-group">
          <label for="ai-api-key-input" class="ai-api-form-label">API Key</label>
          <input
            id="ai-api-key-input"
            v-model="apiKey"
            type="password"
            placeholder="sk-..."
            autocomplete="off"
            class="ai-api-form-input"
          />
        </div>
        <div class="ai-api-form-group">
          <label for="ai-model-input" class="ai-api-form-label">模型名称</label>
          <div class="ai-api-form-row">
            <input
              id="ai-model-input"
              v-model="model"
              type="text"
              placeholder="gpt-4o"
              list="ai-model-list"
              class="ai-api-form-input"
            />
            <button
              type="button"
              class="ai-api-fetch-btn"
              :disabled="fetching"
              @click="onFetchModels"
            >{{ fetching ? '获取中…' : '获取模型' }}</button>
          </div>
          <datalist id="ai-model-list">
            <option v-for="m in modelsHints" :key="m" :value="m" />
          </datalist>
          <div class="ai-api-form-help">点击"获取模型"自动填充，也可手动输入</div>
        </div>
        <div class="ai-api-form-footer">
          <div class="ai-api-form-error">{{ errorText }}</div>
          <button type="submit" class="ai-api-form-submit">保存配置</button>
        </div>
      </form>
    </div>
  </div>
</template>

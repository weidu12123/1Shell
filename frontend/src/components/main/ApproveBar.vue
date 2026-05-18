<script setup lang="ts">
// ApproveBar.vue — MainConsole 刀 5a · 1Shell AI 安全模式审批条
// 1:1 复刻 [public/index.html:538-557](public/index.html#L538-L557) + [public/ide-panel.js:310-353](public/ide-panel.js#L310-L353)
// fixed bottom 4 + slide-up 动画；120s 倒计时由 useIdePanel 驱动
import { useIdePanel } from '@/composables/useIdePanel';

const ide = useIdePanel();

function onCustomKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ide.approveCustom();
  }
}
</script>

<template>
  <Transition name="approve-bar">
    <div v-if="ide.approveRequest.value" class="approve-bar">
      <div class="approve-bar-head">
        <span>🛡</span>
        <span class="approve-bar-title">{{ ide.approveRequest.value.title }}</span>
        <span class="approve-bar-countdown">{{ ide.approveRequest.value.countdown }}s</span>
      </div>
      <div class="approve-bar-body">
        <div class="approve-bar-desc">AI 要执行 {{ ide.approveRequest.value.toolName }}：</div>
        <pre class="approve-bar-detail">{{ ide.approveRequest.value.detail }}</pre>
      </div>
      <div class="approve-bar-foot">
        <button type="button" class="approve-bar-deny" @click="ide.approveDeny">✕ 拒绝</button>
        <div class="approve-bar-custom">
          <input
            v-model="ide.approveCustomText.value"
            type="text"
            class="approve-bar-custom-input"
            placeholder="自定义回复..."
            @keydown="onCustomKeydown"
          />
          <button type="button" class="approve-bar-custom-btn" @click="ide.approveCustom">回复</button>
        </div>
        <button type="button" class="approve-bar-allow" @click="ide.approveAllow">✓ 允许</button>
      </div>
    </div>
  </Transition>
</template>

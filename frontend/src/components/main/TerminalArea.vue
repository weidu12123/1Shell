<script setup lang="ts">
// TerminalArea.vue — MainConsole 终端区
// 严格 1:1 对照老 [public/index.html](public/index.html) row 326-426 + [public/layout.js](public/layout.js) renderTabs。
// 结构（自上而下）：terminal-tabs → 状态栏 → SuggestionBox → CmdInlinePanel → terminal-main（含 terminal-hint / terminal-container / Ghost / fab）
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AnalyzeFab from '@/components/main/AnalyzeFab.vue';
import AnalyzePanel from '@/components/main/AnalyzePanel.vue';
import CmdInlinePanel from '@/components/main/CmdInlinePanel.vue';
import GhostOverlay from '@/components/main/GhostOverlay.vue';
import PlaybookInjectPanel from '@/components/main/PlaybookInjectPanel.vue';
import ScriptInjectPanel from '@/components/main/ScriptInjectPanel.vue';
import SuggestionBox from '@/components/main/SuggestionBox.vue';
import { useCommandSuggestion } from '@/composables/useCommandSuggestion';
import { useScriptInject } from '@/composables/useScriptInject';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useTerminalAi } from '@/composables/useTerminalAi';
import { useTerminalAnalyze } from '@/composables/useTerminalAnalyze';
import { useHostsStore } from '@/stores/hosts';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { SessionInfo } from '@/utils/terminal';

const emit = defineEmits<{
  'host-change': [hostId: string];
  'host-close': [hostId: string];
  'fullscreen-toggle': [value: boolean];
}>();

const hosts = useHostsStore();
const sessionTerminal = useSessionTerminal();
const terminalAi = useTerminalAi();
const commandSuggestion = useCommandSuggestion();
const scriptInject = useScriptInject();
const terminalAnalyze = useTerminalAnalyze();

const terminalEl = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const showSuggestionBox = ref(true);

const activeHost = computed(() => hosts.hostMap.get(sessionTerminal.activeHostId.value) || hosts.hostMap.get(LOCAL_HOST_ID) || null);
const statusDotClass = computed(() => sessionTerminal.statusKind.value);
const sessionsList = computed(() => [...sessionTerminal.sessions.value.values()].filter((s) => s.status !== 'closed'));
const aiContextText = computed(() => activeHost.value ? `当前上下文：${activeHost.value.name}` : '当前上下文：本机');

function tabName(session: SessionInfo): string {
  return hosts.hostMap.get(session.hostId)?.name || session.hostName || session.hostId;
}

function tabMeta(session: SessionInfo): string {
  const host = hosts.hostMap.get(session.hostId);
  if (!host) return '';
  return host.type === 'local' ? '本地' : (host.host || '');
}

function switchSession(session: SessionInfo): void {
  emit('host-change', session.hostId);
}

function closeSession(session: SessionInfo, event: MouseEvent): void {
  event.stopPropagation();
  sessionTerminal.closeHostSession(session.hostId);
  emit('host-close', session.hostId);
}

function reconnect(): void {
  const hostId = sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  sessionTerminal.connectToHost(hostId, true).catch(() => { /* 静默 */ });
}

function clearTerminal(): void {
  sessionTerminal.clearTerminal();
}

function toggleCommandPanel(): void {
  if (commandSuggestion.isOpen.value) commandSuggestion.closeCmdModal();
  else commandSuggestion.openCmdModal();
}

function toggleFullscreen(): void {
  isFullscreen.value = !isFullscreen.value;
  emit('fullscreen-toggle', isFullscreen.value);
  setTimeout(() => sessionTerminal.focusTerminal(), 60);
}

function closeSuggestion(): void {
  showSuggestionBox.value = false;
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
}

onMounted(() => {
  if (terminalEl.value) sessionTerminal.mount(terminalEl.value);
  terminalAi.initialize();
  commandSuggestion.initialize();
  scriptInject.initialize();
  terminalAnalyze.initialize();
  setTimeout(() => sessionTerminal.focusTerminal(), 80);
});

onBeforeUnmount(() => {
  sessionTerminal.unmount();
  emit('fullscreen-toggle', false);
});
</script>

<template>
  <section class="terminal-area" :class="{ fullscreen: isFullscreen }">
    <!-- 终端 tabs（老 index.html row 329-336 + layout.js renderTabs） -->
    <div id="terminal-tabs" class="terminal-tabs">
      <div
        v-for="session in sessionsList"
        :key="session.id"
        :data-tab-host="session.hostId"
        class="terminal-tab"
        :class="{ active: session.id === sessionTerminal.activeSessionId.value }"
        @click="switchSession(session)"
      >
        <span class="terminal-tab-status" :class="`status-${session.status}`"></span>
        <span class="terminal-tab-name">{{ tabName(session) }}</span>
        <span class="terminal-tab-meta">{{ tabMeta(session) }}</span>
        <button
          type="button"
          class="terminal-tab-close"
          :data-tab-close="session.hostId"
          @click="closeSession(session, $event)"
        >×</button>
      </div>
      <!-- "+ 新终端"：第 16 节决策 A，dead button 不绑 handler（仅渲染） -->
      <button class="terminal-tab-add" type="button">+ 新终端</button>
    </div>

    <!-- 状态栏（老 index.html row 339-354） -->
    <div class="terminal-toolbar">
      <div class="terminal-status-wrap">
        <span id="session-status-dot" class="status-dot" :class="statusDotClass"></span>
        <span id="session-status-text" class="terminal-status-text">{{ sessionTerminal.statusText.value }}</span>
        <span
          id="terminal-inline-preview"
          class="terminal-inline-preview"
          :class="{ hidden: !terminalAi.inlinePreviewText.value }"
        >{{ terminalAi.inlinePreviewText.value }}</span>
        <span id="ai-context-text" class="ai-context-text" :class="{ hidden: !activeHost }">
          {{ aiContextText }}
        </span>
      </div>
      <div class="terminal-actions">
        <button
          id="inject-script-btn"
          type="button"
          class="terminal-action-btn purple"
          :class="{ active: scriptInject.scriptOpen.value }"
          title="快捷执行脚本库中的脚本"
          @click="scriptInject.scriptOpen.value ? scriptInject.closeScriptPanel() : scriptInject.openScriptPanel()"
        >脚本</button>
        <button
          id="inject-playbook-btn"
          type="button"
          class="terminal-action-btn purple"
          :class="{ active: scriptInject.playbookOpen.value }"
          title="快捷执行 Playbook 编排"
          @click="scriptInject.playbookOpen.value ? scriptInject.closePlaybookPanel() : scriptInject.openPlaybookPanel()"
        >Playbook</button>
        <button id="reconnect-btn" type="button" class="terminal-action-btn" @click="reconnect">重连</button>
        <button id="cmd-suggest-btn" type="button" class="terminal-action-btn" :class="{ active: commandSuggestion.isOpen.value }" @click="toggleCommandPanel">AI 命令</button>
        <button id="clear-term-btn" type="button" class="terminal-action-btn" @click="clearTerminal">清屏</button>
        <button
          id="fullscreen-btn"
          type="button"
          class="terminal-action-btn"
          title="全屏终端"
          @click="toggleFullscreen"
        >{{ isFullscreen ? '退出全屏' : '全屏' }}</button>
      </div>
    </div>

    <!-- 补全建议占位条（老 #terminal-inline-suggestion-box，shrink-0 普通块） -->
    <SuggestionBox
      :text="terminalAi.suggestionText.value"
      :visible="showSuggestionBox && terminalAi.ghostVisible.value"
      @close="closeSuggestion"
    />

    <!-- AI 命令面板（老 #cmd-inline-panel，hidden 时不占空间） -->
    <CmdInlinePanel />

    <!-- 脚本注入面板（22.3 节：CmdInlinePanel 之后,terminal-main 之前） -->
    <ScriptInjectPanel />

    <!-- Playbook 注入面板（22.3 节：紧跟 ScriptInjectPanel） -->
    <PlaybookInjectPanel />

    <!-- 终端主体（老 row 417-425：flex-1 min-h-0 relative；hint / container / overlay / fab 全部 absolute 在此） -->
    <div class="terminal-main">
      <div
        id="terminal-hint"
        class="terminal-hint"
        :class="{ hidden: !sessionTerminal.terminalHint.value }"
      >{{ sessionTerminal.terminalHint.value }}</div>
      <div id="terminal-container" ref="terminalEl" class="terminal-container"></div>
      <GhostOverlay
        :visible="terminalAi.ghostVisible.value"
        :text="terminalAi.ghostText.value"
        :hint="terminalAi.ghostHint.value"
      />
      <!-- 选区分析 FAB（terminal-main 内,与 GhostOverlay 同级 absolute） -->
      <AnalyzeFab />
    </div>

    <!-- AI 选区分析底部 docked 横向条（与 terminal-main 同列,不挡左右栏） -->
    <AnalyzePanel />
  </section>
</template>

<script setup lang="ts">
// MainConsole 主控台 — 老 [public/index.html](public/index.html) 入口
// 刀 1：登录 + 壳 + 顶栏 + Settings + Host 管理（其它三栏为 placeholder，留给刀 2-5）
import { ref, computed, onMounted, onActivated, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useAuthStore } from '@/stores/auth';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { useConfirm } from '@/composables/useConfirm';
import { useTopbarProbe } from '@/composables/useTopbarProbe';
import { readStorageState, writeStorageState } from '@/composables/usePageState';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { MainHost, HostFormPayload, HostLink } from '@/utils/mainConsole';

import TopBar from '@/components/main/TopBar.vue';
import HostListSidebar from '@/components/main/HostListSidebar.vue';
import TerminalArea from '@/components/main/TerminalArea.vue';
import HostModal from '@/components/main/HostModal.vue';
import SettingsModal from '@/components/main/SettingsModal.vue';
import AnalyzeContextMenu from '@/components/main/AnalyzeContextMenu.vue';
import FileBrowserPanel from '@/components/main/FileBrowserPanel.vue';
import AiChatPanel from '@/components/main/AiChatPanel.vue';
import IdePanel from '@/components/main/IdePanel.vue';
import ApproveBar from '@/components/main/ApproveBar.vue';
import AgentPanel from '@/components/main/AgentPanel.vue';

const { requestJson } = useApiClient();
const auth = useAuthStore();
const hosts = useHostsStore();
const notify = useNotifyStore();
const { confirm } = useConfirm();
const sessionTerminal = useSessionTerminal();
try { hosts.setFilterKeyword(localStorage.getItem('1shell.console.host-filter') || ''); } catch { /* ignore */ }

const activeHostId = sessionTerminal.activeHostId;
const probe = useTopbarProbe(activeHostId);
const route = useRoute();
const CONSOLE_PREFS_KEY = '1shell.console.page.prefs.v1';
const consolePrefs = readStorageState(CONSOLE_PREFS_KEY, {
  sidebarCollapsed: false,
  aiPanelCollapsed: false,
  terminalFullscreen: false,
  rightTab: 'chat' as 'chat' | 'ide' | 'agent',
});

const sidebarCollapsed = ref(consolePrefs.sidebarCollapsed);
const aiPanelCollapsed = ref(consolePrefs.aiPanelCollapsed);
const terminalFullscreen = ref(consolePrefs.terminalFullscreen);
const darkMode = ref(document.documentElement.classList.contains('dark'));

function saveConsolePrefs(): void {
  writeStorageState(CONSOLE_PREFS_KEY, {
    sidebarCollapsed: sidebarCollapsed.value,
    aiPanelCollapsed: aiPanelCollapsed.value,
    terminalFullscreen: terminalFullscreen.value,
    rightTab: rightTab.value,
  });
}

// Host modal
const hostModalOpen = ref(false);
const hostEditing = ref<MainHost | null>(null);
const hostModalRef = ref<InstanceType<typeof HostModal> | null>(null);

// Settings modal
const settingsOpen = ref(false);

const sshHosts = computed(() => hosts.items.filter((h: MainHost) => h.type === 'ssh' || h.id !== LOCAL_HOST_ID));

interface HostsListResponse {
  hosts?: MainHost[];
  warnings?: { usingFallbackSecret?: boolean };
}

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<HostsListResponse>('/api/hosts');
    hosts.setHosts(data.hosts || []);
    hosts.setSecretWarning(Boolean(data.warnings?.usingFallbackSecret));

    // ?host=<id> 优先 (来自地图主页「立即连接」)
    // socket connect handler 会基于 activeHostId.value 自动连接
    const queryHost = typeof route.query.host === 'string' ? route.query.host : null;
    if (queryHost && hosts.hostMap.has(queryHost)) {
      activeHostId.value = queryHost;
      hosts.select(queryHost);
      return;
    }

    if (!hosts.hostMap.has(activeHostId.value)) {
      activeHostId.value = LOCAL_HOST_ID;
    }
    hosts.select(activeHostId.value);
  } catch (err) {
    notify.error((err as Error).message || '加载主机列表失败');
  }
}

// auth gate 由 App.vue 顶层负责；进到这里说明已登录或 auth 关闭。
async function bootstrapConsole(): Promise<void> {
  try {
    await loadHosts();
    sessionTerminal.connectSocket();
  } catch (err) {
    notify.error((err as ApiError | Error).message || '主控初始化失败');
  }
}

onMounted(() => { void bootstrapConsole(); });
onBeforeUnmount(() => { sessionTerminal.disconnectSocket(); });

async function onLogout(): Promise<void> {
  const ok = await confirm({ title: '退出登录', message: '确认退出当前账号？', okText: '退出' });
  if (!ok) return;
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
  } catch { /* 静默 */ }
  sessionTerminal.disconnectSocket();
  auth.logout();
  hosts.setHosts([]);
}

// Topbar actions
function openAddHost(): void {
  hostEditing.value = null;
  hostModalOpen.value = true;
}

function onSidebarToggle(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  saveConsolePrefs();
}

function onAiPanelToggle(): void {
  aiPanelCollapsed.value = !aiPanelCollapsed.value;
  saveConsolePrefs();
}

function toggleTheme(): void {
  const cur = document.documentElement.classList.contains('dark');
  const next = !cur;
  document.documentElement.classList.toggle('dark', next);
  localStorage.setItem('1shell-theme', next ? 'dark' : 'light');
  darkMode.value = next;
}

// Host list actions
function onHostConnect(hostId: string): void {
  activeHostId.value = hostId;
  hosts.select(hostId);
  // 记住最近连接主机，供主页"最近主机"卡使用
  if (hostId && hostId !== LOCAL_HOST_ID) {
    try { localStorage.setItem('1shell-last-host', hostId); } catch { /* ignore */ }
  }
  sessionTerminal.connectToHost(hostId, false).catch((err) => {
    notify.error((err as Error).message || '连接主机失败');
  });
}

function activateQueryHost(): void {
  const queryHost = typeof route.query.host === 'string' ? route.query.host : null;
  if (!queryHost || !hosts.hostMap.has(queryHost) || activeHostId.value === queryHost) return;
  onHostConnect(queryHost);
}

onActivated(() => {
  activateQueryHost();
});

watch(() => route.query.host, () => {
  activateQueryHost();
});

function onHostEdit(hostId: string): void {
  const h = hosts.hostMap.get(hostId);
  if (!h) return;
  hostEditing.value = h;
  hostModalOpen.value = true;
}

async function onHostDelete(hostId: string): Promise<void> {
  const h = hosts.hostMap.get(hostId);
  if (!h) return;
  const ok = await confirm({ title: '删除主机', message: `确认删除主机"${h.name}"吗？`, okText: '删除' });
  if (!ok) return;
  try {
    await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });
    if (activeHostId.value === hostId) {
      sessionTerminal.closeHostSession(hostId);
      activeHostId.value = LOCAL_HOST_ID;
    }
    await loadHosts();
    notify.success('主机已删除');
  } catch (err) {
    notify.error((err as Error).message);
  }
}

async function onHostSubmit(
  payload: HostFormPayload | { isLocal: true; name: string; links: HostLink[] },
  hostId: string | null
): Promise<void> {
  try {
    if ('isLocal' in payload && payload.isLocal) {
      await requestJson('/api/hosts/local-config', {
        method: 'PUT',
        body: JSON.stringify({ name: payload.name, links: payload.links }),
      });
    } else if (hostId) {
      await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await requestJson('/api/hosts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    await loadHosts();
    hostModalOpen.value = false;
    notify.success(hostId === LOCAL_HOST_ID ? '本机配置已更新' : (hostId ? '主机已更新' : '主机已添加'));
  } catch (err) {
    hostModalRef.value?.setError((err as Error).message);
  }
}

// 刀 5a/5b 拍板：右栏 tab 切换（feedback-right-aside-tabs）
const rightTab = ref<'chat' | 'ide' | 'agent'>(consolePrefs.rightTab);
function onTerminalFullscreen(value: boolean): void {
  terminalFullscreen.value = value;
  saveConsolePrefs();
}

// 右栏 tab 切换时也要 refit（IDE↔Chat↔Agent 宽度从 40%↔20%↔40% 切换）
watch(rightTab, () => {
  saveConsolePrefs();
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
});

watch(() => hosts.filterKeyword, () => {
  try { localStorage.setItem('1shell.console.host-filter', hosts.filterKeyword); } catch { /* ignore */ }
});

// 左栏（主机列表 + 文件浏览器）垂直分隔条 — 拖拽调整两块占比,localStorage 持久化
const LEFT_SPLIT_KEY = '1shell-left-split';
const LEFT_SPLIT_TOTAL = 10;
const LEFT_SPLIT_MIN = 1;

const leftAsideRef = ref<HTMLElement | null>(null);
const hostFlex = ref(5);
const fileFlex = computed(() => Math.max(LEFT_SPLIT_MIN, LEFT_SPLIT_TOTAL - hostFlex.value));

(function loadSavedSplit(): void {
  const raw = localStorage.getItem(LEFT_SPLIT_KEY);
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= LEFT_SPLIT_MIN && n <= LEFT_SPLIT_TOTAL - LEFT_SPLIT_MIN) {
    hostFlex.value = n;
  }
})();

let dragStartY = 0;
let dragStartHostFlex = 5;
let dragAsideHeight = 0;

function onSplitMouseMove(event: MouseEvent): void {
  const delta = event.clientY - dragStartY;
  if (!dragAsideHeight) return;
  const deltaFlex = (delta / dragAsideHeight) * LEFT_SPLIT_TOTAL;
  const next = Math.min(
    LEFT_SPLIT_TOTAL - LEFT_SPLIT_MIN,
    Math.max(LEFT_SPLIT_MIN, dragStartHostFlex + deltaFlex)
  );
  hostFlex.value = next;
}

function onSplitMouseUp(): void {
  document.removeEventListener('mousemove', onSplitMouseMove);
  document.removeEventListener('mouseup', onSplitMouseUp);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  localStorage.setItem(LEFT_SPLIT_KEY, String(hostFlex.value));
}

function onSplitMouseDown(event: MouseEvent): void {
  if (!leftAsideRef.value) return;
  event.preventDefault();
  dragStartY = event.clientY;
  dragStartHostFlex = hostFlex.value;
  dragAsideHeight = leftAsideRef.value.clientHeight;
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onSplitMouseMove);
  document.addEventListener('mouseup', onSplitMouseUp);
}

function onSplitDoubleClick(): void {
  hostFlex.value = 5;
  localStorage.setItem(LEFT_SPLIT_KEY, '5');
}
</script>

<template>
  <!-- auth gate 由 App.vue 顶层负责；这里假定已登录。 -->
  <!-- 主壳。h-screen + overflow-hidden 强制占满 viewport,杜绝内部内容撑大整页 -->
  <div class="flex flex-col min-w-0 p-2 gap-2 h-screen min-h-0 overflow-hidden">

    <!-- 顶栏 -->
    <TopBar
      v-if="!terminalFullscreen"
      :host-name="probe.displayName.value"
      :cpu="probe.cpuText.value"
      :memory="probe.memoryText.value"
      :load="probe.loadText.value"
      :disk="probe.diskText.value"
      :dark-mode="darkMode"
      @add-host="openAddHost"
      @toggle-sidebar="onSidebarToggle"
      @toggle-ai-panel="onAiPanelToggle"
      @open-settings="settingsOpen = true"
      @toggle-theme="toggleTheme"
      @mobile-menu="onSidebarToggle"
    />

    <!-- 三栏主内容 -->
    <div class="flex flex-1 gap-2 min-h-0">

      <!-- 左栏：主机列表 + 文件树（文件树刀 3） -->
      <aside
        ref="leftAsideRef"
        class="w-[20%] shrink-0 flex flex-col gap-2 min-h-0 relative transition-all duration-300"
        :class="{ hidden: sidebarCollapsed || terminalFullscreen }"
      >
        <HostListSidebar
          :hosts="hosts.filteredItems"
          :active-host-id="activeHostId"
          :search-keyword="hosts.filterKeyword"
          :show-secret-warning="hosts.secretWarning"
          :flex="hostFlex"
          @update:search-keyword="hosts.setFilterKeyword"
          @connect="onHostConnect"
          @edit="onHostEdit"
          @delete="onHostDelete"
          @toggle-collapsed="() => { /* 单区折叠：刀 1 暂不实现，刀 2 layout 一起做 */ }"
        />
        <!-- 垂直分隔条：拖拽调整主机列表 / 文件浏览器占比；双击恢复默认 5:5 -->
        <div
          class="left-split-handle"
          title="拖拽调整上下占比；双击恢复默认"
          @mousedown="onSplitMouseDown"
          @dblclick="onSplitDoubleClick"
        >
          <span class="left-split-handle-grip" />
        </div>
        <!-- 文件浏览器（刀 3 阶段 2）—— 20.4 节硬边界：自身容器内滚动,不外溢 -->
        <div
          class="rounded-2xl flex flex-col overflow-hidden"
          :style="{ flex: fileFlex, minHeight: 0 }"
        >
          <FileBrowserPanel />
        </div>
      </aside>

      <!-- 中栏：终端（刀 2 填充） -->
      <main class="flex-1 flex flex-col min-w-0 min-h-0 rounded-2xl overflow-hidden">
        <TerminalArea
          @host-change="onHostConnect"
          @fullscreen-toggle="onTerminalFullscreen"
        />
      </main>

      <!-- 右栏：AI Chat / 1Shell AI / AI Agent tab 切换（刀 4 + 刀 5a + 刀 5b） -->
      <!-- 宽度跟随 tab：IDE/Agent 激活时 w-[40%]（整体 2:4:4 同老版 setIdePanelOpen/setAgentPanelOpen）；AI Chat 时 w-[20%] -->
      <aside
        v-if="!aiPanelCollapsed && !terminalFullscreen"
        class="shrink-0 flex flex-col min-h-0 rounded-2xl overflow-hidden transition-all duration-300 ease-in-out"
        :class="rightTab === 'ide' || rightTab === 'agent' ? 'w-[40%]' : 'w-[20%]'"
      >
        <!-- tab 头：feedback-right-aside-tabs 拍板 -->
        <div class="ai-side-tabs">
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': rightTab === 'chat' }"
            @click="rightTab = 'chat'"
          >AI Chat</button>
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': rightTab === 'ide' }"
            @click="rightTab = 'ide'"
          >1Shell AI</button>
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': rightTab === 'agent' }"
            @click="rightTab = 'agent'"
          >AI Agent</button>
        </div>
        <div class="ai-side-tab-content">
          <AiChatPanel v-show="rightTab === 'chat'" />
          <IdePanel v-show="rightTab === 'ide'" />
          <AgentPanel v-show="rightTab === 'agent'" />
        </div>
      </aside>
    </div>

    <!-- Host 编辑 modal -->
    <HostModal
      ref="hostModalRef"
      :open="hostModalOpen"
      :editing="hostEditing"
      :ssh-hosts="sshHosts"
      @close="hostModalOpen = false"
      @submit="onHostSubmit"
    />

    <!-- Settings modal -->
    <SettingsModal
      :open="settingsOpen"
      @close="settingsOpen = false"
    />

    <!-- 选区分析右键菜单（position:fixed 全局,挂在 terminal-area 外；分析面板已 dock 到 TerminalArea 内底部） -->
    <AnalyzeContextMenu />

    <!-- 1Shell AI 安全模式审批条（刀 5a · fixed bottom 4 全局浮层） -->
    <ApproveBar />

    <!-- 左侧栏退出按钮（占位：AppSidebar 已有，这里仅作 listener — 刀 1 后期由 AppSidebar 触发 onLogout） -->
    <!-- TODO 刀 1 完工后：AppSidebar 内"退出"按钮 emit 触发本组件 onLogout -->
  </div>
</template>

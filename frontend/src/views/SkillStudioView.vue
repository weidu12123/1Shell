<script setup lang="ts">
// IDE 工作台（skill-studio） — 老 skill-studio.html (516) + skill-studio.js (934) 主入口
// 迭代 1：全部 UI 骨架 + 7 socket on + 5 emit + deploy_mcp + refine 入口 + 历史抽屉 + 文件浏览器
// 迭代 2 接：安全模式审批条 + 本地 MCP 启停
import { ref } from 'vue';
import { useStudioRunner } from '@/composables/useStudioRunner';
import HostList from '@/components/studio/HostList.vue';
import PathList from '@/components/studio/PathList.vue';
import ContainerPane from '@/components/studio/ContainerPane.vue';
import ToolPane from '@/components/studio/ToolPane.vue';
import ChatArea from '@/components/studio/ChatArea.vue';
import InputArea from '@/components/studio/InputArea.vue';
import HistoryDrawer from '@/components/studio/HistoryDrawer.vue';
import FilePickerModal from '@/components/studio/FilePickerModal.vue';
import ApproveBar from '@/components/studio/ApproveBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const r = useStudioRunner();

// 文件浏览器开关 + 主机池
const fpOpen = ref(false);
function openFilePicker(): void {
  fpOpen.value = true;
}
</script>

<template>
  <div class="flex w-full h-screen overflow-hidden">
    <!-- 历史抽屉（侧栏右侧） -->
    <HistoryDrawer
      :open="r.historyDrawerOpen.value"
      :sessions="r.sessions.value"
      :current-session-id="r.currentSessionId.value"
      :residual-count-for-session="r.residualCountForSession"
      @new-session="r.startNewChat"
      @switch-to="(id: string) => r.switchSession(id)"
      @delete="(id: string) => r.deleteSession(id)"
      @cleanup-residuals="(id: string) => r.cleanupSessionResiduals(id)"
    />

    <!-- 主区域 -->
    <div class="flex flex-col flex-1 min-w-0 min-h-0 p-2 gap-2">

      <!-- 顶栏 -->
      <header class="relative shrink-0 h-14 flex items-center px-5 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] shadow-sm">
        <div class="flex items-center gap-3 shrink-0">
          <span class="w-9 h-9 rounded-xl bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-300 flex items-center justify-center">
            <AppIcon name="pen" :size="20" />
          </span>
          <div>
            <div class="text-base font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              IDE 工作台
              <span class="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300 font-semibold">IDE</span>
            </div>
            <div class="text-[11px] text-slate-400">选主机/文件/容器 · 自然语言描述 → AI 自由创作 · 多轮迭代</div>
          </div>
        </div>
        <div class="flex-1"></div>
        <div class="flex items-center gap-2">
          <button
            class="text-[11px] px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 inline-flex items-center gap-1"
            title="新建对话"
            @click="r.startNewChat"
          >
            <AppIcon name="plus" :size="12" />
            <span>新建</span>
          </button>
          <button
            class="text-[11px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b] inline-flex items-center gap-1 text-slate-700 dark:text-slate-200"
            title="创作历史"
            @click="r.toggleHistoryDrawer"
          >
            <AppIcon name="history" :size="12" />
            <span>历史</span>
          </button>
          <RouterLink
            to="/skills"
            class="text-[11px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-[#1e293b] hover:bg-slate-100 dark:hover:bg-[#1e293b] text-slate-700 dark:text-slate-200"
          >← 仓库</RouterLink>
        </div>
      </header>

      <!-- 三栏主内容 -->
      <div class="flex flex-1 gap-2 min-h-0">

        <!-- 左栏：主机 + 路径 -->
        <aside class="w-[22%] shrink-0 flex flex-col gap-2 min-h-0">
          <HostList
            :hosts="r.allHosts.value"
            :selected-ids="new Set(r.selectedHosts.value.keys())"
            @toggle="(id: string) => r.toggleHost(id)"
          />
          <PathList
            :paths="r.selectedPaths.value"
            :host-name="r.hostName"
            @add="(p: string) => r.addPath(p)"
            @remove="(i: number) => r.removePath(i)"
            @browse="openFilePicker"
          />
        </aside>

        <!-- 中栏：chat + 输入 -->
        <main class="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
          <div
            v-if="r.authoringSession.value"
            class="shrink-0 rounded-2xl border border-purple-200/80 bg-purple-50/80 px-3 py-2 text-xs text-purple-800 dark:border-purple-500/20 dark:bg-purple-500/10 dark:text-purple-200"
          >
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="font-semibold">Authoring Session · {{ r.authoringSession.value.intent }} · {{ r.authoringSession.value.risk }} risk</div>
              <div class="text-[11px] opacity-80">当前阶段：{{ r.authoringStageText.value }}</div>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="item in r.authoringStages.value"
                :key="item.stage"
                class="px-2 py-1 rounded-full border"
                :class="item.active
                  ? 'border-purple-500 bg-purple-600 text-white'
                  : item.done
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                    : 'border-purple-200/80 bg-white/60 text-purple-500 dark:border-purple-500/20 dark:bg-transparent dark:text-purple-300/70'"
              >{{ item.label }}</span>
            </div>
          </div>
          <ChatArea
            :messages="r.currentMessages.value"
            :run-status-text="r.runStatusText.value"
            :show-clear-button="r.currentMessages.value.length > 0"
            @clear="r.clearCurrentChat"
            @authoring-reply="(interaction, value, label) => r.respondAuthoring(interaction, value, label)"
          />
          <InputArea
            :task-value="r.taskInput.value"
            :summary="r.summaryText.value"
            :safe-mode="r.safeMode.value"
            :unlimited-turns="r.unlimitedTurns.value"
            :cc-collab="r.ccCollab.value"
            :refined-mode="r.refinedMode.value"
            :is-running="r.isRunning.value"
            @update:task-value="(v: string) => (r.taskInput.value = v)"
            @send="r.onSend"
            @stop="r.onStop"
            @update:safe-mode="(v: boolean) => r.setSafeMode(v)"
            @update:unlimited-turns="(v: boolean) => r.setUnlimitedTurns(v)"
            @update:cc-collab="(v: boolean) => r.setCcCollab(v)"
            @update:refined-mode="(v: boolean) => r.setRefinedMode(v)"
          />
        </main>

        <!-- 右栏：容器 + 工具 -->
        <aside class="w-[24%] shrink-0 flex flex-col gap-2 min-h-0">
          <ContainerPane
            :all-hosts="r.allHosts.value"
            :host-name="r.hostName"
            :scan-host-id="r.scanHostId.value"
            :scanning="r.scanning.value"
            :scan-result="r.containerScan.value"
            :pinned-map="r.selectedContainers.value"
            :is-selected="r.isContainerSelected"
            @update:scan-host-id="(v: string) => (r.scanHostId.value = v)"
            @scan="r.scanContainers"
            @toggle="(hid, c) => r.toggleContainer(hid, c)"
            @unpin="(key: string) => r.unpinContainer(key)"
          />
          <ToolPane
            :filter="r.toolFilter.value"
            :items="r.filteredToolItems.value"
            :total-count="r.toolItems.value.length"
            :selected-count="r.selectedTools.value.size"
            :selected-keys="r.selectedTools.value"
            :item-key="r.toolItemKey"
            @update:filter="(v) => (r.toolFilter.value = v)"
            @toggle="(it) => r.toggleTool(it)"
          />
        </aside>

      </div>
    </div>

    <!-- 文件浏览器模态 -->
    <FilePickerModal
      :open="fpOpen"
      :pool="r.selectedHosts.value.size > 0 ? [...r.selectedHosts.value.values()] : r.allHosts.value"
      :selected-paths="r.selectedPaths.value"
      :load-dir="r.loadFpDir"
      @close="fpOpen = false"
      @pick="(hid: string, p: string) => r.addPickedPath(hid, p)"
    />

    <!-- 安全模式审批条（底部浮出 · 迭代 2） -->
    <ApproveBar
      :payload="r.pendingApprove.value"
      :countdown="r.approveCountdown.value"
      @respond="(action, text) => r.respondApprove(action, text)"
    />
  </div>
</template>

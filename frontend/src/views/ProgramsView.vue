<script setup lang="ts">
import { ref } from 'vue';
import { useProgramsRunner } from '@/composables/useProgramsRunner';
import ProgramDetail from '@/components/programs/ProgramDetail.vue';
import AskModal from '@/components/programs/AskModal.vue';
import ProgramRunModal from '@/components/programs/ProgramRunModal.vue';

const r = useProgramsRunner();

const showProgramsMenu = ref(false);
const showResidualMenu = ref(false);
const showStatsMenu = ref(false);

function toggleProgramsMenu(): void {
  showProgramsMenu.value = !showProgramsMenu.value;
  showResidualMenu.value = false;
  showStatsMenu.value = false;
}

function toggleResidualMenu(): void {
  showResidualMenu.value = !showResidualMenu.value;
  showProgramsMenu.value = false;
  showStatsMenu.value = false;
}

function toggleStatsMenu(): void {
  showStatsMenu.value = !showStatsMenu.value;
  showProgramsMenu.value = false;
  showResidualMenu.value = false;
}

function closeMenus(): void {
  showProgramsMenu.value = false;
  showResidualMenu.value = false;
  showStatsMenu.value = false;
}

function selectProgram(id: string): void {
  if (r.activeProgramId.value === id) {
    r.activeProgramId.value = null;
  } else {
    r.selectProgram(id);
  }
  showProgramsMenu.value = false;
}

function triggerTypes(p: { triggers?: { type: string }[] }): string {
  return [...new Set((p.triggers || []).map((t) => t.type))].join(' · ') || '无 trigger';
}

function hostLabel(p: { hosts?: string | string[] }): string {
  if (p.hosts === 'all') return '所有主机';
  if (Array.isArray(p.hosts)) return `${p.hosts.length} 台主机`;
  return '—';
}
</script>

<template>
  <div class="flex flex-col flex-1 min-w-0 p-2 gap-2 h-full">

    <!-- 顶栏 -->
    <header class="topbar shrink-0 h-14 flex items-center px-5 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#111827] shadow-sm gap-3 relative z-50">
      <span class="text-2xl text-slate-700 dark:text-slate-200">⚙</span>
      <div class="min-w-0">
        <div class="text-base font-bold text-slate-700 dark:text-slate-200">长驻程序</div>
        <div class="text-[11px] text-slate-400">Program Engine · cron / 手动 / 审计</div>
      </div>

      <!-- 程序列表 按钮 + 浮层 — 紧跟标题 -->
      <div class="relative ml-4">
        <button
          class="h-9 px-4 rounded-xl text-sm font-semibold transition-all border"
          :class="showProgramsMenu ? 'bg-blue-500 text-white border-blue-500' : 'bg-white dark:bg-[#1a2332] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-[#1e293b] hover:border-blue-300 hover:text-blue-500'"
          @click="toggleProgramsMenu"
        >☰ 程序列表 <span class="ml-1 text-[11px] opacity-70">{{ r.programs.value.length }}</span></button>

        <div
          v-if="showProgramsMenu"
          class="absolute top-full left-0 mt-1.5 w-72 bg-white dark:bg-[#111827] rounded-xl border border-slate-200 dark:border-[#1e293b] shadow-xl z-50 overflow-hidden"
        >
          <div class="px-3 py-2 border-b border-slate-100 dark:border-[#1e293b] text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Programs</div>
          <div v-if="r.programs.value.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">
            尚无 Program<br>
            <span class="opacity-60">放到 data/programs/&lt;id&gt;/program.yaml 并点"重扫"</span>
          </div>
          <div class="max-h-72 overflow-auto p-2 flex flex-col gap-1">
            <div
              v-for="p in r.programs.value"
              :key="p.id"
              class="px-3 py-2 rounded-lg cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-[#1a2332]"
              :class="p.id === r.activeProgramId.value ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800' : 'border border-transparent'"
              @click="selectProgram(p.id)"
            >
              <div class="flex items-center gap-2">
                <span class="flex-1 text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">{{ p.name }}</span>
                <span class="badge" :class="p.enabled ? 'badge-ok' : 'badge-idle'">{{ p.enabled ? '已启用' : '未启用' }}</span>
                <button
                  class="shrink-0 text-[11px] px-1.5 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600 dark:border-red-800 dark:hover:bg-red-900/30 transition-colors"
                  title="删除"
                  @click.stop="r.deleteProgram(p.id, p.name)"
                >删</button>
              </div>
              <div class="text-[10px] text-slate-400 mt-0.5">{{ triggerTypes(p) }} · {{ hostLabel(p) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 无效/残留 Program 面板 -->
      <div class="relative">
        <button
          class="h-9 px-4 rounded-xl text-sm font-semibold transition-all border"
          :class="showResidualMenu ? 'bg-red-500 text-white border-red-500' : r.residualPrograms.value.length ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-300 border-red-200 dark:border-red-900 hover:border-red-300' : 'bg-white dark:bg-[#1a2332] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-[#1e293b] hover:border-blue-300 hover:text-blue-500'"
          @click="toggleResidualMenu"
        >⚠ 无效 <span class="ml-1 text-[11px] opacity-70">{{ r.residualPrograms.value.length }}</span></button>

        <div
          v-if="showResidualMenu"
          class="absolute top-full left-0 mt-1.5 w-[28rem] bg-white dark:bg-[#111827] rounded-xl border border-slate-200 dark:border-[#1e293b] shadow-xl z-50 overflow-hidden"
        >
          <div class="px-3 py-2 border-b border-slate-100 dark:border-[#1e293b] text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Invalid / Residual Programs</div>
          <div v-if="r.residualPrograms.value.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">
            没有发现加载失败或残留 Program。
          </div>
          <div class="max-h-80 overflow-auto p-2 flex flex-col gap-2">
            <div
              v-for="item in r.residualPrograms.value"
              :key="item.id"
              class="rounded-lg border border-red-100 bg-red-50/70 p-3 dark:border-red-900/60 dark:bg-red-950/20"
            >
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-semibold text-red-700 dark:text-red-300">{{ item.id }}</span>
                <button
                  class="shrink-0 text-[11px] px-2 py-1 rounded border border-red-200 text-red-500 hover:bg-red-100 hover:text-red-700 dark:border-red-800 dark:hover:bg-red-900/30 transition-colors"
                  @click="r.deleteResidualProgram(item.id)"
                >删除残留</button>
              </div>
              <div class="mt-1 text-[11px] text-red-600 dark:text-red-300 whitespace-pre-wrap">{{ item.error }}</div>
              <div v-if="item.path" class="mt-1 truncate text-[10px] text-slate-400">{{ item.path }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 统计 按钮 + 浮层 — 紧跟程序列表 -->
      <div class="relative">
        <button
          class="h-9 px-4 rounded-xl text-sm font-semibold transition-all border"
          :class="showStatsMenu ? 'bg-blue-500 text-white border-blue-500' : 'bg-white dark:bg-[#1a2332] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-[#1e293b] hover:border-blue-300 hover:text-blue-500'"
          @click="toggleStatsMenu"
        >📊 统计</button>

        <div
          v-if="showStatsMenu"
          class="absolute top-full left-0 mt-1.5 w-44 bg-white dark:bg-[#111827] rounded-xl border border-slate-200 dark:border-[#1e293b] shadow-xl z-50 p-2"
        >
          <div
            v-for="item in [
              { label: 'Program 总数', value: r.statPrograms.value, color: 'text-blue-500' },
              { label: '无效残留',    value: r.residualPrograms.value.length, color: 'text-red-500' },
              { label: '启用实例',    value: r.statEnabled.value,   color: 'text-emerald-500' },
              { label: '活跃 Run',   value: r.statActive.value,    color: 'text-amber-500' },
              { label: '近 24h 失败', value: r.statFailed24h.value === null ? '—' : r.statFailed24h.value, color: 'text-red-500' },
            ]"
            :key="item.label"
            class="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-[#1a2332]"
          >
            <span class="text-xs text-slate-500 dark:text-slate-400">{{ item.label }}</span>
            <span class="text-sm font-bold" :class="item.color">{{ item.value }}</span>
          </div>
        </div>
      </div>

      <div class="flex-1" />
      <button class="h-9 px-4 rounded-xl text-sm font-semibold border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all" @click="r.reloadAll()">↻ 重扫</button>
      <button class="h-9 px-4 rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-md hover:shadow-lg transition-all" @click="r.refreshAll()">↻ 刷新</button>
    </header>

    <!-- 主面板：ProgramDetail 全宽 -->
    <main class="main-panel flex-1 flex flex-col min-h-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#111827] shadow-sm overflow-hidden">
      <ProgramDetail
        :program="r.activeProgram.value"
        :hosts="r.hosts.value"
        :current-tab="r.currentTab.value"
        :active-runs="r.activeRuns.value"
        :event-entries="r.eventEntries.value"
        :guardian-entries="r.guardianEntries.value"
        :l2-entries="r.l2Entries.value"
        :result-entries="r.resultEntries.value"
        :results-host-label="r.resultsHostLabel.value"
        :guardian-unlimited="r.guardianUnlimited.value"
        :l2-unlimited="r.l2Unlimited.value"
        :improve-btn-pending="r.improveBtnPending.value"
        :refresh-runs="r.refreshRuns"
        @switch-tab="(t) => r.switchTab(t)"
        @trigger="(pid: string, hid: string, action?: string, inputs?: Record<string, unknown>) => r.triggerInstance(pid, hid, action, inputs)"
        @toggle="(pid: string, hid: string, en: boolean) => r.toggleInstance(pid, hid, en)"
        @set-guardian-unlimited="(en: boolean) => r.setGuardianUnlimited(en)"
        @set-l2-unlimited="(en: boolean) => r.setL2Unlimited(en)"
        @improve="r.requestL2Improve()"
      />
    </main>

    <!-- 点击浮层外部关闭 -->
    <div
      v-if="showProgramsMenu || showResidualMenu || showStatsMenu"
      class="fixed inset-0 z-40"
      @click="closeMenus"
    />

    <ProgramRunModal
      :request="r.programRunRequest.value"
      @run="(inputs) => r.submitProgramRunInputs(inputs)"
      @cancel="r.cancelProgramRunInputs()"
    />

    <!-- Guardian ask 模态 -->
    <AskModal
      :ask="r.currentAsk.value"
      @answer="(a) => r.answerAsk(a)"
      @cancel="r.cancelAsk()"
    />
  </div>
</template>

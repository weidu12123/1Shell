<script setup lang="ts">
// 详情容器 — 详情头部（name/desc/enabled/triggers）+ tab nav + 6 个 panel 切换
import type { ProgramInfo, RunRecord, HostInfo, ActiveRun, EventEntry, GuardianEntry, L2Entry, RenderResultEntry } from '@/utils/programs';
import type { TabKey } from '@/composables/useProgramsRunner';
import InstancesTab from './InstancesTab.vue';
import ResultsTab from './ResultsTab.vue';
import RunsTab from './RunsTab.vue';
import EventsTab from './EventsTab.vue';
import L2Tab from './L2Tab.vue';
import GuardianTab from './GuardianTab.vue';

interface Props {
  program: ProgramInfo | null;
  hosts: HostInfo[];
  currentTab: TabKey;
  activeRuns: ActiveRun[];
  // streams
  eventEntries: EventEntry[];
  guardianEntries: GuardianEntry[];
  l2Entries: L2Entry[];
  resultEntries: RenderResultEntry[];
  resultsHostLabel: string | null;
  // unlimited
  guardianUnlimited: boolean;
  l2Unlimited: boolean;
  improveBtnPending: boolean;
  // runs refresh
  refreshRuns: () => Promise<RunRecord[]>;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  switchTab: [tab: TabKey];
  trigger: [programId: string, hostId: string, actionName?: string];
  toggle: [programId: string, hostId: string, enable: boolean];
  setGuardianUnlimited: [enabled: boolean];
  setL2Unlimited: [enabled: boolean];
  improve: [];
}>();

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'instances', label: '实例' },
  { key: 'results',   label: '📊 结果' },
  { key: 'runs',      label: '运行历史' },
  { key: 'events',    label: '实时事件' },
  { key: 'l2',        label: '⚡ L2 Skill' },
  { key: 'guardian',  label: '🛡 L3 Guardian' },
];

function triggerCls(type: string): string {
  return type === 'cron' ? 'badge-ok' : 'badge-idle';
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <!-- 未选中：占位 -->
    <div v-if="!program" class="flex-1 flex items-center justify-center text-slate-400 text-sm">
      « 选择一个 Program 查看详情
    </div>

    <!-- 详情主体 -->
    <template v-else>
      <!-- 头部 -->
      <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-base font-bold text-slate-700 dark:text-slate-200">{{ program.name }}</div>
            <div class="text-[11px] text-slate-400 mt-0.5 whitespace-pre-wrap">{{ program.description || '' }}</div>
          </div>
          <div class="shrink-0 flex items-center gap-2">
            <span class="badge" :class="program.enabled ? 'badge-ok' : 'badge-idle'">{{ program.enabled ? '已启用' : '未启用' }}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-3">
          <span
            v-for="t in (program.triggers || [])"
            :key="t.id"
            class="badge"
            :class="triggerCls(t.type)"
          >
            {{ t.id }} · {{ t.type }}<template v-if="t.type === 'cron'"> <code class="text-[10px]">{{ t.schedule }}</code></template> → {{ t.action }}
          </span>
        </div>
      </div>

      <!-- Tab 栏 -->
      <div class="shrink-0 px-5 pt-2 flex items-center gap-0 border-b border-slate-100 dark:border-[#1e293b]">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="px-4 py-2 text-xs font-semibold rounded-t-lg border-b-2 cursor-pointer"
          :class="currentTab === t.key
            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
            : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'"
          @click="emit('switchTab', t.key)"
        >{{ t.label }}</button>
      </div>

      <!-- Panel 路由（与老版 .hidden 切换等价） -->
      <InstancesTab
        v-show="currentTab === 'instances'"
        :program="program"
        :hosts="hosts"
        :active-runs="activeRuns"
        @trigger="(pid: string, hid: string, action?: string) => emit('trigger', pid, hid, action)"
        @toggle="(pid: string, hid: string, en: boolean) => emit('toggle', pid, hid, en)"
      />
      <ResultsTab
        v-show="currentTab === 'results'"
        :entries="resultEntries"
        :host-label="resultsHostLabel"
      />
      <RunsTab
        v-show="currentTab === 'runs'"
        :program-id="program.id"
        :hosts="hosts"
        :active="currentTab === 'runs'"
        :refresh-fn="refreshRuns"
      />
      <EventsTab
        v-show="currentTab === 'events'"
        :entries="eventEntries"
      />
      <L2Tab
        v-show="currentTab === 'l2'"
        :entries="l2Entries"
        :unlimited="l2Unlimited"
        :improve-pending="improveBtnPending"
        @set-unlimited="(en: boolean) => emit('setL2Unlimited', en)"
        @improve="emit('improve')"
      />
      <GuardianTab
        v-show="currentTab === 'guardian'"
        :entries="guardianEntries"
        :unlimited="guardianUnlimited"
        @set-unlimited="(en: boolean) => emit('setGuardianUnlimited', en)"
      />
    </template>
  </div>
</template>

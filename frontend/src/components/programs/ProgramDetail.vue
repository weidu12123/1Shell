<script setup lang="ts">
import { computed } from 'vue';
import type { ProgramInfo, RunRecord, HostInfo, ActiveRun, EventEntry, GuardianEntry, L2Entry, RenderResultEntry } from '@/utils/programs';
import type { TabKey } from '@/composables/useProgramsRunner';
import ProgramArtifactHost from './ProgramArtifactHost.vue';

interface Props {
  program: ProgramInfo | null;
  hosts: HostInfo[];
  currentTab: TabKey;
  activeRuns: ActiveRun[];
  eventEntries: EventEntry[];
  guardianEntries: GuardianEntry[];
  l2Entries: L2Entry[];
  resultEntries: RenderResultEntry[];
  resultsHostLabel: string | null;
  guardianUnlimited: boolean;
  l2Unlimited: boolean;
  improveBtnPending: boolean;
  refreshRuns: () => Promise<RunRecord[]>;
}

const props = defineProps<Props>();

const contractIssues = computed(() => props.program?.frontendContract?.issues || []);
const contractWarnings = computed(() => props.program?.frontendContract?.warnings || []);
const contractRenderable = computed(() => props.program?.frontendContract?.renderable === true);
const actionCount = computed(() => Object.keys(props.program?.actions || {}).length);
const l2Skill = computed(() => props.program?.l2?.skill || '未配置');
const l3Policy = computed(() => props.program?.l3?.enabled === false ? '关闭' : '启用');

function triggerCls(type: string): string {
  return type === 'cron' ? 'badge-ok' : 'badge-idle';
}

function contractBadgeClass(): string {
  if (!props.program?.frontendContract) return 'badge-idle';
  return contractRenderable.value ? 'badge-ok' : 'badge-err';
}

function contractText(): string {
  if (!props.program?.frontendContract) return '未检查';
  return contractRenderable.value ? '前端可渲染' : '前端不可渲染';
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <div v-if="!program" class="flex-1 flex items-center justify-center text-slate-400 text-sm">
      « 选择一个 Program 查看详情
    </div>

    <template v-else>
      <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-base font-bold text-slate-700 dark:text-slate-200">{{ program.name }}</div>
            <div class="text-[11px] text-slate-400 mt-0.5 whitespace-pre-wrap">{{ program.description || '' }}</div>
          </div>
          <div class="shrink-0 flex items-center gap-2">
            <span class="badge" :class="contractBadgeClass()">{{ contractText() }}</span>
            <span class="badge" :class="program.enabled ? 'badge-ok' : 'badge-idle'">{{ program.enabled ? '已启用' : '未启用' }}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-3">
          <span class="badge badge-idle">hosts: {{ program.hosts === 'all' ? 'all' : (program.hosts || []).length }}</span>
          <span class="badge badge-idle">actions: {{ actionCount }}</span>
          <span class="badge badge-idle">L2: {{ l2Skill }}</span>
          <span class="badge badge-idle">L3: {{ l3Policy }}</span>
          <span
            v-for="t in (program.triggers || [])"
            :key="t.id"
            class="badge"
            :class="triggerCls(t.type)"
          >
            {{ t.id }} · {{ t.type }}<template v-if="t.type === 'cron'"> <code class="text-[10px]">{{ t.schedule }}</code></template> → {{ t.action }}
          </span>
        </div>
        <div
          v-if="contractIssues.length || contractWarnings.length"
          class="mt-3 rounded-xl border px-3 py-2 text-xs"
          :class="contractIssues.length ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300'"
        >
          <div class="font-semibold">Frontend Contract Check</div>
          <ul class="mt-1 list-disc space-y-0.5 pl-4">
            <li v-for="issue in contractIssues" :key="`issue-${issue}`">{{ issue }}</li>
            <li v-for="warning in contractWarnings" :key="`warning-${warning}`">{{ warning }}</li>
          </ul>
        </div>
      </div>

      <ProgramArtifactHost
        class="min-h-[520px] flex-1"
        :program="program"
        :hosts="hosts"
        :active-runs="activeRuns"
        :result-entries="resultEntries"
        :event-entries="eventEntries"
        @refresh="refreshRuns"
      />
    </template>
  </div>
</template>

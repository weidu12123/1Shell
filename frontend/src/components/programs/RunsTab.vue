<script setup lang="ts">
// 运行历史 Tab — 老 runs-body
import { ref, watch, onMounted } from 'vue';
import type { RunRecord, HostInfo } from '@/utils/programs';

interface Props {
  programId: string | null;
  hosts: HostInfo[];
  active: boolean;
  refreshFn: () => Promise<RunRecord[]>;
}
const props = defineProps<Props>();
const runs = ref<RunRecord[]>([]);

async function reload(): Promise<void> {
  if (!props.programId) {
    runs.value = [];
    return;
  }
  runs.value = await props.refreshFn();
}

onMounted(reload);
// active 切到本 tab 时刷新（与老版 switchTab tab==='runs' 时 refreshRuns 行为一致）
watch(() => [props.programId, props.active] as const, ([, isActive], [prevId]) => {
  if (props.programId && (isActive || props.programId !== prevId)) reload();
});

function hostName(hostId: string): string {
  const h = props.hosts.find((x) => x.id === hostId);
  return h ? h.name : hostId;
}

function duration(r: RunRecord): string {
  if (!r.started_at || !r.finished_at) return '—';
  const sec = Math.max(0, (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000);
  return `${sec.toFixed(1)}s`;
}

function statusBadge(status: string): { cls: string; text: string } {
  if (status === 'success') return { cls: 'badge-ok', text: '成功' };
  if (status === 'running') return { cls: 'badge-run', text: '运行中' };
  if (status === 'warning') return { cls: 'badge-warn', text: '⚠ 已报告' };
  if (status === 'failed')  return { cls: 'badge-err', text: '失败' };
  if (status === 'cancelled') return { cls: 'badge-warn', text: '已取消' };
  return { cls: 'badge-idle', text: status || '未运行' };
}

defineExpose({ reload });
</script>

<template>
  <div class="flex-1 overflow-auto">
    <table class="ct-table">
      <thead>
        <tr>
          <th>#</th><th>主机</th><th>Trigger</th><th>Action</th><th>状态</th>
          <th>步骤</th><th>开始时间</th><th>耗时</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="runs.length === 0">
          <td colspan="8" class="text-center text-slate-400 py-8">暂无运行记录</td>
        </tr>
        <tr v-for="r in runs" :key="r.id">
          <td class="text-slate-400 text-[10px]">#{{ r.id }}</td>
          <td>{{ hostName(r.host_id) }}</td>
          <td class="text-[10px]">{{ r.trigger_id }} <span class="text-slate-400">({{ r.trigger_type }})</span></td>
          <td class="text-[10px]">{{ r.action }}</td>
          <td><span class="badge" :class="statusBadge(r.status).cls">{{ statusBadge(r.status).text }}</span></td>
          <td class="text-[10px]">{{ r.steps_completed }}/{{ r.steps_total }}</td>
          <td class="text-[10px] text-slate-500 dark:text-slate-400">{{ r.started_at }}</td>
          <td class="text-[10px]">{{ duration(r) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

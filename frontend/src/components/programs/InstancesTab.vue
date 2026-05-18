<script setup lang="ts">
// 实例 Tab — 老 instances-body 表格
// 包含 customActions（program.ui.instance_actions）替换默认"触发"按钮逻辑
import { computed } from 'vue';
import type { ProgramInfo, HostInfo, InstanceActionDef, ActiveRun } from '@/utils/programs';
import { useConfirm } from '@/composables/useConfirm';

interface Props {
  program: ProgramInfo;
  hosts: HostInfo[];
  activeRuns: ActiveRun[];
}
const props = defineProps<Props>();
const emit = defineEmits<{
  trigger: [programId: string, hostId: string, actionName?: string];
  toggle: [programId: string, hostId: string, enable: boolean];
}>();

const { confirm } = useConfirm();

// 当前 program 下正在跑的 host 集合（reactive — activeRuns 变化时自动重算）
const activeHostSet = computed<Set<string>>(() => {
  const s = new Set<string>();
  for (const r of props.activeRuns) {
    if (r.programId === props.program.id) s.add(r.hostId);
  }
  return s;
});

function isActive(hostId: string): boolean {
  return activeHostSet.value.has(hostId);
}

interface MergedRow {
  host_id: string;
  enabled: boolean;
  last_status?: string;
  last_run_at?: string;
  last_trigger_id?: string;
}

// 合并：expectedHosts ∪ instances（确保未运行过的 host 也显示）
const rows = computed<MergedRow[]>(() => {
  const p = props.program;
  const expectedHosts: string[] = p.hosts === 'all'
    ? props.hosts.map((h) => h.id)
    : (Array.isArray(p.hosts) ? p.hosts : []);
  const map = new Map<string, MergedRow>();
  for (const hid of expectedHosts) {
    map.set(hid, { host_id: hid, enabled: true });
  }
  for (const inst of (p.instances || [])) {
    map.set(inst.host_id, {
      host_id: inst.host_id,
      enabled: inst.enabled === 1 || inst.enabled === undefined,
      last_status: inst.last_status,
      last_run_at: inst.last_run_at,
      last_trigger_id: inst.last_trigger_id,
    });
  }
  return [...map.values()];
});

const customActions = computed<InstanceActionDef[] | undefined>(() => props.program.ui?.instance_actions);

function hostName(hostId: string): string {
  const h = props.hosts.find((x) => x.id === hostId);
  return h ? h.name : hostId;
}

function statusBadge(active: boolean, status?: string): { cls: string; text: string } {
  if (active) return { cls: 'badge-run', text: '运行中' };
  if (!status) return { cls: 'badge-idle', text: '未运行' };
  if (status === 'success')   return { cls: 'badge-ok',   text: '成功' };
  if (status === 'running')   return { cls: 'badge-run',  text: '运行中' };
  if (status === 'warning')   return { cls: 'badge-warn', text: '⚠ 已报告' };
  if (status === 'failed')    return { cls: 'badge-err',  text: '失败' };
  if (status === 'cancelled') return { cls: 'badge-warn', text: '已取消' };
  return { cls: 'badge-idle', text: status };
}

function actionClass(style?: string): string {
  switch (style) {
    case 'primary': return 'act-btn-primary';
    case 'success': return 'act-btn-success';
    case 'danger':  return 'act-btn-danger';
    default:        return 'act-btn-default';
  }
}

async function onCustomAction(hostId: string, action: InstanceActionDef): Promise<void> {
  if (action.confirm) {
    const ok = await confirm({ title: '确认操作', message: action.confirm, okText: '确认' });
    if (!ok) return;
  }
  emit('trigger', props.program.id, hostId, action.action);
}
</script>

<template>
  <div class="flex-1 overflow-auto">
    <table class="ct-table">
      <thead>
        <tr>
          <th>主机</th><th>启用</th><th>最近状态</th>
          <th>最近执行</th><th>最近 Trigger</th>
          <th class="text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td colspan="6" class="text-center text-slate-400 py-8">无可用主机</td>
        </tr>
        <tr v-for="row in rows" :key="row.host_id">
          <td>
            <span class="font-semibold">{{ hostName(row.host_id) }}</span>
            <span class="text-[10px] text-slate-400 ml-1">{{ row.host_id }}</span>
          </td>
          <td>
            <span class="badge" :class="row.enabled ? 'badge-ok' : 'badge-idle'">{{ row.enabled ? '开' : '关' }}</span>
          </td>
          <td>
            <span class="badge" :class="statusBadge(isActive(row.host_id), row.last_status).cls">
              {{ statusBadge(isActive(row.host_id), row.last_status).text }}
            </span>
          </td>
          <td class="text-[10px] text-slate-500 dark:text-slate-400">{{ row.last_run_at || '—' }}</td>
          <td class="text-[10px] text-slate-500 dark:text-slate-400">{{ row.last_trigger_id || '—' }}</td>
          <td class="text-right whitespace-nowrap">
            <!-- customActions 替换默认按钮 -->
            <template v-if="customActions">
              <button
                v-for="a in customActions"
                :key="a.action"
                class="act-btn"
                :class="[actionClass(a.style), { 'opacity-50 cursor-not-allowed': isActive(row.host_id) }]"
                :disabled="isActive(row.host_id)"
                @click="onCustomAction(row.host_id, a)"
              >{{ a.label }}</button>
            </template>
            <!-- 默认"触发"按钮 -->
            <button
              v-else
              class="act-btn act-btn-primary"
              :class="{ 'opacity-50 cursor-not-allowed': isActive(row.host_id) }"
              :disabled="isActive(row.host_id)"
              @click="emit('trigger', program.id, row.host_id)"
            >▶ 触发</button>
            <!-- 启用/停用 -->
            <button
              v-if="row.enabled"
              class="act-btn act-btn-danger"
              @click="emit('toggle', program.id, row.host_id, false)"
            >停用</button>
            <button
              v-else
              class="act-btn act-btn-success"
              @click="emit('toggle', program.id, row.host_id, true)"
            >启用</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import PlaybookEditor from '@/components/scripts/PlaybookEditor.vue';
import PlaybookList from '@/components/scripts/PlaybookList.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';
import {
  deepClone,
  makeDraftWorkflow,
  type HostInfo,
  type ScriptInfo,
  type WorkflowInfo,
  type WorkflowRunResponse,
  type WorkflowSaveResponse,
  type WorkflowsListResponse,
} from '@/utils/scripts';

interface Props {
  scripts: ScriptInfo[];
  hosts: HostInfo[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  back: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const { confirm } = useConfirm();

const mode = ref<'list' | 'editor'>('list');
const playbooks = ref<WorkflowInfo[]>([]);
const loading = ref(false);
const errorText = ref<string | null>(null);

const currentId = ref<string | null>(null);
const isNew = ref(false);
const draft = ref<WorkflowInfo | null>(null);
const saving = ref(false);
const running = ref(false);

async function loadPlaybooks(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const resp = await requestJson<WorkflowsListResponse>('/api/workflows');
    playbooks.value = Array.isArray(resp.workflows) ? resp.workflows : [];
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err);
    playbooks.value = [];
  } finally {
    loading.value = false;
  }
}

function onCreate(): void {
  isNew.value = true;
  currentId.value = null;
  draft.value = makeDraftWorkflow();
  mode.value = 'editor';
}

function onSelect(id: string): void {
  const pb = playbooks.value.find((p) => p.id === id);
  if (!pb) return;
  isNew.value = false;
  currentId.value = id;
  draft.value = deepClone(pb);
  // 兜底确保 steps 是数组
  if (!Array.isArray(draft.value.steps)) draft.value.steps = [];
  mode.value = 'editor';
}

async function onSave(): Promise<void> {
  if (!draft.value) return;
  const d = draft.value;
  if (!d.name.trim()) { notify.warn('请输入 Playbook 名称'); return; }
  if (d.steps.length === 0) { notify.warn('请至少添加一个步骤'); return; }
  for (const step of d.steps) {
    if (!step.scriptId) { notify.warn('有步骤未选择脚本'); return; }
  }

  const body = {
    name: d.name.trim(),
    icon: d.icon || '📘',
    description: d.description || '',
    steps: d.steps,
  };

  saving.value = true;
  try {
    if (isNew.value) {
      const resp = await requestJson<WorkflowSaveResponse>('/api/workflows', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      currentId.value = resp.workflow.id;
      isNew.value = false;
      draft.value = deepClone(resp.workflow);
      notify.success('Playbook 已创建');
    } else if (currentId.value) {
      const resp = await requestJson<WorkflowSaveResponse>(
        `/api/workflows/${encodeURIComponent(currentId.value)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      draft.value = deepClone(resp.workflow);
      notify.success('Playbook 已保存');
    }
    await loadPlaybooks();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    saving.value = false;
  }
}

async function onRun(): Promise<void> {
  if (isNew.value || !currentId.value) {
    notify.warn('请先保存 Playbook');
    return;
  }
  running.value = true;
  try {
    const resp = await requestJson<WorkflowRunResponse>(
      `/api/workflows/${encodeURIComponent(currentId.value)}/run`,
      { method: 'POST' },
    );
    const run = resp.run;
    if (run.status === 'success') {
      notify.success(`Playbook 执行成功，完成 ${run.completedSteps}/${run.totalSteps} 步`);
    } else {
      notify.error(`Playbook 执行失败：${run.error || '部分步骤未通过'}`, 6000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    running.value = false;
  }
}

async function onDelete(): Promise<void> {
  if (isNew.value || !currentId.value) return;
  const pb = playbooks.value.find((p) => p.id === currentId.value);
  const ok = await confirm({
    title: '确认删除 Playbook',
    message: `此操作不可撤销，确定要删除"${pb?.name || currentId.value}"吗？`,
    okText: '确认删除',
  });
  if (!ok) return;

  try {
    await requestJson(`/api/workflows/${encodeURIComponent(currentId.value)}`, { method: 'DELETE' });
    notify.success('Playbook 已删除');
    currentId.value = null;
    draft.value = null;
    isNew.value = false;
    mode.value = 'list';
    await loadPlaybooks();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

onMounted(() => {
  void loadPlaybooks();
});
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <!-- 顶部 header（list / editor 共享，沿用老版） -->
    <div class="shrink-0 px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-lg">📘</span>
        <div class="text-sm font-bold text-slate-700 dark:text-slate-200">
          {{ mode === 'list' ? 'Playbook 编排' : (isNew ? '新建 Playbook' : '编辑 Playbook') }}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="mode === 'list'"
          type="button"
          class="h-7 px-3 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold shadow hover:shadow-lg transition-all"
          @click="onCreate"
        >+ 新建 Playbook</button>
        <button
          type="button"
          class="h-7 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:border-purple-300 hover:text-purple-500"
          @click="emit('back')"
        >← 返回脚本列表</button>
      </div>
    </div>

    <!-- 子视图 -->
    <PlaybookList
      v-if="mode === 'list'"
      :playbooks="playbooks"
      :loading="loading"
      :error-text="errorText"
      @select="onSelect"
    />
    <PlaybookEditor
      v-else-if="draft"
      :draft="draft"
      :scripts="scripts"
      :hosts="hosts"
      :is-new="isNew"
      :saving="saving"
      :running="running"
      @save="onSave"
      @run="onRun"
      @delete="onDelete"
    />
  </div>
</template>

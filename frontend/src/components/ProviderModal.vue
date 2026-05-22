<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import {
  SKILLS_SLOT_ID,
  UPSTREAM_LABELS,
  type ProviderInfo,
  type ProvidersResponse,
  type UpstreamProtocol,
} from '@/utils/cliSetup';

interface Props {
  open: boolean;
  cliId: string | null;
  cliName?: string;
  supportedUpstream: UpstreamProtocol[];
  launchCommand?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  changed: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const providers = ref<ProviderInfo[]>([]);
const activeProviderId = ref<string | undefined>(undefined);
const loadingList = ref(false);
const listError = ref<string | null>(null);

const editingPid = ref<string | null>(null);
const fName = ref('');
const fUpstream = ref<UpstreamProtocol>('openai');
const fApiBase = ref('');
const fApiKey = ref('');
const fApiKeyPlaceholder = ref('sk-...');
const fModel = ref('');
const statusText = ref('');
const statusOk = ref<boolean | null>(null);
const saving = ref(false);

const isSkillsSlot = computed(() => props.cliId === SKILLS_SLOT_ID);
const title = computed(() => {
  if (!props.cliId) return '配置 API 代理';
  if (isSkillsSlot.value) return '配置 1Shell AI 引擎';
  return `配置 ${props.cliName || props.cliId} API 渠道`;
});
const subtitle = computed(() => {
  if (isSkillsSlot.value) return '驱动主控台 AI / IDE 创作 / Program & Skill 执行（支持 OpenAI 兼容 / Anthropic）';
  const labels = (props.supportedUpstream.length ? props.supportedUpstream : (['openai'] as UpstreamProtocol[]))
    .map((u) => UPSTREAM_LABELS[u] || u).join(' / ');
  return `支持上游协议: ${labels}`;
});

const allowedUpstreams = computed<UpstreamProtocol[]>(() => {
  if (isSkillsSlot.value) return ['anthropic', 'openai'];
  return props.supportedUpstream.length ? props.supportedUpstream : ['openai'];
});

const showEnvHint = computed(() => !isSkillsSlot.value && !!props.launchCommand);

const saveBtnText = computed(() => {
  if (saving.value) return '保存中...';
  return editingPid.value ? '保存修改' : '添加渠道';
});

const formLabel = computed(() => {
  if (!editingPid.value) return '添加新渠道';
  const p = providers.value.find((x) => x.id === editingPid.value);
  return `编辑: ${p?.name || '未命名'}`;
});

function close(): void {
  emit('update:open', false);
}

function resetFormToAdd(): void {
  editingPid.value = null;
  fName.value = '';
  fUpstream.value = allowedUpstreams.value[0];
  fApiBase.value = '';
  fApiKey.value = '';
  fApiKeyPlaceholder.value = 'sk-...';
  fModel.value = '';
  statusText.value = '';
  statusOk.value = null;
}

function startEdit(p: ProviderInfo): void {
  editingPid.value = p.id;
  fName.value = p.name || '';
  fUpstream.value = p.upstreamProtocol || 'openai';
  fApiBase.value = p.apiBase || '';
  fApiKey.value = '';
  fApiKeyPlaceholder.value = p.apiKeySet ? (p.apiKey || '已设置') : 'sk-...';
  fModel.value = p.model || '';
  statusText.value = '';
  statusOk.value = null;
}

async function loadProviders(): Promise<void> {
  if (!props.cliId) return;
  loadingList.value = true;
  listError.value = null;
  try {
    const resp = await requestJson<ProvidersResponse>(`/api/agent/providers/${encodeURIComponent(props.cliId)}`);
    providers.value = resp.providers || [];
    activeProviderId.value = resp.activeProviderId;
  } catch (err) {
    listError.value = err instanceof Error ? err.message : String(err);
    providers.value = [];
  } finally {
    loadingList.value = false;
  }
}

async function onSave(): Promise<void> {
  if (!props.cliId) return;
  const body: Record<string, string | undefined> = {
    name: fName.value.trim() || undefined,
    upstreamProtocol: fUpstream.value,
    apiBase: fApiBase.value.trim(),
    apiKey: fApiKey.value.trim() || undefined,
    model: fModel.value.trim() || undefined,
  };

  if (!body.apiBase) {
    statusText.value = '✗ API 基础地址不能为空';
    statusOk.value = false;
    return;
  }
  if (!editingPid.value && !body.apiKey) {
    statusText.value = '✗ 新渠道必须填写 API Key';
    statusOk.value = false;
    return;
  }

  saving.value = true;
  try {
    if (editingPid.value) {
      await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${editingPid.value}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      statusText.value = '✓ 渠道已更新';
      notify.success('渠道已更新');
    } else {
      await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      statusText.value = '✓ 渠道已添加';
      notify.success('渠道已添加');
    }
    statusOk.value = true;
    await loadProviders();
    emit('changed');
    resetFormToAdd();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusText.value = `✗ 保存失败: ${msg}`;
    statusOk.value = false;
    notify.error(msg, 5000);
  } finally {
    saving.value = false;
  }
}

async function onActivate(pid: string): Promise<void> {
  if (!props.cliId) return;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${pid}/activate`, { method: 'PUT' });
    notify.success('已切换活跃渠道');
    await loadProviders();
    emit('changed');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

async function onDelete(pid: string): Promise<void> {
  if (!props.cliId) return;
  const p = providers.value.find((x) => x.id === pid);
  if (!window.confirm(`确定删除渠道「${p?.name || pid}」？`)) return;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${pid}`, { method: 'DELETE' });
    notify.success('已删除');
    await loadProviders();
    emit('changed');
    if (editingPid.value === pid) resetFormToAdd();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

async function copyLaunchCmd(): Promise<void> {
  if (!props.launchCommand) return;
  try {
    await navigator.clipboard.writeText(props.launchCommand);
    notify.success('已复制启动命令');
  } catch {
    notify.error('复制失败');
  }
}

watch(() => props.open, async (v) => {
  if (v && props.cliId) {
    providers.value = [];
    activeProviderId.value = undefined;
    listError.value = null;
    resetFormToAdd();
    await loadProviders();
  }
});

watch(() => props.cliId, async (newId, oldId) => {
  if (props.open && newId && newId !== oldId) {
    providers.value = [];
    activeProviderId.value = undefined;
    listError.value = null;
    resetFormToAdd();
    await loadProviders();
  }
});
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    @click="onBackdropClick"
  >
    <div class="w-[580px] max-h-[90vh] overflow-y-auto bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700">
      <!-- 头 -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
        <div>
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200">{{ title }}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">{{ subtitle }}</div>
        </div>
        <button type="button" class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 text-sm" @click="close">✕</button>
      </div>

      <!-- Provider 列表 -->
      <div class="px-5 pt-4 pb-2">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">API 渠道列表</span>
          <button type="button" class="h-6 px-2.5 rounded-md bg-cyan-50 border border-cyan-200 text-cyan-600 text-[10px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400" @click="resetFormToAdd">+ 添加渠道</button>
        </div>
        <div class="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
          <div v-if="loadingList" class="text-[10px] text-slate-400 text-center py-3">加载中...</div>
          <div v-else-if="listError" class="text-[10px] text-red-500 py-2">加载失败: {{ listError }}</div>
          <div v-else-if="providers.length === 0" class="text-[10px] text-slate-400 text-center py-3">尚未添加任何 API 渠道</div>
          <div
            v-for="p in providers"
            v-else
            :key="p.id"
            class="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs"
            :class="p.id === activeProviderId
              ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0b1324]'"
          >
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-slate-700 dark:text-slate-200 truncate">
                <span v-if="p.id === activeProviderId" class="text-emerald-500 mr-1">●</span>
                <span v-else class="text-slate-300 mr-1">○</span>
                {{ p.name || '未命名' }}
              </div>
              <div class="text-[10px] text-slate-400 truncate">
                {{ UPSTREAM_LABELS[p.upstreamProtocol] || p.upstreamProtocol || 'openai' }}
                · {{ p.model || '默认模型' }}
                · {{ p.apiKeySet ? 'Key ✓' : 'Key ✗' }}
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button v-if="p.id !== activeProviderId" type="button" class="h-6 px-1.5 rounded text-[10px] border border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10" title="设为活跃" @click="onActivate(p.id)">启用</button>
              <button type="button" class="h-6 px-1.5 rounded text-[10px] border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800" title="编辑" @click="startEdit(p)">编辑</button>
              <button type="button" class="h-6 px-1.5 rounded text-[10px] border border-red-200 dark:border-red-500/30 text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10" title="删除" @click="onDelete(p.id)">✕</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 分割线 -->
      <div class="mx-5 h-px bg-slate-100 dark:bg-slate-700"></div>

      <!-- 表单 -->
      <div class="px-5 py-4 flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">{{ formLabel }}</span>
          <span v-if="editingPid" class="text-[9px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-300 font-semibold">编辑中</span>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">渠道名称</label>
          <input v-model="fName" type="text" placeholder="例：DeepSeek / 官方 API" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">上游协议类型</label>
          <select v-model="fUpstream" class="h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400">
            <option v-for="u in allowedUpstreams" :key="u" :value="u">{{ UPSTREAM_LABELS[u] }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">上游 API 基础地址</label>
          <input v-model="fApiBase" type="text" placeholder="https://api.openai.com" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">API Key</label>
          <input v-model="fApiKey" type="password" :placeholder="fApiKeyPlaceholder" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">目标模型</label>
          <input v-model="fModel" type="text" placeholder="gpt-4o / deepseek-chat" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>

        <!-- 启动命令提示（仅 CLI 沙箱模式） -->
        <div v-if="showEnvHint" class="rounded-lg bg-slate-50 dark:bg-[#0b1324] border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center justify-between mb-1.5">
            <div class="text-[10px] font-semibold text-slate-400 uppercase">启动命令（不修改本地配置）</div>
            <button type="button" class="h-6 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] text-slate-500 hover:text-cyan-500 hover:border-cyan-300" title="复制启动命令" @click="copyLaunchCmd">📋 复制</button>
          </div>
          <pre class="text-[11px] font-mono text-cyan-600 dark:text-cyan-400 whitespace-pre-wrap break-all select-all">{{ launchCommand }}</pre>
          <div class="mt-1.5 text-[10px] text-slate-400">通过环境变量与沙箱目录启动，不修改本地配置</div>
        </div>

        <div v-if="statusText" class="text-[10px]" :class="statusOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">{{ statusText }}</div>
      </div>

      <!-- 按钮 -->
      <div class="px-5 py-3.5 border-t border-slate-100 dark:border-slate-700 flex items-center gap-2">
        <button type="button" :disabled="saving" class="flex-1 h-9 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-xs font-semibold shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed" @click="onSave">{{ saveBtnText }}</button>
        <button type="button" class="h-9 px-4 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 text-xs hover:bg-slate-50 dark:hover:bg-slate-800" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

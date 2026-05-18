<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { ApiError, useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { parseTags, serializeTags, type McpInfo } from '@/utils/skills';

interface Props { open: boolean }
interface DeployCandidate { command: string; source: string }
interface DeployInspectResponse {
  repoUrl: string;
  installDir: string;
  name: string;
  description: string;
  command: string;
  detectedFrom: string;
  candidates: DeployCandidate[];
  installCommand: string;
  buildCommand: string;
  tags: string[];
  enabled: boolean;
  autoStart: boolean;
  exposeToIde: boolean;
  warnings: string[];
  readmeHints: string[];
}
interface DeployRegisterResponse {
  server?: McpInfo;
  steps?: Array<{ label: string; exitCode: number; stdout: string; stderr: string }>;
  preload?: { ok?: boolean; tools?: unknown[]; error?: string } | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const phase = ref<'input' | 'review' | 'done'>('input');
const fUrl = ref('');
const fName = ref('');
const fCommand = ref('');
const fDescription = ref('');
const fTags = ref('');
const fInstallDir = ref('');
const enabled = ref(true);
const autoStart = ref(false);
const exposeToIde = ref(true);
const candidates = ref<DeployCandidate[]>([]);
const warnings = ref<string[]>([]);
const installCommand = ref('');
const buildCommand = ref('');
const statusText = ref('');
const inspecting = ref(false);
const deploying = ref(false);

const busy = computed(() => inspecting.value || deploying.value);

watch(() => props.open, (now) => {
  if (!now) return;
  reset();
});

function reset(): void {
  phase.value = 'input';
  fUrl.value = '';
  fName.value = '';
  fCommand.value = '';
  fDescription.value = '';
  fTags.value = '';
  fInstallDir.value = '';
  enabled.value = true;
  autoStart.value = false;
  exposeToIde.value = true;
  candidates.value = [];
  warnings.value = [];
  installCommand.value = '';
  buildCommand.value = '';
  statusText.value = '';
  inspecting.value = false;
  deploying.value = false;
}

function close(): void {
  if (busy.value) return;
  emit('update:open', false);
}

function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

async function inspect(): Promise<void> {
  const repoUrl = fUrl.value.trim();
  if (!repoUrl) { notify.error('请粘贴 GitHub 链接'); return; }

  inspecting.value = true;
  statusText.value = '正在 clone/pull 仓库、读取 package/README 并匹配 1Shell 本地能力...';
  try {
    const data = await requestJson<DeployInspectResponse>('/api/mcp-servers/deploy/inspect', {
      method: 'POST',
      body: JSON.stringify({ repoUrl }),
    });
    fUrl.value = data.repoUrl || repoUrl;
    fName.value = data.name || '';
    fCommand.value = data.command || '';
    fDescription.value = data.description || '';
    fTags.value = serializeTags(data.tags);
    fInstallDir.value = data.installDir || '';
    enabled.value = data.enabled !== false;
    autoStart.value = data.autoStart === true;
    exposeToIde.value = data.exposeToIde !== false;
    candidates.value = data.candidates || [];
    warnings.value = data.warnings || [];
    installCommand.value = data.installCommand || '';
    buildCommand.value = data.buildCommand || '';
    statusText.value = `已识别：${data.detectedFrom || '通用 Node MCP'}${data.command ? '\n可直接一键部署；如识别不准再覆写命令。' : ''}`;
    phase.value = 'review';
  } catch (err) {
    const msg = errorMessage(err, '识别失败');
    statusText.value = msg;
    notify.error(msg, 5000);
  } finally {
    inspecting.value = false;
  }
}

async function deploy(): Promise<void> {
  if (!fName.value.trim()) { notify.error('请填写 MCP 名称'); return; }
  if (!fCommand.value.trim()) { notify.error('请填写启动命令'); return; }

  deploying.value = true;
  statusText.value = '正在安装依赖、生成私有配置、注册 MCP 并预加载 tools/list...';
  try {
    const data = await requestJson<DeployRegisterResponse>('/api/mcp-servers/deploy/register', {
      method: 'POST',
      body: JSON.stringify({
        repoUrl: fUrl.value.trim(),
        installDir: fInstallDir.value,
        name: fName.value.trim(),
        command: fCommand.value.trim(),
        description: fDescription.value.trim(),
        tags: parseTags(fTags.value),
        enabled: enabled.value,
        autoStart: autoStart.value,
        exposeToIde: exposeToIde.value,
      }),
    });
    const preload = data.preload;
    const preloadText = preload ? (preload.ok ? `预加载成功：${preload.tools?.length || 0} tools` : `预加载失败：${preload.error || '未知错误'}`) : '未触发预加载';
    statusText.value = `注册成功：${data.server?.name || fName.value}\n${preloadText}`;
    notify.success('本地 MCP 已注册');
    emit('saved');
    phase.value = 'done';
  } catch (err) {
    const msg = errorMessage(err, '部署失败');
    statusText.value = msg;
    notify.error(msg, 6000);
  } finally {
    deploying.value = false;
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    @click="onBackdrop"
  >
    <div class="bg-white dark:bg-[#0f172a] rounded-2xl border border-slate-200 dark:border-[#1e293b] w-[640px] max-h-[88vh] overflow-hidden shadow-2xl flex flex-col text-slate-700 dark:text-slate-200">
      <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center">
        <span class="text-sm font-semibold flex-1 inline-flex items-center gap-1.5">
          <AppIcon name="robot" :size="14" />
          <span>受控部署本地 MCP</span>
        </span>
        <button class="text-xl text-slate-400 hover:text-red-500 disabled:opacity-50" :disabled="busy" @click="close">✕</button>
      </div>

      <div class="p-5 flex flex-col gap-3 overflow-auto">
        <div class="text-[11px] text-slate-400">
          粘贴 GitHub 仓库链接，1Shell 会 clone/pull 到 data/local-mcp，读取 package/README 并自动匹配本机能力；例如 SSH 类 MCP 会直接复用 1Shell 已保存的主机配置生成私有 config-file。
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">GitHub 仓库链接</span>
          <input v-model="fUrl" class="fld" :disabled="phase !== 'input' || busy" placeholder="https://github.com/modelcontextprotocol/servers" />
        </label>

        <template v-if="phase !== 'input'">
          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">MCP 名称</span>
              <input v-model="fName" class="fld" :disabled="phase === 'done' || busy" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">标签</span>
              <input v-model="fTags" class="fld" :disabled="phase === 'done' || busy" placeholder="local, deployed" />
            </label>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-500">启动命令（自动生成，可覆写）</span>
            <input v-model="fCommand" class="fld font-mono" :disabled="phase === 'done' || busy" placeholder="node build/index.js --config-file .1shell/ssh-mcp-config.json" />
          </label>

          <div v-if="candidates.length" class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-500">分析候选（默认已选第一项）</span>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="item in candidates"
                :key="item.command + item.source"
                class="text-[10px] px-2 py-1 rounded border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-transparent text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1e293b] font-mono"
                :disabled="phase === 'done' || busy"
                @click="fCommand = item.command"
              >{{ item.command }} · {{ item.source }}</button>
            </div>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-500">描述</span>
            <textarea v-model="fDescription" class="fld min-h-[64px]" :disabled="phase === 'done' || busy" />
          </label>

          <div class="text-[10px] text-slate-400 font-mono truncate" :title="fInstallDir">安装目录：{{ fInstallDir }}</div>
          <div class="text-[10px] text-slate-400">
            将执行：{{ installCommand || '无需 npm install' }}<span v-if="buildCommand"> → {{ buildCommand }}</span>
          </div>

          <div class="grid grid-cols-2 gap-2 text-[11px]">
            <label class="flex items-center gap-2"><input v-model="enabled" type="checkbox" :disabled="phase === 'done' || busy" />启用</label>
            <label class="flex items-center gap-2"><input v-model="autoStart" type="checkbox" :disabled="phase === 'done' || busy" />服务启动时自启</label>
            <label class="flex items-center gap-2"><input v-model="exposeToIde" type="checkbox" :disabled="phase === 'done' || busy" />暴露给 1Shell AI</label>
          </div>

          <div v-if="warnings.length" class="text-[11px] p-3 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <div v-for="w in warnings" :key="w">{{ w }}</div>
          </div>
        </template>

        <div
          v-if="statusText"
          class="text-[11px] p-3 rounded-lg bg-slate-50 dark:bg-[#1e293b] text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap max-h-[180px] overflow-auto"
        >{{ statusText }}</div>
      </div>

      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2">
        <button class="flex-1 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#1e293b] disabled:opacity-50" :disabled="busy" @click="close">
          {{ phase === 'done' ? '完成' : '取消' }}
        </button>
        <button
          v-if="phase === 'input'"
          class="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-60"
          :disabled="busy"
          @click="inspect"
        >{{ inspecting ? '识别中...' : '识别仓库 →' }}</button>
        <button
          v-else-if="phase === 'review'"
          class="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-60"
          :disabled="busy"
          @click="deploy"
        >{{ deploying ? '部署中...' : '一键部署并预加载 →' }}</button>
      </div>
    </div>
  </div>
</template>

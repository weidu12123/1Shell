// useScriptInject.ts — MainConsole 刀 3 阶段 1 · 脚本 & Playbook 快捷注入
// 1:1 复刻 [public/script-inject.js](public/script-inject.js)（381 行）
// 单例 composable：scripts/playbooks 列表 + 选中 + 参数 + 预览 + 注入 + heredoc 包装

import { reactive, ref, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { ScriptInfo, PreviewResponse } from '@/utils/scripts';

interface PlaybookStep {
  scriptId: string;
  scriptName?: string;
  hostId?: string;
  params?: Record<string, unknown>;
}

interface PlaybookInfo {
  id: string;
  name: string;
  icon?: string;
  steps?: PlaybookStep[];
}

interface ScriptsListResponse { scripts?: ScriptInfo[] }
interface PlaybooksListResponse { playbooks?: PlaybookInfo[] }

export interface ScriptInjectApi {
  readonly scriptOpen: Ref<boolean>;
  readonly playbookOpen: Ref<boolean>;
  readonly scripts: Ref<ScriptInfo[]>;
  readonly playbooks: Ref<PlaybookInfo[]>;
  readonly selectedScriptId: Ref<string>;
  readonly selectedScript: Ref<ScriptInfo | null>;
  readonly params: Record<string, string>;
  readonly previewCommand: Ref<string>;
  readonly previewError: Ref<boolean>;
  readonly selectedPlaybookId: Ref<string>;
  readonly selectedPlaybook: Ref<PlaybookInfo | null>;
  readonly playbookRunning: Ref<boolean>;
  readonly playbookResultHtml: Ref<string>;
  readonly playbookResultVisible: Ref<boolean>;

  initialize(): void;
  openScriptPanel(): void;
  closeScriptPanel(): void;
  openPlaybookPanel(): void;
  closePlaybookPanel(): void;
  onScriptChange(id: string): void;
  onPlaybookChange(id: string): void;
  updateParam(name: string, value: string): void;
  refreshPreview(): void;
  injectScript(): void;
  copyScript(): void;
  runPlaybook(): Promise<void>;
}

let _instance: ScriptInjectApi | null = null;

export function useScriptInject(): ScriptInjectApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetScriptInjectSingleton(): void {
  _instance = null;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function create(): ScriptInjectApi {
  const { requestJson } = useApiClient();
  const hosts = useHostsStore();
  const sessionTerminal = useSessionTerminal();
  const notify = useNotifyStore();

  const scriptOpen = ref(false);
  const playbookOpen = ref(false);
  const scripts = ref<ScriptInfo[]>([]);
  const playbooks = ref<PlaybookInfo[]>([]);
  const selectedScriptId = ref('');
  const selectedScript = ref<ScriptInfo | null>(null);
  const params = reactive<Record<string, string>>({});
  const previewCommand = ref('');
  const previewError = ref(false);
  const selectedPlaybookId = ref('');
  const selectedPlaybook = ref<PlaybookInfo | null>(null);
  const playbookRunning = ref(false);
  const playbookResultHtml = ref('');
  const playbookResultVisible = ref(false);

  let initialized = false;

  function getHostId(): string {
    return hosts.selected?.id || sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  }

  // 1:1 复刻 script-inject.js:69 — 单行直发，多行 heredoc 整段执行
  function injectToTerminal(command: string): boolean {
    const lines = command.split('\n').filter((l) => l.trim() !== '');
    let payload: string;
    if (lines.length <= 1) {
      payload = command.trim() + '\n';
    } else {
      const eof = '__1SHELL_EOF__';
      payload = `bash << '${eof}'\n${command}\n${eof}\n`;
    }
    if (!sessionTerminal.sendSessionInput(payload)) {
      notify.warn('注入失败，终端会话未就绪');
      return false;
    }
    return true;
  }

  function clearParams(): void {
    Object.keys(params).forEach((k) => { delete params[k]; });
  }

  async function loadScripts(): Promise<void> {
    try {
      const resp = await requestJson<ScriptsListResponse>('/api/scripts');
      scripts.value = resp.scripts || [];
    } catch {
      scripts.value = [];
    }
  }

  async function loadPlaybooks(): Promise<void> {
    try {
      const resp = await requestJson<PlaybooksListResponse>('/api/playbooks');
      playbooks.value = resp.playbooks || [];
    } catch {
      playbooks.value = [];
    }
  }

  function onScriptChange(id: string): void {
    selectedScriptId.value = id;
    const script = scripts.value.find((s) => s.id === id) || null;
    selectedScript.value = script;
    clearParams();
    previewCommand.value = '';
    previewError.value = false;
    if (!script) return;
    // 初始化参数默认值
    (script.parameters || []).forEach((def) => {
      params[def.name] = def.default !== undefined && def.default !== null ? String(def.default) : '';
    });
    void refreshPreview();
  }

  function updateParam(name: string, value: string): void {
    params[name] = value;
    void refreshPreview();
  }

  async function refreshPreview(): Promise<void> {
    const script = selectedScript.value;
    if (!script) return;
    try {
      const resp = await requestJson<PreviewResponse>(
        `/api/scripts/${encodeURIComponent(script.id)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({ hostId: getHostId(), params: { ...params } }),
        }
      );
      previewCommand.value = resp.renderedCommand || '（空）';
      previewError.value = false;
    } catch (err) {
      previewCommand.value = `预览失败: ${(err as Error).message}`;
      previewError.value = true;
    }
  }

  function injectScript(): void {
    if (!previewCommand.value || previewError.value) return;
    if (injectToTerminal(previewCommand.value)) {
      closeScriptPanel();
      sessionTerminal.focusTerminal();
    }
  }

  function copyScript(): void {
    if (!previewCommand.value || previewError.value) return;
    navigator.clipboard?.writeText(previewCommand.value).then(() => {
      notify.success('命令已复制');
    }).catch(() => { /* 静默 */ });
  }

  function openScriptPanel(): void {
    closePlaybookPanel();
    scriptOpen.value = true;
    if (!scripts.value.length) void loadScripts();
  }

  function closeScriptPanel(): void {
    scriptOpen.value = false;
    selectedScriptId.value = '';
    selectedScript.value = null;
    clearParams();
    previewCommand.value = '';
    previewError.value = false;
  }

  function onPlaybookChange(id: string): void {
    selectedPlaybookId.value = id;
    const pb = playbooks.value.find((p) => p.id === id) || null;
    selectedPlaybook.value = pb;
    playbookResultVisible.value = false;
    playbookResultHtml.value = '';
  }

  // 1:1 复刻 script-inject.js:264 — 逐步 preview → 拼接 echo 前缀 → 整段 heredoc 注入
  async function runPlaybook(): Promise<void> {
    const pb = selectedPlaybook.value;
    if (!pb) return;
    const steps = pb.steps || [];
    if (!steps.length) {
      notify.warn('Playbook 没有任何步骤');
      return;
    }
    const baseHostId = getHostId();
    playbookRunning.value = true;
    playbookResultVisible.value = true;
    playbookResultHtml.value = '<span class="text-slate-400">正在渲染命令…</span>';
    try {
      const commandParts: string[] = [];
      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        const stepHostId = step.hostId || baseHostId;
        const stepName = step.scriptName || step.scriptId || `步骤 ${i + 1}`;
        const resp = await requestJson<PreviewResponse>(
          `/api/scripts/${encodeURIComponent(step.scriptId)}/preview`,
          {
            method: 'POST',
            body: JSON.stringify({ hostId: stepHostId, params: step.params || {} }),
          }
        );
        const rendered = resp.renderedCommand || '';
        if (!rendered) {
          playbookResultHtml.value = `<span class="text-red-500">步骤 ${i + 1}「${escapeHtml(stepName)}」渲染为空</span>`;
          return;
        }
        commandParts.push(`echo '── [${i + 1}/${steps.length}] ${stepName.replace(/'/g, "\\'")} ──'`);
        commandParts.push(rendered);
      }
      const fullScript = commandParts.join('\n');
      playbookResultHtml.value =
        `<div class="mb-1"><span class="text-green-600 dark:text-green-400 font-semibold">${steps.length} 个步骤已渲染</span></div>`
        + `<pre class="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">${escapeHtml(fullScript)}</pre>`;
      if (injectToTerminal(fullScript)) {
        notify.success(`Playbook「${pb.name}」已注入终端`);
        sessionTerminal.focusTerminal();
      }
    } catch (err) {
      playbookResultHtml.value = `<span class="text-red-500">${escapeHtml((err as Error).message)}</span>`;
    } finally {
      playbookRunning.value = false;
    }
  }

  function openPlaybookPanel(): void {
    closeScriptPanel();
    playbookOpen.value = true;
    playbookResultVisible.value = false;
    if (!playbooks.value.length) void loadPlaybooks();
  }

  function closePlaybookPanel(): void {
    playbookOpen.value = false;
    selectedPlaybookId.value = '';
    selectedPlaybook.value = null;
    playbookResultVisible.value = false;
    playbookResultHtml.value = '';
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;
  }

  return {
    scriptOpen,
    playbookOpen,
    scripts,
    playbooks,
    selectedScriptId,
    selectedScript,
    params,
    previewCommand,
    previewError,
    selectedPlaybookId,
    selectedPlaybook,
    playbookRunning,
    playbookResultHtml,
    playbookResultVisible,
    initialize,
    openScriptPanel,
    closeScriptPanel,
    openPlaybookPanel,
    closePlaybookPanel,
    onScriptChange,
    onPlaybookChange,
    updateParam,
    refreshPreview,
    injectScript,
    copyScript,
    runPlaybook,
  };
}

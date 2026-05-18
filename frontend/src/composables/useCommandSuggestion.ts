// useCommandSuggestion.ts — MainConsole 刀 2 · AI 命令面板
// 1:1 复刻 public/command-suggestion.js：/api/complete command mode + 插入当前 session

import { ref, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID, isLocalHost } from '@/utils/mainConsole';
import type { AiApiConfig } from '@/utils/terminal';

interface CommandCompletionResponse {
  completion?: string;
}

export interface CommandSuggestionApi {
  readonly isOpen: Ref<boolean>;
  readonly prompt: Ref<string>;
  readonly result: Ref<string>;
  readonly isGenerating: Ref<boolean>;

  initialize(): void;
  openCmdModal(): void;
  closeCmdModal(): void;
  resetResult(): void;
  generateCommandSuggestion(): Promise<void>;
  copyCommandSuggestion(): Promise<void>;
  insertCommandSuggestion(): void;
}

let _instance: CommandSuggestionApi | null = null;

export function useCommandSuggestion(): CommandSuggestionApi {
  if (!_instance) _instance = createCommandSuggestion();
  return _instance;
}

export function _resetCommandSuggestionSingleton(): void {
  _instance = null;
}

function createCommandSuggestion(): CommandSuggestionApi {
  const hosts = useHostsStore();
  const notify = useNotifyStore();
  const sessionTerminal = useSessionTerminal();
  const { requestJson } = useApiClient();

  let initialized = false;
  const isOpen = ref(false);
  const prompt = ref('');
  const result = ref('');
  const isGenerating = ref(false);

  function resetResult(): void {
    result.value = '';
  }

  function setGenerating(flag: boolean): void {
    isGenerating.value = flag;
  }

  function getHostPromptPrefix(): string {
    const host = hosts.selected || hosts.hostMap.get(sessionTerminal.activeHostId.value) || null;
    if (!host) return '';
    if (isLocalHost(host)) {
      return '[当前主机: 本机 / 本地 Shell]\n';
    }
    return `[当前主机: ${host.name} / ${host.username}@${host.host}:${host.port}]\n`;
  }

  function openCmdModal(): void {
    prompt.value = '';
    resetResult();
    isOpen.value = true;
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      sessionTerminal.term.value?.scrollToBottom?.();
    }, 60);
  }

  function closeCmdModal(): void {
    isOpen.value = false;
    setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  }

  async function generateCommandSuggestion(): Promise<void> {
    const text = prompt.value.trim();
    if (!text || isGenerating.value) return;

    resetResult();
    setGenerating(true);

    try {
      const customConfig: AiApiConfig = window.__aiApiConfig || {};
      const body: Record<string, unknown> = {
        prefix: `${getHostPromptPrefix()}${text}`,
        mode: 'command',
      };
      if (customConfig.apiBase) body.apiBase = customConfig.apiBase;
      if (customConfig.apiKey) body.apiKey = customConfig.apiKey;
      if (customConfig.model) body.model = customConfig.model;

      const response = await requestJson<CommandCompletionResponse>('/api/complete', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      result.value = response.completion || '';
      if (!result.value) result.value = '未生成结果';
    } catch (error) {
      notify.error((error as Error).message || '命令生成失败');
    } finally {
      setGenerating(false);
    }
  }

  async function copyCommandSuggestion(): Promise<void> {
    if (!result.value || result.value === '未生成结果') return;
    try {
      await navigator.clipboard.writeText(result.value);
      notify.success('命令已复制');
    } catch (error) {
      notify.error((error as Error).message || '复制失败');
    }
  }

  function insertCommandSuggestion(): void {
    if (!result.value || result.value === '未生成结果') return;
    if (!sessionTerminal.sendSessionInput(result.value)) return;
    closeCmdModal();
    sessionTerminal.focusTerminal();
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;
  }

  void LOCAL_HOST_ID;

  return {
    isOpen,
    prompt,
    result,
    isGenerating,
    initialize,
    openCmdModal,
    closeCmdModal,
    resetResult,
    generateCommandSuggestion,
    copyCommandSuggestion,
    insertCommandSuggestion,
  };
}

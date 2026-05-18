// useTerminalAi.ts — MainConsole 刀 2 · terminal-ai.js Vue 迁移
// 1:1 复刻 public/terminal-ai.js：本地字典、CSI 解析、本地回显、requestId/inputSnapshot 竞态、Tab/→ 采纳

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Terminal } from '@xterm/xterm';

import {
  AI_DEBOUNCE_MS,
  AI_ECHO_GRACE_MS,
  COMMON_COMMANDS,
  COMMON_COMMANDS_SET,
  type AiApiConfig,
} from '@/utils/terminal';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import { useHostsStore } from '@/stores/hosts';
import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal, type SessionTerminalApi } from '@/composables/useSessionTerminal';

interface InlineCompletionResponse {
  completion?: string;
}

interface ParsedInput {
  printableText: string;
  backspaceCount: number;
  hasControl: boolean;
  submitted: boolean;
  cleared: boolean;
  hasTab: boolean;
}

interface TerminalAiState {
  initialized: boolean;
  bound: boolean;
  inputBuffer: string;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  latestRequestId: number;
  activeRequestId: number;
  activeRequestInput: string;
  pendingAcceptanceRequestId: number;
  ghostText: string;
  hasSelection: boolean;
  lastUserInputAt: number;
  pendingEcho: string;
  outputEchoBuffer: string;
  recentCommands: string[];
  lastGhostRenderedAt: number;
  inEscapeSequence: boolean;
}

export interface TerminalAiApi {
  readonly ghostText: Ref<string>;
  readonly ghostVisible: Ref<boolean>;
  readonly ghostHint: Ref<string>;
  readonly inlinePreviewText: ComputedRef<string>;
  readonly suggestionText: ComputedRef<string>;

  initialize(): void;
  clearGhostText(): void;
  resetInputState(): void;
  getRecentCommands(): string[];
}

declare global {
  interface Window {
    __aiApiConfig?: AiApiConfig;
  }
}

let _instance: TerminalAiApi | null = null;

export function useTerminalAi(): TerminalAiApi {
  if (!_instance) _instance = createTerminalAi();
  return _instance;
}

export function _resetTerminalAiSingleton(): void {
  _instance = null;
}

function createTerminalAi(): TerminalAiApi {
  const hosts = useHostsStore();
  const { requestJson } = useApiClient();
  const sessionTerminal = useSessionTerminal();

  const state: TerminalAiState = {
    initialized: false,
    bound: false,
    inputBuffer: '',
    pendingTimer: null,
    latestRequestId: 0,
    activeRequestId: 0,
    activeRequestInput: '',
    pendingAcceptanceRequestId: 0,
    ghostText: '',
    hasSelection: false,
    lastUserInputAt: 0,
    pendingEcho: '',
    outputEchoBuffer: '',
    recentCommands: [],
    lastGhostRenderedAt: 0,
    inEscapeSequence: false,
  };

  const ghostText = ref('');
  const ghostVisible = ref(false);
  const ghostHint = ref('');
  const inlinePreviewText = computed(() => ghostText.value ? ghostText.value : '');
  const suggestionText = computed(() => ghostText.value ? `${state.inputBuffer}${ghostText.value}` : '等待输入…');

  let retryInterval: ReturnType<typeof setInterval> | null = null;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let selectionDispose: { dispose(): void } | null = null;

  function getTerminal(): Terminal | null {
    return sessionTerminal.term.value;
  }

  function getHostPayload(): Record<string, unknown> {
    const host = hosts.selected || hosts.hostMap.get(sessionTerminal.activeHostId.value) || null;
    return {
      hostId: host?.id || LOCAL_HOST_ID,
      shellType: 'bash',
      platform: host?.type === 'local' ? 'local' : 'linux',
      arch: '',
      cwd: '',
    };
  }

  function resetTimer(): void {
    if (!state.pendingTimer) return;
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }

  function syncGhostRefs(): void {
    ghostText.value = state.ghostText;
    ghostVisible.value = Boolean(state.ghostText);
    ghostHint.value = state.ghostText ? 'Tab / → 采纳，Esc 拒绝' : '';
  }

  function clearGhostText(): void {
    state.ghostText = '';
    syncGhostRefs();
  }

  function invalidatePending(reason = ''): void {
    resetTimer();
    state.activeRequestId = 0;
    state.activeRequestInput = '';
    if (reason !== 'echo-buffer-only') {
      clearGhostText();
    }
    if (reason === 'selection') {
      state.hasSelection = true;
    }
  }

  function resetInputState(): void {
    state.inputBuffer = '';
    state.hasSelection = false;
    state.pendingEcho = '';
    state.outputEchoBuffer = '';
    invalidatePending();
  }

  function rememberCommittedCommand(rawCommand: string): void {
    const command = String(rawCommand || '').trim();
    if (!command) return;
    state.recentCommands = [...state.recentCommands, command].slice(-5);
  }

  function tryLocalCompletion(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';
    const words = trimmed.split(/\s+/);
    const lastWord = words[words.length - 1];
    if (!lastWord) return '';
    const match = COMMON_COMMANDS.find(
      (cmd) => cmd.startsWith(lastWord) && cmd.length > lastWord.length
    );
    if (!match) return '';
    return match.slice(lastWord.length);
  }

  function applyPrintableChunk(text: string): void {
    if (!text) return;
    state.inputBuffer += text;
    state.pendingEcho += text;
    state.hasSelection = false;
    resetTimer();
    state.activeRequestId = 0;
    state.activeRequestInput = '';

    const local = tryLocalCompletion(state.inputBuffer);
    if (local) {
      renderGhostText(local);
      return;
    }
    clearGhostText();
    scheduleCompletion();
  }

  function applyBackspace(count: number): void {
    if (!count) return;
    state.inputBuffer = state.inputBuffer.slice(0, -count);
    state.pendingEcho = state.pendingEcho.slice(0, -count);
    resetTimer();
    state.activeRequestId = 0;
    state.activeRequestInput = '';

    const local = tryLocalCompletion(state.inputBuffer);
    if (local) {
      renderGhostText(local);
      return;
    }
    clearGhostText();
    scheduleCompletion();
  }

  function splitControlSequence(data: string): ParsedInput {
    if (!data) {
      return { printableText: '', backspaceCount: 0, hasControl: false, submitted: false, cleared: false, hasTab: false };
    }

    let printableText = '';
    let backspaceCount = 0;
    let hasControl = false;
    let submitted = false;
    let cleared = false;
    let hasTab = false;
    let inEsc = false;
    let inCsi = false;

    const chars = String(data);
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      const code = chars.charCodeAt(i);

      if (inCsi) {
        if (code >= 0x40 && code <= 0x7E) {
          inCsi = false;
        }
        continue;
      }

      if (inEsc) {
        inEsc = false;
        if (char === '[') {
          inCsi = true;
          continue;
        }
        continue;
      }

      if (code === 0x1B) {
        hasControl = true;
        inEsc = true;
        continue;
      }

      if (char === '\r' || char === '\n') {
        hasControl = true;
        submitted = true;
        continue;
      }

      if (code === 0x03 || code === 0x04 || code === 0x15) {
        hasControl = true;
        cleared = true;
        continue;
      }

      if (code === 0x0C) {
        hasControl = true;
        continue;
      }

      if (code === 0x7F) {
        hasControl = true;
        backspaceCount += 1;
        continue;
      }

      if (code === 0x09) {
        hasControl = true;
        hasTab = true;
        continue;
      }

      if (code < 0x20) {
        hasControl = true;
        continue;
      }

      printableText += char;
    }

    return { printableText, backspaceCount, hasControl, submitted, cleared, hasTab };
  }

  function handleInputMirror(data: string): void {
    if (!data) return;
    state.lastUserInputAt = Date.now();

    const parsed = splitControlSequence(data);

    if (parsed.cleared) {
      state.inputBuffer = '';
      state.pendingEcho = '';
      state.outputEchoBuffer = '';
      invalidatePending();
    }

    if (parsed.backspaceCount) {
      applyBackspace(parsed.backspaceCount);
    }

    if (parsed.printableText) {
      applyPrintableChunk(parsed.printableText);
    }

    if (parsed.submitted) {
      rememberCommittedCommand(state.inputBuffer);
      state.inputBuffer = '';
      state.pendingEcho = '';
      state.outputEchoBuffer = '';
      invalidatePending();
    }

    if (parsed.hasControl && !parsed.hasTab && !parsed.backspaceCount && !parsed.printableText && !parsed.submitted && !parsed.cleared) {
      invalidatePending();
    }
  }

  function normalizeTerminalOutput(output: string): string {
    return String(output || '')
      .replace(/\[[0-9;?]*[ -/]*[@-~]/gu, '')
      .replace(/[@-_]/gu, '')
      .replace(/\].*?(?:|\\)/gu, '')
      .replace(/\r/g, '')
      .replace(/[ --]/g, '');
  }

  function isLikelyLocalEcho(output: string): boolean {
    if (!output) return false;

    const normalizedOutput = normalizeTerminalOutput(output);
    const trimmedOutput = normalizedOutput.trim();
    const now = Date.now();

    if (!trimmedOutput) return true;

    if (state.ghostText && now - state.lastGhostRenderedAt < 1200 && normalizedOutput.length <= 16) {
      return true;
    }

    if (!state.pendingEcho) {
      if (now - state.lastUserInputAt < AI_ECHO_GRACE_MS && normalizedOutput.length < 10) {
        return true;
      }
      return false;
    }

    if (now - state.lastUserInputAt > AI_ECHO_GRACE_MS) return false;

    state.outputEchoBuffer = `${state.outputEchoBuffer}${normalizedOutput}`.slice(
      -Math.max(512, state.pendingEcho.length * 4)
    );

    if (state.outputEchoBuffer.includes(state.pendingEcho)) {
      state.pendingEcho = '';
      state.outputEchoBuffer = '';
      return true;
    }

    if (state.pendingEcho.endsWith(normalizedOutput)) {
      return true;
    }

    if (state.pendingEcho.includes(normalizedOutput)) {
      return true;
    }

    if (state.ghostText && normalizedOutput.length <= Math.max(16, state.inputBuffer.length + state.ghostText.length)) {
      const currentLine = `${state.inputBuffer}${state.ghostText}`;
      if (currentLine.includes(trimmedOutput) || currentLine.startsWith(trimmedOutput)) {
        return true;
      }
    }

    return false;
  }

  function acceptGhostText(): boolean {
    if (!state.ghostText) return false;

    const accepted = state.ghostText;
    const requestId = state.activeRequestId;
    const requestInput = state.activeRequestInput;
    const ok = sessionTerminal.sendSessionInput(accepted, { source: 'terminal-ai-ghost' });
    if (!ok) return false;

    state.inputBuffer += accepted;
    clearGhostText();

    if (requestId && requestInput) {
      state.pendingAcceptanceRequestId = requestId;
      state.activeRequestId = 0;
      state.activeRequestInput = '';
    }

    return true;
  }

  function shouldRequestCompletion(): boolean {
    if (state.hasSelection) return false;
    if (state.ghostText) return false;

    const trimmed = state.inputBuffer.trim();
    if (!trimmed.includes(' ')) return false;
    const baseCmd = trimmed.split(/\s+/)[0];
    if (!COMMON_COMMANDS_SET.has(baseCmd)) return false;

    const term = getTerminal();
    if (!term) return false;
    if (typeof term.hasSelection === 'function' && term.hasSelection()) return false;
    return true;
  }

  function renderGhostText(completion: string): void {
    state.ghostText = completion;
    state.lastGhostRenderedAt = Date.now();
    syncGhostRefs();
  }

  async function requestInlineCompletion(requestId: number, inputSnapshot: string): Promise<void> {
    try {
      const customConfig = window.__aiApiConfig || {};
      const body: Record<string, unknown> = {
        ...getHostPayload(),
        currentInput: inputSnapshot,
        cursorIndex: inputSnapshot.length,
        recentCommands: state.recentCommands,
      };
      if (customConfig.apiBase) body.apiBase = customConfig.apiBase;
      if (customConfig.apiKey) body.apiKey = customConfig.apiKey;
      if (customConfig.model) body.model = customConfig.model;

      const response = await requestJson<InlineCompletionResponse>('/api/ai/terminal/complete-inline', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (requestId === state.pendingAcceptanceRequestId && inputSnapshot === state.inputBuffer) {
        state.pendingAcceptanceRequestId = 0;
        return;
      }
      if (requestId !== state.activeRequestId) return;
      if (inputSnapshot !== state.inputBuffer) return;

      const completion = String(response.completion || '');
      if (!completion) {
        clearGhostText();
        return;
      }

      renderGhostText(completion);
    } catch {
      if (requestId === state.activeRequestId) {
        clearGhostText();
      }
    }
  }

  function scheduleCompletion(): void {
    resetTimer();
    if (!shouldRequestCompletion()) return;

    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;

      if (!shouldRequestCompletion()) return;
      const inputSnapshot = state.inputBuffer;
      const requestId = state.latestRequestId + 1;
      state.latestRequestId = requestId;
      state.activeRequestId = requestId;
      state.activeRequestInput = inputSnapshot;
      requestInlineCompletion(requestId, inputSnapshot);
    }, AI_DEBOUNCE_MS);
  }

  function syncSelectionState(): void {
    const term = getTerminal();
    if (!term || typeof term.hasSelection !== 'function') return;

    state.hasSelection = term.hasSelection();
    if (state.hasSelection) {
      invalidatePending('selection');
    }
  }

  function attachKeyboardInterception(): void {
    const term = getTerminal();
    if (!term || typeof term.attachCustomKeyEventHandler !== 'function') return;

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (!state.ghostText) return true;

      if (event.type !== 'keydown') return true;

      if (event.key === 'Tab' || event.key === 'ArrowRight') {
        event.preventDefault();
        return !acceptGhostText();
      }

      if (event.key === 'Escape') {
        clearGhostText();
        event.preventDefault();
        return false;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        invalidatePending();
      }

      return true;
    });
  }

  function bindTerminalEvents(stm: SessionTerminalApi): void {
    stm.onInput(({ data, meta }) => {
      if (meta?.source === 'terminal-ai-ghost') return;
      handleInputMirror(String(data || ''));
    });

    stm.onOutput(({ data }) => {
      const output = String(data || '');
      if (isLikelyLocalEcho(output)) {
        return;
      }
      if (state.ghostText && Date.now() - state.lastGhostRenderedAt < 1200) {
        return;
      }
      invalidatePending();
    });

    stm.onLifecycle(({ type }) => {
      if (['clear', 'reset', 'session-change', 'host-switch-start', 'socket-disconnect', 'session-error'].includes(type)) {
        resetInputState();
      }
    });
  }

  function tryBind(): void {
    if (state.bound) return;

    const term = getTerminal();
    if (!sessionTerminal || !term) return;

    state.bound = true;
    bindTerminalEvents(sessionTerminal);

    if (typeof term.onSelectionChange === 'function') {
      selectionDispose = term.onSelectionChange(() => syncSelectionState());
    }

    attachKeyboardInterception();
  }

  function initialize(): void {
    if (state.initialized) return;
    state.initialized = true;
    clearGhostText();
    tryBind();

    if (!state.bound) {
      retryInterval = setInterval(() => {
        tryBind();
        if (state.bound && retryInterval) clearInterval(retryInterval);
      }, 500);
      retryTimeout = setTimeout(() => {
        if (retryInterval) clearInterval(retryInterval);
      }, 20_000);
    }
  }

  void selectionDispose;
  void retryTimeout;

  return {
    ghostText,
    ghostVisible,
    ghostHint,
    inlinePreviewText,
    suggestionText,
    initialize,
    clearGhostText,
    resetInputState,
    getRecentCommands: () => [...state.recentCommands],
  };
}

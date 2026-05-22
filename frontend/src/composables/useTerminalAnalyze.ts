// useTerminalAnalyze.ts — MainConsole 刀 3 阶段 1 · 终端选区 AI 分析
// 1:1 复刻 [public/terminal-analyze.js](public/terminal-analyze.js)（384 行）
// 单例：FAB 显隐 / 右键菜单 / 分析面板 / 选区轮询 + 80ms 防抖 / lifecycle 驱动延迟绑定

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useTerminalAi } from '@/composables/useTerminalAi';
import { useHostsStore } from '@/stores/hosts';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { AiApiConfig } from '@/utils/terminal';

type RiskLevel = 'safe' | 'caution' | 'danger' | null;
type ErrorType = 'permission_denied' | 'command_not_found' | 'oom' | 'network_error' | 'syntax_error' | 'other' | null;

interface AnalysisResult {
  summary?: string;
  errorType?: ErrorType;
  fixSuggestion?: string | null;
  riskLevel?: RiskLevel;
}

const RISK_LABELS: Record<NonNullable<RiskLevel>, { text: string; cls: string }> = {
  safe: { text: '低风险', cls: 'risk-safe' },
  caution: { text: '中风险，请确认', cls: 'risk-caution' },
  danger: { text: '高风险，仅复制', cls: 'risk-danger' },
};

const ERROR_TYPE_LABELS: Record<string, string> = {
  permission_denied: '权限不足',
  command_not_found: '命令不存在',
  oom: '内存不足 (OOM)',
  network_error: '网络错误',
  syntax_error: '语法错误',
  other: '其他错误',
};

declare global {
  interface Window {
    __aiApiConfig?: AiApiConfig;
  }
}

export interface TerminalAnalyzeApi {
  readonly fabVisible: Ref<boolean>;
  readonly ctxVisible: Ref<boolean>;
  readonly ctxLeft: Ref<number>;
  readonly ctxTop: Ref<number>;
  readonly panelOpen: Ref<boolean>;
  readonly loading: Ref<boolean>;
  readonly result: Ref<AnalysisResult | null>;
  readonly selectedText: Ref<string>;
  readonly previewExpanded: Ref<boolean>;
  readonly previewText: ComputedRef<string>;
  readonly previewToggleLabel: ComputedRef<string>;
  readonly previewToggleVisible: ComputedRef<boolean>;
  readonly confirmVisible: Ref<boolean>;
  readonly riskLabel: ComputedRef<{ text: string; cls: string } | null>;
  readonly errorTypeLabel: ComputedRef<string>;
  readonly insertVisible: ComputedRef<boolean>;

  initialize(): void;
  closePanel(): void;
  hideCtxMenu(): void;
  triggerAnalysis(): void;
  copySelectedText(): Promise<void>;
  togglePreview(): void;
  copyCommand(): Promise<void>;
  handleInsertClick(): void;
  confirmInsert(): void;
  cancelInsert(): void;
}

let _instance: TerminalAnalyzeApi | null = null;

export function useTerminalAnalyze(): TerminalAnalyzeApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetTerminalAnalyzeSingleton(): void {
  _instance = null;
}

function create(): TerminalAnalyzeApi {
  const { requestJson } = useApiClient();
  const sessionTerminal = useSessionTerminal();
  const terminalAi = useTerminalAi();
  const hosts = useHostsStore();

  const fabVisible = ref(false);
  const ctxVisible = ref(false);
  const ctxLeft = ref(0);
  const ctxTop = ref(0);
  const panelOpen = ref(false);
  const loading = ref(false);
  const result = ref<AnalysisResult | null>(null);
  const selectedText = ref('');
  const previewExpanded = ref(false);
  const confirmVisible = ref(false);

  const previewText = computed(() => {
    const text = selectedText.value;
    if (!text) return '';
    const lines = text.split('\n');
    if (lines.length <= 10) return text;
    return previewExpanded.value ? text : lines.slice(0, 10).join('\n') + '\n…';
  });
  const previewToggleVisible = computed(() => selectedText.value.split('\n').length > 10);
  const previewToggleLabel = computed(() => previewExpanded.value ? '收起' : '展开全部');

  const riskLabel = computed(() => {
    const r = result.value?.riskLevel;
    if (!r) return null;
    return RISK_LABELS[r] || RISK_LABELS.caution;
  });
  const errorTypeLabel = computed(() => {
    const t = result.value?.errorType;
    if (!t) return '';
    return ERROR_TYPE_LABELS[t] || t;
  });
  const insertVisible = computed(() => {
    const r = result.value;
    return Boolean(r?.fixSuggestion) && r?.riskLevel !== 'danger';
  });

  let initialized = false;
  let selectionBound = false;
  let isAnalyzing = false;
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let onContextMenuListener: ((event: MouseEvent) => void) | null = null;
  let boundElement: HTMLElement | null = null;

  function getHostPayload(): { hostId: string; shellType: string; platform: string } {
    const host = hosts.selected || hosts.hostMap.get(sessionTerminal.activeHostId.value);
    return {
      hostId: host?.id || LOCAL_HOST_ID,
      shellType: 'bash',
      platform: host?.type === 'local' ? 'local' : 'linux',
    };
  }

  // ── FAB & ctx menu ───────────────────────────────────────────────

  function showCtxMenu(x: number, y: number): void {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const menuW = 160;
    const menuH = 48;
    ctxLeft.value = x + menuW > vpW ? vpW - menuW - 6 : x;
    ctxTop.value = y + menuH > vpH ? vpH - menuH - 6 : y;
    ctxVisible.value = true;
  }

  function hideCtxMenu(): void {
    ctxVisible.value = false;
  }

  // ── 选区轮询 ──────────────────────────────────────────────────────

  function pollSelection(): void {
    const term = sessionTerminal.term.value;
    if (!term) return;
    if (typeof term.hasSelection === 'function' && term.hasSelection()) {
      const sel = typeof term.getSelection === 'function' ? term.getSelection() : '';
      if (sel && sel.trim().length >= 3) {
        selectedText.value = sel;
        fabVisible.value = true;
        return;
      }
    }
    fabVisible.value = false;
  }

  // ── 绑定（lifecycle 驱动，解决竞态） ─────────────────────────────

  function bindSelectionEvents(): void {
    if (selectionBound) return;
    const term = sessionTerminal.term.value;
    if (!term) return;
    selectionBound = true;

    if (typeof term.onSelectionChange === 'function') {
      term.onSelectionChange(() => {
        if (selectionTimer) clearTimeout(selectionTimer);
        selectionTimer = setTimeout(pollSelection, 80);
      });
    }

    const el = term.element as HTMLElement | undefined;
    if (el) {
      boundElement = el;
      onContextMenuListener = (event: MouseEvent): void => {
        const term2 = sessionTerminal.term.value;
        const hasSel = typeof term2?.hasSelection === 'function' && term2.hasSelection();
        const sel = hasSel && typeof term2?.getSelection === 'function' ? term2.getSelection() : '';
        if (sel && sel.trim().length >= 3) {
          event.preventDefault();
          selectedText.value = sel;
          showCtxMenu(event.clientX, event.clientY);
        } else {
          hideCtxMenu();
        }
      };
      el.addEventListener('contextmenu', onContextMenuListener);
    }
  }

  function tryBindSelectionEvents(): void {
    if (selectionBound) return;
    requestAnimationFrame(() => bindSelectionEvents());
  }

  // ── 触发分析 ──────────────────────────────────────────────────────

  function triggerAnalysis(): void {
    const text = selectedText.value.trim();
    if (text.length < 3) return;
    hideCtxMenu();
    fabVisible.value = false;
    void runAnalysis(selectedText.value);
  }

  async function copySelectedText(): Promise<void> {
    const term = sessionTerminal.term.value;
    const selection = typeof term?.getSelection === 'function' ? term.getSelection() : selectedText.value;
    const text = selection || selectedText.value;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    hideCtxMenu();
  }

  async function runAnalysis(text: string): Promise<void> {
    if (isAnalyzing) return;
    isAnalyzing = true;
    selectedText.value = text;
    previewExpanded.value = false;
    panelOpen.value = true;
    confirmVisible.value = false;
    loading.value = true;
    result.value = null;

    try {
      const customConfig = window.__aiApiConfig || {};
      const recentCommands = terminalAi.getRecentCommands();
      const body: Record<string, unknown> = {
        ...getHostPayload(),
        selectedText: text,
        recentCommands,
      };
      if (customConfig.apiBase) body.apiBase = customConfig.apiBase;
      if (customConfig.apiKey) body.apiKey = customConfig.apiKey;
      if (customConfig.model) body.model = customConfig.model;

      const resp = await requestJson<AnalysisResult>(
        '/api/ai/terminal/analyze-selection',
        { method: 'POST', body: JSON.stringify(body) }
      );
      result.value = resp;
    } catch (err) {
      result.value = {
        summary: `分析失败：${(err as Error).message}`,
        errorType: null,
        fixSuggestion: null,
        riskLevel: null,
      };
    } finally {
      loading.value = false;
      isAnalyzing = false;
    }
  }

  function togglePreview(): void {
    previewExpanded.value = !previewExpanded.value;
  }

  function closePanel(): void {
    panelOpen.value = false;
    confirmVisible.value = false;
  }

  function insertCommand(): void {
    const fix = result.value?.fixSuggestion;
    if (!fix) return;
    sessionTerminal.sendSessionInput(fix);
    closePanel();
    sessionTerminal.focusTerminal();
  }

  function handleInsertClick(): void {
    const r = result.value;
    if (!r?.fixSuggestion) return;
    if (r.riskLevel === 'caution') {
      confirmVisible.value = true;
      return;
    }
    insertCommand();
  }

  function confirmInsert(): void {
    confirmVisible.value = false;
    insertCommand();
  }

  function cancelInsert(): void {
    confirmVisible.value = false;
  }

  async function copyCommand(): Promise<void> {
    const fix = result.value?.fixSuggestion;
    if (!fix) return;
    await navigator.clipboard.writeText(fix);
  }

  // ── 全局事件（关闭右键菜单） ─────────────────────────────────────

  function onDocClick(event: MouseEvent): void {
    if (!ctxVisible.value) return;
    // 右键菜单 DOM 在 MainConsoleView，组件根带 data-analyze-ctx 标记。
    // 点击落在菜单内不关；其他位置（含 FAB）关闭。
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-analyze-ctx]')) return;
    hideCtxMenu();
  }

  function onDocKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') hideCtxMenu();
  }

  function onDocScroll(): void {
    hideCtxMenu();
  }

  // ── 初始化 ───────────────────────────────────────────────────────

  function initialize(): void {
    if (initialized) return;
    initialized = true;

    sessionTerminal.onLifecycle(({ type }) => {
      if (type === 'socket-connect' || type === 'session-change' || type === 'clear') {
        tryBindSelectionEvents();
      }
    });
    tryBindSelectionEvents();

    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKeydown);
    document.addEventListener('scroll', onDocScroll, { passive: true, capture: true });
  }

  // 防 TS 抖：boundElement / onContextMenuListener 单例生命周期内不释放
  void boundElement;
  void onContextMenuListener;

  return {
    fabVisible,
    ctxVisible,
    ctxLeft,
    ctxTop,
    panelOpen,
    loading,
    result,
    selectedText,
    previewExpanded,
    previewText,
    previewToggleLabel,
    previewToggleVisible,
    confirmVisible,
    riskLabel,
    errorTypeLabel,
    insertVisible,
    initialize,
    closePanel,
    hideCtxMenu,
    triggerAnalysis,
    copySelectedText,
    togglePreview,
    copyCommand,
    handleInsertClick,
    confirmInsert,
    cancelInsert,
  };
}

// useIdePanel.ts — MainConsole 刀 5a · 1Shell AI 右栏面板
// 1:1 复刻 [public/ide-panel.js](public/ide-panel.js)（467 行）
// 单例：socket lifecycle 绑定 / safe / cc / unlimited 三 toggle / 安全模式审批 / send / stop / clear
//
// 老版 index.html 实际没有 ide-tool-toggle / ide-tool-picker / ide-tool-chips DOM
// （ide-panel.js 里 getElementById 为 null 时静默 no-op），故 1:1 不带工具选择器 UI
// → 不调 loadTools / buildContext 也不带 skills / mcpServers 字段（用户看到的与老版一致）

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';

interface MinimalSocket {
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener?: (...args: unknown[]) => void): unknown;
}

type LineKind = 'stdout' | 'stderr' | 'info' | 'error' | 'success' | 'stream';

export interface IdeLine {
  kind: LineKind;
  text: string;
}

export interface IdeTurn {
  role: 'user' | 'assistant';
  /** user：纯文本；assistant：line 序列（流式 push） */
  text?: string;
  lines?: IdeLine[];
}

export interface IdeApproveRequest {
  requestId: string;
  sessionId: string;
  title: string;
  toolName: string;
  detail: string;
  /** 剩余秒数（响应式倒计时） */
  countdown: number;
}

export interface IdePanelApi {
  readonly turns: Ref<IdeTurn[]>;
  readonly isRunning: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly statusText: Ref<string>;
  readonly safeMode: Ref<boolean>;
  readonly claudeCodeEnabled: Ref<boolean>;
  readonly unlimitedTurns: Ref<boolean>;
  readonly approveRequest: Ref<IdeApproveRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly hasMessages: ComputedRef<boolean>;

  initialize(): void;
  sendMessage(): void;
  stop(): void;
  resetChat(): void;
  setSafeMode(v: boolean): void;
  setClaudeCodeEnabled(v: boolean): void;
  setUnlimitedTurns(v: boolean): void;
  approveAllow(): void;
  approveDeny(): void;
  approveCustom(): void;
}

let _instance: IdePanelApi | null = null;

export function useIdePanel(): IdePanelApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetIdePanelSingleton(): void {
  _instance = null;
}

function truncate(s: unknown): string {
  const t = String(s ?? '').trim();
  return t.length > 2000 ? t.slice(0, 2000) + '\n...[truncated]' : t;
}

function genSessionId(): string {
  return 'ide-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create(): IdePanelApi {
  const sessionTerminal = useSessionTerminal();
  const hosts = useHostsStore();
  const notify = useNotifyStore();

  const turns = ref<IdeTurn[]>([]);
  const isRunning = ref(false);
  const inputText = ref('');
  const statusText = ref('待命');
  const safeMode = ref(true);
  const claudeCodeEnabled = ref(false);
  const unlimitedTurns = ref(false);

  const approveRequest = ref<IdeApproveRequest | null>(null);
  const approveCustomText = ref('');
  let approveTickHandle: number | null = null;

  const hasMessages = computed(() => turns.value.length > 0);

  let sessionId: string | null = null;
  let socket: MinimalSocket | null = null;
  let currentAssistant: IdeTurn | null = null;
  let currentTextHadDelta = false;
  let stopFallbackHandle: number | null = null;
  let sendAckHandle: number | null = null;
  let activeRunId: string | null = null;
  let stopRequested = false;
  const stoppedRunIds = new Set<string>();

  interface IdeSocketMessage {
    sessionId?: string;
    runId?: string;
  }

  function matchesCurrentRun(msg: IdeSocketMessage | null | undefined, options: { allowStopped?: boolean; allowAfterStop?: boolean } = {}): boolean {
    if (!msg || msg.sessionId !== sessionId) return false;
    if (msg.runId) {
      if (stoppedRunIds.has(msg.runId) && !options.allowStopped) return false;
      if (activeRunId && msg.runId !== activeRunId) return false;
      activeRunId = msg.runId;
    }
    if (stopRequested && !options.allowAfterStop) return false;
    return true;
  }

  function rememberStoppedRun(runId = activeRunId): void {
    if (!runId) return;
    stoppedRunIds.add(runId);
    if (stoppedRunIds.size > 20) {
      const firstStopped = stoppedRunIds.values().next().value;
      if (firstStopped) stoppedRunIds.delete(firstStopped);
    }
  }

  function getSocket(): MinimalSocket | null {
    const s = sessionTerminal.getSocket?.() as MinimalSocket | undefined | null;
    return s ?? null;
  }

  function setStatus(text: string): void { statusText.value = text; }

  function pushUser(text: string): void {
    turns.value.push({ role: 'user', text });
    currentAssistant = null;
  }

  function ensureAssistant(): IdeTurn {
    if (!currentAssistant) {
      const t: IdeTurn = { role: 'assistant', lines: [] };
      turns.value.push(t);
      currentAssistant = t;
    }
    return currentAssistant;
  }

  function appendLine(kind: LineKind, text: string): void {
    const t = ensureAssistant();
    t.lines!.push({ kind, text });
  }

  /** 流式增量追加 — 只拼接到最后一个 'stream' line。
   *  用专门的 'stream' kind 与 'stdout'（工具结果）区分，避免在
   *  text-delta → tool-end → text-delta 序列里把第二段 AI 文本拼到工具结果末尾。 */
  function appendDelta(text: string): void {
    const t = ensureAssistant();
    const lines = t.lines!;
    const last = lines[lines.length - 1];
    if (last && last.kind === 'stream') {
      last.text += text;
    } else {
      lines.push({ kind: 'stream', text });
    }
  }

  function finalize(): void {
    isRunning.value = false;
    stopRequested = false;
    currentAssistant = null;
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
    if (stopFallbackHandle !== null) {
      window.clearTimeout(stopFallbackHandle);
      stopFallbackHandle = null;
    }
    if (sendAckHandle !== null) {
      window.clearTimeout(sendAckHandle);
      sendAckHandle = null;
    }
  }

  function clearApproveTick(): void {
    if (approveTickHandle !== null) {
      window.clearInterval(approveTickHandle);
      approveTickHandle = null;
    }
  }

  function respondApprove(action: 'allow' | 'deny' | 'custom', text = ''): void {
    const req = approveRequest.value;
    if (!req || !socket) {
      approveRequest.value = null;
      clearApproveTick();
      return;
    }
    socket.emit('ide:approve-response', {
      requestId: req.requestId,
      sessionId: req.sessionId,
      action,
      text: text || '',
    });
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
  }

  function approveAllow(): void { respondApprove('allow'); }
  function approveDeny(): void { respondApprove('deny'); }
  function approveCustom(): void {
    const text = approveCustomText.value.trim();
    if (!text) return;
    respondApprove('custom', text);
  }

  function bindSocket(): void {
    const s = getSocket();
    if (!s || socket === s) return;
    socket = s;

    s.on('ide:thinking', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage;
      if (!matchesCurrentRun(msg)) return;
      currentTextHadDelta = false;
      setStatus('思考中...');
    });
    s.on('ide:text', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & { text?: string };
      if (!matchesCurrentRun(msg) || !msg.text || currentTextHadDelta) return;
      appendDelta(msg.text);
    });
    s.on('ide:text-delta', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & { delta?: string };
      if (!matchesCurrentRun(msg) || !msg.delta) return;
      currentTextHadDelta = true;
      setStatus('生成中...');
      appendDelta(msg.delta);
    });
    s.on('ide:tool-start', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & { name?: string; input?: unknown };
      if (!matchesCurrentRun(msg)) return;
      const inputStr = msg.input ? ` ${JSON.stringify(msg.input).slice(0, 100)}` : '';
      appendLine('info', `⚙ ${msg.name ?? ''}${inputStr}`);
    });
    s.on('ide:tool-end', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & { result?: unknown; is_error?: boolean };
      if (!matchesCurrentRun(msg)) return;
      appendLine(msg.is_error ? 'stderr' : 'stdout', truncate(msg.result));
    });
    s.on('ide:done', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & { round?: number };
      if (!matchesCurrentRun(msg)) return;
      setStatus(`完成 (${msg.round ?? 0} 轮)`);
      finalize();
    });
    s.on('ide:error', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & { error?: string };
      if (!matchesCurrentRun(msg)) return;
      setStatus('出错');
      appendLine('error', `✘ ${msg.error || '未知错误'}`);
      finalize();
    });
    s.on('ide:cancelled', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage;
      if (!matchesCurrentRun(msg, { allowStopped: true, allowAfterStop: true })) return;
      rememberStoppedRun(msg.runId);
      setStatus('已取消');
      finalize();
    });

    s.on('ide:approve-request', (...args: unknown[]) => {
      const msg = args[0] as IdeSocketMessage & {
        requestId?: string;
        title?: string;
        toolName?: string;
        detail?: string;
      };
      if (!matchesCurrentRun(msg) || !msg.requestId) return;

      clearApproveTick();
      approveCustomText.value = '';
      approveRequest.value = {
        requestId: msg.requestId,
        sessionId: msg.sessionId!,
        title: msg.title || '安全模式',
        toolName: msg.toolName || '操作',
        detail: msg.detail || '',
        countdown: 120,
      };
      // 1:1 复刻 ide-panel.js:331-336 — 120s 倒计时,到 0 自动拒绝
      approveTickHandle = window.setInterval(() => {
        const req = approveRequest.value;
        if (!req) { clearApproveTick(); return; }
        req.countdown -= 1;
        if (req.countdown <= 0) respondApprove('deny');
      }, 1000);
    });
  }

  function setSafeMode(v: boolean): void {
    safeMode.value = v;
    if (socket && sessionId) {
      socket.emit('ide:safe-mode', { sessionId, enabled: v });
    }
  }

  function setClaudeCodeEnabled(v: boolean): void {
    claudeCodeEnabled.value = v;
    if (socket && sessionId) {
      socket.emit('ide:claude-code-collab', { sessionId, enabled: v });
    }
  }

  function setUnlimitedTurns(v: boolean): void {
    unlimitedTurns.value = v;
    if (socket && sessionId) {
      socket.emit('ide:unlimited-turns', { sessionId, enabled: v });
    }
  }

  function buildContext(): Record<string, unknown> {
    const ctx: { hosts?: Array<Record<string, unknown>> } = {};
    const hostId = sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
    const host = hosts.hostMap.get(hostId);
    if (host) {
      ctx.hosts = [{
        id: host.id || 'local',
        name: host.name,
        username: (host as { username?: string }).username,
        host: (host as { host?: string }).host,
        port: (host as { port?: number }).port,
      }];
    }
    return ctx;
  }

  function sendMessage(): void {
    const text = inputText.value.trim();
    if (!text || isRunning.value) return;
    if (!socket) bindSocket();
    if (!socket) {
      notify.error('Socket 未连接');
      return;
    }

    if (!sessionId) {
      sessionId = genSessionId();
      socket.emit('ide:safe-mode', { sessionId, enabled: safeMode.value });
      if (claudeCodeEnabled.value) {
        socket.emit('ide:claude-code-collab', { sessionId, enabled: true });
      }
      if (unlimitedTurns.value) {
        socket.emit('ide:unlimited-turns', { sessionId, enabled: true });
      }
    }

    activeRunId = null;
    stopRequested = false;
    pushUser(text);
    inputText.value = '';

    // 提前建 assistant turn,触发"思考中..."占位（与老 renderAiTurn 同步）
    ensureAssistant();
    isRunning.value = true;
    setStatus('启动中...');

    sendAckHandle = window.setTimeout(() => {
      setStatus('启动超时');
      appendLine('error', 'ide:message 未收到确认，请检查 Socket 连接');
      finalize();
    }, 8000);

    socket.emit('ide:message', {
      sessionId,
      message: text,
      context: buildContext(),
      safeMode: safeMode.value,
      claudeCodeEnabled: claudeCodeEnabled.value,
      unlimitedTurns: unlimitedTurns.value,
    }, (ack: { ok?: boolean; error?: string } | undefined) => {
      if (sendAckHandle !== null) {
        window.clearTimeout(sendAckHandle);
        sendAckHandle = null;
      }
      if (!ack?.ok) {
        setStatus('启动失败');
        appendLine('error', ack?.error || 'ide:message 被拒绝');
        finalize();
      }
    });
  }

  function stop(): void {
    if (!socket || !sessionId) return;
    const stoppedSessionId = sessionId;
    stopRequested = true;
    rememberStoppedRun();
    socket.emit('ide:stop', { sessionId: stoppedSessionId }, (ack: { ok?: boolean } | undefined) => {
      if (!ack?.ok && isRunning.value) {
        setStatus('停止请求失败');
        finalize();
      }
    });
    setStatus('正在停止...');
    if (stopFallbackHandle !== null) window.clearTimeout(stopFallbackHandle);
    stopFallbackHandle = window.setTimeout(() => {
      if (isRunning.value && sessionId === stoppedSessionId) {
        setStatus('已停止');
        finalize();
      }
    }, 2500);
  }

  function resetChat(): void {
    if (isRunning.value) return;
    if (sessionId && socket) {
      socket.emit('ide:clear', { sessionId });
    }
    sessionId = null;
    activeRunId = null;
    stopRequested = false;
    stoppedRunIds.clear();
    currentAssistant = null;
    turns.value = [];
    setStatus('待命');
  }

  let initialized = false;
  function initialize(): void {
    if (initialized) return;
    initialized = true;
    // socket 未就绪时轮询直至 getSocket 返回,与老 ide-panel.js:452-455 一致
    const waitSocket = window.setInterval(() => {
      if (getSocket()) {
        window.clearInterval(waitSocket);
        bindSocket();
      }
    }, 500);
  }

  return {
    turns,
    isRunning,
    inputText,
    statusText,
    safeMode,
    claudeCodeEnabled,
    unlimitedTurns,
    approveRequest,
    approveCustomText,
    hasMessages,
    initialize,
    sendMessage,
    stop,
    resetChat,
    setSafeMode,
    setClaudeCodeEnabled,
    setUnlimitedTurns,
    approveAllow,
    approveDeny,
    approveCustom,
  };
}

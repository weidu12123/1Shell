// useAiFab.ts — P5 跨页浮动 1Shell AI · 业务 composable
// 1:1 复刻 [public/ai-fab.js](public/ai-fab.js)（482 行）
// 与 useIdePanel（MainConsole 内置 1Shell AI）独立 —— sessionId 用 `fab-*` 前缀,会话隔离
// 拖拽位置 + 持久化 + 模块感知由 AppAiFab.vue 处理；本 composable 只管业务
//
// 1:1 沿用 ai-fab.js:273-283：自己 new io() 独立 socket 连接,不复用 useSessionTerminal 的主终端 socket。
// 原因：(1) 老版本就这样;(2) 复用 useSessionTerminal 会把 xterm 等重量级依赖 hoist 到 root bundle,
// 影响非 MainConsole 7 页的初次加载性能。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';

import { useNotifyStore } from '@/stores/notify';

type LineKind = 'stdout' | 'stderr' | 'info' | 'error' | 'success' | 'stream';

export interface FabLine {
  kind: LineKind;
  text: string;
}

export interface FabTurn {
  role: 'user' | 'assistant';
  text?: string;
  lines?: FabLine[];
}

export interface FabApproveRequest {
  requestId: string;
  sessionId: string;
  title: string;
  toolName: string;
  detail: string;
  countdown: number;
}

export interface ModuleContext {
  name: string;
  icon: string;
  hint: string;
}

export interface AiFabApi {
  readonly turns: Ref<FabTurn[]>;
  readonly isRunning: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly statusText: Ref<string>;
  readonly safeMode: Ref<boolean>;
  readonly approveRequest: Ref<FabApproveRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly hasMessages: ComputedRef<boolean>;
  readonly moduleCtx: Ref<ModuleContext>;

  initialize(): void;
  setModuleContext(ctx: ModuleContext): void;
  sendMessage(): void;
  stop(): void;
  resetChat(): void;
  setSafeMode(v: boolean): void;
  approveAllow(): void;
  approveDeny(): void;
  approveCustom(): void;
  /** 外部接口（替代老 window.sendToAiFab）：预填消息并发送 */
  prefillAndSend(message: string, onOpen?: () => void): void;
}

let _instance: AiFabApi | null = null;

export function useAiFab(): AiFabApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetAiFabSingleton(): void {
  _instance = null;
}

function truncate1500(s: unknown): string {
  const t = String(s ?? '').trim();
  return t.length > 1500 ? t.slice(0, 1500) + '\n...[truncated]' : t;
}

function genSessionId(): string {
  return 'fab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create(): AiFabApi {
  const notify = useNotifyStore();

  const turns = ref<FabTurn[]>([]);
  const isRunning = ref(false);
  const inputText = ref('');
  const statusText = ref('待命');
  const safeMode = ref(true);
  const approveRequest = ref<FabApproveRequest | null>(null);
  const approveCustomText = ref('');
  const moduleCtx = ref<ModuleContext>({ name: '1Shell', icon: '🖥', hint: '' });

  const hasMessages = computed(() => turns.value.length > 0);

  let sessionId: string | null = null;
  let currentAssistant: FabTurn | null = null;
  let socket: Socket | null = null;
  let socketBound = false;
  let approveTickHandle: number | null = null;
  let currentTextHadDelta = false;
  let stopFallbackHandle: number | null = null;
  let sendAckHandle: number | null = null;
  let sendConnectHandle: number | null = null;
  let pendingConnectSend: (() => void) | null = null;
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

  function ensureSocket(): Socket | null {
    if (socket) return socket;
    // 1:1 复刻 ai-fab.js:281-283 — 独立 io 连接（vite proxy 自动转发到后端）
    socket = io({ transports: ['websocket', 'polling'] });
    return socket;
  }

  function getSocket(): Socket | null { return socket; }

  function setStatus(text: string): void { statusText.value = text; }

  function pushUser(text: string): void {
    turns.value.push({ role: 'user', text });
    currentAssistant = null;
  }

  function ensureAssistant(): FabTurn {
    if (!currentAssistant) {
      const t: FabTurn = { role: 'assistant', lines: [] };
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
    if (sendConnectHandle !== null) {
      window.clearTimeout(sendConnectHandle);
      sendConnectHandle = null;
    }
    if (pendingConnectSend && socket) {
      socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
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
    const socket = getSocket();
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
    if (socketBound) return;
    const socket = getSocket();
    if (!socket) return;
    socketBound = true;

    // 1:1 复刻 ai-fab.js:286-321 — 与 ide-panel.js 同一 ide:* 协议
    socket.on('ide:thinking', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage;
      if (!matchesCurrentRun(m)) return;
      currentTextHadDelta = false;
      setStatus('思考中...');
    });
    socket.on('ide:text', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & { text?: string };
      if (!matchesCurrentRun(m) || !m.text || currentTextHadDelta) return;
      appendDelta(m.text);
    });
    socket.on('ide:text-delta', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & { delta?: string };
      if (!matchesCurrentRun(m) || !m.delta) return;
      currentTextHadDelta = true;
      setStatus('生成中...');
      appendDelta(m.delta);
    });
    socket.on('ide:tool-start', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & { name?: string; input?: unknown };
      if (!matchesCurrentRun(m)) return;
      const inp = m.input ? ` ${JSON.stringify(m.input).slice(0, 80)}` : '';
      appendLine('info', `⚙ ${m.name ?? ''}${inp}`);
    });
    socket.on('ide:tool-end', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & { result?: unknown; is_error?: boolean };
      if (!matchesCurrentRun(m)) return;
      appendLine(m.is_error ? 'stderr' : 'stdout', truncate1500(m.result));
    });
    socket.on('ide:done', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & { round?: number };
      if (!matchesCurrentRun(m)) return;
      setStatus(`完成 (${m.round ?? 0} 轮)`);
      finalize();
    });
    socket.on('ide:error', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & { error?: string };
      if (!matchesCurrentRun(m)) return;
      setStatus('出错');
      appendLine('error', `✘ ${m.error || '未知错误'}`);
      finalize();
    });
    socket.on('ide:cancelled', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage;
      if (!matchesCurrentRun(m, { allowStopped: true, allowAfterStop: true })) return;
      rememberStoppedRun(m.runId);
      setStatus('已取消');
      finalize();
    });

    // 安全模式审批（1:1 复刻 ai-fab.js:318-321 + 434-468 — 120s 倒计时）
    socket.on('ide:approve-request', (...args: unknown[]) => {
      const m = args[0] as IdeSocketMessage & {
        requestId?: string;
        title?: string;
        toolName?: string;
        detail?: string;
      };
      if (!matchesCurrentRun(m) || !m.requestId) return;

      clearApproveTick();
      approveCustomText.value = '';
      approveRequest.value = {
        requestId: m.requestId,
        sessionId: m.sessionId!,
        title: m.title || '安全模式',
        toolName: m.toolName || '操作',
        detail: m.detail || '',
        countdown: 120,
      };
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
    const socket = getSocket();
    if (socket && sessionId) {
      socket.emit('ide:safe-mode', { sessionId, enabled: v });
    }
  }

  function setModuleContext(ctx: ModuleContext): void {
    moduleCtx.value = ctx;
  }

  function buildContext(): Record<string, unknown> {
    // 1:1 复刻 ai-fab.js:369-379 — module + moduleHint（无 hostSel,新版本路由内自动取）
    return {
      module: moduleCtx.value.name,
      moduleHint: moduleCtx.value.hint,
    };
  }

  function emitIdeMessage(socket: Socket, text: string): void {
    sendAckHandle = window.setTimeout(() => {
      setStatus('启动超时');
      appendLine('error', 'ide:message 已发送但未收到后端确认，请检查后端 Socket handler');
      finalize();
    }, 8000);

    socket.emit('ide:message', {
      sessionId,
      message: text,
      context: buildContext(),
      safeMode: safeMode.value,
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

  function sendWhenSocketReady(socket: Socket, text: string): void {
    if (socket.connected) {
      emitIdeMessage(socket, text);
      return;
    }
    setStatus('连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        window.clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(socket, text);
    };
    socket.once('connect', pendingConnectSend);
    socket.connect();
    sendConnectHandle = window.setTimeout(() => {
      if (pendingConnectSend) socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
      setStatus('Socket 未连接');
      appendLine('error', 'Socket 尚未连接，ide:message 未发送；请确认后端已启动并刷新页面重试');
      finalize();
    }, 8000);
  }

  function sendMessage(): void {
    const text = inputText.value.trim();
    if (!text || isRunning.value) return;
    const socket = ensureSocket();
    if (!socket) {
      notify.error('Socket 未连接');
      return;
    }

    bindSocket();

    if (!sessionId) {
      sessionId = genSessionId();
      socket.emit('ide:safe-mode', { sessionId, enabled: safeMode.value });
    }

    activeRunId = null;
    stopRequested = false;
    pushUser(text);
    inputText.value = '';

    ensureAssistant();
    isRunning.value = true;
    setStatus('启动中...');

    sendWhenSocketReady(socket, text);
  }

  function stop(): void {
    const socket = getSocket();
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
    const socket = getSocket();
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

  function prefillAndSend(message: string, onOpen?: () => void): void {
    onOpen?.();
    inputText.value = message;
    setTimeout(() => sendMessage(), 300);
  }

  let initialized = false;
  function initialize(): void {
    if (initialized) return;
    initialized = true;
    // 老版懒连接：socket 在第一次 sendMessage / setSafeMode 时才建立。
    // 这里不主动建,避免 7 个非排除页一进就建 socket 浪费连接。
  }

  return {
    turns,
    isRunning,
    inputText,
    statusText,
    safeMode,
    approveRequest,
    approveCustomText,
    hasMessages,
    moduleCtx,
    initialize,
    setModuleContext,
    sendMessage,
    stop,
    resetChat,
    setSafeMode,
    approveAllow,
    approveDeny,
    approveCustom,
    prefillAndSend,
  };
}

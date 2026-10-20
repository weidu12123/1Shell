// useSessionTerminal.ts — MainConsole 刀 2 · xterm 多会话核心
// 1:1 复刻 [public/session-terminal.js](public/session-terminal.js)（414 行）+ [public/layout.js](public/layout.js) terminal-tabs 部分
// - 单 xterm 实例 + 多会话 buffers + 重连指数退避 + 主题同步 + lifecycle 广播
// - 暴露 reactive state（statusKind/statusText/terminalHint/sessions/activeHostId/activeSessionId）供 UI 绑定
// - 模块级单例（与老 sessionTerminalModule 一样,terminal-ai / command-suggestion / file-browser 等都引用）

import { shallowRef, ref, markRaw, type Ref, type ShallowRef } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Socket } from 'socket.io-client';

import {
  DARK_THEME, LIGHT_THEME,
  SESSION_BUFFER_LIMIT,
  type SessionInfo, type SessionStatus,
  type SessionInputMeta, type LifecyclePayload,
} from '@/utils/terminal';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import { useSocket } from '@/composables/useSocket';
import { useHostsStore } from '@/stores/hosts';
import { useAuthStore } from '@/stores/auth';
import { useNotifyStore } from '@/stores/notify';

type InputListener = (payload: { data: string; meta: SessionInputMeta }) => void;
type OutputListener = (payload: { sessionId: string; data: string }) => void;
type LifecycleListener = (payload: LifecyclePayload) => void;

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 36;
const MIN_TERMINAL_COLS = 24;
const MIN_TERMINAL_ROWS = 8;
const RESIZE_SETTLE_MS = 90;

export interface SessionTerminalApi {
  /** xterm 实例（shallowRef · markRaw,Vue 响应式不代理） */
  readonly term: ShallowRef<Terminal | null>;
  /** 挂载 xterm DOM(由 TerminalArea.vue onMounted 调用) */
  mount(container: HTMLElement): void;
  unmount(): void;

  connectSocket(): void;
  disconnectSocket(): void;

  connectToHost(hostId: string, forceReconnect?: boolean): Promise<void>;
  /** 主动 close 某 host 的当前 session(tab close 用) */
  closeHostSession(hostId: string): void;

  sendSessionInput(data: string, meta?: SessionInputMeta): boolean;
  clearTerminal(): void;
  focusTerminal(): void;
  pauseUserInput(): void;
  resumeUserInput(suppressMs?: number): void;
  /** 仅 fit,不 emit resize 也不 focus */
  fit(): void;

  onInput(fn: InputListener): () => void;
  onOutput(fn: OutputListener): () => void;
  onLifecycle(fn: LifecycleListener): () => void;

  /* reactive state — UI 直接绑 */
  readonly activeHostId: Ref<string>;
  readonly activeSessionId: Ref<string | null>;
  readonly sessions: ShallowRef<Map<string, SessionInfo>>;
  readonly statusKind: Ref<SessionStatus>;
  readonly statusText: Ref<string>;
  readonly terminalHint: Ref<string>;

  getSocket(): Socket | null;
  getActiveBuffer(): string;
}

/* ───── 模块级单例（与老 createSessionTerminalModule 一次性实例化一样） ───── */

let _instance: SessionTerminalApi | null = null;

export function useSessionTerminal(): SessionTerminalApi {
  if (!_instance) _instance = create();
  return _instance;
}

/** 供 terminal-ai / command-suggestion / 其它刀复用 */
export function getSessionTerminalSingleton(): SessionTerminalApi | null {
  return _instance;
}

/** 测试/热重载用 — 不要在生产代码调用 */
export function _resetSessionTerminalSingleton(): void {
  _instance = null;
}

function create(): SessionTerminalApi {
  const hosts = useHostsStore();
  const auth = useAuthStore();
  const notify = useNotifyStore();

  const isDark = (): boolean => document.documentElement.classList.contains('dark');

  /* ── xterm ─────────────────────────────────── */
  const _term = markRaw(new Terminal({
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 14,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    lineHeight: 1.25,
    scrollback: 5000,
    windowsMode: true,
    theme: isDark() ? DARK_THEME : LIGHT_THEME,
  }));
  const _fit = markRaw(new FitAddon());
  _term.loadAddon(_fit);

  const term = shallowRef<Terminal | null>(_term);

  // 主题切换实时同步(MutationObserver 1:1 沿用,与 [public/session-terminal.js:53-57](public/session-terminal.js#L53-L57))
  const themeObserver = new MutationObserver(() => {
    _term.options.theme = isDark() ? DARK_THEME : LIGHT_THEME;
  });
  themeObserver.observe(document.documentElement, { attributeFilter: ['class'] });

  /* ── 状态 ─────────────────────────────────── */
  let socket: Socket | null = null;
  let socketCleanup: (() => void) | null = null;
  let initialized = false;
  let onDataDispose: { dispose(): void } | null = null;
  let mountedContainer: HTMLElement | null = null;
  let _resizeObserver: ResizeObserver | null = null;
  let _resizeRafId: number | null = null;
  let _resizeSettleTimerId: number | null = null;
  let lastSentSizeKey = '';
  let lastRenderedSizeKey = '';
  let userInputPaused = false;
  let suppressStrayInputUntil = 0;
  let replayingBufferDepth = 0;

  function stripTerminalQueriesForReplay(data: string): string {
    return String(data || '')
      .replace(/\x1b\[(?:>|=|\?)?0?c/g, '')
      .replace(/\x1b\[\??[56]n/g, '')
      .replace(/\x1b\[>0?q/g, '')
      .replace(/\x1b\[\?[0-9;]+\$p/g, '')
      .replace(/\x1b\](?:4;[0-9]+|10|11|12);\?(?:\x07|\x1b\\)/g, '');
  }

  const activeHostId = ref<string>(LOCAL_HOST_ID);
  const activeSessionId = ref<string | null>(null);
  const sessions = shallowRef<Map<string, SessionInfo>>(new Map());
  const sessionBuffers = new Map<string, string>();
  const statusKind = ref<SessionStatus>('idle');
  const statusText = ref<string>('未连接');
  const terminalHint = ref<string>('正在准备本机会话…');

  const inputListeners = new Set<InputListener>();
  const outputListeners = new Set<OutputListener>();
  const lifecycleListeners = new Set<LifecycleListener>();

  /* ── 工具 ─────────────────────────────────── */
  function emitInput(p: { data: string; meta: SessionInputMeta }): void {
    inputListeners.forEach((fn) => { try { fn(p); } catch { /* 静默 */ } });
  }
  function emitOutput(p: { sessionId: string; data: string }): void {
    outputListeners.forEach((fn) => { try { fn(p); } catch { /* 静默 */ } });
  }
  function emitLifecycle(p: LifecyclePayload): void {
    lifecycleListeners.forEach((fn) => { try { fn(p); } catch { /* 静默 */ } });
  }

  function notifyInput(data: string, meta: SessionInputMeta = {}): void {
    emitInput({ data, meta });
  }
  function notifyOutput(payload: { sessionId: string; data: string }): void {
    emitOutput(payload);
  }
  function notifyLifecycle(type: string, extra: Record<string, unknown> = {}): void {
    emitLifecycle({ type, ...extra } as LifecyclePayload);
  }

  function setStatus(kind: SessionStatus, text: string): void {
    statusKind.value = kind;
    statusText.value = text;
  }

  function minUsableCols(): number {
    return MIN_TERMINAL_COLS;
  }

  function isUsableTerminalSize(cols: number, rows: number): boolean {
    return Number.isFinite(cols)
      && Number.isFinite(rows)
      && cols >= minUsableCols()
      && rows >= MIN_TERMINAL_ROWS;
  }

  function trimSessionBuffer(value: string): string {
    if (value.length <= SESSION_BUFFER_LIMIT) return value;
    const start = value.length - SESSION_BUFFER_LIMIT;
    const newline = value.indexOf('\n', start);
    return value.slice(newline >= 0 ? newline + 1 : start);
  }

  function safeTerminalSize(): { cols: number; rows: number } {
    return {
      cols: Math.max(_term.cols || DEFAULT_TERMINAL_COLS, minUsableCols()),
      rows: Math.max(_term.rows || DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS),
    };
  }

  function terminalCellSize(): { width: number; height: number } {
    const core = (_term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
    })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const width = Number(cell?.width);
    const height = Number(cell?.height);
    return {
      width: Number.isFinite(width) && width > 0 ? width : 8.4,
      height: Number.isFinite(height) && height > 0 ? height : 17.5,
    };
  }

  function measuredTerminalSize(): { cols: number; rows: number } | null {
    const container = mountedContainer || _term.element?.parentElement || null;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const style = window.getComputedStyle(container);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const width = Math.max(0, (rect.width || container.clientWidth) - paddingLeft - paddingRight);
    const height = Math.max(0, (rect.height || container.clientHeight) - paddingTop - paddingBottom);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const cell = terminalCellSize();
    const cols = Math.floor(width / cell.width);
    const rows = Math.floor(height / cell.height);
    if (!isUsableTerminalSize(cols, rows)) return null;
    return { cols, rows };
  }

  function chooseTerminalSize(proposed: { cols: number; rows: number } | null): { cols: number; rows: number } | null {
    const measured = measuredTerminalSize();
    const validProposed = proposed && isUsableTerminalSize(proposed.cols, proposed.rows) ? proposed : null;
    if (!validProposed) return measured;
    if (!measured) return validProposed;
    const proposedKey = `${validProposed.cols}x${validProposed.rows}`;
    const measuredKey = `${measured.cols}x${measured.rows}`;
    if (proposedKey === measuredKey) return validProposed;
    if (measured.cols > validProposed.cols + 8 || Math.abs(measured.rows - validProposed.rows) > 2) return measured;
    return validProposed;
  }

  function fitTerminal(): { cols: number; rows: number } | null {
    try {
      const proposed = _fit.proposeDimensions();
      const size = chooseTerminalSize(proposed || null);
      if (!size) return null;
      if (proposed && size.cols === proposed.cols && size.rows === proposed.rows) {
        _fit.fit();
      } else if (_term.cols !== size.cols || _term.rows !== size.rows) {
        _term.resize(size.cols, size.rows);
      }
      const appliedSize = { cols: _term.cols, rows: _term.rows };
      refreshTerminalViewport(appliedSize);
      return appliedSize;
    } catch {
      const measured = measuredTerminalSize();
      if (measured) {
        try {
          _term.resize(measured.cols, measured.rows);
          refreshTerminalViewport(measured);
          return measured;
        } catch { /* 静默 */ }
      }
      return null;
    }
  }

  function refreshTerminalViewport(size = safeTerminalSize()): void {
    if (!isUsableTerminalSize(size.cols, size.rows)) return;
    const key = `${size.cols}x${size.rows}`;
    if (key === lastRenderedSizeKey) return;
    lastRenderedSizeKey = key;
    requestAnimationFrame(() => {
      try {
        _term.refresh(0, Math.max(0, _term.rows - 1));
        _term.scrollToBottom();
      } catch { /* 静默 */ }
    });
  }

  function syncTerminalSize(force = false): void {
    const fitted = fitTerminal();
    const size = fitted || safeTerminalSize();
    if (!isUsableTerminalSize(size.cols, size.rows)) return;
    refreshTerminalViewport(size);
    const key = `${size.cols}x${size.rows}`;
    if (!force && key === lastSentSizeKey) return;
    lastSentSizeKey = key;
    if (socket && activeSessionId.value) {
      socket.emit('session:resize', {
        sessionId: activeSessionId.value,
        cols: size.cols,
        rows: size.rows,
      });
    }
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function ensureFittedForSession(): Promise<{ cols: number; rows: number }> {
    for (let i = 0; i < 3; i += 1) {
      const fitted = fitTerminal();
      if (fitted) return fitted;
      await nextFrame();
    }
    return safeTerminalSize();
  }

  function updateSessionMap(mutator: (m: Map<string, SessionInfo>) => void): void {
    const next = new Map(sessions.value);
    mutator(next);
    sessions.value = next;
  }

  /* ── 终端控制 ─────────────────────────────────── */
  function clearTerminal(): void {
    _term.clear();
    if (activeSessionId.value) sessionBuffers.set(activeSessionId.value, '');
    notifyLifecycle('clear');
    _term.focus();
  }

  function resetTerminal(): void {
    _term.reset();
    _term.clear();
    notifyLifecycle('reset');
  }

  function fit(): void {
    fitTerminal();
  }

  function focusTerminal(): void {
    suppressStrayInputUntil = Math.max(suppressStrayInputUntil, Date.now() + 350);
    requestAnimationFrame(() => {
      try {
        fitTerminal();
        scheduleResize();
        _term.focus();
      } catch { /* 静默 */ }
    });
  }

  function scrollTerminalToBottom(): void {
    requestAnimationFrame(() => {
      try { _term.scrollToBottom(); } catch { /* 静默 */ }
    });
  }

  function getActiveBuffer(): string {
    return activeSessionId.value ? (sessionBuffers.get(activeSessionId.value) || '') : '';
  }

  /* ── 会话查找/创建 ───────────────────────────── */
  function findSessionByHost(hostId: string): SessionInfo | null {
    for (const session of sessions.value.values()) {
      if (session.hostId === hostId && session.status !== 'closed') return session;
    }
    return null;
  }

  async function callSessionCreate(hostId: string): Promise<SessionInfo> {
    const size = await ensureFittedForSession();
    return new Promise((resolve, reject) => {
      if (!socket) { reject(new Error('Socket 未连接')); return; }
      socket.emit(
        'session:create',
        { hostId, cols: size.cols, rows: size.rows },
        (result: { ok: boolean; session?: SessionInfo; error?: string }) => {
          if (!result?.ok) { reject(new Error(result?.error || '会话创建失败')); return; }
          resolve(result.session as SessionInfo);
        }
      );
    });
  }

  async function connectToHost(hostId: string, forceReconnect = false): Promise<void> {
    const host = hosts.hostMap.get(hostId);
    if (!host) return;

    notifyLifecycle('host-switch-start', { hostId, forceReconnect });
    activeHostId.value = hostId;
    hosts.select(hostId);
    terminalHint.value = `正在连接 ${host.name}…`;
    setStatus('connecting', '连接中…');
    resetTerminal();

    try {
      let session: SessionInfo | null = null;

      if (forceReconnect) {
        const previous = findSessionByHost(hostId);
        if (previous) {
          socket?.emit('session:close', { sessionId: previous.id });
          updateSessionMap((m) => { m.delete(previous.id); });
          sessionBuffers.delete(previous.id);
        }
      } else {
        session = findSessionByHost(hostId);
      }

      if (!session) {
        session = await callSessionCreate(hostId);
        const created = session;
        updateSessionMap((m) => { m.set(created.id, created); });
      }

      activeSessionId.value = session.id;
      notifyLifecycle('session-change', { hostId, sessionId: session.id, forceReconnect });
      syncTerminalSize(true);
      window.setTimeout(() => syncTerminalSize(true), 120);
      window.setTimeout(() => syncTerminalSize(true), 360);
      const replay = stripTerminalQueriesForReplay(sessionBuffers.get(session.id) || '');
      suppressStrayInputUntil = Date.now() + 450;
      if (replay) {
        replayingBufferDepth += 1;
        _term.write(replay, () => {
          replayingBufferDepth = Math.max(0, replayingBufferDepth - 1);
          suppressStrayInputUntil = Date.now() + 250;
          scrollTerminalToBottom();
        });
      }
      scrollTerminalToBottom();
      if (hostId !== LOCAL_HOST_ID) {
        const hint = `当前终端已切换到 ${host.name}`;
        terminalHint.value = hint;
        setTimeout(() => {
          if (terminalHint.value === hint) terminalHint.value = '';
        }, 3000);
      } else {
        terminalHint.value = '';
      }
      setStatus(session.status, session.status === 'ready' ? '已连接' : session.status);
      focusTerminal();
    } catch (error) {
      const msg = (error as Error).message;
      setStatus('error', msg);
      terminalHint.value = msg;
      notifyLifecycle('session-error', { hostId, error: msg });
    }
  }

  function closeHostSession(hostId: string): void {
    const session = findSessionByHost(hostId);
    if (!session) return;
    socket?.emit('session:close', { sessionId: session.id });
    updateSessionMap((m) => { m.delete(session.id); });
    sessionBuffers.delete(session.id);

    // 若关闭的是当前 active 会话,尝试切到其它活跃会话
    if (activeHostId.value === hostId) {
      const remaining = [...sessions.value.values()].filter((s) => s.status !== 'closed');
      if (remaining.length > 0) {
        const last = remaining[remaining.length - 1];
        connectToHost(last.hostId, false).catch(() => { /* 静默 */ });
      } else {
        activeSessionId.value = null;
      }
    }
  }

  function pauseUserInput(): void {
    userInputPaused = true;
  }

  function resumeUserInput(suppressMs = 350): void {
    userInputPaused = false;
    suppressStrayInputUntil = Date.now() + Math.max(0, suppressMs);
  }

  function normalizeXtermInput(data: string): string {
    if (userInputPaused || replayingBufferDepth > 0) return '';
    let payload = String(data || '');
    payload = payload.replace(/\x1b\[(?:I|O)/g, '');
    if (Date.now() < suppressStrayInputUntil) {
      payload = payload
        .replace(/\x1b\[\?[0-9;]*c/g, '')
        .replace(/\x1b\[>[0-9;]*c/g, '')
        .replace(/\x1b\[\?[0-9;]*\$y/g, '')
        .replace(/\x1b\[[0-9]+;[0-9]+R/g, '')
        .replace(/\x1b\](?:4;[0-9]+|10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/^\[\?[0-9;]*c$/g, '')
        .replace(/^>[0-9;]*c$/g, '');
      if (payload === ']') return '';
    }
    return payload;
  }

  function sendSessionInput(data: string, meta: SessionInputMeta = {}): boolean {
    if (!socket || !activeSessionId.value) return false;
    const payload = String(data || '');
    if (!payload) return false;
    notifyInput(payload, meta);
    socket.emit('session:input', {
      sessionId: activeSessionId.value,
      data: payload,
    });
    return true;
  }

  /* ── socket bind(1:1 沿用 session-terminal.js attachSocketListeners；改共享连接后只注册具名 handler,可精确摘除) ────── */
  async function enterActiveHostSession(): Promise<void> {
    terminalHint.value = 'Socket 已连接,正在进入默认本机会话…';
    notifyLifecycle('socket-connect');
    try {
      if (!hosts.hostMap.has(activeHostId.value)) {
        activeHostId.value = LOCAL_HOST_ID;
      }
      await connectToHost(activeHostId.value || LOCAL_HOST_ID, true);
    } catch (error) {
      const msg = (error as Error).message;
      setStatus('error', msg);
      terminalHint.value = msg;
    }
  }

  function attachSocketListeners(sock: Socket): () => void {
    const onConnect = (): void => {
      void enterActiveHostSession();
    };

    const onDisconnect = (reason: string): void => {
      const byLogout = reason === 'io client disconnect';
      setStatus(byLogout ? 'closed' : 'error', byLogout ? '已退出登录' : `连接断开: ${reason},正在重连…`);
      terminalHint.value = byLogout ? '已退出登录' : 'Socket 连接断开,正在重连…';
      notifyLifecycle('socket-disconnect', { reason });
    };

    const onConnectError = (error: Error): void => {
      if (error?.message === 'UNAUTHORIZED') {
        auth.setAuthenticated(false);
        notify.error('登录已失效,请重新登录');
        notifyLifecycle('socket-error', { error: 'UNAUTHORIZED' });
        return;
      }
      const msg = error?.message || 'Socket 连接失败';
      setStatus('error', msg);
      terminalHint.value = msg;
      notifyLifecycle('socket-error', { error: msg });
    };

    const onReconnect = (): void => {
      setStatus('ready', '已重新连接');
      notify.success('WebSocket 已重新连接');
      if (activeHostId.value) {
        connectToHost(activeHostId.value, true).catch(() => { /* 静默 */ });
      }
    };

    const onReconnectAttempt = (attempt: number): void => {
      setStatus('error', `正在重连… (第 ${attempt} 次)`);
    };

    const onSessionOutput = ({ sessionId, data }: { sessionId: string; data: string }): void => {
      if (!sessionId) return;
      const output = String(data || '');
      const previous = sessionBuffers.get(sessionId) || '';
      const next = trimSessionBuffer(previous + stripTerminalQueriesForReplay(output));
      sessionBuffers.set(sessionId, next);
      if (sessionId !== activeSessionId.value) return;
      notifyOutput({ sessionId, data: output });
      _term.write(output, () => scrollTerminalToBottom());
      scrollTerminalToBottom();
    };

    const onSessionStatus = (session: SessionInfo): void => {
      updateSessionMap((m) => { m.set(session.id, session); });
      notifyLifecycle('session-status', {
        hostId: session.hostId,
        sessionId: session.id,
        status: session.status,
      });

      if (session.id === activeSessionId.value) {
        const textMap: Record<string, string> = {
          connecting: '连接中…',
          ready: session.warning || '已连接',
          error: session.lastError || '连接失败',
          closed: '已关闭',
        };
        setStatus(session.status, textMap[session.status] || String(session.status));

        if (session.status === 'ready') {
          if (session.hostId !== LOCAL_HOST_ID) {
            const hint = `当前终端已切换到 ${session.hostName ?? ''}`;
            terminalHint.value = hint;
            setTimeout(() => {
              if (terminalHint.value === hint) terminalHint.value = '';
            }, 3000);
          } else {
            terminalHint.value = '';
          }
        }
        if (session.status === 'error') {
          terminalHint.value = session.lastError || '会话错误';
        }
      }

      if (session.status === 'closed' || session.status === 'error') {
        if (session.id === activeSessionId.value && session.status === 'closed') {
          terminalHint.value = `${session.hostName ?? ''} 会话已关闭`;
        }
        if (session.status === 'closed') {
          sessionBuffers.delete(session.id);
        }
      }
    };

    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    sock.on('connect_error', onConnectError);
    sock.on('reconnect', onReconnect);
    sock.on('reconnect_attempt', onReconnectAttempt);
    sock.on('session:output', onSessionOutput);
    sock.on('session:status', onSessionStatus);

    return () => {
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.off('connect_error', onConnectError);
      sock.off('reconnect', onReconnect);
      sock.off('reconnect_attempt', onReconnectAttempt);
      sock.off('session:output', onSessionOutput);
      sock.off('session:status', onSessionStatus);
    };
  }

  function connectSocket(): void {
    if (socket) return;
    // 与 ide:* / probe:update 共用全局唯一 socket.io 连接（原先这里自建第二条连接）
    socket = useSocket();
    socketCleanup = attachSocketListeners(socket);
    if (socket.connected) {
      // 共享连接可能早已就绪,'connect' 不会再触发——直接进默认会话
      void enterActiveHostSession();
    } else if (socket.disconnected) {
      socket.connect();
    }
  }

  function disconnectSocket(): void {
    if (!socket) return;
    // 共享连接:只摘掉本模块的监听器,不断开传输层（ide 聊天/探针推送还在用）
    socketCleanup?.();
    socketCleanup = null;
    socket = null;
    activeSessionId.value = null;
    sessions.value = new Map();
    sessionBuffers.clear();
    setStatus('closed', '未连接');
    notifyLifecycle('socket-disconnect', { reason: 'manual' });
  }

  /* ── DOM mount ─────────────────────────────────── */
  const onWindowResize = (): void => scheduleResize();

  /**
   * 容器尺寸变更（flex 重排 / 面板展开 / 窗口缩放 / 父级首屏 layout 抖动）时,
   * 节流到下一帧 fit + emit session:resize。
   * 解决:页面首次刷新进入时 xterm 在 0/不稳定尺寸容器里 open 后,
   *      后续 layout 完成无人触发 fit,xterm 仍保留首屏尺寸把父级撑大。
   */
  function scheduleResize(): void {
    if (_resizeRafId === null) {
      _resizeRafId = requestAnimationFrame(() => {
        _resizeRafId = null;
        const fitted = fitTerminal();
        if (fitted) refreshTerminalViewport(fitted);
      });
    }
    if (_resizeSettleTimerId !== null) window.clearTimeout(_resizeSettleTimerId);
    _resizeSettleTimerId = window.setTimeout(() => {
      _resizeSettleTimerId = null;
      syncTerminalSize();
    }, RESIZE_SETTLE_MS);
  }

  function mount(container: HTMLElement): void {
    mountedContainer = container;
    // 切换路由再回来时,xterm 已挂在原 DOM —— 复用元素重挂到新 container,
    // 避免 v-if 重建后 _term.element 还指向旧 DOM 节点导致空白。
    if (initialized) {
      if (_term.element && _term.element.parentElement !== container) {
        container.appendChild(_term.element);
      }
      attachResizeObserver(container);
      scheduleResize();
      return;
    }
    // 容器高度未稳定时（页面刷新首屏 flex 链未布局完）等下一帧再 open,
    // 否则 xterm 会在 0/不稳定容器里塞默认 80x24 尺寸撑大父级。
    // 对照老 [public/session-terminal.js:372-385](public/session-terminal.js#L372-L385) 用 MutationObserver 等 app-shell 非 hidden。
    if (container.clientHeight === 0 || container.clientWidth === 0) {
      requestAnimationFrame(() => mount(container));
      return;
    }
    _term.open(container);
    fitTerminal();
    onDataDispose = _term.onData((data: string) => {
      const payload = normalizeXtermInput(data);
      if (!payload) return;
      sendSessionInput(payload);
    });
    window.addEventListener('resize', onWindowResize);
    attachResizeObserver(container);
    initialized = true;
  }

  function attachResizeObserver(container: HTMLElement): void {
    _resizeObserver?.disconnect();
    _resizeObserver = new ResizeObserver(() => scheduleResize());
    _resizeObserver.observe(container);
  }

  function unmount(): void {
    window.removeEventListener('resize', onWindowResize);
    _resizeObserver?.disconnect();
    _resizeObserver = null;
    mountedContainer = null;
    if (_resizeRafId !== null) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; }
    if (_resizeSettleTimerId !== null) { window.clearTimeout(_resizeSettleTimerId); _resizeSettleTimerId = null; }
    // 注意:不 dispose onDataDispose 也不 reset initialized —— xterm 实例单例,
    // 切换路由再回来时 mount 复用 _term.element + onData。
  }

  /* ── listener register ─────────────────────────────────── */
  function onInput(fn: InputListener): () => void {
    inputListeners.add(fn);
    return () => { inputListeners.delete(fn); };
  }
  function onOutput(fn: OutputListener): () => void {
    outputListeners.add(fn);
    return () => { outputListeners.delete(fn); };
  }
  function onLifecycle(fn: LifecycleListener): () => void {
    lifecycleListeners.add(fn);
    return () => { lifecycleListeners.delete(fn); };
  }

  return {
    term,
    mount,
    unmount,
    connectSocket,
    disconnectSocket,
    connectToHost,
    closeHostSession,
    sendSessionInput,
    clearTerminal,
    focusTerminal,
    pauseUserInput,
    resumeUserInput,
    fit,
    onInput,
    onOutput,
    onLifecycle,
    activeHostId,
    activeSessionId,
    sessions,
    statusKind,
    statusText,
    terminalHint,
    getSocket: () => socket,
    getActiveBuffer,
  };
}

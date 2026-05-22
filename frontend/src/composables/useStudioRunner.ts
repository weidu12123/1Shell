// useStudioRunner.ts — IDE 工作台核心 composable
// 与 useProgramsRunner 同套路：集中 state + socket on/emit + cleanup
// 迭代 1 范围：7 socket on + 5 emit + 全部 state + API + deploy_mcp/refine 入口
// 迭代 2：补 ide:mcp-status / ide:approve-request 监听 + ide:mcp-start/stop / ide:approve-response emit + ApproveBar

import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useSocket, bindHandlers, type SocketHandler } from '@/composables/useSocket';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';
import { readStorageState, writeStorageState } from '@/composables/usePageState';
import {
  type HostInfo, type SelectedPath, type SelectedContainer,
  type SkillInfo, type McpInfo, type LocalMcpStatus,
  type ToolFilter, type ToolItem,
  type ContainerScanResult, type ContainerScanItem,
  type FpItem,
  type ChatSession, type SessionMessage, type AiLineKind,
  type SendContext,
  type AuthoringArtifact, type AuthoringInteraction, type AuthoringStage, type AuthoringSessionSnapshot,
  type ApprovePayload, type ApproveAction,
  HISTORY_KEY, ERROR_CONTEXT_KEY, SESSIONS_MAX, APPROVE_TIMEOUT_SEC,
  truncate60, newSessionId, collectAuthoringResidualPaths,
  DOCKER_SCAN_CMD, parseDockerScan,
} from '@/utils/studio';

type RunStatusKind = 'idle' | 'starting' | 'running' | 'done' | 'error' | 'cancelled';

interface AckResponse { ok?: boolean; error?: string }
interface ExecResponse { stdout?: string; stderr?: string }
interface FpListResponse { path: string; parent: string | null; items: FpItem[] }
interface CleanupResidualsResponse { ok?: boolean; deleted?: string[]; missing?: string[]; rejected?: Array<{ path: string; reason: string }> }

interface StudioPrefs {
  selectedHostIds: string[];
  selectedPaths: SelectedPath[];
  selectedContainers: SelectedContainer[];
  selectedTools: string[];
  scanHostId: string;
  toolFilter: ToolFilter;
  currentSessionId: string | null;
  taskInput: string;
  safeMode: boolean;
  unlimitedTurns: boolean;
  ccCollab: boolean;
  refinedMode: boolean;
  historyDrawerOpen: boolean;
}

const STUDIO_PREFS_KEY = '1shell.skill-studio.prefs.v4.0.0';

export function useStudioRunner() {
  const socket = useSocket();
  const { requestJson } = useApiClient();
  const { confirm } = useConfirm();
  const notify = useNotifyStore();
  const savedPrefs = readStorageState<StudioPrefs>(STUDIO_PREFS_KEY, {
    selectedHostIds: [],
    selectedPaths: [],
    selectedContainers: [],
    selectedTools: [],
    scanHostId: 'local',
    toolFilter: 'all',
    currentSessionId: null,
    taskInput: '',
    safeMode: true,
    unlimitedTurns: false,
    ccCollab: false,
    refinedMode: false,
    historyDrawerOpen: false,
  });

  /* ─── state ───────────────────────────────────────── */
  const hosts = shallowRef<HostInfo[]>([]);
  const skillList = shallowRef<SkillInfo[]>([]);
  const mcpList = shallowRef<McpInfo[]>([]);

  const selectedHosts = ref<Map<string, HostInfo>>(new Map());
  const selectedPaths = ref<SelectedPath[]>(savedPrefs.selectedPaths);
  const selectedContainers = ref<Map<string, SelectedContainer>>(new Map((savedPrefs.selectedContainers || []).map((c) => [`${c.hostId}::${c.name}`, c])));
  const selectedTools = ref<Set<string>>(new Set(savedPrefs.selectedTools)); // 'skill:<id>' | 'mcp:<id>'
  const localMcpStatus = ref<Map<string, LocalMcpStatus>>(new Map()); // 迭代 2 才填

  // 容器扫描
  const scanHostId = ref<string>(savedPrefs.scanHostId);
  const containerScan = shallowRef<ContainerScanResult | null>(null);
  const scanning = ref(false);
  const toolFilter = ref<ToolFilter>(savedPrefs.toolFilter);

  // chat / sessions
  const sessions = ref<ChatSession[]>([]);
  const currentSessionId = ref<string | null>(savedPrefs.currentSessionId);
  const currentMessages = computed<SessionMessage[]>(() => {
    const s = sessions.value.find((x) => x.id === currentSessionId.value);
    return s ? s.messages : [];
  });

  // run state
  const isRunning = ref(false);
  const runStatusKind = ref<RunStatusKind>('idle');
  const runStatusText = ref('待命');
  const authoringSession = ref<AuthoringSessionSnapshot | null>(null);

  // 输入区
  const taskInput = ref(savedPrefs.taskInput);
  const safeMode = ref(savedPrefs.safeMode);
  const unlimitedTurns = ref(savedPrefs.unlimitedTurns);
  const ccCollab = ref(savedPrefs.ccCollab);
  const refinedMode = ref(savedPrefs.refinedMode === true);

  // 历史抽屉
  const historyDrawerOpen = ref(savedPrefs.historyDrawerOpen);

  // 安全模式审批条（迭代 2）
  const pendingApprove = ref<ApprovePayload | null>(null);
  const approveCountdown = ref<number>(APPROVE_TIMEOUT_SEC);
  let approveTickHandle: ReturnType<typeof setInterval> | null = null;
  let currentTextHadDelta = false;
  let stopFallbackHandle: ReturnType<typeof setTimeout> | null = null;
  let sendAckHandle: ReturnType<typeof setTimeout> | null = null;
  let sendConnectHandle: ReturnType<typeof setTimeout> | null = null;
  let pendingConnectSend: (() => void) | null = null;
  let activeRunId: string | null = null;
  let stopRequested = false;
  const stoppedRunIds = new Set<string>();

  interface IdeSocketMessage {
    sessionId?: string;
    runId?: string;
  }

  function matchesCurrentRun(msg: IdeSocketMessage | null | undefined, options: { allowStopped?: boolean; allowAfterStop?: boolean } = {}): boolean {
    if (!msg || msg.sessionId !== currentSessionId.value) return false;
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

  /* ─── computed ────────────────────────────────────── */

  // 主机列表合并（local 永远在顶，且去掉 hosts 里 id==='local' 防重）
  const allHosts = computed<HostInfo[]>(() => [
    { id: 'local', name: '本机', host: '127.0.0.1' },
    ...hosts.value.filter((h) => h.id !== 'local'),
  ]);

  const toolItems = computed<ToolItem[]>(() => {
    const items: ToolItem[] = [];
    for (const s of skillList.value) {
      items.push({ kind: 'skill', id: s.id, name: s.name, icon: s.icon || '🔧', meta: truncate60(s.description), isLocal: false, statusDot: '' });
    }
    for (const m of mcpList.value) {
      const isLocal = m.type === 'local' || Boolean(m.command);
      const status = localMcpStatus.value.get(m.id);
      const runtimeStatus = status?.status || m.runtimeStatus;
      const statusDot = isLocal ? (runtimeStatus === 'running' ? ' 🟢' : runtimeStatus === 'starting' ? ' 🟡' : '') : '';
      items.push({
        kind: isLocal ? 'local' : 'mcp',
        id: m.id, name: m.name,
        icon: isLocal ? '📦' : '🔌',
        meta: truncate60(m.description || m.url || m.command),
        isLocal, statusDot,
      });
    }
    return items;
  });

  const filteredToolItems = computed<ToolItem[]>(() =>
    toolItems.value.filter((it) => toolFilter.value === 'all' || it.kind === toolFilter.value)
  );

  const toolItemKey = (it: ToolItem): string => (it.isLocal ? `mcp:${it.id}` : `${it.kind}:${it.id}`);

  const summaryText = computed(() =>
    `主机: ${selectedHosts.value.size} · 路径: ${selectedPaths.value.length} · 容器: ${selectedContainers.value.size} · 工具: ${selectedTools.value.size}`
  );

  const authoringStageOrder: AuthoringStage[] = ['discovery', 'options', 'spec', 'plan', 'draft', 'review', 'commit', 'verify'];
  const authoringStageLabels: Record<AuthoringStage, string> = {
    discovery: 'Discovery',
    options: 'Options',
    spec: 'Spec',
    plan: 'Plan',
    draft: 'Draft',
    review: 'Review',
    commit: 'Commit',
    verify: 'Verify',
    done: 'Done',
    blocked: 'Blocked',
  };
  const authoringStages = computed(() => authoringStageOrder.map((stage) => ({
    stage,
    label: authoringStageLabels[stage],
    active: authoringSession.value?.stage === stage,
    done: authoringSession.value ? authoringStageOrder.indexOf(stage) < authoringStageOrder.indexOf(authoringSession.value.stage) : false,
  })));
  const authoringStageText = computed(() => authoringSession.value ? authoringStageLabels[authoringSession.value.stage] || authoringSession.value.stage : '');

  function hostName(hostId: string): string {
    if (hostId === 'local') return '本机';
    const h = hosts.value.find((x) => x.id === hostId);
    return h ? h.name : hostId;
  }

  function saveStudioPrefs(): void {
    writeStorageState<StudioPrefs>(STUDIO_PREFS_KEY, {
      selectedHostIds: [...selectedHosts.value.keys()],
      selectedPaths: selectedPaths.value,
      selectedContainers: [...selectedContainers.value.values()],
      selectedTools: [...selectedTools.value],
      scanHostId: scanHostId.value,
      toolFilter: toolFilter.value,
      currentSessionId: currentSessionId.value,
      taskInput: taskInput.value,
      safeMode: safeMode.value,
      unlimitedTurns: unlimitedTurns.value,
      ccCollab: ccCollab.value,
      refinedMode: refinedMode.value,
      historyDrawerOpen: historyDrawerOpen.value,
    });
  }

  function restoreSelectedHosts(): void {
    if (!savedPrefs.selectedHostIds.length) return;
    const next = new Map<string, HostInfo>();
    for (const id of savedPrefs.selectedHostIds) {
      const h = allHosts.value.find((item) => item.id === id);
      if (h) next.set(id, h);
    }
    selectedHosts.value = next;
  }

  /* ─── chat helpers ────────────────────────────────── */

  function getSession(id: string | null): ChatSession | null {
    if (!id) return null;
    return sessions.value.find((x) => x.id === id) || null;
  }

  function sanitizeLoadedSessions(items: ChatSession[]): ChatSession[] {
    const staleAckText = 'ide:message 未收到确认，请检查 Socket 连接';
    let changed = false;
    const cleaned = items.map((session) => {
      const messages = (session.messages || []).filter((msg) => {
        const keep = !(msg.role === 'ai' && String(msg.content || '').includes(staleAckText));
        if (!keep) changed = true;
        return keep;
      });
      return messages === session.messages ? session : { ...session, messages };
    });
    if (changed) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(cleaned.slice(0, SESSIONS_MAX))); } catch { /* ignore */ }
    }
    return cleaned;
  }

  function loadSessionsFromStorage(): void {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      sessions.value = Array.isArray(parsed) ? sanitizeLoadedSessions(parsed) : [];
    } catch {
      sessions.value = [];
    }
  }

  function saveSessionsToStorage(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.value.slice(0, SESSIONS_MAX)));
    } catch { /* quota — ignore */ }
  }

  function newSession(title: string): ChatSession {
    const id = newSessionId();
    const s: ChatSession = { id, title: (title || '未命名').slice(0, 60), createdAt: Date.now(), messages: [] };
    sessions.value = [s, ...sessions.value];
    currentSessionId.value = id;
    saveSessionsToStorage();
    return s;
  }

  function saveMessageToCurrent(msg: SessionMessage): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    s.messages = [...s.messages, msg];
    // 首条用户消息更新 session 标题
    if (msg.role === 'user' && (!s.title || s.title === '未命名')
        && s.messages.filter((m) => m.role === 'user').length === 1) {
      s.title = msg.content.slice(0, 40);
    }
    sessions.value = [...sessions.value]; // 触发响应式
    saveSessionsToStorage();
  }

  function appendUserMessage(text: string): void {
    if (!currentSessionId.value) newSession(text.slice(0, 40));
    saveMessageToCurrent({ role: 'user', content: text });
  }

  function appendAiLine(kind: AiLineKind, text: string): void {
    saveMessageToCurrent({ role: 'ai', kind, content: text });
  }

  function appendAiDelta(text: string): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last?.role === 'ai' && last.kind === 'stream') {
      last.content += text;
      s.messages = [...s.messages];
      sessions.value = [...sessions.value];
      saveSessionsToStorage();
      return;
    }
    saveMessageToCurrent({ role: 'ai', kind: 'stream', content: text });
  }

  function appendAuthoringInteraction(interaction: AuthoringInteraction): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const exists = s.messages.some((m) => m.role === 'authoring' && m.interaction?.id === interaction.id);
    if (exists) return;
    saveMessageToCurrent({ role: 'authoring', interaction });
  }

  function appendAuthoringArtifact(artifact: AuthoringArtifact): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const existing = s.messages.find((m) => m.role === 'authoring' && m.artifact?.id === artifact.id);
    if (existing?.role === 'authoring') {
      existing.artifact = artifact;
      s.messages = [...s.messages];
      sessions.value = [...sessions.value];
      saveSessionsToStorage();
      return;
    }
    saveMessageToCurrent({ role: 'authoring', artifact });
  }

  function markAuthoringAnswered(interactionId: string): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    for (const msg of s.messages) {
      if (msg.role === 'authoring' && msg.interaction?.id === interactionId) {
        msg.interaction = { ...msg.interaction, answered: true };
      }
    }
    s.messages = [...s.messages];
    sessions.value = [...sessions.value];
    saveSessionsToStorage();
  }

  function switchSession(id: string): void {
    if (getSession(id)) currentSessionId.value = id;
  }

  function startNewChat(): void {
    activeRunId = null;
    stopRequested = false;
    stoppedRunIds.clear();
    authoringSession.value = null;
    currentSessionId.value = null;
  }

  async function clearCurrentChat(): Promise<void> {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const ok = await confirm({ title: '清空对话', message: '清空当前对话的消息？', okText: '清空' });
    if (!ok) return;
    s.messages = [];
    sessions.value = [...sessions.value];
    saveSessionsToStorage();
  }

  function residualCountForSession(session: ChatSession): number {
    return collectAuthoringResidualPaths(session).paths.length;
  }

  async function cleanupSessionResiduals(id: string, silent = false): Promise<CleanupResidualsResponse | null> {
    const session = getSession(id);
    if (!session) return null;
    const { paths } = collectAuthoringResidualPaths(session);
    if (paths.length === 0) {
      if (!silent) notify.info('这条历史没有可清理的文件残留');
      return { ok: true, deleted: [], missing: [], rejected: [] };
    }
    if (!silent) {
      const ok = await confirm({
        title: '清理文件残留',
        message: `只清理这条历史里未通过验证/未完成验证的落盘文件，共 ${paths.length} 个；不会删除历史记录。`,
        okText: '清理残留',
      });
      if (!ok) return null;
    }
    try {
      const result = await requestJson<CleanupResidualsResponse>('/api/skill-studio/cleanup-residuals', {
        method: 'POST',
        body: JSON.stringify({ sessionId: id, paths }),
      });
      if (!silent) {
        const deleted = result.deleted?.length || 0;
        const missing = result.missing?.length || 0;
        const rejected = result.rejected?.length || 0;
        if (deleted || missing) notify.success(`残留清理完成：删除 ${deleted} 个，已不存在 ${missing} 个${rejected ? `，跳过 ${rejected} 个已加载/受保护文件` : ''}`);
        else if (rejected) notify.warn(`没有删除文件，${rejected} 个文件被跳过`);
        else notify.info('没有发现可删除的残留文件');
      }
      return result;
    } catch (err) {
      if (!silent) notify.error('清理残留失败: ' + (err as Error).message);
      return null;
    }
  }

  async function deleteSession(id: string): Promise<void> {
    const session = getSession(id);
    if (!session) return;
    const residualCount = residualCountForSession(session);
    const ok = await confirm({
      title: '删除历史记录',
      message: residualCount > 0
        ? `删除这条历史记录，并同步清理其中 ${residualCount} 个未通过验证/未完成验证的文件残留？`
        : '删除这条历史记录？',
      okText: '删除',
    });
    if (!ok) return;
    if (residualCount > 0) await cleanupSessionResiduals(id, true);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (currentSessionId.value === id) {
      currentSessionId.value = null;
      authoringSession.value = null;
    }
    socket.emit('ide:clear', { sessionId: id });
    saveSessionsToStorage();
  }

  function toggleHistoryDrawer(): void {
    historyDrawerOpen.value = !historyDrawerOpen.value;
  }

  function setStatus(kind: RunStatusKind, text: string): void {
    runStatusKind.value = kind;
    runStatusText.value = text;
  }

  /* ─── socket on (迭代 1: 7 个) ────────────────────── */

  const handlers: SocketHandler[] = [
    ['ide:thinking', (msg: unknown) => {
      const m = msg as IdeSocketMessage;
      if (!matchesCurrentRun(m)) return;
      currentTextHadDelta = false;
      setStatus('running', '思考中...');
    }],
    ['ide:authoring-session', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { session?: AuthoringSessionSnapshot };
      if (!m || m.sessionId !== currentSessionId.value || !m.session) return;
      authoringSession.value = m.session;
      setStatus('running', `创作流程：${authoringStageLabels[m.session.stage] || m.session.stage}`);
    }],
    ['ide:authoring-interaction', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { interaction?: AuthoringInteraction };
      if (!m || m.sessionId !== currentSessionId.value || !m.interaction) return;
      appendAuthoringInteraction(m.interaction);
    }],
    ['ide:authoring-artifact', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { artifact?: AuthoringArtifact };
      if (!m || m.sessionId !== currentSessionId.value || !m.artifact) return;
      appendAuthoringArtifact(m.artifact);
    }],
    ['ide:text', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { text?: string };
      if (!matchesCurrentRun(m) || !m.text || currentTextHadDelta) return;
      appendAiLine('stdout', m.text);
    }],
    ['ide:text-delta', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { delta?: string };
      if (!matchesCurrentRun(m) || !m.delta) return;
      currentTextHadDelta = true;
      setStatus('running', '生成中...');
      appendAiDelta(m.delta);
    }],
    ['ide:tool-start', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { name?: string };
      if (!matchesCurrentRun(m)) return;
      setStatus('running', m.name ? `调用工具：${m.name}` : '调用工具...');
    }],
    ['ide:tool-end', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { is_error?: boolean };
      if (!matchesCurrentRun(m)) return;
      setStatus('running', m.is_error ? '工具返回错误，继续分析...' : '思考中...');
    }],
    ['ide:done', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { round?: number };
      if (!matchesCurrentRun(m)) return;
      setStatus('done', `完成 (${m.round ?? 0} 轮)`);
      finalize();
    }],
    ['ide:error', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { error?: string };
      if (!matchesCurrentRun(m)) return;
      setStatus('error', '出错');
      appendAiLine('error', `✘ ${m.error || '未知错误'}`);
      finalize();
    }],
    ['ide:cancelled', (msg: unknown) => {
      const m = msg as IdeSocketMessage;
      if (!matchesCurrentRun(m, { allowStopped: true, allowAfterStop: true })) return;
      rememberStoppedRun(m.runId);
      setStatus('cancelled', '已取消');
      appendAiLine('error', '已取消');
      finalize();
    }],
    ['ide:mcp-status', (msg: unknown) => {
      const m = msg as { mcpId?: string; status?: string; tools?: unknown[] };
      if (!m.mcpId) return;
      const next = new Map(localMcpStatus.value);
      next.set(m.mcpId, {
        status: (m.status as LocalMcpStatus['status']) || 'stopped',
        toolCount: Array.isArray(m.tools) ? m.tools.length : 0,
      });
      localMcpStatus.value = next;
    }],
    ['ide:approve-request', (msg: unknown) => {
      const m = msg as Partial<ApprovePayload> & IdeSocketMessage;
      if (!matchesCurrentRun(m) || !m.requestId || !m.sessionId) return;
      // 新 request 来时若已有旧倒计时，清理旧的（防多 tick 累加）
      clearApproveCountdown();
      pendingApprove.value = {
        requestId: m.requestId,
        sessionId: m.sessionId,
        title: m.title,
        toolName: m.toolName,
        detail: m.detail,
      };
      approveCountdown.value = APPROVE_TIMEOUT_SEC;
      approveTickHandle = setInterval(() => {
        approveCountdown.value -= 1;
        if (approveCountdown.value <= 0) {
          // 120s 超时自动 deny
          respondApprove('deny');
        }
      }, 1000);
    }],
  ];

  /* ─── API ─────────────────────────────────────────── */

  async function loadContext(): Promise<void> {
    try {
      const data = await requestJson<{ hosts?: HostInfo[] }>('/api/skill-studio/context');
      hosts.value = data.hosts || [];
      restoreSelectedHosts();
    } catch (err) {
      notify.error((err as Error).message || '加载主机列表失败');
    }
  }

  async function loadSkills(): Promise<void> {
    try {
      const [skillRes, mcpRes] = await Promise.all([
        requestJson<{ skills?: SkillInfo[] }>('/api/skills').catch(() => ({ skills: [] as SkillInfo[] })),
        requestJson<{ servers?: McpInfo[] }>('/api/mcp-servers').catch(() => ({ servers: [] as McpInfo[] })),
      ]);
      skillList.value = (skillRes.skills || []).filter((s) => s.id !== 'skill-authoring');
      mcpList.value = (mcpRes.servers || []).filter((m) => m.enabled !== false && m.exposeToIde !== false);
    } catch { /* 静默 */ }
  }

  async function scanContainers(): Promise<void> {
    const hostId = scanHostId.value || 'local';
    scanning.value = true;
    containerScan.value = null; // 让 UI 显"扫描中…"

    const tryExec = (): Promise<ExecResponse> => requestJson<ExecResponse>('/api/exec', {
      method: 'POST',
      body: JSON.stringify({ hostId, command: DOCKER_SCAN_CMD, timeout: 12000 }),
    });

    try {
      const res = await tryExec();
      containerScan.value = parseDockerScan(res.stdout || '');
    } catch (err) {
      // 第一次失败：800ms 后自动重试 1 次
      await new Promise((r) => setTimeout(r, 800));
      try {
        const res2 = await tryExec();
        containerScan.value = parseDockerScan(res2.stdout || '');
      } catch (err2) {
        containerScan.value = { kind: 'error', message: (err2 as Error).message.slice(0, 80) };
      }
    }
    scanning.value = false;
  }

  async function loadFpDir(hostId: string, dirPath: string): Promise<FpListResponse | null> {
    try {
      const url = `/api/files/list?hostId=${encodeURIComponent(hostId)}&path=${encodeURIComponent(dirPath || '')}`;
      const data = await requestJson<FpListResponse>(url);
      return data;
    } catch (err) {
      notify.error('加载目录失败: ' + (err as Error).message);
      return null;
    }
  }

  /* ─── 4 个选择集合的 toggle ────────────────────────── */

  function toggleHost(id: string): void {
    const m = new Map(selectedHosts.value);
    if (m.has(id)) m.delete(id);
    else {
      const h = allHosts.value.find((x) => x.id === id);
      if (h) m.set(id, h);
    }
    selectedHosts.value = m;
  }

  function addPath(path: string): void {
    const p = path.trim();
    if (!p) return;
    if (selectedHosts.value.size === 0) {
      notify.error('请先在左上角选中至少一台主机');
      return;
    }
    const next = selectedPaths.value.slice();
    for (const h of selectedHosts.value.values()) {
      next.push({ hostId: h.id, path: p });
    }
    selectedPaths.value = next;
  }

  function addPickedPath(hostId: string, path: string): void {
    // fp-modal 内的"➕"添加：去重
    if (selectedPaths.value.find((x) => x.hostId === hostId && x.path === path)) return;
    selectedPaths.value = [...selectedPaths.value, { hostId, path }];
  }

  function removePath(index: number): void {
    selectedPaths.value = selectedPaths.value.filter((_, i) => i !== index);
  }

  function toggleContainer(hostId: string, c: ContainerScanItem): void {
    const key = `${hostId}::${c.name}`;
    const m = new Map(selectedContainers.value);
    if (m.has(key)) m.delete(key);
    else m.set(key, { hostId, name: c.name, image: c.image });
    selectedContainers.value = m;
  }

  function unpinContainer(key: string): void {
    const m = new Map(selectedContainers.value);
    m.delete(key);
    selectedContainers.value = m;
  }

  function isContainerSelected(hostId: string, name: string): boolean {
    return selectedContainers.value.has(`${hostId}::${name}`);
  }

  function toggleTool(it: ToolItem): void {
    const key = toolItemKey(it);
    const s = new Set(selectedTools.value);
    if (s.has(key)) {
      s.delete(key);
      if (it.isLocal) stopLocalMcp(it.id);
    } else {
      s.add(key);
      if (it.isLocal) startLocalMcp(it.id);
    }
    selectedTools.value = s;
  }

  /* ─── 本地 MCP 启停（迭代 2） ──────────────────────── */

  function startLocalMcp(mcpId: string): void {
    socket.emit('ide:mcp-start', { mcpId }, (ack: AckResponse) => {
      if (!ack?.ok) {
        notify.error(`MCP 启动失败: ${ack?.error || '未知错误'}`);
      }
    });
  }

  function stopLocalMcp(mcpId: string): void {
    socket.emit('ide:mcp-stop', { mcpId });
  }

  /* ─── 安全模式审批条 emit（迭代 2） ────────────────── */

  function clearApproveCountdown(): void {
    if (approveTickHandle !== null) {
      clearInterval(approveTickHandle);
      approveTickHandle = null;
    }
  }

  function respondApprove(action: ApproveAction, text: string = ''): void {
    const p = pendingApprove.value;
    if (!p) return;
    if (action === 'custom') {
      const t = text.trim();
      if (!t) {
        notify.error('请输入自定义回复');
        return;
      }
      text = t;
    }
    clearApproveCountdown();
    socket.emit('ide:approve-response', {
      requestId: p.requestId,
      sessionId: p.sessionId,
      action,
      text: text || '',
    });
    pendingApprove.value = null;
  }

  /* ─── 3 个 checkbox 同步 ──────────────────────────── */

  function setSafeMode(enabled: boolean): void {
    safeMode.value = enabled;
    if (currentSessionId.value) {
      socket.emit('ide:safe-mode', { sessionId: currentSessionId.value, enabled });
    }
  }

  function setUnlimitedTurns(enabled: boolean): void {
    unlimitedTurns.value = enabled;
    if (currentSessionId.value) {
      socket.emit('ide:unlimited-turns', { sessionId: currentSessionId.value, enabled });
    }
  }

  function setCcCollab(enabled: boolean): void {
    ccCollab.value = enabled;
    if (currentSessionId.value) {
      socket.emit('ide:claude-code-collab', { sessionId: currentSessionId.value, enabled });
    }
  }

  function setRefinedMode(enabled: boolean): void {
    refinedMode.value = enabled;
    if (currentSessionId.value) {
      socket.emit('ide:refined-mode', { sessionId: currentSessionId.value, enabled });
    }
  }

  /* ─── onSend / onStop ─────────────────────────────── */

  function buildSendContext(): SendContext {
    return {
      hosts: [...selectedHosts.value.values()].map((h) => ({
        id: h.id, name: h.name, host: h.host, username: h.username, port: h.port,
      })),
      containers: [...selectedContainers.value.values()],
      files: selectedPaths.value.map((p) => ({ hostId: p.hostId, path: p.path })),
      mcpServers: [...selectedTools.value].filter((k) => k.startsWith('mcp:')).map((k) => {
        const id = k.slice(4);
        const srv = mcpList.value.find((m) => m.id === id);
        return srv ? { id: srv.id, name: srv.name, url: srv.url } : { id };
      }),
    };
  }

  function emitIdeMessage(task: string): void {
    sendAckHandle = setTimeout(() => {
      setStatus('error', '启动超时');
      appendAiLine('error', 'ide:message 已发送但未收到后端确认，请检查后端 Socket handler');
      finalize();
    }, 8000);

    socket.emit('ide:message', {
      sessionId: currentSessionId.value,
      message: task,
      context: buildSendContext(),
      safeMode: safeMode.value,
      unlimitedTurns: unlimitedTurns.value,
      claudeCodeEnabled: ccCollab.value,
      refinedMode: refinedMode.value,
      entry: 'studio',
    }, (ack: AckResponse) => {
      if (sendAckHandle !== null) {
        clearTimeout(sendAckHandle);
        sendAckHandle = null;
      }
      if (!ack?.ok) {
        setStatus('error', '启动失败');
        appendAiLine('error', ack?.error || 'ide:message 被拒绝');
        finalize();
        return;
      }
      const sid = currentSessionId.value;
      if (sid) {
        socket.emit('ide:safe-mode', { sessionId: sid, enabled: safeMode.value });
        socket.emit('ide:unlimited-turns', { sessionId: sid, enabled: unlimitedTurns.value });
        socket.emit('ide:claude-code-collab', { sessionId: sid, enabled: ccCollab.value });
        socket.emit('ide:refined-mode', { sessionId: sid, enabled: refinedMode.value });
      }
    });
  }

  function sendWhenSocketReady(task: string): void {
    if (socket.connected) {
      emitIdeMessage(task);
      return;
    }
    setStatus('starting', '连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(task);
    };
    socket.once('connect', pendingConnectSend);
    socket.connect();
    sendConnectHandle = setTimeout(() => {
      if (pendingConnectSend) socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
      setStatus('error', 'Socket 未连接');
      appendAiLine('error', 'Socket 尚未连接，ide:message 未发送；请确认后端已启动并刷新页面重试');
      finalize();
    }, 8000);
  }

  async function sendTask(task: string): Promise<void> {
    activeRunId = null;
    stopRequested = false;
    appendUserMessage(task);

    isRunning.value = true;
    setStatus('starting', '启动中...');

    sendWhenSocketReady(task);
  }

  async function onSend(): Promise<void> {
    const task = taskInput.value.trim();
    if (!task) {
      notify.error('请输入自然语言描述');
      return;
    }
    if (isRunning.value) return;
    taskInput.value = '';
    await sendTask(task);
  }

  function respondAuthoring(interaction: AuthoringInteraction, value: string, label: string): void {
    if (isRunning.value) {
      notify.error('请等待当前回复完成后再选择');
      return;
    }
    if (!currentSessionId.value || !authoringSession.value) return;
    const text = interaction.kind === 'commit_approval'
      ? (value === 'approve'
        ? `我确认执行：${label || '写入创作产物文件'}：${interaction.artifactId || ''}`
        : `暂不写入，继续修改草案：${interaction.artifactId || ''}`)
      : interaction.kind === 'options'
        ? `我选择方案 ${value}：${label}`
        : `${interaction.question || '我的回答'}：${label || value}`;
    socket.emit('ide:authoring-reply', {
      sessionId: currentSessionId.value,
      authoringSessionId: authoringSession.value.id,
      interactionId: interaction.id,
      value,
      text,
    }, (ack: AckResponse) => {
      if (!ack?.ok) {
        notify.error(ack?.error || '提交选择失败');
        return;
      }
      markAuthoringAnswered(interaction.id);
      void sendTask(text);
    });
  }

  function onStop(): void {
    if (!currentSessionId.value) return;
    const stoppedSessionId = currentSessionId.value;
    stopRequested = true;
    rememberStoppedRun();
    socket.emit('ide:stop', { sessionId: stoppedSessionId }, (ack: AckResponse) => {
      if (!ack?.ok && isRunning.value) {
        setStatus('cancelled', '停止请求失败');
        finalize();
      }
    });
    setStatus('cancelled', '正在停止...');
    if (stopFallbackHandle !== null) clearTimeout(stopFallbackHandle);
    stopFallbackHandle = setTimeout(() => {
      if (isRunning.value && currentSessionId.value === stoppedSessionId) {
        setStatus('cancelled', '已停止');
        appendAiLine('error', '已停止');
        finalize();
      }
    }, 2500);
  }

  function finalize(): void {
    isRunning.value = false;
    stopRequested = false;
    pendingApprove.value = null;
    clearApproveCountdown();
    if (stopFallbackHandle !== null) {
      clearTimeout(stopFallbackHandle);
      stopFallbackHandle = null;
    }
    if (sendAckHandle !== null) {
      clearTimeout(sendAckHandle);
      sendAckHandle = null;
    }
    if (sendConnectHandle !== null) {
      clearTimeout(sendConnectHandle);
      sendConnectHandle = null;
    }
    if (pendingConnectSend) {
      socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
    }
    // 任务完成后重拉 skill 列表（用户可能新建了 skill）
    void loadSkills();
  }

  /* ─── 跨页入口：deploy_mcp / refine（13.2 = B 补齐） ─── */

  async function handleEntryQuery(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const deployUrl = params.get('deploy_mcp');
    const mode = params.get('mode');
    const target = params.get('target');

    if (deployUrl) {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => {
        taskInput.value = `帮我部署这个 MCP Server 到本地：${deployUrl}\n请 clone 仓库、安装依赖、识别启动命令，然后用 deploy_local_mcp 注册。`;
        void onSend();
      }, 500);
      return;
    }

    if (mode === 'refine' && target) {
      window.history.replaceState({}, '', window.location.pathname);
      const targetItem = skillList.value.find((s) => s.id === target);
      const artifactName = targetItem?.name || target;
      let errorCtx = '';
      try {
        errorCtx = sessionStorage.getItem(ERROR_CONTEXT_KEY) || '';
        sessionStorage.removeItem(ERROR_CONTEXT_KEY);
      } catch { /* quota */ }
      setTimeout(() => {
        const lines: string[] = [`请帮我改进产物「${artifactName}」（id: ${target}）。`];
        if (errorCtx) {
          lines.push('', '上一次运行的错误信息：', '```', errorCtx, '```', '');
          lines.push('请分析以上错误的根因，定位是 Program L1/action、Skill 约束还是执行命令本身的问题，并给出具体修改方案。');
        } else {
          lines.push('', '请分析这个产物当前的不足，并给出改进方案。');
        }
        taskInput.value = lines.join('\n');
        void onSend();
      }, 500);
      return;
    }
  }

  /* ─── 生命周期 ────────────────────────────────────── */

  const cleanup = bindHandlers(socket, handlers);

  watch([
    selectedHosts,
    selectedPaths,
    selectedContainers,
    selectedTools,
    scanHostId,
    toolFilter,
    currentSessionId,
    taskInput,
    safeMode,
    unlimitedTurns,
    ccCollab,
    refinedMode,
    historyDrawerOpen,
  ], saveStudioPrefs, { deep: true });

  onMounted(async () => {
    loadSessionsFromStorage();
    if (savedPrefs.currentSessionId && sessions.value.some((s) => s.id === savedPrefs.currentSessionId)) {
      currentSessionId.value = savedPrefs.currentSessionId;
    } else if (savedPrefs.currentSessionId) {
      currentSessionId.value = null;
    }
    await Promise.all([loadContext(), loadSkills()]);
    await handleEntryQuery();
  });

  onBeforeUnmount(() => {
    cleanup();
    clearApproveCountdown();
  });

  return {
    /* state */
    hosts, allHosts, skillList, mcpList,
    selectedHosts, selectedPaths, selectedContainers, selectedTools,
    localMcpStatus,
    scanHostId, containerScan, scanning,
    toolFilter, toolItems, filteredToolItems, toolItemKey,
    sessions, currentSessionId, currentMessages,
    isRunning, runStatusKind, runStatusText,
    authoringSession, authoringStages, authoringStageText,
    taskInput, safeMode, unlimitedTurns, ccCollab, refinedMode,
    historyDrawerOpen,
    pendingApprove, approveCountdown,
    summaryText,
    /* helpers */
    hostName,
    isContainerSelected,
    /* methods */
    toggleHost, addPath, addPickedPath, removePath,
    toggleContainer, unpinContainer,
    toggleTool,
    setSafeMode, setUnlimitedTurns, setCcCollab, setRefinedMode,
    onSend, onStop, respondAuthoring,
    switchSession, startNewChat, clearCurrentChat, deleteSession,
    cleanupSessionResiduals, residualCountForSession,
    toggleHistoryDrawer,
    scanContainers, loadFpDir,
    respondApprove,
  };
}

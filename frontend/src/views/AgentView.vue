<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import HostListToolResult from '@/components/ide/HostListToolResult.vue';
import ProbeListToolResult from '@/components/ide/ProbeListToolResult.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import AgentSessionRail from '@/components/AgentSessionRail.vue';
import TerminalArea from '@/components/main/TerminalArea.vue';
import HostModal from '@/components/main/HostModal.vue';
import AnalyzeContextMenu from '@/components/main/AnalyzeContextMenu.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { readStorageState, writeStorageState } from '@/composables/usePageState';
import { useHostsStore } from '@/stores/hosts';
import { useIdeChat, type IdeApprovalMode, type IdeTimelineItem, type IdeChatApi, type IdeChatMessage, type IdeThinkingTimelineItem, type IdeToolTimelineItem, type IdeSystemTimelineItem, type IdeRewindPoint, type IdeFileLocation } from '@/composables/useIdeChat';
import { useNotifyStore } from '@/stores/notify';
import {
  agentGoalObjective,
  emptyAgentGoalState,
  formatAgentGoalLabel,
  parseAgentGoalCommand,
  reduceAgentGoalCommand,
  serializeAgentGoal,
  type AgentGoalCommand,
} from '@/utils/agentGoal';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { MainHost, HostFormPayload, HostLink, HostInfo } from '@/utils/mainConsole';
import { renderMarkdown, streamingPlainText } from '@/utils/markdown';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';
import { parseHostListResult, parseProbeListResult } from '@/utils/structuredToolResults';
import { agentSlashCommandsForSurface, filterAgentSlashCommands, type AgentSlashCommand } from '@/utils/agentSlashCommands';

// 异步加载：CodeMirror 体积大，只在真正打开文件面板时拉取
const AgentFilePanel = defineAsyncComponent(() => import('@/components/ide/AgentFilePanel.vue'));
const AttachmentThumb = defineAsyncComponent(() => import('@/components/ide/AttachmentThumb.vue'));
// 工具卡 diff（claude Edit/MultiEdit 的 old/new）同样按需加载
const IdeEditDiff = defineAsyncComponent(() => import('@/components/ide/IdeEditDiff.vue'));

// ── provider model ──
interface AgentProviderModel {
  id: string;
  apiModel: string;
  displayName?: string;
  enabled?: boolean;
  reasoningEffort?: string;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
}

interface AgentProvider {
  id: string;
  name: string;
  apiBase: string;
  apiKeySet: boolean;
  model: string;
  upstreamProtocol: string;
  reasoningEffort?: string;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
  activeModelId?: string | null;
  routeModelId?: string | null;
  models?: AgentProviderModel[];
  enabled?: boolean;
}

interface AgentProviderRoute {
  providerId?: string | null;
  modelId?: string | null;
}

// ── protocol agents（第三方协议 agent：Claude Code / Codex / …）──
const ONESHELL_AGENT_ID = 'oneshell';

interface ProtocolAgentInfo {
  id: string;
  name: string;
  protocol: string;
  icon?: string;
  description?: string;
  supportsResume?: boolean;
  installed: boolean;
  binaryPath?: string;
}

interface AgentModelOption {
  key: string;
  providerId: string;
  modelId: string | null;
  providerName: string;
  label: string;
  apiModel: string;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
}

// ── type guards unused in template — discriminator checked directly for TS narrowing ──

function toolIcon(tool: IdeToolTimelineItem): string {
  const n = tool.name.toLowerCase();
  if (tool.isError) return 'alert';
  if (n.includes('execute') || n.includes('command') || n.includes('host_exec') || n === 'shell') return 'terminal';
  if (n.includes('probe') || n.includes('metric')) return 'radio';
  if (n.includes('host') || n.includes('server')) return 'server';
  if (n.includes('download')) return 'download';
  if (n.includes('upload')) return 'cloud';
  if (n.includes('delete') || n.includes('remove') || n.includes('rm')) return 'trash';
  if (n.includes('write') || n.includes('create') || n.includes('mkdir')) return 'file-plus';
  if (n.includes('read') || n.includes('list') || n.includes('dir') || n.includes('file')) return 'folder';
  if (n.includes('approval') || n.includes('permission')) return 'shield';
  if (n.includes('secret')) return 'lock';
  if (n.includes('verify')) return 'check';
  if (n.includes('ask')) return 'message-circle';
  return 'wrench';
}

function toolLabel(tool: IdeToolTimelineItem): string {
  if (tool.status === 'preparing') return '准备中';
  if (tool.status === 'running') return '执行中';
  if (tool.status === 'error') return '失败';
  return '完成';
}

function toolDuration(d: number | undefined): string {
  if (d === undefined) return '';
  return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
}

// 协议 agent 工具卡带出的触碰文件（后端 tool 事件 locations）
function toolFileLocations(tool: IdeToolTimelineItem): IdeFileLocation[] {
  return Array.isArray(tool.locations) ? tool.locations : [];
}

// claude Edit / MultiEdit 入参 → diff 对（展开的工具卡里渲染 unified diff）
interface ToolEditDiff {
  oldText: string;
  newText: string;
  path: string;
}

function toolEditDiffs(tool: IdeToolTimelineItem): ToolEditDiff[] {
  if (!isRecord(tool.input)) return [];
  const input = tool.input;
  const path = stringField(input, 'file_path') || stringField(input, 'filePath');
  const out: ToolEditDiff[] = [];
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    out.push({ oldText: input.old_string, newText: input.new_string, path });
  } else if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (!isRecord(edit)) continue;
      if (typeof edit.old_string === 'string' && typeof edit.new_string === 'string') {
        out.push({ oldText: edit.old_string, newText: edit.new_string, path });
      }
    }
  }
  return out;
}

function fmtVal(v: unknown, max = 4000): string {
  if (v === undefined || v === null) return '';
  const t = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return t.length > max ? t.slice(0, max) + '\n…[truncated]' : t;
}

function hasHostListResult(tool: IdeToolTimelineItem): boolean {
  return tool.name === 'list_hosts' && Boolean(parseHostListResult(tool.result));
}

function hasProbeListResult(tool: IdeToolTimelineItem): boolean {
  return ['list_probes', 'query_probe'].includes(tool.name) && Boolean(parseProbeListResult(tool.result));
}

function assistantDisplayText(item: IdeChatMessage, index: number): string {
  return item.text;
}

function assistantStreamingText(item: IdeChatMessage, index: number): string {
  return streamingPlainText(assistantDisplayText(item, index));
}

// ── state ──
const { requestJson } = useApiClient();
const { confirm } = useConfirm();
const notify = useNotifyStore();
const route = useRoute();
const router = useRouter();

const scrollEl = ref<HTMLElement | null>(null);
const shellEl = ref<HTMLElement | null>(null);
const hostsStore = useHostsStore();
// AgentView 老代码消费 HostInfo 形状（id/name/host），从 hosts store 投影
const hosts = computed<HostInfo[]>(() => hostsStore.items.map((h: MainHost) => ({ id: h.id, name: h.name, host: h.host })));
const providers = ref<AgentProvider[]>([]);
const protocolAgents = ref<ProtocolAgentInfo[]>([]);
const activeProviderId = ref<string | null>(null);
const activeModelId = ref<string | null>(null);
const agentGoal = ref(emptyAgentGoalState());
const selectedHostId = ref('');
const selectedWorkspaceHostIds = ref<string[]>([]);
const modelPreference = ref('默认模型');
const approvalMode = ref<IdeApprovalMode>('manual');
const composerInput = ref('');
const composerMode = ref<'chat' | 'goal'>('chat');
const composerInputEl = ref<HTMLTextAreaElement | null>(null);
const showHostDropdown = ref(false);
const showModeDropdown = ref(false);
const showModelDropdown = ref(false);
const showFilesDropdown = ref(false);
const newSessionModalOpen = ref(false);
const newSessionHostDraft = ref<string[]>([]);
const newSessionAgentDraft = ref(ONESHELL_AGENT_ID);
const newSessionCwdDraft = ref('');
const expandingToolId = ref<string | null>(null);
const initialMobileRailLayout = typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
const railCollapsed = ref(initialMobileRailLayout);
const mobileRailLayout = ref(initialMobileRailLayout);
let railAutoCollapsed = initialMobileRailLayout;
let follow = true;

type RailTab = 'chat' | 'files' | 'tools';

interface FileFocus {
  hostId: string;
  path: string;
  directory: string;
  fileName?: string;
  toolName?: string;
  action?: string;
  status?: string;
  updatedAt?: number;
}

const railTab = ref<RailTab>('chat');
const fileFocus = ref<FileFocus | null>(null);
// 右栏文件面板（M3 IDE 壳）：桌面端点击工具卡文件 chip 打开
const filePanelFile = ref<IdeFileLocation | null>(null);
let lastToolFocusKey = '';

// ── 工作模式：Agent 对话 / 终端（同一主区切换，composer 常驻共用，Warp 式命令输入）──
type WorkMode = 'agent' | 'terminal';
const WORKMODE_KEY = '1shell.agent.workmode.v1';

const sessionTerminal = useSessionTerminal();
const termHostId = sessionTerminal.activeHostId;
// 终端模式 composer 主机徽标（4.7.5 起顶栏探针退役，名字直接取主机列表）
const termHostName = computed(() => hostsStore.hostMap.get(termHostId.value)?.name || '本机');

const storedWorkMode = readStorageState<{ mode?: WorkMode }>(WORKMODE_KEY, { mode: 'agent' });
const workMode = ref<WorkMode>(storedWorkMode.mode === 'terminal' ? 'terminal' : 'agent');
const isTerminalMode = computed(() => workMode.value === 'terminal');
// 终端全屏 = 主区（终端+输入条）整体 fixed 铺满窗口
const terminalFullscreen = ref(false);
// 终端惰性启动：首次切到终端模式才建 xterm / 连 PTY 会话
const terminalStarted = ref(false);

function refitTerminalSoon(): void {
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
}

function ensureTerminalStarted(): void {
  if (terminalStarted.value) return;
  terminalStarted.value = true;
  // 共享 socket 已就绪时直接进默认会话（activeHostId 决定连谁）
  sessionTerminal.connectSocket();
}

function setWorkMode(mode: WorkMode): void {
  if (workMode.value === mode) return;
  workMode.value = mode;
  slashSubView.value = null;
  if (mode === 'terminal') ensureTerminalStarted();
  else terminalFullscreen.value = false;
  writeStorageState(WORKMODE_KEY, { mode });
  refitTerminalSoon();
  void nextTick(() => composerInputEl.value?.focus());
}

function onTerminalFullscreen(value: boolean): void {
  terminalFullscreen.value = value;
  refitTerminalSoon();
}

// Warp 式：终端模式下，底部输入框即命令行（也可直接点击 xterm 输入）
function sendToTerminal(): void {
  const raw = composerInput.value;
  if (!raw.trim()) return;
  const ok = sessionTerminal.sendSessionInput(raw.replace(/\r?\n/g, '\r') + '\r');
  if (!ok) {
    notify.error('终端未连接，请稍候或重新选择主机');
    return;
  }
  composerInput.value = '';
}

// ── 主机管理（合并自原 /terminal 页左栏）──
const hostModalOpen = ref(false);
const hostEditing = ref<MainHost | null>(null);
const hostModalRef = ref<InstanceType<typeof HostModal> | null>(null);
const sshHosts = computed(() => hostsStore.items.filter((h: MainHost) => h.type === 'ssh' || h.id !== LOCAL_HOST_ID));

function openAddHost(): void {
  hostEditing.value = null;
  hostModalOpen.value = true;
}

function onHostEdit(hostId: string): void {
  const h = hostsStore.hostMap.get(hostId);
  if (!h) return;
  hostEditing.value = h;
  hostModalOpen.value = true;
}

async function onHostDelete(hostId: string): Promise<void> {
  const h = hostsStore.hostMap.get(hostId);
  if (!h) return;
  const ok = await confirm({ title: '删除主机', message: `确认删除主机"${h.name}"吗？绑定在该主机上的对话记录会一并删除。`, okText: '删除' });
  if (!ok) return;
  try {
    await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });
    if (termHostId.value === hostId) {
      sessionTerminal.closeHostSession(hostId);
      termHostId.value = LOCAL_HOST_ID;
    }
    await loadHosts();
    void loadSessions();
    notify.success('主机已删除');
  } catch (err) {
    notify.error((err as Error).message);
  }
}

async function onHostSubmit(
  payload: HostFormPayload | { isLocal: true; name: string; links: HostLink[] },
  hostId: string | null
): Promise<void> {
  try {
    if ('isLocal' in payload && payload.isLocal) {
      await requestJson('/api/hosts/local-config', {
        method: 'PUT',
        body: JSON.stringify({ name: payload.name, links: payload.links }),
      });
    } else if (hostId) {
      await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await requestJson('/api/hosts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    await loadHosts();
    hostModalOpen.value = false;
    notify.success(hostId === LOCAL_HOST_ID ? '本机配置已更新' : (hostId ? '主机已更新' : '主机已添加'));
  } catch (err) {
    hostModalRef.value?.setError((err as Error).message);
  }
}

function onHostConnect(hostId: string): void {
  hostsStore.select(hostId);
  termHostId.value = hostId;
  // 记住最近连接主机，供主页"最近主机"卡使用
  if (hostId && hostId !== LOCAL_HOST_ID) {
    try { localStorage.setItem('1shell-last-host', hostId); } catch { /* ignore */ }
  }
  const firstStart = !terminalStarted.value;
  setWorkMode('terminal');
  if (firstStart) {
    // 首次启动：connectSocket 的默认会话逻辑会连 activeHostId（setWorkMode 同模式重入时不触发,这里兜底）
    ensureTerminalStarted();
    return;
  }
  sessionTerminal.connectToHost(hostId, false).catch((err) => {
    notify.error((err as Error).message || '连接主机失败');
  });
}

// ?host=<id>（来自地图主页/面板「立即连接」）→ 选中主机 + 切到终端模式
function activateQueryHost(): void {
  const queryHost = typeof route.query.host === 'string' ? route.query.host : null;
  if (!queryHost || !hostsStore.hostMap.has(queryHost)) return;
  if (termHostId.value === queryHost && isTerminalMode.value && terminalStarted.value) return;
  onHostConnect(queryHost);
}

// rail 主机卡片「新对话」：在该主机（或全局）上开新 Agent 会话
function onHostNewSession(key: string): void {
  const ids = key && key !== '__global__' ? [key] : [];
  setWorkMode('agent');
  onNewSession(ids);
}

type AttachmentKind = 'image' | 'text' | 'document' | 'file';

interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  base64?: string;
  text?: string;
  error?: string;
}

const ATTACHMENT_MAX_COUNT = 8;
const ATTACHMENT_MAX_BINARY_BYTES = 12 * 1024 * 1024;
const ATTACHMENT_MAX_TEXT_BYTES = 800 * 1024;

const attachmentInput = ref<HTMLInputElement | null>(null);
const composerAttachments = ref<ComposerAttachment[]>([]);
const attachmentError = ref('');
let pastedImageSeq = 0;

const rewindModalOpen = ref(false);
const rewindLoading = ref(false);
const rewindError = ref('');
const rewindPoints = ref<IdeRewindPoint[]>([]);
const rewindHighlight = ref(0);
const rewindModalRef = ref<HTMLElement | null>(null);

// ── slash commands ──
const SLASH_COMMANDS = agentSlashCommandsForSurface('agent');
const slashHighlight = ref(0);
const slashSubView = ref<string | null>(null);
const slashSubHighlight = ref(0);

interface ProtocolSessionSettings {
  approvalMode: 'auto' | 'ask';
  effort: string;
  fast: boolean;
}

function normalizeProtocolSettings(value?: Partial<ProtocolSessionSettings> | null): ProtocolSessionSettings {
  return {
    // 审批模式固定 auto：第三方 agent 仅以完全访问接入（「每次询问」已下线，
    // 真实 CLI 上审批卡链路不可靠，MCP 调用会被拒导致任务中断）
    approvalMode: 'auto',
    effort: String(value?.effort || '').trim(),
    fast: value?.fast === true,
  };
}

interface AgentRuntime {
  ide: IdeChatApi;
  hostId: Ref<string>;
  workspaceHostIds: Ref<string[]>;
  agentId: Ref<string>;
  cwd: Ref<string>;
  protocolSettings: Ref<ProtocolSessionSettings>;
  createdAt: string;
  touchedAt: Ref<string>;
  stopWatchers: Array<() => void>;
}

interface CreateAgentRuntimeOptions {
  hostId?: string;
  workspaceHostIds?: string[];
  agentId?: string;
  cwd?: string;
  settings?: Partial<ProtocolSessionSettings> | null;
  session?: IdeLoadableAgentSession;
}

interface IdeLoadableAgentSession {
  id: string;
  timeline: IdeTimelineItem[];
  running?: boolean;
  runId?: string;
}

const runtimes = shallowRef<AgentRuntime[]>([]);
const activeRuntimeId = ref('');
const activeRuntime = computed(() => {
  return runtimes.value.find((runtime) => runtime.ide.currentSessionId.value === activeRuntimeId.value)
    || runtimes.value[0]
    || null;
});

const ACTIVE_AGENT_SESSION_STORAGE_KEY = 'oneshell.agent.activeSessionId';
let initialSessionRestoreAttempted = false;

function readStoredActiveSessionId(): string {
  try { return window.localStorage.getItem(ACTIVE_AGENT_SESSION_STORAGE_KEY) || ''; } catch { return ''; }
}

function storeActiveSessionId(id: string): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_AGENT_SESSION_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_AGENT_SESSION_STORAGE_KEY);
  } catch { /* ignore storage failures */ }
}

function rememberRuntimeSession(runtime: AgentRuntime | null = activeRuntime.value): void {
  if (!runtime) return;
  if (runtime.ide.timeline.value.length > 0 || runtime.ide.isRunning.value) {
    storeActiveSessionId(runtime.ide.currentSessionId.value);
  }
}

const enabledProviders = computed(() => providers.value.filter(p => p.enabled !== false));

// ── protocol agent helpers ──
function normalizeAgentId(agentId: unknown): string {
  const id = String(agentId || '').trim();
  return id && id !== ONESHELL_AGENT_ID ? id : ONESHELL_AGENT_ID;
}

function isProtocolAgentId(agentId: string): boolean {
  return Boolean(agentId) && agentId !== ONESHELL_AGENT_ID;
}

function agentNameFor(agentId: string): string {
  if (!isProtocolAgentId(agentId)) return '1Shell AI';
  return protocolAgents.value.find((agent) => agent.id === agentId)?.name || agentId;
}

const installedProtocolAgents = computed(() => protocolAgents.value.filter((agent) => agent.installed));
const activeAgentId = computed(() => normalizeAgentId(activeRuntime.value?.agentId.value));
const activeAgentName = computed(() => agentNameFor(activeAgentId.value));
const activeIsProtocolAgent = computed(() => isProtocolAgentId(activeAgentId.value));
const activeCwd = computed(() => String(activeRuntime.value?.cwd.value || '').trim());

async function loadProtocolAgents(): Promise<void> {
  try {
    const resp = await requestJson<{ ok: boolean; agents: ProtocolAgentInfo[] }>('/api/agent/protocol/agents');
    if (resp.ok) protocolAgents.value = Array.isArray(resp.agents) ? resp.agents : [];
  } catch { /* ignore */ }
}

// ── 协议会话 composer 选择器（agent 切换 / 审批 / 思考程度 / fast）──
const showAgentDropdown = ref(false);
const showEffortDropdown = ref(false);

const EFFORT_LABELS: Record<string, string> = { '': '默认', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
const CLAUDE_EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORT_OPTIONS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const activeProtocolInfo = computed(() => protocolAgents.value.find((agent) => agent.id === activeAgentId.value) || null);
const activeEffortOptions = computed<string[]>(() => {
  const protocol = activeProtocolInfo.value?.protocol || '';
  if (protocol === 'claude-stream') return CLAUDE_EFFORT_OPTIONS;
  if (protocol === 'codex-app-server') return CODEX_EFFORT_OPTIONS;
  return [];
});
const activeSupportsFast = computed(() => (activeProtocolInfo.value?.protocol || '') === 'codex-app-server');
const activeProtocolSettings = computed<ProtocolSessionSettings>(() => activeRuntime.value?.protocolSettings.value || normalizeProtocolSettings(null));
const activeEffortLabel = computed(() => EFFORT_LABELS[activeProtocolSettings.value.effort] || activeProtocolSettings.value.effort || '默认');

function updateProtocolSettings(patch: Partial<ProtocolSessionSettings>): void {
  const runtime = activeRuntime.value;
  if (!runtime) return;
  runtime.protocolSettings.value = normalizeProtocolSettings({ ...runtime.protocolSettings.value, ...patch });
}

function toggleAgentDropdown(): void {
  showAgentDropdown.value = !showAgentDropdown.value;
  showEffortDropdown.value = false;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
  if (showAgentDropdown.value) void loadProtocolAgents();
}

// 会话内切换 agent（双向）：1Shell AI ↔ claude/codex/…。1Shell 以 VPS 为
// 维度，本地工作目录对切换无关紧要——不带 cwd 时后端兜底用户主目录（CLI
// 进程总得有个启动目录），协议 agent 操作 VPS 走 1Shell MCP 工具。oneshell
// 方向由后端 release 协议进程并翻转会话归属，服务端全量历史无缝带过去。
function pickSessionAgent(agentId: string): void {
  showAgentDropdown.value = false;
  const runtime = activeRuntime.value;
  if (!runtime) return;
  const target = normalizeAgentId(agentId);
  if (target === normalizeAgentId(runtime.agentId.value)) return;
  if (runtime.ide.isRunning.value) {
    notify.info('当前回合仍在运行，请先停止后再切换 agent。');
    return;
  }
  runtime.agentId.value = target;
  // effort 取值域随 agent 变化，切换后回到默认档
  updateProtocolSettings({ effort: '' });
  rememberRuntimeSession(runtime);
  notify.info(isProtocolAgentId(target)
    ? `已切换为 ${agentNameFor(target)}，下一条消息起由它接管（会自动补读会话上下文）。`
    : '已切换为 1Shell AI，下一条消息起由它接管（完整对话历史自动延续）。');
}

function pickProtocolEffort(effort: string): void {
  showEffortDropdown.value = false;
  updateProtocolSettings({ effort });
}

function toggleProtocolFast(): void {
  updateProtocolSettings({ fast: !activeProtocolSettings.value.fast });
}

// 协议会话激活时确保目录已加载（composer 需要 agent 名称与协议类型）
watch(activeIsProtocolAgent, (isProtocol) => {
  if (isProtocol && !protocolAgents.value.length) void loadProtocolAgents();
}, { immediate: true });

function modelKey(providerId: string | null | undefined, modelId: string | null | undefined): string {
  return providerId ? `${providerId}::${modelId || ''}` : '';
}

function providerModelProfiles(provider: AgentProvider): AgentProviderModel[] {
  const models = (provider.models || []).filter((model) => model.enabled !== false);
  if (models.length > 0) return models;
  return [{
    id: provider.routeModelId || provider.activeModelId || 'default',
    apiModel: provider.model || '',
    displayName: provider.model || '',
    enabled: true,
    reasoningEffort: provider.reasoningEffort,
    contextTokenLimit: provider.contextTokenLimit,
    maxOutputTokens: provider.maxOutputTokens,
  }];
}

const enabledModelOptions = computed<AgentModelOption[]>(() => enabledProviders.value.flatMap((provider) => (
  providerModelProfiles(provider).map((model) => ({
    key: modelKey(provider.id, model.id),
    providerId: provider.id,
    modelId: model.id || null,
    providerName: provider.name || '未命名配置',
    label: model.displayName || model.apiModel || provider.model || '未指定模型',
    apiModel: model.apiModel || provider.model || '',
    contextTokenLimit: model.contextTokenLimit ?? provider.contextTokenLimit ?? null,
    maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens ?? null,
  }))
)));
const activeModelKey = computed(() => modelKey(activeProviderId.value, activeModelId.value));

function findModelOption(providerId: string | null, modelId: string | null = null): AgentModelOption | null {
  if (!providerId) return null;
  return enabledModelOptions.value.find((option) => option.providerId === providerId && option.modelId === modelId)
    || enabledModelOptions.value.find((option) => option.providerId === providerId)
    || null;
}

function modelOptionMeta(option: AgentModelOption): string {
  const parts = [option.providerName];
  if (option.apiModel && option.apiModel !== option.label) parts.push(option.apiModel);
  return parts.join(' · ');
}

const isGoalComposerMode = computed(() => composerMode.value === 'goal');
const composerPlaceholder = computed(() => {
  if (isTerminalMode.value) return '输入命令，Enter 发送到终端；Shift + Enter 换行…';
  return isGoalComposerMode.value
    ? '1Shell 应继续朝哪个目标努力？'
    : '输入目标、命令，或直接粘贴图片/文件后发送…';
});

const slashCmds = computed<AgentSlashCommand[]>(() => {
  if (isTerminalMode.value) return [];
  if (isGoalComposerMode.value) return [];
  if (slashSubView.value) return [];
  return filterAgentSlashCommands(composerInput.value, SLASH_COMMANDS);
});

const showSlashMenu = computed(() => !newSessionModalOpen.value && !rewindModalOpen.value && !showModelDropdown.value && !showModeDropdown.value && (slashCmds.value.length > 0 || slashSubView.value !== null));

function openSlashModel(): void {
  void loadProviders();
  slashSubView.value = 'model';
  slashSubHighlight.value = 0;
  showModelDropdown.value = false;
  composerInput.value = '';
}

function openGoalComposer(prefill = ''): void {
  composerMode.value = 'goal';
  composerInput.value = prefill;
  slashSubView.value = null;
  showHostDropdown.value = false;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
  void nextTick(() => composerInputEl.value?.focus());
}

function closeGoalComposer(): void {
  if (!isGoalComposerMode.value) return;
  composerMode.value = 'chat';
  composerInput.value = '';
}

function closeSlashMenu(): void {
  composerInput.value = '';
  slashSubView.value = null;
}

function selectSlashCmd(cmd: AgentSlashCommand): void {
  if (cmd.cmd === '/model') { openSlashModel(); return; }
  if (cmd.cmd === '/goal') { openGoalComposer(); return; }
  if (cmd.cmd === '/host') { composerInput.value = ''; showHostDropdown.value = true; return; }
  if (cmd.cmd === '/mode') { composerInput.value = ''; showModeDropdown.value = true; return; }
  if (cmd.cmd === '/compact') { composerInput.value = ''; sendSlash('/compact'); return; }
  if (cmd.cmd === '/remind') { composerInput.value = ''; void openRewindModal(); return; }
  if (cmd.cmd === '/clear') { composerInput.value = ''; void clearChat(); return; }
  composerInput.value = cmd.cmd + ' ';
}

async function selectModelFromSlash(providerId: string | null, modelId: string | null = null, clearComposer = true): Promise<void> {
  const option = findModelOption(providerId, modelId);
  const newModel = option?.label || '默认模型';
  modelPreference.value = newModel;
  if (providerId && (providerId !== activeProviderId.value || (option?.modelId || null) !== activeModelId.value)) {
    try {
      await requestJson(`/api/agent/providers/skills/${providerId}/activate`, {
        method: 'PUT',
        body: JSON.stringify(option?.modelId ? { modelId: option.modelId } : {}),
      } as any);
      activeProviderId.value = providerId;
      activeModelId.value = option?.modelId || null;
      const provider = providers.value.find(p => p.id === providerId);
      if (provider && option) {
        provider.routeModelId = option.modelId;
        provider.activeModelId = option.modelId;
        provider.model = option.apiModel;
        provider.contextTokenLimit = option.contextTokenLimit ?? null;
        provider.maxOutputTokens = option.maxOutputTokens ?? null;
      }
      notify.info(`模型已切换为 ${newModel}`);
    } catch { /* ignore */ }
  }
  showModelDropdown.value = false;
  if (clearComposer) closeSlashMenu();
  else slashSubView.value = null;
}

function toggleModelDropdown(): void {
  void loadProviders();
  showModelDropdown.value = !showModelDropdown.value;
  showModeDropdown.value = false;
  showHostDropdown.value = false;
  slashSubView.value = null;
}

async function selectComposerModel(providerId: string | null, modelId: string | null = null): Promise<void> {
  await selectModelFromSlash(providerId, modelId, false);
  showModelDropdown.value = false;
}

function hostForId(id: string): HostInfo | null {
  if (!id) return null;
  return hosts.value.find((host) => host.id === id) || null;
}

function normalizeWorkspaceHostIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'all' && id !== '*')));
}

function workspaceHostIdsFromInput(value?: string | string[]): string[] {
  return Array.isArray(value) ? normalizeWorkspaceHostIds(value) : normalizeWorkspaceHostIds(value ? [value] : []);
}

function workspacePrimaryHostId(ids: string[]): string {
  return ids.length === 1 ? ids[0] : '';
}

function workspaceEquals(a: string[], b: string[]): boolean {
  const left = normalizeWorkspaceHostIds(a).slice().sort();
  const right = normalizeWorkspaceHostIds(b).slice().sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function workspaceHosts(ids: string[]): HostInfo[] {
  const allowed = new Set(normalizeWorkspaceHostIds(ids));
  return hosts.value.filter((host) => allowed.has(host.id));
}

function workspaceLabel(ids: string[]): string {
  const normalized = normalizeWorkspaceHostIds(ids);
  if (!normalized.length) return '全局';
  const names = normalized.map((id) => hostForId(id)?.name || (id === LOCAL_HOST_ID ? '本机' : id));
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} +${names.length - 2}`;
}

function workspaceContextHosts(ids: string[]): Array<{ id: string; name?: string; host?: string }> | undefined {
  const items = workspaceHosts(ids).map((host) => ({ id: host.id, name: host.name, host: host.host }));
  return items.length ? items : undefined;
}

function toolPolicyForWorkspace(hostIds: string[]): Record<string, unknown> {
  const ids = normalizeWorkspaceHostIds(hostIds);
  if (!ids.length) {
    return {
      source: 'agent_workspace',
      gatewayMode: 'execute',
      allowedHosts: ['*'],
    };
  }
  return {
    source: 'agent_workspace',
    gatewayMode: 'execute',
    allowedHosts: ids,
  };
}

function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): AgentRuntime {
  const initialWorkspaceHostIds = normalizeWorkspaceHostIds(
    options.workspaceHostIds !== undefined ? options.workspaceHostIds : (options.hostId ? [options.hostId] : []),
  );
  const runtimeWorkspaceHostIds = ref<string[]>(initialWorkspaceHostIds);
  const runtimeHostId = ref(workspacePrimaryHostId(initialWorkspaceHostIds));
  const runtimeAgentId = ref(normalizeAgentId(options.agentId));
  const runtimeCwd = ref(String(options.cwd || '').trim());
  const runtimeProtocolSettings = ref<ProtocolSessionSettings>(normalizeProtocolSettings(options.settings));
  const touchedAt = ref(new Date().toISOString());

  const ideApi = useIdeChat({
    sessionPrefix: 'agent',
    approvalMode: () => approvalMode.value,
    context: () => {
      const workspaceIds = normalizeWorkspaceHostIds(runtimeWorkspaceHostIds.value);
      return {
        surface: 'agent',
        module: 'Agent',
        moduleHint: '当前在 1Shell Agent 专用前端。',
        agentGoal: agentGoalObjective(agentGoal.value) || undefined,
        threadGoal: serializeAgentGoal(agentGoal.value),
        hostScope: workspaceIds.length ? workspaceIds.join(',') : 'all',
        workspaceHostIds: workspaceIds,
        toolPolicy: toolPolicyForWorkspace(workspaceIds),
        modelPreference: modelPreference.value !== '默认模型' ? modelPreference.value : undefined,
        hosts: workspaceContextHosts(workspaceIds),
      };
    },
    messagePayload: () => {
      // 协议 agent 会话：后端 registerIdeSocketHandlers 按 agentId 分流到
      // protocolAgentService。目标 VPS + 运行设置（审批/思考程度/fast）
      // 每条消息都带最新值，中途切换 agent 也走这里的 agentId。
      if (isProtocolAgentId(runtimeAgentId.value)) {
        const workspaceIds = normalizeWorkspaceHostIds(runtimeWorkspaceHostIds.value);
        return {
          agentId: runtimeAgentId.value,
          cwd: runtimeCwd.value || undefined,
          workspaceHostIds: workspaceIds,
          hosts: workspaceContextHosts(workspaceIds),
          settings: { ...runtimeProtocolSettings.value },
          attachments: attachmentPayload(),
        };
      }
      return {
        // 显式声明归属：会话可能刚从协议 agent 切回 1Shell AI，路由层据此
        // 让协议侧交还会话（杀进程 + 翻转记录归属）
        agentId: ONESHELL_AGENT_ID,
        entry: 'core',
        approvalMode: approvalMode.value,
        goal: agentGoalObjective(agentGoal.value) || undefined,
        goalStatus: serializeAgentGoal(agentGoal.value)?.status,
        threadGoal: serializeAgentGoal(agentGoal.value),
        hostId: runtimeHostId.value || undefined,
        workspaceHostIds: normalizeWorkspaceHostIds(runtimeWorkspaceHostIds.value),
        modelPreference: modelPreference.value !== '默认模型' ? modelPreference.value : undefined,
        attachments: attachmentPayload(),
      };
    },
    onRunComplete: () => {
      touchedAt.value = new Date().toISOString();
      rememberRuntimeSession(runtime);
      void refreshRuntimeProjection(runtime);
    },
  });

  const runtime: AgentRuntime = {
    ide: ideApi,
    hostId: runtimeHostId,
    workspaceHostIds: runtimeWorkspaceHostIds,
    agentId: runtimeAgentId,
    cwd: runtimeCwd,
    protocolSettings: runtimeProtocolSettings,
    createdAt: touchedAt.value,
    touchedAt,
    stopWatchers: [],
  };

  runtime.stopWatchers.push(watch(() => ideApi.currentSessionId.value, (nextId, previousId) => {
    if (activeRuntimeId.value === previousId) activeRuntimeId.value = nextId;
    touchedAt.value = new Date().toISOString();
    rememberRuntimeSession(runtime);
  }));
  runtime.stopWatchers.push(watch(() => ideApi.timeline.value.length, () => {
    touchedAt.value = new Date().toISOString();
    rememberRuntimeSession(runtime);
  }));

  runtimes.value = [...runtimes.value, runtime];
  if (options.session) ideApi.loadSession(options.session);
  activateRuntime(runtime);
  return runtime;
}

function activateRuntime(runtime: AgentRuntime): void {
  activeRuntimeId.value = runtime.ide.currentSessionId.value;
  selectedHostId.value = runtime.hostId.value || '';
  selectedWorkspaceHostIds.value = normalizeWorkspaceHostIds(runtime.workspaceHostIds.value);
  fileFocus.value = null;
  filePanelFile.value = null;
  showFilesDropdown.value = false;
  lastToolFocusKey = '';
  follow = true;
  syncRailFromTimeline();
  rememberRuntimeSession(runtime);
  scrollToBottom(true);
}

function findRuntimeBySessionId(id: string): AgentRuntime | null {
  return runtimes.value.find((runtime) => runtime.ide.currentSessionId.value === id) || null;
}

function disposeRuntime(runtime: AgentRuntime): void {
  runtime.stopWatchers.forEach((stop) => stop());
  runtime.ide.dispose();
}

const ide = new Proxy({} as IdeChatApi, {
  get(_target, key: keyof IdeChatApi) {
    const runtime = activeRuntime.value;
    if (!runtime) throw new Error('Agent runtime 尚未初始化');
    return runtime.ide[key];
  },
});

createAgentRuntime();

// ── session history rail ──
interface SessionMeta {
  id: string;
  title: string;
  entry: string;
  hostId: string;
  workspaceHostIds?: string[];
  modelLabel: string;
  messageCount: number;
  preview: string;
  agentId?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
  awaitingApproval?: boolean;
}
const sessions = ref<SessionMeta[]>([]);
const sessionsLoading = ref(false);
const railSessions = computed<SessionMeta[]>(() => {
  const rows = new Map<string, SessionMeta>();
  for (const session of sessions.value) rows.set(session.id, session);

  for (const runtime of runtimes.value) {
    const id = runtime.ide.currentSessionId.value;
    const timeline = runtime.ide.timeline.value;
    if (!id || (!timeline.length && !runtime.ide.isRunning.value)) continue;
    const existing = rows.get(id);
    rows.set(id, {
      id,
      title: existing?.title || liveSessionTitle(runtime),
      entry: existing?.entry || 'core',
      hostId: runtime.hostId.value || existing?.hostId || '',
      workspaceHostIds: normalizeWorkspaceHostIds(runtime.workspaceHostIds.value),
      modelLabel: existing?.modelLabel || (isProtocolAgentId(runtime.agentId.value) ? agentNameFor(runtime.agentId.value) : modelText.value),
      messageCount: timeline.length || existing?.messageCount || 0,
      preview: liveSessionPreview(runtime) || existing?.preview || '',
      agentId: normalizeAgentId(runtime.agentId.value || existing?.agentId),
      cwd: runtime.cwd.value || existing?.cwd || '',
      createdAt: existing?.createdAt || runtime.createdAt,
      updatedAt: runtime.touchedAt.value || existing?.updatedAt || runtime.createdAt,
      running: runtime.ide.isRunning.value,
      awaitingApproval: Boolean(runtime.ide.approveRequest.value),
    });
  }

  return [...rows.values()].sort((a, b) => parseSessionTime(b.updatedAt) - parseSessionTime(a.updatedAt));
});

function liveSessionTitle(runtime: AgentRuntime): string {
  const firstUser = runtime.ide.timeline.value.find((item): item is IdeChatMessage => item.kind === 'user');
  const text = firstUser?.text?.split('\n').find(Boolean)?.trim() || '';
  if (text) return text.slice(0, 60);
  return '新对话';
}

function liveSessionPreview(runtime: AgentRuntime): string {
  const latest = runtime.ide.timeline.value.slice().reverse().find((item) => {
    return item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool';
  });
  if (!latest) return runtime.ide.isRunning.value ? '运行中' : '';
  if (latest.kind === 'tool') return `${latest.name} · ${latest.status}`;
  return latest.text?.replace(/\s+/g, ' ').trim().slice(0, 120) || '';
}

function parseSessionTime(value: string): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    const resp = await requestJson<{ ok: boolean; sessions: SessionMeta[] }>('/api/agent/sessions');
    if (resp.ok) {
      sessions.value = resp.sessions || [];
      await restoreInitialSession(sessions.value);
    }
  } catch { /* ignore */ } finally {
    sessionsLoading.value = false;
  }
}

function waitForSessionProjection(attempt: number): Promise<void> {
  const delays = [140, 320, 700];
  return new Promise((resolve) => window.setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)]));
}

async function refreshRuntimeProjection(runtime: AgentRuntime, attempt = 0): Promise<void> {
  const sessionId = runtime.ide.currentSessionId.value;
  const currentLength = runtime.ide.timeline.value.length;
  if (!sessionId || runtime.ide.isRunning.value) return;
  // 刷新窗口内用户可能刚点了切换 agent / 改了 cwd：请求返回后只在用户没
  // 动过的情况下才用记录值回写，避免把切换选择静默还原
  const agentIdBefore = normalizeAgentId(runtime.agentId.value);
  const cwdBefore = String(runtime.cwd.value || '').trim();

  try {
    await waitForSessionProjection(attempt);
    if (runtime.ide.currentSessionId.value !== sessionId || runtime.ide.isRunning.value) return;

    const resp = await requestJson<{ ok: boolean; session: { id: string; entry: string; hostId: string; workspaceHostIds?: string[]; agentId?: string; cwd?: string; timeline: IdeTimelineItem[]; running?: boolean; runId?: string } }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}`);
    const projected = resp.session?.timeline || [];
    if (!resp.ok || !resp.session) {
      if (attempt < 2) await refreshRuntimeProjection(runtime, attempt + 1);
      return;
    }
    if (projected.length < currentLength) {
      if (attempt < 2) await refreshRuntimeProjection(runtime, attempt + 1);
      return;
    }
    if (runtime.ide.currentSessionId.value !== sessionId || runtime.ide.isRunning.value) return;

    const workspaceIds = normalizeWorkspaceHostIds(resp.session.workspaceHostIds || (resp.session.hostId ? [resp.session.hostId] : []));
    runtime.hostId.value = workspacePrimaryHostId(workspaceIds);
    runtime.workspaceHostIds.value = workspaceIds;
    if (normalizeAgentId(runtime.agentId.value) === agentIdBefore) {
      runtime.agentId.value = normalizeAgentId(resp.session.agentId);
    }
    if (String(runtime.cwd.value || '').trim() === cwdBefore) {
      runtime.cwd.value = String(resp.session.cwd || '').trim();
    }
    runtime.ide.loadSession({
      id: resp.session.id,
      timeline: projected,
      running: Boolean(resp.session.running),
      runId: resp.session.runId || '',
    });
    if (resp.session.running) void runtime.ide.reattachSession();
  } catch {
    if (attempt < 2) {
      await refreshRuntimeProjection(runtime, attempt + 1);
      return;
    }
  } finally {
    if (attempt === 0) void loadSessions();
  }
}

async function restoreInitialSession(rows: SessionMeta[]): Promise<void> {
  if (initialSessionRestoreAttempted) return;
  initialSessionRestoreAttempted = true;
  const runtime = activeRuntime.value;
  if (!runtime || runtime.ide.isRunning.value || runtime.ide.timeline.value.length > 0) return;

  const storedId = readStoredActiveSessionId();
  if (storedId && await onSelectSession(storedId)) return;
  const latest = rows[0]?.id || '';
  if (latest && latest !== storedId) await onSelectSession(latest);
}

async function onSelectSession(id: string): Promise<boolean> {
  if (id === ide.currentSessionId.value) return true;
  const liveRuntime = findRuntimeBySessionId(id);
  if (liveRuntime) {
    activateRuntime(liveRuntime);
    return true;
  }
  try {
    const resp = await requestJson<{ ok: boolean; session: { id: string; entry: string; hostId: string; workspaceHostIds?: string[]; agentId?: string; cwd?: string; settings?: Partial<ProtocolSessionSettings>; timeline: IdeTimelineItem[]; running?: boolean; runId?: string } }>(`/api/agent/sessions/${id}`);
    if (!resp.ok || !resp.session) return false;
    fileFocus.value = null;
    lastToolFocusKey = '';
    composerAttachments.value = [];
    attachmentError.value = '';
    const runtime = createAgentRuntime({
      hostId: resp.session.hostId || '',
      workspaceHostIds: normalizeWorkspaceHostIds(resp.session.workspaceHostIds || (resp.session.hostId ? [resp.session.hostId] : [])),
      agentId: resp.session.agentId || '',
      cwd: resp.session.cwd || '',
      settings: resp.session.settings || null,
      session: {
        id: resp.session.id,
        timeline: resp.session.timeline || [],
        running: Boolean(resp.session.running),
        runId: resp.session.runId || '',
      },
    });
    if (resp.session.running) void runtime.ide.reattachSession();
    follow = true;
    scrollToBottom(true);
    return true;
  } catch { return false; }
}

function onNewSession(
  workspaceInput: string | string[] = selectedWorkspaceHostIds.value,
  agentOptions: { agentId?: string; cwd?: string } = {},
): void {
  const runtime = activeRuntime.value;
  const agentId = normalizeAgentId(agentOptions.agentId);
  const cwd = isProtocolAgentId(agentId) ? String(agentOptions.cwd || '').trim() : '';
  // 协议 agent 会话运行在本机工作目录上，目标 VPS 通过 1Shell MCP 操作
  const workspaceIds = workspaceHostIdsFromInput(workspaceInput);
  const normalizedHostId = workspacePrimaryHostId(workspaceIds);
  if (runtime && !runtime.ide.isRunning.value && runtime.ide.timeline.value.length === 0) {
    runtime.hostId.value = normalizedHostId;
    runtime.workspaceHostIds.value = workspaceIds;
    runtime.agentId.value = agentId;
    runtime.cwd.value = cwd;
    runtime.protocolSettings.value = normalizeProtocolSettings(null);
    selectedHostId.value = normalizedHostId;
    selectedWorkspaceHostIds.value = workspaceIds;
  } else {
    createAgentRuntime({ hostId: normalizedHostId, workspaceHostIds: workspaceIds, agentId, cwd });
  }
  fileFocus.value = null;
  lastToolFocusKey = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}

async function onRenameSession(id: string, title: string): Promise<void> {
  const target = sessions.value.find((s) => s.id === id);
  if (target) target.title = title; // optimistic
  try {
    await requestJson(`/api/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
  } catch { void loadSessions(); }
}

async function onCopySession(id: string): Promise<void> {
  const runtime = findRuntimeBySessionId(id);
  if (runtime?.ide.isRunning.value) {
    notify.info('这条 Agent 对话仍在运行，请结束后再复制。');
    return;
  }
  try {
    const resp = await requestJson<{ ok: boolean; session: SessionMeta }>(`/api/agent/sessions/${encodeURIComponent(id)}/copy`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!resp.ok || !resp.session?.id) throw new Error('复制失败');
    sessions.value = [resp.session, ...sessions.value.filter((s) => s.id !== resp.session.id)];
    notify.success('对话已复制');
    await onSelectSession(resp.session.id);
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
    void loadSessions();
  }
}

async function onDeleteSession(id: string): Promise<void> {
  const runtime = findRuntimeBySessionId(id);
  if (runtime?.ide.isRunning.value) {
    notify.info('这条 Agent 对话仍在运行，请先停止后再删除。');
    return;
  }
  const wasActive = id === ide.currentSessionId.value;
  const ok = await confirm({ message: '删除这个对话？此操作不可恢复。', title: '删除对话' });
  if (!ok) return;
  try {
    await requestJson(`/api/agent/sessions/${id}`, { method: 'DELETE' });
  } catch { /* ignore */ }
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (readStoredActiveSessionId() === id) storeActiveSessionId('');
  if (runtime) {
    disposeRuntime(runtime);
    runtimes.value = runtimes.value.filter((item) => item !== runtime);
  }
  if (wasActive) {
    if (!runtimes.value.length) createAgentRuntime({ workspaceHostIds: selectedWorkspaceHostIds.value });
    else activateRuntime(runtimes.value[0]);
  }
  fileFocus.value = null;
  lastToolFocusKey = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}

const goalText = computed(() => formatAgentGoalLabel(agentGoal.value));
const hostText = computed(() => workspaceLabel(selectedWorkspaceHostIds.value));
const modelText = computed(() => {
  const active = findModelOption(activeProviderId.value, activeModelId.value);
  return active?.label || modelPreference.value;
});
const modelChannel = computed(() => {
  const active = findModelOption(activeProviderId.value, activeModelId.value);
  return active?.providerName || '';
});
const modeBadge = computed(() => {
  switch (approvalMode.value) {
    case 'delegated': return { label: '委托', cls: 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/20' };
    case 'full_access': return { label: '完全', cls: 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400 border-red-300 dark:border-red-500/20' };
    default: return { label: '手动', cls: 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-500/20' };
  }
});
const hasTimeline = computed(() => ide.timeline.value.length > 0);
const isBusy = computed(() => ide.isRunning.value);
const canSubmitComposer = computed(() => {
  // 终端模式：agent 忙不影响发命令
  if (isTerminalMode.value) return Boolean(composerInput.value.trim());
  if (isBusy.value) return false;
  if (isGoalComposerMode.value) return Boolean(composerInput.value.trim());
  return Boolean(composerInput.value.trim() || composerAttachments.value.length);
});

const modes: { key: IdeApprovalMode; label: string }[] = [
  { key: 'manual', label: '手动审批' },
  { key: 'delegated', label: '委托审批' },
  { key: 'full_access', label: '完全访问' },
];

function syncRailLayout(): void {
  const isMobile = window.matchMedia('(max-width: 900px)').matches;
  mobileRailLayout.value = isMobile;
  if (isMobile && !railAutoCollapsed && !railCollapsed.value) {
    railCollapsed.value = true;
    railAutoCollapsed = true;
  } else if (!isMobile && railAutoCollapsed) {
    railCollapsed.value = false;
    railAutoCollapsed = false;
  }
}

function toggleRail(): void {
  railCollapsed.value = !railCollapsed.value;
  railAutoCollapsed = false;
}

function closeRailOnMobile(): void {
  if (mobileRailLayout.value) railCollapsed.value = true;
}

async function onRailSelectSession(id: string): Promise<void> {
  const ok = await onSelectSession(id);
  if (ok) closeRailOnMobile();
}

function openNewSessionModal(): void {
  newSessionHostDraft.value = [];
  newSessionAgentDraft.value = ONESHELL_AGENT_ID;
  newSessionCwdDraft.value = '';
  void loadProtocolAgents();
  newSessionModalOpen.value = true;
  showHostDropdown.value = false;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
}

function closeNewSessionModal(): void {
  newSessionModalOpen.value = false;
}

function pickNewSessionAgent(agentId: string): void {
  newSessionAgentDraft.value = normalizeAgentId(agentId);
}

const newSessionIsProtocol = computed(() => isProtocolAgentId(newSessionAgentDraft.value));

function toggleNewSessionHost(id: string): void {
  const hostId = String(id || '').trim();
  if (!hostId) return;
  const set = new Set(newSessionHostDraft.value);
  if (set.has(hostId)) set.delete(hostId);
  else set.add(hostId);
  newSessionHostDraft.value = Array.from(set);
}

function confirmNewSession(): void {
  onNewSession(newSessionHostDraft.value, {
    agentId: newSessionAgentDraft.value,
    cwd: newSessionCwdDraft.value,
  });
  closeNewSessionModal();
  closeRailOnMobile();
}

function onRailNewSession(): void {
  openNewSessionModal();
}

// 文件页「以此目录新建会话」：预填工作目录并预选第一个已安装协议 agent
function onRailNewSessionAt(path: string): void {
  openNewSessionModal();
  newSessionCwdDraft.value = String(path || '').trim();
  const firstInstalled = installedProtocolAgents.value[0];
  if (firstInstalled) newSessionAgentDraft.value = firstInstalled.id;
}

const FILE_TOOL_ACTIONS: Record<string, string> = {
  list_remote_dir: '列出目录',
  read_remote_file: '读取文件',
  write_remote_file: '写入文件',
  create_directory: '创建目录',
  delete_path: '删除路径',
  rename_path: '重命名路径',
  upload_file: '上传文件',
  download_file: '下载文件',
};

const HOST_TOOL_NAMES = new Set([
  'execute_command',
  'host_exec',
  'run_script',
  'query_probe',
  'get_probe',
  'get_probe_samples',
  'get_probe_timeseries',
  'get_probe_traffic',
  'install_probe_agent',
  'restart_probe_agent',
  'uninstall_probe_agent',
  'probe_diag_ping',
  'probe_diag_http',
  'probe_diag_dns',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parentDirectory(path: string): string {
  const text = String(path || '').trim();
  if (!text) return '';
  const normalized = text.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized.startsWith('/') ? '/' : '';
  return normalized.slice(0, idx);
}

function basename(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized.split('/').pop() || normalized;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function focusFromTool(tool: IdeToolTimelineItem): FileFocus | null {
  if (!isRecord(tool.input)) return null;
  const hostId = stringField(tool.input, 'hostId') || LOCAL_HOST_ID;
  const toolName = tool.name;

  if (toolName === 'list_remote_dir') {
    const directory = stringField(tool.input, 'path');
    return {
      hostId,
      path: directory,
      directory,
      toolName,
      action: FILE_TOOL_ACTIONS[toolName],
      status: tool.status,
    };
  }

  if (toolName === 'create_directory') {
    const path = stringField(tool.input, 'path');
    return {
      hostId,
      path,
      directory: parentDirectory(path),
      fileName: basename(path),
      toolName,
      action: FILE_TOOL_ACTIONS[toolName],
      status: tool.status,
    };
  }

  if (toolName === 'upload_file') {
    const directory = stringField(tool.input, 'dirPath');
    const filename = stringField(tool.input, 'filename') || basename(stringField(tool.input, 'localPath'));
    const path = filename ? joinPath(directory, filename) : directory;
    return {
      hostId,
      path,
      directory,
      fileName: filename || undefined,
      toolName,
      action: FILE_TOOL_ACTIONS[toolName],
      status: tool.status,
    };
  }

  const path = toolName === 'rename_path'
    ? stringField(tool.input, 'newPath') || stringField(tool.input, 'path')
    : stringField(tool.input, 'path');
  if (!path || !FILE_TOOL_ACTIONS[toolName]) return null;
  const directory = parentDirectory(path);
  return {
    hostId,
    path,
    directory,
    fileName: basename(path),
    toolName,
    action: FILE_TOOL_ACTIONS[toolName],
    status: tool.status,
  };
}

// 本会话涉及的文件：从时间线工具卡的 locations 聚合（live 与重载天然一致），
// 最近触碰的排最前。仅协议 agent 会话会产出 locations。
const sessionFiles = computed<IdeFileLocation[]>(() => {
  const seen = new Map<string, IdeFileLocation>();
  for (const item of ide.timeline.value) {
    if (item.kind !== 'tool') continue;
    const locations = (item as IdeToolTimelineItem).locations;
    if (!Array.isArray(locations)) continue;
    for (const loc of locations) {
      if (!loc?.path) continue;
      seen.delete(loc.path);
      seen.set(loc.path, loc);
    }
  }
  return [...seen.values()].reverse();
});

// 点击工具卡上的文件路径：桌面端打开右栏文件面板（CodeMirror 编辑/预览）；
// 移动端没有右栏空间，退回左栏文件页定位（协议 agent 的文件都在本机）
function openToolFile(location: IdeFileLocation): void {
  const path = String(location?.path || '').trim();
  if (!path) return;
  if (!mobileRailLayout.value) {
    filePanelFile.value = { path, line: location.line };
    return;
  }
  railCollapsed.value = false;
  railTab.value = 'files';
  fileFocus.value = {
    hostId: LOCAL_HOST_ID,
    path,
    directory: parentDirectory(path),
    fileName: basename(path),
    action: 'Agent 文件操作',
    status: 'done',
    updatedAt: Date.now(),
  };
}

function syncRailFromTimeline(): void {
  const tools = ide.timeline.value.filter((item): item is IdeToolTimelineItem => item.kind === 'tool').slice().reverse();
  const latestHostTool = tools.find((tool) => isRecord(tool.input) && stringField(tool.input, 'hostId'));
  if (latestHostTool && isRecord(latestHostTool.input)) {
    const hostId = stringField(latestHostTool.input, 'hostId');
    if (hostId && hostId !== 'all') selectedHostId.value = hostId;
  }

  const latestFocus = tools.map(focusFromTool).find((focus): focus is FileFocus => Boolean(focus));
  if (latestFocus) {
    const key = `${latestFocus.hostId}:${latestFocus.toolName}:${latestFocus.status}:${latestFocus.path}:${latestFocus.directory}:${latestFocus.fileName || ''}`;
    if (key !== lastToolFocusKey) {
      lastToolFocusKey = key;
      selectedHostId.value = latestFocus.hostId;
      railTab.value = 'files';
      fileFocus.value = { ...latestFocus, updatedAt: Date.now() };
    }
    return;
  }

  if (latestHostTool && isRecord(latestHostTool.input) && HOST_TOOL_NAMES.has(latestHostTool.name)) {
    const hostId = stringField(latestHostTool.input, 'hostId');
    const key = `${hostId}:${latestHostTool.name}:${latestHostTool.status}`;
    if (hostId && hostId !== 'all' && key !== lastToolFocusKey) {
      lastToolFocusKey = key;
      railTab.value = 'files';
      fileFocus.value = {
        hostId,
        path: '',
        directory: '',
        toolName: latestHostTool.name,
        action: latestHostTool.name === 'run_script' ? '运行脚本' : '主机操作',
        status: latestHostTool.status,
        updatedAt: Date.now(),
      };
    }
  }
}

// ── lifecycle ──
watch(() => ide.timeline.value.length, () => { scrollToBottom(); });
watch(() => ide.timeline.value, () => {
  syncRailFromTimeline();
  scrollToBottom();
}, { deep: true });
onMounted(() => {
  syncRailLayout();
  window.addEventListener('resize', syncRailLayout);
  void loadHosts().then(() => {
    activateQueryHost();
    // 上次离开时是终端模式 → 恢复连接
    if (workMode.value === 'terminal') ensureTerminalStarted();
  });
  void loadProviders();
  void loadProtocolAgents();
  void loadSessions();
});
onActivated(() => {
  void loadHosts().then(() => activateQueryHost());
});
watch(() => route.query.host, () => {
  activateQueryHost();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncRailLayout);
  for (const runtime of runtimes.value) disposeRuntime(runtime);
  runtimes.value = [];
});

interface ConsoleHostsResponse {
  hosts?: MainHost[];
  warnings?: { usingFallbackSecret?: boolean };
}

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<ConsoleHostsResponse>('/api/hosts/console');
    hostsStore.setHosts(data.hosts || []);
    hostsStore.setSecretWarning(Boolean(data.warnings?.usingFallbackSecret));
    if (!hostsStore.hostMap.has(termHostId.value)) {
      termHostId.value = LOCAL_HOST_ID;
    }
  } catch { /* ignore */ }
}

async function loadProviders(): Promise<void> {
  try {
    const resp = await requestJson<{ ok: boolean; providers: AgentProvider[]; activeProviderId: string | null; activeRoute?: AgentProviderRoute | null }>('/api/agent/providers/skills');
    if (resp.ok) {
      providers.value = resp.providers || [];
      activeProviderId.value = resp.activeRoute?.providerId || resp.activeProviderId;
      const active = providers.value.find(p => p.id === activeProviderId.value);
      activeModelId.value = resp.activeRoute?.modelId || active?.routeModelId || active?.activeModelId || null;
      const option = findModelOption(activeProviderId.value, activeModelId.value);
      if (option) modelPreference.value = option.label;
      else if (active) modelPreference.value = active.model;
    }
  } catch { /* ignore */ }
}

// ── scroll ──
function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  follow = isNearScrollBottom(el);
}
function scrollToBottom(force = false): void {
  const el = scrollEl.value;
  const wasPinned = force || (follow && (!el || isNearScrollBottom(el)));
  if (force) follow = true;
  void nextTick(() => {
    scrollToBottomIfPinned(scrollEl.value, wasPinned);
  });
}

// ── actions ──
function makeAttachmentId(): string {
  return `att-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isTextAttachment(file: File): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith('text/')) return true;
  return /\.(txt|md|markdown|json|jsonl|yaml|yml|toml|ini|conf|config|env|log|csv|tsv|xml|html|css|scss|js|ts|tsx|jsx|vue|py|sh|bash|ps1|sql|dockerfile|gitignore)$/i.test(name);
}

function attachmentKind(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (isTextAttachment(file)) return 'text';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'document';
  return 'file';
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

function dataUrlBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

async function buildAttachment(file: File): Promise<ComposerAttachment> {
  const kind = attachmentKind(file);
  const base: ComposerAttachment = {
    id: makeAttachmentId(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    kind,
  };

  if (kind === 'text') {
    if (file.size > ATTACHMENT_MAX_TEXT_BYTES) {
      return { ...base, error: '文本文件过大，未展开内容' };
    }
    const text = await readAsText(file);
    return {
      ...base,
      text,
    };
  }

  if (kind === 'image' || kind === 'document' || kind === 'file') {
    if (file.size > ATTACHMENT_MAX_BINARY_BYTES) {
      return { ...base, error: '文件过大，仅发送文件名和大小' };
    }
    return { ...base, base64: dataUrlBase64(await readAsDataUrl(file)) };
  }

  return base;
}

function normalizedClipboardFile(file: File): File {
  if (file.name) return file;
  const ext = file.type === 'image/jpeg' ? 'jpg'
    : file.type === 'image/webp' ? 'webp'
      : file.type === 'image/gif' ? 'gif'
        : file.type === 'image/png' ? 'png'
          : 'bin';
  pastedImageSeq += 1;
  return new File([file], `pasted-image-${Date.now()}-${pastedImageSeq}.${ext}`, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
  });
}

// 单条消息 base64 总量护栏：socket.io maxHttpBufferSize 为 16MB，超限的
// 消息会被整条丢弃，这里提前把超出的附件降级为仅发送文件名
function attachmentsBinaryTotal(): number {
  return composerAttachments.value.reduce((sum, item) => sum + (item.base64 ? item.size : 0), 0);
}

async function addAttachmentFiles(rawFiles: File[], source = '选择'): Promise<void> {
  const files = rawFiles.map(normalizedClipboardFile);
  if (!files.length) return;
  attachmentError.value = '';
  const remaining = ATTACHMENT_MAX_COUNT - composerAttachments.value.length;
  if (remaining <= 0) {
    attachmentError.value = `最多附加 ${ATTACHMENT_MAX_COUNT} 个文件`;
    return;
  }

  for (const file of files.slice(0, remaining)) {
    try {
      const att = await buildAttachment(file);
      if (att.base64 && attachmentsBinaryTotal() + att.size > ATTACHMENT_MAX_BINARY_BYTES) {
        composerAttachments.value.push({ ...att, base64: undefined, error: '附件总大小超限，仅发送文件名和大小' });
      } else {
        composerAttachments.value.push(att);
      }
    } catch (err) {
      composerAttachments.value.push({
        id: makeAttachmentId(),
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        kind: attachmentKind(file),
        error: (err as Error).message || '读取失败',
      });
    }
  }
  if (files.length > remaining) attachmentError.value = `已达到 ${ATTACHMENT_MAX_COUNT} 个附件上限`;
  else if (source === '粘贴') notify.info(`已粘贴 ${files.length} 个附件`);
}

async function onAttachmentChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  await addAttachmentFiles(files, '选择');
}

function filesFromClipboard(event: ClipboardEvent): File[] {
  const clipboard = event.clipboardData;
  if (!clipboard) return [];
  const directFiles = Array.from(clipboard.files || []);
  const itemFiles = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const all = directFiles.length ? directFiles : itemFiles;
  const seen = new Set<string>();
  return all.filter((file) => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function onComposerPaste(event: ClipboardEvent): Promise<void> {
  if (isTerminalMode.value) return; // 终端模式：按普通文本粘贴，不收附件
  const files = filesFromClipboard(event);
  if (!files.length) return;
  event.preventDefault();
  await addAttachmentFiles(files, '粘贴');
}

function removeAttachment(id: string): void {
  composerAttachments.value = composerAttachments.value.filter((item) => item.id !== id);
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentPayload(): Record<string, unknown>[] {
  return composerAttachments.value.map((item) => ({
    name: item.name,
    size: item.size,
    mime: item.mime,
    kind: item.kind,
    base64: item.base64,
    text: item.text,
    error: item.error,
  }));
}

function send(): void {
  if (isTerminalMode.value) {
    sendToTerminal();
    return;
  }
  const t = composerInput.value.trim() ? composerInput.value.replace(/^(?:\r?\n)+|\s+$/g, '') : '';
  if (isBusy.value) return;
  if (isGoalComposerMode.value) {
    if (!t) return;
    applyAgentGoalCommand({ kind: 'goal', action: 'set', objective: t });
    composerMode.value = 'chat';
    composerInput.value = '';
    follow = true;
    return;
  }
  if (!t && !composerAttachments.value.length) return;
  if (t && composerAttachments.value.length === 0 && handleAgentGoalCommandText(t)) {
    composerInput.value = '';
    follow = true;
    return;
  }
  // 附件不再拼文字摘要进消息：路径提示由后端注入给模型/agent，
  // 对话里的回显走 ide:attachments 事件的缩略图/文件卡
  ide.inputText.value = t || '请分析附件。';
  follow = true;
  ide.sendMessage();
  composerInput.value = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}
function sendSlash(cmd: string): void {
  follow = true;
  ide.prefillAndSend(cmd);
}
function setGoal(): void {
  if (isGoalComposerMode.value) {
    void nextTick(() => composerInputEl.value?.focus());
    return;
  }
  openGoalComposer();
}
function handleAgentGoalCommandText(value: string): boolean {
  const command = parseAgentGoalCommand(value);
  if (!command) return false;
  if (command.action === 'show') {
    openGoalComposer();
    return true;
  }
  if (command.action === 'edit') {
    openGoalComposer(agentGoal.value.objective);
    return true;
  }
  applyAgentGoalCommand(command);
  return true;
}
function applyAgentGoalCommand(command: AgentGoalCommand): void {
  const result = reduceAgentGoalCommand(agentGoal.value, command);
  if (result.needsEditor) return openGoalComposer(agentGoal.value.objective);
  agentGoal.value = result.state;
  ide.pushSystemEvent(result.title, result.text, result.tone);
}
function pickHost(id: string): void {
  const workspaceIds = workspaceHostIdsFromInput(id);
  const normalizedHostId = workspacePrimaryHostId(workspaceIds);
  const runtime = activeRuntime.value;
  if (runtime?.ide.isRunning.value && !workspaceEquals(runtime.workspaceHostIds.value, workspaceIds)) {
    selectedHostId.value = normalizedHostId;
    selectedWorkspaceHostIds.value = workspaceIds;
    railTab.value = 'chat';
    onNewSession(workspaceIds);
    showHostDropdown.value = false;
    notify.info('已按主机打开新的 Agent 对话，原对话继续运行。');
    return;
  }
  selectedHostId.value = normalizedHostId;
  selectedWorkspaceHostIds.value = workspaceIds;
  if (runtime) {
    runtime.hostId.value = normalizedHostId;
    runtime.workspaceHostIds.value = workspaceIds;
  }
  fileFocus.value = null;
  lastToolFocusKey = '';
  showHostDropdown.value = false;
  // 协议会话：目标变化随下一条消息注入 prompt，不发 /host 系统消息
  if (!activeIsProtocolAgent.value) sendSlash(`/host ${id || 'all'}`);
}
function onRailSelectHost(id: string): void {
  const workspaceIds = workspaceHostIdsFromInput(id);
  const normalizedHostId = workspacePrimaryHostId(workspaceIds);
  const runtime = activeRuntime.value;
  if (runtime?.ide.isRunning.value && !workspaceEquals(runtime.workspaceHostIds.value, workspaceIds)) {
    selectedHostId.value = normalizedHostId;
    selectedWorkspaceHostIds.value = workspaceIds;
    railTab.value = 'chat';
    onNewSession(workspaceIds);
    notify.info('已按主机打开新的 Agent 对话，原对话继续运行。');
    return;
  }
  selectedHostId.value = normalizedHostId;
  selectedWorkspaceHostIds.value = workspaceIds;
  if (runtime) {
    runtime.hostId.value = normalizedHostId;
    runtime.workspaceHostIds.value = workspaceIds;
  }
  fileFocus.value = null;
  lastToolFocusKey = '';
  showHostDropdown.value = false;
}
function pickMode(m: IdeApprovalMode): void {
  approvalMode.value = m;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
}
async function clearChat(): Promise<void> {
  if (isBusy.value) {
    notify.info('当前 Agent 对话仍在运行，请先停止后再清空。');
    return;
  }
  const ok = await confirm({ message: '清空当前会话时间线？', title: '清空' });
  if (!ok) return;
  storeActiveSessionId('');
  ide.resetChat();
  fileFocus.value = null;
  lastToolFocusKey = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}
function rewindPointTime(point: IdeRewindPoint): string {
  const time = Date.parse(point.createdAt || '');
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m ago`;
  if (diff < day) return `${Math.max(1, Math.round(diff / hour))}h ago`;
  return `${Math.max(1, Math.round(diff / day))}d ago`;
}

function rewindPointHost(point: IdeRewindPoint): string {
  const id = String(point.hostId || '').trim();
  if (!id || id === 'all') return hostText.value;
  if (id === LOCAL_HOST_ID || id === 'local') return '本机';
  const host = hostForId(id);
  return host?.name || id;
}

function rewindPointText(point: IdeRewindPoint): string {
  return String(point.text || '').trim() || '(空输入)';
}

async function openRewindModal(): Promise<void> {
  if (isBusy.value) {
    notify.info('当前 Agent 仍在运行，请先停止或等待完成后再回溯。');
    return;
  }
  showHostDropdown.value = false;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
  slashSubView.value = null;
  rewindModalOpen.value = true;
  rewindLoading.value = true;
  rewindError.value = '';
  rewindPoints.value = [];
  rewindHighlight.value = 0;
  try {
    const points = await ide.listRewindPoints();
    rewindPoints.value = [...points].sort((a, b) => b.ordinal - a.ordinal);
    if (!rewindPoints.value.length) rewindError.value = '当前会话还没有可回溯的输入。发送一次 Agent 消息后，1Shell 会自动建立回溯点。';
  } catch (err) {
    rewindError.value = (err as Error).message || '无法加载回溯点';
  } finally {
    rewindLoading.value = false;
    void nextTick(() => rewindModalRef.value?.focus());
  }
}

function closeRewindModal(): void {
  rewindModalOpen.value = false;
  rewindLoading.value = false;
  rewindError.value = '';
}

function moveRewindHighlight(delta: number): void {
  if (!rewindPoints.value.length) return;
  const max = rewindPoints.value.length - 1;
  rewindHighlight.value = Math.min(max, Math.max(0, rewindHighlight.value + delta));
}

function runRewind(point = rewindPoints.value[rewindHighlight.value]): void {
  if (!point || isBusy.value) return;
  closeRewindModal();
  follow = true;
  ide.prefillAndSend(`/remind #${point.ordinal}`);
}

function onRewindModalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeRewindModal();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveRewindHighlight(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveRewindHighlight(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    runRewind();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (isTerminalMode.value) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToTerminal();
    }
    return;
  }
  if (isGoalComposerMode.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGoalComposer();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
  }
  if (showSlashMenu.value) {
    if (slashSubView.value === 'model') {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashSubHighlight.value = Math.min(slashSubHighlight.value + 1, enabledModelOptions.value.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashSubHighlight.value = Math.max(slashSubHighlight.value - 1, 0); return; }
      if (e.key === 'Enter') { e.preventDefault(); const idx = slashSubHighlight.value;
        if (idx === 0) { selectModelFromSlash(null); } else { const option = enabledModelOptions.value[idx - 1]; if (option) selectModelFromSlash(option.providerId, option.modelId); }
        return; }
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); slashSubView.value = null; slashHighlight.value = 0; return; }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); slashHighlight.value = Math.min(slashHighlight.value + 1, slashCmds.value.length - 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashHighlight.value = Math.max(slashHighlight.value - 1, 0); return; }
    if (e.key === 'Enter') { e.preventDefault(); selectSlashCmd(slashCmds.value[slashHighlight.value]); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
    if (e.key === 'Tab') { e.preventDefault(); composerInput.value = slashCmds.value[slashHighlight.value].cmd + ' '; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

// ── approval ──
function onSecretRefSubmit(secretRef: string): void {
  ide.approveCustomText.value = secretRef;
  ide.approveCustom();
}
</script>

<template>
  <div
    ref="shellEl"
    class="agent-view-shell flex h-full p-2 text-slate-800 dark:text-slate-200 transition-colors"
    :class="{ 'agent-view-shell--mobile-rail': mobileRailLayout, 'agent-view-shell--rail-open': !railCollapsed }"
  >
    <button
      v-if="mobileRailLayout && !railCollapsed"
      type="button"
      class="agent-view-rail-backdrop"
      aria-label="关闭侧栏"
      @click="railCollapsed = true"
    ></button>
    <AgentSessionRail
      v-if="!railCollapsed"
      class="agent-view-rail agent-view-panel"
      :sessions="railSessions"
      :active-id="ide.currentSessionId.value"
      :loading="sessionsLoading"
      v-model:active-tab="railTab"
      :hosts="hosts"
      :selected-host-id="selectedHostId"
      :file-focus="fileFocus"
      :console-hosts="hostsStore.items"
      :active-console-host-id="termHostId"
      :secret-warning="hostsStore.secretWarning"
      @select="onRailSelectSession"
      @new-session="onRailNewSession"
      @new-session-at="onRailNewSessionAt"
      @rename="onRenameSession"
      @copy="onCopySession"
      @delete="onDeleteSession"
      @select-host="onRailSelectHost"
      @host-connect="onHostConnect"
      @host-edit="onHostEdit"
      @host-delete="onHostDelete"
      @host-add="openAddHost"
      @host-new-session="onHostNewSession"
    />
    <div class="agent-view-main agent-view-panel flex flex-col flex-1 min-w-0 min-h-0 h-full" :class="{ 'agent-view-main--fullscreen': isTerminalMode && terminalFullscreen }">
    <!-- ── status bar（对话专属；终端模式下隐藏省空间） ── -->
    <header v-if="!isTerminalMode" class="agent-view-header shrink-0 flex items-center gap-3 px-6 h-12 border-b border-slate-200/80 dark:border-white/[0.06] bg-white/90 dark:bg-[#0d111b]/95 select-none">
      <button
        type="button"
        class="agent-view-rail-toggle"
        :title="railCollapsed ? '显示侧栏' : '隐藏侧栏'"
        :aria-pressed="!railCollapsed"
        @click="toggleRail"
      >
        <AppIcon :name="railCollapsed ? 'panel-left' : 'arrow-right'" :size="14" :class="railCollapsed ? '' : 'rotate-180'" />
      </button>
      <span class="text-[11px] font-semibold tracking-widest text-slate-500 dark:text-slate-400 uppercase">Agent</span>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-slate-400 dark:text-slate-500">目标</span>
        <button class="max-w-[180px] truncate text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer" @click="setGoal" :title="goalText">{{ goalText }}</button>
      </div>
      <span class="text-slate-300 dark:text-slate-700">·</span>
      <div class="relative">
        <button class="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer" @click="showHostDropdown = !showHostDropdown">{{ hostText }}</button>
        <div v-if="showHostDropdown" class="absolute top-full left-0 mt-1.5 w-52 bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-30 py-1 overflow-hidden">
          <button class="w-full text-left px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer" @click="pickHost('')">所有主机</button>
          <button v-for="h in hosts" :key="h.id" class="w-full text-left px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer" @click="pickHost(h.id)">{{ h.name }}</button>
        </div>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <span v-if="isBusy" class="text-[11px] text-sky-600 dark:text-sky-400/80 animate-pulse">运行中</span>
        <div v-if="sessionFiles.length" class="relative">
          <button class="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 transition-colors cursor-pointer" title="本会话涉及的文件" @click="showFilesDropdown = !showFilesDropdown">
            <AppIcon name="file" :size="13" />
            文件 {{ sessionFiles.length }}
          </button>
          <div v-if="showFilesDropdown" class="absolute top-full right-0 mt-1.5 w-72 max-h-80 overflow-y-auto bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-30 py-1">
            <button
              v-for="f in sessionFiles"
              :key="f.path"
              class="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer"
              :title="f.path"
              @click="openToolFile(f); showFilesDropdown = false"
            >
              <div class="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-200">
                <AppIcon name="file" :size="11" class="shrink-0 text-slate-400 dark:text-slate-500" />
                <span class="truncate">{{ basename(f.path) }}</span>
              </div>
              <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-600 truncate">{{ f.path }}</div>
            </button>
          </div>
        </div>
        <button v-if="hasTimeline" class="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 transition-colors cursor-pointer" @click="openRewindModal" title="回溯到某次输入">
          <AppIcon name="history" :size="13" />
          回溯
        </button>
        <button v-if="hasTimeline" class="text-xs text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer" @click="clearChat" title="清空时间线">清空</button>
      </div>
    </header>

    <!-- ── body ── -->
    <div class="agent-view-body flex-1 flex min-h-0 overflow-hidden">
      <!-- timeline -->
      <div v-show="!isTerminalMode" ref="scrollEl" class="flex-1 overflow-y-auto overflow-x-hidden" @scroll="onScroll">
        <!-- empty state -->
        <div v-if="!hasTimeline" class="flex flex-col items-center justify-center min-h-full py-16 px-6 text-center">
          <div class="w-14 h-14 rounded-2xl bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] shadow-sm flex items-center justify-center mb-5">
            <AppIcon name="message-circle" :size="27" class="text-slate-500 dark:text-slate-300" />
          </div>
          <h2 class="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">1Shell Agent</h2>
          <p class="text-sm text-slate-500 dark:text-slate-500 mb-8 max-w-sm">输入目标、命令或上下文，Agent 会调用工具并把过程留在这里。</p>
          <div class="grid grid-cols-2 gap-3 w-full max-w-[520px]">
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-white dark:bg-[#0f1624] border border-slate-200 dark:border-white/[0.07] rounded-xl hover:border-slate-300 dark:hover:border-white/[0.12] hover:shadow-sm transition-all duration-200 cursor-pointer group" @click="setGoal">
              <span class="w-9 h-9 rounded-lg bg-slate-100 dark:bg-white/[0.05] flex items-center justify-center shrink-0 group-hover:bg-sky-50 dark:group-hover:bg-sky-500/10 transition-colors"><AppIcon name="target" :size="18" class="text-slate-600 dark:text-slate-300 group-hover:text-sky-600 dark:group-hover:text-sky-300" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">设置目标</span>
            </button>
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-white dark:bg-[#0f1624] border border-slate-200 dark:border-white/[0.07] rounded-xl hover:border-slate-300 dark:hover:border-white/[0.12] hover:shadow-sm transition-all duration-200 cursor-pointer group" @click="showHostDropdown = true">
              <span class="w-9 h-9 rounded-lg bg-slate-100 dark:bg-white/[0.05] flex items-center justify-center shrink-0 group-hover:bg-sky-50 dark:group-hover:bg-sky-500/10 transition-colors"><AppIcon name="server" :size="18" class="text-slate-600 dark:text-slate-300 group-hover:text-sky-600 dark:group-hover:text-sky-300" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">选择主机</span>
            </button>
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-white dark:bg-[#0f1624] border border-slate-200 dark:border-white/[0.07] rounded-xl hover:border-slate-300 dark:hover:border-white/[0.12] hover:shadow-sm transition-all duration-200 cursor-pointer group" @click="toggleModelDropdown">
              <span class="w-9 h-9 rounded-lg bg-slate-100 dark:bg-white/[0.05] flex items-center justify-center shrink-0 group-hover:bg-sky-50 dark:group-hover:bg-sky-500/10 transition-colors"><AppIcon name="spark" :size="18" class="text-slate-600 dark:text-slate-300 group-hover:text-sky-600 dark:group-hover:text-sky-300" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">模型偏好</span>
            </button>
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-white dark:bg-[#0f1624] border border-slate-200 dark:border-white/[0.07] rounded-xl hover:border-slate-300 dark:hover:border-white/[0.12] hover:shadow-sm transition-all duration-200 cursor-pointer group" @click="showModeDropdown = true; showModelDropdown = false">
              <span class="w-9 h-9 rounded-lg bg-slate-100 dark:bg-white/[0.05] flex items-center justify-center shrink-0 group-hover:bg-sky-50 dark:group-hover:bg-sky-500/10 transition-colors"><AppIcon name="shield" :size="18" class="text-slate-600 dark:text-slate-300 group-hover:text-sky-600 dark:group-hover:text-sky-300" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">审批模式</span>
            </button>
          </div>
        </div>

        <!-- timeline items -->
        <div v-else class="max-w-[1020px] mx-auto px-6 py-7 space-y-5">
          <template v-for="(item, index) in ide.timeline.value" :key="item.id">
            <!-- user -->
            <div v-if="item.kind === 'user'" class="flex flex-col items-end gap-2">
              <div v-if="(item as IdeChatMessage).text" class="max-w-[76%] px-4 py-2.5 rounded-2xl rounded-br-md bg-slate-900 dark:bg-slate-100 border border-slate-900 dark:border-slate-100 text-sm leading-relaxed text-white dark:text-slate-900 shadow-sm whitespace-pre-wrap break-words">{{ (item as IdeChatMessage).text }}</div>
              <!-- 附件回显：图片=缩略图（点击放大灯箱），其余=文件卡，点击开右栏文件面板 -->
              <div v-if="(item as IdeChatMessage).attachments?.length" class="max-w-[76%] flex flex-wrap justify-end gap-2">
                <template v-for="(att, attIndex) in (item as IdeChatMessage).attachments" :key="`${item.id}-att-${attIndex}`">
                  <AttachmentThumb
                    v-if="att.kind === 'image' && att.path"
                    :path="att.path"
                    :host-id="LOCAL_HOST_ID"
                    :alt="att.name"
                  />
                  <button
                    v-else
                    type="button"
                    class="max-w-[240px] h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-[11px] transition-colors"
                    :class="att.error
                      ? 'border-amber-200 dark:border-amber-400/20 bg-amber-50 dark:bg-amber-400/8 text-amber-700 dark:text-amber-300 cursor-default'
                      : 'border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#0b0f19] text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/[0.16] cursor-pointer'"
                    :title="att.error ? `${att.name}：${att.error}` : `${att.name}${att.size ? ` · ${formatAttachmentSize(att.size)}` : ''}`"
                    @click="!att.error && att.path && openToolFile({ path: att.path })"
                  >
                    <AppIcon :name="att.error ? 'alert' : 'file'" :size="13" />
                    <span class="truncate">{{ att.name || '附件' }}</span>
                  </button>
                </template>
              </div>
            </div>

            <!-- thinking -->
            <div v-else-if="item.kind === 'thinking'" class="flex items-start gap-3 px-1">
              <span class="w-6 h-6 mt-0.5 rounded-full bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.07] flex items-center justify-center shrink-0"><AppIcon name="spark" :size="12" class="text-slate-400 dark:text-slate-500" /></span>
              <p class="text-[13px] text-slate-400 dark:text-slate-500 italic leading-relaxed">{{ (item as IdeThinkingTimelineItem).text }}</p>
            </div>

            <!-- system -->
            <div v-else-if="item.kind === 'system'" class="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/80 dark:bg-white/[0.035] border border-slate-200/80 dark:border-white/[0.06] text-xs">
              <span class="shrink-0 w-5 h-5 rounded-md flex items-center justify-center" :class="(item as IdeSystemTimelineItem).tone === 'success' ? 'bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300' : (item as IdeSystemTimelineItem).tone === 'warning' ? 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-400' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-500 dark:text-slate-400'"><AppIcon :name="(item as IdeSystemTimelineItem).tone === 'success' ? 'check' : (item as IdeSystemTimelineItem).tone === 'warning' ? 'alert' : 'terminal'" :size="12" /></span>
              <span class="text-slate-500 dark:text-slate-400"><strong class="text-slate-700 dark:text-slate-300">{{ (item as IdeSystemTimelineItem).title }}</strong> · {{ (item as IdeSystemTimelineItem).text }}</span>
            </div>

            <!-- tool -->
            <div v-else-if="item.kind === 'tool'" class="rounded-xl bg-white/90 dark:bg-[#0f1624] border cursor-pointer transition-all shadow-sm"
              :class="[(item as IdeToolTimelineItem).isError ? 'border-red-200 dark:border-red-500/20 hover:border-red-300 dark:hover:border-red-500/30' : (item as IdeToolTimelineItem).status === 'running' || (item as IdeToolTimelineItem).status === 'preparing' ? 'border-sky-200/90 dark:border-sky-500/20 hover:border-sky-300 dark:hover:border-sky-500/30' : 'border-slate-200/90 dark:border-white/[0.07] hover:border-slate-300 dark:hover:border-white/[0.12]', expandingToolId === (item as IdeToolTimelineItem).toolUseId ? 'border-slate-300 dark:border-white/[0.14] shadow-md' : '']"
              @click="expandingToolId = expandingToolId === (item as IdeToolTimelineItem).toolUseId ? null : (item as IdeToolTimelineItem).toolUseId">
              <div class="flex items-center gap-3 px-4 py-3.5">
                <span class="w-8 h-8 rounded-lg border flex items-center justify-center shrink-0"
                  :class="[(item as IdeToolTimelineItem).isError ? 'bg-red-50 dark:bg-red-400/10 border-red-100 dark:border-red-400/20 text-red-500 dark:text-red-400' : (item as IdeToolTimelineItem).status === 'running' || (item as IdeToolTimelineItem).status === 'preparing' ? 'bg-sky-50 dark:bg-sky-400/10 border-sky-100 dark:border-sky-400/20 text-sky-600 dark:text-sky-300' : 'bg-slate-50 dark:bg-white/[0.04] border-slate-200/80 dark:border-white/[0.07] text-slate-500 dark:text-slate-400']">
                  <AppIcon :name="toolIcon(item as IdeToolTimelineItem)" :size="15" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">{{ (item as IdeToolTimelineItem).name }}</span>
                    <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0"
                      :class="[(item as IdeToolTimelineItem).isError ? 'text-red-600 dark:text-red-400 border-red-200 dark:border-red-400/15 bg-red-50 dark:bg-red-400/5' : (item as IdeToolTimelineItem).status === 'done' ? 'text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.04]' : (item as IdeToolTimelineItem).status === 'running' ? 'text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-400/15 bg-sky-50 dark:bg-sky-400/5' : 'text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-400/15 bg-slate-50 dark:bg-slate-400/5']">
                      {{ toolLabel(item as IdeToolTimelineItem) }}
                    </span>
                  </div>
                  <div class="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                    <span v-if="toolDuration((item as IdeToolTimelineItem).durationMs)">{{ toolDuration((item as IdeToolTimelineItem).durationMs) }}</span>
                  </div>
                  <div v-if="toolFileLocations(item as IdeToolTimelineItem).length" class="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <button
                      v-for="loc in toolFileLocations(item as IdeToolTimelineItem)"
                      :key="loc.path"
                      type="button"
                      class="inline-flex items-center gap-1 max-w-[260px] px-1.5 py-0.5 rounded-md border border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.04] text-[11px] text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-300 hover:border-sky-300 dark:hover:border-sky-400/30 transition-colors cursor-pointer"
                      :title="loc.path"
                      @click.stop="openToolFile(loc)"
                    >
                      <AppIcon name="file" :size="11" class="shrink-0" />
                      <span class="truncate">{{ basename(loc.path) }}</span>
                    </button>
                  </div>
                </div>
                <AppIcon name="arrow-right" :size="14" class="text-slate-400 dark:text-slate-600 shrink-0 transition-transform duration-200" :class="expandingToolId === (item as IdeToolTimelineItem).toolUseId ? 'rotate-90' : ''" />
              </div>
              <div v-if="hasHostListResult(item as IdeToolTimelineItem)" class="px-4 pb-4" @click.stop>
                <HostListToolResult :result="(item as IdeToolTimelineItem).result" />
              </div>
              <div v-else-if="hasProbeListResult(item as IdeToolTimelineItem)" class="px-4 pb-4" @click.stop>
                <ProbeListToolResult :result="(item as IdeToolTimelineItem).result" />
              </div>
              <div v-if="expandingToolId === (item as IdeToolTimelineItem).toolUseId" class="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-white/[0.05] pt-3">
                <div v-if="toolEditDiffs(item as IdeToolTimelineItem).length" class="space-y-1.5" @click.stop>
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">改动</div>
                  <IdeEditDiff
                    v-for="(diff, di) in toolEditDiffs(item as IdeToolTimelineItem)"
                    :key="`${item.id}-diff-${di}`"
                    :old-text="diff.oldText"
                    :new-text="diff.newText"
                    :file-name="diff.path ? basename(diff.path) : ''"
                  />
                </div>
                <div v-if="(item as IdeToolTimelineItem).input !== undefined && (item as IdeToolTimelineItem).input !== null" class="space-y-1">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">参数</div>
                  <pre class="text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-[#090d15] border border-slate-200/70 dark:border-white/[0.05] rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[200px] overflow-y-auto">{{ fmtVal((item as IdeToolTimelineItem).input) }}</pre>
                </div>
                <div v-if="(item as IdeToolTimelineItem).logs.length" class="space-y-1">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">输出</div>
                  <pre v-for="(log, i) in (item as IdeToolTimelineItem).logs" :key="i" class="text-xs rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[260px] overflow-y-auto"
                    :class="log.stream === 'stderr' ? 'text-red-600 dark:text-red-300/80 bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-400/10' : 'text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-[#090d15] border border-slate-200/70 dark:border-white/[0.05]'">{{ log.text }}</pre>
                </div>
                <div v-if="!hasHostListResult(item as IdeToolTimelineItem) && !hasProbeListResult(item as IdeToolTimelineItem) && (item as IdeToolTimelineItem).result !== undefined && (item as IdeToolTimelineItem).result !== null" class="space-y-1">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">结果</div>
                  <pre class="text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-[#090d15] border border-slate-200/70 dark:border-white/[0.05] rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[240px] overflow-y-auto">{{ fmtVal((item as IdeToolTimelineItem).result) }}</pre>
                </div>
              </div>
            </div>

            <!-- assistant -->
            <div v-else class="flex items-start gap-3">
              <span class="w-7 h-7 mt-0.5 rounded-full bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] shadow-sm flex items-center justify-center shrink-0"><AppIcon name="spark" :size="13" class="text-slate-500 dark:text-slate-300" /></span>
              <div class="min-w-0 flex-1">
                <div v-if="assistantDisplayText(item as IdeChatMessage, index) && (item as IdeChatMessage).status === 'streaming'" class="text-sm leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words" v-text="assistantStreamingText(item as IdeChatMessage, index)"></div>
                <div v-else-if="assistantDisplayText(item as IdeChatMessage, index)" class="text-sm leading-relaxed text-slate-700 dark:text-slate-200 space-y-3 markdown-body agent-md" v-html="renderMarkdown(assistantDisplayText(item as IdeChatMessage, index), { tables: 'safe', inlineCode: 'plain' })"></div>
                <div v-else class="flex items-center gap-1.5 py-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-sky-400/60 animate-pulse"></span>
                  <span class="w-1.5 h-1.5 rounded-full bg-sky-400/60 animate-pulse" style="animation-delay: 0.15s"></span>
                  <span class="w-1.5 h-1.5 rounded-full bg-sky-400/60 animate-pulse" style="animation-delay: 0.3s"></span>
                </div>
              </div>
            </div>
          </template>

          <div v-if="isBusy" class="flex justify-center pt-2">
            <button class="px-4 py-1.5 rounded-full border border-red-200 dark:border-red-500/15 text-xs text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/5 transition-colors cursor-pointer" @click="ide.stop()">停止生成</button>
          </div>
        </div>
      </div>

      <!-- 终端（与时间线同一主区，composer 开关切换；首次进入终端模式才挂载） -->
      <div v-if="terminalStarted" v-show="isTerminalMode" class="flex-1 min-w-0 min-h-0 flex flex-col">
        <TerminalArea
          @host-change="onHostConnect"
          @fullscreen-toggle="onTerminalFullscreen"
          @open-host-selector="railTab = 'chat'; railCollapsed = false"
        />
      </div>

      <!-- file panel (M3 IDE 壳右栏；审批面板打开时隐藏但保留编辑状态) -->
      <AgentFilePanel
        v-if="filePanelFile && !mobileRailLayout && !isTerminalMode"
        v-show="!ide.approveRequest.value"
        class="w-[420px] shrink-0 min-h-0 h-full border-l border-slate-200 dark:border-white/[0.06]"
        :path="filePanelFile.path"
        :line="filePanelFile.line"
        :host-id="LOCAL_HOST_ID"
        :current-session-id="ide.currentSessionId.value"
        @close="filePanelFile = null"
        @open-session="onRailSelectSession"
      />

      <!-- approval sidebar -->
      <div v-if="ide.approveRequest.value" class="agent-approval-panel w-[380px] shrink-0 min-h-0 h-full border-l border-slate-200 dark:border-white/[0.06] bg-stone-50 dark:bg-[#0f1321] flex flex-col overflow-hidden">
        <IdeApprovalCard
          :request="ide.approveRequest.value"
          :custom-text="ide.approveCustomText.value"
          density="compact"
          @update:custom-text="(value) => { ide.approveCustomText.value = value; }"
          @allow="ide.approveAllow"
          @deny="ide.approveDeny"
          @custom="ide.approveCustom"
          @option="ide.approveOption"
          @secret-submit="onSecretRefSubmit"
        />
      </div>

    </div>

    <!-- ── composer ── -->
    <footer class="shrink-0 border-t border-slate-200/80 dark:border-white/[0.06] bg-white/90 dark:bg-[#0d111b]/95 relative">
      <!-- slash command menu -->
      <div v-if="showSlashMenu" class="absolute bottom-full left-0 right-0 max-w-[1020px] mx-auto px-6 pb-1 z-30">
        <div class="bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-xl shadow-2xl overflow-hidden">

          <!-- ── model sub-view ── -->
          <template v-if="slashSubView === 'model'">
            <button class="w-full text-left px-3 py-2 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer border-b border-slate-100 dark:border-white/[0.04]" @click="slashSubView = null; slashHighlight = 0">
              <AppIcon name="arrow-right" :size="12" class="rotate-180" />
              返回命令列表
            </button>
            <button class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer" :class="slashSubHighlight === 0 ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'" @click="selectModelFromSlash(null)">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="!activeProviderId ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
              <div class="min-w-0 flex-1">
                <span class="text-xs font-medium" :class="slashSubHighlight === 0 ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">默认模型</span>
                <span class="text-[10px] text-slate-400 dark:text-slate-600 ml-2">系统默认</span>
              </div>
            </button>
            <div v-if="enabledModelOptions.length" class="h-px bg-slate-100 dark:bg-white/[0.06] mx-3"></div>
            <button
              v-for="(option, i) in enabledModelOptions"
              :key="option.key"
              class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
              :class="(slashSubHighlight - 1) === i ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
              @click="selectModelFromSlash(option.providerId, option.modelId)"
            >
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="option.key === activeModelKey ? 'bg-sky-500 shadow-[0_0_6px_rgba(14,165,233,0.35)]' : 'bg-slate-300 dark:bg-slate-600'"></span>
              <div class="min-w-0 flex-1">
                <span class="text-xs font-medium" :class="(slashSubHighlight - 1) === i ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ option.label || '未指定模型' }}</span>
                <span class="text-[10px] text-slate-400 dark:text-slate-600 ml-2">{{ modelOptionMeta(option) }}</span>
              </div>
            </button>
            <div v-if="!enabledModelOptions.length" class="px-3 py-4 text-xs text-slate-400 dark:text-slate-600 text-center">
              暂无启用的模型接入 · <RouterLink to="/config/ai" class="text-sky-500 hover:underline">前往 AI 配置</RouterLink>
            </div>
          </template>

          <!-- ── command list ── -->
          <template v-if="!slashSubView">
            <div class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">命令</div>
            <button
              v-for="(cmd, i) in slashCmds"
              :key="cmd.cmd"
              type="button"
              class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
              :class="i === slashHighlight ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
              @click="selectSlashCmd(cmd)"
            >
              <span class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" :class="i === slashHighlight ? 'bg-sky-100 dark:bg-sky-500/15 text-sky-600 dark:text-sky-400' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-500 dark:text-slate-400'">
                <AppIcon :name="cmd.icon" :size="14" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-mono font-semibold" :class="i === slashHighlight ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ cmd.cmd }}</span>
                  <span class="text-xs" :class="i === slashHighlight ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'">{{ cmd.label }}</span>
                </div>
                <div class="text-[11px] text-slate-400 dark:text-slate-600 mt-0.5">{{ cmd.desc }}</div>
              </div>
            </button>
          </template>
        </div>
      </div>

      <div :class="isTerminalMode ? 'px-4 py-2' : 'max-w-[1020px] mx-auto px-6 py-3'">
        <input
          ref="attachmentInput"
          type="file"
          class="hidden"
          multiple
          @change="onAttachmentChange"
        />
        <div v-if="composerAttachments.length || attachmentError" class="mb-2 flex flex-wrap gap-1.5">
          <span
            v-for="item in composerAttachments"
            :key="item.id"
            class="max-w-[260px] h-7 px-2 rounded-md border flex items-center gap-1.5 text-[11px]"
            :class="item.error ? 'border-amber-200 dark:border-amber-400/20 bg-amber-50 dark:bg-amber-400/8 text-amber-700 dark:text-amber-300' : 'border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#0b0f19] text-slate-600 dark:text-slate-300'"
            :title="`${item.name} · ${formatAttachmentSize(item.size)}${item.error ? ` · ${item.error}` : ''}`"
          >
            <AppIcon :name="item.kind === 'image' ? 'image' : 'file'" :size="13" />
            <span class="truncate">{{ item.name }}</span>
            <span class="shrink-0 text-[10px] text-slate-400 dark:text-slate-600">{{ formatAttachmentSize(item.size) }}</span>
            <button
              type="button"
              class="shrink-0 w-4 h-4 rounded flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
              title="移除附件"
              @click="removeAttachment(item.id)"
            >
              <AppIcon name="close" :size="10" />
            </button>
          </span>
          <span v-if="attachmentError" class="h-7 px-2 rounded-md border border-amber-200 dark:border-amber-400/20 bg-amber-50 dark:bg-amber-400/8 text-[11px] text-amber-700 dark:text-amber-300 flex items-center">{{ attachmentError }}</span>
        </div>
        <div
          class="rounded-xl border bg-white dark:bg-[#090d15] shadow-sm transition-colors p-2.5"
          :class="isGoalComposerMode ? 'border-sky-300 dark:border-sky-400/35 focus-within:border-sky-400 dark:focus-within:border-sky-300/55' : 'border-slate-200 dark:border-white/[0.08] focus-within:border-sky-300 dark:focus-within:border-sky-400/30'"
        >
          <div
            v-if="isGoalComposerMode"
            class="mb-1.5 min-h-9 px-2.5 py-1.5 rounded-lg border border-sky-200 dark:border-sky-400/20 bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300 flex items-center gap-2 text-xs"
          >
            <span class="w-6 h-6 rounded-lg bg-sky-100 dark:bg-sky-400/15 flex items-center justify-center shrink-0">
              <AppIcon name="target" :size="13" />
            </span>
            <strong class="font-semibold shrink-0">目标</strong>
            <span class="min-w-0 truncate text-sky-600 dark:text-sky-300/80">下一条输入会保存为 Agent 工作目标</span>
            <button
              type="button"
              class="ml-auto w-6 h-6 rounded-lg flex items-center justify-center hover:bg-sky-100 dark:hover:bg-sky-400/15 transition-colors cursor-pointer"
              title="退出目标输入"
              @click="closeGoalComposer"
            >
              <AppIcon name="close" :size="11" />
            </button>
          </div>
          <textarea
            ref="composerInputEl"
            v-model="composerInput"
            class="w-full max-h-[180px] px-2 py-1.5 text-sm leading-6 text-slate-700 dark:text-slate-200 bg-transparent border-0 resize-none focus:outline-none placeholder:text-slate-400 dark:placeholder:text-slate-600"
            :class="isTerminalMode ? 'min-h-[32px]' : 'min-h-[56px]'"
            :placeholder="composerPlaceholder"
            :rows="isTerminalMode ? 1 : 2"
            @keydown="onKeydown"
            @paste="onComposerPaste"
          ></textarea>
          <div class="mt-1.5 flex items-center gap-2">
            <!-- Agent / 终端模式切换：输入框常驻共用，切换后内容保留（Warp 式命令输入） -->
            <div class="shrink-0 h-8 p-0.5 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-100/80 dark:bg-white/[0.03] flex items-center gap-0.5" role="tablist" aria-label="输入模式">
              <button
                type="button"
                class="h-7 px-2.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                :class="!isTerminalMode ? 'bg-white dark:bg-white/[0.1] text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'"
                title="Agent 对话模式"
                @click="setWorkMode('agent')"
              >
                <AppIcon name="spark" :size="12" />
                Agent
              </button>
              <button
                type="button"
                class="h-7 px-2.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                :class="isTerminalMode ? 'bg-white dark:bg-white/[0.1] text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'"
                title="终端模式：输入框直接发命令到终端"
                @click="setWorkMode('terminal')"
              >
                <AppIcon name="terminal" :size="12" />
                终端
              </button>
            </div>

            <template v-if="!isTerminalMode">
            <button
              type="button"
              class="shrink-0 w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-400/10 flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              title="添加图片或文档"
              :disabled="isBusy || isGoalComposerMode"
              @click="attachmentInput?.click()"
            >
              <AppIcon name="paperclip" :size="16" />
            </button>

            <button
              type="button"
              class="shrink-0 w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-400/10 flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              title="回溯到某次输入"
              :disabled="isBusy || !hasTimeline"
              @click="openRewindModal"
            >
              <AppIcon name="history" :size="16" />
            </button>

            <!-- agent 切换（所有会话）：1Shell AI ↔ claude/codex/… 随时互切 -->
            <div class="relative">
              <button
                type="button"
                class="h-8 max-w-[180px] px-2.5 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03] text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 cursor-pointer hover:border-sky-300 dark:hover:border-sky-400/30 transition-colors"
                :title="activeCwd && activeIsProtocolAgent ? `${activeAgentName} · ${activeCwd}` : activeAgentName"
                @click="toggleAgentDropdown"
              >
                <AppIcon :name="activeIsProtocolAgent ? 'robot' : 'spark'" :size="13" class="text-sky-500 shrink-0" />
                <span class="truncate">{{ activeAgentName }}</span>
                <AppIcon name="arrow-right" :size="11" class="rotate-90 opacity-70 shrink-0" />
              </button>
              <div v-if="showAgentDropdown" class="absolute bottom-full left-0 mb-2 w-56 bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-40 py-1 overflow-hidden">
                <button
                  type="button"
                  class="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer flex items-center gap-2"
                  :class="!activeIsProtocolAgent ? 'bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="pickSessionAgent(ONESHELL_AGENT_ID)"
                >
                  <AppIcon name="spark" :size="12" class="shrink-0" :class="!activeIsProtocolAgent ? 'text-sky-500' : 'text-slate-400'" />
                  <span class="truncate">1Shell AI</span>
                </button>
                <button
                  v-for="agent in installedProtocolAgents"
                  :key="agent.id"
                  type="button"
                  class="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer flex items-center gap-2"
                  :class="agent.id === activeAgentId ? 'bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="pickSessionAgent(agent.id)"
                >
                  <AppIcon name="robot" :size="12" class="shrink-0" :class="agent.id === activeAgentId ? 'text-sky-500' : 'text-slate-400'" />
                  <span class="truncate">{{ agent.name }}</span>
                </button>
                <div v-if="!installedProtocolAgents.length" class="px-3 py-2 text-xs text-slate-400 dark:text-slate-600">未检测到已安装的协议 agent</div>
              </div>
            </div>

            <!-- 协议 agent 会话：思考程度 / fast（完全访问权限接入，无审批模式选项） -->
            <template v-if="activeIsProtocolAgent">
              <div v-if="activeEffortOptions.length" class="relative">
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-lg border border-transparent text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-white/[0.04] flex items-center gap-1.5 cursor-pointer transition-colors"
                  title="思考程度"
                  @click="showEffortDropdown = !showEffortDropdown; showAgentDropdown = false"
                >
                  <AppIcon name="spark" :size="13" />
                  <span>思考 · {{ activeEffortLabel }}</span>
                  <AppIcon name="arrow-right" :size="11" class="rotate-90 opacity-70" />
                </button>
                <div v-if="showEffortDropdown" class="absolute bottom-full left-0 mb-2 w-36 bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-40 py-1 overflow-hidden">
                  <button
                    v-for="effort in activeEffortOptions"
                    :key="effort || 'default'"
                    class="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer"
                    :class="activeProtocolSettings.effort === effort ? 'bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                    @click="pickProtocolEffort(effort)"
                  >{{ EFFORT_LABELS[effort] || effort }}<span v-if="effort" class="ml-1.5 text-[10px] text-slate-400 dark:text-slate-600">{{ effort }}</span></button>
                </div>
              </div>

              <button
                v-if="activeSupportsFast"
                type="button"
                class="h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                :class="activeProtocolSettings.fast ? 'border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/10 text-amber-700 dark:text-amber-300' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                title="Codex fast 档（service tier = fast）"
                @click="toggleProtocolFast"
              >
                <AppIcon name="zap" :size="13" />
                <span>极速</span>
              </button>

              <div v-if="activeCwd" class="ml-auto hidden md:flex items-center min-w-0 text-[10px] text-slate-400 dark:text-slate-600" :title="activeCwd">
                <span class="truncate max-w-[220px]">{{ activeCwd }}</span>
              </div>
              <div v-else class="ml-auto"></div>
            </template>

            <template v-else>
            <button
              type="button"
              class="shrink-0 h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              :class="isGoalComposerMode ? 'border-sky-300 dark:border-sky-400/30 bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
              :disabled="isBusy"
              :title="goalText"
              @click="setGoal"
            >
              <AppIcon name="target" :size="14" />
              <span>目标</span>
            </button>

            <div class="relative">
              <button
                type="button"
                class="h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                :class="modeBadge.cls"
                @click="showModeDropdown = !showModeDropdown; showModelDropdown = false; showAgentDropdown = false"
              >
                <AppIcon name="shield" :size="13" />
                <span>{{ modeBadge.label }}</span>
                <AppIcon name="arrow-right" :size="11" class="rotate-90 opacity-70" />
              </button>
              <div v-if="showModeDropdown" class="absolute bottom-full left-0 mb-2 w-36 bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-40 py-1 overflow-hidden">
                <button
                  v-for="m in modes"
                  :key="m.key"
                  class="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer"
                  :class="approvalMode === m.key ? 'bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="pickMode(m.key)"
                >{{ m.label }}</button>
              </div>
            </div>

            <div class="ml-auto relative min-w-0">
              <button
                type="button"
                class="h-8 max-w-[260px] px-2.5 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-white/[0.04] flex items-center gap-1.5 cursor-pointer transition-colors"
                title="切换模型"
                @click="toggleModelDropdown"
              >
                <AppIcon name="spark" :size="13" />
                <span class="truncate">{{ modelText }}</span>
                <span v-if="modelChannel" class="hidden sm:inline text-[10px] text-slate-400 dark:text-slate-600 truncate">({{ modelChannel }})</span>
                <AppIcon name="arrow-right" :size="11" class="rotate-90 opacity-70 shrink-0" />
              </button>
              <div v-if="showModelDropdown" class="absolute bottom-full right-0 mb-2 w-[300px] max-w-[calc(100vw-48px)] bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-xl shadow-2xl z-40 py-1.5 overflow-hidden">
                <button
                  type="button"
                  class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
                  :class="!activeProviderId ? 'bg-sky-50 dark:bg-sky-400/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="selectComposerModel(null)"
                >
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="!activeProviderId ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold" :class="!activeProviderId ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">默认模型</div>
                    <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-600">使用当前系统默认模型接入</div>
                  </div>
                </button>
                <div v-if="enabledModelOptions.length" class="h-px bg-slate-100 dark:bg-white/[0.06] mx-3"></div>
                <button
                  v-for="option in enabledModelOptions"
                  :key="option.key"
                  type="button"
                  class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
                  :class="option.key === activeModelKey ? 'bg-sky-50 dark:bg-sky-400/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="selectComposerModel(option.providerId, option.modelId)"
                >
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="option.key === activeModelKey ? 'bg-sky-500 shadow-[0_0_6px_rgba(14,165,233,0.35)]' : 'bg-slate-300 dark:bg-slate-600'"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold truncate" :class="option.key === activeModelKey ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ option.label || '未指定模型' }}</div>
                    <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-600 truncate">{{ modelOptionMeta(option) }}</div>
                  </div>
                </button>
                <div v-if="!enabledModelOptions.length" class="px-3 py-4 text-xs text-slate-400 dark:text-slate-600 text-center">
                  暂无启用的模型接入 · <RouterLink to="/config/ai" class="text-sky-500 hover:underline">前往 AI 配置</RouterLink>
                </div>
              </div>
            </div>
            </template>
            </template>

            <!-- 终端模式：侧栏开关 + 当前主机徽标 -->
            <template v-else>
              <button
                type="button"
                class="shrink-0 w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] flex items-center justify-center transition-colors cursor-pointer"
                :title="railCollapsed ? '显示侧栏' : '隐藏侧栏'"
                @click="toggleRail"
              >
                <AppIcon name="panel-left" :size="14" />
              </button>
              <span class="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03] text-xs font-medium text-slate-600 dark:text-slate-300 flex items-center gap-1.5 min-w-0">
                <AppIcon name="server" :size="13" class="text-sky-500 shrink-0" />
                <span class="truncate max-w-[160px]">{{ termHostName }}</span>
              </span>
              <div class="ml-auto"></div>
            </template>

            <button
              class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer"
              :class="canSubmitComposer ? 'bg-slate-900 dark:bg-sky-500 text-white hover:bg-slate-800 dark:hover:bg-sky-400 shadow-md shadow-slate-900/10 dark:shadow-sky-500/10' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-400 dark:text-slate-600 cursor-not-allowed'"
              :disabled="!canSubmitComposer"
              @click="send"
            >
              <AppIcon :name="canSubmitComposer ? (isTerminalMode ? 'terminal' : (isGoalComposerMode ? 'target' : 'send')) : 'arrow-right'" :size="16" />
            </button>
          </div>
        </div>
      </div>
    </footer>

    <div v-if="showHostDropdown || showModeDropdown || showModelDropdown || showFilesDropdown || showAgentDropdown || showEffortDropdown" class="fixed inset-0 z-20" @click="showHostDropdown = false; showModeDropdown = false; showModelDropdown = false; showFilesDropdown = false; showAgentDropdown = false; showEffortDropdown = false"></div>

    <Teleport to="body">
      <div
        v-if="newSessionModalOpen"
        class="fixed inset-0 z-[2200] flex items-center justify-center bg-slate-950/55 backdrop-blur-[2px] p-4"
        @click.self="closeNewSessionModal"
      >
        <section
          class="w-full max-w-[560px] max-h-[78vh] overflow-hidden rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#101624] shadow-2xl flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-session-modal-title"
        >
          <header class="shrink-0 flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-white/[0.06]">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                  <AppIcon name="plus" :size="16" />
                </span>
                <h2 id="new-session-modal-title" class="text-base font-semibold text-slate-800 dark:text-slate-100">新建对话</h2>
              </div>
              <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{{ newSessionIsProtocol ? '第三方 agent 在本机工作目录中运行，可同时指定目标 VPS（经 1Shell MCP 操作）。' : '不选择 VPS 时建立全局对话。' }}</p>
            </div>
            <button
              type="button"
              class="shrink-0 w-9 h-9 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] flex items-center justify-center transition-colors cursor-pointer"
              title="关闭"
              @click="closeNewSessionModal"
            >
              <AppIcon name="close" :size="16" />
            </button>
          </header>

          <div class="flex-1 min-h-[240px] overflow-y-auto px-5 py-4">
            <div class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">Agent</div>
            <div class="mt-2 space-y-1.5">
              <button
                type="button"
                class="w-full min-h-11 px-3 rounded-lg border flex items-center gap-3 text-left transition-colors cursor-pointer"
                :class="!newSessionIsProtocol ? 'border-sky-300 dark:border-sky-400/30 bg-sky-50 dark:bg-sky-400/10' : 'border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                @click="pickNewSessionAgent(ONESHELL_AGENT_ID)"
              >
                <span class="w-7 h-7 rounded-md flex items-center justify-center shrink-0" :class="!newSessionIsProtocol ? 'bg-sky-500 text-white' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-400'">
                  <AppIcon name="sparkle" :size="14" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium" :class="!newSessionIsProtocol ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">1Shell AI</div>
                  <div class="mt-0.5 text-xs text-slate-400 dark:text-slate-500">内置 agent，可绑定 VPS 工作区</div>
                </div>
              </button>
              <button
                v-for="agent in protocolAgents"
                :key="agent.id"
                type="button"
                class="w-full min-h-11 px-3 rounded-lg border flex items-center gap-3 text-left transition-colors"
                :class="[
                  newSessionAgentDraft === agent.id ? 'border-sky-300 dark:border-sky-400/30 bg-sky-50 dark:bg-sky-400/10' : 'border-slate-200 dark:border-white/[0.08]',
                  agent.installed ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.04]' : 'opacity-55 cursor-not-allowed',
                ]"
                :disabled="!agent.installed"
                :title="agent.installed ? '' : '未检测到该 CLI，请先安装'"
                @click="pickNewSessionAgent(agent.id)"
              >
                <span class="w-7 h-7 rounded-md flex items-center justify-center shrink-0" :class="newSessionAgentDraft === agent.id ? 'bg-sky-500 text-white' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-400'">
                  <AppIcon name="robot" :size="14" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium" :class="newSessionAgentDraft === agent.id ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ agent.name }}</div>
                  <div class="mt-0.5 text-xs text-slate-400 dark:text-slate-500 truncate">{{ agent.installed ? (agent.description || agent.protocol) : '未安装' }}</div>
                </div>
              </button>
            </div>

            <template v-if="newSessionIsProtocol">
              <div class="mt-4 text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">工作目录</div>
              <input
                v-model="newSessionCwdDraft"
                type="text"
                class="mt-2 w-full h-10 px-3 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-sky-400 dark:focus:border-sky-400/50"
                placeholder="本机目录，如 E:\projects\demo（留空使用默认目录）"
                spellcheck="false"
              >
              <p class="mt-2 text-xs leading-5 text-slate-400 dark:text-slate-500">agent 将在该目录中读写文件、执行命令。</p>
            </template>

            <button
              type="button"
              class="mt-4 w-full min-h-12 px-3 rounded-lg border flex items-center gap-3 text-left transition-colors cursor-pointer"
              :class="newSessionHostDraft.length === 0 ? 'border-sky-300 dark:border-sky-400/30 bg-sky-50 dark:bg-sky-400/10' : 'border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
              @click="newSessionHostDraft = []"
            >
              <span class="w-7 h-7 rounded-md flex items-center justify-center shrink-0" :class="newSessionHostDraft.length === 0 ? 'bg-sky-500 text-white' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-400'">
                <AppIcon name="globe" :size="14" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium" :class="newSessionHostDraft.length === 0 ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ newSessionIsProtocol ? '不绑定 VPS' : '全局对话' }}</div>
                <div class="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{{ newSessionIsProtocol ? '仅在本机工作目录中活动' : '不绑定具体 VPS' }}</div>
              </div>
            </button>

            <div class="mt-4 flex items-center justify-between gap-3">
              <div class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">{{ newSessionIsProtocol ? '目标 VPS' : 'VPS' }}</div>
              <div class="text-xs text-slate-400 dark:text-slate-500">{{ newSessionHostDraft.length ? workspaceLabel(newSessionHostDraft) : (newSessionIsProtocol ? '不绑定' : '全局') }}</div>
            </div>
            <p v-if="newSessionIsProtocol" class="mt-1 text-xs leading-5 text-slate-400 dark:text-slate-500">选中后 agent 会通过 1Shell MCP 工具操作这些主机。</p>

            <div class="mt-2 space-y-1.5">
              <button
                v-for="host in hosts"
                :key="host.id"
                type="button"
                class="w-full min-h-11 px-3 rounded-lg border flex items-center gap-3 text-left transition-colors cursor-pointer"
                :class="newSessionHostDraft.includes(host.id) ? 'border-sky-300 dark:border-sky-400/30 bg-sky-50 dark:bg-sky-400/10' : 'border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                @click="toggleNewSessionHost(host.id)"
              >
                <span class="w-5 h-5 rounded border flex items-center justify-center shrink-0" :class="newSessionHostDraft.includes(host.id) ? 'border-sky-500 bg-sky-500 text-white' : 'border-slate-300 dark:border-slate-600 text-transparent'">
                  <AppIcon name="check" :size="13" />
                </span>
                <span class="w-7 h-7 rounded-md bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                  <AppIcon name="server" :size="14" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate text-slate-700 dark:text-slate-200">{{ host.name || host.id }}</div>
                  <div class="mt-0.5 text-xs text-slate-400 dark:text-slate-500 truncate">{{ host.host || host.id }}</div>
                </div>
              </button>
              <div v-if="!hosts.length" class="px-3 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
                暂无 VPS
              </div>
            </div>
          </div>

          <footer class="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 dark:border-white/[0.06] bg-stone-50 dark:bg-[#0b0f19]">
            <div class="text-xs text-slate-500 dark:text-slate-400 truncate">
              {{ newSessionIsProtocol
                ? `${agentNameFor(newSessionAgentDraft)} · ${newSessionCwdDraft.trim() || '默认目录'}${newSessionHostDraft.length ? ` · ${workspaceLabel(newSessionHostDraft)}` : ''}`
                : `工作区：${newSessionHostDraft.length ? workspaceLabel(newSessionHostDraft) : '全局'}` }}
            </div>
            <div class="flex items-center gap-2">
              <button type="button" class="h-8 px-3 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-white dark:hover:bg-white/[0.04] transition-colors cursor-pointer" @click="closeNewSessionModal">取消</button>
              <button type="button" class="h-8 px-3 rounded-lg text-xs font-medium bg-slate-900 dark:bg-sky-500 text-white hover:bg-slate-800 dark:hover:bg-sky-400 transition-colors cursor-pointer" @click="confirmNewSession">建立对话</button>
            </div>
          </footer>
        </section>
      </div>

      <div
        v-if="rewindModalOpen"
        class="fixed inset-0 z-[2200] flex items-center justify-center bg-slate-950/55 backdrop-blur-[2px] p-4"
        @click.self="closeRewindModal"
      >
        <section
          ref="rewindModalRef"
          class="w-full max-w-[640px] max-h-[78vh] overflow-hidden rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#101624] shadow-2xl outline-none flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rewind-modal-title"
          tabindex="-1"
          @keydown="onRewindModalKeydown"
        >
          <header class="shrink-0 flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-white/[0.06]">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                  <AppIcon name="history" :size="16" />
                </span>
                <h2 id="rewind-modal-title" class="text-base font-semibold text-slate-800 dark:text-slate-100">Rewind to...</h2>
              </div>
              <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">选择一次输入，1Shell 会回到当时的对话位置，并撤销之后可逆的主机文件操作。</p>
            </div>
            <button
              type="button"
              class="shrink-0 w-9 h-9 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] flex items-center justify-center transition-colors cursor-pointer"
              title="关闭"
              @click="closeRewindModal"
            >
              <AppIcon name="close" :size="16" />
            </button>
          </header>

          <div class="min-h-[220px] flex-1 overflow-y-auto py-2">
            <div v-if="rewindLoading" class="h-[220px] flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
              正在读取回溯点...
            </div>
            <div v-else-if="rewindError" class="px-5 py-8 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ rewindError }}
            </div>
            <template v-else>
              <button
                v-for="(point, i) in rewindPoints"
                :key="point.id"
                type="button"
                class="w-full min-h-[54px] px-5 py-3 text-left border-b border-slate-100 dark:border-white/[0.04] flex items-center gap-3 transition-colors cursor-pointer"
                :class="i === rewindHighlight ? 'bg-sky-50 dark:bg-sky-400/10 outline outline-1 outline-sky-400/60 outline-offset-[-1px]' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                @mouseenter="rewindHighlight = i"
                @click="runRewind(point)"
              >
                <span class="shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center text-xs font-semibold"
                  :class="i === rewindHighlight ? 'border-sky-300 dark:border-sky-400/30 text-sky-700 dark:text-sky-300 bg-white/70 dark:bg-sky-400/10' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-white/[0.03]'">
                  #{{ point.ordinal }}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="truncate text-sm font-medium" :class="i === rewindHighlight ? 'text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200'">{{ rewindPointText(point) }}</span>
                    <span class="shrink-0 text-xs text-slate-400 dark:text-slate-500">{{ rewindPointTime(point) }}</span>
                  </div>
                  <div class="mt-1 flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
                    <span class="inline-flex items-center gap-1 min-w-0">
                      <AppIcon name="server" :size="12" />
                      <span class="truncate">{{ rewindPointHost(point) }}</span>
                    </span>
                    <span class="text-slate-300 dark:text-slate-700">/</span>
                    <span>{{ point.undoCount }} 个可撤销文件操作</span>
                  </div>
                </div>
              </button>
            </template>
          </div>

          <footer class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-slate-200 dark:border-white/[0.06] bg-stone-50 dark:bg-[#0b0f19]">
            <div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
              <span class="px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">↑↓</span>
              <span>移动</span>
              <span class="text-slate-300 dark:text-slate-700">·</span>
              <span class="px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">Enter</span>
              <span>回溯</span>
              <span class="text-slate-300 dark:text-slate-700">·</span>
              <span class="px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">Esc</span>
              <span>关闭</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <p class="text-[11px] leading-5 text-slate-400 dark:text-slate-500">当前只自动撤销 1Shell 结构化文件工具造成的改动；shell 命令、服务安装、数据库写入会保留在报告里。</p>
              <button
                type="button"
                class="shrink-0 h-8 px-3 rounded-lg text-xs font-medium transition-colors"
                :class="rewindPoints.length && !rewindLoading ? 'bg-slate-900 dark:bg-sky-500 text-white hover:bg-slate-800 dark:hover:bg-sky-400 cursor-pointer' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-400 dark:text-slate-600 cursor-not-allowed'"
                :disabled="!rewindPoints.length || rewindLoading"
                @click="runRewind()"
              >
                回溯
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>
    </div>

    <!-- Host 编辑 modal（rail 主机区的增改） -->
    <HostModal
      ref="hostModalRef"
      :open="hostModalOpen"
      :editing="hostEditing"
      :ssh-hosts="sshHosts"
      @close="hostModalOpen = false"
      @submit="onHostSubmit"
    />

    <!-- 终端选区分析右键菜单（position:fixed 全局） -->
    <AnalyzeContextMenu />
  </div>
</template>

<style scoped>
.agent-view-rail-toggle {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  background: transparent;
  transition: background-color 0.15s ease, color 0.15s ease;
  cursor: pointer;
}

.agent-view-rail-toggle:hover,
.agent-view-rail-toggle:focus-visible {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.06);
  outline: none;
}

.dark .agent-view-rail-toggle {
  color: #94a3b8;
}

.dark .agent-view-rail-toggle:hover,
.dark .agent-view-rail-toggle:focus-visible {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.06);
}

.agent-view-rail-backdrop {
  display: none;
}

/* ── 纸面卡片（三栏统一质感，沿用原终端页 paper-panel 视觉） ── */
.agent-view-panel {
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.95);
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.07);
  backdrop-filter: blur(10px);
  overflow: hidden;
}

.dark .agent-view-panel {
  border-color: rgba(30, 41, 59, 0.95);
  background: rgba(11, 19, 36, 0.88);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
}

.agent-view-rail {
  margin-right: 8px;
}

/* 终端全屏：主区（终端+输入条）整体铺满窗口，盖过顶栏/侧栏 */
.agent-view-main--fullscreen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  height: auto !important;
  border-radius: 0;
}

/* 窄屏（与 style.css 的 .agent-view-shell 纵排断点一致） */
@media (max-width: 768px) {
  .agent-view-rail {
    margin-right: 0;
    margin-top: 8px;
  }
}

.agent-approval-panel :deep(.ide-approval-card) {
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.agent-view-shell--mobile-rail {
  position: relative;
}

.agent-view-shell--mobile-rail :deep(.agent-view-rail) {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 42;
  width: min(86vw, 360px);
  min-width: min(86vw, 300px);
  max-width: min(92vw, 420px);
  box-shadow: 18px 0 38px rgba(15, 23, 42, 0.22);
}

.agent-view-shell--mobile-rail .agent-view-rail-backdrop {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: block;
  border: 0;
  padding: 0;
  background: rgba(15, 23, 42, 0.36);
}

@media (max-width: 700px) {
  .agent-view-header {
    padding-left: 12px;
    padding-right: 12px;
    gap: 8px;
  }

  .agent-view-header > .flex.items-center.gap-2.text-xs {
    min-width: 0;
  }
}

.agent-md :deep(pre) {
  background: #0f172a;
  color: #e2e8f0;
  border: 0;
  border-radius: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.6;
}
.dark .agent-md :deep(pre) {
  background: transparent;
  color: #e2e8f0;
}
.agent-md :deep(.markdown-code-block) {
  border-color: rgba(51, 65, 85, 0.92);
  background: #0f172a;
}
.agent-md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.agent-md :deep(p) { margin: 0.5em 0; }
.agent-md :deep(p:first-child) { margin-top: 0; }
.agent-md :deep(p:last-child) { margin-bottom: 0; }
.agent-md :deep(ul), .agent-md :deep(ol) { padding-left: 1.5em; margin: 0.4em 0; }
.agent-md :deep(li) { margin: 0.2em 0; }
.agent-md :deep(h1), .agent-md :deep(h2), .agent-md :deep(h3) { font-weight: 600; margin: 0.8em 0 0.3em; }
.agent-md :deep(h1) { font-size: 1.15em; }
.agent-md :deep(h2) { font-size: 1.05em; }
.agent-md :deep(h3) { font-size: 1em; }
.agent-md :deep(blockquote) {
  border-left: 2px solid rgba(52, 211, 153, 0.3);
  padding-left: 12px;
  color: #94a3b8;
  margin: 0.4em 0;
}
.agent-md :deep(a) { color: #38bdf8; text-decoration: underline; }
.dark .agent-md :deep(a) { color: #38bdf8; }
</style>

// studio.ts — IDE 工作台 (skill-studio) 类型定义
// 与老 skill-studio.js 字段 1:1 对应

/* ───── 基础实体 ──────────────────────────────────── */

export interface HostInfo {
  id: string;
  name: string;
  host?: string;
  username?: string;
  port?: number;
}

export interface SelectedPath {
  hostId: string;
  path: string;
}

export interface SelectedContainer {
  hostId: string;
  name: string;
  image: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  kind?: 'skill';
  category?: string;
}

export interface McpInfo {
  id: string;
  name: string;
  type?: 'local' | 'remote';
  url?: string;
  command?: string;
  description?: string;
  enabled?: boolean;
  exposeToIde?: boolean;
  runtimeStatus?: string;
  toolCount?: number;
}

export interface LocalMcpStatus {
  status: 'starting' | 'running' | 'stopped' | 'error' | string;
  toolCount?: number;
}

export type ToolFilter = 'all' | 'skill' | 'mcp' | 'local';

export interface ToolItem {
  kind: 'skill' | 'mcp' | 'local';
  id: string;
  name: string;
  icon: string;
  meta: string;
  isLocal: boolean;
  statusDot: string;
}

/* ───── 容器扫描 ──────────────────────────────────── */

export interface ContainerScanItem {
  name: string;
  image: string;
  status: string; // 'Up X minutes' / 'Exited' 等
}

export type ContainerScanResult =
  | { kind: 'list'; items: ContainerScanItem[] }
  | { kind: 'no-docker' }
  | { kind: 'error'; message: string };

/* ───── 文件浏览器 ────────────────────────────────── */

export interface FpItem {
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
}

/* ───── chat 消息 / session ───────────────────────── */

export type AiLineKind = 'stdout' | 'stderr' | 'info' | 'thought' | 'error' | 'success' | 'stream';

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AiMessage {
  role: 'ai';
  kind: AiLineKind;
  content: string;
}

export interface AuthoringOption {
  id: string;
  label: string;
  description?: string;
  summary?: string;
  pros?: string[];
  cons?: string[];
  risk?: 'low' | 'medium' | 'high' | string;
  recommended?: boolean;
}

export interface AuthoringInteraction {
  id: string;
  sessionId: string;
  kind: 'question' | 'options' | 'commit_approval';
  title?: string;
  description?: string;
  question?: string;
  questionKind?: 'single_choice' | 'multi_choice' | 'text' | 'confirm' | string;
  summary?: string;
  artifactId?: string;
  files?: Array<{ path: string; bytes?: number }>;
  dangerousActions?: string[];
  irreversibleActions?: string[];
  validation?: { ok?: boolean; errors?: string[]; warnings?: string[] } | null;
  options?: AuthoringOption[];
  required?: boolean;
  answered?: boolean;
}

export interface AuthoringArtifact {
  id: string;
  type: 'program_spec' | 'authoring_plan' | 'program_draft' | 'authoring_verification' | 'skill_spec' | 'skill_draft' | string;
  title: string;
  status?: string;
  data?: Record<string, unknown>;
  warnings?: string[];
  dangerousActions?: string[];
  validation?: { ok?: boolean; errors?: string[]; warnings?: string[] } | null;
}

export interface AuthoringMessage {
  role: 'authoring';
  interaction?: AuthoringInteraction;
  artifact?: AuthoringArtifact;
}

export type SessionMessage = UserMessage | AiMessage | AuthoringMessage;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: SessionMessage[];
}

export interface ResidualCleanupSummary {
  paths: string[];
  passedArtifactIds: string[];
}

export type AuthoringStage = 'discovery' | 'options' | 'spec' | 'plan' | 'draft' | 'review' | 'commit' | 'verify' | 'done' | 'blocked';

export interface AuthoringSessionSnapshot {
  id: string;
  intent: string;
  stage: AuthoringStage;
  complexity: 'simple' | 'moderate' | 'complex' | string;
  risk: 'low' | 'medium' | 'high' | string;
  source: string;
  refinedMode?: boolean;
  userGoal: string;
  artifacts?: AuthoringArtifact[];
  approvals?: Record<string, boolean>;
  blockedTools?: Array<{ toolName: string; stage: string; at: number }>;
}

/* ───── onSend context payload ────────────────────── */

export interface SendContext {
  hosts: Array<{ id: string; name: string; host?: string; username?: string; port?: number }>;
  containers: SelectedContainer[];
  files: Array<{ hostId: string; path: string }>;
  mcpServers: Array<{ id: string; name?: string; url?: string }>;
}

/* ───── 安全模式审批条 ─────────────────────────────── */

export interface ApprovePayload {
  requestId: string;
  sessionId: string;
  title?: string;
  toolName?: string;
  detail?: string;
}

export type ApproveAction = 'allow' | 'deny' | 'custom';

export const APPROVE_TIMEOUT_SEC = 120;

/* ───── 帮手 ─────────────────────────────────────── */

export const HISTORY_KEY = '1shell.studio.sessions.v4.0.0';
export const ERROR_CONTEXT_KEY = '1shell.studio.errorContext.v4.0.0';
export const SESSIONS_MAX = 50;
export const TOOL_OUTPUT_MAX = 2000;

/** 老版 truncate160 实际只截 60 字符（1:1 沿用 bug） */
export function truncate60(s: string | undefined): string {
  return String(s || '').replace(/\s+/g, ' ').slice(0, 60);
}

/** AI tool 结果裁剪（与老版 truncate 一致） */
export function truncateOutput(s: string | undefined): string {
  const t = String(s || '').trim();
  return t.length > TOOL_OUTPUT_MAX ? t.slice(0, TOOL_OUTPUT_MAX) + '\n...[truncated]' : t;
}

export function humanSize(bytes: number | undefined): string {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'M';
  return (b / 1024 / 1024 / 1024).toFixed(1) + 'G';
}

function artifactData(artifact: AuthoringArtifact): Record<string, unknown> {
  return artifact.data && typeof artifact.data === 'object' ? artifact.data : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function filePaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String((item as { path?: unknown })?.path || '').trim()).filter(Boolean)
    : [];
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function collectAuthoringResidualPaths(session: ChatSession): ResidualCleanupSummary {
  const passedArtifactIds = new Set<string>();
  const failedArtifactIds = new Set<string>();
  const draftArtifacts: AuthoringArtifact[] = [];
  const interactionPaths: Array<{ artifactId: string; paths: string[] }> = [];

  for (const message of session.messages || []) {
    if (message.role !== 'authoring') continue;
    if (message.interaction?.kind === 'commit_approval' && message.interaction.artifactId) {
      interactionPaths.push({
        artifactId: message.interaction.artifactId,
        paths: (message.interaction.files || []).map((file) => file.path).filter(Boolean),
      });
    }
    const artifact = message.artifact;
    if (!artifact) continue;
    if (artifact.type === 'program_draft' || artifact.type === 'skill_draft') draftArtifacts.push(artifact);
    if (artifact.type === 'authoring_verification') {
      const sourceArtifactId = String(artifactData(artifact).sourceArtifactId || '').trim();
      if (!sourceArtifactId) continue;
      if (artifact.status === 'passed' || artifact.validation?.ok === true || artifactData(artifact).ok === true) passedArtifactIds.add(sourceArtifactId);
      else failedArtifactIds.add(sourceArtifactId);
    }
  }

  const paths = new Set<string>();
  for (const artifact of draftArtifacts) {
    if (passedArtifactIds.has(artifact.id)) continue;
    const data = artifactData(artifact);
    const committedFiles = stringArray(data.committedFiles);
    const draftFiles = filePaths(data.files);
    const shouldClean = committedFiles.length > 0
      || failedArtifactIds.has(artifact.id)
      || artifact.status === 'committed'
      || artifact.status === 'needs_fix'
      || artifact.status === 'failed'
      || artifact.validation?.ok === false;
    for (const path of committedFiles) paths.add(normalizeArtifactPath(path));
    if (shouldClean) {
      for (const path of draftFiles) paths.add(normalizeArtifactPath(path));
    }
  }

  for (const item of interactionPaths) {
    if (passedArtifactIds.has(item.artifactId)) continue;
    const artifact = draftArtifacts.find((candidate) => candidate.id === item.artifactId);
    if (artifact && artifact.status === 'draft' && artifact.validation?.ok !== false && !failedArtifactIds.has(artifact.id)) continue;
    for (const path of item.paths) paths.add(normalizeArtifactPath(path));
  }

  return { paths: [...paths].filter((path) => path.startsWith('data/programs/') || path.startsWith('data/skills/')), passedArtifactIds: [...passedArtifactIds] };
}

export function newSessionId(): string {
  return 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function formatSessionTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 容器扫描命令（与老版一致，含 timeout 包裹防 docker 挂死） */
export const DOCKER_SCAN_CMD = 'timeout 8 docker ps -a --format "{{.Names}}|{{.Image}}|{{.Status}}" 2>/dev/null || echo "__docker_unavailable__"';

/** 解析 docker ps 输出 */
export function parseDockerScan(stdout: string): ContainerScanResult {
  const out = String(stdout || '').trim();
  if (!out || out === '__docker_unavailable__') return { kind: 'no-docker' };
  const items = out.split('\n').map((line) => {
    const [name, image, ...rest] = line.split('|');
    return {
      name: (name || '').trim(),
      image: (image || '').trim(),
      status: rest.join('|').trim(),
    };
  }).filter((x) => x.name && x.name !== '__docker_unavailable__');
  return { kind: 'list', items };
}

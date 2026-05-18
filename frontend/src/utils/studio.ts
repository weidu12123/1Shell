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
  kind?: 'skill' | 'playbook';
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

export type SessionMessage = UserMessage | AiMessage;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: SessionMessage[];
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

export const HISTORY_KEY = '1shell.ide.sessions.v1';
export const ERROR_CONTEXT_KEY = '1shell.studio.errorContext';
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

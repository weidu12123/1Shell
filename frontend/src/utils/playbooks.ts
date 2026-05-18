/* ───── 实体类型 ──────────────────────────────── */

export interface InputDef {
  name: string;
  label: string;
  type?: 'string' | 'select';
  placeholder?: string;
  default?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  visibleWhen?: { field: string; value: string | string[] };
}

export interface PlaybookInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  kind?: 'skill' | 'playbook';
  tags?: string[];
  forceLocal?: boolean;
  executionMode?: 'playbook' | 'ai-loop';
  inputs?: InputDef[];
  category?: string;
}

export interface HostInfo {
  id: string;
  name: string;
  host?: string;
}

export interface ProviderActive {
  id: string;
  name?: string;
  model?: string;
  apiKeySet?: boolean;
}

/* ───── render_result payload ─────────────────── */

export type RenderLevel = 'info' | 'success' | 'warning' | 'error';

export interface RenderBase {
  level?: RenderLevel;
  title?: string;
  subtitle?: string;
}

export interface RenderTablePayload extends RenderBase {
  format: 'table';
  columns?: string[];
  rows?: unknown[][];
  rowActions?: Array<{ value?: string; label?: string }>;
  rowActionSkill?: string;
  rowInputKey?: string;
}

export interface RenderKeyValuePayload extends RenderBase {
  format: 'keyvalue';
  items?: Array<{ key: string; value: unknown }>;
  data?: Record<string, unknown>;
}

export interface RenderListPayload extends RenderBase {
  format: 'list';
  listItems?: Array<{ title?: string; description?: string }>;
}

export interface RenderCodePayload extends RenderBase {
  format: 'code';
  content?: string;
}

export interface RenderMessagePayload extends RenderBase {
  format?: 'message';
  content?: string;
}

export type RenderPayload =
  | RenderTablePayload
  | RenderKeyValuePayload
  | RenderListPayload
  | RenderCodePayload
  | RenderMessagePayload;

/* ───── ask payload ──────────────────────────── */

export interface AskSelectPayload {
  type: 'select';
  title?: string;
  description?: string;
  options?: Array<{ value: string; label?: string; description?: string }>;
}

export interface AskConfirmPayload {
  type: 'confirm';
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface AskInputPayload {
  type: 'input';
  title?: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
}

export type AskPayload = AskSelectPayload | AskConfirmPayload | AskInputPayload;

export type AskAnswer =
  | { value: string; label?: string }
  | { confirmed: boolean }
  | { value: string };

/* ───── 运行流条目（统一 union） ──────────────── */

export type RunMode = 'playbook' | 'ai-loop' | 'ai-rescue';
export type RunStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

export interface ExecEntry {
  kind: 'exec';
  key: string;
  toolUseId: string;
  command: string;
  running: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
}

export interface ThoughtEntry {
  kind: 'thought';
  key: string;
  text: string;
}

export interface RenderEntry {
  kind: 'render';
  key: string;
  payload: RenderPayload;
}

export interface AskEntry {
  kind: 'ask';
  key: string;
  toolUseId: string;
  payload: AskPayload;
  answered: boolean;
  answerText?: string;
}

export interface PlaybookStepEntry {
  kind: 'playbook-step';
  key: string;
  stepId: string;
  label: string;
  state: 'running' | 'verified' | 'failed';
  durationMs?: number;
  reason?: string;
}

export interface RescueBannerEntry {
  kind: 'rescue-banner';
  key: string;
  label?: string;
}

export interface RunSummaryEntry {
  kind: 'run-summary';
  key: string;
  elapsedSec: number;
  turns: number;
  rescueCount: number;
  isPlaybook: boolean;
}

export interface SystemMessageEntry {
  kind: 'system-message';
  key: string;
  text: string;
  level: 'info' | 'error';
}

export interface DividerEntry {
  kind: 'divider';
  key: string;
  text: string;
}

export type RunEntry =
  | ExecEntry
  | ThoughtEntry
  | RenderEntry
  | AskEntry
  | PlaybookStepEntry
  | RescueBannerEntry
  | RunSummaryEntry
  | SystemMessageEntry
  | DividerEntry;

/* ───── 帮手 ──────────────────────────────────── */

export const MODE_BADGE: Record<RunMode, { text: string; cls: string }> = {
  'playbook':   { text: '⚡ Playbook',  cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' },
  'ai-loop':    { text: '🤖 AI-loop',   cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' },
  'ai-rescue':  { text: '🛠 AI-Rescue', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' },
};

export const STATUS_STYLES: Record<RunStatus, { dot: string; txt: string }> = {
  idle:      { dot: 'bg-slate-300',                  txt: 'text-slate-500 dark:text-slate-400' },
  starting:  { dot: 'bg-yellow-400 animate-pulse',   txt: 'text-amber-600 dark:text-amber-400' },
  running:   { dot: 'bg-blue-500 animate-pulse',     txt: 'text-blue-600 dark:text-blue-400' },
  waiting:   { dot: 'bg-amber-400 animate-pulse',    txt: 'text-amber-600 dark:text-amber-400' },
  done:      { dot: 'bg-emerald-500',                txt: 'text-emerald-600 dark:text-emerald-400' },
  error:     { dot: 'bg-red-500',                    txt: 'text-red-600 dark:text-red-400' },
  cancelled: { dot: 'bg-slate-400',                  txt: 'text-slate-500 dark:text-slate-400' },
};

export function genRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatElapsed(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/** 与 navigator.platform 一致；后端用不到，仅为统一接口预留 */
export const LIBRARY_KIND = 'playbook' as const;

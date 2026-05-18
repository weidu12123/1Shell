export type ScriptCategory = 'system' | 'docker' | 'network' | 'backup' | 'security' | 'other';
export type ScriptRisk = 'safe' | 'confirm' | 'danger';
export type ParamType = 'string' | 'number' | 'boolean' | 'select';
export type RunStatus = 'success' | 'failed' | 'running';

export interface ParamDef {
  name: string;
  type: ParamType;
  label?: string;
  default?: string | number | boolean;
  required?: boolean;
  options?: Array<{ value: string; label?: string }>;
}

export interface ScriptInfo {
  id: string;
  name: string;
  icon?: string;
  category: ScriptCategory;
  tags: string[];
  riskLevel: ScriptRisk;
  description?: string;
  content: string;
  parameters: ParamDef[];
  runCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface HostInfo {
  id: string;
  name: string;
  host?: string;
}

export interface PreviewResponse {
  ok: boolean;
  renderedCommand: string;
  params: Record<string, unknown>;
  riskLevel: ScriptRisk;
  warnings: string[];
}

export interface RunSingleResponse {
  ok: boolean;
  status: RunStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  runId?: number;
  hostId?: string;
  hostName?: string;
}

export interface RunBatchResponse {
  ok: boolean;
  total: number;
  success: number;
  failed: number;
  results: RunSingleResponse[];
}

export interface ScriptsListResponse {
  ok: boolean;
  scripts: ScriptInfo[];
}

export interface HostsListResponse {
  hosts: HostInfo[];
  warnings?: Record<string, unknown>;
}

export interface AiGenerateResponse {
  ok: boolean;
  script?: Partial<ScriptInfo>;
  error?: string;
}

export interface RunHistoryEntry {
  runId: number;
  scriptId: string;
  scriptName?: string;
  hostId: string;
  hostName?: string;
  status: RunStatus;
  exitCode?: number | null;
  durationMs?: number | null;
  startedAt?: string;
  renderedCommand?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface RunHistoryResponse {
  ok: boolean;
  runs: RunHistoryEntry[];
  total: number;
}

// ── Playbook / Workflow (迭代 2) ────────────────────────────────
export interface WorkflowStep {
  scriptId: string;
  scriptName?: string;
  hostId?: string;
  params?: Record<string, unknown>;
  stopOnFail?: boolean;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  steps: WorkflowStep[];
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowsListResponse {
  ok: boolean;
  workflows: WorkflowInfo[];
}

export interface WorkflowSaveResponse {
  ok: boolean;
  workflow: WorkflowInfo;
}

export interface WorkflowRun {
  status: RunStatus;
  completedSteps: number;
  totalSteps: number;
  error?: string;
}

export interface WorkflowRunResponse {
  ok: boolean;
  run: WorkflowRun;
}

export function makeDraftWorkflow(): WorkflowInfo {
  return {
    id: '',
    name: '',
    icon: '',
    description: '',
    steps: [],
  };
}

export function makeStep(): WorkflowStep {
  return { scriptId: '', scriptName: '', hostId: '', params: {}, stopOnFail: true };
}

export const CATEGORY_LABELS: Record<ScriptCategory, string> = {
  system:   '系统',
  docker:   'Docker',
  network:  '网络',
  backup:   '备份',
  security: '安全',
  other:    '其他',
};

export const CATEGORY_ICONS: Record<ScriptCategory, string> = {
  system: 'chart', docker: 'container', network: 'globe', backup: 'save', security: 'lock', other: 'folder',
};

export interface RiskBadge {
  text: string;
  cls: string;
}

export const RISK_BADGES: Record<ScriptRisk, RiskBadge> = {
  safe:    { text: '安全',   cls: 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30' },
  confirm: { text: '需确认', cls: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30' },
  danger:  { text: '危险',   cls: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30' },
};

export const RISK_LABEL_ACTIVE_CLS: Record<ScriptRisk, string> = {
  safe:    'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  confirm: 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10',
  danger:  'border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10',
};

export const CATEGORIES: Array<{ value: ScriptCategory | 'all'; icon: string; label: string }> = [
  { value: 'all',      icon: 'library',   label: '全部' },
  { value: 'system',   icon: 'chart',     label: '系统' },
  { value: 'docker',   icon: 'container', label: 'Docker' },
  { value: 'network',  icon: 'globe',     label: '网络' },
  { value: 'backup',   icon: 'save',      label: '备份' },
  { value: 'security', icon: 'lock',      label: '安全' },
];

export const PARAM_TYPES: ParamType[] = ['string', 'number', 'boolean', 'select'];

export const PAGE_SIZE_HISTORY = 20;

export function makeDraftScript(): ScriptInfo {
  return {
    id: '',
    name: '未命名脚本',
    icon: '',
    category: 'other',
    tags: [],
    riskLevel: 'safe',
    description: '',
    content: '#!/bin/bash\necho hello\n',
    parameters: [],
    runCount: 0,
  };
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delayMs: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// 老数据里 icon 可能是 emoji（含非 ASCII），新数据是 AppIcon 名（纯 ASCII）。
// true 表示当 emoji 字符渲染，false 表示当 AppIcon name 渲染。
export function isEmojiIcon(s: string | undefined | null): boolean {
  if (!s) return false;
  return /[^\x00-\x7F]/.test(s);
}

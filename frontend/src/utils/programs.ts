// programs.ts — Program Engine 类型定义（programs.html 迁移配套）
// 与老 programs-page.js 字段 1:1 对应

import type { RenderPayload } from '@/utils/playbooks';

export type { RenderPayload } from '@/utils/playbooks';

/* ───── Program / Instance / Run 配置 ─────────────── */

export interface TriggerDef {
  id: string;
  type: 'cron' | string;
  schedule?: string;
  action: string;
}

export interface InstanceActionDef {
  label: string;
  action: string;
  style?: 'primary' | 'success' | 'danger' | 'default';
  confirm?: string;
}

export interface ProgramInfo {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  triggers?: TriggerDef[];
  hosts?: 'all' | string[];
  instances?: InstanceInfo[];
  ui?: {
    instance_actions?: InstanceActionDef[];
  };
}

export type InstanceStatus = 'success' | 'running' | 'warning' | 'failed' | 'cancelled' | string;

export interface InstanceInfo {
  program_id: string;
  host_id: string;
  enabled?: number;
  last_status?: InstanceStatus;
  last_run_at?: string;
  last_trigger_id?: string;
}

export interface RunRecord {
  id: number;
  program_id: string;
  host_id: string;
  trigger_id: string;
  trigger_type: string;
  action: string;
  status: InstanceStatus;
  steps_completed: number;
  steps_total: number;
  started_at: string;
  finished_at?: string;
}

export interface ActiveRun {
  runId: string;
  programId: string;
  hostId: string;
  startedAt: number;
}

export interface HostInfo {
  id: string;
  name: string;
}

export interface RenderResultEntry {
  key: string;
  ts: string;
  stepId: string;
  payload: RenderPayload;
}

/* ───── Guardian Ask payload (3 子型 — programs 老版字段集合) ─────────── */

export interface AskSelectPayload {
  type: 'select';
  title?: string;
  description?: string;
  danger?: boolean;
  options?: Array<{ value: string; label?: string; description?: string }>;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AskInputPayload {
  type: 'input';
  title?: string;
  description?: string;
  danger?: boolean;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AskConfirmPayload {
  type: 'confirm';
  title?: string;
  description?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type AskPayload = AskSelectPayload | AskInputPayload | AskConfirmPayload;

export type AskAnswer =
  | { value: string; label: string }
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface CurrentAsk {
  sessionId: string;
  toolUseId: string;
  payload: AskPayload;
}

/* ───── 事件流条目 union ─────────────────────────── */

// 实时事件 Tab — run lifecycle（4 子）
export interface EvRunStarted   { type: 'run-started';   key: string; ts: string; runId: string; programId: string; hostId: string; triggerId: string; action: string }
export interface EvStepStarted  { type: 'step-started';  key: string; ts: string; runId: string; stepId: string }
export interface EvStepEnded    { type: 'step-ended';    key: string; ts: string; runId: string; stepId: string; status: string; durationMs?: number; reason?: string }
export interface EvRunEnded     { type: 'run-ended';     key: string; ts: string; runId: string; programId: string; status: string; error?: string }
export interface EvPhase        { type: 'phase';         key: string; ts: string; runId?: string; programId?: string; hostId?: string; layer?: 'L1' | 'L2' | 'L3' | string; phase?: string; stepId?: string | null; reason?: string; attempt?: number; incidentId?: string | null }
export type EventEntry = EvRunStarted | EvStepStarted | EvStepEnded | EvRunEnded | EvPhase;

// Guardian Tab — 10 子型
export interface GuSessionStarted    { type: 'session-started';    key: string; ts: string; sessionId: string; programId?: string; hostId?: string; runId?: string; stepId?: string; allowedSkills: string }
export interface GuMonitorTriggered  { type: 'monitor-triggered';  key: string; ts: string; programId?: string; hostId?: string; monitorId?: string; check?: string }
export interface GuThinking          { type: 'thinking';           key: string; ts: string; sessionId: string; turn?: number }
export interface GuThought           { type: 'thought';            key: string; ts: string; sessionId: string; text: string }
export interface GuExec              { type: 'exec';               key: string; ts: string; sessionId: string; command: string }
export interface GuExecResult        { type: 'exec-result';        key: string; ts: string; sessionId: string; exitCode?: number; durationMs?: number; stderrSnippet?: string; stdoutSnippet?: string }
export interface GuRender            { type: 'render';             key: string; ts: string; sessionId: string; level?: string; title?: string; content?: string }
export interface GuInfo              { type: 'info';               key: string; ts: string; sessionId: string; message: string }
export interface GuAsk               { type: 'ask';                key: string; ts: string; sessionId: string; payload?: { type?: string; title?: string } }
export interface GuSessionEnded      { type: 'session-ended';      key: string; ts: string; sessionId: string; resolution?: string; summary?: string; ok?: boolean }
export type GuardianEntry =
  | GuSessionStarted | GuMonitorTriggered | GuThinking | GuThought
  | GuExec | GuExecResult | GuRender | GuInfo | GuAsk | GuSessionEnded;

// L2 Skill Tab — 6 子型
export interface L2Started     { type: 'l2-started';   key: string; ts: string; sessionId: string; programId?: string; stepId?: string; skillId?: string; goal?: string; mode?: string; attempt?: number }
export interface L2Thinking    { type: 'l2-thinking';  key: string; ts: string; sessionId: string; turn?: number; mode?: string }
export interface L2Exec        { type: 'exec';         key: string; ts: string; sessionId: string; command: string }
export interface L2ExecResult  { type: 'exec-result';  key: string; ts: string; sessionId: string; exitCode?: number; durationMs?: number; stderrSnippet?: string; stdoutSnippet?: string }
export interface L2Info        { type: 'info';         key: string; ts: string; sessionId: string; message: string }
export interface L2Ended       { type: 'l2-ended';     key: string; ts: string; sessionId: string; stepId?: string; ok?: boolean; summary?: string; durationMs?: number; disposition?: string; mode?: string }
export type L2Entry = L2Started | L2Thinking | L2Exec | L2ExecResult | L2Info | L2Ended;

/* ───── 帮手 ─────────────────────────────────────── */

export function nowTs(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

let keySeq = 0;
export function nextKey(): string {
  keySeq += 1;
  return `pgk_${keySeq}`;
}

/** events / guardian / l2 流单条上限（与老版一致） */
export const STREAM_MAX = 200;

/** stat-failed 拉取窗口（与老版一致） */
export const FAILED_LOOKBACK_LIMIT = 500;

/** "受保护" 名称判断（与 shared.js _renderTable 一致，programs 也透传） */
export function isProtectedName(name: string): boolean {
  return /1shell/i.test(name);
}

/** stderr/stdout 末 160 字符（与老版一致） */
export function snippet(s: string | undefined): string {
  return (s || '').trimEnd().slice(-160);
}

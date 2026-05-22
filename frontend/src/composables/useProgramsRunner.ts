// useProgramsRunner.ts — Program Engine 控制台核心 composable
// 与 usePlaybookRunner 同套路：集中 socket 21 on + 6 emit + state + cleanup
// 1:1 沿用老 programs-page.js 行为（IIFE 933 行 → 这里 ~430 行）

import { computed, ref, shallowRef, onMounted, onBeforeUnmount, watch } from 'vue';
import { useSocket, bindHandlers, type SocketHandler } from '@/composables/useSocket';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import {
  type ProgramInfo,
  type InstanceInfo,
  type RunRecord,
  type ActiveRun,
  type HostInfo,
  type RenderResultEntry,
  type RenderPayload,
  type AskPayload,
  type AskAnswer,
  type CurrentAsk,
  type ProgramInputDef,
  type ProgramResidualInfo,
  type EventEntry,
  type GuardianEntry,
  type L2Entry,
  nowTs, nextKey, snippet, STREAM_MAX, FAILED_LOOKBACK_LIMIT,
} from '@/utils/programs';

export type TabKey = 'instances' | 'results' | 'runs' | 'events' | 'l2' | 'guardian';

interface GuardianSessionLink {
  sessionId: string;
  programId?: string;
  hostId?: string;
  runId?: string;
}

interface AckResponse { ok?: boolean; error?: string; unlimitedTurns?: boolean; runIds?: number[] }
interface ProgramRunRequest { program: ProgramInfo; hostId: string; actionName?: string }

interface ProgramsPrefs {
  activeProgramId: string | null;
  currentTab: TabKey;
  guardianUnlimited: boolean;
  l2Unlimited: boolean;
}

interface ProgramsCache {
  programs: ProgramInfo[];
  residualPrograms: ProgramResidualInfo[];
  hosts: HostInfo[];
  activeRuns: ActiveRun[];
  statFailed24h: number | null;
}

const PROGRAMS_PREFS_KEY = '1shell.programs.prefs.v1';
const PROGRAMS_CACHE_KEY = 'programs.page.cache.v1';
const PROGRAMS_CACHE_TTL_MS = 45_000;

export function useProgramsRunner() {
  const socket = useSocket();
  const { requestJson } = useApiClient();
  const { confirm } = useConfirm();
  const notify = useNotifyStore();

  /* ─── state ───────────────────────────────────────── */
  const savedPrefs = readStorageState<ProgramsPrefs>(PROGRAMS_PREFS_KEY, {
    activeProgramId: null,
    currentTab: 'instances',
    guardianUnlimited: false,
    l2Unlimited: false,
  });
  const programs = shallowRef<ProgramInfo[]>([]);
  const residualPrograms = shallowRef<ProgramResidualInfo[]>([]);
  const hosts = shallowRef<HostInfo[]>([]);
  const activeProgramId = ref<string | null>(savedPrefs.activeProgramId);
  const currentTab = ref<TabKey>(savedPrefs.currentTab);

  // 共享 Map：L2 和 Guardian 复用同一个（1:1 沿用 programs-page.js 第 270/295 行）
  const activeRuns = shallowRef<ActiveRun[]>([]);
  const guardianSessions = shallowRef<GuardianSessionLink[]>([]);

  // 4 个流（shallowRef + 整体替换 + STREAM_MAX 截断）
  const eventEntries = shallowRef<EventEntry[]>([]);
  const guardianEntries = shallowRef<GuardianEntry[]>([]);
  const l2Entries = shallowRef<L2Entry[]>([]);
  const resultEntries = shallowRef<RenderResultEntry[]>([]);
  const resultsHostLabel = ref<string | null>(null);

  // Unlimited turns + AI 改进按钮状态
  const guardianUnlimited = ref(savedPrefs.guardianUnlimited);
  const l2Unlimited = ref(savedPrefs.l2Unlimited);
  const improveBtnPending = ref(false);
  const programRunRequest = ref<ProgramRunRequest | null>(null);

  // L2 改进所需的最近一次执行日志
  const lastL2Log = ref<L2Entry[]>([]);
  const lastL2Meta = ref<{ programId: string; stepId: string; skillId: string; goal: string } | null>(null);

  // Guardian ask modal
  const currentAsk = ref<CurrentAsk | null>(null);

  // 24h failed 数（null 表示未加载/失败 → 显 "—"）
  const statFailed24h = ref<number | null>(null);

  function saveProgramsPrefs(): void {
    writeStorageState<ProgramsPrefs>(PROGRAMS_PREFS_KEY, {
      activeProgramId: activeProgramId.value,
      currentTab: currentTab.value,
      guardianUnlimited: guardianUnlimited.value,
      l2Unlimited: l2Unlimited.value,
    });
  }

  function saveProgramsCache(): void {
    setCachedPageState<ProgramsCache>(PROGRAMS_CACHE_KEY, {
      programs: programs.value,
      residualPrograms: residualPrograms.value,
      hosts: hosts.value,
      activeRuns: activeRuns.value,
      statFailed24h: statFailed24h.value,
    });
  }

  function restoreProgramsCache(): boolean {
    const entry = getCachedPageState<ProgramsCache>(PROGRAMS_CACHE_KEY);
    if (!entry) return false;
    programs.value = entry.value.programs || [];
    residualPrograms.value = entry.value.residualPrograms || [];
    hosts.value = entry.value.hosts || [];
    activeRuns.value = entry.value.activeRuns || [];
    statFailed24h.value = entry.value.statFailed24h ?? null;
    return true;
  }

  // 30 秒兜底
  let improveTimer: ReturnType<typeof setTimeout> | null = null;

  /* ─── computed ─────────────────────────────────────── */
  const statPrograms = computed(() => programs.value.length);
  const statEnabled = computed(() =>
    programs.value.flatMap((p) => p.instances || []).filter((i) => i.enabled === 1).length
  );
  const statActive = computed(() => activeRuns.value.length);

  const activeProgram = computed<ProgramInfo | null>(() =>
    programs.value.find((p) => p.id === activeProgramId.value) || null
  );

  function isInstanceActive(programId: string, hostId: string): boolean {
    return activeRuns.value.some((r) => r.programId === programId && r.hostId === hostId);
  }

  /* ─── stream helpers（每个独立 200 上限 + prepend 最新） ─── */

  function appendStream<T>(
    list: { value: T[] },
    item: T,
    max = STREAM_MAX,
  ): void {
    const next = [item, ...list.value];
    list.value = next.length > max ? next.slice(0, max) : next;
  }

  function pushEvent(ev: EventEntry): void {
    // 过滤：当前 program 匹配时才显示（与老版 pushEvent 一致 — programId 在 run-started/run-ended 上判）
    if (activeProgramId.value && 'programId' in ev && ev.programId && ev.programId !== activeProgramId.value) return;
    appendStream(eventEntries, ev);
  }

  function pushGuardian(ev: GuardianEntry): void {
    // 按 sessionId → guardianSessions → programId 过滤
    if (activeProgramId.value) {
      if ('sessionId' in ev) {
        const ses = guardianSessions.value.find((s) => s.sessionId === ev.sessionId);
        if (ses && ses.programId && ses.programId !== activeProgramId.value) return;
      } else if ('programId' in ev && ev.programId && ev.programId !== activeProgramId.value) {
        return;
      }
    }
    appendStream(guardianEntries, ev);
  }

  function pushL2(ev: L2Entry): void {
    // L2 改进日志收集（任何 L2 事件都 push，包括 thinking/info；与老版 line 784 一致）
    if (ev.type === 'l2-started') {
      lastL2Log.value = [];
      lastL2Meta.value = {
        programId: ev.programId || '',
        stepId: ev.stepId || '',
        skillId: ev.skillId || '',
        goal: ev.goal || '',
      };
    }
    lastL2Log.value = [...lastL2Log.value, ev];

    if (activeProgramId.value) {
      const ses = guardianSessions.value.find((s) => s.sessionId === ev.sessionId);
      if (ses && ses.programId && ses.programId !== activeProgramId.value) return;
    }
    appendStream(l2Entries, ev);
  }

  function pushResult(programId: string, hostId: string, stepId: string, payload: RenderPayload): void {
    // 老版 pushResult 内有"activeProgramId 必须匹配"的隐式过滤 — 调用方各处都判过
    if (activeProgramId.value && programId !== activeProgramId.value) return;
    const entry: RenderResultEntry = {
      key: nextKey(),
      ts: nowTs(),
      stepId: stepId || '',
      payload,
    };
    // 结果是追加在末尾（与老版 append 一致，不像 events 是 prepend）
    resultEntries.value = [...resultEntries.value, entry];
  }

  function clearResults(hostId?: string): void {
    resultEntries.value = [];
    if (hostId) {
      const host = hosts.value.find((h) => h.id === hostId);
      resultsHostLabel.value = `主机：${host ? host.name : hostId}`;
    }
  }

  /* ─── socket handlers (21 on) ──────────────────────── */

  const handlers: SocketHandler[] = [
    /* Program lifecycle (5) */
    ['program:run-started', (msg: unknown) => {
      const m = msg as { runId: string; programId: string; hostId: string; triggerId: string; action: string };
      activeRuns.value = [...activeRuns.value, {
        runId: m.runId, programId: m.programId, hostId: m.hostId, startedAt: Date.now(),
      }];
      pushEvent({
        type: 'run-started', key: nextKey(), ts: nowTs(),
        runId: m.runId, programId: m.programId, hostId: m.hostId,
        triggerId: m.triggerId, action: m.action,
      });
      if (m.programId === activeProgramId.value) {
        clearResults(m.hostId);
        if (currentTab.value === 'instances') refreshInstances().catch(() => {});
      }
    }],
    ['program:render', (msg: unknown) => {
      const m = msg as { programId: string; hostId: string; stepId: string; payload: RenderPayload };
      if (m.programId !== activeProgramId.value) return;
      pushResult(m.programId, m.hostId, m.stepId, m.payload);
      if (currentTab.value === 'events' || currentTab.value === 'instances') {
        currentTab.value = 'results';
      }
    }],
    ['program:step-started', (msg: unknown) => {
      const m = msg as { runId: string; programId?: string; stepId: string };
      pushEvent({
        type: 'step-started', key: nextKey(), ts: nowTs(),
        runId: m.runId, stepId: m.stepId,
      });
    }],
    ['program:step-ended', (msg: unknown) => {
      const m = msg as { runId: string; programId?: string; stepId: string; status: string; durationMs?: number; reason?: string };
      pushEvent({
        type: 'step-ended', key: nextKey(), ts: nowTs(),
        runId: m.runId, stepId: m.stepId, status: m.status,
        durationMs: m.durationMs, reason: m.reason,
      });
    }],
    ['program:phase', (msg: unknown) => {
      const m = msg as { runId?: string; programId?: string; hostId?: string; layer?: string; phase?: string; stepId?: string | null; reason?: string; attempt?: number; incidentId?: string | null; escalationId?: string | null };
      pushEvent({
        type: 'phase', key: nextKey(), ts: nowTs(),
        runId: m.runId, programId: m.programId, hostId: m.hostId,
        layer: m.layer, phase: m.phase, stepId: m.stepId,
        reason: m.reason, attempt: m.attempt, incidentId: m.incidentId,
        escalationId: m.escalationId,
      });
    }],
    ['program:run-ended', (msg: unknown) => {
      const m = msg as { runId: string; programId: string; status: string; error?: string };
      activeRuns.value = activeRuns.value.filter((r) => r.runId !== m.runId);
      pushEvent({
        type: 'run-ended', key: nextKey(), ts: nowTs(),
        runId: m.runId, programId: m.programId, status: m.status, error: m.error,
      });
      if (m.programId === activeProgramId.value) {
        if (currentTab.value === 'instances') refreshInstances().catch(() => {});
        if (currentTab.value === 'runs') refreshRuns().catch(() => {});
      }
    }],

    /* Guardian (9) */
    ['guardian:session-started', (msg: unknown) => {
      const m = msg as { sessionId: string; programId?: string; hostId?: string; runId?: string; failingStep?: { id?: string }; allowedSkills?: Array<{ id: string }> };
      guardianSessions.value = [...guardianSessions.value, {
        sessionId: m.sessionId, programId: m.programId, hostId: m.hostId, runId: m.runId,
      }];
      const allowed = (m.allowedSkills || []).map((s) => s.id).join(', ');
      pushGuardian({
        type: 'session-started', key: nextKey(), ts: nowTs(),
        sessionId: m.sessionId, programId: m.programId, hostId: m.hostId, runId: m.runId,
        stepId: m.failingStep?.id,
        allowedSkills: allowed || '（无白名单）',
      });
    }],
    ['guardian:thinking', (msg: unknown) => {
      const m = msg as { sessionId: string; turn?: number };
      pushGuardian({ type: 'thinking', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, turn: m.turn });
    }],
    ['guardian:thought', (msg: unknown) => {
      const m = msg as { sessionId: string; text?: string };
      pushGuardian({ type: 'thought', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, text: m.text || '' });
    }],
    ['guardian:exec', (msg: unknown) => {
      const m = msg as { sessionId: string; command?: string };
      pushGuardian({ type: 'exec', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, command: m.command || '' });
    }],
    ['guardian:exec-result', (msg: unknown) => {
      const m = msg as { sessionId: string; exitCode?: number; durationMs?: number; stderr?: string; stdout?: string };
      pushGuardian({
        type: 'exec-result', key: nextKey(), ts: nowTs(), sessionId: m.sessionId,
        exitCode: m.exitCode, durationMs: m.durationMs,
        stderrSnippet: snippet(m.stderr), stdoutSnippet: snippet(m.stdout),
      });
    }],
    ['guardian:render', (msg: unknown) => {
      const m = msg as { sessionId: string; programId?: string; hostId?: string; payload?: { level?: string; title?: string; content?: string; subtitle?: string } };
      const p = m.payload || {};
      pushGuardian({
        type: 'render', key: nextKey(), ts: nowTs(), sessionId: m.sessionId,
        level: p.level || 'info',
        title: p.title || '(render)',
        content: p.content || p.subtitle || '',
      });
      // 同步推到 results 流（双轨）
      if (m.programId && m.hostId) {
        pushResult(m.programId, m.hostId, 'guardian', m.payload as RenderPayload);
      }
    }],
    ['guardian:info', (msg: unknown) => {
      const m = msg as { sessionId: string; message?: string };
      pushGuardian({ type: 'info', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, message: m.message || '' });
    }],
    ['guardian:ask', (msg: unknown) => {
      const m = msg as { sessionId: string; toolUseId: string; payload?: AskPayload };
      pushGuardian({
        type: 'ask', key: nextKey(), ts: nowTs(), sessionId: m.sessionId,
        payload: m.payload ? { type: m.payload.type, title: m.payload.title } : undefined,
      });
      if (m.payload) {
        currentAsk.value = { sessionId: m.sessionId, toolUseId: m.toolUseId, payload: m.payload };
      }
    }],
    ['guardian:session-ended', (msg: unknown) => {
      const m = msg as { sessionId: string; resolution?: string; summary?: string; ok?: boolean };
      guardianSessions.value = guardianSessions.value.filter((s) => s.sessionId !== m.sessionId);
      pushGuardian({
        type: 'session-ended', key: nextKey(), ts: nowTs(), sessionId: m.sessionId,
        resolution: m.resolution, summary: m.summary, ok: m.ok,
      });
      // session 结束时若 modal 是这个 session 自动关
      if (currentAsk.value?.sessionId === m.sessionId) {
        currentAsk.value = null;
      }
    }],

    /* L2 Skill (6) */
    ['program:l2:started', (msg: unknown) => {
      const m = msg as { sessionId: string; programId?: string; hostId?: string; runId?: string; stepId?: string; skillId?: string; goal?: string; mode?: string; attempt?: number };
      // L2 和 Guardian 共用同一 Map（1:1 沿用）
      guardianSessions.value = [...guardianSessions.value, {
        sessionId: m.sessionId, programId: m.programId, hostId: m.hostId, runId: m.runId,
      }];
      pushL2({
        type: 'l2-started', key: nextKey(), ts: nowTs(),
        sessionId: m.sessionId, programId: m.programId,
        stepId: m.stepId, skillId: m.skillId, goal: m.goal,
        mode: m.mode, attempt: m.attempt,
      });
    }],
    ['program:l2:thinking', (msg: unknown) => {
      const m = msg as { sessionId: string; turn?: number };
      pushL2({ type: 'l2-thinking', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, turn: m.turn });
    }],
    ['program:l2:exec', (msg: unknown) => {
      const m = msg as { sessionId: string; command?: string };
      pushL2({ type: 'exec', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, command: m.command || '' });
    }],
    ['program:l2:exec-result', (msg: unknown) => {
      const m = msg as { sessionId: string; exitCode?: number; durationMs?: number; stderr?: string; stdout?: string };
      pushL2({
        type: 'exec-result', key: nextKey(), ts: nowTs(), sessionId: m.sessionId,
        exitCode: m.exitCode, durationMs: m.durationMs,
        stderrSnippet: snippet(m.stderr), stdoutSnippet: snippet(m.stdout),
      });
    }],
    ['program:l2:info', (msg: unknown) => {
      const m = msg as { sessionId: string; message?: string };
      pushL2({ type: 'info', key: nextKey(), ts: nowTs(), sessionId: m.sessionId, message: m.message || '' });
    }],
    ['program:l2:ended', (msg: unknown) => {
      const m = msg as { sessionId: string; stepId?: string; ok?: boolean; summary?: string; durationMs?: number; disposition?: string; mode?: string };
      guardianSessions.value = guardianSessions.value.filter((s) => s.sessionId !== m.sessionId);
      pushL2({
        type: 'l2-ended', key: nextKey(), ts: nowTs(), sessionId: m.sessionId,
        stepId: m.stepId, ok: m.ok, summary: m.summary, durationMs: m.durationMs,
        disposition: m.disposition, mode: m.mode,
      });
    }],

    /* L3 Monitor (1) */
    ['program:monitor-triggered', (msg: unknown) => {
      const m = msg as { programId?: string; hostId?: string; monitorId?: string; check?: string };
      pushGuardian({
        type: 'monitor-triggered', key: nextKey(), ts: nowTs(),
        programId: m.programId, hostId: m.hostId, monitorId: m.monitorId, check: m.check,
      });
    }],
  ];

  /* ─── 数据加载 / API ──────────────────────────────── */

  async function loadPrograms(): Promise<void> {
    try {
      const data = await requestJson<{ programs: ProgramInfo[]; residuals?: ProgramResidualInfo[] }>('/api/programs');
      programs.value = data.programs || [];
      residualPrograms.value = data.residuals || [];
      saveProgramsCache();
    } catch (err) {
      notify.error((err as Error).message || '加载 Programs 失败');
      programs.value = [];
      residualPrograms.value = [];
    }
  }

  async function loadHosts(): Promise<void> {
    try {
      const data = await requestJson<{ hosts?: HostInfo[] } | HostInfo[]>('/api/hosts');
      hosts.value = Array.isArray(data) ? data : (data.hosts || []);
      saveProgramsCache();
    } catch {
      hosts.value = [];
    }
  }

  async function loadActiveRuns(): Promise<void> {
    try {
      const data = await requestJson<{ runs?: ActiveRun[] }>('/api/program-runs/active');
      activeRuns.value = (data.runs || []).map((r) => ({
        runId: r.runId, programId: r.programId, hostId: r.hostId, startedAt: Date.now(),
      }));
      saveProgramsCache();
    } catch { /* 静默 */ }
  }

  async function reloadAll(): Promise<void> {
    try {
      const data = await requestJson<{ residuals?: ProgramResidualInfo[] }>('/api/programs/reload', { method: 'POST' });
      residualPrograms.value = data.residuals || [];
      notify.success('已重扫 data/programs/');
      await loadPrograms();
      if (activeProgramId.value) await refreshDetail();
      await updateStats();
    } catch (err) {
      notify.error((err as Error).message || '重扫失败');
    }
  }

  async function refreshAll(): Promise<void> {
    await loadPrograms();
    if (activeProgramId.value) await refreshDetail();
    await loadActiveRuns();
    await updateStats();
  }

  async function refreshDetail(): Promise<void> {
    if (!activeProgramId.value) return;
    try {
      const data = await requestJson<{ ok: boolean; program: ProgramInfo; instances: InstanceInfo[] }>(
        `/api/programs/${encodeURIComponent(activeProgramId.value)}`,
      );
      if (data.ok) {
        const next = programs.value.slice();
        const idx = next.findIndex((p) => p.id === activeProgramId.value);
        if (idx >= 0) {
          next[idx] = { ...data.program, instances: data.instances };
          programs.value = next;
        }
      }
    } catch (err) {
      notify.error((err as Error).message || '加载详情失败');
    }
  }

  async function refreshInstances(): Promise<void> {
    if (!activeProgramId.value) return;
    try {
      const data = await requestJson<{ ok: boolean; instances: InstanceInfo[] }>(
        `/api/programs/${encodeURIComponent(activeProgramId.value)}/instances`,
      );
      if (data.ok) {
        const next = programs.value.slice();
        const idx = next.findIndex((p) => p.id === activeProgramId.value);
        if (idx >= 0) {
          next[idx] = { ...next[idx], instances: data.instances || [] };
          programs.value = next;
        }
      }
    } catch { /* 静默 */ }
  }

  async function refreshRuns(): Promise<RunRecord[]> {
    if (!activeProgramId.value) return [];
    try {
      const data = await requestJson<{ runs?: RunRecord[] }>(
        `/api/program-runs?programId=${encodeURIComponent(activeProgramId.value)}&limit=100`,
      );
      return data.runs || [];
    } catch (err) {
      notify.error((err as Error).message || '加载运行历史失败');
      return [];
    }
  }

  async function loadLastRenders(programId: string): Promise<void> {
    const p = programs.value.find((x) => x.id === programId);
    if (!p) return;
    const hostIds: string[] = p.hosts === 'all'
      ? hosts.value.map((h) => h.id)
      : (Array.isArray(p.hosts) ? p.hosts : []);
    for (const hostId of hostIds) {
      try {
        const data = await requestJson<{ ok: boolean; renders?: Array<{ stepId: string; payload: RenderPayload }> }>(
          `/api/programs/${encodeURIComponent(programId)}/instances/${encodeURIComponent(hostId)}/renders`,
        );
        if (data.ok && Array.isArray(data.renders) && data.renders.length > 0) {
          clearResults(hostId);
          for (const item of data.renders) {
            pushResult(programId, hostId, item.stepId, item.payload);
          }
          if (resultsHostLabel.value) {
            resultsHostLabel.value = resultsHostLabel.value + ' (歷史數據)';
          }
          return; // 找到第一个有数据的主机即停止
        }
      } catch { /* 忽略单主机失败 */ }
    }
  }

  function inputsForAction(program: ProgramInfo, actionName?: string): ProgramInputDef[] {
    return [...(program.inputs || []), ...(actionName ? program.actions?.[actionName]?.inputs || [] : [])];
  }

  async function runProgram(programId: string, hostId: string, actionName?: string, inputs?: Record<string, unknown>): Promise<void> {
    try {
      const body: Record<string, unknown> = { hostId };
      if (actionName) body.actionName = actionName;
      if (inputs) body.inputs = inputs;
      const res = await requestJson<AckResponse>(
        `/api/programs/${encodeURIComponent(programId)}/trigger`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      notify.success(`已触发（run #${(res.runIds || []).join(', ')}）`);
      programRunRequest.value = null;
    } catch (err) {
      notify.error((err as Error).message || '触发失败');
    }
  }

  async function triggerInstance(programId: string, hostId: string, actionName?: string, inputs?: Record<string, unknown>): Promise<void> {
    const program = programs.value.find((item) => item.id === programId);
    if (inputs) {
      await runProgram(programId, hostId, actionName, inputs);
      return;
    }
    if (program && inputsForAction(program, actionName).length > 0) {
      programRunRequest.value = { program, hostId, actionName };
      return;
    }
    await runProgram(programId, hostId, actionName);
  }

  async function submitProgramRunInputs(inputs: Record<string, unknown>): Promise<void> {
    const request = programRunRequest.value;
    if (!request) return;
    await runProgram(request.program.id, request.hostId, request.actionName, inputs);
  }

  function cancelProgramRunInputs(): void {
    programRunRequest.value = null;
  }

  async function toggleInstance(programId: string, hostId: string, enable: boolean): Promise<void> {
    const endpoint = enable ? 'enable' : 'disable';
    try {
      await requestJson(
        `/api/programs/${encodeURIComponent(programId)}/instances/${encodeURIComponent(hostId)}/${endpoint}`,
        { method: 'POST' },
      );
      notify.success(enable ? '已启用' : '已停用');
      await refreshDetail();
    } catch (err) {
      notify.error((err as Error).message || (enable ? '启用失败' : '停用失败'));
    }
  }

  async function deleteResidualProgram(id: string): Promise<void> {
    const item = residualPrograms.value.find((entry) => entry.id === id);
    const ok = await confirm({
      title: '删除残留 Program',
      message: `确认删除残留 Program「${id}」？\n\n该 Program 当前无法加载，将删除 data/programs/${id}/ 目录。`,
      okText: '删除',
    });
    if (!ok) return;
    try {
      const data = await requestJson<{ residuals?: ProgramResidualInfo[] }>(`/api/program-residuals/${encodeURIComponent(id)}`, { method: 'DELETE' });
      residualPrograms.value = data.residuals || residualPrograms.value.filter((entry) => entry.id !== id);
      await loadPrograms();
      notify.success(`残留 Program「${item?.id || id}」已删除`);
    } catch (err) {
      notify.error((err as Error).message || '删除残留 Program 失败');
    }
  }

  async function deleteProgram(id: string, name: string): Promise<void> {
    const ok = await confirm({
      title: '删除 Program',
      message: `确认删除 Program「${name}」？\n\n此操作会删除 data/programs/${id}/ 目录下的所有文件，不可撤销。`,
      okText: '删除',
    });
    if (!ok) return;
    try {
      await requestJson(`/api/programs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (activeProgramId.value === id) activeProgramId.value = null;
      await loadPrograms();
      notify.success(`Program「${name}」已删除`);
    } catch (err) {
      notify.error((err as Error).message || '删除失败');
    }
  }

  async function updateStats(): Promise<void> {
    try {
      const data = await requestJson<{ runs?: RunRecord[] }>(
        `/api/program-runs?limit=${FAILED_LOOKBACK_LIMIT}`,
      );
      const since = Date.now() - 86400000;
      statFailed24h.value = (data.runs || []).filter((r) =>
        r.status === 'failed' && new Date(r.started_at).getTime() >= since,
      ).length;
      saveProgramsCache();
    } catch {
      statFailed24h.value = null;
    }
  }

  /* ─── selectProgram / Tab 切换 ─────────────────────── */

  function selectProgram(id: string): void {
    activeProgramId.value = id;
    resultEntries.value = [];
    resultsHostLabel.value = null;
    currentTab.value = 'instances';
    saveProgramsPrefs();
    // 异步载入历史 renders（不阻塞）
    loadLastRenders(id).catch(() => {});
  }

  function switchTab(tab: TabKey): void {
    currentTab.value = tab;
    saveProgramsPrefs();
  }

  /* ─── Unlimited turns 同步 ────────────────────────── */

  function initUnlimitedTurns(): void {
    socket.emit('guardian:get-unlimited-turns', {}, (ack: AckResponse) => {
      if (ack?.ok) guardianUnlimited.value = !!ack.unlimitedTurns;
    });
    socket.emit('l2:get-unlimited-turns', {}, (ack: AckResponse) => {
      if (ack?.ok) l2Unlimited.value = !!ack.unlimitedTurns;
    });
  }

  function setGuardianUnlimited(enabled: boolean): void {
    guardianUnlimited.value = enabled;
    saveProgramsPrefs();
    socket.emit('guardian:set-unlimited-turns', { enabled }, () => {});
  }

  function setL2Unlimited(enabled: boolean): void {
    l2Unlimited.value = enabled;
    saveProgramsPrefs();
    socket.emit('l2:set-unlimited-turns', { enabled }, () => {});
  }

  /* ─── L2 AI 改进 ──────────────────────────────────── */

  function requestL2Improve(): void {
    if (!lastL2Meta.value || lastL2Log.value.length === 0) {
      notify.warn('还没有 L2 执行记录，请先运行一次 Program。');
      return;
    }
    const execEntries = lastL2Log.value
      .filter((e) => e.type === 'exec' || e.type === 'exec-result')
      .map((e) => {
        if (e.type === 'exec') return `→ ${e.command}`;
        const ok = e.exitCode === 0;
        return `${ok ? '✓' : '✗'} exit=${e.exitCode} ${e.durationMs}ms${e.stderrSnippet ? ' err:' + e.stderrSnippet : ''}`;
      })
      .join('\n');

    currentTab.value = 'l2';
    improveBtnPending.value = true;

    const payload = {
      programId: lastL2Meta.value.programId,
      hostId: 'local',
      skillId: lastL2Meta.value.skillId,
      goal: lastL2Meta.value.goal,
      execLog: execEntries || '(无日志)',
    };

    socket.emit('l2:improve', payload, (ack: AckResponse) => {
      if (ack && !ack.ok) {
        notify.error('改进启动失败: ' + (ack.error || '未知错误'));
        improveBtnPending.value = false;
      }
    });

    // 30 秒兜底
    if (improveTimer) clearTimeout(improveTimer);
    improveTimer = setTimeout(() => {
      improveBtnPending.value = false;
      improveTimer = null;
    }, 30000);
  }

  /* ─── Guardian ask 模态 ───────────────────────────── */

  function answerAsk(answer: AskAnswer): void {
    if (!currentAsk.value) return;
    const { sessionId, toolUseId } = currentAsk.value;
    socket.emit('guardian:answer', { sessionId, toolUseId, answer }, () => {});
    currentAsk.value = null;
  }

  function cancelAsk(): void {
    if (!currentAsk.value) {
      currentAsk.value = null;
      return;
    }
    const { sessionId, toolUseId, payload } = currentAsk.value;
    const type = payload.type || 'confirm';
    const answer: AskAnswer = type === 'confirm'
      ? { confirmed: false }
      : { cancelled: true };
    socket.emit('guardian:answer', { sessionId, toolUseId, answer }, () => {});
    currentAsk.value = null;
  }

  /* ─── 生命周期 ────────────────────────────────────── */

  const cleanup = bindHandlers(socket, handlers);

  watch([activeProgramId, currentTab], saveProgramsPrefs);

  onMounted(async () => {
    const restored = restoreProgramsCache();
    initUnlimitedTurns();
    if (!restored || !isPageStateFresh(PROGRAMS_CACHE_KEY, PROGRAMS_CACHE_TTL_MS)) {
      await Promise.all([loadPrograms(), loadHosts()]);
      await loadActiveRuns();
      await updateStats();
    }
  });

  onBeforeUnmount(() => {
    cleanup();
    if (improveTimer) clearTimeout(improveTimer);
  });

  return {
    /* state (readonly via ref) */
    programs, residualPrograms, hosts, activeProgramId, activeProgram, currentTab,
    activeRuns, isInstanceActive,
    eventEntries, guardianEntries, l2Entries, resultEntries, resultsHostLabel,
    guardianUnlimited, l2Unlimited, improveBtnPending,
    programRunRequest,
    lastL2Log, lastL2Meta, currentAsk,
    statPrograms, statEnabled, statActive, statFailed24h,
    /* methods */
    selectProgram, switchTab,
    reloadAll, refreshAll, refreshDetail, refreshInstances, refreshRuns, loadLastRenders,
    triggerInstance, submitProgramRunInputs, cancelProgramRunInputs,
    toggleInstance, deleteProgram, deleteResidualProgram, updateStats,
    setGuardianUnlimited, setL2Unlimited, requestL2Improve,
    answerAsk, cancelAsk,
  };
}

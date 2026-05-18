'use strict';

/**
 * Program Engine — 长驻程序调度与三层执行状态机
 *
 * L1：确定性 exec/render。
 * L2：Program 绑定 Skill 下的维护/AI 功能层。
 * L3：危机升级层，只由 incident、L2 越界/高风险/需人工、重复失败或显式升级触发。
 */

const cron = require('node-cron');
const { checkVerify, checkWhen, DEFAULT_STEP_TIMEOUT_MS } = require('../skills/playbook-schema');
const {
  normalizeL2Disposition,
  shouldEscalateToL3,
  buildEscalationReason,
} = require('./escalation-policy');

function createProgramEngine({
  registry,
  stateService,
  bridgeService,
  hostService,
  auditService,
  logger,
  io,
  guardianService,
  skillStepExecutor,
}) {
  const scheduledTasks = new Map();
  const runningInstances = new Map();
  const activeRuns = new Map();
  let started = false;

  function start() {
    if (started) return;
    started = true;
    scheduleAll();
    logger?.info?.('[program-engine] started', {
      programs: registry.list().length,
      scheduled: totalScheduled(),
    });
  }

  function stop() {
    for (const tasks of scheduledTasks.values()) {
      for (const t of tasks) { try { t.stop(); } catch { /* ignore */ } }
    }
    scheduledTasks.clear();
    for (const run of activeRuns.values()) run.cancelled = true;
    started = false;
  }

  function reload() {
    stop();
    const result = registry.reload();
    start();
    return result;
  }

  function totalScheduled() {
    let n = 0;
    for (const tasks of scheduledTasks.values()) n += tasks.length;
    return n;
  }

  function scheduleAll() {
    for (const program of registry.list()) scheduleProgram(program);
  }

  function scheduleProgram(program) {
    if (!program.enabled) return;
    const tasks = [];
    const hostIds = resolveHosts(program);

    for (const trigger of program.triggers) {
      if (trigger.type !== 'cron') continue;
      for (const hostId of hostIds) {
        if (!stateService.isEnabled(program.id, hostId)) continue;
        const task = cron.schedule(trigger.schedule, () => {
          runInstance(program, hostId, trigger, { triggerType: 'cron' })
            .catch((err) => logger?.error?.('[program-engine] cron run error', {
              programId: program.id, hostId, triggerId: trigger.id, error: err.message,
            }));
        }, { scheduled: true, timezone: process.env.TZ });
        tasks.push(task);
      }
    }

    if (Array.isArray(program.monitors) && program.monitors.length > 0) {
      for (const monitor of program.monitors) {
        for (const hostId of hostIds) {
          if (!stateService.isEnabled(program.id, hostId)) continue;
          const task = cron.schedule(monitor.interval, () => {
            runMonitorCheck(program, hostId, monitor)
              .catch((err) => logger?.error?.('[program-engine] monitor error', {
                programId: program.id, hostId, monitorId: monitor.id, error: err.message,
              }));
          }, { scheduled: true, timezone: process.env.TZ });
          tasks.push(task);
        }
      }
    }

    if (tasks.length > 0) scheduledTasks.set(program.id, tasks);
  }

  function resolveHosts(program) {
    if (program.hosts === 'all') {
      const all = hostService.listHosts?.() || [];
      return all.map((h) => h.id);
    }
    return program.hosts;
  }

  async function triggerManual({ programId, hostId, triggerId, actionName }) {
    const program = registry.get(programId);
    if (!program) throw new Error(`Program 不存在: ${programId}`);

    let trigger;
    if (triggerId) {
      trigger = program.triggers.find((t) => t.id === triggerId);
      if (!trigger) throw new Error(`Trigger 不存在: ${triggerId}`);
    } else if (actionName) {
      if (!program.actions[actionName]) throw new Error(`Action 不存在: ${actionName}`);
      trigger = { id: `manual:${actionName}`, type: 'manual', action: actionName };
    } else {
      trigger = program.triggers.find((t) => t.type === 'manual') || program.triggers[0];
    }

    const hostIds = hostId === 'all' ? resolveHosts(program) : [hostId || resolveHosts(program)[0]];
    const runIds = [];
    for (const hid of hostIds) {
      const runId = await runInstance(program, hid, trigger, { triggerType: 'manual' });
      if (runId) runIds.push(runId);
    }
    return runIds;
  }

  async function runInstance(program, hostId, trigger, { triggerType }) {
    const lockKey = `${program.id}::${hostId}`;
    if (runningInstances.has(lockKey)) {
      logger?.warn?.('[program-engine] instance busy, skip', { programId: program.id, hostId });
      return null;
    }

    const action = program.actions[trigger.action];
    if (!action) {
      logger?.error?.('[program-engine] action missing', { programId: program.id, action: trigger.action });
      return null;
    }

    const runId = stateService.recordRunStart({
      programId: program.id,
      hostId,
      triggerId: trigger.id,
      triggerType,
      action: trigger.action,
    });
    runningInstances.set(lockKey, runId);

    const runState = {
      cancelled: false,
      programId: program.id,
      hostId,
      stepOutputs: new Map(),
      renderPayloads: [],
      repairFailures: new Map(),
    };
    activeRuns.set(runId, runState);

    emitProgramPhase({ runId, programId: program.id, hostId, layer: 'L1', phase: 'run-started', stepId: null, reason: trigger.id });
    io?.emit?.('program:run-started', {
      runId, programId: program.id, hostId, triggerId: trigger.id, action: trigger.action, triggerType,
    });
    auditService?.log?.({
      action: 'program_run_start',
      source: 'program',
      hostId,
      hostName: hostService.findHost?.(hostId)?.name || hostId,
      details: JSON.stringify({ programId: program.id, triggerId: trigger.id, actionName: trigger.action }),
    });

    let status = 'success';
    let error = null;
    let stepsCompleted = 0;
    let guardianInvocations = 0;
    let l2Invocations = 0;

    try {
      for (const step of action.steps) {
        if (runState.cancelled) { status = 'cancelled'; break; }

        io?.emit?.('program:step-started', { runId, stepId: step.id, layer: step.type === 'skill' ? 'L2' : 'L1' });

        if (step.type === 'render') {
          const payload = buildProgramRenderPayload(step, runState.stepOutputs);
          runState.renderPayloads.push({ stepId: step.id, payload });
          io?.emit?.('program:render', { runId, programId: program.id, hostId, stepId: step.id, payload });
          io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'rendered', durationMs: 0, layer: 'L1' });
          stepsCompleted++;
          continue;
        }

        if (step.type === 'skill') {
          const result = await executeExplicitL2Step({ program, hostId, step, runState, runId });
          l2Invocations++;
          if (result.action === 'continue') { stepsCompleted++; continue; }
          if (result.guardianUsed) guardianInvocations++;
          status = result.status;
          error = result.error;
          break;
        }

        emitProgramPhase({ runId, programId: program.id, hostId, layer: 'L1', phase: 'exec', stepId: step.id, reason: step.label });
        const result = await execStep(step, hostId);
        runState.stepOutputs.set(step.id, result);

        const verdict = checkVerify(step.verify, result);
        io?.emit?.('program:step-ended', {
          runId,
          stepId: step.id,
          status: verdict.ok ? 'verified' : (step.optional ? 'skipped' : 'failed'),
          durationMs: result.durationMs,
          reason: verdict.ok ? null : verdict.reason,
          layer: 'L1',
        });

        if (verdict.ok) { stepsCompleted++; continue; }
        if (step.optional) { stepsCompleted++; continue; }

        const outcome = await handleL1Failure({
          program, action, hostId, step, result, verdict, runState, runId, trigger,
        });
        l2Invocations += outcome.l2Used ? 1 : 0;
        guardianInvocations += outcome.guardianUsed ? 1 : 0;

        if (outcome.action === 'continue') { stepsCompleted++; continue; }
        status = outcome.status;
        error = outcome.error;
        break;
      }
    } catch (err) {
      status = 'error';
      error = err.message;
      logger?.error?.('[program-engine] run exception', { runId, programId: program.id, hostId, error: err.message });
    } finally {
      runningInstances.delete(lockKey);
      activeRuns.delete(runId);
    }

    appendFinalRenderIfNeeded({
      runState,
      runId,
      programId: program.id,
      hostId,
      status,
      error,
      stepsTotal: action.steps.length,
      stepsCompleted,
      l2Invocations,
      guardianInvocations,
    });

    stateService.recordRunEnd(runId, {
      status,
      stepsTotal: action.steps.length,
      stepsCompleted,
      rescueCount: guardianInvocations,
      details: { l2Invocations, guardianInvocations },
      error,
      renders: runState.renderPayloads,
    });

    io?.emit?.('program:run-ended', {
      runId, programId: program.id, hostId, status, error,
      stepsTotal: action.steps.length, stepsCompleted,
      l2Invocations, guardianInvocations,
    });
    auditService?.log?.({
      action: 'program_run_end',
      source: 'program',
      hostId,
      hostName: hostService.findHost?.(hostId)?.name || hostId,
      exit_code: status === 'success' ? 0 : 1,
      error,
      details: JSON.stringify({ programId: program.id, status, stepsCompleted, l2Invocations, guardianInvocations }),
    });

    return runId;
  }

  async function executeExplicitL2Step({ program, hostId, step, runState, runId }) {
    if (step.when && !checkWhen(step.when, runState.stepOutputs)) {
      io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'skipped', durationMs: 0, reason: 'when 条件未满足', layer: 'L2' });
      return { action: 'continue' };
    }
    if (!skillStepExecutor) {
      io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'failed', durationMs: 0, reason: 'L2 Skill Executor 未配置', layer: 'L2' });
      return { action: 'stop', status: 'failed', error: `step "${step.id}" 类型为 skill 但 L2 Executor 未配置` };
    }

    emitProgramPhase({ runId, programId: program.id, hostId, layer: 'L2', phase: 'explicit-skill', stepId: step.id, reason: step.skill });
    const l2Result = await skillStepExecutor.execute({ program, hostId, step, stepOutputs: runState.stepOutputs, runId });
    runState.stepOutputs.set(step.id, l2Result);

    if (l2Result.output || l2Result.summary) {
      const renderPayload = {
        format: 'message',
        title: `L2 Skill · ${step.label || step.id}`,
        subtitle: l2Result.ok ? '执行成功' : '执行失败',
        level: l2Result.ok ? 'success' : 'warning',
        content: l2Result.output || l2Result.summary,
      };
      runState.renderPayloads.push({ stepId: step.id, payload: renderPayload });
      io?.emit?.('program:render', { runId, programId: program.id, hostId, stepId: step.id, payload: renderPayload });
    }

    io?.emit?.('program:step-ended', {
      runId, stepId: step.id,
      status: l2Result.ok ? 'verified' : (step.optional ? 'skipped' : 'failed'),
      durationMs: l2Result.durationMs,
      reason: l2Result.ok ? null : l2Result.summary,
      layer: 'L2',
    });

    if (l2Result.ok || step.optional) return { action: 'continue' };
    return { action: 'stop', status: 'failed', error: `L2 step "${step.id}" 失败：${l2Result.summary}` };
  }

  async function handleL1Failure({ program, action, hostId, step, result, verdict, runState, runId, trigger }) {
    if (action.on_fail === 'ignore') return { action: 'continue' };
    if (action.on_fail === 'stop') return { action: 'stop', status: 'failed', error: `step "${step.id}" 失败：${verdict.reason}` };

    const incident = matchIncidentFromStep(program, step, result, runState.stepOutputs);
    if (incident) {
      return escalateToL3({ program, hostId, step, result, reason: incident.reason, runId, trigger, incident });
    }

    if (step.on_fail === 'escalate') {
      return escalateToL3({ program, hostId, step, result, reason: verdict.reason, runId, trigger, incident: null });
    }

    if (!skillStepExecutor) {
      return { action: 'stop', status: 'failed', error: `L1 step "${step.id}" 失败且 L2 Executor 未配置：${verdict.reason}` };
    }

    const attempts = Math.max(1, program.l2?.max_repair_attempts || 1);
    let lastRepair = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      emitProgramPhase({ runId, programId: program.id, hostId, layer: 'L2', phase: 'repair', stepId: step.id, reason: verdict.reason, attempt });
      lastRepair = await skillStepExecutor.repairFailure({
        program,
        hostId,
        failingStep: step,
        failureReason: verdict.reason,
        execResult: result,
        stepOutputs: runState.stepOutputs,
        runId,
        attempt,
      });

      const disposition = normalizeL2Disposition(lastRepair.disposition);
      if (lastRepair.ok || disposition === 'resolved') {
        try { registry.reload?.(); } catch { /* ignore */ }
        runState.stepOutputs.set(step.id, {
          ...result,
          stdout: lastRepair.output || result.stdout,
          stderr: '',
          exitCode: 0,
          l2Disposition: disposition,
        });
        return { action: 'continue', l2Used: true };
      }

      if (shouldEscalateToL3({ disposition })) {
        const reason = buildEscalationReason({ disposition, summary: lastRepair.summary });
        return escalateToL3({ program, hostId, step, result: lastRepair, reason, runId, trigger, incident: null, l2Used: true });
      }
    }

    const key = `${program.id}::${hostId}::${step.id}`;
    const failures = (runState.repairFailures.get(key) || 0) + 1;
    runState.repairFailures.set(key, failures);
    const repeatedFailure = failures >= (program.l2?.escalate_after_failures || 2);
    if (shouldEscalateToL3({ disposition: lastRepair?.disposition, repeatedFailure })) {
      const reason = buildEscalationReason({ disposition: lastRepair?.disposition, summary: lastRepair?.summary, repeatedFailure });
      return escalateToL3({ program, hostId, step, result: lastRepair || result, reason, runId, trigger, incident: null, l2Used: true });
    }

    return {
      action: 'stop',
      status: 'failed',
      error: `L1 step "${step.id}" 失败，L2 未能修复：${lastRepair?.summary || verdict.reason}`,
      l2Used: true,
    };
  }

  async function escalateToL3({ program, hostId, step, result, reason, runId, trigger, incident = null, l2Used = false }) {
    if (!program.l3?.enabled) {
      return { action: 'stop', status: 'failed', error: `需要 L3 但 Program l3.enabled=false：${reason}`, l2Used };
    }
    if (!guardianService) {
      return { action: 'stop', status: 'failed', error: `需要 L3 但 Guardian 未配置：${reason}`, l2Used };
    }

    emitProgramPhase({
      runId,
      programId: program.id,
      hostId,
      layer: 'L3',
      phase: 'escalate',
      stepId: step.id,
      reason,
      incidentId: incident?.id || null,
    });

    let outcome;
    try {
      outcome = await guardianService.escalate({
        program,
        hostId,
        failingStep: step,
        failureReason: reason,
        execResult: result,
        runId,
        triggerId: trigger.id,
      });
    } catch (err) {
      outcome = { ok: false, reason: `Guardian 异常: ${err.message}` };
    }

    if (outcome?.ok) {
      try { registry.reload?.(); } catch { /* ignore */ }
      return { action: 'continue', guardianUsed: true, l2Used };
    }
    return {
      action: 'stop',
      status: 'warning',
      error: `L3 未能解决 step "${step.id}"：${outcome?.reason || '未知原因'}`,
      guardianUsed: true,
      l2Used,
    };
  }

  async function execStep(step, hostId) {
    const timeout = step.timeout || DEFAULT_STEP_TIMEOUT_MS;
    try {
      const result = await bridgeService.execOnHost(hostId, step.run, timeout, { source: 'program-l1' });
      if (hostId !== 'local' && result.exitCode !== 0 && result.durationMs < 150) {
        await new Promise((r) => setTimeout(r, 200));
        try { return await bridgeService.execOnHost(hostId, step.run, timeout, { source: 'program-l1-retry' }); }
        catch (err) { return { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 }; }
      }
      return result;
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
    }
  }

  async function runMonitorCheck(program, hostId, monitor) {
    let result;
    try { result = await bridgeService.execOnHost(hostId, monitor.check, DEFAULT_STEP_TIMEOUT_MS, { source: 'monitor' }); }
    catch (err) { result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 }; }

    const ok = checkExpect(monitor.expect, result).ok;
    if (ok) return;

    logger?.warn?.('[program-engine] monitor triggered', { programId: program.id, hostId, monitorId: monitor.id });
    io?.emit?.('program:monitor-triggered', { programId: program.id, hostId, monitorId: monitor.id, check: monitor.check, layer: 'L3' });

    const failingStep = { id: `monitor_${monitor.id}`, label: `Monitor: ${monitor.id}`, run: monitor.check };
    await escalateToL3({
      program,
      hostId,
      step: failingStep,
      result,
      reason: `Monitor "${monitor.id}" 检查不符合预期`,
      runId: `monitor_${Date.now().toString(36)}`,
      trigger: { id: `monitor:${monitor.id}` },
      incident: { id: monitor.id, reason: 'monitor_failed' },
    });
  }

  function setInstanceEnabled(programId, hostId, enabled) {
    stateService.setEnabled(programId, hostId, enabled);
    reload();
  }

  function cancelRun(runId) {
    const run = activeRuns.get(runId);
    if (run) run.cancelled = true;
  }

  function listActive() {
    return [...activeRuns.entries()].map(([runId, s]) => ({
      runId, programId: s.programId, hostId: s.hostId, cancelled: s.cancelled,
    }));
  }

  function appendFinalRenderIfNeeded({
    runState,
    runId,
    programId,
    hostId,
    status,
    error,
    stepsTotal,
    stepsCompleted,
    l2Invocations,
    guardianInvocations,
  }) {
    if (status === 'success' && runState.renderPayloads.length > 0) return;

    const payload = {
      format: 'message',
      title: status === 'success' ? 'Program 执行结果' : 'Program 终态说明',
      subtitle: `状态：${status}`,
      level: status === 'success' ? 'success' : (status === 'warning' ? 'warning' : 'error'),
      content: error || `执行完成：${stepsCompleted}/${stepsTotal} 个步骤完成。`,
      items: [
        { key: '完成步骤', value: `${stepsCompleted}/${stepsTotal}` },
        { key: 'L2 调用', value: String(l2Invocations || 0) },
        { key: 'L3 调用', value: String(guardianInvocations || 0) },
      ],
    };

    runState.renderPayloads.push({ stepId: '__final__', payload });
    io?.emit?.('program:render', { runId, programId, hostId, stepId: '__final__', payload });
  }

  function emitProgramPhase(payload) {
    io?.emit?.('program:phase', payload);
  }

  return { start, stop, reload, triggerManual, setInstanceEnabled, cancelRun, listActive };
}

function matchIncidentFromStep(program, step, result, stepOutputs) {
  const incidents = Array.isArray(program.incidents) ? program.incidents : [];
  for (const incident of incidents) {
    if (step.incident && incident.id === step.incident) {
      const verdict = checkExpect(incident.expect, result);
      if (!verdict.ok) return { ...incident, reason: verdict.reason };
    }
    if (incident.when && checkWhen(incident.when, stepOutputs)) {
      return { ...incident, reason: 'when 条件命中' };
    }
  }
  return null;
}

function checkExpect(expect, execResult) {
  const stdout = (execResult.stdout || '').replace(/[\r\n\s]+$/, '');
  if (expect?.exit_code != null && execResult.exitCode !== expect.exit_code) return { ok: false, reason: `exit_code=${execResult.exitCode}，期望 ${expect.exit_code}` };
  if (expect?.stdout_contains && !stdout.includes(expect.stdout_contains)) return { ok: false, reason: `stdout 未包含 "${expect.stdout_contains}"` };
  if (expect?.stdout_match) {
    try { if (!new RegExp(expect.stdout_match).test(stdout)) return { ok: false, reason: `stdout 不匹配 /${expect.stdout_match}/` }; }
    catch { return { ok: false, reason: `stdout_match 非法: ${expect.stdout_match}` }; }
  }
  const number = Number(stdout.match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (Number.isFinite(number)) {
    if (expect?.number_lt != null && !(number < expect.number_lt)) return { ok: false, reason: `${number} 未小于 ${expect.number_lt}` };
    if (expect?.number_lte != null && !(number <= expect.number_lte)) return { ok: false, reason: `${number} 未小于等于 ${expect.number_lte}` };
    if (expect?.number_gt != null && !(number > expect.number_gt)) return { ok: false, reason: `${number} 未大于 ${expect.number_gt}` };
    if (expect?.number_gte != null && !(number >= expect.number_gte)) return { ok: false, reason: `${number} 未大于等于 ${expect.number_gte}` };
  }
  return { ok: true };
}

function buildProgramRenderPayload(step, stepOutputs) {
  const base = {
    format: step.format || 'message',
    title: step.title,
    subtitle: step.subtitle,
    level: step.level || 'info',
  };

  if (step.format === 'keyvalue') {
    const items = [];
    if (Array.isArray(step.items)) items.push(...step.items);
    if (Array.isArray(step.items_from_steps)) {
      for (const it of step.items_from_steps) {
        const out = stepOutputs.get(it.value_from);
        if (!out) continue;
        let val = applyTransform((out.stdout || '').trim(), it.transform);
        val = `${it.prefix || ''}${val}${it.suffix || ''}`;
        items.push({ key: it.key, value: val });
      }
    }
    base.items = items;
  } else if (step.format === 'table') {
    base.columns = step.columns || [];
    if (step.rows_from_step) {
      const out = stepOutputs.get(step.rows_from_step);
      if (out) {
        const sep = step.row_separator || step.separator || null;
        base.rows = (out.stdout || '').split('\n')
          .map((l) => l.trim()).filter(Boolean)
          .map((l) => sep ? l.split(sep) : l.split(/\s{2,}|\t/));
      }
    } else {
      base.rows = step.rows || [];
    }
    if (Array.isArray(step.rowActions)) base.rowActions = step.rowActions;
    const rowSkill = step.rowActionSkill || step.row_action_skill;
    if (rowSkill) base.rowActionSkill = rowSkill;
    const rowKey = step.rowInputKey || step.row_input_key;
    if (rowKey) base.rowInputKey = rowKey;
  } else if (step.format === 'list') {
    base.listItems = step.listItems || [];
  } else if (step.format === 'message') {
    if (step.content_from) {
      const out = stepOutputs.get(step.content_from);
      base.content = out ? (out.stdout || '').trim() : '';
    } else {
      base.content = step.content || '';
    }
  }
  return base;
}

function applyTransform(value, transform) {
  const t = String(transform || 'trim').trim();
  if (!t || t === 'trim') return value.trim();
  if (t === 'first_line') return value.split('\n')[0].trim();
  if (t === 'last_line') {
    const lines = value.trim().split('\n');
    return lines[lines.length - 1] || '';
  }
  if (t.startsWith('kv:')) {
    const key = t.slice(3);
    const found = value.split('|').find((part) => part.startsWith(`${key}=`));
    return found ? found.slice(key.length + 1) : '';
  }
  return value.trim();
}

module.exports = { createProgramEngine };

'use strict';

/**
 * Program Engine — 长驻程序调度与执行
 *
 * 职责：
 *   1. 启动时读 registry，对每个启用的 Program 的每个绑定 host，
 *      按 triggers 注册 cron 定时任务。
 *   2. 接收手动触发，按 trigger 或 action 执行。
 *   3. 每次执行走确定性步骤（bridge exec + verify）；
 *      失败按 action.on_fail 处理（escalate → Guardian AI 介入）。
 *   4. 所有 run 记录到 state service；关键事件通过 io 推送到前端。
 *
 * 并发策略：同一个 (program, host) 实例**不并发**——cron 触发时若实例在跑，
 * 本轮直接 skip，避免积压（这是长驻程序的常规做法）。
 *
 * 事件（io emit）：
 *   program:run-started    { runId, programId, hostId, triggerId, action }
 *   program:step-started   { runId, stepId }
 *   program:step-ended     { runId, stepId, status, durationMs, reason? }
 *   program:render         { runId, programId, hostId, stepId, payload }
 *   program:run-ended      { runId, programId, hostId, status, error? }
 */

const cron = require('node-cron');
const { checkVerify, DEFAULT_STEP_TIMEOUT_MS } = require('../skills/playbook-schema');

function createProgramEngine({
  registry,
  stateService,
  bridgeService,
  hostService,
  auditService,
  logger,
  io,
  guardianService,   // 可选，为 null 时 escalate 退化成 stop
}) {
  // programId → [cron.ScheduledTask]
  const scheduledTasks = new Map();
  // "programId::hostId" → runId  (instance lock)
  const runningInstances = new Map();
  // runId → { cancelled, programId, hostId }
  const activeRuns = new Map();
  let started = false;

  // ─── 启动 / 停止 ─────────────────────────────────────────────────────
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
    // 当前正在跑的 run 不能硬杀 SSH，设置 cancelled flag 让后续 step 跳过
    for (const run of activeRuns.values()) run.cancelled = true;
    started = false;
  }

  function reload() {
    stop();
    registry.reload();
    start();
  }

  function totalScheduled() {
    let n = 0;
    for (const tasks of scheduledTasks.values()) n += tasks.length;
    return n;
  }

  function scheduleAll() {
    for (const program of registry.list()) {
      scheduleProgram(program);
    }
  }

  function scheduleProgram(program) {
    if (!program.enabled) return;

    const tasks = [];
    const hostIds = resolveHosts(program);

    for (const trigger of program.triggers) {
      if (trigger.type !== 'cron') continue;

      // 每个 (program, host, trigger) 注册一个独立的 cron 任务
      for (const hostId of hostIds) {
        // 实例级停用的跳过
        if (!stateService.isEnabled(program.id, hostId)) continue;

        const task = cron.schedule(trigger.schedule, () => {
          runInstance(program, hostId, trigger, { triggerType: 'cron' })
            .catch((err) => {
              logger?.error?.('[program-engine] cron run error', {
                programId: program.id, hostId, triggerId: trigger.id, error: err.message,
              });
            });
        }, { scheduled: true, timezone: process.env.TZ });

        tasks.push(task);
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

  // ─── 手动触发 ────────────────────────────────────────────────────────
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
      // 默认取第一个 manual trigger，没有就取第一个 trigger
      trigger = program.triggers.find((t) => t.type === 'manual') || program.triggers[0];
    }

    // 解析 hostId（可能是 'all'）
    const hostIds = hostId === 'all' ? resolveHosts(program) : [hostId || resolveHosts(program)[0]];

    const runIds = [];
    for (const hid of hostIds) {
      const runId = await runInstance(program, hid, trigger, { triggerType: 'manual' });
      if (runId) runIds.push(runId);
    }
    return runIds;
  }

  // ─── 实例执行 ────────────────────────────────────────────────────────
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

    const runState = { cancelled: false, programId: program.id, hostId, stepOutputs: new Map(), renderPayloads: [] };
    activeRuns.set(runId, runState);

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

    try {
      for (const step of action.steps) {
        if (runState.cancelled) { status = 'cancelled'; break; }

        io?.emit?.('program:step-started', { runId, stepId: step.id });

        if (step.type === 'render') {
          const payload = buildProgramRenderPayload(step, runState.stepOutputs);
          runState.renderPayloads.push({ stepId: step.id, payload });
          io?.emit?.('program:render', {
            runId, programId: program.id, hostId, stepId: step.id, payload,
          });
          io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'rendered', durationMs: 0 });
          stepsCompleted++;
          continue;
        }

        const result = await execStep(step, hostId);
        runState.stepOutputs.set(step.id, result);

        const verdict = checkVerify(step.verify, result);
        io?.emit?.('program:step-ended', {
          runId, stepId: step.id,
          status: verdict.ok ? 'verified' : (step.optional ? 'skipped' : 'failed'),
          durationMs: result.durationMs,
          reason: verdict.ok ? null : verdict.reason,
        });

        if (!verdict.ok) {
          if (step.optional) { stepsCompleted++; continue; }

          // on_fail 处理
          if (action.on_fail === 'ignore') { stepsCompleted++; continue; }

          // ─── escalate → Guardian AI 介入 ──────────────────────────
          if (action.on_fail === 'escalate' && guardianService) {
            let outcome;
            try {
              outcome = await guardianService.escalate({
                program,
                hostId,
                failingStep: step,
                failureReason: verdict.reason,
                execResult: result,
                runId,
                triggerId: trigger.id,
              });
            } catch (gErr) {
              outcome = { ok: false, reason: `Guardian 异常: ${gErr.message}` };
            }
            guardianInvocations++;

            if (outcome?.ok) {
              // Guardian 声称已修复根因，重载 registry 使 write_program_step 的改动生效
              try { registry.reload?.(); } catch { /* 静默 */ }
              stepsCompleted++;
              continue;
            }
            // Guardian 未能修复，但已介入并输出了诊断报告 → warning（有问题但已知晓）
            status = 'warning';
            error = `Guardian 未能修复 step "${step.id}"，已输出诊断报告：${outcome?.reason || '未知原因'}`;
            break;
          }

          if (action.on_fail === 'escalate' && !guardianService) {
            status = 'failed';
            error = `step "${step.id}" 失败且未配置 Guardian：${verdict.reason}`;
            break;
          }

          // stop
          status = 'failed';
          error = `step "${step.id}" 失败：${verdict.reason}`;
          break;
        }

        stepsCompleted++;
      }
    } catch (err) {
      status = 'error';
      error = err.message;
      logger?.error?.('[program-engine] run exception', {
        runId, programId: program.id, hostId, error: err.message,
      });
    } finally {
      runningInstances.delete(lockKey);
      activeRuns.delete(runId);
    }

    stateService.recordRunEnd(runId, {
      status,
      stepsTotal: action.steps.length,
      stepsCompleted,
      rescueCount: guardianInvocations,
      error,
      renders: runState.renderPayloads,
    });

    io?.emit?.('program:run-ended', {
      runId, programId: program.id, hostId, status, error,
      stepsTotal: action.steps.length, stepsCompleted,
    });
    auditService?.log?.({
      action: 'program_run_end',
      source: 'program',
      hostId,
      hostName: hostService.findHost?.(hostId)?.name || hostId,
      exit_code: status === 'success' ? 0 : 1,
      error,
      details: JSON.stringify({ programId: program.id, status, stepsCompleted }),
    });

    return runId;
  }

  async function execStep(step, hostId) {
    const timeout = step.timeout || DEFAULT_STEP_TIMEOUT_MS;
    try {
      const result = await bridgeService.execOnHost(hostId, step.run, timeout, { source: 'program' });

      // 与 playbook-executor 一致的断连重试：0ms 返回视为连接死
      if (hostId !== 'local' && result.exitCode !== 0 && result.durationMs < 150) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          return await bridgeService.execOnHost(hostId, step.run, timeout, { source: 'program-retry' });
        } catch (err) {
          return { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
        }
      }
      return result;
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
    }
  }

  // ─── Instance 启用 / 停用 ────────────────────────────────────────────
  function setInstanceEnabled(programId, hostId, enabled) {
    stateService.setEnabled(programId, hostId, enabled);
    // 启停后整体重调度（简单稳妥）
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

  return {
    start, stop, reload,
    triggerManual,
    setInstanceEnabled,
    cancelRun,
    listActive,
  };
}

// ─── render step payload 构造（与 playbook-executor 保持一致）─────────────
function buildProgramRenderPayload(step, stepOutputs) {
  const base = {
    format: step.format || 'message',
    title:    step.title,
    subtitle: step.subtitle,
    level:    step.level || 'info',
  };

  if (step.format === 'keyvalue') {
    const items = [];
    if (Array.isArray(step.items)) items.push(...step.items);
    if (Array.isArray(step.items_from_steps)) {
      for (const it of step.items_from_steps) {
        const out = stepOutputs.get(it.value_from);
        if (!out) continue;
        let val = (out.stdout || '').trim();
        if (it.transform === 'first_line') val = val.split('\n')[0].trim();
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
        base.rows = (out.stdout || '').split('\n')
          .map((l) => l.trim()).filter(Boolean)
          .map((l) => l.split(/\s{2,}|\t/));
      }
    } else {
      base.rows = step.rows || [];
    }
    if (Array.isArray(step.rowActions)) base.rowActions = step.rowActions;
    const rowSkill = step.rowActionSkill || step.row_action_skill;
    if (rowSkill) base.rowActionSkill = rowSkill;
    const rowKey = step.rowInputKey || step.row_input_key;
    if (rowKey) base.rowInputKey = rowKey;

  } else if (step.format === 'message') {
    if (step.content_from) {
      const out = stepOutputs.get(step.content_from);
      base.content = out ? (out.stdout || '').trim() : '';
    } else {
      base.content = step.content || '';
    }

  } else if (step.format === 'code') {
    base.language = step.language || '';
    base.content  = step.content || '';
  }

  return base;
}

module.exports = { createProgramEngine };
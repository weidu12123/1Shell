'use strict';

/**
 * Playbook Executor (L1)
 *
 * 按 playbook.yaml 的 steps 顺序在目标主机执行命令，使用 verify 规则做成功判定。
 * 不经过 AI，零 token 消耗。
 *
 * 当某个 exec step 的 verify 失败时：
 *   - 若注入了 rescuer（L2），移交 Rescuer 决定：重试 / 修补剩余计划 / 放弃
 *   - 若没有 Rescuer，直接 fail loudly
 *
 * 对外事件（与现有 runner 保持兼容，前端无感）：
 *   skill:run-started / skill:exec / skill:exec-result / skill:render
 *   skill:done / skill:error / skill:cancelled
 * 新增：
 *   skill:step-started / skill:step-verified / skill:step-failed
 *   skill:mode  — 告诉前端本次走的是 playbook 还是 AI-loop
 */

const { exec: childExec } = require('child_process');
const { ROOT_DIR } = require('../config/env');
const { checkVerify } = require('./playbook-schema');

const DEFAULT_TIMEOUT_MS = 30000;

function createPlaybookExecutor({ bridgeService, hostService, auditService, rescuer, logger }) {
  // runId → runState
  const activeRuns = new Map();

  async function run({ socket, runId, skill, playbook, hostId, inputs = {} }) {
    const host = hostService.findHost(hostId) || (hostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) {
      socket.emit('skill:error', { runId, error: `主机不存在: ${hostId}` });
      return;
    }

    const runState = {
      socket,
      cancelled: false,
      hostId,
      skillId: skill.id,
      playbook,
      inputs,
      stepOutputs: new Map(),   // stepId → { stdout, stderr, exitCode, durationMs }
      completedSteps: [],       // 已成功的 step id 列表
      rescueCount: 0,
      meta: {
        runId, itemId: skill.id, itemName: skill.name, itemKind: skill.kind || 'playbook',
        mode: 'playbook',
        hostId, hostName: host.name,
        startedAt: Date.now(),
      },
    };
    activeRuns.set(runId, runState);

    socket.emit('skill:run-started', {
      runId,
      skillId: skill.id,
      hostId,
      hostName: host.name,
      mode: 'playbook',
    });
    socket.emit('skill:mode', { runId, mode: 'playbook', goal: playbook.goal });

    auditService?.log?.({
      action: 'skill_run_start',
      source: 'skill',
      hostId,
      hostName: host.name,
      skillId: skill.id,
      mode: 'playbook',
    });

    try {
      // SSH 预热，避免首条命令因建连耗时而超时
      if (hostId !== 'local') {
        try {
          await bridgeService.execOnHost(hostId, 'echo 1', 15000, { source: 'skill-warmup' });
        } catch { /* 静默 */ }
      }

      let steps = [...playbook.steps];
      let cursor = 0;

      while (cursor < steps.length && !runState.cancelled) {
        const step = steps[cursor];
        await executeStep(step, runState, runId);

        if (runState.cancelled) break;

        // 如果 Rescuer 改写了剩余计划，步骤数组会被替换
        if (runState._patchedSteps) {
          steps = [...runState.completedSteps.map(id => steps.find(s => s.id === id)).filter(Boolean), ...runState._patchedSteps];
          cursor = runState.completedSteps.length;
          runState._patchedSteps = null;
          continue;
        }

        cursor++;
      }

      if (runState.cancelled) {
        socket.emit('skill:cancelled', { runId });
        auditService?.log?.({ action: 'skill_run_cancel', source: 'skill', skillId: skill.id, hostId });
      } else {
        socket.emit('skill:done', {
          runId,
          reason: 'playbook_complete',
          steps: runState.completedSteps.length,
          rescueCount: runState.rescueCount,
        });
        auditService?.log?.({
          action: 'skill_run_done',
          source: 'skill',
          skillId: skill.id,
          hostId,
          mode: 'playbook',
          steps: runState.completedSteps.length,
          rescueCount: runState.rescueCount,
        });
      }
    } catch (err) {
      logger?.error?.('Playbook 执行异常', { runId, skillId: skill.id, error: err.message });
      socket.emit('skill:error', { runId, error: err.message });
      auditService?.log?.({
        action: 'skill_run_error',
        source: 'skill',
        skillId: skill.id,
        hostId,
        mode: 'playbook',
        error: err.message,
      });
    } finally {
      activeRuns.delete(runId);
    }
  }

  async function executeStep(step, runState, runId) {
    const { socket, hostId } = runState;
    socket.emit('skill:step-started', { runId, stepId: step.id, label: step.label, type: step.type });

    if (step.type === 'exec') {
      await runExecStep(step, runState, runId);
    } else if (step.type === 'render') {
      await runRenderStep(step, runState, runId);
    }
  }

  async function runExecStep(step, runState, runId) {
    const { socket, hostId } = runState;
    const command = interpolateInputs(step.run, runState.inputs);
    const timeout = step.timeout || DEFAULT_TIMEOUT_MS;
    const toolUseId = `step_${step.id}_${Date.now()}`;

    socket.emit('skill:exec', { runId, toolUseId, command, timeout, stepId: step.id });

    let result;
    try {
      if (hostId === 'local') {
        result = await execLocal(command, timeout);
      } else {
        result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'skill' });
      }
    } catch (err) {
      result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
    }

    // ── 自动重试：SSH 长连接静默断开时，bridge 会在 ~0ms 内立刻返回错误。
    // 这不是命令本身的问题，等待 bridge 重建连接后再试一次即可，无需 AI 介入。
    // 判据：durationMs < 150ms（bridge 未真正执行命令）且 exitCode !== 0。
    if (hostId !== 'local' && result.exitCode !== 0 && result.durationMs < 150) {
      await new Promise((r) => setTimeout(r, 200)); // 给 bridge 200ms 重建连接
      try {
        result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'skill-retry' });
      } catch (err) {
        result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
      }
    }

    socket.emit('skill:exec-result', {
      runId,
      toolUseId,
      stepId: step.id,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });

    const verdict = checkVerify(step.verify, result);

    if (verdict.ok) {
      if (step.capture_stdout) runState.stepOutputs.set(step.id, result);
      runState.completedSteps.push(step.id);
      socket.emit('skill:step-verified', { runId, stepId: step.id, durationMs: result.durationMs });
      return;
    }

    // verify 失败
    if (step.optional) {
      socket.emit('skill:step-failed', {
        runId, stepId: step.id, reason: verdict.reason, skipped: true,
      });
      return;
    }

    socket.emit('skill:step-failed', { runId, stepId: step.id, reason: verdict.reason });

    // 尝试走 Rescuer
    if (rescuer && typeof rescuer.rescue === 'function') {
      if (runState.rescueCount >= runState.playbook.budget.max_rescues) {
        throw new Error(
          `步骤 "${step.label}" 失败且已用尽 Rescuer 预算（${runState.playbook.budget.max_rescues} 次）。原因：${verdict.reason}`,
        );
      }
      runState.rescueCount++;
      socket.emit('skill:mode', { runId, mode: 'ai-rescue', stepId: step.id });

      const outcome = await rescuer.rescue({
        runId,
        socket,
        hostId,
        playbook: runState.playbook,
        failingStep: step,
        failureReason: verdict.reason,
        execResult: result,
        completedSteps: [...runState.completedSteps],
        stepOutputs: runState.stepOutputs,
      });

      socket.emit('skill:mode', { runId, mode: 'playbook' });

      if (outcome?.action === 'retry_ok') {
        // Rescuer 已经跑通了该步骤，把它当成功算
        if (step.capture_stdout && outcome.execResult) {
          runState.stepOutputs.set(step.id, outcome.execResult);
        }
        runState.completedSteps.push(step.id);
        // Rescue 后 bridge 可能残留上一次超时的错误状态，用一条 echo 把队列冲掉
        if (runState.hostId !== 'local') {
          try {
            await bridgeService.execOnHost(runState.hostId, 'echo 1', 5000, { source: 'skill-post-rescue-flush' });
          } catch { /* 静默，只是冲洗 */ }
        }
        return;
      }
      if (outcome?.action === 'patch_plan' && Array.isArray(outcome.newSteps)) {
        runState._patchedSteps = outcome.newSteps;
        return;
      }
      // give_up 或未知
      throw new Error(
        `步骤 "${step.label}" 失败，Rescuer 放弃。原因：${verdict.reason}${outcome?.reason ? ` / ${outcome.reason}` : ''}`,
      );
    }

    // 无 Rescuer：fail loudly
    throw new Error(`步骤 "${step.label}" 失败：${verdict.reason}\n[stderr] ${(result.stderr || '').slice(-500)}`);
  }

  async function runRenderStep(step, runState, runId) {
    const { socket } = runState;
    const payload = buildRenderPayload(step, runState);
    socket.emit('skill:render', { runId, toolUseId: `render_${step.id}`, payload, stepId: step.id });
    runState.completedSteps.push(step.id);
    socket.emit('skill:step-verified', { runId, stepId: step.id });
  }

  function buildRenderPayload(step, runState) {
    const base = {
      format: step.format,
      title: step.title,
      subtitle: step.subtitle,
      level: step.level,
    };

    if (step.format === 'keyvalue') {
      const items = [];
      if (step.items) items.push(...step.items);
      if (step.items_from_steps) {
        for (const it of step.items_from_steps) {
          const val = resolveValue(it, runState.stepOutputs);
          if (val != null) items.push({ key: it.key, value: `${it.prefix || ''}${val}${it.suffix || ''}` });
        }
      }
      base.items = items;
    } else if (step.format === 'table') {
      base.columns = step.columns || [];
      if (step.rows_from_step) {
        const out = runState.stepOutputs.get(step.rows_from_step);
        if (out) base.rows = stdoutToRows(out.stdout);
      } else {
        base.rows = step.rows || [];
      }
      if (Array.isArray(step.rowActions)) base.rowActions = step.rowActions;
      // 支持 camelCase (rowActionSkill) 和 snake_case (row_action_skill) 两种写法
      const rowSkill = step.rowActionSkill || step.row_action_skill;
      if (rowSkill) base.rowActionSkill = rowSkill;
      const rowKey = step.rowInputKey || step.row_input_key;
      if (rowKey) base.rowInputKey = rowKey;
    } else if (step.format === 'list') {
      base.listItems = step.listItems || [];
    } else if (step.format === 'message') {
      if (step.content_from) {
        const out = runState.stepOutputs.get(step.content_from);
        base.content = out ? out.stdout.trim() : '';
      } else {
        base.content = step.content || '';
      }
    }
    return base;
  }

  function resolveValue(it, stepOutputs) {
    if (it.value != null) return it.value;
    if (!it.value_from) return null;
    const out = stepOutputs.get(it.value_from);
    if (!out) return null;
    let val = out.stdout || '';
    switch (it.transform) {
      case 'trim': val = val.trim(); break;
      case 'first_line': val = val.split('\n')[0].trim(); break;
      default: val = val.trim();
    }
    return val;
  }

  function stdoutToRows(stdout) {
    return stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(/\s{2,}|\t/));
  }

  function interpolateInputs(cmd, inputs) {
    return cmd.replace(/\$\{inputs\.(\w+)\}/g, (_, name) => {
      const v = inputs[name];
      return v != null ? String(v) : '';
    });
  }

  function execLocal(command, timeoutMs) {
    const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const startAt = Date.now();
    return new Promise((resolve) => {
      childExec(command, { timeout, maxBuffer: 10 * 1024 * 1024, cwd: ROOT_DIR }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || (err && !stderr ? String(err.message || '') : ''),
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          durationMs: Date.now() - startAt,
        });
      });
    });
  }

  function cancelRun(runId) {
    const state = activeRuns.get(runId);
    if (!state) return;
    state.cancelled = true;
  }

  function cancelAllForSocket(socketId) {
    for (const [runId, state] of activeRuns) {
      if (state.socket?.id === socketId) {
        state.cancelled = true;
        activeRuns.delete(runId);
      }
    }
  }

  function listActiveRuns() {
    return [...activeRuns.entries()].map(([runId, s]) => ({
      runId,
      ...(s.meta || {}),
      socketId: s.socket?.id,
    }));
  }

  return { run, cancelRun, cancelAllForSocket, listActiveRuns };
}

module.exports = { createPlaybookExecutor };
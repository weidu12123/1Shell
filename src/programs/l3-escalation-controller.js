'use strict';

const ACCEPTED_DISPOSITIONS = new Set([
  'out_of_scope',
  'risk_too_high',
  'needs_human_decision',
  'suspected_incident',
]);

const VALID_DISPOSITIONS = new Set([
  'resolved',
  'unresolved',
  ...ACCEPTED_DISPOSITIONS,
]);

const ACCEPTED_SEVERITIES = new Set(['high', 'critical', 'emergency']);

function createL3EscalationController({ guardianService, programRegistry, hostService, auditService, io, logger }) {
  async function request(input = {}) {
    const escalationId = input.escalationId || `l3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const program = input.program || programRegistry?.get?.(String(input.programId || '').trim());
    const programId = program?.id || String(input.programId || '').trim();
    const runId = String(input.runId || '').trim();
    const hostId = String(input.hostId || '').trim();
    const step = input.step || findStep(program, String(input.stepId || '').trim()) || { id: String(input.stepId || 'l3_request').trim() || 'l3_request', label: 'L3 escalation request' };
    const stepId = step.id || String(input.stepId || '').trim() || 'l3_request';
    const sourceLayer = String(input.sourceLayer || 'L2').trim().toUpperCase();
    const disposition = normalizeDisposition(input.disposition);
    const severity = normalizeSeverity(input.severity);
    const reason = String(input.reason || '').trim() || buildDefaultReason({ sourceLayer, disposition, severity });
    const evidence = normalizeEvidence(input.evidence);
    const requestedAction = String(input.requestedAction || '').trim();
    const userDecisionNeeded = input.userDecisionNeeded === true;
    const sessionId = input.sessionId || null;
    const source = input.source || 'program-l2';

    const base = { escalationId, programId, runId, hostId, stepId, sourceLayer, disposition, severity, reason, evidence, requestedAction, userDecisionNeeded };
    emitPhase({ ...base, layer: 'L3', phase: 'l3-requested' });
    emitL2Info(sessionId, `request_l3_escalation: ${disposition}/${severity} — ${reason}`);

    const rejected = validateRequest({ program, programId, hostId, runId, stepId, sourceLayer, disposition, reason });
    if (rejected) return finish({ ...base, sessionId, source, accepted: false, decision: 'rejected', decisionReason: rejected });

    const decision = decide({ disposition, severity, userDecisionNeeded, requestedAction });
    if (decision !== 'accepted') {
      return finish({ ...base, sessionId, source, accepted: false, decision, decisionReason: decisionReason(decision, disposition) });
    }

    if (!program.l3?.enabled) {
      return finish({ ...base, sessionId, source, accepted: false, decision: 'rejected', decisionReason: 'Program l3.enabled=false，Controller 已拒绝 L3 接管' });
    }
    if (!guardianService) {
      return finish({ ...base, sessionId, source, accepted: false, decision: 'rejected', decisionReason: 'Guardian 服务未配置，Controller 无法提交 L3' });
    }

    emitPhase({ ...base, layer: 'L3', phase: 'l3-request-accepted' });
    emitL2Info(sessionId, `L3 Controller 已接受升级请求：${escalationId}`);

    let guardianOutcome;
    try {
      guardianOutcome = await guardianService.escalate({
        program,
        hostId,
        failingStep: step,
        failureReason: formatGuardianReason({ reason, disposition, severity, requestedAction, userDecisionNeeded, evidence }),
        execResult: buildExecResult(input),
        runId,
        triggerId: input.triggerId || `l3-request:${escalationId}`,
      });
    } catch (err) {
      guardianOutcome = { ok: false, reason: `Guardian 异常: ${err.message}` };
    }

    return finish({
      ...base,
      sessionId,
      source,
      accepted: true,
      decision: 'accepted',
      decisionReason: guardianOutcome?.ok ? 'Guardian 已完成 L3 接管' : `Guardian 未能完成接管：${guardianOutcome?.reason || '未知原因'}`,
      guardianOutcome,
    });
  }

  function finish(payload) {
    const result = {
      ok: payload.accepted && payload.guardianOutcome?.ok !== false,
      accepted: payload.accepted,
      escalationId: payload.escalationId,
      decision: payload.decision,
      reason: payload.decisionReason,
      programId: payload.programId,
      runId: payload.runId,
      hostId: payload.hostId,
      stepId: payload.stepId,
      sourceLayer: payload.sourceLayer,
      disposition: payload.disposition,
      severity: payload.severity,
      requestedAction: payload.requestedAction,
      userDecisionNeeded: payload.userDecisionNeeded,
      guardian: payload.guardianOutcome ? {
        ok: !!payload.guardianOutcome.ok,
        reason: payload.guardianOutcome.reason || payload.guardianOutcome.summary || '',
      } : null,
    };
    result.render = buildRender(result);

    emitPhase({
      runId: payload.runId,
      programId: payload.programId,
      hostId: payload.hostId,
      layer: 'L3',
      phase: `l3-request-${payload.decision}`,
      stepId: payload.stepId,
      reason: payload.decisionReason,
      escalationId: payload.escalationId,
    });
    emitL2Info(payload.sessionId, `L3 升级请求 ${payload.decision}: ${payload.decisionReason}`);
    audit(payload.source, result);
    logger?.info?.('[l3-escalation] request decided', result);
    return result;
  }

  function validateRequest({ program, programId, hostId, runId, stepId, sourceLayer, disposition, reason }) {
    if (!programId) return 'programId 为必填';
    if (!program) return `Program 不存在: ${programId}`;
    if (!hostId) return 'hostId 为必填';
    if (hostId !== 'local' && hostService?.findHost && !hostService.findHost(hostId)) return `主机不存在: ${hostId}`;
    if (!runId) return 'runId 为必填';
    if (!stepId) return 'stepId 为必填';
    if (!['L1', 'L2', 'L3'].includes(sourceLayer)) return 'sourceLayer 必须是 L1/L2/L3';
    if (!VALID_DISPOSITIONS.has(disposition)) return `disposition 非法: ${disposition}`;
    if (!reason) return 'reason 为必填';
    return null;
  }

  function decide({ disposition, severity, userDecisionNeeded, requestedAction }) {
    if (ACCEPTED_DISPOSITIONS.has(disposition)) return 'accepted';
    if (ACCEPTED_SEVERITIES.has(severity)) return 'accepted';
    if (userDecisionNeeded) return 'accepted';
    if (looksRisky(requestedAction)) return 'accepted';
    return 'rejected';
  }

  function emitPhase(payload) {
    io?.emit?.('program:phase', payload);
  }

  function emitL2Info(sessionId, message) {
    if (!sessionId || !message) return;
    io?.emit?.('program:l2:info', { sessionId, message });
  }

  function audit(source, result) {
    auditService?.log?.({
      action: 'program_l3_escalation_request',
      source: source || 'program-l2',
      hostId: result.hostId,
      hostName: hostService?.findHost?.(result.hostId)?.name || result.hostId,
      exit_code: result.ok ? 0 : 1,
      error: result.ok ? null : result.reason,
      details: JSON.stringify(result),
    });
  }

  return { request };
}

function normalizeDisposition(value) {
  const v = String(value || 'unresolved').trim();
  return VALID_DISPOSITIONS.has(v) ? v : 'unresolved';
}

function normalizeSeverity(value) {
  const v = String(value || 'medium').trim().toLowerCase();
  return ['low', 'medium', 'high', 'critical', 'emergency'].includes(v) ? v : 'medium';
}

function normalizeEvidence(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function findStep(program, stepId) {
  if (!program || !stepId) return null;
  for (const action of Object.values(program.actions || {})) {
    const found = (action.steps || []).find((s) => s.id === stepId);
    if (found) return found;
  }
  return null;
}

function buildDefaultReason({ sourceLayer, disposition, severity }) {
  return `${sourceLayer} 请求 L3 接管：${disposition}/${severity}`;
}

function decisionReason(decision, disposition) {
  if (decision === 'queued') return '升级请求已进入队列';
  if (decision === 'needs_user_confirmation') return '升级请求需要用户确认';
  return `disposition=${disposition} 未达到 L3 接管条件`;
}

function looksRisky(action) {
  return /(restart|reboot|shutdown|firewall|iptables|ufw|ssh|credential|secret|delete|drop|truncate|downgrade|private key|停机|重启|防火墙|凭据|密钥|删除|降级)/i.test(action || '');
}

function formatGuardianReason({ reason, disposition, severity, requestedAction, userDecisionNeeded, evidence }) {
  const lines = [
    reason,
    `disposition=${disposition}`,
    `severity=${severity}`,
  ];
  if (requestedAction) lines.push(`requestedAction=${requestedAction}`);
  if (userDecisionNeeded) lines.push('userDecisionNeeded=true');
  if (evidence.length) lines.push('evidence:', ...evidence.map((item) => `- ${item}`));
  return lines.join('\n');
}

function buildExecResult(input) {
  const evidence = normalizeEvidence(input.evidence).join('\n');
  return {
    stdout: evidence || String(input.reason || ''),
    stderr: '',
    exitCode: 1,
    durationMs: 0,
    l3EscalationRequest: true,
  };
}

function buildRender(result) {
  const accepted = result.decision === 'accepted';
  return {
    format: 'message',
    level: accepted ? (result.guardian?.ok ? 'success' : 'warning') : 'warning',
    title: accepted ? 'L3 升级请求已提交' : 'L3 升级请求未接管',
    subtitle: `decision=${result.decision} · disposition=${result.disposition} · severity=${result.severity}`,
    content: result.reason,
    items: [
      { key: '升级 ID', value: result.escalationId },
      { key: '来源层级', value: result.sourceLayer },
      { key: 'Program', value: result.programId },
      { key: 'Run', value: result.runId },
      { key: 'Step', value: result.stepId },
    ],
  };
}

module.exports = { createL3EscalationController };

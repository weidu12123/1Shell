'use strict';

const L2_DISPOSITIONS = new Set([
  'resolved',
  'unresolved',
  'out_of_scope',
  'risk_too_high',
  'needs_human_decision',
  'suspected_incident',
]);

const L3_DISPOSITIONS = new Set([
  'out_of_scope',
  'risk_too_high',
  'needs_human_decision',
  'suspected_incident',
]);

function normalizeL2Disposition(value) {
  const v = String(value || '').trim();
  return L2_DISPOSITIONS.has(v) ? v : 'unresolved';
}

function shouldEscalateToL3({ disposition, repeatedFailure = false, incident = null }) {
  if (incident) return true;
  if (repeatedFailure) return true;
  return L3_DISPOSITIONS.has(normalizeL2Disposition(disposition));
}

function buildEscalationReason({ disposition, summary, repeatedFailure = false, incident = null }) {
  if (incident) return `命中 L3 incident 规则「${incident.id}」: ${incident.reason || incident.severity || 'critical'}`;
  if (repeatedFailure) return `L2 连续修复失败达到阈值: ${summary || '无说明'}`;
  const d = normalizeL2Disposition(disposition);
  if (d === 'out_of_scope') return `L2 判定超出 Skill 约束范围: ${summary || '无说明'}`;
  if (d === 'risk_too_high') return `L2 判定操作风险过高: ${summary || '无说明'}`;
  if (d === 'needs_human_decision') return `L2 需要人工决策: ${summary || '无说明'}`;
  if (d === 'suspected_incident') return `L2 怀疑发生安全/业务事故: ${summary || '无说明'}`;
  return summary || 'L2 未能修复';
}

module.exports = {
  L2_DISPOSITIONS,
  normalizeL2Disposition,
  shouldEscalateToL3,
  buildEscalationReason,
};

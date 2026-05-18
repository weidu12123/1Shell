'use strict';

/**
 * Program Schema — data/programs/<id>/program.yaml
 *
 * 新三层语义：
 *   L1 — exec/render 确定性执行
 *   L2 — Program 绑定的 1Shell Skill 约束 AI：L1 失败维护、显式 AI 功能 step
 *   L3 — 1Shell AI 危机升级层：incident / L2 越界 / 高风险 / 重复失败 / 手动升级
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cron = require('node-cron');

const { normalizeStep } = require('../skills/playbook-schema');

function loadProgram(programDir) {
  const programPath = path.join(programDir, 'program.yaml');
  if (!fs.existsSync(programPath)) return null;

  let raw;
  try { raw = fs.readFileSync(programPath, 'utf8'); } catch { return null; }

  let doc;
  try { doc = yaml.load(raw); }
  catch (err) { throw new Error(`program.yaml 解析失败: ${err.message}`); }

  const id = path.basename(programDir);
  return normalizeProgram(doc, id, programPath);
}

function normalizeProgram(doc, id, sourcePath = 'program.yaml') {
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${sourcePath}: 根节点必须是对象`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`${sourcePath}: program id "${id}" 不合法（必须 kebab-case）`);
  }

  const name = String(doc.name || id).trim();
  const description = doc.description ? String(doc.description) : '';
  const enabled = doc.enabled !== false;
  const hosts = normalizeHosts(doc.hosts, sourcePath);

  const rawActions = doc.actions || {};
  if (!rawActions || typeof rawActions !== 'object' || Array.isArray(rawActions)) {
    throw new Error(`${sourcePath}: actions 必须是对象`);
  }
  const actionNames = Object.keys(rawActions);
  if (actionNames.length === 0) throw new Error(`${sourcePath}: 至少需要定义一个 action`);

  const actions = {};
  for (const [actName, raw] of Object.entries(rawActions)) {
    actions[actName] = normalizeAction(raw, actName, sourcePath);
  }

  const rawTriggers = Array.isArray(doc.triggers) ? doc.triggers : [];
  if (rawTriggers.length === 0) throw new Error(`${sourcePath}: triggers 数组不能为空`);
  const seenTriggerIds = new Set();
  const triggers = rawTriggers.map((t, idx) => normalizeTrigger(t, idx, seenTriggerIds, actions, sourcePath));

  const l2 = normalizeL2(doc.l2 || doc.maintenance || {}, doc, sourcePath);
  const l3 = normalizeL3(doc.l3 || doc.guardian || {}, sourcePath);
  const guardian = { skills: l3.skills, max_actions_per_hour: l3.max_actions_per_hour };

  const monitors = Array.isArray(doc.monitors)
    ? doc.monitors.map((m, idx) => normalizeMonitor(m, idx, actions, sourcePath)).filter(Boolean)
    : [];

  const incidents = Array.isArray(doc.incidents)
    ? doc.incidents.map((item, idx) => normalizeIncident(item, idx, actions, sourcePath))
    : [];

  const ui = doc.ui && typeof doc.ui === 'object'
    ? normalizeUi(doc.ui, actions, sourcePath)
    : null;

  return {
    id,
    name,
    description,
    enabled,
    hosts,
    triggers,
    actions,
    l2,
    l3,
    guardian,
    monitors,
    incidents,
    ui,
  };
}

function normalizeHosts(rawHosts, sourcePath) {
  if (rawHosts === 'all') return 'all';
  if (Array.isArray(rawHosts)) {
    const hosts = rawHosts.map(String).map((s) => s.trim()).filter(Boolean);
    if (hosts.length === 0) throw new Error(`${sourcePath}: hosts 数组不能为空（或用 'all'）`);
    return hosts;
  }
  if (typeof rawHosts === 'string' && rawHosts.trim()) return [rawHosts.trim()];
  throw new Error(`${sourcePath}: hosts 必须是字符串、数组或 'all'`);
}

function normalizeAction(raw, actName, sourcePath) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourcePath}: action "${actName}" 必须是对象`);
  }
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (rawSteps.length === 0) throw new Error(`${sourcePath}: action "${actName}" 必须至少有一个 step`);

  const seenIds = new Set();
  const steps = rawSteps.map((s, idx) => normalizeProgramStep(s, idx, seenIds, `${sourcePath} action="${actName}"`));

  const onFail = String(raw.on_fail || raw.on_failure || 'repair').trim();
  if (!['repair', 'stop', 'ignore', 'escalate'].includes(onFail)) {
    throw new Error(`${sourcePath}: action "${actName}" on_fail 必须是 repair|stop|ignore|escalate`);
  }
  return { name: raw.name ? String(raw.name) : actName, steps, on_fail: onFail };
}

function normalizeProgramStep(step, idx, seenIds, sourcePath) {
  const out = normalizeStep(step, idx, seenIds, sourcePath);
  if (step && typeof step === 'object') {
    if (step.on_fail) out.on_fail = String(step.on_fail);
    if (step.incident) out.incident = String(step.incident);
  }
  return out;
}

function normalizeTrigger(raw, idx, seenIds, actions, sourcePath) {
  if (!raw || typeof raw !== 'object') throw new Error(`${sourcePath}: triggers[${idx}] 必须是对象`);
  const id = String(raw.id || '').trim();
  if (!id) throw new Error(`${sourcePath}: triggers[${idx}] 缺少 id`);
  if (seenIds.has(id)) throw new Error(`${sourcePath}: triggers[${idx}] id "${id}" 重复`);
  seenIds.add(id);

  const type = String(raw.type || 'manual').trim();
  if (!['cron', 'manual'].includes(type)) {
    throw new Error(`${sourcePath}: triggers[${idx}] type "${type}" 未知（支持 cron | manual）`);
  }

  const actionName = String(raw.action || '').trim();
  if (!actionName) throw new Error(`${sourcePath}: triggers[${idx}] 缺少 action 字段`);
  if (!actions[actionName]) throw new Error(`${sourcePath}: triggers[${idx}] action "${actionName}" 未在 actions{} 里定义`);

  const out = { id, type, action: actionName };
  if (type === 'cron') {
    const schedule = String(raw.schedule || '').trim();
    if (!schedule) throw new Error(`${sourcePath}: triggers[${idx}] cron 类型缺少 schedule`);
    if (!cron.validate(schedule)) throw new Error(`${sourcePath}: triggers[${idx}] schedule "${schedule}" 不是合法的 cron 表达式`);
    out.schedule = schedule;
  }
  return out;
}

function normalizeL2(raw, doc, sourcePath) {
  const skill = String(
    raw.skill || raw.repair_skill || raw.maintenance_skill || doc.maintenance_skill || doc.l2_skill || '',
  ).trim();
  if (skill && !/^[a-z0-9][a-z0-9-]*$/.test(skill)) {
    throw new Error(`${sourcePath}: l2.skill "${skill}" 不合法（必须 kebab-case）`);
  }

  return {
    skill,
    max_repair_attempts: clampInt(raw.max_repair_attempts, 1, 5, 1),
    escalate_after_failures: clampInt(raw.escalate_after_failures, 1, 10, 2),
    allow_write_program: raw.allow_write_program !== false,
    require_skill_for_repair: raw.require_skill_for_repair !== false,
  };
}

function normalizeL3(raw, sourcePath) {
  const skills = Array.isArray(raw.skills) ? raw.skills.map(String).map((s) => s.trim()).filter(Boolean) : [];
  for (const skill of skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) {
      throw new Error(`${sourcePath}: l3.skills 包含非法 skill id "${skill}"`);
    }
  }

  return {
    enabled: raw.enabled !== false,
    skills,
    max_actions_per_hour: clampInt(raw.max_actions_per_hour, 1, 1000, 20),
    require_confirmation: raw.require_confirmation !== false,
  };
}

function normalizeMonitor(raw, idx, actions, sourcePath) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) throw new Error(`${sourcePath}: monitors[${idx}] 缺少 id`);
  const check = String(raw.check || '').trim();
  if (!check) throw new Error(`${sourcePath}: monitors[${idx}] 缺少 check（shell 命令）`);
  const interval = String(raw.interval || '').trim();
  if (!interval) throw new Error(`${sourcePath}: monitors[${idx}] 缺少 interval（cron 表达式）`);
  if (!cron.validate(interval)) throw new Error(`${sourcePath}: monitors[${idx}] interval "${interval}" 不是合法的 cron 表达式`);

  const action = raw.action ? String(raw.action).trim() : '';
  if (action && !actions[action]) throw new Error(`${sourcePath}: monitors[${idx}] action "${action}" 未在 actions{} 里定义`);

  return { id, check, expect: normalizeExpect(raw.expect), interval, action };
}

function normalizeIncident(raw, idx, actions, sourcePath) {
  if (!raw || typeof raw !== 'object') throw new Error(`${sourcePath}: incidents[${idx}] 必须是对象`);
  const id = String(raw.id || '').trim();
  if (!id) throw new Error(`${sourcePath}: incidents[${idx}] 缺少 id`);

  const severity = ['warning', 'critical', 'emergency'].includes(raw.severity) ? raw.severity : 'critical';
  const policy = ['ask_then_act', 'auto_diagnose', 'manual_only'].includes(raw.policy || raw.l3_policy)
    ? String(raw.policy || raw.l3_policy)
    : 'ask_then_act';
  const action = raw.action ? String(raw.action).trim() : '';
  if (action && !actions[action]) throw new Error(`${sourcePath}: incidents[${idx}] action "${action}" 未在 actions{} 里定义`);

  const check = raw.check ? String(raw.check).trim() : '';
  const when = normalizeWhen(raw.when);
  if (!check && !when) throw new Error(`${sourcePath}: incidents[${idx}] 必须定义 check 或 when`);

  return {
    id,
    severity,
    policy,
    check,
    when,
    expect: normalizeExpect(raw.expect),
    action,
    allowed_actions: Array.isArray(raw.allowed_actions) ? raw.allowed_actions.map(String).filter(Boolean) : [],
  };
}

function normalizeExpect(raw) {
  const expect = {};
  if (raw && typeof raw === 'object') {
    if (raw.exit_code != null) expect.exit_code = Number(raw.exit_code);
    if (raw.stdout_contains) expect.stdout_contains = String(raw.stdout_contains);
    if (raw.stdout_match) expect.stdout_match = String(raw.stdout_match);
    if (raw.number_lt != null) expect.number_lt = Number(raw.number_lt);
    if (raw.number_lte != null) expect.number_lte = Number(raw.number_lte);
    if (raw.number_gt != null) expect.number_gt = Number(raw.number_gt);
    if (raw.number_gte != null) expect.number_gte = Number(raw.number_gte);
  }
  if (Object.keys(expect).length === 0) expect.exit_code = 0;
  return expect;
}

function normalizeWhen(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const step = String(raw.step || '').trim();
  if (!step) return null;
  const out = { step };
  if (raw.exit_code != null) out.exit_code = Number(raw.exit_code);
  if (raw.exit_code_not != null) out.exit_code_not = Number(raw.exit_code_not);
  if (raw.stdout_contains) out.stdout_contains = String(raw.stdout_contains);
  if (raw.stdout_match) out.stdout_match = String(raw.stdout_match);
  return out;
}

function normalizeUi(raw, actions, sourcePath) {
  const result = {};
  if (Array.isArray(raw.instance_actions) && raw.instance_actions.length > 0) {
    const seenIds = new Set();
    result.instance_actions = raw.instance_actions.map((item, idx) => {
      if (!item || typeof item !== 'object') throw new Error(`${sourcePath}: ui.instance_actions[${idx}] 必须是对象`);
      const id = String(item.id || '').trim();
      if (!id) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] 缺少 id`);
      if (seenIds.has(id)) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] id "${id}" 重复`);
      seenIds.add(id);

      const label = String(item.label || id).trim();
      const action = String(item.action || '').trim();
      if (!action) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] 缺少 action`);
      if (!actions[action]) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] action "${action}" 未在 actions{} 里定义`);

      const style = ['primary', 'success', 'danger', 'default'].includes(item.style) ? item.style : 'default';
      const confirm = item.confirm ? String(item.confirm) : null;
      return { id, label, action, style, confirm };
    });
  }
  return Object.keys(result).length > 0 ? result : null;
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = { loadProgram, normalizeProgram };

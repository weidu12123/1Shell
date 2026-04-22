'use strict';

/**
 * Program Schema — 定义并校验 data/programs/<id>/program.yaml
 *
 * Program 是**长驻运维程序**（与 Playbook 的"一次性执行"相对）：
 * 由 triggers 驱动，在绑定的 hosts 上周期性或按事件执行 actions。
 * 每个 (program_id, host_id) 组合是一个独立实例，有独立 state。
 *
 * Schema：
 *   id           (从目录名推导)
 *   name         人类可读名称
 *   description  说明
 *   enabled      全局开关（默认 true）
 *   hosts        [hostId] 或 'all' 或 'local'
 *   triggers[]   cron | manual
 *     - id
 *     - type: cron | manual
 *     - schedule: '*\/5 * * * *'   (cron only)
 *     - action: <action_name>
 *   actions{}    { name: { steps: [...], on_fail?: escalate|ignore|stop } }
 *   guardian     — Guardian AI 配置（可选，on_fail: escalate 时使用）
 *
 * Step 语法复用 playbook-schema（exec / render + verify），不发明新格式。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cron = require('node-cron');

const { normalizeStep } = require('../skills/playbook-schema');

/**
 * @returns {object|null}
 */
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

  // hosts: 'all' | 'local' | string[]
  let hosts;
  if (doc.hosts === 'all') hosts = 'all';
  else if (Array.isArray(doc.hosts)) {
    hosts = doc.hosts.map(String).filter(Boolean);
    if (hosts.length === 0) {
      throw new Error(`${sourcePath}: hosts 数组不能为空（或用 'all'）`);
    }
  } else if (typeof doc.hosts === 'string') {
    hosts = [doc.hosts.trim()];
  } else {
    throw new Error(`${sourcePath}: hosts 必须是字符串、数组或 'all'`);
  }

  // actions: { name → { steps, on_fail } }
  const rawActions = doc.actions || {};
  if (typeof rawActions !== 'object') {
    throw new Error(`${sourcePath}: actions 必须是对象`);
  }
  const actions = {};
  const seenActions = Object.keys(rawActions);
  if (seenActions.length === 0) {
    throw new Error(`${sourcePath}: 至少需要定义一个 action`);
  }
  for (const [actName, raw] of Object.entries(rawActions)) {
    actions[actName] = normalizeAction(raw, actName, sourcePath);
  }

  // triggers
  const rawTriggers = Array.isArray(doc.triggers) ? doc.triggers : [];
  if (rawTriggers.length === 0) {
    throw new Error(`${sourcePath}: triggers 数组不能为空`);
  }
  const seenTriggerIds = new Set();
  const triggers = rawTriggers.map((t, idx) =>
    normalizeTrigger(t, idx, seenTriggerIds, actions, sourcePath),
  );

  // guardian 配置（可选）
  const guardian = doc.guardian && typeof doc.guardian === 'object'
    ? normalizeGuardian(doc.guardian, sourcePath)
    : { enabled: false, skills: [], max_actions_per_hour: 20 };

  return {
    id,
    name,
    description,
    enabled,
    hosts,
    triggers,
    actions,
    guardian,
  };
}

function normalizeAction(raw, actName, sourcePath) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourcePath}: action "${actName}" 必须是对象`);
  }
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (rawSteps.length === 0) {
    throw new Error(`${sourcePath}: action "${actName}" 必须至少有一个 step`);
  }
  const seenIds = new Set();
  const steps = rawSteps.map((s, idx) =>
    normalizeStep(s, idx, seenIds, `${sourcePath} action="${actName}"`),
  );
  const onFail = raw.on_fail || 'stop';
  if (!['stop', 'ignore', 'escalate'].includes(onFail)) {
    throw new Error(`${sourcePath}: action "${actName}" on_fail 必须是 stop|ignore|escalate`);
  }
  return { steps, on_fail: onFail };
}

function normalizeTrigger(raw, idx, seenIds, actions, sourcePath) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourcePath}: triggers[${idx}] 必须是对象`);
  }
  const id = String(raw.id || '').trim();
  if (!id) throw new Error(`${sourcePath}: triggers[${idx}] 缺少 id`);
  if (seenIds.has(id)) throw new Error(`${sourcePath}: triggers[${idx}] id "${id}" 重复`);
  seenIds.add(id);

  const type = String(raw.type || 'manual').trim();
  if (!['cron', 'manual'].includes(type)) {
    throw new Error(
      `${sourcePath}: triggers[${idx}] type "${type}" 未知（支持 cron | manual）`,
    );
  }

  const actionName = String(raw.action || '').trim();
  if (!actionName) {
    throw new Error(`${sourcePath}: triggers[${idx}] 缺少 action 字段`);
  }
  if (!actions[actionName]) {
    throw new Error(
      `${sourcePath}: triggers[${idx}] action "${actionName}" 未在 actions{} 里定义`,
    );
  }

  const out = { id, type, action: actionName };

  if (type === 'cron') {
    const schedule = String(raw.schedule || '').trim();
    if (!schedule) {
      throw new Error(`${sourcePath}: triggers[${idx}] cron 类型缺少 schedule`);
    }
    if (!cron.validate(schedule)) {
      throw new Error(`${sourcePath}: triggers[${idx}] schedule "${schedule}" 不是合法的 cron 表达式`);
    }
    out.schedule = schedule;
  }

  return out;
}

function normalizeGuardian(raw, sourcePath) {
  const enabled = raw.enabled === true;
  const skills = Array.isArray(raw.skills) ? raw.skills.map(String).filter(Boolean) : [];
  const maxPerHour = Number(raw.max_actions_per_hour);
  const max_actions_per_hour = Number.isFinite(maxPerHour) && maxPerHour > 0
    ? Math.min(maxPerHour, 1000)
    : 20;
  return { enabled, skills, max_actions_per_hour };
}

module.exports = { loadProgram, normalizeProgram };
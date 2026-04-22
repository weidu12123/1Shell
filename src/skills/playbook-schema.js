'use strict';

/**
 * Playbook Schema — 定义并校验 data/skills/<id>/playbook.yaml 的结构。
 *
 * 设计目标：让 Skill 的"执行流"从自然语言工作流（workflows/*.md）转为
 * 结构化步骤列表，从而支持 L1 确定性执行器直跑（0 token），
 * 仅在某步失败时由 L2 Rescuer 介入修复。
 *
 * 两种 step 类型：
 *   - exec   : 在目标主机执行一条 shell 命令，带 verify 判定
 *   - render : 组装前面 step 的输出，直接调 render_result 推给前端（不过 AI）
 *
 * Schema 最小必要字段：
 *   goal       : 任务目标（一句话，Rescuer 介入时会读到）
 *   steps[]    : 至少一个 step
 *
 * 可选字段：
 *   budget.max_rescues  : Rescuer 介入次数上限，默认 2
 *   budget.max_tokens   : Token 软上限（仅用于提示，不强制熔断），默认 50000
 *   step.verify         : 成功判定，缺省时仅用 exit_code === 0
 *   step.on_error_hint  : 作者留给 Rescuer 的修复提示（自然语言）
 *   step.timeout        : 毫秒，默认 30000
 *   step.optional       : true 时失败不触发 Rescuer，仅标记跳过
 *   rescuer_skill       : 绑定的 Rescue Skill id（指向 data/skills/<id>/）。
 *                         有值时 Rescuer 会在硬约束之上叠加该 Skill 的
 *                         rules / references / workflows 作为"场景化约束"。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_BUDGET = {
  max_rescues: 2,
  max_tokens: 50000,
};

const DEFAULT_STEP_TIMEOUT_MS = 30000;

/**
 * 从 Skill 目录加载 playbook.yaml。
 * @returns {object|null} 规范化后的 playbook；不存在或无效时返回 null。
 */
function loadPlaybook(skillDir) {
  const playbookPath = path.join(skillDir, 'playbook.yaml');
  if (!fs.existsSync(playbookPath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(playbookPath, 'utf8');
  } catch {
    return null;
  }

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new Error(`playbook.yaml 解析失败: ${err.message}`);
  }

  return normalizePlaybook(doc, playbookPath);
}

/**
 * 校验并规范化 playbook 对象。抛出错误时消息面向 Skill 作者。
 */
function normalizePlaybook(doc, sourcePath = 'playbook.yaml') {
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${sourcePath}: 根节点必须是对象`);
  }

  const goal = String(doc.goal || '').trim();
  if (!goal) {
    throw new Error(`${sourcePath}: 必须定义顶层 goal 字段（一句话描述任务目标）`);
  }

  const rawSteps = Array.isArray(doc.steps) ? doc.steps : [];
  if (rawSteps.length === 0) {
    throw new Error(`${sourcePath}: steps 数组不能为空`);
  }

  const seenIds = new Set();
  const steps = rawSteps.map((s, idx) => normalizeStep(s, idx, seenIds, sourcePath));

  const budget = {
    max_rescues: clampInt(doc.budget?.max_rescues, 0, 10, DEFAULT_BUDGET.max_rescues),
    max_tokens: clampInt(doc.budget?.max_tokens, 1000, 1000000, DEFAULT_BUDGET.max_tokens),
  };

  const rescuerSkill = doc.rescuer_skill ? String(doc.rescuer_skill).trim() : '';
  if (rescuerSkill && !/^[a-z0-9][a-z0-9-]*$/.test(rescuerSkill)) {
    throw new Error(
      `${sourcePath}: rescuer_skill "${rescuerSkill}" 不合法，必须是 kebab-case id（小写字母/数字/连字符）`,
    );
  }

  return {
    goal,
    description: doc.description ? String(doc.description) : '',
    budget,
    steps,
    rescuer_skill: rescuerSkill,
  };
}

function normalizeStep(step, idx, seenIds, sourcePath) {
  if (!step || typeof step !== 'object') {
    throw new Error(`${sourcePath}: steps[${idx}] 必须是对象`);
  }

  const id = String(step.id || '').trim();
  if (!id) {
    throw new Error(`${sourcePath}: steps[${idx}] 缺少 id`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(
      `${sourcePath}: steps[${idx}].id "${id}" 不合法，必须以字母或下划线开头、仅含字母数字下划线`,
    );
  }
  if (seenIds.has(id)) {
    throw new Error(`${sourcePath}: steps[${idx}].id "${id}" 重复`);
  }
  seenIds.add(id);

  const type = step.type ? String(step.type).trim() : 'exec';

  if (type === 'exec') return normalizeExecStep(step, id, idx, sourcePath);
  if (type === 'render') return normalizeRenderStep(step, id, idx, sourcePath);

  throw new Error(`${sourcePath}: steps[${idx}] 未知 type "${type}"（支持 exec | render）`);
}

function normalizeExecStep(step, id, idx, sourcePath) {
  const run = String(step.run || '').trim();
  if (!run) {
    throw new Error(`${sourcePath}: steps[${idx}](${id}) 类型为 exec，必须有 run 字段`);
  }

  return {
    id,
    type: 'exec',
    label: String(step.label || id),
    run,
    timeout: clampInt(step.timeout, 1000, 600000, DEFAULT_STEP_TIMEOUT_MS),
    verify: normalizeVerify(step.verify),
    on_error_hint: step.on_error_hint ? String(step.on_error_hint) : '',
    optional: step.optional === true || step.optional === 'true',
    capture_stdout: step.capture_stdout !== false, // 默认 true，Rescuer 和 render step 都需要
  };
}

function normalizeRenderStep(step, id, idx, sourcePath) {
  const format = String(step.format || '').trim();
  if (!['table', 'keyvalue', 'list', 'message'].includes(format)) {
    throw new Error(
      `${sourcePath}: steps[${idx}](${id}) 类型为 render，format 必须是 table/keyvalue/list/message`,
    );
  }

  const out = {
    id,
    type: 'render',
    label: String(step.label || id),
    format,
    title: step.title ? String(step.title) : '',
    subtitle: step.subtitle ? String(step.subtitle) : '',
    level: ['info', 'success', 'warning', 'error'].includes(step.level) ? step.level : 'info',
  };

  // keyvalue
  if (Array.isArray(step.items_from_steps)) {
    out.items_from_steps = step.items_from_steps.map((it) => ({
      key: String(it.key || ''),
      value_from: it.value_from ? String(it.value_from) : '',
      value: it.value != null ? String(it.value) : undefined,
      prefix: it.prefix ? String(it.prefix) : '',
      suffix: it.suffix ? String(it.suffix) : '',
      transform: it.transform ? String(it.transform) : '', // 'trim' | 'first_line' | 'json_path:xxx'
    }));
  }
  if (Array.isArray(step.items)) {
    out.items = step.items.map((it) => ({
      key: String(it.key || ''),
      value: String(it.value || ''),
    }));
  }

  // table
  if (Array.isArray(step.columns)) out.columns = step.columns.map(String);
  if (Array.isArray(step.rows)) out.rows = step.rows.map((r) => (Array.isArray(r) ? r.map(String) : []));
  if (step.rows_from_step) out.rows_from_step = String(step.rows_from_step);
  if (Array.isArray(step.rowActions)) {
    out.rowActions = step.rowActions.map((a) => ({
      label: String(a.label || ''),
      value: String(a.value || ''),
    }));
  }
  if (step.row_action_skill) out.row_action_skill = String(step.row_action_skill);

  // list
  if (Array.isArray(step.listItems)) {
    out.listItems = step.listItems.map((it) => ({
      title: String(it.title || ''),
      description: String(it.description || ''),
    }));
  }

  // message
  if (step.content) out.content = String(step.content);
  if (step.content_from) out.content_from = String(step.content_from);

  return out;
}

function normalizeVerify(v) {
  // 缺省：只看 exit code === 0
  if (!v || typeof v !== 'object') return { exit_code: 0 };

  const out = {};
  if (v.exit_code != null) {
    const n = Number(v.exit_code);
    if (Number.isInteger(n)) out.exit_code = n;
  } else {
    out.exit_code = 0;
  }
  if (v.stdout_match) out.stdout_match = String(v.stdout_match);
  if (v.stdout_contains) out.stdout_contains = String(v.stdout_contains);
  if (v.stderr_not_contains) out.stderr_not_contains = String(v.stderr_not_contains);
  if (v.min_duration_ms != null) out.min_duration_ms = Number(v.min_duration_ms) || 0;
  return out;
}

/**
 * 根据 verify 规则判断一次 exec 结果是否通过。
 * @returns {{ ok: boolean, reason?: string }}\n */
function checkVerify(verify, execResult) {
  const { exitCode, stderr = '', durationMs = 0 } = execResult;
  // Shell 命令输出通常以 \r\n 或 \n 结尾。
  // JS 的 $ 锚（非 multiline 模式）只匹配字符串末位，不匹配 \n 前的位置，
  // 因此 /^\d+$/.test("44\n") === false。
  // 统一去掉尾部空白后再做正则和 contains 匹配。
  const stdout = (execResult.stdout || '').replace(/[\r\n\s]+$/, '');

  if (verify.exit_code != null && exitCode !== verify.exit_code) {
    return { ok: false, reason: `exit_code=${exitCode}，期望 ${verify.exit_code}` };
  }
  if (verify.stdout_match) {
    try {
      const re = new RegExp(verify.stdout_match);
      if (!re.test(stdout)) {
        return { ok: false, reason: `stdout 不匹配正则 /${verify.stdout_match}/` };
      }
    } catch {
      return { ok: false, reason: `verify.stdout_match 不是合法正则: ${verify.stdout_match}` };
    }
  }
  if (verify.stdout_contains && !stdout.includes(verify.stdout_contains)) {
    return { ok: false, reason: `stdout 未包含 "${verify.stdout_contains}"` };
  }
  if (verify.stderr_not_contains && stderr.includes(verify.stderr_not_contains)) {
    return { ok: false, reason: `stderr 含有禁止字串 "${verify.stderr_not_contains}"` };
  }
  if (verify.min_duration_ms && durationMs < verify.min_duration_ms) {
    return { ok: false, reason: `执行耗时 ${durationMs}ms < ${verify.min_duration_ms}ms，疑似未真正运行` };
  }
  return { ok: true };
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = {
  loadPlaybook,
  normalizePlaybook,
  normalizeStep,          // 供 Program Engine 复用（Program 的 step 语法与 Playbook 一致）
  checkVerify,
  DEFAULT_BUDGET,
  DEFAULT_STEP_TIMEOUT_MS,
};
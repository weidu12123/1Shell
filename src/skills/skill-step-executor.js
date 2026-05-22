'use strict';

/**
 * L2 Skill Step Executor
 *
 * 当 Program 的步骤类型为 type: skill 时，由本模块执行。
 * 加载指定 Skill 的结构化上下文（rules / workflows / references），
 * 在约束框架内调用 AI 完成程序作者设计的任务。
 *
 * 与 L1（确定性执行，0 token）互补：L1 做能脚本化的事，L2 做需要判断力的事。
 * 与 L3（1Shell AI 全权）不同：L2 受 Skill 的 rules 约束，能力边界明确。
 *
 * 工具集：
 *   - execute_command    : 在目标主机执行命令
 *   - write_program_step : 修改 Program 步骤（自我改进）
 *   - report_outcome     : 宣告结果（success / failure + 输出）
 *   - request_l3_escalation : 向 L3 Controller 提交升级请求
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { exec: childExec } = require('child_process');
const { ROOT_DIR } = require('../config/env');
const { assessCommandRisk } = require('../ai/command-safety');

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const SKILL_BODY_PER_FILE_BYTES = 8 * 1024;
const SKILL_BODY_TOTAL_BYTES = 32 * 1024;
const SKILL_FILE_READ_MAX_BYTES = 24 * 1024;

// ─── L2 工具定义 ──────────────────────────────────────────────────────────

const L3_ESCALATION_TOOL = {
  name: 'request_l3_escalation',
  description:
    '向 1Shell L3 Controller 提交结构化升级请求。L2 不能直接接管 L3，只能用本工具请求。' +
    '\n适用：out_of_scope、risk_too_high、needs_human_decision、suspected_incident，或需要重启/防火墙/凭据/私钥/删除/降级等高风险操作。',
  input_schema: {
    type: 'object',
    properties: {
      disposition: { type: 'string', enum: ['unresolved', 'out_of_scope', 'risk_too_high', 'needs_human_decision', 'suspected_incident'] },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical', 'emergency'], description: '影响等级，默认 medium' },
      reason: { type: 'string', description: '升级原因' },
      evidence: { type: 'array', items: { type: 'string' }, description: '证据列表，例如 stdout/stderr 摘要、约束命中原因' },
      requestedAction: { type: 'string', description: '希望 L3 判断或执行的动作' },
      userDecisionNeeded: { type: 'boolean', description: '是否需要用户做业务/安全决策' },
    },
    required: ['disposition', 'reason'],
  },
};

const L2_BASE_TOOLS = [
  {
    name: 'read_skill_file',
    description:
      '按需读取当前 Program 绑定 Skill 的单个文件。SKILL.md 和 rules 摘要已在上下文中；workflows/references/examples/scripts 需要时再读，不要无目的全量读取。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 Skill 根目录的文件路径，如 workflows/repair.md、references/domain.md' },
      },
      required: ['path'],
    },
  },
  {
    name: 'execute_command',
    description:
      '在目标主机上执行非交互式 shell 命令，用于完成任务或诊断环境。' +
      '\n- 包管理器加 -y' +
      '\n- 长耗时命令把 timeout 设大' +
      '\n- 禁止 ssh/scp 连接其他主机' +
      '\n- 危险命令会被硬拦截并要求升级 L3',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_program_step',
    description:
      '修改当前 Program 某个 step 的 run 命令，直接写回 program.yaml。' +
      '\n用途：当你发现某步骤的命令需要调整时，用本工具将正确命令固化到 Program 里，' +
      '\n让下次触发时自动使用修正后的命令，实现自我改进。',
    input_schema: {
      type: 'object',
      properties: {
        stepId:     { type: 'string', description: '要修改的 step id' },
        newRun:     { type: 'string', description: '替换 step.run 的新 shell 命令' },
        actionName: { type: 'string', description: '可选，action 名，不填取第一个 action' },
      },
      required: ['stepId', 'newRun'],
    },
  },
];

const L2_TOOLS = [
  ...L2_BASE_TOOLS,
  L3_ESCALATION_TOOL,
  {
    name: 'report_outcome',
    description:
      '完成任务后必须调用本工具宣告结果。' +
      '\n- success : 任务已完成' +
      '\n- failure : 无法完成，需要说明原因',
    input_schema: {
      type: 'object',
      properties: {
        status:  { type: 'string', enum: ['success', 'failure'] },
        summary: { type: 'string', description: '简要说明做了什么 / 为何失败' },
        output:  { type: 'string', description: '步骤输出，供后续步骤引用' },
      },
      required: ['status', 'summary'],
    },
  },
];

const L2_REPAIR_TOOLS = [
  ...L2_BASE_TOOLS,
  L3_ESCALATION_TOOL,
  {
    name: 'report_outcome',
    description:
      '完成 L1 失败维护后必须调用本工具宣告结构化结论。' +
      '\n- resolved: 已修复，Program 可以继续' +
      '\n- unresolved: 在 Skill 约束内尝试后仍无法修复' +
      '\n- out_of_scope: 问题超出本 Program 绑定 Skill 的职责范围' +
      '\n- risk_too_high: 需要高风险操作，L2 不应执行' +
      '\n- needs_human_decision: 需要用户做业务/安全决策' +
      '\n- suspected_incident: 怀疑发生攻击、数据损坏或业务事故，应升级 L3',
    input_schema: {
      type: 'object',
      properties: {
        disposition: {
          type: 'string',
          enum: ['resolved', 'unresolved', 'out_of_scope', 'risk_too_high', 'needs_human_decision', 'suspected_incident'],
        },
        summary: { type: 'string', description: '一句话说明诊断/修复/升级原因' },
        output: { type: 'string', description: '可展示给用户或供后续步骤引用的结果' },
      },
      required: ['disposition', 'summary'],
    },
  },
];

// ─── Skill 上下文加载 ─────────────────────────────────────────────────────

function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return raw;
  return raw.substring(endIdx + 4).trim();
}

function readMdDir(dir, remainingRef) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  const out = [];
  for (const e of entries.filter((x) => x.isFile() && x.name.toLowerCase().endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (remainingRef.value <= 0) break;
    let content = '';
    try { content = fs.readFileSync(path.join(dir, e.name), 'utf8'); }
    catch { continue; }
    const clip = content.slice(0, Math.min(SKILL_BODY_PER_FILE_BYTES, remainingRef.value));
    remainingRef.value -= Buffer.byteLength(clip, 'utf8');
    out.push({ name: e.name.replace(/\.md$/i, ''), content: clip });
  }
  return out;
}

function listSkillReadableFiles(skillDir) {
  const roots = ['workflows', 'references', 'examples', 'scripts', 'templates'];
  const out = [];
  for (const root of roots) {
    const abs = path.join(skillDir, root);
    if (!fs.existsSync(abs)) continue;
    collectSkillFiles(abs, root, out);
  }
  return out.sort();
}

function collectSkillFiles(absDir, relDir, out) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`.replace(/\\/g, '/');
    if (entry.isDirectory()) collectSkillFiles(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function loadSkillContext(skillRegistry, skillId) {
  if (!skillId || !skillRegistry) return null;
  const skill = typeof skillRegistry.getSkill === 'function'
    ? skillRegistry.getSkill(skillId)
    : null;
  if (!skill?.dir) return null;
  if (skill.kind && skill.kind !== 'skill') return null;

  const remaining = { value: SKILL_BODY_TOTAL_BYTES };

  let body = '';
  try {
    const raw = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
    body = stripFrontmatter(raw).slice(0, SKILL_BODY_PER_FILE_BYTES);
    remaining.value -= Buffer.byteLength(body, 'utf8');
  } catch { /* ignore */ }

  const rules = readMdDir(path.join(skill.dir, 'rules'), remaining);
  const fileIndex = listSkillReadableFiles(skill.dir);

  const hasAny = body || rules.length || fileIndex.length;
  if (!hasAny) return null;

  return {
    id: skillId,
    name: skill.name || skillId,
    dir: skill.dir,
    body,
    rules,
    fileIndex,
  };
}

// ─── Prompt 构造 ──────────────────────────────────────────────────────────

function buildL2System({ program, host, step, skillContext }) {
  const isLocal = host.id === 'local';
  let hostDesc;
  if (isLocal) {
    const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    hostDesc = `1Shell 本机 · ${os} · ${process.arch}`;
  } else {
    hostDesc = `${host.name} (${host.username || 'root'}@${host.host}:${host.port || 22})`;
  }

  const lines = [
    `你是 1Shell 的 L2 AI，通过 Skill 提供的上下文在目标主机上完成特定任务。`,
    `你是 Program「${program.name}」的一个 Skill 步骤，被程序作者设计用来处理 L1 确定性步骤做不到的操作。`,
    ``,
    `## 当前任务`,
    `- Step: \`${step.id}\` — ${step.label}`,
    `- 目标: ${step.goal}`,
    ``,
    `## 目标主机`,
    `- ${hostDesc}`,
    `- hostId: \`${host.id}\``,
    `- execute_command 自动在此主机执行，不要指定 host。`,
    isLocal && process.platform === 'win32' ? `- **注意：本机是 Windows，禁止使用 Linux 命令（df、grep、awk、head 等），必须用 PowerShell 或 cmd 命令。**` : '',
    ``,
    `## 工作流程`,
    `1. 阅读下方 SKILL.md 路由、rules 和文件索引；需要具体 workflow/reference/example/script 时，用 read_skill_file 按需读取单个文件`,
    `2. 用 execute_command 在目标主机上执行必要操作`,
    `3. 如发现 Program 的 exec 步骤命令需要修正，用 write_program_step 固化改进`,
    `4. 如超出 L2 权限，调用 request_l3_escalation 提交升级请求`,
    `5. 完成后调用 report_outcome 宣告结果`,
    ``,
    `## 硬约束`,
    `- Skill 的 rules 是铁律，不可违反`,
    `- 禁止 rm -rf /、dd、mkfs、fork bomb、shutdown、reboot`,
    `- 禁止操作名称含 "1shell" 的资源`,
    `- 禁止修改 /etc/ssh/ 下任何文件`,
    `- 最终必须调用 report_outcome`,
  ];

  if (step.on_error_hint) {
    lines.push(``, `## 作者提示`, step.on_error_hint.trim());
  }

  if (skillContext) {
    lines.push(``, `---`, ``, `## Skill 能力包: ${skillContext.name} (\`${skillContext.id}\`)`);
    if (skillContext.body) lines.push(``, skillContext.body.trim());
    for (const r of skillContext.rules) {
      lines.push(``, `### 规则 · ${r.name}`, r.content.trim());
    }
    if (skillContext.fileIndex?.length) {
      lines.push(``, `### 可按需读取的文件索引`, `需要具体流程、参考、示例或脚本时，用 read_skill_file 读取单个文件，不要全量读取。`);
      for (const file of skillContext.fileIndex) lines.push(`- ${file}`);
    }
  }

  return lines.join('\n');
}

function buildL2UserMessage({ step, stepOutputs }) {
  const lines = [
    `## 任务目标`,
    step.goal,
  ];

  if (stepOutputs && stepOutputs.size > 0) {
    lines.push(``, `## 前置步骤输出`);
    for (const [sid, out] of stepOutputs) {
      const stdout = (out.stdout || '').trimEnd().slice(-400);
      if (stdout) {
        lines.push(``, `### ${sid} (exitCode=${out.exitCode})`, '```', stdout, '```');
      }
    }
  }

  lines.push(``, `请按 Skill 的 workflows 执行任务，完成后调用 report_outcome。`);
  return lines.join('\n');
}

function buildL2RepairSystem({ program, host, skillContext }) {
  const isLocal = host.id === 'local';
  const hostDesc = isLocal
    ? `1Shell 本机 · ${process.platform === 'win32' ? 'Windows' : process.platform} · ${process.arch}`
    : `${host.name} (${host.username || 'root'}@${host.host}:${host.port || 22})`;

  const lines = [
    `你是 1Shell Program 的 L2 维护 AI。`,
    `你只在 Program「${program.name}」绑定的 1Shell Skill 约束下处理 L1 失败。`,
    `你的职责不是全权接管，而是：诊断、做低风险修复、修正 Program step，或明确升级 L3。`,
    ``,
    `## 目标主机`,
    `- ${hostDesc}`,
    `- hostId: \`${host.id}\``,
    `- execute_command 自动在此主机执行，不要指定 host。`,
    isLocal && process.platform === 'win32' ? `- 本机是 Windows，禁止使用 Linux 命令。` : '',
    ``,
    `## 工作流程`,
    `1. 阅读失败 step、verify 和 stdout/stderr`,
    `2. 按绑定 Skill 的 SKILL.md 路由、rules 和文件索引判断是否需要用 read_skill_file 读取具体 workflow/reference`,
    `3. 只做低风险诊断/修复；如需危险命令、停站、改 SSH/防火墙/数据库等，必须调用 request_l3_escalation 请求 L3`,
    `4. 如已验证更正确的命令，可用 write_program_step 固化`,
    `5. 最后必须调用 report_outcome，disposition 只能取枚举值`,
    ``,
    `## disposition 选择规则`,
    `- resolved: 已修复，Program 可以继续`,
    `- unresolved: 在当前 Skill 约束内无法修复，但不构成危机`,
    `- out_of_scope: 超出绑定 Skill 职责边界`,
    `- risk_too_high: 需要 L2 无权执行的高风险操作`,
    `- needs_human_decision: 需要用户做业务/安全选择`,
    `- suspected_incident: 怀疑攻击、数据损坏、业务事故或连锁故障`,
    ``,
    `## 硬约束`,
    `- Skill rules 是铁律，不可违反`,
    `- 禁止 rm -rf /、dd、mkfs、fork bomb、shutdown、reboot`,
    `- 禁止修改 /etc/ssh/ 或 sshd_config`,
    `- 禁止操作名称含 "1shell" 的资源`,
    `- 不确定就升级，不要越权`,
  ].filter(Boolean);

  if (skillContext) {
    lines.push(``, `---`, ``, `## Program 绑定 Skill: ${skillContext.name} (\`${skillContext.id}\`)`);
    if (skillContext.body) lines.push(``, skillContext.body.trim());
    for (const r of skillContext.rules) lines.push(``, `### 规则 · ${r.name}`, r.content.trim());
    if (skillContext.fileIndex?.length) {
      lines.push(``, `### 可按需读取的文件索引`, `需要具体流程、参考、示例或脚本时，用 read_skill_file 读取单个文件，不要全量读取。`);
      for (const file of skillContext.fileIndex) lines.push(`- ${file}`);
    }
  }

  return lines.join('\n');
}

function buildL2RepairUserMessage({ failingStep, failureReason, execResult, stepOutputs, attempt }) {
  const stdoutTail = (execResult?.stdout || '').trimEnd().slice(-800);
  const stderrTail = (execResult?.stderr || '').trimEnd().slice(-1000);
  const lines = [
    `## L1 失败上下文`,
    `- attempt: ${attempt}`,
    `- step: \`${failingStep.id}\` — ${failingStep.label || failingStep.id}`,
    `- command: \`${(failingStep.run || '').slice(0, 500)}\``,
    `- failureReason: ${failureReason}`,
    `- exitCode: ${execResult?.exitCode}`,
  ];
  if (failingStep.verify) lines.push('', '### verify', '```json', JSON.stringify(failingStep.verify, null, 2), '```');
  if (stdoutTail) lines.push('', '### stdout 末尾', '```', stdoutTail, '```');
  if (stderrTail) lines.push('', '### stderr 末尾', '```', stderrTail, '```');
  if (failingStep.on_error_hint) lines.push('', '### 作者提示', failingStep.on_error_hint.trim());

  if (stepOutputs && stepOutputs.size > 0) {
    lines.push('', '## 已完成步骤输出摘要');
    for (const [sid, out] of stepOutputs) {
      const stdout = (out.stdout || '').trimEnd().slice(-300);
      if (stdout) lines.push('', `### ${sid} (exitCode=${out.exitCode})`, '```', stdout, '```');
    }
  }

  lines.push('', '请在 Program 绑定 Skill 约束内维护该失败；完成后调用 report_outcome。');
  return lines.join('\n');
}

// ─── 命令执行辅助 ─────────────────────────────────────────────────────────

function execLocal(command, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS);
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

function formatExecResult({ stdout, stderr, exitCode }) {
  const parts = [];
  if (stdout?.trim()) parts.push(`[stdout]\n${stdout.trimEnd()}`);
  if (stderr?.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  if (!parts.length) parts.push('[stdout] (空)');
  parts.push(`[exitCode] ${exitCode}`);
  return parts.join('\n\n');
}

// ─── 工具 Handler ─────────────────────────────────────────────────────────

async function handleExec(tu, { hostId, bridgeService, io, sessionId }) {
  const command = String(tu.input?.command || '').trim();
  const timeout = Number(tu.input?.timeout) > 0 ? Number(tu.input.timeout) : DEFAULT_EXEC_TIMEOUT_MS;
  if (!command) {
    return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] command 空', is_error: true };
  }

  const risk = assessCommandRisk(command);
  if (risk.dangerous) {
    io?.emit?.('program:l2:info', {
      sessionId,
      message: `危险命令被 L2 拦截：${risk.reason}。请 request_l3_escalation 后 report_outcome disposition=risk_too_high。`,
    });
    return {
      type: 'tool_result',
      tool_use_id: tu.id,
      is_error: true,
      content: `[BLOCKED] ${risk.reason}。L2 无权执行该命令，请先 request_l3_escalation，再 report_outcome disposition=risk_too_high。`,
    };
  }

  io?.emit?.('program:l2:exec', { sessionId, toolUseId: tu.id, command, timeout, hostId });

  let result;
  try {
    result = hostId === 'local'
      ? await execLocal(command, timeout)
      : await bridgeService.execOnHost(hostId, command, timeout, { source: 'l2-skill' });
  } catch (err) {
    result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
  }

  // 断连重试
  if (result.exitCode !== 0 && result.durationMs < 150 && hostId !== 'local') {
    await new Promise((r) => setTimeout(r, 200));
    try {
      result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'l2-skill-retry' });
    } catch (err) {
      result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
    }
  }

  io?.emit?.('program:l2:exec-result', {
    sessionId, toolUseId: tu.id,
    stdout: result.stdout, stderr: result.stderr,
    exitCode: result.exitCode, durationMs: result.durationMs,
  });

  return {
    type: 'tool_result', tool_use_id: tu.id,
    content: formatExecResult(result), is_error: result.exitCode !== 0,
  };
}

function handleReadSkillFile(tu, { skillContext }) {
  if (!skillContext?.dir) {
    return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] Skill 上下文为空', is_error: true };
  }
  const rawPath = String(tu.input?.path || '').trim().replace(/\\/g, '/');
  if (!rawPath) {
    return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] path 为空', is_error: true };
  }
  const normalized = path.posix.normalize(rawPath);
  if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(rawPath)) {
    return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 路径越界: ${rawPath}`, is_error: true };
  }
  const allowed = normalized === 'SKILL.md' || /^(rules|workflows|references|examples|scripts|templates)\//.test(normalized);
  if (!allowed) {
    return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 只能读取 SKILL.md 或 rules/workflows/references/examples/scripts/templates 下的文件: ${rawPath}`, is_error: true };
  }
  const abs = path.resolve(skillContext.dir, normalized);
  if (!(abs.startsWith(skillContext.dir + path.sep) || abs === skillContext.dir)) {
    return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 路径越界: ${rawPath}`, is_error: true };
  }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 不是文件: ${rawPath}`, is_error: true };
    const content = fs.readFileSync(abs, 'utf8').slice(0, SKILL_FILE_READ_MAX_BYTES);
    return { type: 'tool_result', tool_use_id: tu.id, content: `# ${skillContext.id}/${normalized}\n\n${content}` };
  } catch (err) {
    return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 读取失败: ${err.message}`, is_error: true };
  }
}

async function handleRequestL3Escalation(tu, { l3EscalationController, program, hostId, step, runId, sessionId, source }) {
  if (!l3EscalationController) {
    return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] L3 Controller 未配置', is_error: true };
  }
  const result = await l3EscalationController.request({
    ...(tu.input || {}),
    program,
    programId: program.id,
    runId,
    hostId,
    step,
    stepId: step.id,
    sourceLayer: 'L2',
    sessionId,
    source: source || 'program-l2',
  });
  return {
    type: 'tool_result',
    tool_use_id: tu.id,
    content: JSON.stringify(result, null, 2),
    is_error: result.decision !== 'accepted' || result.guardian?.ok === false,
    l3Escalation: result,
  };
}

async function handleWriteProgramStep(tu, { program, io, sessionId }) {
  const { stepId, newRun, actionName } = tu.input || {};
  if (!stepId || !newRun) {
    return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] stepId 和 newRun 均为必填', is_error: true };
  }

  const yamlPath = path.join(program.dir || path.join(ROOT_DIR, 'data', 'programs', program.id), 'program.yaml');
  if (!fs.existsSync(yamlPath)) {
    return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] program.yaml 不存在: ${yamlPath}`, is_error: true };
  }

  let raw;
  try { raw = fs.readFileSync(yamlPath, 'utf8'); }
  catch (e) { return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 读取失败: ${e.message}`, is_error: true }; }

  const actions = program.actions || {};
  const targetAction = actionName && actions[actionName] ? actionName : Object.keys(actions)[0];
  if (!targetAction) {
    return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] 找不到 action', is_error: true };
  }

  const steps = actions[targetAction]?.steps || [];
  const targetStep = steps.find((s) => s.id === stepId);
  if (!targetStep) {
    return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] step "${stepId}" 不存在于 action "${targetAction}"`, is_error: true };
  }

  const escapedStepId = stepId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRegex = new RegExp(
    `((?:^|\\n)[ \\t]*-[ \\t]+id:[ \\t]+${escapedStepId}[\\s\\S]*?\\n)([ \\t]+)run:[ \\t]*(?:[^\\n]*(?:\\n\\2[ \\t]+[^\\n]+)*)`,
    'm'
  );

  const indentMatch = raw.match(new RegExp(`\\n([ \\t]+)-[ \\t]+id:[ \\t]+${escapedStepId}`));
  const baseIndent = indentMatch ? indentMatch[1] + '  ' : '        ';
  const fieldIndent = baseIndent + '  ';
  const newRunYaml = newRun.includes('\n')
    ? `run: |\n${newRun.split('\n').map((l) => fieldIndent + l).join('\n')}`
    : `run: ${newRun}`;

  let newRaw;
  if (blockRegex.test(raw)) {
    newRaw = raw.replace(blockRegex, (match, prefix, indent) => `${prefix}${indent}${newRunYaml}`);
  } else {
    const oldRunLine = new RegExp(`([ \\t]+run:[ \\t]*)${targetStep.run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (oldRunLine.test(raw)) {
      newRaw = raw.replace(oldRunLine, `$1${newRun}`);
    } else {
      return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] 无法在 YAML 中定位 run 字段，请人工修改', is_error: true };
    }
  }

  try { fs.writeFileSync(yamlPath, newRaw, 'utf8'); }
  catch (e) { return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 写入失败: ${e.message}`, is_error: true }; }

  io?.emit?.('program:l2:info', { sessionId, message: `write_program_step: ${program.id}.${targetAction}.${stepId} 已更新` });

  return {
    type: 'tool_result', tool_use_id: tu.id,
    content: `OK - program.yaml 已更新：${program.id} / ${targetAction} / ${stepId}\n新命令：${newRun.slice(0, 200)}`,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────

function createSkillStepExecutor({
  bridgeService, hostService, proxyConfigStore, port,
  logger, skillRegistry, io, l3EscalationController,
}) {
  let globalUnlimitedTurns = false;

  function setUnlimitedTurns(enabled) { globalUnlimitedTurns = enabled; }
  function getUnlimitedTurns() { return globalUnlimitedTurns; }

  /**
   * 执行一个 type: skill 步骤。
   * @returns {{ ok, summary, output, stdout, exitCode, durationMs }}
   */
  async function execute({ program, hostId, step, stepOutputs, runId }) {
    const startAt = Date.now();

    const host = hostService.findHost(hostId)
      || (hostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) {
      return { ok: false, summary: `主机不存在: ${hostId}`, output: '', stdout: '', exitCode: 1, durationMs: 0 };
    }

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      return { ok: false, summary: 'AI Provider 未配置', output: '', stdout: '', exitCode: 1, durationMs: 0 };
    }

    const skillContext = loadSkillContext(skillRegistry, step.skill);
    if (!skillContext) {
      logger?.warn?.('[l2] Skill 未能加载', { runId, skillId: step.skill });
      return { ok: false, summary: `Skill "${step.skill}" 不存在或为空`, output: '', stdout: '', exitCode: 1, durationMs: 0 };
    }

    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;
    const model = provider.model || 'claude-sonnet-4-20250514';
    const sessionId = `l2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    io?.emit?.('program:l2:started', {
      sessionId, runId, programId: program.id, hostId,
      stepId: step.id, skillId: step.skill, goal: step.goal,
    });

    const system = buildL2System({ program, host, step, skillContext });
    const messages = [{
      role: 'user',
      content: buildL2UserMessage({ step, stepOutputs }),
    }];

    let status = null;   // 'success' | 'failure'
    let summary = '';
    let output = '';
    let l3Escalation = null;

    try {
      const maxTurns = globalUnlimitedTurns ? Infinity : DEFAULT_MAX_TURNS;

      for (let turn = 0; turn < maxTurns; turn++) {
        io?.emit?.('program:l2:thinking', { sessionId, turn: turn + 1 });

        let resp;
        try {
          resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 4096, system, messages, tools: L2_TOOLS }),
          });
        } catch (err) {
          summary = `AI 调用失败: ${err.message}`;
          status = 'failure';
          break;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          summary = `Provider 返回 ${resp.status}: ${errText.substring(0, 200)}`;
          status = 'failure';
          break;
        }

        const data = await resp.json();
        if (data.type === 'error') {
          summary = data.error?.message || 'Provider 返回错误';
          status = 'failure';
          break;
        }

        const content = Array.isArray(data.content) ? data.content : [];
        messages.push({ role: 'assistant', content });

        if (data.stop_reason === 'end_turn') {
          summary = 'L2 未调用 report_outcome 便结束';
          status = 'failure';
          break;
        }
        if (data.stop_reason !== 'tool_use') {
          summary = `L2 意外停止: ${data.stop_reason}`;
          status = 'failure';
          break;
        }

        const toolUses = content.filter((b) => b.type === 'tool_use');
        const toolResults = [];
        let outcomeReceived = false;

        for (const tu of toolUses) {
          if (tu.name === 'read_skill_file') {
            toolResults.push(handleReadSkillFile(tu, { skillContext }));

          } else if (tu.name === 'execute_command') {
            toolResults.push(await handleExec(tu, { hostId, bridgeService, io, sessionId }));

          } else if (tu.name === 'write_program_step') {
            toolResults.push(await handleWriteProgramStep(tu, { program, io, sessionId }));

          } else if (tu.name === 'request_l3_escalation') {
            const toolResult = await handleRequestL3Escalation(tu, { l3EscalationController, program, hostId, step, runId, sessionId, source: 'program-l2' });
            l3Escalation = toolResult.l3Escalation || l3Escalation;
            toolResults.push(toolResult);

          } else if (tu.name === 'report_outcome') {
            status = tu.input?.status === 'success' ? 'success' : 'failure';
            summary = String(tu.input?.summary || '').trim() || '(无说明)';
            output = String(tu.input?.output || '').trim();
            outcomeReceived = true;
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'OK' });
            break;

          } else {
            toolResults.push({
              type: 'tool_result', tool_use_id: tu.id,
              content: `Unknown tool: ${tu.name}`, is_error: true,
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
        if (outcomeReceived) break;
      }

      if (!status) {
        // 轮次耗尽，强制一轮总结确保有输出（结果导向）
        try {
          messages.push({ role: 'user', content: [{ type: 'text', text:
            '你已达到最大轮次限制。请立即：\n1. 调用 report_outcome 宣告结果（success 或 failure）\n2. 在 summary 中总结你目前的发现和已完成的操作\n3. 在 output 中输出你已采集到的关键数据\n不要再执行任何命令，直接总结。'
          }] });
          io?.emit?.('program:l2:thinking', { sessionId, turn: 'final-summary' });
          const finalResp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 4096, system, messages, tools: L2_TOOLS }),
          });
          if (finalResp.ok) {
            const finalData = await finalResp.json();
            const finalContent = Array.isArray(finalData.content) ? finalData.content : [];
            for (const tu of finalContent.filter(b => b.type === 'tool_use')) {
              if (tu.name === 'report_outcome') {
                status = tu.input?.status === 'success' ? 'success' : 'failure';
                summary = String(tu.input?.summary || '').trim() || '(轮次耗尽后总结)';
                output = String(tu.input?.output || '').trim();
              }
            }
          }
        } catch { /* 总结失败不影响主流程 */ }

        if (!status) {
          status = 'failure';
          summary = summary || `L2 超出最大轮次 (${DEFAULT_MAX_TURNS})`;
        }
      }
    } catch (err) {
      status = 'failure';
      summary = `L2 异常: ${err.message}`;
      logger?.error?.('[l2] execute exception', { runId, stepId: step.id, error: err.message });
    }

    const durationMs = Date.now() - startAt;
    const ok = status === 'success';

    io?.emit?.('program:l2:ended', { sessionId, runId, stepId: step.id, ok, summary, durationMs });

    return {
      ok,
      summary,
      output,
      stdout: output,
      stderr: ok ? '' : summary,
      exitCode: ok ? 0 : 1,
      durationMs,
      l3Escalation,
    };
  }

  async function repairFailure({ program, hostId, failingStep, failureReason, execResult, stepOutputs, runId, attempt = 1 }) {
    const startAt = Date.now();
    const host = hostService.findHost(hostId)
      || (hostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) {
      return { ok: false, disposition: 'unresolved', summary: `主机不存在: ${hostId}`, output: '', durationMs: 0 };
    }

    const skillId = program.l2?.skill || '';
    if (!skillId && program.l2?.require_skill_for_repair !== false) {
      return { ok: false, disposition: 'out_of_scope', summary: 'Program 未绑定 L2 维护 Skill', output: '', durationMs: 0 };
    }

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      return { ok: false, disposition: 'unresolved', summary: 'AI Provider 未配置', output: '', durationMs: 0 };
    }

    const skillContext = skillId ? loadSkillContext(skillRegistry, skillId) : null;
    if (skillId && !skillContext) {
      return { ok: false, disposition: 'out_of_scope', summary: `L2 维护 Skill "${skillId}" 不存在或为空`, output: '', durationMs: 0 };
    }

    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;
    const model = provider.model || 'claude-sonnet-4-20250514';
    const sessionId = `l2-repair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    io?.emit?.('program:l2:started', {
      sessionId, runId, programId: program.id, hostId,
      stepId: failingStep.id, skillId: skillId || '(none)', goal: `维护 L1 失败: ${failingStep.label || failingStep.id}`,
      mode: 'repair', attempt,
    });

    const system = buildL2RepairSystem({ program, host, skillContext });
    const messages = [{
      role: 'user',
      content: buildL2RepairUserMessage({ failingStep, failureReason, execResult, stepOutputs, attempt }),
    }];

    let disposition = null;
    let summary = '';
    let output = '';
    let l3Escalation = null;

    try {
      const maxTurns = globalUnlimitedTurns ? Infinity : DEFAULT_MAX_TURNS;
      for (let turn = 0; turn < maxTurns; turn++) {
        io?.emit?.('program:l2:thinking', { sessionId, turn: turn + 1, mode: 'repair' });

        let resp;
        try {
          resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 4096, system, messages, tools: L2_REPAIR_TOOLS }),
          });
        } catch (err) {
          disposition = 'unresolved';
          summary = `AI 调用失败: ${err.message}`;
          break;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          disposition = 'unresolved';
          summary = `Provider 返回 ${resp.status}: ${errText.substring(0, 200)}`;
          break;
        }

        const data = await resp.json();
        if (data.type === 'error') {
          disposition = 'unresolved';
          summary = data.error?.message || 'Provider 返回错误';
          break;
        }

        const content = Array.isArray(data.content) ? data.content : [];
        messages.push({ role: 'assistant', content });

        if (data.stop_reason === 'end_turn') {
          disposition = 'unresolved';
          summary = 'L2 维护未调用 report_outcome 便结束';
          break;
        }
        if (data.stop_reason !== 'tool_use') {
          disposition = 'unresolved';
          summary = `L2 维护意外停止: ${data.stop_reason}`;
          break;
        }

        const toolResults = [];
        let outcomeReceived = false;
        for (const tu of content.filter((b) => b.type === 'tool_use')) {
          if (tu.name === 'read_skill_file') {
            toolResults.push(handleReadSkillFile(tu, { skillContext }));
          } else if (tu.name === 'execute_command') {
            toolResults.push(await handleExec(tu, { hostId, bridgeService, io, sessionId }));
          } else if (tu.name === 'write_program_step') {
            if (program.l2?.allow_write_program === false) {
              toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: '[BLOCKED] Program 禁止 L2 写回 step', is_error: true });
            } else {
              toolResults.push(await handleWriteProgramStep(tu, { program, io, sessionId }));
            }
          } else if (tu.name === 'request_l3_escalation') {
            const toolResult = await handleRequestL3Escalation(tu, { l3EscalationController, program, hostId, step: failingStep, runId, sessionId, source: 'program-l2-repair' });
            l3Escalation = toolResult.l3Escalation || l3Escalation;
            toolResults.push(toolResult);
          } else if (tu.name === 'report_outcome') {
            disposition = String(tu.input?.disposition || 'unresolved');
            summary = String(tu.input?.summary || '').trim() || '(无说明)';
            output = String(tu.input?.output || '').trim();
            outcomeReceived = true;
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'OK' });
            break;
          } else {
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}`, is_error: true });
          }
        }
        messages.push({ role: 'user', content: toolResults });
        if (outcomeReceived) break;
      }

      if (!disposition) {
        disposition = 'unresolved';
        summary = summary || `L2 维护超出最大轮次 (${DEFAULT_MAX_TURNS})`;
      }
    } catch (err) {
      disposition = 'unresolved';
      summary = `L2 维护异常: ${err.message}`;
      logger?.error?.('[l2] repair exception', { runId, stepId: failingStep.id, error: err.message });
    }

    const durationMs = Date.now() - startAt;
    const ok = disposition === 'resolved';
    io?.emit?.('program:l2:ended', {
      sessionId, runId, stepId: failingStep.id, ok, summary, durationMs,
      disposition, mode: 'repair',
    });

    return { ok, disposition, summary, output, stdout: output, stderr: ok ? '' : summary, exitCode: ok ? 0 : 1, durationMs, l3Escalation };
  }

  /**
   * 根据上次 L2 执行日志，启动一次自我改进 session。
   * 分析哪些命令失败/超时，优化 Skill workflows 和 Program steps。
   */
  async function improve({ program, hostId, skillId, goal, execLog, runId }) {
    const startAt = Date.now();

    const host = hostService.findHost(hostId)
      || (hostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) return { ok: false, summary: '主机不存在' };

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) return { ok: false, summary: 'AI Provider 未配置' };

    const skillContext = loadSkillContext(skillRegistry, skillId);
    if (!skillContext) return { ok: false, summary: `Skill "${skillId}" 不存在` };

    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;
    const model = provider.model || 'claude-sonnet-4-20250514';
    const sessionId = `l2-improve_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const isLocal = host.id === 'local';
    let hostDesc;
    if (isLocal) {
      const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
      hostDesc = `1Shell 本机 · ${os} · ${process.arch}`;
    } else {
      hostDesc = `${host.name} (${host.username || 'root'}@${host.host}:${host.port || 22})`;
    }

    const MAX_IMPROVE_TURNS = 12;

    const system = [
      `你是 1Shell 的 L2 AI。当前任务是**纠错提速**，不是加功能。`,
      ``,
      `## 目标主机`,
      `- ${hostDesc}`,
      isLocal && process.platform === 'win32' ? `- **本机是 Windows，必须用 PowerShell 或 cmd 命令。**` : '',
      ``,
      `## 你的任务（严格遵守）`,
      `1. 阅读下方执行日志，找出失败（✗）和超时的命令`,
      `2. 针对每个失败命令，写出修正版本`,
      `3. 用 execute_command 验证修正命令（每个命令只验证一次，通过就行）`,
      `4. 用 write_program_step 把验证通过的命令写回 program.yaml`,
      `5. 立即调用 report_outcome 结束`,
      ``,
      `## 禁止`,
      `- 禁止添加新功能、新步骤、新检查`,
      `- 禁止探索性操作（不要扫描目录、不要尝试多种方案）`,
      `- 禁止超过 3 次 execute_command（验证即可，不要反复试）`,
      `- 每条命令 timeout 不超过 30000`,
    ].filter(Boolean).join('\n');

    const userMsg = [
      `## 上次执行日志（只修日志中标 ✗ 的失败命令）`,
      execLog,
      ``,
      `只修失败命令，验证通过后 write_program_step，然后 report_outcome。`,
    ].join('\n');

    io?.emit?.('program:l2:started', {
      sessionId, runId, programId: program.id, hostId,
      stepId: 'improve', skillId, goal: '自我改进：优化上次执行中的问题',
    });

    const messages = [{ role: 'user', content: userMsg }];
    let status = null, summary = '', output = '';

    try {
      for (let turn = 0; turn < MAX_IMPROVE_TURNS; turn++) {
        io?.emit?.('program:l2:thinking', { sessionId, turn: turn + 1 });

        let resp;
        try {
          resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 2048, system, messages, tools: L2_TOOLS }),
          });
        } catch (err) { summary = `AI 调用失败: ${err.message}`; status = 'failure'; break; }

        if (!resp.ok) { summary = `Provider ${resp.status}`; status = 'failure'; break; }

        const data = await resp.json();
        if (data.type === 'error') { summary = data.error?.message || 'error'; status = 'failure'; break; }

        const content = Array.isArray(data.content) ? data.content : [];
        messages.push({ role: 'assistant', content });

        if (data.stop_reason === 'end_turn' || data.stop_reason !== 'tool_use') {
          status = 'failure'; summary = 'AI 未调用 report_outcome'; break;
        }

        const toolUses = content.filter((b) => b.type === 'tool_use');
        const toolResults = [];
        let done = false;

        for (const tu of toolUses) {
          if (tu.name === 'execute_command') {
            toolResults.push(await handleExec(tu, { hostId, bridgeService, io, sessionId }));
          } else if (tu.name === 'write_program_step') {
            toolResults.push(await handleWriteProgramStep(tu, { program, io, sessionId }));
          } else if (tu.name === 'report_outcome') {
            status = tu.input?.status === 'success' ? 'success' : 'failure';
            summary = String(tu.input?.summary || '').trim() || '(无说明)';
            output = String(tu.input?.output || '').trim();
            done = true;
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'OK' });
            break;
          } else {
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown: ${tu.name}`, is_error: true });
          }
        }

        messages.push({ role: 'user', content: toolResults });
        if (done) break;
      }

      if (!status) { status = 'failure'; summary = '轮次耗尽'; }
    } catch (err) {
      status = 'failure'; summary = `异常: ${err.message}`;
    }

    const durationMs = Date.now() - startAt;
    const ok = status === 'success';
    io?.emit?.('program:l2:ended', { sessionId, runId, stepId: 'improve', ok, summary, durationMs });

    return { ok, summary, output, durationMs };
  }

  return { execute, repairFailure, improve, setUnlimitedTurns, getUnlimitedTurns };
}

module.exports = { createSkillStepExecutor };

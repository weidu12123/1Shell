'use strict';

/**
 * Guardian AI — Program 异常守护者
 *
 * 当 Program 的 step 失败且 action.on_fail === 'escalate' 时被唤起。
 * 与 L2 Rescuer（针对 Skill/Playbook 的一次性救援）不同，Guardian 是
 * **长驻程序的自愈逻辑**：目标是让 Program 持续稳定运行。
 *
 * 能力：
 *   - 读取 program.guardian.skills 白名单里的 Skill 能力包（rules + workflows + SKILL.md）
 *   - 在目标主机上用 execute_command 诊断 / 修复
 *   - 调用 ask_user 向前端弹窗（危险/白名单外操作必须问）
 *   - 最终 report_outcome → resolved | unresolvable
 *
 * 配额：per-program 每小时最多 N 次介入（滑动窗口）。
 * 安全：execute_command 会对"当前主机 + 白名单外的危险 pattern"做二次询问。
 *
 * Socket 事件（通过 io 广播，前端 programs.html 订阅）：
 *   guardian:session-started  { sessionId, programId, hostId, runId, failingStep }
 *   guardian:thinking         { sessionId, turn }
 *   guardian:thought          { sessionId, text }
 *   guardian:exec             { sessionId, toolUseId, command, timeout }
 *   guardian:exec-result      { sessionId, toolUseId, stdout, stderr, exitCode, durationMs }
 *   guardian:ask              { sessionId, toolUseId, payload }   (await)
 *   guardian:info             { sessionId, message }
 *   guardian:session-ended    { sessionId, resolution, reason }
 *
 * Socket 事件（前端 → 后端）：
 *   guardian:answer           { sessionId, toolUseId, answer }
 *   guardian:cancel           { sessionId }
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { exec: childExec } = require('child_process');
const { ROOT_DIR } = require('../config/env');

const DEFAULT_MAX_GUARDIAN_TURNS = 12;
const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const ASK_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟无人回应自动 give_up

const SKILL_BODY_PER_FILE_BYTES = 8 * 1024;
const SKILL_BODY_TOTAL_BYTES    = 32 * 1024;

// 危险命令 pattern（这些命令强制 ask_user，即使在 workflow 内）
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\b:(){:|:&};:/,              // fork bomb
  /\bchmod\s+-R\s+[0-7]{3,4}\s+\//,
  /\bshutdown\b/,
  /\breboot\b/,
];

// ─── 工具定义 ────────────────────────────────────────────────────────
const GUARDIAN_TOOLS = [
  {
    name: 'execute_command',
    description:
      '在目标主机上执行非交互式 shell 命令，用于诊断或修复 Program 的失败步骤。' +
      '\n- 包管理器加 -y' +
      '\n- 长耗时命令把 timeout 设大' +
      '\n- 绝对禁止 ssh/scp 连接其他主机',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number', description: '毫秒，默认 30000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ask_user',
    description:
      '向用户请示。场景：1) 白名单外的破坏性操作；2) 多候选需要用户选择；3) 修复方案不确定需要确认。' +
      '\n5 分钟无人回复自动 give_up。',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['select', 'confirm', 'input'] },
        title: { type: 'string' },
        description: { type: 'string' },
        danger: { type: 'boolean' },
        confirmLabel: { type: 'string' },
        cancelLabel: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } },
          },
        },
        placeholder: { type: 'string' },
        defaultValue: { type: 'string' },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'render_result',
    description: '向前端推送结构化结果（诊断报告 / 修复摘要）。format = message|keyvalue|table|list',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['message', 'keyvalue', 'table', 'list'] },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        content: { type: 'string' },
        items: { type: 'array' },
        columns: { type: 'array' },
        rows: { type: 'array' },
        listItems: { type: 'array' },
      },
      required: ['format'],
    },
  },
  {
    name: 'write_program_step',
    description:
      '修改当前 Program 某个 step 的 run 命令，直接写回 program.yaml。' +
      '\n用途：当 execute_command 已验证正确命令后，用本工具将正确命令固化到 Program 里，' +
      '让下次 cron/手动触发时自动使用修复后的命令，实现真正的自愈。' +
      '\n- stepId: 要修改的 step id（必须是当前 Program 的 step）' +
      '\n- newRun: 替换 step.run 的新 shell 命令' +
      '\n- actionName: 可选，指定 action 名，不填默认取第一个 action' +
      '\n修改后 Program 会自动重载，下次触发直接生效。',
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
  {
    name: 'report_outcome',
    description:
      '完成所有诊断 / 修复后，必须调用本工具宣告结果。' +
      '\n- resolved: 你已修复导致失败的根因，Program 可安全继续' +
      '\n- unresolvable: 无法在当前权限/上下文内修复，需要人介入',
    input_schema: {
      type: 'object',
      properties: {
        resolution: { type: 'string', enum: ['resolved', 'unresolvable'] },
        summary: { type: 'string', description: '一句话说明采取了什么措施 / 为何放弃' },
      },
      required: ['resolution', 'summary'],
    },
  },
];

// ─── 辅助：读 Skill 内容拼进 prompt ──────────────────────────────────────
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

function loadAllowedSkills(skillRegistry, skillIds) {
  if (!Array.isArray(skillIds) || skillIds.length === 0) return [];
  const remaining = { value: SKILL_BODY_TOTAL_BYTES };
  const result = [];
  for (const id of skillIds) {
    if (remaining.value <= 0) break;
    const skill = typeof skillRegistry.getSkill === 'function' ? skillRegistry.getSkill(id) : null;
    if (!skill?.dir) continue;
    if (skill.kind && skill.kind !== 'skill') continue;

    let body = '';
    try {
      const raw = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
      body = stripFrontmatter(raw).slice(0, SKILL_BODY_PER_FILE_BYTES);
      remaining.value -= Buffer.byteLength(body, 'utf8');
    } catch { /* ignore */ }

    const rules = readMdDir(path.join(skill.dir, 'rules'), remaining);
    const workflows = readMdDir(path.join(skill.dir, 'workflows'), remaining);
    const references = readMdDir(path.join(skill.dir, 'references'), remaining);

    result.push({ id, name: skill.name || id, body, rules, workflows, references });
  }
  return result;
}

// ─── Prompt 构造 ────────────────────────────────────────────────────────
function buildGuardianSystem({ program, host, allowedSkills }) {
  const hostDesc = host.id === 'local'
    ? '1Shell 本机（child_process）'
    : `${host.name} (${host.username || 'root'}@${host.host}:${host.port || 22})`;

  const lines = [
    `你是 1Shell 的 Guardian AI，负责保障长驻 Program 的持续稳定运行。`,
    `Program「${program.name}」的一个步骤失败了，你被唤起做定向修复。`,
    ``,
    `## 目标主机`,
    `- ${hostDesc}`,
    `- hostId: \`${host.id}\``,
    `- execute_command 自动在此主机执行，不要指定 host。`,
    ``,
    `## 工作流程（严格按 guardian-protocol Skill 执行）`,
    `1. 读失败上下文（failing step / stderr / on_error_hint）`,
    `2. 按 guardian-protocol 的 workflows/diagnose.md 诊断根因`,
    `3. 按 guardian-protocol 的 workflows/fix.md 修复`,
    `4. 按 guardian-protocol 的 workflows/report.md 输出结果（必须调用 render_result）`,
    `5. **必须**最后调用 report_outcome 宣告 resolved 或 unresolvable`,
    ``,
    `## 硬约束（绝对禁止）`,
    `- 不得操作名称含 shell\ 的资源`,
    `- 不得 rm -rf /、dd、mkfs、fork bomb 等系统级破坏命令`,
    `- 不得修改 /etc/ssh/ 或 sshd_config`,
    `- 不得 reboot / shutdown`,
    `- 白名单外的破坏性操作必须先 ask_user type=confirm danger=true`,
    ``,
    `## 响应风格`,
    `- 极简，不解释过程`,
    `- guardian-protocol Skill 的 rules 是你的行为铁律，workflows 是你的执行指南`,
  ];

  if (allowedSkills.length > 0) {
    lines.push(``, `---`, ``, `## 允许使用的 Skill 能力包`);
    lines.push(`以下 Skill 是本 Program 授权你在修复时参考的能力包。请**优先按这些 Skill 的 workflows 指引**诊断。`);
    lines.push(`它们的 rules 是你必须遵守的**附加约束**（叠加在硬约束之上）。`);

    for (const s of allowedSkills) {
      lines.push(``, `### 📦 Skill: ${s.name} (\`${s.id}\`)`, ``);
      if (s.body) lines.push(s.body.trim());
      for (const r of s.rules) {
        lines.push(``, `#### 规则 · ${r.name}`, r.content.trim());
      }
      for (const w of s.workflows) {
        lines.push(``, `#### 诊断流程 · ${w.name}`, w.content.trim());
      }
      for (const ref of s.references) {
        lines.push(``, `#### 参考 · ${ref.name}`, ref.content.trim());
      }
    }
  } else {
    lines.push(``, `## Skill 白名单`, `本 Program 未配置 guardian.skills，你只能依赖通用运维知识修复。`);
  }

  return lines.join('\n');
}

function buildGuardianUser({ program, failingStep, failureReason, execResult, triggerId }) {
  const stdoutTail = (execResult?.stdout || '').trimEnd().slice(-400);
  const stderrTail = (execResult?.stderr || '').trimEnd().slice(-800);

  const lines = [
    `## Program`,
    `- id: \`${program.id}\``,
    `- name: ${program.name}`,
    `- triggerId: ${triggerId}`,
    ``,
    `## 失败步骤`,
    `- id: \`${failingStep.id}\``,
    `- 描述: ${failingStep.label || failingStep.id}`,
    `- 命令: \`${(failingStep.run || '').slice(0, 300)}\``,
    `- 失败原因: ${failureReason}`,
    `- exitCode: ${execResult?.exitCode}`,
  ];
  if (stdoutTail) lines.push('', '### stdout（末尾）', '```', stdoutTail, '```');
  if (stderrTail) lines.push('', '### stderr（末尾）', '```', stderrTail, '```');
  if (failingStep.on_error_hint) {
    lines.push('', '## 作者提示 (on_error_hint)', failingStep.on_error_hint.trim());
  }
  lines.push('', '请诊断并修复，然后 report_outcome。');
  return lines.join('\n');
}

// ─── 配额（滑动窗口） ──────────────────────────────────────────────────
function createQuotaTracker() {
  const windows = new Map(); // programId → [timestamp...]
  return {
    /** @returns {boolean} ok */
    tryConsume(programId, maxPerHour) {
      const now = Date.now();
      const cutoff = now - 3600000;
      const arr = (windows.get(programId) || []).filter((t) => t > cutoff);
      if (arr.length >= maxPerHour) {
        windows.set(programId, arr);
        return false;
      }
      arr.push(now);
      windows.set(programId, arr);
      return true;
    },
    currentCount(programId) {
      const cutoff = Date.now() - 3600000;
      const arr = (windows.get(programId) || []).filter((t) => t > cutoff);
      windows.set(programId, arr);
      return arr.length;
    },
  };
}

// ─── 命令执行 ──────────────────────────────────────────────────────────
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

function isDangerous(command) {
  const cmd = String(command || '');
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

// ─── Guardian Factory ──────────────────────────────────────────────────
function createGuardianService({
  bridgeService, hostService, proxyConfigStore, port,
  auditService, logger, skillRegistry, io,
}) {
  const quota = createQuotaTracker();
  // sessionId → { cancelled, pendingAsk:{toolUseId, resolve, reject, timer} }
  const activeSessions = new Map();
  let globalUnlimitedTurns = false;

  function setUnlimitedTurns(enabled) {
    globalUnlimitedTurns = enabled;
  }

  function getUnlimitedTurns() {
    return globalUnlimitedTurns;
  }

  /**
   * 对一个 Program 发起 Guardian 介入。
   * @returns {Promise<{ ok: boolean, reason: string, summary?: string, sessionId: string }>}
   */
  async function escalate({ program, hostId, failingStep, failureReason, execResult, runId, triggerId }) {
    // ─ 配额 ─
    const maxPerHour = program.guardian?.max_actions_per_hour ?? 20;
    if (!quota.tryConsume(program.id, maxPerHour)) {
      const reason = `Guardian 配额耗尽：每小时 ${maxPerHour} 次已满`;
      logger?.warn?.('[guardian] quota exhausted', { programId: program.id, maxPerHour });
      return { ok: false, reason, sessionId: '' };
    }

    const host = hostService.findHost(hostId)
      || (hostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) {
      return { ok: false, reason: `主机不存在: ${hostId}`, sessionId: '' };
    }

    // ─ Provider ─（复用 skills 槽位）
    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      return { ok: false, reason: 'AI Provider 未配置（skills / claude-code 均无）', sessionId: '' };
    }

    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;
    const model = provider.model || 'claude-sonnet-4-20250514';

    // ─ 加载 Skill ─
    // guardian-protocol 始终作为第一个 Skill 加载（系统级元约束）
    // 用户在 guardian.skills 里声明的 Rescue Skill 追加在后面
    const PROTOCOL_SKILL_ID = 'guardian-protocol';
    const protocolSkillIds = [PROTOCOL_SKILL_ID, ...(program.guardian?.skills || [])];
    const allowedSkills = loadAllowedSkills(skillRegistry, protocolSkillIds);

    const sessionId = `guardian_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const state = { cancelled: false, pendingAsk: null };
    activeSessions.set(sessionId, state);

    io?.emit?.('guardian:session-started', {
      sessionId, programId: program.id, hostId, runId, triggerId,
      failingStep: { id: failingStep.id, label: failingStep.label, run: failingStep.run },
      allowedSkills: allowedSkills.map((s) => ({ id: s.id, name: s.name })),
    });

    auditService?.log?.({
      action: 'guardian_escalate',
      source: 'guardian',
      hostId,
      hostName: host.name,
      details: JSON.stringify({
        programId: program.id, runId, stepId: failingStep.id, reason: failureReason,
      }),
    });

    const system = buildGuardianSystem({ program, host, allowedSkills });
    const messages = [{
      role: 'user',
      content: buildGuardianUser({ program, failingStep, failureReason, execResult, triggerId }),
    }];

    let resolution = null;      // 'resolved' | 'unresolvable' | null
    let summary = '';

    try {
      const maxTurns = globalUnlimitedTurns ? Infinity : DEFAULT_MAX_GUARDIAN_TURNS;

      for (let turn = 0; turn < maxTurns; turn++) {
        if (state.cancelled) { summary = 'Guardian 被取消'; break; }
        io?.emit?.('guardian:thinking', { sessionId, turn: turn + 1 });

        let resp;
        try {
          resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              system,
              messages,
              tools: GUARDIAN_TOOLS,
            }),
          });
        } catch (err) {
          summary = `AI 调用失败: ${err.message}`;
          resolution = 'unresolvable';
          break;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          summary = `Provider 返回 ${resp.status}: ${errText.substring(0, 200)}`;
          resolution = 'unresolvable';
          break;
        }

        const data = await resp.json();
        if (data.type === 'error') {
          summary = data.error?.message || 'Provider 返回错误';
          resolution = 'unresolvable';
          break;
        }

        const content = Array.isArray(data.content) ? data.content : [];
        messages.push({ role: 'assistant', content });

        for (const blk of content) {
          if (blk.type === 'text' && blk.text?.trim()) {
            io?.emit?.('guardian:thought', { sessionId, text: blk.text });
          }
        }

        if (data.stop_reason === 'end_turn') {
          summary = 'Guardian 未调用 report_outcome 便结束';
          resolution = 'unresolvable';
          break;
        }
        if (data.stop_reason !== 'tool_use') {
          summary = `Guardian 意外停止: ${data.stop_reason}`;
          resolution = 'unresolvable';
          break;
        }

        const toolUses = content.filter((b) => b.type === 'tool_use');
        const toolResults = [];
        let outcomeReceived = false;

        for (const tu of toolUses) {
          if (state.cancelled) break;

          if (tu.name === 'execute_command') {
            const res = await handleExec(tu, { sessionId, hostId, state });
            toolResults.push(res);

          } else if (tu.name === 'ask_user') {
            const res = await handleAsk(tu, { sessionId, state });
            toolResults.push(res);

          } else if (tu.name === 'render_result') {
            io?.emit?.('guardian:render', {
              sessionId, toolUseId: tu.id, payload: tu.input,
              programId: program.id, hostId,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: 'OK - rendered',
            });

          } else if (tu.name === 'write_program_step') {
            const res = await handleWriteProgramStep(tu, { sessionId, program });
            toolResults.push(res);

          } else if (tu.name === 'report_outcome') {
            resolution = tu.input?.resolution === 'resolved' ? 'resolved' : 'unresolvable';
            summary = String(tu.input?.summary || '').trim() || '(无说明)';
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

      if (!resolution) {
        // 轮次耗尽但 AI 未主动 report_outcome —— 强制一轮总结，确保有输出
        try {
          messages.push({ role: 'user', content: [{ type: 'text', text:
            '你已达到最大轮次限制。请立即：\n1. 调用 render_result 输出你目前的诊断发现和已采取的修复措施\n2. 调用 report_outcome 宣告最终结果（resolved 或 unresolvable）\n不要再执行任何命令，直接总结。'
          }] });
          io?.emit?.('guardian:thinking', { sessionId, turn: 'final-summary' });
          const finalResp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 4096, system, messages, tools: GUARDIAN_TOOLS }),
          });
          if (finalResp.ok) {
            const finalData = await finalResp.json();
            const finalContent = Array.isArray(finalData.content) ? finalData.content : [];
            for (const blk of finalContent) {
              if (blk.type === 'text' && blk.text?.trim()) {
                io?.emit?.('guardian:thought', { sessionId, text: blk.text });
              }
            }
            const finalToolUses = finalContent.filter(b => b.type === 'tool_use');
            for (const tu of finalToolUses) {
              if (tu.name === 'render_result') {
                io?.emit?.('guardian:render', {
                  sessionId, toolUseId: tu.id, payload: tu.input,
                  programId: program.id, hostId,
                });
              } else if (tu.name === 'report_outcome') {
                resolution = tu.input?.resolution === 'resolved' ? 'resolved' : 'unresolvable';
                summary = String(tu.input?.summary || '').trim() || '(轮次耗尽后总结)';
              }
            }
          }
        } catch { /* 总结失败不影响主流程 */ }

        if (!resolution) {
          resolution = 'unresolvable';
          summary = summary || `Guardian 超出最大轮次 (${DEFAULT_MAX_GUARDIAN_TURNS})，已输出阶段性结果`;
        }
      }
    } finally {
      activeSessions.delete(sessionId);
    }

    const ok = resolution === 'resolved';
    io?.emit?.('guardian:session-ended', { sessionId, resolution, summary, ok });
    auditService?.log?.({
      action: 'guardian_end',
      source: 'guardian',
      hostId,
      hostName: host.name,
      exit_code: ok ? 0 : 1,
      error: ok ? null : summary,
      details: JSON.stringify({ programId: program.id, runId, resolution }),
    });

    return { ok, reason: summary, summary, sessionId };
  }

  // ─── 工具 handler ────────────────────────────────────────────────────

  async function handleExec(tu, { sessionId, hostId, state }) {
    const command = String(tu.input?.command || '').trim();
    const timeout = Number(tu.input?.timeout) > 0 ? Number(tu.input.timeout) : DEFAULT_EXEC_TIMEOUT_MS;
    if (!command) {
      return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] command 空', is_error: true };
    }

    // 危险 pattern 二次询问
    if (isDangerous(command)) {
      io?.emit?.('guardian:info', {
        sessionId,
        message: `⚠ 危险命令拦截，Guardian 必须先 ask_user 确认：${command.slice(0, 120)}`,
      });
      return {
        type: 'tool_result', tool_use_id: tu.id, is_error: true,
        content: `[BLOCKED] 命令匹配危险 pattern（rm -rf / mkfs / reboot 等）。请先用 ask_user type=confirm danger=true 获得用户确认，或改用更安全的替代方案。原命令：${command.slice(0, 200)}`,
      };
    }

    io?.emit?.('guardian:exec', { sessionId, toolUseId: tu.id, command, timeout, hostId });

    let result;
    try {
      result = hostId === 'local'
        ? await execLocal(command, timeout)
        : await bridgeService.execOnHost(hostId, command, timeout, { source: 'guardian' });
    } catch (err) {
      result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
    }

    // 断连重试（与 L2 一致）
    if (result.exitCode !== 0 && result.durationMs < 150 && hostId !== 'local') {
      await new Promise((r) => setTimeout(r, 200));
      try {
        result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'guardian-retry' });
      } catch (err) {
        result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
      }
    }

    io?.emit?.('guardian:exec-result', {
      sessionId, toolUseId: tu.id,
      stdout: result.stdout, stderr: result.stderr,
      exitCode: result.exitCode, durationMs: result.durationMs,
    });

    return {
      type: 'tool_result', tool_use_id: tu.id,
      content: formatExecResult(result), is_error: result.exitCode !== 0,
    };
  }

  async function handleWriteProgramStep(tu, { sessionId, program }) {
    const { stepId, newRun, actionName } = tu.input || {};
    if (!stepId || !newRun) {
      return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] stepId 和 newRun 均为必填', is_error: true };
    }

    // 定位 program.yaml 路径
    const yamlPath = path.join(program.dir || path.join(ROOT_DIR, 'data', 'programs', program.id), 'program.yaml');
    if (!fs.existsSync(yamlPath)) {
      return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] program.yaml 不存在: ${yamlPath}`, is_error: true };
    }

    let raw;
    try { raw = fs.readFileSync(yamlPath, 'utf8'); }
    catch (e) { return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 读取失败: ${e.message}`, is_error: true }; }

    // 找到目标 action
    const actions = program.actions || {};
    const targetAction = actionName && actions[actionName]
      ? actionName
      : Object.keys(actions)[0];
    if (!targetAction) {
      return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] 找不到 action', is_error: true };
    }

    const steps = actions[targetAction]?.steps || [];
    const step = steps.find((s) => s.id === stepId);
    if (!step) {
      return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] step "${stepId}" 不存在于 action "${targetAction}"`, is_error: true };
    }

    // 用正则在 YAML 原文中替换 run 字段（保留缩进）
    // 匹配: 在 stepId 出现后最近的 run: 行，替换到下一个非续行的 key
    // 策略：构造 block-scalar 替代，确保多行命令安全
    const escapedStepId = stepId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 找 "  - id: <stepId>" 块内的 run: 字段，替换到下一个同级 key
    const blockRegex = new RegExp(
      `((?:^|\\n)[ \\t]*-[ \\t]+id:[ \\t]+${escapedStepId}[\\s\\S]*?\\n)([ \\t]+)run:[ \\t]*(?:[^\\n]*(?:\\n\\2[ \\t]+[^\\n]+)*)`,
      'm'
    );

    // 把 newRun 转成 YAML block scalar（用 | 保留换行）
    const indentMatch = raw.match(new RegExp(`\\n([ \\t]+)-[ \\t]+id:[ \\t]+${escapedStepId}`));
    const baseIndent = indentMatch ? indentMatch[1] + '  ' : '        ';
    const fieldIndent = baseIndent + '  ';
    const newRunYaml = newRun.includes('\n')
      ? `run: |\n${newRun.split('\n').map((l) => fieldIndent + l).join('\n')}`
      : `run: ${newRun}`;

    let newRaw;
    if (blockRegex.test(raw)) {
      newRaw = raw.replace(blockRegex, (match, prefix, indent) => {
        return `${prefix}${indent}${newRunYaml}`;
      });
    } else {
      // fallback: 简单字符串替换旧 run 行
      const oldRunLine = new RegExp(`([ \\t]+run:[ \\t]*)${step.run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (oldRunLine.test(raw)) {
        newRaw = raw.replace(oldRunLine, `$1${newRun}`);
      } else {
        return { type: 'tool_result', tool_use_id: tu.id, content: '[ERROR] 无法在 YAML 中定位 run 字段，请人工修改', is_error: true };
      }
    }

    try {
      fs.writeFileSync(yamlPath, newRaw, 'utf8');
    } catch (e) {
      return { type: 'tool_result', tool_use_id: tu.id, content: `[ERROR] 写入失败: ${e.message}`, is_error: true };
    }

    io?.emit?.('guardian:info', { sessionId, message: `✅ write_program_step: ${program.id}.${targetAction}.${stepId} 已更新，Program 即将重载` });

    return {
      type: 'tool_result', tool_use_id: tu.id,
      content: `OK - program.yaml 已更新：${program.id} / ${targetAction} / ${stepId}\n新命令：${newRun.slice(0, 200)}`,
    };
  }

  async function handleAsk(tu, { sessionId, state }) {
    io?.emit?.('guardian:ask', { sessionId, toolUseId: tu.id, payload: tu.input });
    try {
      const answer = await new Promise((resolve, reject) => {
        state.pendingAsk = { toolUseId: tu.id, resolve, reject, timer: null };
        state.pendingAsk.timer = setTimeout(() => {
          if (state.pendingAsk?.toolUseId === tu.id) {
            state.pendingAsk = null;
            resolve({ timeout: true, value: null, confirmed: false });
          }
        }, ASK_TIMEOUT_MS);
      });
      return {
        type: 'tool_result', tool_use_id: tu.id,
        content: typeof answer === 'string' ? answer : JSON.stringify(answer),
      };
    } catch (err) {
      return {
        type: 'tool_result', tool_use_id: tu.id,
        content: `[ERROR] ask_user 失败: ${err.message}`, is_error: true,
      };
    }
  }

  // ─── 外部接口 ────────────────────────────────────────────────────────
  function submitAnswer(sessionId, toolUseId, answer) {
    const s = activeSessions.get(sessionId);
    if (!s || !s.pendingAsk) return false;
    if (s.pendingAsk.toolUseId !== toolUseId) return false;
    if (s.pendingAsk.timer) clearTimeout(s.pendingAsk.timer);
    const { resolve } = s.pendingAsk;
    s.pendingAsk = null;
    resolve(answer);
    return true;
  }

  function cancel(sessionId) {
    const s = activeSessions.get(sessionId);
    if (!s) return;
    s.cancelled = true;
    if (s.pendingAsk) {
      if (s.pendingAsk.timer) clearTimeout(s.pendingAsk.timer);
      s.pendingAsk.resolve({ cancelled: true });
      s.pendingAsk = null;
    }
  }

  function currentQuota(programId) {
    return quota.currentCount(programId);
  }

  function listActive() {
    return [...activeSessions.keys()];
  }

  return { escalate, submitAnswer, cancel, currentQuota, listActive, setUnlimitedTurns, getUnlimitedTurns };
}

module.exports = { createGuardianService };
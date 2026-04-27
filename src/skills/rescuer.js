'use strict';

/**
 * L2 AI Rescuer（隐式触发模式）
 *
 * L2 的两种触发模式之一：
 *   - 显式触发：Program 的 type: skill 步骤，由 skill-step-executor 执行
 *   - 隐式触发（本模块）：L1 Playbook Executor 某步骤 verify 失败时自动调用
 *
 * 使用最少的 AI 调用做定向修复：
 *   - execute_command : 在目标主机诊断 / 修复
 *   - report_outcome  : 宣告结果 → retry_ok | patch_plan | give_up
 *
 * 返回值供 playbook-executor 消费：
 *   { action: 'retry_ok',   execResult }
 *   { action: 'patch_plan', newSteps: [...] }
 *   { action: 'give_up',    reason }
 *
 * Token 控制：max_tokens=2048，MAX_RESCUE_TURNS=8。
 */

const { exec: childExec } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { ROOT_DIR } = require('../config/env');

const MAX_RESCUE_TURNS = 8;
const DEFAULT_EXEC_TIMEOUT_MS = 30000;

// Rescue Skill 内容拼进 prompt 时的大小上限（防止单轮 token 爆炸）
const RESCUE_SKILL_PER_FILE_BYTES = 8 * 1024;   //  8KB / 文件
const RESCUE_SKILL_TOTAL_BYTES    = 24 * 1024;  // 24KB 总量

// ─── Rescue Skill 加载 ─────────────────────────────────────────────────────
// 从 data/skills/<id>/ 读取 SKILL.md / rules/ / references/ / workflows/，
// 供 buildRescueSystem 拼进"场景化约束"段。
// 硬约束（3 次上限 / 必须 report_outcome / 三选一）不由 Skill 决定，保留在代码里。

function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return raw;
  return raw.substring(endIdx + 4).trim();
}

function readMarkdownDir(dir, usedBytesRef) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }

  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out = [];
  for (const f of files) {
    if (usedBytesRef.value >= RESCUE_SKILL_TOTAL_BYTES) break;
    let content = '';
    try { content = fs.readFileSync(path.join(dir, f.name), 'utf8'); }
    catch { continue; }
    const remainingTotal = RESCUE_SKILL_TOTAL_BYTES - usedBytesRef.value;
    const clipped = content.slice(0, Math.min(RESCUE_SKILL_PER_FILE_BYTES, remainingTotal));
    usedBytesRef.value += Buffer.byteLength(clipped, 'utf8');
    out.push({ name: f.name.replace(/\.md$/i, ''), content: clipped });
  }
  return out;
}

function loadRescueSkillContext(skillRegistry, skillId) {
  if (!skillId || !skillRegistry) return null;
  const skill = typeof skillRegistry.getSkill === 'function'
    ? skillRegistry.getSkill(skillId)
    : null;
  if (!skill || !skill.dir) return null;
  // libraryService 会把 playbook 也用 getSkill 暴露，这里只接受真正的 Skill
  if (skill.kind && skill.kind !== 'skill') return null;

  const usedBytes = { value: 0 };

  // SKILL.md body（去掉 frontmatter）
  let skillBody = '';
  try {
    const raw = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
    skillBody = stripFrontmatter(raw).slice(0, RESCUE_SKILL_PER_FILE_BYTES);
    usedBytes.value += Buffer.byteLength(skillBody, 'utf8');
  } catch { /* ignore */ }

  // 优先级：rules > workflows > references（按用户对齐时的顺序）
  const rules      = readMarkdownDir(path.join(skill.dir, 'rules'), usedBytes);
  const workflows  = readMarkdownDir(path.join(skill.dir, 'workflows'), usedBytes);
  const references = readMarkdownDir(path.join(skill.dir, 'references'), usedBytes);

  // 至少有点内容才返回；全空就当没挂
  const hasAny = skillBody || rules.length || workflows.length || references.length;
  if (!hasAny) return null;

  return {
    id: skillId,
    name: skill.name || skillId,
    skillBody,
    rules,
    workflows,
    references,
    bytes: usedBytes.value,
  };
}

// ─── Rescue 工具集 ──────────────────────────────────────────────────────────

const RESCUE_TOOLS = [
  {
    name: 'execute_command',
    description:
      '在目标主机上执行一条非交互式 shell 命令，用于诊断或修复失败步骤。' +
      '\n- 不要使用交互式命令' +
      '\n- 包管理器加 -y' +
      '\n- 长耗时命令请把 timeout 设大',
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
    name: 'report_outcome',
    description:
      '报告修复结果。完成所有 execute_command 后调用此工具，宣告结果。' +
      '\n- retry_ok   : 你已成功执行了等效命令，原步骤视为通过' +
      '\n- patch_plan : 提供修订后的剩余步骤列表（含原失败步骤的修正版本）' +
      '\n- give_up    : 无法修复，终止 Playbook',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['retry_ok', 'patch_plan', 'give_up'],
        },
        // patch_plan
        new_steps: {
          type: 'array',
          description:
            '(patch_plan) 替换原剩余步骤的新步骤列表。' +
            '每个步骤必须有 id / label / run / verify，type 默认 exec。',
          items: {
            type: 'object',
            properties: {
              id:             { type: 'string' },
              label:          { type: 'string' },
              type:           { type: 'string', enum: ['exec', 'render'], default: 'exec' },
              run:            { type: 'string' },
              verify:         { type: 'object' },
              optional:       { type: 'boolean' },
              capture_stdout: { type: 'boolean' },
              timeout:        { type: 'number' },
            },
            required: ['id', 'label', 'run'],
          },
        },
        // give_up
        reason: { type: 'string', description: '(give_up) 放弃原因，简要说明' },
      },
      required: ['action'],
    },
  },
];

// ─── Prompt 构造 ────────────────────────────────────────────────────────────

function buildRescueSystem(hostId, host, skillContext) {
  const hostDesc = host.id === 'local'
    ? '1Shell 本机（child_process 执行）'
    : `${host.name} (${host.username || 'root'}@${host.host}:${host.port || 22})`;

  const lines = [
    '你是 1Shell 的运维 AI Rescuer。',
    '一个确定性 Playbook 步骤执行失败，你被激活来做最小范围修复。',
    '',
    '## 目标主机',
    `- ${hostDesc}`,
    `- hostId: \`${hostId}\``,
    '- 调用 execute_command 时无需指定主机，命令自动在上述主机上执行。',
    '',
    '## 工作流程',
    '1. 阅读失败上下文和 on_error_hint（如有）',
    '2. 用 execute_command 诊断 / 尝试修复（**最多 3 次**，超过即 give_up）',
    '3. 立即调用 report_outcome 宣告结果，不要继续探索',
    '',
    '## 原则（硬约束，不可违反）',
    '- 只修复当前失败步骤；不做超出修复范围的变更',
    '- 超过 3 条 execute_command 还没解决 → 直接 give_up，不要继续尝试',
    '- 不要做无意义的诊断（xxd / od / hexdump 等字节级调试）',
    '- 响应极简，不要冗余解释',
    '- 最终必须调用 report_outcome 宣告 retry_ok / patch_plan / give_up 之一',
  ];

  if (skillContext) {
    lines.push(
      '',
      '---',
      '',
      `## 场景化约束（Rescue Skill: ${skillContext.name} · \`${skillContext.id}\`）`,
      '',
      '以下内容由绑定的 Rescue Skill 提供，作为本场景的**附加指导**。',
      '**不可覆盖上方硬约束**；仅用于补充场景知识、诊断顺序、已知坑位。',
    );

    if (skillContext.skillBody) {
      lines.push('', '### 概述', skillContext.skillBody.trim());
    }

    for (const r of skillContext.rules) {
      lines.push('', `### 规则 · ${r.name}`, r.content.trim());
    }
    for (const w of skillContext.workflows) {
      lines.push('', `### 诊断流程 · ${w.name}`, w.content.trim());
    }
    for (const ref of skillContext.references) {
      lines.push('', `### 参考 · ${ref.name}`, ref.content.trim());
    }
  }

  return lines.join('\n');
}

function buildRescueUserMessage({
  playbook, failingStep, failureReason, execResult, completedSteps,
}) {
  const stdoutTail = (execResult.stdout || '').trimEnd().slice(-400);
  const stderrTail = (execResult.stderr || '').trimEnd().slice(-800);

  const lines = [
    '## Playbook 目标',
    playbook.goal,
    '',
    '## 已完成步骤',
    completedSteps.length > 0 ? completedSteps.join(', ') : '（无）',
    '',
    '## 失败步骤',
    `- ID: \`${failingStep.id}\``,
    `- 描述: ${failingStep.label}`,
    `- 命令: \`${failingStep.run || ''}\``,
    `- 失败原因: ${failureReason}`,
    `- exitCode: ${execResult.exitCode}`,
  ];

  if (stdoutTail) {
    lines.push('', '### stdout（末尾）', '```', stdoutTail, '```');
  }
  if (stderrTail) {
    lines.push('', '### stderr（末尾）', '```', stderrTail, '```');
  }
  if (failingStep.on_error_hint) {
    lines.push('', '## 作者提示 (on_error_hint)', failingStep.on_error_hint.trim());
  }
  if (failingStep.verify && Object.keys(failingStep.verify).length > 0) {
    lines.push(
      '',
      '## verify 规则（步骤须满足此条件才算通过）',
      '```json',
      JSON.stringify(failingStep.verify, null, 2),
      '```',
    );
  }

  lines.push('', '请诊断并修复，然后通过 report_outcome 报告结果。');
  return lines.join('\n');
}

// ─── 本地命令执行 ────────────────────────────────────────────────────────────

function execLocal(command, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS);
  const startAt = Date.now();
  return new Promise((resolve) => {
    childExec(
      command,
      { timeout, maxBuffer: 10 * 1024 * 1024, cwd: ROOT_DIR },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || (err && !stderr ? String(err.message || '') : ''),
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          durationMs: Date.now() - startAt,
        });
      },
    );
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

// ─── Rescuer Factory ─────────────────────────────────────────────────────────

function createRescuer({ bridgeService, hostService, proxyConfigStore, port, logger, skillRegistry }) {
  /**
   * rescue({ runId, socket, hostId, playbook, failingStep, failureReason,
   *          execResult, completedSteps, stepOutputs })
   * → { action: 'retry_ok'|'patch_plan'|'give_up', execResult?, newSteps?, reason? }
   */
  async function rescue({
    runId, socket, hostId,
    playbook, failingStep, failureReason, execResult,
    completedSteps,
  }) {
    const host = hostService.findHost(hostId)
      || (hostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) {
      return { action: 'give_up', reason: `主机不存在: ${hostId}` };
    }

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      return { action: 'give_up', reason: 'AI Provider 未配置，无法执行 Rescue' };
    }

    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;
    const model    = provider.model || 'claude-sonnet-4-20250514';

    // 若 Playbook 绑定了 Rescue Skill，加载其 rules/workflows/references 作为场景化约束
    // 查找顺序：
    //   1. playbook.yaml 中的显式 rescuer_skill 字段
    //   2. 约定命名 <playbook-id>-rescue（无需在 yaml 里手写，Bundle 创建时自动符合此规范）
    let rescuerSkillId = String(playbook.rescuer_skill || '').trim();
    if (!rescuerSkillId && playbook.id) {
      const conventionId = `${playbook.id}-rescue`;
      if (skillRegistry.getSkill?.(conventionId)) {
        rescuerSkillId = conventionId;
      }
    }
    const skillContext = rescuerSkillId
      ? loadRescueSkillContext(skillRegistry, rescuerSkillId)
      : null;
    if (rescuerSkillId && !skillContext) {
      logger?.warn?.('Rescue Skill 未能加载，回退为默认 Rescuer', {
        runId, rescuerSkillId,
      });
      socket.emit('skill:info', {
        runId,
        message: `[!] Rescue Skill "${rescuerSkillId}" 未找到或为空，使用默认 Rescuer`,
      });
    } else if (skillContext) {
      socket.emit('skill:info', {
        runId,
        message: `[Rescue Skill] "${skillContext.name}" 已加载 (${skillContext.bytes}B 场景化约束)`,
      });
    }

    const system   = buildRescueSystem(hostId, host, skillContext);
    const messages = [
      {
        role: 'user',
        content: buildRescueUserMessage({
          playbook, failingStep, failureReason, execResult, completedSteps,
        }),
      },
    ];

    // 救援时最后一条成功的 exec 结果（用于 retry_ok 返回）
    let lastExecResult = null;
    const rescueStepId = `rescue_${failingStep.id}`;

    for (let turn = 0; turn < MAX_RESCUE_TURNS; turn++) {
      let resp;
      try {
        resp = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: 2048,
            system,
            messages,
            tools: RESCUE_TOOLS,
          }),
        });
      } catch (err) {
        logger?.error?.('Rescuer fetch 失败', { runId, stepId: failingStep.id, error: err.message });
        return { action: 'give_up', reason: `AI 调用失败: ${err.message}` };
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return {
          action: 'give_up',
          reason: `Provider 返回 ${resp.status}: ${errText.substring(0, 200)}`,
        };
      }

      const data = await resp.json();
      if (data.type === 'error') {
        return { action: 'give_up', reason: data.error?.message || 'Provider 返回错误' };
      }

      const content = Array.isArray(data.content) ? data.content : [];
      messages.push({ role: 'assistant', content });

      if (data.stop_reason === 'end_turn') {
        return { action: 'give_up', reason: 'Rescuer 未调用 report_outcome 便结束' };
      }
      if (data.stop_reason !== 'tool_use') {
        return { action: 'give_up', reason: `Rescuer 意外停止: ${data.stop_reason}` };
      }

      const toolUses    = content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      let outcomeReturned = false;

      for (const tu of toolUses) {
        const { name, input = {}, id } = tu;

        // ── execute_command ──────────────────────────────────────────────
        if (name === 'execute_command') {
          const command = String(input.command || '').trim();
          const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : DEFAULT_EXEC_TIMEOUT_MS;

          socket.emit('skill:exec', { runId, toolUseId: id, command, timeout, stepId: rescueStepId });

          let result;
          try {
            result = hostId === 'local'
              ? await execLocal(command, timeout)
              : await bridgeService.execOnHost(hostId, command, timeout, { source: 'skill-rescue' });
          } catch (err) {
            result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
          }

          // 与 L1 executor 一致：bridge 立刻返回错误（0ms）说明连接死了，等待重建后重试
          if (result.exitCode !== 0 && result.durationMs < 150 && hostId !== 'local') {
            await new Promise((r) => setTimeout(r, 200));
            try {
              result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'skill-rescue-retry' });
            } catch (err) {
              result = { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
            }
          }

          socket.emit('skill:exec-result', {
            runId,
            toolUseId: id,
            stepId: rescueStepId,
            stdout:    result.stdout,
            stderr:    result.stderr,
            exitCode:  result.exitCode,
            durationMs: result.durationMs,
          });

          lastExecResult = result;

          toolResults.push({
            type:        'tool_result',
            tool_use_id: id,
            content:     formatExecResult(result),
            is_error:    result.exitCode !== 0,
          });

        // ── report_outcome ───────────────────────────────────────────────
        } else if (name === 'report_outcome') {
          const { action } = input;

          // acknowledge so the loop can exit cleanly
          toolResults.push({
            type:        'tool_result',
            tool_use_id: id,
            content:     'OK',
          });

          if (action === 'retry_ok') {
            outcomeReturned = true;
            const finalResult = lastExecResult || {
              stdout: input.last_stdout || '',
              stderr: input.last_stderr || '',
              exitCode: 0,
              durationMs: 0,
            };
            // push the ack and return immediately after loop
            messages.push({ role: 'user', content: toolResults });
            return { action: 'retry_ok', execResult: finalResult };
          }

          if (action === 'patch_plan') {
            const rawSteps = Array.isArray(input.new_steps) ? input.new_steps : [];
            if (rawSteps.length === 0) {
              return { action: 'give_up', reason: 'patch_plan 的 new_steps 为空' };
            }
            const newSteps = rawSteps.map((s) => ({
              type:           'exec',
              optional:       false,
              capture_stdout: false,
              ...s,
            }));
            messages.push({ role: 'user', content: toolResults });
            return { action: 'patch_plan', newSteps };
          }

          // give_up
          messages.push({ role: 'user', content: toolResults });
          return { action: 'give_up', reason: input.reason || '无说明' };

        } else {
          toolResults.push({
            type:        'tool_result',
            tool_use_id: id,
            content:     `Unknown tool: ${name}`,
            is_error:    true,
          });
        }
      }

      if (!outcomeReturned) {
        messages.push({ role: 'user', content: toolResults });
      }
    }

    return { action: 'give_up', reason: `Rescuer 超出最大轮次 (${MAX_RESCUE_TURNS})` };
  }

  return { rescue };
}

module.exports = { createRescuer };
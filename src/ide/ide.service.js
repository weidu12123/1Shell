'use strict';

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const fetch = require('node-fetch');
const { emitIdeEvent } = require('./ide.events');
const { materializeAttachments } = require('../agents/protocol/attachment-store');
const {
  ONESHELL_CORE_SYSTEM_PROMPT,
} = require('../ai/oneshell-ai-prompt');
const {
  evaluateAgentRunOutcome,
} = require('../agent-runtime/outcome');
const {
  composeSystemPrompt,
  resolveAiSkillContext,
} = require('../skills/ai-skill-resolver');
const { formatOutputDiagnostics } = require('../utils/output-diagnostics');
const { redactCredentialPatterns, redactPotentialSecrets } = require('../../lib/secret-redaction');
const { canUseTool, createBudgetExceededResult } = require('../agent-runtime/budget');
const {
  DEFAULT_IDE_AGENT_LIMITS,
  IDE_AGENT_PHASE_DEFINITIONS,
  createIdeAgentPolicy,
  createIdeAgentGoalProfile,
  evaluateIdeAgentProfileToolUse,
  evaluateGatewayWriteToolPolicy,
  filterToolsForAgent,
  normalizeIdeApprovalMode,
  normalizeIdeAgentToolInput,
  shouldRequestAgentApproval,
} = require('./ide.agent-kernel');

function emitToSession(session, fallbackSocket, event, payload) {
  const target = session?.socket || fallbackSocket;
  try { emitIdeEvent(target, event, payload); } catch { /* ignore */ }
}

function assistantTextFromBlocks(blocks = []) {
  return blocks
    .filter(block => block?.type === 'text')
    .map(block => String(block.text || ''))
    .join('');
}

function normalizeVisibleWorkNote(value, maxLength = 1600) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}\n...[truncated]` : text;
}

function extractToolWorkNotes(content = []) {
  const notes = new Map();
  if (!Array.isArray(content)) return notes;
  let pendingText = '';
  let latestNote = '';
  for (const block of content) {
    if (block?.type === 'text') {
      pendingText += String(block.text || '');
      const note = normalizeVisibleWorkNote(pendingText);
      if (note) latestNote = note;
      continue;
    }
    if (block?.type === 'tool_use' && block.id && latestNote) {
      notes.set(String(block.id), latestNote);
    }
  }
  return notes;
}

function rememberToolWorkNotes(session, runId, content = []) {
  if (!session) return;
  const notes = extractToolWorkNotes(content);
  if (notes.size === 0) return;
  if (!(session.toolWorkNotes instanceof Map)) session.toolWorkNotes = new Map();
  for (const [toolUseId, workNote] of notes.entries()) {
    session.toolWorkNotes.set(toolUseId, { runId, workNote });
  }
}

function readToolWorkNote(session, runId, toolUseId) {
  const id = String(toolUseId || '').trim();
  if (!id || !(session?.toolWorkNotes instanceof Map)) return '';
  const entry = session.toolWorkNotes.get(id);
  if (!entry || (entry.runId && runId && entry.runId !== runId)) return '';
  return normalizeVisibleWorkNote(entry.workNote);
}

function resolveNullablePositiveInteger(value) {
  if (value === undefined || value === null || value === false) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || ['none', 'unbounded', 'runtime_policy', 'runtime-policy', 'long_running'].includes(text)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

// ─── 增量 SSE 解析（实时推送 text delta + 随时可中断） ─────────────────────
/**
 * 逐 chunk 解析 Anthropic SSE 流，实时 emit ide:text-delta 到前端。
 * AbortController 在整个流读取期间保持有效，cancelSession 可随时 abort。
 * 返回与 parseAnthropicSSE 相同结构的完整 message 对象。
 */
function streamAnthropicSSE(stream, abortController, session, socket, sessionId, runId) {
  return new Promise((resolve, reject) => {
    const blocks = [];
    let stopReason = 'end_turn';
    let stopSeq = null;
    let modelId = '';
    let inputTokens = 0, outputTokens = 0;
    let emittedTextDelta = false;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let resolved = false;

    function isCurrentRun() {
      return session?.currentRunId === runId && !session?.cancelled;
    }

    function buildResult() {
      return {
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: blocks.filter(Boolean).map(blk => {
          if (blk.type === 'text') return { type: 'text', text: blk.text };
          if (blk.type === 'tool_use') {
            let input = blk.input;
            if (!input && blk._inputJson) {
              try { input = JSON.parse(blk._inputJson); } catch { input = {}; }
            }
            return { type: 'tool_use', id: blk.id, name: blk.name, input: input || {} };
          }
          if (blk.type === 'thinking') {
            // 完整 thinking 块（内容+signature）——DeepSeek 等推理模型默认输出
            // thinking；历史里回传残缺块会被上游当非法请求（Anthropic 协议在
            // 请求未开 thinking 时不接受历史 thinking 块，DeepSeek 表现为空响应）
            return { type: 'thinking', thinking: blk.thinking || '', signature: blk.signature || '' };
          }
          return blk;
        }),
        stop_reason: stopReason,
        stop_sequence: stopSeq,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        _emittedTextDelta: emittedTextDelta,
      };
    }

    function cleanup() {
      abortController.signal.removeEventListener('abort', onAbort);
    }

    function finish() {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(buildResult());
    }

    function processLine(line) {
      if (resolved) return;
      if (!line.startsWith('data: ')) return;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') return;
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }
      if (!evt.type) return;

      if (evt.type === 'error') {
        resolved = true;
        cleanup();
        try { stream.destroy(); } catch { /* ignore */ }
        reject(new Error(evt.error?.message || 'SSE error'));
        return;
      }
      if (evt.type === 'message_start') {
        modelId = evt.message?.model || modelId;
        inputTokens = evt.message?.usage?.input_tokens || 0;
        outputTokens = evt.message?.usage?.output_tokens || 0;
        return;
      }
      if (evt.type === 'content_block_start') {
        const cb = evt.content_block || {};
        blocks[evt.index] = {
          type: cb.type,
          text: cb.text || '',
          id: cb.id || '',
          name: cb.name || '',
          _inputJson: '',
          _lastInputProgressSize: 0,
          _lastInputProgressAt: 0,
        };
        const blk = blocks[evt.index];
        if (blk.type === 'tool_use' && blk.id && isCurrentRun()) {
          emitToSession(session, socket, 'ide:tool-start', {
            sessionId,
            runId,
            toolUseId: blk.id,
            name: blk.name || 'unknown',
            input: null,
            phase: 'preparing_input',
          });
        }
        return;
      }
      if (evt.type === 'content_block_delta') {
        const blk = blocks[evt.index];
        if (!blk) return;
        const d = evt.delta || {};
        if (d.type === 'text_delta' && d.text) {
          blk.text += d.text;
          emittedTextDelta = true;
          if (session.currentRunId === runId && !session.cancelled) {
            emitToSession(session, socket, 'ide:text-delta', {
              sessionId,
              runId,
              delta: d.text,
              text: assistantTextFromBlocks(blocks),
            });
          }
        }
        if (d.type === 'thinking_delta' && d.thinking) {
          blk.thinking = (blk.thinking || '') + d.thinking;
        }
        if (d.type === 'signature_delta' && d.signature) {
          blk.signature = (blk.signature || '') + d.signature;
        }
        if (d.type === 'input_json_delta') {
          blk._inputJson += d.partial_json || '';
        }
        return;
      }
      if (evt.type === 'content_block_stop') {
        const blk = blocks[evt.index];
        if (blk && blk._inputJson) {
          try { blk.input = JSON.parse(blk._inputJson); } catch { blk.input = {}; }
          delete blk._inputJson;
        }
        return;
      }
      if (evt.type === 'message_delta') {
        stopReason = evt.delta?.stop_reason || stopReason;
        stopSeq = evt.delta?.stop_sequence || stopSeq;
        outputTokens = evt.usage?.output_tokens || outputTokens;
        return;
      }
      if (evt.type === 'message_stop') {
        finish();
      }
    }

    // 监听 abort — 流读取期间 cancelSession 触发时立即中断
    const onAbort = () => {
      if (resolved) return;
      resolved = true;
      try { stream.destroy(); } catch { /* ignore */ }
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    if (abortController.signal.aborted) {
      onAbort();
      return;
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true });

    stream.on('data', (chunk) => {
      if (resolved) return;
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
        if (resolved) break;
      }
    });

    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer && !resolved) processLine(buffer);
      abortController.signal.removeEventListener('abort', onAbort);
      finish();
    });

    stream.on('error', (err) => {
      abortController.signal.removeEventListener('abort', onAbort);
      if (resolved) return;
      resolved = true;
      reject(err);
    });
  });
}

// ─── 上下文压缩 ─────────────────────────────────────────────────────────
// 保留最近 KEEP_RECENT 条消息完整，更早的 tool_result 截断到 TRUNCATE_TO 字符
const KEEP_RECENT = 40;
const TRUNCATE_TO = 6000;

// 回溯快照是整文件 base64 常驻内存（每条最多 ~8MB），undo 记录数组无上限，
// agent 反复改文件的会话会线性吃掉服务器内存。总预算超限时把最老的
// restore_file 原位降级为 unrestorable 占位（长度不变，checkpoint.undoStart 索引不断）。
const REWIND_SNAPSHOT_BUDGET_BYTES = 32 * 1024 * 1024;

function rewindRecordSnapshotBytes(entry) {
  const snap = entry?.record?.snapshot?.base64Content;
  return typeof snap === 'string' ? snap.length : 0;
}

function applyRewindSnapshotBudget(entries, budgetBytes = REWIND_SNAPSHOT_BUDGET_BYTES) {
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const entry of entries) total += rewindRecordSnapshotBytes(entry);
  if (total <= budgetBytes) return total;
  for (const entry of entries) {
    if (total <= budgetBytes) break;
    const bytes = rewindRecordSnapshotBytes(entry);
    if (!bytes) continue;
    total -= bytes;
    entry.record = {
      type: 'unrestorable',
      hostId: entry.record.hostId || 'local',
      path: entry.record.path || '',
      reason: 'snapshot_budget_recycled',
      note: '较早的回溯快照已因内存预算回收，无法自动恢复',
    };
  }
  return total;
}

// 1Shell AI 会话 idle 回收：sessions Map 无驱逐时，每个会话的完整消息历史
// （含附件 base64、回溯快照）常驻内存直到进程重启；协议 agent 侧已有
// idle 回收（destroySession keepRecord），这里对齐同一模式——空闲超时后
// 落盘并移出内存，下条消息 getOrCreateSession 会从 repo 恢复。
const IDE_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function createSessionIdleKeeper({ sessions, timeoutMs = IDE_SESSION_IDLE_TIMEOUT_MS, onEvict }) {
  function clear(session) {
    if (session?.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  function touch(session) {
    if (!session?.sessionId) return;
    clear(session);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (!sessions.has(session.sessionId)) return;
      if (session.currentRunId && !session.cancelled) {
        touch(session); // 回合运行中（含挂起审批卡），续期不回收
        return;
      }
      clear(session);
      onEvict(session);
    }, timeoutMs);
    session.idleTimer.unref?.();
  }

  return { touch, clear };
}
const MAX_PROVIDER_TRANSIENT_RETRIES = 2;
const EMPTY_MODEL_RESPONSE_RETRY_LIMIT = 2;
const COMPACT_KEEP_RECENT_MESSAGES = 8;
const COMPACT_MIN_MESSAGES = 3;
const COMPACT_MAX_SOURCE_CHARS = 60000;
const COMPACT_MAX_SUMMARY_CHARS = 12000;
const COMPACT_SUMMARY_PREFIX = '[1Shell compact summary]';
const DETACHED_TOOL_RESULT_TEXT_PREFIX = 'Previous tool result was detached from its tool call.';
const HEADLESS_SYNC_ASK_MAX_TIMEOUT_MS = 600000;
const HEADLESS_DETACHED_ASK_DEFAULT_TIMEOUT_MS = envPositiveNumber('ONESHELL_MCP_DETACHED_ASK_TIMEOUT_MS', 60 * 60 * 1000);
const HEADLESS_DETACHED_ASK_MAX_TIMEOUT_MS = envPositiveNumber('ONESHELL_MCP_DETACHED_ASK_MAX_TIMEOUT_MS', 6 * 60 * 60 * 1000);

function envPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function toolContentPreview(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'image') return '[image]';
    return JSON.stringify(block);
  }).join('\n');
}

function stripTerminalControl(text) {
  return String(text || '')
    .replace(/(?:\uFFFD|\?)\[/g, '\x1b[')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '');
}

function collapseCarriageReturnUpdates(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const segments = line.split('\r');
      return [...segments].reverse().find((segment) => segment.length > 0) || '';
    })
    .join('\n');
}

function compactTerminalOutputForModel(text, maxChars = 5000, maxLines = 160) {
  const lines = collapseCarriageReturnUpdates(stripTerminalControl(text)).split('\n').map(line => line.trimEnd());
  const compacted = [];
  let previous = null;
  let repeats = 0;
  const flush = () => {
    if (previous === null) return;
    compacted.push(repeats > 1 && previous.trim() ? `${previous}  (重复 ${repeats} 次)` : previous);
    previous = null;
    repeats = 0;
  };
  for (const line of lines) {
    if (line === previous) {
      repeats += 1;
      continue;
    }
    flush();
    previous = line;
    repeats = 1;
  }
  flush();

  let visible = compacted;
  if (visible.length > maxLines) {
    const omitted = visible.length - maxLines + 1;
    visible = [`... 已折叠前 ${omitted} 行工具输出 ...`, ...visible.slice(-(maxLines - 1))];
  }

  let output = visible.join('\n');
  if (output.length > maxChars) {
    output = `${output.slice(0, maxChars)}\n...(tool_result 已裁剪，原 ${output.length} 字符)`;
  }
  return output;
}

function isTransientProviderError(err) {
  const message = String(err?.message || err || '');
  if (isProviderProtocolError(err)) return false;
  return /Provider 返回 (429|500|502|503|504)|Gateway Time-out|gateway timeout|api_error|ECONNRESET|socket hang up|ETIMEDOUT|premature close/i.test(message);
}

function isProviderProtocolError(err) {
  const message = String(err?.message || err || '');
  return /No tool call found for function call output|invalid_request_error|Provider (?:返回|杩斿洖) 400|HTTP 400|status 400/i.test(message);
}

// 单条工具结果的入库/进上下文上限。read_remote_file 一次最少返回 2MB，
// execute_command maxBuffer 8MB——不设上限时一条结果就常驻内存并随
// 全量重写放大，长会话服务器（4G 内存）跑一下午就 OOM。取 256K：
// 常规配置/脚本/日志片段原样保留（text-fidelity 不受影响），超大输出
// 截断并提示模型用可分页命令补读。
const TOOL_RESULT_MAX_CHARS = 256 * 1024;

function compactToolResultForModel(_toolName, content) {
  if (typeof content !== 'string' || content.length <= TOOL_RESULT_MAX_CHARS) return content;
  return `${content.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[1Shell] 工具输出超过 ${TOOL_RESULT_MAX_CHARS} 字符，已截断。如需其余内容，请用可分页的命令（head/tail/sed -n 'N,Mp'/grep）读取指定范围。`;
}

function compactMessages(messages) {
  if (messages.length <= KEEP_RECENT) return messages;

  const cutoff = messages.length - KEEP_RECENT;
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;

    const compacted = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const text = toolContentPreview(block.content);
      const compactedText = compactTerminalOutputForModel(text, TRUNCATE_TO, 120);
      if (compactedText === text && text.length <= TRUNCATE_TO) return block;
      return { ...block, content: compactedText };
    });
    return { ...msg, content: compacted };
  });
}

function parseCompactCommand(message) {
  const text = String(message || '').trim();
  const match = text.match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { instruction: String(match[1] || '').trim() };
}

function compactKeepCount(totalMessages) {
  const total = Number(totalMessages || 0);
  if (total <= COMPACT_MIN_MESSAGES) return total;
  if (total <= 10) return 2;
  return Math.min(COMPACT_KEEP_RECENT_MESSAGES, Math.max(2, Math.floor(total / 4)));
}

function splitMessagesForCompact(messages = []) {
  const all = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const keepCount = compactKeepCount(all.length);
  const splitIndex = compactSplitIndex(all, Math.max(0, all.length - keepCount));
  return {
    all,
    older: all.slice(0, splitIndex),
    recent: all.slice(splitIndex),
    keepCount,
  };
}

function compactSplitIndex(messages = [], desiredIndex = 0) {
  let index = Math.max(0, Math.min(Number(desiredIndex) || 0, messages.length));
  while (index > 0) {
    const resultIds = toolResultIds(messages[index]);
    if (!resultIds.size) break;
    let matchingToolUseIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (toolUseIds(messages[i]).some((id) => resultIds.has(id))) {
        matchingToolUseIndex = i;
        break;
      }
    }
    if (matchingToolUseIndex < 0) break;
    index = matchingToolUseIndex;
  }
  return index;
}

function providerMessageTextForCompact(message = {}, index = 0) {
  const role = String(message.role || 'unknown');
  const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content || '') }];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const text = String(block.text || '').trim();
      if (text) parts.push(text);
      continue;
    }
    if (block.type === 'tool_use') {
      const name = String(block.name || 'unknown_tool');
      const input = safeJsonStringify(block.input || {});
      parts.push(`[tool_use:${name}] ${input}`);
      continue;
    }
    if (block.type === 'tool_result') {
      const content = compactTerminalOutputForModel(toolContentPreview(block.content || block.text || ''), 4000, 80);
      parts.push(`[tool_result${block.is_error ? ':error' : ''}] ${content}`);
      continue;
    }
    parts.push(`[${block.type || 'block'}] ${safeJsonStringify(block).slice(0, 2000)}`);
  }
  const body = parts.join('\n').trim();
  return body ? `#${index + 1} ${role}\n${body}` : '';
}

function buildCompactSource(messages = [], maxChars = COMPACT_MAX_SOURCE_CHARS) {
  const lines = [];
  let length = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const item = providerMessageTextForCompact(messages[i], i);
    if (!item) continue;
    const nextLength = length + item.length + 2;
    if (nextLength > maxChars) {
      const remaining = Math.max(0, maxChars - length - 80);
      if (remaining > 400) lines.push(`${item.slice(0, remaining)}\n...[compact source truncated]`);
      break;
    }
    lines.push(item);
    length = nextLength;
  }
  return lines.join('\n\n');
}

function buildCompactPrompt({ source = '', instruction = '', recentCount = 0 } = {}) {
  return [
    'You are compacting an agent conversation for 1Shell.',
    'Write a concise but complete continuation summary. Preserve information needed for future model calls.',
    '',
    'Include:',
    '- user goal, constraints, preferences, selected host/project/session context',
    '- important files, commands, tool calls, results, failures, approvals, and safety notes',
    '- current plan, pending tasks, blockers, and verification status',
    '- facts that must not be rediscovered',
    '',
    'Do not invent facts. Do not include irrelevant chatter. Keep the summary in Chinese when the conversation is Chinese.',
    `The newest ${recentCount} message(s) will remain in full after this summary, so focus on older context.`,
    instruction ? `Extra user instruction for compaction: ${instruction}` : '',
    '',
    '<conversation_to_compact>',
    source,
    '</conversation_to_compact>',
  ].filter(Boolean).join('\n');
}

function createCompactSummaryMessage(summary, { compactedAt, compactedCount, keptCount } = {}) {
  const safeSummary = String(summary || '').trim().slice(0, COMPACT_MAX_SUMMARY_CHARS);
  const text = [
    COMPACT_SUMMARY_PREFIX,
    `compactedAt=${compactedAt || new Date().toISOString()}`,
    `compactedMessages=${Number(compactedCount || 0)}`,
    `keptRecentMessages=${Number(keptCount || 0)}`,
    '',
    safeSummary,
  ].join('\n');
  return { role: 'user', content: [{ type: 'text', text }] };
}

function isCompactSummaryText(text = '') {
  return String(text || '').trimStart().startsWith(COMPACT_SUMMARY_PREFIX);
}

function isDetachedToolResultText(text = '') {
  return String(text || '').trimStart().startsWith(DETACHED_TOOL_RESULT_TEXT_PREFIX);
}

function compactSummaryTimelineText(text = '') {
  const source = String(text || '').replace(COMPACT_SUMMARY_PREFIX, '').trim();
  const lines = source.split('\n');
  const meta = [];
  const body = [];
  for (const line of lines) {
    if (/^(compactedAt|compactedMessages|keptRecentMessages)=/.test(line)) meta.push(line);
    else body.push(line);
  }
  const compacted = meta.join(' · ');
  const preview = body.join('\n').trim().slice(0, 1200);
  return [compacted ? `已压缩历史上下文：${compacted}` : '已压缩历史上下文。', preview].filter(Boolean).join('\n\n');
}

function extractProviderTextContent(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.trim();
  if (Array.isArray(data.content)) {
    return data.content.map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return block.text || '';
      return '';
    }).join('').trim();
  }
  const choice = data.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice.trim();
  if (Array.isArray(choice)) {
    return choice.map((block) => block?.text || block?.content || '').join('').trim();
  }
  return '';
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || '');
  }
}

function toolUseIds(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block?.type === 'tool_use' && block.id).map((block) => block.id);
}

function toolResultIds(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return new Set();
  return new Set(message.content.filter((block) => block?.type === 'tool_result' && block.tool_use_id).map((block) => block.tool_use_id));
}

function allToolUseIds(messages = []) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const id of toolUseIds(message)) ids.add(id);
  }
  return ids;
}

function sanitizeProviderMessageHistory(messages = []) {
  const pendingToolUseIds = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const id of toolUseIds(message)) pendingToolUseIds.add(id);
      continue;
    }
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    const sanitized = [];
    for (const block of message.content) {
      if (block?.type !== 'tool_result') {
        sanitized.push(block);
        continue;
      }
      const id = String(block.tool_use_id || '').trim();
      if (id && pendingToolUseIds.has(id)) {
        pendingToolUseIds.delete(id);
        sanitized.push(block);
        continue;
      }
      sanitized.push({
        type: 'text',
        text: formatOrphanToolResultAsText(block),
      });
    }
    message.content = sanitized;
  }
  return messages;
}

function formatOrphanToolResultAsText(block = {}) {
  const id = String(block.tool_use_id || '').trim();
  const content = toolContentPreview(block.content || block.text || '').trim();
  return [
    DETACHED_TOOL_RESULT_TEXT_PREFIX,
    id ? `tool_result_id=${id}` : '',
    content || '(empty result)',
  ].filter(Boolean).join('\n');
}

function repairDanglingToolUseMessages(messages) {
  for (let i = 0; i < messages.length; i++) {
    const ids = toolUseIds(messages[i]);
    if (ids.length === 0) continue;

    const next = messages[i + 1];
    const resultIds = toolResultIds(next);
    const missing = ids.filter((id) => !resultIds.has(id));
    if (missing.length === 0) continue;

    const syntheticResults = missing.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'Tool result missing: the session was interrupted before the final tool_result was persisted. No stdout, stderr, exit code, or completion state was recorded for this tool call.',
      is_error: true,
    }));

    if (next?.role === 'user' && Array.isArray(next.content) && resultIds.size > 0) {
      next.content.push(...syntheticResults);
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: syntheticResults });
      i += 1;
    }
  }
}

// 模型 API 消息投影：会话可在 1Shell AI 与协议 agent（claude/codex/ACP）间
// 来回切换，协议时期的历史块不是为回传模型 API 而生——tool_use.name 可能是
// 任意标题（带空格/中文），块上还挂着 locations 等附加字段，直接回传会被
// API 拒绝。这里在请求边界做只读投影（不动 session.messages，时间线与文件
// chips 不受影响）：名字不合法的 tool_use 连同其 tool_result 一起转普通文
// 本；形状合法但带附加字段的块复制成标准形状。
const MODEL_API_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MODEL_API_TOOL_USE_KEYS = new Set(['type', 'id', 'name', 'input']);
const MODEL_API_TOOL_RESULT_KEYS = new Set(['type', 'tool_use_id', 'content', 'is_error']);

// sessionId 会进附件落盘目录名(dataDir/agent-attachments/<seg>)。sessionId 由
// 客户端 socket 载荷直接给出,不能信任:斜杠等分隔符已被 \w 白名单挡掉,但纯点
// 段('.'/'..')会穿透 [^\w.-] → path.join 出一级目录逃逸。凡清洗后剩下的全是点
// 的段一律兜底成安全名。
function safeSessionDirName(sessionId) {
  const cleaned = String(sessionId || 'session').replace(/[^\w.-]/g, '_');
  return /[^.]/.test(cleaned) ? cleaned : 'session';
}

function projectMessagesForModelApi(messages = []) {
  const stringifyForPreview = (value) => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value ?? {}); } catch { return ''; }
  };
  const droppedToolUseIds = new Set();
  const projected = (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    let changed = false;
    let content = message.content.filter((block) => {
      // 1Shell 的 agent 请求不开 thinking 参数，Anthropic 协议不允许历史里
      // 出现 thinking 块；DeepSeek 等默认输出 thinking 的模型若不剥掉，
      // 第二轮起上游会返回空响应（曾经表现为"empty assistant responses repeatedly"）
      if (block?.type === 'thinking') { changed = true; return false; }
      return true;
    });
    content = content.map((block) => {
      if (block?.type !== 'tool_use') return block;
      const name = String(block.name || '');
      if (!MODEL_API_TOOL_NAME_RE.test(name)) {
        if (block.id) droppedToolUseIds.add(String(block.id));
        changed = true;
        return { type: 'text', text: `[外部 agent 工具调用] ${name || 'tool'} ${stringifyForPreview(block.input).slice(0, 400)}`.trim() };
      }
      if (Object.keys(block).some((key) => !MODEL_API_TOOL_USE_KEYS.has(key))) {
        changed = true;
        return { type: 'tool_use', id: block.id, name, input: block.input ?? {} };
      }
      return block;
    });
    if (!changed && content.length === message.content.length) return message;
    return { ...message, content };
  });
  return projected.map((message) => {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block?.type !== 'tool_result') return block;
      if (droppedToolUseIds.has(String(block.tool_use_id || ''))) {
        changed = true;
        return { type: 'text', text: `[外部 agent 工具结果] ${stringifyForPreview(block.content).slice(0, 400)}`.trim() };
      }
      if (Object.keys(block).some((key) => !MODEL_API_TOOL_RESULT_KEYS.has(key))) {
        changed = true;
        return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, is_error: Boolean(block.is_error) };
      }
      return block;
    });
    if (!changed) return message;
    // API 要求 tool_result 位于 user 消息 content 的最前面；转文本后重排序
    const results = content.filter((block) => block?.type === 'tool_result');
    const others = content.filter((block) => block?.type !== 'tool_result');
    return { ...message, content: [...results, ...others] };
  }).map((message) => {
    // 消息级附加字段（attachments 落盘元数据等）只服务会话记录/前端回显，
    // 不属于模型 API 消息形状，请求边界统一剥离
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    if (!Object.keys(message).some((key) => key !== 'role' && key !== 'content')) return message;
    return { role: message.role, content: message.content };
  });
}

// 4.7.5：AI 任务板块整体退役（创作模式、任务执行、失败修复授权全部删除）。
// entry 只剩 'core' 一种语义，保留归一化函数以兼容旧客户端载荷。
function normalizePromptEntry(_entry, _context = null, _message = '') {
  return 'core';
}

function promptForEntry(_entry) {
  return ONESHELL_CORE_SYSTEM_PROMPT;
}

const AGENT_ATTACHMENT_MAX_COUNT = 8;
const AGENT_ATTACHMENT_MAX_BINARY_BYTES = 6 * 1024 * 1024;
const AGENT_ATTACHMENT_MAX_TEXT_BYTES = 800 * 1024;
const EXACT_TEXT_REF_PATTERN = /\[\[1shell-exact-attachment:([A-Za-z0-9_-]+)\]\]/g;

function cleanAttachmentName(name) {
  return String(name || 'attachment').replace(/[\\/\r\n\t]/g, ' ').trim().slice(0, 160) || 'attachment';
}

function cleanMime(mime) {
  return String(mime || 'application/octet-stream').trim().toLowerCase().slice(0, 120) || 'application/octet-stream';
}

function byteLengthFromBase64(value) {
  try {
    const clean = String(value || '').replace(/^data:[^,]+,/i, '').replace(/\s+/g, '');
    if (!clean) return 0;
    return Buffer.byteLength(clean, 'base64');
  } catch {
    return 0;
  }
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function exactAttachmentHandle(index, sha256) {
  return `att_${Math.max(0, Number(index) || 0)}_${String(sha256 || '').slice(0, 16)}`;
}

function normalizeAgentAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, AGENT_ATTACHMENT_MAX_COUNT).map((raw, index) => {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mime = cleanMime(item.mime || item.type);
    const kind = ['image', 'text', 'document', 'file'].includes(String(item.kind || ''))
      ? String(item.kind)
      : (mime.startsWith('image/') ? 'image' : (mime === 'application/pdf' ? 'document' : 'file'));
    const base64 = String(item.base64 || '').replace(/^data:[^,]+,/i, '').replace(/\s+/g, '');
    const binaryBytes = byteLengthFromBase64(base64);
    const rawText = typeof item.text === 'string' ? item.text : '';
    const textBytes = utf8ByteLength(rawText);
    const textTooLarge = rawText && textBytes > AGENT_ATTACHMENT_MAX_TEXT_BYTES;
    const text = textTooLarge ? '' : rawText;
    const textSha256 = text ? sha256Hex(text) : '';
    const declaredSize = Number(item.size);
    const error = [
      String(item.error || '').trim(),
      textTooLarge ? `Text attachment exceeds exact-text limit (${attachmentSizeLabel(textBytes)} > ${attachmentSizeLabel(AGENT_ATTACHMENT_MAX_TEXT_BYTES)}).` : '',
    ].filter(Boolean).join(' ');
    return {
      name: cleanAttachmentName(item.name),
      mime,
      kind,
      size: Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : binaryBytes,
      base64: binaryBytes > 0 && binaryBytes <= AGENT_ATTACHMENT_MAX_BINARY_BYTES ? base64 : '',
      text,
      textBytes,
      textSha256,
      exactHandle: text ? exactAttachmentHandle(index, textSha256) : '',
      error: error.slice(0, 240),
      binaryBytes,
    };
  });
}

function attachmentSizeLabel(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentSummaryLine(att) {
  const type = att.kind === 'image' ? '图片' : att.kind === 'text' ? '文本' : att.kind === 'document' ? '文档' : '文件';
  return `- ${att.name} (${type}, ${att.mime}, ${attachmentSizeLabel(att.size || att.binaryBytes)})${att.error ? `: ${att.error}` : ''}`;
}

function registerExactTextAttachment(registry, att) {
  if (!(registry instanceof Map) || !att?.text || !att.exactHandle) return '';
  registry.set(att.exactHandle, {
    handle: att.exactHandle,
    name: att.name,
    mime: att.mime,
    text: att.text,
    bytes: att.textBytes,
    sha256: att.textSha256,
  });
  return att.exactHandle;
}

function exactAttachmentTextBlock(att) {
  const handle = att.exactHandle;
  return [
    `<attachment name=${JSON.stringify(att.name)} mime=${JSON.stringify(att.mime)} exactHandle=${JSON.stringify(handle)} bytes=${att.textBytes} sha256=${att.textSha256}>`,
    `For verbatim output, output exactly [[1shell-exact-attachment:${handle}]]. 1Shell will expand that handle deterministically from the original attachment bytes.`,
    `<<<1shell-exact-content:${handle}`,
    att.text,
    `1shell-exact-content:${handle}>>>`,
    '</attachment>',
  ].join('\n');
}

function expandExactTextReferences(text, session = {}) {
  const source = String(text || '');
  const registry = session?.exactTextAttachments;
  if (!(registry instanceof Map) || !source.includes('[[1shell-exact-attachment:')) {
    return { text: source, expanded: false, refs: [], missing: [] };
  }
  const refs = [];
  const missing = [];
  let expanded = false;
  const next = source.replace(EXACT_TEXT_REF_PATTERN, (match, handle) => {
    const record = registry.get(handle);
    if (!record) {
      missing.push(handle);
      return match;
    }
    const bytes = utf8ByteLength(record.text);
    const sha256 = sha256Hex(record.text);
    if (bytes !== record.bytes || sha256 !== record.sha256) {
      missing.push(handle);
      return match;
    }
    expanded = true;
    refs.push({ handle, bytes, sha256, name: record.name, mime: record.mime });
    return record.text;
  });
  return { text: next, expanded, refs, missing };
}

function expandExactTextReferencesInBlocks(content = [], session = {}) {
  if (!Array.isArray(content)) return { content, expanded: false, refs: [], missing: [] };
  let expanded = false;
  const refs = [];
  const missing = [];
  const next = content.map((block) => {
    if (block?.type !== 'text') return block;
    const result = expandExactTextReferences(block.text || '', session);
    if (result.expanded) expanded = true;
    refs.push(...result.refs);
    missing.push(...result.missing);
    return result.expanded ? { ...block, text: result.text } : block;
  });
  return { content: next, expanded, refs, missing };
}

function exactExpansionTraceData(exactExpansion = {}) {
  if (!exactExpansion?.expanded) return {};
  return {
    exactExpanded: true,
    exactRefs: Array.isArray(exactExpansion.refs)
      ? exactExpansion.refs.map((ref) => ({
        handle: String(ref.handle || ''),
        name: String(ref.name || ''),
        mime: String(ref.mime || ''),
        bytes: Number(ref.bytes) || 0,
        sha256: String(ref.sha256 || ''),
      }))
      : [],
  };
}

function assistantTraceSummary(visibleText = '', exactExpansion = {}) {
  if (!exactExpansion?.expanded) return redactCredentialPatterns(visibleText);
  const refs = exactExpansionTraceData(exactExpansion).exactRefs || [];
  const refText = refs.map((ref) => {
    const name = ref.name ? `${ref.name} ` : '';
    return `${name}${ref.bytes} bytes sha256=${ref.sha256}`;
  }).join('; ');
  return `Assistant response expanded ${refs.length || 0} exact attachment reference(s); visible text omitted from trace. ${refText}`.trim();
}

function normalizeGoalStatus(value) {
  const text = String(value || '').trim();
  return ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(text)
    ? text
    : 'active';
}

function normalizeRuntimeGoalContext(context = null) {
  const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const threadGoal = ctx.threadGoal && typeof ctx.threadGoal === 'object' && !Array.isArray(ctx.threadGoal)
    ? ctx.threadGoal
    : {};
  const objective = String(threadGoal.objective || ctx.agentGoal || ctx.goal || '').replace(/\r\n/g, '\n').trim();
  if (!objective) return null;
  const updatedAt = String(threadGoal.updatedAt || ctx.goalUpdatedAt || '').trim();
  return {
    objective: objective.length > 4000 ? objective.slice(0, 4000) : objective,
    status: normalizeGoalStatus(threadGoal.status || ctx.goalStatus),
    updatedAt,
  };
}

function indentMultiline(value) {
  return String(value || '').replace(/\n/g, '\n  ');
}

function buildRunContextBlock(context = null) {
  const goal = normalizeRuntimeGoalContext(context);
  if (!goal) return '';
  return [
    '**Current 1Shell goal**:',
    `- objective: ${indentMultiline(goal.objective)}`,
    `- status: ${goal.status}`,
    goal.updatedAt ? `- updatedAt: ${goal.updatedAt}` : '',
  ].filter(Boolean).join('\n') + '\n\n';
}

function preserveUserMessageStructure(value) {
  const raw = String(value ?? '');
  if (!raw.trim()) return '';
  return raw.replace(/^(?:\r?\n)+|\s+$/g, '');
}

function stripLegacyInjectedUserPrefixes(text = '') {
  let current = String(text || '');
  current = current.replace(/^(?:\*\*(?:目标主机|相关文件|相关容器|MCP Server)\*\*：\r?\n(?:  -[^\r\n]*\r?\n|  注意：[^\r\n]*\r?\n|  请使用[^\r\n]*\r?\n)*\r?\n)+/, '');
  current = current.replace(/^\*\*Current 1Shell goal\*\*:\r?\n(?:- [^\r\n]*(?:\r?\n  [^\r\n]*)*\r?\n)+\r?\n/, '');
  return current;
}

function buildAgentUserContent({ firstContextBlock = '', runContextBlock = '', message = '', attachments = [], exactTextRegistry = null }) {
  const normalized = normalizeAgentAttachments(attachments);
  const prefix = `${firstContextBlock || ''}${runContextBlock || ''}`;
  const cleanMessage = preserveUserMessageStructure(message);
  const text = prefix ? `${prefix}${cleanMessage}`.trim() : cleanMessage;
  if (!normalized.length) return text;

  const blocks = [{ type: 'text', text: text || '请分析附件。' }];
  const summary = normalized.map(attachmentSummaryLine).join('\n');
  blocks.push({ type: 'text', text: `\n\n用户随消息发送了以下附件：\n${summary}` });

  for (const att of normalized) {
    if (att.kind === 'text' && att.text) {
      registerExactTextAttachment(exactTextRegistry, att);
      blocks.push({
        type: 'text',
        text: `\n\n${exactAttachmentTextBlock(att)}`,
      });
      continue;
    }
    if (att.kind === 'image' && att.base64 && att.mime.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.mime, data: att.base64 },
      });
      continue;
    }
    if (att.kind === 'document' && att.base64 && att.mime === 'application/pdf') {
      blocks.push({
        type: 'document',
        title: att.name,
        source: { type: 'base64', media_type: att.mime, data: att.base64 },
      });
    }
  }
  return blocks;
}

/**
 * IDE Service — 自由对话模式的创作引擎
 *
 * 默认对话路径保持极简 system prompt，不注入外部流程规则。
 *   - 对话历史持久保留，支持多轮迭代
 *   - 工具集更广（list_artifacts / query_format 等）
 *   - 用户是对话主体，AI 响应用户指令而非自驱执行
 */
function createIdeService({ ideTools, proxyConfigStore, port, hostService, auditService, logger, localMcpService, mcpRegistry, skillRegistry, harness, agentRuntime, secretService, ideSessionRepository, dataDir = '' }) {

  // sessionId → { messages[], system, hostId, abortController }
  const sessions = new Map();
  const sessionIdleKeeper = createSessionIdleKeeper({
    sessions,
    timeoutMs: IDE_SESSION_IDLE_TIMEOUT_MS,
    onEvict: (session) => {
      persistSessionSafe(session.sessionId, session, { modelLabel: '' });
      sessions.delete(session.sessionId);
      logger?.info?.(`[ide] 会话 ${session.sessionId} 空闲回收（记录已落盘，可继续对话）`);
    },
  });

const READONLY_TOOLS = new Set([
  'list_hosts', 'list_artifacts', 'query_format',
  'verify_outcome',
  'reload_registry', 'list_mcp_servers', 'list_scripts', 'get_script', 'query_audit',
  'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
  'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
  'list_remote_dir', 'read_remote_file',
]);

  const PARALLEL_SAFE_TOOLS = new Set([
    'list_hosts', 'list_artifacts', 'query_format',
    'list_mcp_servers', 'list_scripts', 'query_audit',
    'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
    'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
    'list_remote_dir', 'read_remote_file',
  ]);

  const SIDE_EFFECT_TOOLS = new Set([
    'execute_command',
    'reload_registry', 'add_mcp_server', 'remove_mcp_server', 'deploy_local_mcp',
  ]);

const AGENT_CONTROL_TOOLS = new Set(['ask_user', 'request_secret', 'verify_outcome']);
const REWIND_FILE_TOOLS = new Set(['write_remote_file', 'upload_file', 'create_directory', 'delete_path', 'rename_path']);
const REWIND_MAX_FILE_BYTES = 6 * 1024 * 1024;

  function makeAbortError(message = 'Cancelled') {
    const err = new Error(message);
    err.name = 'AbortError';
    err.code = 'CANCELLED';
    return err;
  }

  function isAbortError(err) {
    return err?.name === 'AbortError' || err?.code === 'CANCELLED' || err?.code === 'RUN_REPLACED';
  }

  function recordTraceEvent(stage, eventType, payload = {}) {
    try {
      harness?.recordEvent?.({ stage, eventType, ...payload });
    } catch { /* trace must not block IDE execution */ }
    try {
      const agentRunId = payload.agentRunId || payload.runId;
      agentRuntime?.recordTraceEvent?.(agentRunId, { stage, eventType, ...payload });
    } catch { /* AgentRun trace must not block IDE execution */ }
  }

  function resolveSessionSkillContext({ message, context, entry }) {
    try {
      const normalizedEntry = normalizePromptEntry(entry);
      return resolveAiSkillContext({
        skillRegistry,
        message,
        context,
        entry: normalizedEntry,
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to resolve active skills: ${err.message}`);
      return { skills: [], prompt: '' };
    }
  }

  function recordActiveSkills(runId, sessionId, session, skillContext) {
    const skills = Array.isArray(skillContext?.skills) ? skillContext.skills : [];
    if (skills.length === 0) return;
    const summary = skills.map((skill) => `${skill.id}${skill.reason ? ` (${skill.reason})` : ''}`).join(', ');
    recordTraceEvent('instruction', 'skills_activated', {
      source: 'ide',
      runId,
      sessionId,
      hostId: session?.hostId || 'local',
      toolName: 'skill_resolver',
      summary,
      data: { skills },
    });
  }

  function redactAgentTraceValue(value) {
    try {
      return JSON.parse(JSON.stringify(redactPotentialSecrets(value || {}), (key, item) => {
        if (/token|key|secret|password|auth|credential|content|base64|sensitive|redact/i.test(key)) return '<redacted>';
        if (typeof item === 'string' && item.length > 1000) return `${item.slice(0, 1000)}…`;
        return item;
      }));
    } catch { return {}; }
  }

  function cloneToolInputForExecution(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}));
    } catch {
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    }
  }

  function defaultIdeAgentLedger() {
    return {
      schemaVersion: 1,
      phase: '',
      hasSideEffects: false,
      requiresVerification: false,
      sideEffects: [],
      verification: null,
      reasons: [],
      updatedAt: '',
    };
  }

  function formatIdeAgentLedgerContent(ledger) {
    const lines = [
      `phase: ${ledger.phase || '(none)'}`,
      `hasSideEffects: ${ledger.hasSideEffects === true}`,
      `requiresVerification: ${ledger.requiresVerification === true}`,
      ledger.verification ? `verification: ${ledger.verification.status || 'unknown'} (${ledger.verification.type || 'unknown'})` : 'verification: none',
      ledger.reasons?.length ? `reasons: ${ledger.reasons.join(', ')}` : '',
      ledger.sideEffects?.length ? 'sideEffects:' : '',
      ...(ledger.sideEffects || []).slice(-20).map((item) => `- ${item.toolName || 'tool'} ${item.toolUseId || ''} ${item.summary || ''}`.trim()),
    ].filter(Boolean);
    return lines.join('\n');
  }

  function readIdeAgentLedger(runId) {
    const state = safeGetIdeAgentState(runId);
    const artifact = [...(Array.isArray(state?.artifacts) ? state.artifacts : [])]
      .reverse()
      .find((item) => item?.type === 'agent_run_ledger' || item?.id === 'ide-agent-run-ledger');
    return { ...defaultIdeAgentLedger(), ...(artifact?.data && typeof artifact.data === 'object' ? artifact.data : {}) };
  }

  function writeIdeAgentLedger(runId, patch = {}) {
    if (!runId || !agentRuntime?.updateArtifact) return null;
    try {
      const current = readIdeAgentLedger(runId);
      const sideEffects = Array.isArray(current.sideEffects) ? [...current.sideEffects] : [];
      const incomingSideEffects = Array.isArray(patch.sideEffects) ? patch.sideEffects : (patch.sideEffect ? [patch.sideEffect] : []);
      for (const item of incomingSideEffects) {
        const normalized = item && typeof item === 'object' ? item : {};
        const toolUseId = String(normalized.toolUseId || normalized.tool_use_id || '').trim();
        if (toolUseId && sideEffects.some((existing) => existing.toolUseId === toolUseId)) continue;
        sideEffects.push({
          toolName: String(normalized.toolName || normalized.name || 'unknown').slice(0, 120),
          toolUseId,
          hostId: String(normalized.hostId || 'local').slice(0, 120),
          summary: String(normalized.summary || '').slice(0, 1000),
          isError: normalized.isError === true,
          recordedAt: normalized.recordedAt || new Date().toISOString(),
        });
      }
      const reasons = [...new Set([
        ...normalizeStringArrayForIde(current.reasons),
        ...normalizeStringArrayForIde(patch.reasons),
      ])];
      const ledger = {
        ...current,
        phase: patch.phase !== undefined ? String(patch.phase || '') : current.phase,
        hasSideEffects: current.hasSideEffects === true || patch.hasSideEffects === true || sideEffects.length > 0,
        requiresVerification: current.requiresVerification === true || patch.requiresVerification === true,
        verification: patch.verification !== undefined ? patch.verification : current.verification,
        reasons,
        sideEffects,
        updatedAt: new Date().toISOString(),
      };
      return agentRuntime.updateArtifact(runId, {
        id: 'ide-agent-run-ledger',
        type: 'agent_run_ledger',
        title: 'Agent Run Ledger',
        content: formatIdeAgentLedgerContent(ledger),
        data: ledger,
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to update AgentRun ledger: ${err.message}`);
      return null;
    }
  }

  function normalizeStringArrayForIde(value) {
    return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  }

  function recordIdeAgentPhase(runId, phaseId, message = '', { status = 'running', evidence = [], transition = true } = {}) {
    if (!runId || !phaseId) return;
    try {
      agentRuntime?.updatePhase?.(runId, phaseId, { status, message, evidence });
    } catch (err) {
      logger?.warn?.(`[ide] failed to update AgentRun phase: ${err.message}`);
    }
    writeIdeAgentLedger(runId, { phase: phaseId });
    if (transition !== false) recordIdeAgentTransition(runId, phaseId, message, { status });
  }

  function recordIdeAgentTurn(runId, round, patch = {}) {
    if (!runId || !round || !agentRuntime?.recordTurn) return;
    try {
      agentRuntime.recordTurn(runId, {
        index: Number(round) - 1,
        turn: Number(round),
        ...patch,
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun turn: ${err.message}`);
    }
  }

  function recordIdeAgentObservation(runId, observation = {}) {
    if (!runId || !agentRuntime?.recordObservation) return;
    try {
      agentRuntime.recordObservation(runId, observation);
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun observation: ${err.message}`);
    }
  }

  function recordIdeAgentTransition(runId, node, reason = '', data = {}) {
    if (!runId || !node || !agentRuntime?.recordRuntimeTransition) return;
    try {
      const runtimeNode = normalizeIdeRuntimeNode(node);
      if (!runtimeNode) return;
      const currentNode = String(safeGetIdeAgentState(runId)?.runtimeState?.currentNode || '').trim();
      if (['finalize', 'blocked', 'cancelled'].includes(currentNode) && currentNode !== runtimeNode) return;
      agentRuntime.recordRuntimeTransition(runId, {
        to: runtimeNode,
        status: data.status || 'running',
        reason,
        data: {
          bridge: 'ide-streaming-loop',
          idePhase: String(node || ''),
          ...redactAgentTraceValue(data),
        },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun transition: ${err.message}`);
    }
  }

  function normalizeIdeRuntimeNode(node) {
    const value = String(node || '').trim();
    if (value === 'context') return 'observe';
    if (value === 'result') return 'finalize';
    return value;
  }

  function toolRequiresVerification(toolName, input = {}) {
    const name = String(toolName || '').trim();
    if (!name || AGENT_CONTROL_TOOLS.has(name)) return false;
    if (SIDE_EFFECT_TOOLS.has(name)) return true;
    if (READONLY_TOOLS.has(name)) return false;
    return true;
  }

  function recordIdeAgentSideEffect(runId, tc, result = {}, session = {}) {
    if (!runId || !tc?.name || !toolRequiresVerification(tc.name, tc.input || {})) return;
    const summary = summarizeToolInput(tc.input || {});
    writeIdeAgentLedger(runId, {
      hasSideEffects: true,
      requiresVerification: true,
      reasons: [`side_effect_tool:${tc.name}`],
      sideEffect: {
        toolName: tc.name,
        toolUseId: tc.id,
        hostId: session.hostId || tc.input?.hostId || 'local',
        summary,
        isError: result?.is_error === true,
      },
    });
    recordTraceEvent('acting', 'side_effect_recorded', {
      source: 'ide',
      runId,
      sessionId: session.sessionId,
      hostId: session.hostId || tc.input?.hostId || 'local',
      toolName: tc.name,
      toolUseId: tc.id,
      summary: `记录副作用工具调用：${tc.name}: ${summary}`,
    });
  }

  function createRewindId() {
    return `rw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeRemotePath(value) {
    return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  }

  function remoteBasename(value) {
    const normalized = normalizeRemotePath(value);
    return normalized.split('/').filter(Boolean).pop() || normalized;
  }

  function remoteParentDir(value) {
    const raw = String(value || '').trim();
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/g, '');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return normalized.startsWith('/') ? '/' : '';
    return normalized.slice(0, idx);
  }

  function remoteJoin(dir, name) {
    const left = String(dir || '').trim();
    const right = String(name || '').trim();
    if (!left) return right;
    const sep = left.includes('\\') || /^[A-Za-z]:/.test(left) ? '\\' : '/';
    return left.endsWith('/') || left.endsWith('\\') ? `${left}${right}` : `${left}${sep}${right}`;
  }

  function parseStructuredToolContent(result = {}) {
    const text = String(result?.content || '').trim();
    if (!text || !text.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function toolData(result = {}) {
    const parsed = parseStructuredToolContent(result);
    return parsed?.data && typeof parsed.data === 'object' ? parsed.data : {};
  }

  async function callRewindTool(toolName, input, session = {}, runId = '') {
    return ideTools.handle(toolName, input || {}, {
      socket: null,
      sessionId: session.sessionId || '',
      runId,
      safeMode: false,
      session,
      approvalMode: 'full_access',
      allowApproval: false,
      preApproved: true,
      source: 'agent_remind',
    });
  }

  async function snapshotFileForRewind(hostId, filePath, session, runId) {
    const result = await callRewindTool('download_file', {
      hostId,
      path: filePath,
      maxBytes: REWIND_MAX_FILE_BYTES,
    }, session, runId);
    if (isIdeToolResultError(result)) {
      const reason = toolContentPreview(result.content).slice(0, 400);
      const missing = /not found|no such|不存在|路径不存在|path not found/i.test(reason);
      return { exists: !missing, restorable: false, reason };
    }
    const data = toolData(result);
    if (!data?.base64Content) {
      return { exists: false, restorable: false, reason: 'download_file 未返回可恢复内容' };
    }
    return {
      exists: true,
      restorable: true,
      hostId,
      path: filePath,
      base64Content: data.base64Content,
      filename: data.filename || remoteBasename(filePath),
      size: data.size || 0,
    };
  }

  async function pathLooksExistingDirectory(hostId, dirPath, session, runId) {
    if (!dirPath) return false;
    const result = await callRewindTool('list_remote_dir', { hostId, path: dirPath }, session, runId);
    return !isIdeToolResultError(result);
  }

  async function prepareRewindUndoRecord(session, toolName, input = {}, meta = {}) {
    if (!session || !REWIND_FILE_TOOLS.has(toolName)) return null;
    const hostId = String(input.hostId || session.hostId || 'local').trim() || 'local';
    const runId = meta.runId || session.currentRunId || '';
    try {
      if (toolName === 'write_remote_file') {
        const filePath = String(input.path || '').trim();
        if (!filePath) return null;
        const snap = await snapshotFileForRewind(hostId, filePath, session, runId);
        if (snap.exists && snap.restorable) {
          return { type: 'restore_file', hostId, path: filePath, snapshot: snap, reason: 'write_remote_file' };
        }
        if (snap.exists) {
          return { type: 'unrestorable', hostId, path: filePath, reason: 'write_remote_file_snapshot_failed', note: snap.reason || '无法创建写入前快照' };
        }
        return { type: 'delete_path', hostId, path: filePath, reason: 'write_remote_file_created', note: snap.reason || '' };
      }

      if (toolName === 'upload_file') {
        const dirPath = String(input.dirPath || '').trim();
        const filename = String(input.filename || '').trim() || remoteBasename(input.localPath || '');
        if (!dirPath || !filename) return null;
        const filePath = remoteJoin(dirPath, filename);
        const snap = await snapshotFileForRewind(hostId, filePath, session, runId);
        if (snap.exists && snap.restorable) {
          return { type: 'restore_file', hostId, path: filePath, snapshot: snap, reason: 'upload_file' };
        }
        if (snap.exists) {
          return { type: 'unrestorable', hostId, path: filePath, reason: 'upload_file_snapshot_failed', note: snap.reason || '无法创建上传前快照' };
        }
        return { type: 'delete_path', hostId, path: filePath, reason: 'upload_file_created', note: snap.reason || '' };
      }

      if (toolName === 'delete_path') {
        const targetPath = String(input.path || '').trim();
        if (!targetPath) return null;
        const snap = await snapshotFileForRewind(hostId, targetPath, session, runId);
        if (snap.exists && snap.restorable) {
          return { type: 'restore_file', hostId, path: targetPath, snapshot: snap, reason: 'delete_path' };
        }
        return { type: 'unrestorable', hostId, path: targetPath, reason: 'delete_path_snapshot_failed', note: snap.reason || '无法创建删除前快照' };
      }

      if (toolName === 'rename_path') {
        const oldPath = String(input.path || '').trim();
        const newPath = String(input.newPath || '').trim();
        if (!oldPath || !newPath) return null;
        return { type: 'rename_path', hostId, path: newPath, newPath: oldPath, reason: 'rename_path' };
      }

      if (toolName === 'create_directory') {
        const dirPath = String(input.path || '').trim();
        if (!dirPath) return null;
        const existed = await pathLooksExistingDirectory(hostId, dirPath, session, runId);
        if (existed) return null;
        return { type: 'delete_path', hostId, path: dirPath, reason: 'create_directory' };
      }
    } catch (err) {
      return {
        type: 'unrestorable',
        hostId,
        path: String(input.path || input.dirPath || '').trim(),
        reason: `${toolName}_snapshot_error`,
        note: err.message || '创建回溯快照失败',
      };
    }
    return null;
  }

  function recordRewindUndo(session, toolName, input, result, undoRecord, meta = {}) {
    if (!session || !undoRecord || isIdeToolResultError(result)) return;
    if (!Array.isArray(session.rewindUndoRecords)) session.rewindUndoRecords = [];
    session.rewindUndoRecords.push({
      id: createRewindId(),
      toolName,
      input: redactAgentTraceValue(input || {}),
      record: undoRecord,
      runId: meta.runId || '',
      toolUseId: meta.toolUseId || '',
      createdAt: new Date().toISOString(),
    });
    applyRewindSnapshotBudget(session.rewindUndoRecords);
  }

  async function applyRewindUndoRecord(session, undoEntry, runId = '') {
    const record = undoEntry?.record || {};
    if (!record.type) return { ok: true, summary: '空回溯记录已跳过' };
    if (record.type === 'unrestorable') {
      return { ok: false, summary: `${record.path || '(unknown)'} 无法自动恢复：${record.note || record.reason || '没有可用快照'}` };
    }
    if (record.type === 'restore_file') {
      const filePath = String(record.path || '').trim();
      const result = await callRewindTool('upload_file', {
        hostId: record.hostId || 'local',
        dirPath: remoteParentDir(filePath),
        filename: remoteBasename(filePath),
        base64Content: record.snapshot?.base64Content || '',
      }, session, runId);
      return {
        ok: !isIdeToolResultError(result),
        summary: `恢复文件 ${record.hostId || 'local'}:${filePath}`,
        detail: toolContentPreview(result.content).slice(0, 600),
      };
    }
    if (record.type === 'delete_path') {
      const result = await callRewindTool('delete_path', {
        hostId: record.hostId || 'local',
        path: record.path,
      }, session, runId);
      return {
        ok: !isIdeToolResultError(result),
        summary: `删除回溯产生的路径 ${record.hostId || 'local'}:${record.path}`,
        detail: toolContentPreview(result.content).slice(0, 600),
      };
    }
    if (record.type === 'rename_path') {
      const result = await callRewindTool('rename_path', {
        hostId: record.hostId || 'local',
        path: record.path,
        newPath: record.newPath,
      }, session, runId);
      return {
        ok: !isIdeToolResultError(result),
        summary: `重命名回 ${record.hostId || 'local'}:${record.newPath}`,
        detail: toolContentPreview(result.content).slice(0, 600),
      };
    }
    return { ok: false, summary: `未知回溯记录类型：${record.type}` };
  }

  function startIdeAgentRun({ session, sessionId, runId, message, context, entry, approvalMode, tools = [], claudeCodeEnabled, legacyFlags = {}, goalProfile = null }) {
    if (!agentRuntime?.startRun) throw new Error('Agent runtime 未初始化，1Shell AI 无法启动 AgentRun');
    try {
      const source = 'ide';
      const normalizedEntry = normalizePromptEntry(entry);
      const normalizedApprovalMode = normalizeIdeApprovalMode(approvalMode || session?.approvalMode);
      const policy = createIdeAgentPolicy({ tools, entry: normalizedEntry, approvalMode: normalizedApprovalMode, remotePolicy: session?.toolPolicy, goalProfile });
      const state = agentRuntime.startRun({
        source,
        goal: String(message || '').trim(),
        context: {
          ...redactAgentTraceValue(context),
          hostId: session?.hostId || context?.hosts?.[0]?.id || 'local',
          workspaceHostIds: Array.isArray(session?.workspaceHostIds) ? session.workspaceHostIds : [],
          goalProfile,
        },
        tools: tools.map((tool) => ({ name: tool.name, type: 'ide' })),
        policy,
        outputContract: {
          status: 'unverified_until_verified',
          phases: IDE_AGENT_PHASE_DEFINITIONS,
        },
        metadata: {
          entrypoint: 'ide:message',
          sessionId,
          entry: normalizedEntry,
          approvalMode: normalizedApprovalMode,
          claudeCodeEnabled: !!claudeCodeEnabled,
          legacySafeMode: legacyFlags.safeMode,
          legacyUnlimitedTurns: legacyFlags.unlimitedTurns,
          goalProfile,
          tracePurpose: 'agent_run_is_the_runtime_owner_for_all_1shell_ai_behavior',
        },
      }, { runId });
      session.agentRunId = state.runId;
      session.agentPolicy = policy;
      writeIdeAgentLedger(state.runId, { phase: 'understand' });
      recordIdeAgentPhase(state.runId, 'understand', 'AgentRun started; understanding goal and available policy.');
      return state;
    } catch (err) {
      logger?.warn?.(`[ide] failed to start AgentRun trace: ${err.message}`);
      throw err;
    }
  }

  function endIdeAgentRun(runId, { runnerStatus = 'completed', taskStatus = 'unverified', result = null, error = '' } = {}) {
    if (!runId || !agentRuntime?.endRun) return;
    try {
      if (result && agentRuntime.publishResult) agentRuntime.publishResult(runId, result);
      agentRuntime.endRun(runId, { runnerStatus, taskStatus, error });
      for (const session of sessions.values()) {
        if (session.currentRunId === runId) {
          session.currentRunId = null;
          session.abortController = null;
        }
      }
    } catch (err) {
      logger?.warn?.(`[ide] failed to end AgentRun trace: ${err.message}`);
    }
  }

  function safeGetIdeAgentState(runId) {
    if (!runId || !agentRuntime?.getState) return null;
    try { return agentRuntime.getState(runId); } catch { return null; }
  }

  function resolveIdeAgentFinalTaskStatus(runId, fallback = 'unverified') {
    try {
      const outcome = evaluateAgentRunOutcome(safeGetIdeAgentState(runId), { fallbackTaskStatus: fallback });
      const status = String(outcome?.taskStatus || fallback || 'unverified').trim();
      if (['verified', 'failed', 'blocked', 'unverified', 'partial'].includes(status)) return status;
      return 'unverified';
    } catch (err) {
      logger?.warn?.(`[ide] failed to evaluate AgentRun outcome: ${err.message}`);
      return fallback;
    }
  }

  function resolveIdeAgentOutcome(runId, fallback = 'unverified') {
    try {
      return evaluateAgentRunOutcome(safeGetIdeAgentState(runId), { fallbackTaskStatus: fallback });
    } catch (err) {
      logger?.warn?.(`[ide] failed to evaluate AgentRun outcome: ${err.message}`);
      return { taskStatus: fallback, reasons: ['outcome_evaluation_failed'] };
    }
  }

  function buildIdeFinalResult(runId, textParts = [], meta = {}) {
    const state = safeGetIdeAgentState(runId);
    const existing = state?.result && typeof state.result === 'object' ? state.result : null;
    const outcome = resolveIdeAgentOutcome(runId, 'unverified');
    const forcedTaskStatus = String(meta.forcedTaskStatus || '').trim();
    const finalStatus = ['verified', 'failed', 'blocked', 'unverified', 'partial'].includes(forcedTaskStatus)
      ? forcedTaskStatus
      : (['verified', 'failed', 'blocked', 'unverified', 'partial'].includes(String(outcome.taskStatus || '')) ? outcome.taskStatus : 'unverified');
    const aiText = textParts.length > 0 ? textParts.join('').slice(0, 1000) : '';
    const existingSummary = Array.isArray(existing?.summary) ? existing.summary : [];
    const summary = [...existingSummary, ...(aiText ? [aiText] : [])].filter(Boolean).slice(-6);
    return {
      title: existing?.title || '1Shell AI run completed',
      status: finalStatus,
      taskStatus: finalStatus,
      summary,
      report: existing?.report || aiText,
      data: {
        ...(existing?.data && typeof existing.data === 'object' ? existing.data : {}),
        outcomeReasons: Array.isArray(outcome.reasons) ? outcome.reasons : [],
        agentLedger: readIdeAgentLedger(runId),
        ...meta,
      },
    };
  }

  function recordIdeVerificationOutcome(runId, result = {}, context = {}) {
    const verification = result?.verification && typeof result.verification === 'object' ? result.verification : null;
    if (!runId || !verification || !agentRuntime) return;
    const ok = verification.ok === true;
    const rawStatus = String(verification.status || '').trim().toLowerCase();
    const taskStatus = String(verification.taskStatus || (ok ? 'verified' : (rawStatus === 'unsupported' ? 'unverified' : 'failed'))).trim();
    const finalTaskStatus = ['verified', 'failed', 'blocked', 'unverified'].includes(taskStatus) ? taskStatus : (ok ? 'verified' : 'failed');
    const safeVerification = redactAgentTraceValue(verification);
    const evidence = toolContentPreview(result.content).slice(0, 4000);
    const summary = [
      `${verification.type || 'outcome'} verification ${ok ? 'passed' : rawStatus || 'failed'}`,
      verification.target ? `target=${verification.target}` : '',
      Array.isArray(verification.reasons) && verification.reasons.length ? `reasons=${verification.reasons.join(',')}` : '',
    ].filter(Boolean).join(' | ');
    try {
      agentRuntime.recordVerification?.(runId, {
        ...safeVerification,
        ok,
        status: ok ? 'passed' : (rawStatus || 'failed'),
        taskStatus: finalTaskStatus,
        type: verification.type || 'outcome',
        target: verification.target || '',
        reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
        evidence,
        checkedAt: verification.checkedAt || new Date().toISOString(),
      });
      agentRuntime.updateArtifact?.(runId, {
        id: 'ide-verification-result',
        type: 'verification_result',
        title: `Verification - ${verification.type || 'outcome'}`,
        content: evidence,
        data: {
          ...safeVerification,
          ok,
          status: ok ? 'passed' : (rawStatus || 'failed'),
          taskStatus: finalTaskStatus,
          reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
          checkedAt: verification.checkedAt || new Date().toISOString(),
        },
      });
      agentRuntime.publishResult?.(runId, {
        title: ok ? 'Outcome verified' : (finalTaskStatus === 'unverified' ? 'Outcome unverified' : 'Outcome verification failed'),
        status: finalTaskStatus,
        taskStatus: finalTaskStatus,
        summary: [summary],
        report: evidence,
        data: { verification: safeVerification },
      });
      writeIdeAgentLedger(runId, {
        phase: 'verify',
        verification: {
          ok,
          status: ok ? 'passed' : (rawStatus || 'failed'),
          taskStatus: finalTaskStatus,
          type: verification.type || '',
          target: verification.target || '',
          reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
          checkedAt: verification.checkedAt || new Date().toISOString(),
        },
        reasons: ok ? [] : [`verification_${finalTaskStatus}`],
      });
      recordIdeAgentPhase(runId, 'verify', summary, { status: ok ? 'done' : 'failed', evidence: [summary] });
      agentRuntime.recordTraceEvent?.(runId, {
        stage: 'verify',
        eventType: ok ? 'verification_passed' : (finalTaskStatus === 'unverified' ? 'verification_unverified' : 'verification_failed'),
        summary,
        toolName: 'verify_outcome',
        toolUseId: context.toolUseId,
        sessionId: context.sessionId,
        hostId: context.hostId,
        data: { verification: safeVerification },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record verification outcome: ${err.message}`);
    }
  }

  function cancelIdeAgentRun(runId, reason = 'cancelled') {
    if (!runId || !agentRuntime?.cancelRun) return;
    try {
      const state = agentRuntime.getState?.(runId);
      if (!state || ['completed', 'failed', 'cancelled'].includes(state.runnerStatus)) return;
      agentRuntime.cancelRun(runId, { reason, taskStatus: 'blocked' });
    } catch (err) {
      logger?.warn?.(`[ide] failed to cancel AgentRun trace: ${err.message}`);
    }
  }

  function startIdeAgentToolTrace(runId, tc, session) {
    if (!runId || !tc?.name || !agentRuntime?.recordToolCallStarted) return null;
    try {
      return agentRuntime.recordToolCallStarted(runId, tc.name, redactAgentTraceValue(tc.input || {}), {
        toolUseId: tc.id,
        scope: { hostId: session?.hostId || tc.input?.hostId || 'local' },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun tool start: ${err.message}`);
      return null;
    }
  }

  function guardIdeAgentToolCall(runId, tc, session = null) {
    if (!runId || !tc?.name || !agentRuntime?.getState) return null;
    try {
      const state = agentRuntime.getState(runId);
      const verdict = canUseTool(state, tc.name);
      if (verdict.allow) {
        const profileVerdict = evaluateIdeAgentProfileToolUse(session?.agentGoalProfile || state?.spec?.policy?.goalProfile, tc.name, tc.input || {});
        if (profileVerdict.allow) return null;
        recordTraceEvent('policy', 'tool_denied', {
          source: 'ide',
          runId,
          toolName: tc.name,
          toolUseId: tc.id,
          summary: profileVerdict.reason,
          data: { kind: profileVerdict.kind },
        });
        return createBudgetExceededResult(profileVerdict.reason, profileVerdict.kind || 'profile_policy_denied');
      }
      recordTraceEvent('policy', 'tool_denied', {
        source: 'ide',
        runId,
        toolName: tc.name,
        toolUseId: tc.id,
        summary: verdict.reason,
        data: { kind: verdict.kind },
      });
      return createBudgetExceededResult(verdict.reason, verdict.kind || 'policy_denied');
    } catch (err) {
      logger?.warn?.(`[ide] failed to enforce Agent tool policy: ${err.message}`);
      return null;
    }
  }

  function endIdeAgentToolTrace(runId, toolCall, result = {}) {
    if (!runId || !toolCall || !agentRuntime?.recordToolCallEnded) return;
    try {
      agentRuntime.recordToolCallEnded(runId, toolCall.id, {
        ...result,
        content: toolContentPreview(result.content).slice(0, 4000),
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun tool end: ${err.message}`);
    }
  }

  function createIdeApprovalInterrupt(runId, requestId, tc, summary = {}, riskReason = '', options = {}) {
    if (!runId || !requestId || !tc?.name || !agentRuntime?.createInterrupt) return null;
    try {
      const facts = options.approvalFacts || normalizeApprovalFacts(tc, summary, riskReason, options);
      const title = facts.title || options.title || summary.title || tc.name;
      const detail = formatApprovalDetail(summary, facts.riskReason || riskReason);
      const workNote = normalizeVisibleWorkNote(options.workNote);
      return agentRuntime.createInterrupt(runId, {
        type: 'request_approval',
        reason: 'approval_required',
        message: [title, detail].filter(Boolean).join('\n\n'),
        payload: {
          requestId,
          title,
          detail,
          action: tc.name,
          toolName: tc.name,
          args: redactAgentTraceValue(tc.input || {}),
          workNote,
          riskLevel: facts.riskLevel || String(options.riskLevel || options.risk_level || ''),
          riskReason: facts.riskReason || riskReason,
          approval: facts,
        },
        scope: { hostId: tc.input?.hostId || 'local' },
        runnerStatus: 'waiting_approval',
        taskStatus: 'blocked',
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to create AgentRun approval interrupt: ${err.message}`);
      return null;
    }
  }

  function resolveIdeApprovalInterrupt(runId, interrupt, response = {}) {
    if (!runId || !interrupt?.id || !agentRuntime?.resumeRun) return;
    const action = String(response.action || '').trim();
    const approved = action === 'allow';
    const rejected = action === 'deny';
    const custom = action === 'custom';
    try {
      agentRuntime.resumeRun(runId, {
        interruptId: interrupt.id,
        runnerStatus: 'running',
        resolution: {
          status: approved ? 'approved' : (rejected ? 'rejected' : (custom ? 'answered' : 'resolved')),
          decision: action || 'unknown',
          approved,
          reason: String(response.reason || (rejected ? 'denied_by_user_or_timeout' : '')).slice(0, 500),
          note: custom ? String(response.text || '').slice(0, 1000) : '',
        },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to resolve AgentRun approval interrupt: ${err.message}`);
    }
  }

  function createIdeUserInterrupt(runId, requestId, tc) {
    if (!runId || !requestId || !tc?.name || !agentRuntime?.createInterrupt) return null;
    const input = tc.input || {};
    const isSecret = tc.name === 'request_secret';
    const question = String(input.question || input.message || input.prompt || '').trim();
    const secretName = String(input.name || input.secretName || input.secret_name || '').trim();
    const label = String(input.label || secretName || 'secret').trim();
    const reason = String(input.reason || '').trim();
    const options = Array.isArray(input.options) ? input.options.map((item) => String(item || '').trim()).filter(Boolean) : [];
    try {
      return agentRuntime.createInterrupt(runId, {
        type: isSecret ? 'request_secret' : 'ask_user',
        reason: reason || tc.name,
        message: isSecret ? `需要 Secret 引用：${label}` : (question || 'Agent 需要用户补充信息'),
        payload: isSecret
          ? {
            requestId,
            secrets: [{ name: secretName || 'secret_ref', label, required: true, target: 'secret_ref', provider: input.provider || '' }],
            storePolicy: { plaintext: false, tracePlaintext: false },
          }
          : {
            requestId,
            questions: [{ id: 'answer', prompt: question || '请补充信息', type: options.length > 0 ? 'choice' : 'text', required: true, options }],
            allowMultiple: false,
          },
        scope: { hostId: input.hostId || 'local' },
        runnerStatus: 'interrupted',
        taskStatus: 'blocked',
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to create AgentRun ${tc.name} interrupt: ${err.message}`);
      return null;
    }
  }

  function normalizeSecretRefResponse(response = {}) {
    return String(response.secretRef || response.secret_ref || response.ref || response.text || '').trim();
  }

  function validateSecretRefForAgent(response = {}, input = {}) {
    const secretRef = normalizeSecretRefResponse(response);
    if (!secretRef) {
      return { ok: false, error: '此 Secret 工具只接收已保存的 secret ref/id。若你选择直接提供明文，请在普通对话中明确授权发送，AI 可用于本次操作并做记录脱敏。' };
    }
    if (!/^sec_[a-zA-Z0-9-]+$/.test(secretRef)) {
      return { ok: false, error: '输入不是有效的 secret ref/id。请先保存到 Secret Manager，再选择或填写 sec_ 开头的引用。' };
    }
    if (!secretService?.get) {
      return { ok: false, error: 'Secret Manager 不可用，无法校验 secret ref。' };
    }
    let secret = null;
    try {
      secret = secretService.get(secretRef);
    } catch (err) {
      logger?.warn?.(`[ide] failed to validate secret ref: ${err.message}`);
      return { ok: false, error: '校验 secret ref 失败，请重新选择已保存凭据。' };
    }
    if (!secret) {
      return { ok: false, error: 'secret ref 不存在或已删除。请从 Secret Manager 选择已保存凭据。' };
    }
    return {
      ok: true,
      secretRef: secret.id,
      secretMeta: {
        id: secret.id,
        name: secret.name || String(input.name || input.secretName || input.secret_name || 'secret_ref'),
        type: secret.type || 'generic',
      },
    };
  }

  function resolveIdeUserInterrupt(runId, interrupt, tc, response = {}) {
    if (!runId || !interrupt?.id || !agentRuntime?.resumeRun) return;
    const action = String(response.action || '').trim();
    const text = String(response.text || '').trim();
    const denied = action === 'deny';
    const isSecret = tc?.name === 'request_secret';
    const input = tc?.input || {};
    const secretRef = isSecret ? normalizeSecretRefResponse(response) : '';
    const secretMeta = response.secretMeta && typeof response.secretMeta === 'object' ? response.secretMeta : {};
    try {
      agentRuntime.resumeRun(runId, {
        interruptId: interrupt.id,
        runnerStatus: 'running',
        resolution: isSecret
          ? {
            status: denied ? 'rejected' : (secretRef ? 'provided' : 'resolved'),
            secretRefs: secretRef ? [{
              name: String(secretMeta.name || input.name || input.secretName || input.secret_name || 'secret_ref').slice(0, 120),
              ref: secretRef.slice(0, 300),
              type: String(secretMeta.type || '').slice(0, 120),
            }] : [],
            redacted: true,
            note: denied ? String(response.reason || 'denied_by_user').slice(0, 500) : '用户通过 Secret Manager 提供已校验 secret 引用；trace 不保存密钥明文。',
          }
          : {
            status: denied ? 'rejected' : 'answered',
            answers: text ? { answer: text.slice(0, 2000) } : {},
            note: String(response.reason || '').slice(0, 500),
          },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to resolve AgentRun ${tc?.name || 'user'} interrupt: ${err.message}`);
    }
  }

  function userInterruptDetail(tc) {
    const input = tc.input || {};
    if (tc.name === 'request_secret') {
      const label = input.label || input.name || 'secret';
      return [
        `需要 Secret 引用：${label}`,
        input.provider ? `平台/用途：${input.provider}` : '',
        input.reason ? `原因：${input.reason}` : '',
        '此 Secret 工具只接收 Secret Manager 中已保存的 secret ref/id；如果你明确选择直接提供明文，请回到普通对话发送，AI 可用于本次操作并做记录脱敏。',
      ].filter(Boolean).join('\n');
    }
    const options = Array.isArray(input.options) ? input.options.map((item, index) => `${index + 1}. ${item}`).join('\n') : '';
    return [
      input.question || input.message || 'Agent 需要用户补充信息',
      input.reason ? `原因：${input.reason}` : '',
      options ? `可选项：\n${options}` : '',
      '请使用“自定义回复”输入答案；如果拒绝提供，请点击拒绝。',
    ].filter(Boolean).join('\n\n');
  }

  function waitForUserInterruptTool(socket, sessionId, tc, session, runId) {
    return new Promise((resolve, reject) => {
      const isSecret = tc.name === 'request_secret';
      const requestId = `${isSecret ? 'sec' : 'ask'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const requestEvent = isSecret ? 'ide:secret-request' : 'ide:ask-user';
      const responseEvent = isSecret ? 'ide:secret-response' : 'ide:ask-user-response';
      const interrupt = createIdeUserInterrupt(runId, requestId, tc);
      const input = tc.input || {};
      let unregisterCancel = null;
      let settled = false;

      const cleanup = () => {
        socket.off(responseEvent, handler);
        clearTimeout(timer);
        if (unregisterCancel) unregisterCancel();
      };

      const settle = (fn, value, resolution = value) => {
        if (settled) return;
        settled = true;
        resolveIdeUserInterrupt(runId, interrupt, tc, resolution || {});
        cleanup();
        fn(value);
      };

      const buildResult = (resp = {}) => {
        const action = String(resp.action || '').trim();
        const text = String(resp.text || '').trim();
        if (action === 'deny') return { content: '[用户拒绝提供所需信息]', is_error: true };
        if (isSecret) {
          const validated = validateSecretRefForAgent(resp, input);
          if (!validated.ok) {
            return { content: `[ERROR] ${validated.error}`, is_error: true, secretValidationError: validated.error };
          }
          return {
            content: `用户提供了已校验的 secret 引用：${validated.secretRef} (${validated.secretMeta.type}/${validated.secretMeta.name})`,
            is_error: false,
            secretRef: validated.secretRef,
            secretMeta: validated.secretMeta,
          };
        }
        if (!text) return { content: '[ERROR] 用户未提供答案。', is_error: true };
        return { content: `用户回答：${text.slice(0, 4000)}`, is_error: false };
      };

      const handler = (resp) => {
        if (resp.requestId !== requestId) return;
        const result = buildResult(resp);
        const resolution = isSecret
          ? (result.is_error
            ? { action: 'deny', reason: resp.reason || result.secretValidationError || 'secret_ref_rejected' }
            : { ...resp, action: 'custom', text: result.secretRef, secretRef: result.secretRef, secretMeta: result.secretMeta })
          : resp;
        settle(resolve, result, resolution);
      };
      socket.on(responseEvent, handler);

      const timer = setTimeout(() => settle(resolve, { content: '[ERROR] 等待用户输入超时', is_error: true }, { action: 'deny', reason: 'user_input_timeout' }), 5 * 60 * 1000);
      unregisterCancel = registerCancelHandler(session, () => settle(reject, makeAbortError(), { action: 'deny', reason: 'cancelled' }));

      try {
        throwIfStopped(session, runId);
        emitToSession(session, socket, requestEvent, {
          sessionId,
          runId,
          requestId,
          toolUseId: tc.id,
          toolName: tc.name,
          title: isSecret ? '需要 Secret 引用' : '需要补充信息',
          detail: userInterruptDetail(tc),
          question: input.question || input.message || input.prompt || '',
          reason: input.reason || '',
          options: Array.isArray(input.options) ? input.options : [],
          secretName: input.name || input.secretName || input.secret_name || '',
          label: input.label || input.name || input.secretName || '',
          provider: input.provider || '',
          responseEvent,
        });
      } catch (err) {
        settle(reject, err, { action: 'deny', reason: err.message || 'user_input_emit_failed' });
      }
    });
  }

  function summarizeToolInput(input) {
    try { return JSON.stringify(input || {}).slice(0, 500); } catch { return ''; }
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function ensureSessionCancellation(session) {
    if (!session.cancelHandlers) session.cancelHandlers = new Set();
  }

  function registerCancelHandler(session, handler) {
    ensureSessionCancellation(session);
    session.cancelHandlers.add(handler);
    return () => session.cancelHandlers?.delete(handler);
  }

  function isRunCurrent(session, runId) {
    return session.currentRunId === runId && !session.cancelled;
  }

  function throwIfStopped(session, runId) {
    if (session.currentRunId !== runId) {
      const err = makeAbortError('Run replaced');
      err.code = 'RUN_REPLACED';
      throw err;
    }
    if (session.cancelled) throw makeAbortError();
  }

  function emitCancelledOnce(session, sessionId, socket = session?.socket, runId = session?.currentRunId) {
    if (!session || session.cancelNotified) return;
    session.cancelNotified = true;
    emitToSession(session, socket, 'ide:cancelled', { sessionId, runId });
  }

  function getApprovalSummary(tc) {
    const input = tc.input || {};
    switch (tc.name) {
      case 'execute_command':
        const safeCommand = redactCredentialPatterns(String(input.command || ''));
        return {
          title: '执行命令',
          actionKind: 'command',
          detail: `host: ${input.hostId || 'local'}\ncommand: ${safeCommand}`,
          actionText: safeCommand,
          hostId: input.hostId || 'local',
        };
      case 'create_directory':
        return {
          title: '创建目录',
          detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
          actionKind: 'file_change',
          actionText: `mkdir ${input.path || ''}`,
          hostId: input.hostId || 'local',
        };
      case 'delete_path':
        return {
          title: '删除文件/目录（不可恢复）',
          detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
          actionKind: 'file_delete',
          actionText: `delete_path ${input.path || ''}`,
          hostId: input.hostId || 'local',
        };
      case 'rename_path':
        return {
          title: '重命名/移动',
          detail: `主机: ${input.hostId || 'local'}\n原路径: ${input.path || ''}\n新路径: ${input.newPath || ''}`,
          actionKind: 'file_change',
          actionText: `rename_path ${input.path || ''} -> ${input.newPath || ''}`,
          hostId: input.hostId || 'local',
        };
      case 'deploy_local_mcp':
        return {
          title: '部署本地 MCP',
          detail: `仓库: ${input.repoUrl || ''}\n名称: ${input.name || ''}`,
          actionKind: 'tool',
          actionText: `deploy_local_mcp ${input.name || ''}\n${input.repoUrl || ''}`,
          hostId: input.hostId || 'local',
        };
      default:
        return {
          title: tc.name,
          detail: JSON.stringify(input, null, 2).substring(0, 600),
          actionKind: 'tool',
          actionText: `${tc.name}\n${JSON.stringify(input, null, 2).substring(0, 1200)}`,
          hostId: input.hostId || 'local',
        };
    }
  }

  function cleanPolicyList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }

  function normalizeToolPolicy(policy = {}) {
    const gatewayMode = String(policy.gatewayMode || '').trim();
    const source = String(policy.source || policy.policySource || '').trim();
    return {
      allowedTools: cleanPolicyList(policy.allowedTools),
      allowedHosts: cleanPolicyList(policy.allowedHosts),
      allowedScripts: cleanPolicyList(policy.allowedScripts),
      allowedPaths: cleanPolicyList(policy.allowedPaths),
      gatewayMode: ['answer', 'plan', 'execute'].includes(gatewayMode) ? gatewayMode : 'answer',
      source: source.slice(0, 80),
    };
  }

  function allowsValue(value, allowed) {
    if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes('*')) return true;
    return allowed.includes(String(value || '').trim());
  }

  function normalizePolicyPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }

  function wildcardPolicyPathMatch(targetPath, rulePath) {
    const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}($|/)`).test(targetPath);
  }

  function allowsPath(value, allowedPaths) {
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 || allowedPaths.includes('*')) return true;
    const target = normalizePolicyPath(value);
    return allowedPaths.some((rule) => {
      const normalizedRule = normalizePolicyPath(rule);
      if (normalizedRule.includes('*')) return wildcardPolicyPathMatch(target, normalizedRule);
      return target === normalizedRule || target.startsWith(`${normalizedRule}/`);
    });
  }

  const HOST_SCOPED_TOOL_FIELDS = Object.freeze({
    execute_command: ['hostId'],
    run_script: ['hostId'],
    list_remote_dir: ['hostId'],
    read_remote_file: ['hostId'],
    write_remote_file: ['hostId'],
    create_directory: ['hostId'],
    delete_path: ['hostId'],
    rename_path: ['hostId'],
    upload_file: ['hostId'],
    download_file: ['hostId'],
    get_probe: ['hostId'],
    get_probe_samples: ['hostId'],
    get_probe_timeseries: ['hostId'],
    get_probe_traffic: ['hostId'],
    install_probe_agent: ['hostId'],
    restart_probe_agent: ['hostId'],
    uninstall_probe_agent: ['hostId'],
    probe_diag_ping: ['hostId'],
    probe_diag_http: ['hostId'],
    probe_diag_dns: ['hostId'],
  });

  function toolPolicyLabel(policy = {}) {
    return policy.source === 'agent_workspace' ? 'Agent 工作区' : 'Remote MCP Token';
  }

  function deniedByPolicy(message) {
    return { content: `[ERROR] ${message}`, is_error: true };
  }

  function scopedHostIdForSession(session = {}) {
    const allowedHosts = session?.toolPolicy?.allowedHosts || [];
    const scopedHosts = Array.isArray(allowedHosts)
      ? allowedHosts.map((item) => String(item || '').trim()).filter((item) => item && item !== '*')
      : [];
    if (scopedHosts.length === 1) return scopedHosts[0];
    if (Array.isArray(allowedHosts) && allowedHosts.length > 0) return '';
    const sessionHostId = String(session?.hostId || '').trim();
    return sessionHostId && sessionHostId !== 'all' ? sessionHostId : '';
  }

  function applySessionHostScopeToInput(toolName, args = {}, session = {}) {
    const fields = HOST_SCOPED_TOOL_FIELDS[String(toolName || '').trim()] || [];
    if (fields.length === 0 || !args || typeof args !== 'object' || Array.isArray(args)) return args || {};
    const defaultHostId = scopedHostIdForSession(session);
    if (!defaultHostId) return args;
    let next = args;
    for (const field of fields) {
      if (String(next[field] || '').trim()) continue;
      if (next === args) next = { ...args };
      next[field] = defaultHostId;
    }
    return next;
  }

  function createIdeRuntimeDispatchOptions({ socket, sessionId, runId, session, mcpToolMap, emitLifecycle = true, recordPhase = true, recordEffects = true } = {}) {
    const approvalMode = normalizeIdeApprovalMode(session?.approvalMode);
    const allowInteractiveApproval = approvalMode === 'manual';
    const preApproved = approvalMode === 'full_access';
    const requestHarnessApproval = async (toolName, input, summary, riskReason, approvalContext = {}) => {
      const toolUseId = String(approvalContext?.toolUseId || approvalContext?.tool_use_id || approvalContext?.providerToolUseId || approvalContext?.provider_tool_use_id || '').trim();
      const approval = await waitForApproval(socket, sessionId, { id: toolUseId, name: toolName, input: input || {} }, session, runId, {
        summary,
        riskReason,
        workNote: readToolWorkNote(session, runId, toolUseId),
        approval: approvalContext?.approval || null,
        risk: approvalContext?.risk || null,
        needApproval: approvalContext?.needApproval === true,
        approvalRequired: approvalContext?.approvalRequired === true,
        title: summary?.title || '操作需要确认',
      });
      throwIfStopped(session, runId);
      return approval.action === 'allow';
    };

    return ({ action = {} } = {}) => ({
      toolCallId: action.id,
      providerToolUseId: action.id,
      scope: { hostId: session?.hostId || action.args?.hostId || 'local' },
      approvalMode,
      allowApproval: allowInteractiveApproval,
      preApproved,
      requestApproval: allowInteractiveApproval ? (toolName, input, summary, riskReason, approvalContext = {}) => requestHarnessApproval(
        toolName,
        input,
        summary,
        riskReason,
        { ...approvalContext, toolUseId: action.id },
      ) : undefined,
      executeTool: async ({ toolName, args, toolCall, context: toolContext }) => {
        const scopedArgs = applySessionHostScopeToInput(toolName, args || {}, session);
        const tc = {
          id: toolCall?.providerToolUseId || toolCall?.id || action.id || `${toolName}-${Date.now()}`,
          name: toolName,
          input: scopedArgs,
        };
        const toolAc = new AbortController();
        const unregisterToolCancel = registerCancelHandler(session, () => toolAc.abort());
        const emitToolDelta = ({ stream = 'stdout', text = '' } = {}) => {
          if (!text || !isRunCurrent(session, runId)) return;
          emitToSession(session, socket, 'ide:tool-delta', {
            sessionId,
            runId,
            toolUseId: tc.id,
            name: tc.name,
            stream: stream === 'stderr' ? 'stderr' : 'stdout',
            text: redactCredentialPatterns(String(text)),
          });
        };
        let result = null;
        try {
          throwIfStopped(session, runId);
          if (emitLifecycle) emitToSession(session, socket, 'ide:tool-start', { sessionId, runId, toolUseId: tc.id, name: tc.name, input: redactAgentTraceValue(tc.input), workNote: readToolWorkNote(session, runId, tc.id) });
          if (recordPhase) {
            const phaseId = tc.name === 'verify_outcome'
              ? 'verify'
              : (tc.name === 'ask_user' || tc.name === 'request_secret' ? 'context' : 'act');
            recordIdeAgentPhase(runId, phaseId, `Calling tool ${tc.name}.`);
          }

          if (tc.name === 'ask_user' || tc.name === 'request_secret') {
            result = await waitForUserInterruptTool(socket, sessionId, tc, session, runId);
            return result;
          }

          const policyResult = applyToolPolicy(tc, session);
          if (policyResult) {
            result = policyResult;
            return result;
          }

          const mcpInfo = mcpToolMap?.get?.(toolName);
          let rewindUndoRecord = null;
          if (mcpInfo && localMcpService) {
            try {
              result = await localMcpService.callTool(mcpInfo.mcpId, mcpInfo.mcpToolName, scopedArgs, {
                signal: toolAc.signal,
                killOnAbort: true,
              });
            } catch (err) {
              if (isAbortError(err) || toolAc.signal.aborted) throw makeAbortError();
              result = { content: `[ERROR] ${err.message}`, is_error: true };
            }
          } else {
            rewindUndoRecord = await prepareRewindUndoRecord(session, tc.name, tc.input, {
              runId,
              sessionId,
              toolUseId: tc.id,
            });
            result = await ideTools.handle(toolName, scopedArgs, {
              socket,
              sessionId,
              runId,
              safeMode: false,
              session,
              signal: toolAc.signal,
              approvalMode,
              allowApproval: allowInteractiveApproval,
              preApproved,
              requestApproval: allowInteractiveApproval ? (approvalToolName, approvalInput, approvalSummary, approvalRiskReason, approvalContext = {}) => requestHarnessApproval(
                approvalToolName,
                approvalInput,
                approvalSummary,
                approvalRiskReason,
                { ...approvalContext, toolUseId: tc.id },
              ) : undefined,
              approvalGranted: toolContext?.approvalGranted === true,
              onToolDelta: emitToolDelta,
            });
          }

          recordRewindUndo(session, tc.name, tc.input, result, rewindUndoRecord, {
            runId,
            sessionId,
            toolUseId: tc.id,
          });
          if (recordEffects) recordIdeAgentSideEffect(runId, tc, result, { ...session, sessionId });
          if (recordEffects && tc.name === 'verify_outcome') {
            recordIdeVerificationOutcome(runId, result, {
              sessionId,
              hostId: session?.hostId || tc.input?.hostId || 'local',
              toolUseId: tc.id,
            });
          }
          return result;
        } finally {
          unregisterToolCancel();
          if (emitLifecycle && isRunCurrent(session, runId)) {
            emitToSession(session, socket, 'ide:tool-end', {
              sessionId,
              runId,
              toolUseId: tc.id,
              name: tc.name,
              result: clientToolResultForFrontend(tc.name, result),
              is_error: isIdeToolResultError(result),
            });
          }
        }
      },
    });
  }

  function appendControllerObservationsToSession(session, observations = []) {
    const items = Array.isArray(observations) ? observations : [];
    if (items.length === 0) return;
    if (!session.controllerObservationIds) session.controllerObservationIds = new Set();
    const providerToolUseIds = allToolUseIds(session.messages);
    const blocks = [];
    for (const observation of items) {
      if (!observation || typeof observation !== 'object') continue;
      const id = String(observation.id || observation.toolCallId || '').trim();
      if (id && session.controllerObservationIds.has(id)) continue;
      if (id) session.controllerObservationIds.add(id);
      const block = observationToProviderMessageBlock(observation, { providerToolUseIds });
      if (block) blocks.push(block);
    }
    if (blocks.length > 0) {
      const lastMessage = session.messages[session.messages.length - 1];
      const isPureToolResultMessage = lastMessage?.role === 'user'
        && Array.isArray(lastMessage.content)
        && lastMessage.content.length > 0
        && lastMessage.content.every((b) => b?.type === 'tool_result');
      if (isPureToolResultMessage) {
        lastMessage.content.push(...blocks);
      } else {
        session.messages.push({ role: 'user', content: blocks });
      }
    }
  }

  // Normalize a Harness dispatchTool result into an observation the streaming adapter can
  // feed back to the model as a tool_result on the next turn.
  function normalizeIdeToolObservation(toolCall = {}, result = {}) {
    const raw = result?.raw && typeof result.raw === 'object' ? result.raw : {};
    const contentText = toolContentPreview(result.content || '');
    const facts = extractToolResultFacts(result, raw, contentText);
    const exitCode = firstFiniteNumber(raw.exitCode, result.exitCode, facts.exitCode);
    const isError = result.is_error === true
      || result.isError === true
      || facts.ok === false
      || facts.isError === true
      || (typeof exitCode === 'number' && exitCode !== 0);
    const stdout = String(raw.stdout || result.stdout || facts.stdout || '');
    const stderr = String(raw.stderr || result.stderr || facts.stderr || '');
    return {
      id: toolCall.id,
      providerToolUseId: toolCall.id,
      toolName: toolCall.toolName,
      ok: !isError,
      isError,
      exitCode,
      content: contentText || facts.summary || stdout || stderr || '',
      stdout,
      stderr,
      outputDiagnostics: facts.outputDiagnostics || raw.outputDiagnostics || result.outputDiagnostics || null,
      summary: facts.summary || '',
      error: String(result.error || facts.error || (isError ? facts.summary : '') || '').slice(0, 1000),
    };
  }

  function isIdeToolResultError(result = {}) {
    const raw = result?.raw && typeof result.raw === 'object' ? result.raw : {};
    const contentText = toolContentPreview(result?.content || '');
    const facts = extractToolResultFacts(result || {}, raw, contentText);
    const exitCode = firstFiniteNumber(raw.exitCode, result?.exitCode, facts.exitCode);
    return result?.is_error === true
      || result?.isError === true
      || facts.ok === false
      || facts.isError === true
      || (typeof exitCode === 'number' && exitCode !== 0);
  }

  function observationToProviderMessageBlock(observation = {}, { providerToolUseIds = new Set() } = {}) {
    if (isRuntimeOnlyObservation(observation)) {
      const runtimeText = runtimeObservationTextForProvider(observation);
      return runtimeText ? { type: 'text', text: runtimeText } : null;
    }
    const content = compactToolResultForModel(
      observation.toolName || observation.kind || 'observation',
      formatObservationContentForProvider(observation),
    );
    const toolUseId = providerToolUseIdForObservation(observation, providerToolUseIds);
    if (toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(observation.isError === true || observation.ok === false ? { is_error: true } : {}),
      };
    }
    return {
      type: 'text',
      text: toolContentPreview(content) || String(observation.content || observation.error || ''),
    };
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return undefined;
  }

  function extractToolResultFacts(result = {}, raw = {}, contentText = '') {
    const facts = {};
    mergeToolFactSource(facts, result);
    mergeToolFactSource(facts, raw);
    const parsed = parseToolResultJson(contentText);
    if (parsed) {
      mergeToolFactSource(facts, parsed);
      if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
        mergeToolFactSource(facts, parsed.data);
      }
    }
    if (facts.exitCode === undefined) {
      const match = String(contentText || '').match(/(?:\[exitCode\]|exitCode|exit_code)\s*[:=\]]?\s*(-?\d+)/i);
      if (match) facts.exitCode = Number(match[1]);
    }
    if (facts.ok === undefined && /"ok"\s*:\s*false/i.test(String(contentText || ''))) facts.ok = false;
    if (facts.ok === undefined && /"ok"\s*:\s*true/i.test(String(contentText || ''))) facts.ok = true;
    if (facts.isError === undefined && /^\s*\[ERROR\]/i.test(String(contentText || ''))) facts.isError = true;
    if (!facts.error && facts.isError) facts.error = facts.summary || String(contentText || '').slice(0, 1000);
    return facts;
  }

  function mergeToolFactSource(target, source = {}) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    if (typeof source.ok === 'boolean') target.ok = source.ok;
    if (typeof source.isError === 'boolean') target.isError = source.isError;
    if (typeof source.is_error === 'boolean') target.isError = source.is_error;
    const exitCode = firstFiniteNumber(source.exitCode, source.exit_code);
    if (exitCode !== undefined) target.exitCode = exitCode;
    if (!target.summary && source.summary !== undefined) target.summary = String(source.summary || '');
    if (!target.error && source.error !== undefined) target.error = String(source.error || '');
    if (!target.stdout && source.stdout !== undefined) target.stdout = String(source.stdout || '');
    if (!target.stderr && source.stderr !== undefined) target.stderr = String(source.stderr || '');
    if (!target.outputDiagnostics && source.outputDiagnostics && typeof source.outputDiagnostics === 'object' && !Array.isArray(source.outputDiagnostics)) {
      target.outputDiagnostics = source.outputDiagnostics;
    }
  }

  function parseToolResultJson(contentText = '') {
    const text = String(contentText || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function clientToolResultForFrontend(toolName, result = {}) {
    const contentText = toolContentPreview(result?.content || '');
    if (['list_hosts', 'list_probes'].includes(String(toolName || ''))) {
      const parsed = parseToolResultJson(contentText);
      if (parsed) return parsed;
    }
    return contentText.substring(0, 4000);
  }

  function formatObservationContentForProvider(observation = {}) {
    const body = toolContentPreview(
      observation.content
      || observation.stdout
      || observation.stdoutExcerpt
      || observation.stderr
      || observation.stderrExcerpt
      || observation.error
      || '',
    ).trim();
    const lines = [
      observation.toolName ? `tool=${observation.toolName}` : '',
      observation.ok === true ? 'ok=true' : (observation.ok === false || observation.isError === true ? 'ok=false' : ''),
      observation.isError === true ? 'is_error=true' : '',
      Number.isFinite(Number(observation.exitCode)) ? `exitCode=${Number(observation.exitCode)}` : '',
      observation.error ? `error=${String(observation.error).slice(0, 1000)}` : '',
      observation.summary ? `summary=${String(observation.summary).slice(0, 1000)}` : '',
    ].filter(Boolean);
    const diagnosticsText = formatOutputDiagnostics(observation.outputDiagnostics);
    if (diagnosticsText) lines.push(diagnosticsText);
    if (observation.toolName === 'list_hosts') {
      const parsed = parseToolResultJson(body);
      const hosts = parsed?.data && typeof parsed.data === 'object' && Array.isArray(parsed.data.hosts)
        ? parsed.data.hosts
        : [];
      if (hosts.length > 0) {
        lines.push(
          'structured_result=list_hosts',
          `host_count=${hosts.length}`,
          'display_note=The UI renders exact host fields from this structured result. In final prose, summarize the count and refer to the rendered list instead of rewriting ID/IP/address tables.',
        );
      }
    }
    if (observation.toolName === 'list_probes') {
      const parsed = parseToolResultJson(body);
      const probes = Array.isArray(parsed?.probes)
        ? parsed.probes
        : (Array.isArray(parsed?.data?.probes) ? parsed.data.probes : []);
      if (probes.length > 0) {
        const onlineCount = probes.filter((probe) => probe?.online === true && !probe?.error).length;
        lines.push(
          'structured_result=list_probes',
          `probe_count=${probes.length}`,
          `online_count=${onlineCount}`,
          'display_note=The UI renders exact probe fields from this structured result. In final prose, summarize status and refer to the rendered probe card instead of rewriting CPU/memory/disk/platform data as Markdown tables.',
        );
      }
    }
    if (lines.length === 0) return body;
    return [lines.join('\n'), body].filter(Boolean).join('\n\n');
  }

  function runtimeObservationTextForProvider(observation = {}) {
    const kind = String(observation.kind || observation.type || '').trim();
    const toolName = String(observation.toolName || observation.tool_name || '').trim();
    if (kind !== 'interrupt_resolution' && toolName !== 'agent_interrupt') {
      return toolContentPreview(observation.content || observation.summary || observation.error || '').trim();
    }
    const data = observation.data && typeof observation.data === 'object' && !Array.isArray(observation.data) ? observation.data : {};
    const resolution = data.resolution && typeof data.resolution === 'object' && !Array.isArray(data.resolution) ? data.resolution : {};
    const lines = ['User input received for the interrupted run.'];
    const status = String(data.status || resolution.status || '').trim();
    if (status) lines.push(`status=${status}`);
    const reason = String(resolution.reason || observation.error || '').trim();
    if (reason) lines.push(`reason=${reason.slice(0, 1000)}`);
    const note = String(resolution.note || '').trim();
    if (note) lines.push(`note=${note.slice(0, 1000)}`);
    if (resolution.answers && typeof resolution.answers === 'object' && !Array.isArray(resolution.answers)) {
      try {
        lines.push(`answers=${JSON.stringify(redactAgentTraceValue(resolution.answers)).slice(0, 2000)}`);
      } catch { /* ignore malformed answers */ }
    }
    return lines.filter(Boolean).join('\n');
  }

  function providerToolUseIdForObservation(observation = {}, providerToolUseIds = new Set()) {
    if (isRuntimeOnlyObservation(observation)) return '';
    const candidates = [
      observation.providerToolUseId,
      observation.provider_tool_use_id,
      observation.toolCallId,
      observation.tool_call_id,
      observation.tool_use_id,
      observation.id,
    ].map((item) => String(item || '').trim()).filter(Boolean);
    return candidates.find((id) => providerToolUseIds.has(id)) || '';
  }

  function isRuntimeOnlyObservation(observation = {}) {
    const kind = String(observation.kind || observation.type || '').trim();
    const toolName = String(observation.toolName || observation.tool_name || '').trim();
    return kind.startsWith('runtime_')
      || ['recover', 'verify', 'interrupt_resolution'].includes(kind)
      || ['agent_controller', 'agent_interrupt'].includes(toolName);
  }

  function createIdeStreamingModelAdapter({ socket, sessionId, runId, session, model, proxyUrl, agentTools, context }) {
    let providerTransientRetryCount = 0;
    return async function ideStreamingModelAdapter(request = {}) {
      appendControllerObservationsToSession(session, request.observations || []);
      throwIfStopped(session, runId);
      if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:thinking', { sessionId, runId });

      let data = null;
      try {
        sanitizeProviderMessageHistory(session.messages);
        repairDanglingToolUseMessages(session.messages);
        const compactedMessages = projectMessagesForModelApi(compactMessages(session.messages));
        const baseSystem = [
          composeSystemPrompt(session.system, session.activeSkillContext),
          String(session.contextBlock || '').trim(),
          String(buildRunContextBlock(context) || '').trim(),
        ].filter(Boolean).join('\n\n');
        const apiBody = JSON.stringify({
          model,
          max_tokens: 8192,
          stream: true,
          system: baseSystem,
          messages: compactedMessages,
          tools: agentTools,
        });

        for (let attempt = 0; attempt <= MAX_PROVIDER_TRANSIENT_RETRIES; attempt++) {
          const ac = new AbortController();
          session.abortController = ac;
          const overallTimeout = setTimeout(() => {
            try { ac.abort(); } catch { /* ignore */ }
          }, 240000);
          try {
            logger?.info?.(`[ide] controller round ${request.turn || '?'} attempt ${attempt} fetching provider (timeout=240s)`);
            const fetchStartedAt = Date.now();
            recordTraceEvent('provider', 'provider_request_started', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `controller turn=${request.turn || '?'} attempt=${attempt}`,
              data: { turn: request.turn || null, attempt, timeoutMs: 240000 },
            });
            const resp = await fetch(proxyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: apiBody,
              signal: ac.signal,
            });

            if (!resp.ok) {
              clearTimeout(overallTimeout);
              session.abortController = null;
              const errText = await resp.text().catch(() => '');
              recordTraceEvent('provider', 'provider_http_error', {
                source: 'ide',
                runId,
                sessionId,
                hostId: session.hostId,
                toolName: 'model_provider',
                summary: `provider returned HTTP ${resp.status}`,
                data: { turn: request.turn || null, attempt, status: resp.status, bodyPreview: errText.substring(0, 500) },
              });
              throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
            }

            recordTraceEvent('provider', 'provider_headers_received', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `controller turn=${request.turn || '?'} headers received`,
              data: { turn: request.turn || null, attempt, elapsedMs: Date.now() - fetchStartedAt },
            });
            data = await streamAnthropicSSE(resp.body, ac, session, socket, sessionId, runId);
            clearTimeout(overallTimeout);
            session.abortController = null;
            logger?.info?.(`[ide] controller round ${request.turn || '?'} stream done (${Date.now() - fetchStartedAt}ms total), tools=${data.content.filter(b=>b.type==='tool_use').map(b=>b.name).join(',')||'(none)'}, stop_reason=${data.stop_reason}`);
            recordTraceEvent('provider', 'provider_stream_completed', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `controller turn=${request.turn || '?'} completed`,
              data: {
                turn: request.turn || null,
                attempt,
                elapsedMs: Date.now() - fetchStartedAt,
                stopReason: data.stop_reason || '',
                toolNames: data.content.filter(b => b.type === 'tool_use').map(b => b.name),
              },
            });
            break;
          } catch (retryErr) {
            clearTimeout(overallTimeout);
            session.abortController = null;
            const wasTimeout = retryErr.name === 'AbortError' && !session.cancelled;
            recordTraceEvent('provider', retryErr.name === 'AbortError' ? 'provider_request_aborted' : 'provider_attempt_failed', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: retryErr.message || retryErr.name || 'provider attempt failed',
              data: {
                turn: request.turn || null,
                attempt,
                timeout: wasTimeout,
                cancelled: !!session.cancelled,
                errorName: retryErr.name || '',
                retryable: wasTimeout || isTransientProviderError(retryErr),
              },
            });
            if (retryErr.name === 'AbortError' && session.cancelled) throw retryErr;
            const isRetryable = wasTimeout || isTransientProviderError(retryErr);
            if (!isRetryable || attempt >= MAX_PROVIDER_TRANSIENT_RETRIES) throw retryErr;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      } catch (err) {
        session.abortController = null;
        if (isAbortError(err)) throw err;
        if (isTransientProviderError(err) && providerTransientRetryCount < 1) {
          providerTransientRetryCount += 1;
          if (isRunCurrent(session, runId)) {
            emitToSession(session, socket, 'ide:thinking', { sessionId, runId });
          }
          return ideStreamingModelAdapter(request);
        }
        throw err;
      }

      if (data?.type === 'error') throw new Error(data.error?.message || 'API error');
      throwIfStopped(session, runId);

      const textParts = data.content.filter(b => b.type === 'text').map(b => b.text);
      const toolCalls = data.content.filter(b => b.type === 'tool_use');
      for (const tc of toolCalls) {
        tc.input = normalizeIdeAgentToolInput(session.agentGoalProfile, tc.name, tc.input || {});
      }
      rememberToolWorkNotes(session, runId, data.content);
      const fullText = textParts.join('');
      const exactExpansion = expandExactTextReferences(fullText, session);
      const visibleText = exactExpansion.text;
      if (visibleText.trim().length > 0) {
        // 已通过 text-delta 流过的原文不要再 ide:text 重说一遍——
        // 前端 tool-start 会封存气泡，二次定稿会在工具卡后冒出重复助手文案。
        // 仅在未流式推送、或 exact 引用展开需要改写时再发。
        if (!data._emittedTextDelta) {
          emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: visibleText });
          emitToSession(session, socket, 'ide:text', {
            sessionId,
            runId,
            text: visibleText,
            exactExpanded: exactExpansion.expanded,
            exactRefs: exactExpansion.refs,
          });
        } else if (exactExpansion.expanded) {
          emitToSession(session, socket, 'ide:text-replace', {
            sessionId,
            runId,
            text: visibleText,
            exactExpanded: true,
            exactRefs: exactExpansion.refs,
          });
          emitToSession(session, socket, 'ide:text', {
            sessionId,
            runId,
            text: visibleText,
            exactExpanded: true,
            exactRefs: exactExpansion.refs,
          });
        }
        recordTraceEvent('reasoning', toolCalls.length > 0 ? 'tool_decision' : 'reasoning_summary', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: toolCalls.length > 0 ? 'ai_tool_decision' : 'ai_response',
          summary: assistantTraceSummary(visibleText, exactExpansion),
          data: exactExpansionTraceData(exactExpansion),
        });
      }
      if (hasProviderAssistantContent(data.content)) {
        const expandedBlocks = expandExactTextReferencesInBlocks(data.content, session);
        session.messages.push({ role: 'assistant', content: expandedBlocks.expanded ? expandedBlocks.content : data.content });
      }
      return {
        text: visibleText,
        toolCalls: toolCalls.map((tc) => {
          const executionInput = cloneToolInputForExecution(tc.input || {});
          return {
            id: tc.id,
            toolName: tc.name,
            args: executionInput,
            input: cloneToolInputForExecution(tc.input || {}),
            traceInput: redactAgentTraceValue(tc.input || {}),
            workNote: readToolWorkNote(session, runId, tc.id),
          };
        }),
        final: toolCalls.length === 0 || data.stop_reason === 'end_turn',
        finishReason: data.stop_reason || '',
      };
    };
  }

  function hasProviderAssistantContent(content = []) {
    return Array.isArray(content) && content.some((block) => {
      if (block?.type === 'tool_use') return true;
      if (block?.type === 'text') return String(block.text || '').trim().length > 0;
      return false;
    });
  }

  function isEmptyModelResult(result = {}) {
    const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    if (toolCalls.length > 0) return false;
    return ![result?.text, result?.report, result?.content].some((value) => String(value || '').trim().length > 0);
  }

  function createEmptyModelResponseObservation({ attempt }) {
    const content = [
      'RUNTIME_EMPTY_MODEL_RESPONSE',
      `attempt=${attempt}`,
      'The previous provider response contained no assistant text and no tool calls, so 1Shell did not treat it as completion.',
      'Continue by producing visible assistant text, calling the next appropriate tool, asking a required user question, or explaining the blocker.',
    ].join('\n');
    return {
      id: `runtime-empty-model-response-${Date.now()}-${attempt}`,
      kind: 'runtime_empty_model_response',
      toolName: 'agent_controller',
      content,
      summary: content,
      ok: false,
      isError: true,
    };
  }

  function filteredHostsForPolicy(policy) {
    const hosts = hostService?.listHosts?.() || [];
    const allowedHosts = policy.allowedHosts || [];
    const visible = hosts.filter((host) => allowsValue(host.id, allowedHosts));
    const normalized = visible.map((host) => {
      const type = String(host.type || 'ssh').trim() || 'ssh';
      const id = String(host.id || '').trim();
      const name = String(host.name || id || '').trim();
      const hostAddress = type === 'local' ? '127.0.0.1' : String(host.host || '127.0.0.1').trim();
      const port = type === 'local' ? null : (Number(host.port) || 22);
      // OS 让模型知道该吐 PowerShell 还是 bash —— agent 多数时候是从这里挑主机的。
      const osName = String(host.osInfo?.os || '').toLowerCase() || null;
      return {
        id,
        name,
        host: hostAddress,
        port,
        address: port ? `${hostAddress}:${port}` : hostAddress,
        type,
        ...(osName ? { os: osName } : {}),
        ...(host.osInfo?.prettyName ? { osName: host.osInfo.prettyName } : {}),
        ...(osName === 'windows' ? { shell: 'powershell' } : {}),
      };
    }).filter((host) => host.id);
    const windowsCount = normalized.filter((host) => host.os === 'windows').length;
    return {
      content: formatJson({
        ok: true,
        summary: normalized.length > 0 ? '主机列表读取成功' : '无允许访问的主机',
        ...(windowsCount > 0
          ? { note: 'os=windows 的主机上命令以 PowerShell 执行，请使用 PowerShell 语法与 Windows 路径，不要用 bash/POSIX 命令。' }
          : {}),
        data: { hosts: normalized },
      }),
      is_error: false,
    };
  }

  function applyToolPolicy(tc, session) {
    const policy = session?.toolPolicy;
    if (!policy) return null;
    const input = tc.input || {};
    const requiredDirectToolByInternalTool = {
      execute_command: 'host_exec',
      list_hosts: 'list_hosts',
      list_remote_dir: 'list_remote_dir',
      read_remote_file: 'read_remote_file',
      write_remote_file: 'write_remote_file',
      create_directory: 'create_directory',
      delete_path: 'delete_path',
      rename_path: 'rename_path',
      upload_file: 'upload_file',
      download_file: 'download_file',
    };
    const directTool = requiredDirectToolByInternalTool[tc.name];
    if (directTool && policy.allowedTools.length > 0 && !policy.allowedTools.includes('*') && !policy.allowedTools.includes(directTool)) {
      return deniedByPolicy(`${toolPolicyLabel(policy)} 不允许 1Shell AI 使用能力: ${directTool}`);
    }
    const writeTools = new Set([
      'execute_command',
      'run_script', 'save_script', 'write_remote_file', 'create_directory', 'delete_path', 'rename_path',
      'upload_file', 'download_file', 'add_mcp_server',
      'remove_mcp_server', 'deploy_local_mcp', 'ack_probe_alert', 'install_probe_agent',
      'restart_probe_agent', 'uninstall_probe_agent', 'invoke_claude_code',
    ]);
    if (writeTools.has(tc.name)) {
      // answer/plan 是"只读探查"档（外部 AI 委托探查服务器的主路径）：
      // execute_command 放行只读命令，其余写工具一刀切拒绝。判定抽在
      // ide.agent-kernel.evaluateGatewayWriteToolPolicy，纯函数可直接测。
      const gatewayVerdict = evaluateGatewayWriteToolPolicy(policy.gatewayMode, tc.name, input.command);
      if (gatewayVerdict) return deniedByPolicy(gatewayVerdict.reason);
    }
    if (tc.name === 'list_hosts' && policy.allowedHosts.length > 0 && !policy.allowedHosts.includes('*')) {
      return filteredHostsForPolicy(policy);
    }
    for (const field of HOST_SCOPED_TOOL_FIELDS[tc.name] || []) {
      const value = String(input[field] || '').trim();
      if (!value) continue;
      if (value === 'all' && policy.allowedHosts.length > 0 && !policy.allowedHosts.includes('*')) {
        return deniedByPolicy(`${toolPolicyLabel(policy)} 不允许访问全部主机`);
      }
      if (!allowsValue(value, policy.allowedHosts)) return deniedByPolicy(`${toolPolicyLabel(policy)} 不允许访问主机: ${value}`);
    }
    // 脚本 id 白名单。注意字段名不统一：run_script 用 scriptId，get_script /
    // save_script 用 id —— 照抄单一字段会让新工具静默漏检。
    const scriptIdField = { run_script: 'scriptId', get_script: 'id', save_script: 'id' }[tc.name];
    if (scriptIdField) {
      const scriptId = String(input[scriptIdField] || '').trim();
      if (scriptId && !allowsValue(scriptId, policy.allowedScripts)) {
        return deniedByPolicy(`${toolPolicyLabel(policy)} 不允许操作脚本: ${scriptId}`);
      }
      // save_script 新建分支没有 id 可比对，id 白名单表达不了"允许创建未知 id"，
      // 有非通配白名单时直接拒（fail-closed）。
      if (!scriptId && tc.name === 'save_script'
          && policy.allowedScripts.length > 0 && !policy.allowedScripts.includes('*')) {
        return deniedByPolicy(`${toolPolicyLabel(policy)} 不允许新建脚本`);
      }
    }
    const pathFieldsByTool = {
      list_remote_dir: ['path'],
      read_remote_file: ['path'],
      write_remote_file: ['path'],
      create_directory: ['path'],
      delete_path: ['path'],
      rename_path: ['path', 'newPath'],
      upload_file: ['dirPath', 'localPath'],
      download_file: ['path', 'localPath'],
    };
    for (const field of pathFieldsByTool[tc.name] || []) {
      const value = String(input[field] || '').trim();
      if (value && !allowsPath(value, policy.allowedPaths)) return deniedByPolicy(`${toolPolicyLabel(policy)} 不允许访问路径: ${value}`);
    }
    return null;
  }

  function buildIdeToolCatalog(session) {
    const seenToolNames = new Set();
    const allTools = [];
    const mcpToolMap = new Map();
    for (const t of ideTools.TOOL_SCHEMAS) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      allTools.push(t);
    }
    if (session?.claudeCodeEnabled && ideTools.CLAUDE_CODE_TOOL) {
      const t = ideTools.CLAUDE_CODE_TOOL;
      if (!seenToolNames.has(t.name)) {
        seenToolNames.add(t.name);
        allTools.push(t);
      }
    }
    if (localMcpService) {
      const ideMcpIds = mcpRegistry
        ? mcpRegistry.listServers().filter((s) => s.enabled && s.exposeToIde).map((s) => s.id)
        : undefined;
      for (const t of localMcpService.getAllActiveTools({ allowedIds: ideMcpIds })) {
        if (seenToolNames.has(t.name)) continue;
        seenToolNames.add(t.name);
        mcpToolMap.set(t.name, { mcpId: t._mcpId, mcpToolName: t._mcpToolName });
        const { _mcpId, _mcpToolName, ...clean } = t;
        allTools.push(clean);
      }
    }
    return { allTools, mcpToolMap };
  }

  function waitForApproval(socket, sessionId, tc, session, runId, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `apr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const baseSummary = getApprovalSummary(tc);
      const summary = options.summary || baseSummary;
      const riskReason = String(options.riskReason || '').trim();
      const workNote = normalizeVisibleWorkNote(options.workNote || readToolWorkNote(session, runId, tc.id));
      const approvalFacts = normalizeApprovalFacts(tc, summary, riskReason, options);
      const approvalInterrupt = createIdeApprovalInterrupt(runId, requestId, tc, summary, riskReason, { ...options, workNote, approvalFacts });
      let unregisterCancel = null;
      let settled = false;

      const cleanup = () => {
        socket.off('ide:approve-response', handler);
        clearTimeout(timer);
        if (unregisterCancel) unregisterCancel();
      };

      const settle = (fn, value, resolution = value) => {
        if (settled) return;
        settled = true;
        resolveIdeApprovalInterrupt(runId, approvalInterrupt, resolution || {});
        cleanup();
        fn(value);
      };

      const handler = (resp) => {
        if (resp.requestId !== requestId) return;
        settle(resolve, resp);
      };
      socket.on('ide:approve-response', handler);

      const timer = setTimeout(() => settle(resolve, { action: 'deny', reason: 'approval_timeout' }), 5 * 60 * 1000);
      unregisterCancel = registerCancelHandler(session, () => settle(reject, makeAbortError(), { action: 'deny', reason: 'cancelled' }));

      try {
        throwIfStopped(session, runId);
        emitToSession(session, socket, 'ide:approve-request', {
          sessionId,
          runId,
          requestId,
          toolUseId: tc.id || '',
          toolName: tc.name,
          title: approvalFacts.title || options.title || summary.title,
          detail: formatApprovalDetail(summary, approvalFacts.riskReason || riskReason),
          workNote,
          reason: approvalFacts.reason,
          riskReason: approvalFacts.riskReason,
          riskLevel: approvalFacts.riskLevel,
          hostId: approvalFacts.hostId,
          actionKind: approvalFacts.actionKind,
          actionText: approvalFacts.actionText,
          input: approvalFacts.input,
          approval: approvalFacts,
        });
      } catch (err) {
        settle(reject, err, { action: 'deny', reason: err.message || 'approval_emit_failed' });
      }
    });
  }

  function formatApprovalDetail(summary = {}, riskReason = '') {
    const detail = String(summary?.detail || '').trim();
    const reason = String(riskReason || '').trim();
    if (!reason) return detail;
    const readableReason = reason.startsWith('需要确认：') ? reason : `需要确认：${reason}`;
    if (!detail) return readableReason;
    if (detail.includes(reason) || detail.includes(readableReason)) return detail;
    return [readableReason, detail].filter(Boolean).join('\n\n');
  }

  function normalizeApprovalFacts(tc, summary = {}, riskReason = '', options = {}) {
    const input = tc.input || {};
    const provided = options.approval && typeof options.approval === 'object' ? options.approval : {};
    const risk = provided.risk && typeof provided.risk === 'object' ? provided.risk : (options.risk && typeof options.risk === 'object' ? options.risk : null);
    const title = String(options.title || provided.title || summary.title || tc.name || '操作需要确认').trim();
    const detail = String(provided.detail || summary.detail || '').trim();
    const normalizedRiskReason = String(provided.riskReason || riskReason || '').trim();
    const actionText = String(provided.actionText || summary.actionText || detail || '').trim();
    const riskLevel = String(provided.riskLevel || options.riskLevel || options.risk_level || risk?.level || '').trim();
    const hostId = String(provided.hostId || summary.hostId || input.hostId || 'local').trim() || 'local';
    const reason = String(
      provided.reason
      || (normalizedRiskReason ? `harness 判断需要人工确认：${normalizedRiskReason}` : '此操作需要你确认后才会继续。')
    ).trim();
    const required = provided.required === true || options.approvalRequired === true;
    return {
      schemaVersion: 1,
      source: String(provided.source || 'ide'),
      toolName: tc.name,
      title,
      reason,
      riskReason: normalizedRiskReason,
      riskLevel,
      required,
      recommended: provided.recommended === true || (options.needApproval === true && !required),
      actionKind: String(provided.actionKind || summary.actionKind || 'tool'),
      actionText,
      detail,
      hostId,
      input: redactAgentTraceValue(input || {}),
      summary: {
        title,
        detail,
      },
      risk: risk ? redactAgentTraceValue(risk) : null,
    };
  }

  function applyPromptEntry(session, entry, approvalMode = null) {
    const nextEntry = normalizePromptEntry(entry);
    const nextApprovalMode = normalizeIdeApprovalMode(approvalMode || session.approvalMode);
    if (session.entry !== nextEntry) {
      session.entry = nextEntry;
      session.system = promptForEntry(nextEntry);
      session.activeSkillContext = null;
    }
    session.approvalMode = nextApprovalMode;
  }

  function hasOwnObjectProperty(value, key) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key));
  }

  function cleanWorkspaceHostIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
      .map((item) => String(item || '').trim())
      .filter((item) => item && item !== 'all' && item !== '*'))];
  }

  function workspaceHostIdsFromContext(context = {}) {
    if (hasOwnObjectProperty(context, 'workspaceHostIds')) return cleanWorkspaceHostIds(context.workspaceHostIds);
    if (Array.isArray(context?.hosts)) return cleanWorkspaceHostIds(context.hosts.map((host) => host?.id));
    return [];
  }

  function hostIdForWorkspace(workspaceHostIds = []) {
    return workspaceHostIds.length === 1 ? workspaceHostIds[0] : 'all';
  }

  function hostIdFromContext(context = {}) {
    if (hasOwnObjectProperty(context, 'workspaceHostIds') || Array.isArray(context?.hosts)) {
      return hostIdForWorkspace(workspaceHostIdsFromContext(context));
    }
    return String(context?.hostScope || '').trim() === 'all' ? 'all' : '';
  }

  function buildSessionContextBlock(context) {
    if (!context || typeof context !== 'object') return '';
    const parts = [];
    if (context.hosts?.length > 0) {
      parts.push('**目标主机**：');
      let anyWindows = false;
      for (const h of context.hosts) {
        // OS 以服务端探测结果为准：前端 context 里通常没有这个字段，
        // 而"目标是什么系统"决定模型该吐 PowerShell 还是 bash。
        const probed = hostService?.findHost?.(h.id)?.osInfo || null;
        const osText = probed?.prettyName || probed?.os || h.platform || h.os || '';
        if (String(probed?.os || '').toLowerCase() === 'windows') anyWindows = true;
        const osSuffix = osText ? ` · OS: ${osText}` : '';
        parts.push(`  - id=${h.id} · ${h.name || h.id} (${h.username || 'root'}@${h.host || '127.0.0.1'}:${h.port || 22})${osSuffix}`);
      }
      if (anyWindows) {
        parts.push('  注意：标记为 Windows 的主机上，命令以 PowerShell 执行（不是 bash）。');
        parts.push('  请使用 PowerShell 语法与 Windows 路径，不要用 apt/systemctl/ls 这类 POSIX 命令。');
      }
    }
    if (context.files?.length > 0) {
      parts.push('**相关文件**：');
      for (const f of context.files) parts.push(`  - hostId=${f.hostId} path=${f.path}`);
    }
    if (context.containers?.length > 0) {
      parts.push('**相关容器**：');
      for (const c of context.containers) parts.push(`  - hostId=${c.hostId} name=${c.name || c.id}${c.image ? ` image=${c.image}` : ''}`);
    }
    if (context.mcpServers?.length > 0) {
      parts.push('**MCP Server**：');
      for (const s of context.mcpServers) parts.push(`  - name=${s.name} → ${s.url}`);
    }
    return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
  }

  function getOrCreateSession(sessionId, context, entry, approvalMode = null) {
    const nextContextBlock = buildSessionContextBlock(context);
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.updatedAt = new Date().toISOString();
      applyPromptEntry(session, entry, approvalMode);
      if (nextContextBlock || hasOwnObjectProperty(context, 'hosts') || hasOwnObjectProperty(context, 'workspaceHostIds')) {
        session.contextBlock = nextContextBlock;
      }
      if (hasOwnObjectProperty(context, 'toolPolicy')) session.toolPolicy = context.toolPolicy ? normalizeToolPolicy(context.toolPolicy) : null;
      if (hasOwnObjectProperty(context, 'workspaceHostIds') || Array.isArray(context?.hosts)) session.workspaceHostIds = workspaceHostIdsFromContext(context);
      const contextHostId = hostIdFromContext(context);
      if (contextHostId) session.hostId = contextHostId;
      ensureRewindState(session);
      return session;
    }

    const contextBlock = nextContextBlock;

    const promptEntry = normalizePromptEntry(entry);
    const promptApprovalMode = normalizeIdeApprovalMode(approvalMode);
    const session = {
      messages: restoreSessionMessages(sessionId),
      entry: promptEntry,
      approvalMode: promptApprovalMode,
      system: promptForEntry(promptEntry),
      contextBlock,
      hostId: hostIdFromContext(context) || 'local',
      workspaceHostIds: workspaceHostIdsFromContext(context),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      abortController: null,
      activeChildProcess: null,
      cancelHandlers: new Set(),
      cancelNotified: false,
      cancelled: false,
      currentRunId: null,
      socket: null,
      socketId: null,
      detachedAt: null,
      detachReason: '',
      legacySafeMode: null,
      legacyUnlimitedTurns: null,
      claudeCodeEnabled: false,
      toolPolicy: hasOwnObjectProperty(context, 'toolPolicy') && context.toolPolicy ? normalizeToolPolicy(context.toolPolicy) : null,
      agentPolicy: null,
      agentGoalProfile: null,
      activeSkillContext: null,
      finalizationRepairRounds: 0,
      rewindCheckpoints: [],
      rewindUndoRecords: [],
      rewindSeq: 0,
    };
    sessions.set(sessionId, session);
    return session;
  }

  function ensureRewindState(session) {
    if (!Array.isArray(session.rewindCheckpoints)) session.rewindCheckpoints = [];
    if (!Array.isArray(session.rewindUndoRecords)) session.rewindUndoRecords = [];
    if (!Number.isFinite(Number(session.rewindSeq))) session.rewindSeq = session.rewindCheckpoints.length;
  }

  function createUserRewindCheckpoint(session, message) {
    ensureRewindState(session);
    session.rewindSeq += 1;
    const checkpoint = {
      id: createRewindId(),
      ordinal: session.rewindSeq,
      messageLength: Array.isArray(session.messages) ? session.messages.length : 0,
      undoStart: session.rewindUndoRecords.length,
      text: String(message || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      hostId: session.hostId || '',
      createdAt: new Date().toISOString(),
    };
    session.rewindCheckpoints.push(checkpoint);
    if (session.rewindCheckpoints.length > 40) session.rewindCheckpoints.shift();
    return checkpoint;
  }

  function parseRewindCommand(message) {
    const text = String(message || '').trim();
    const match = text.match(/^\/(?:remind|rewind)(?:\s+(.+))?$/i);
    if (!match) return null;
    const target = String(match[1] || '').trim();
    return { target };
  }

  function resolveIdeProviderConfig() {
    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) return null;
    return {
      provider,
      model: provider.model || 'claude-sonnet-4-20250514',
      proxyUrl: `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`,
    };
  }

  function resolveRewindCheckpoint(session, target = '') {
    ensureRewindState(session);
    const checkpoints = session.rewindCheckpoints;
    if (!checkpoints.length) return null;
    const value = String(target || '').trim();
    if (!value) return null;
    if (/^(last|latest|previous|prev|上次|最近)$/i.test(value)) return checkpoints[checkpoints.length - 1];
    const ordinal = Number(value.replace(/^#/, ''));
    if (Number.isInteger(ordinal)) {
      const byOrdinal = checkpoints.find((checkpoint) => checkpoint.ordinal === ordinal);
      if (byOrdinal) return byOrdinal;
    }
    return checkpoints.find((checkpoint) => checkpoint.id === value) || null;
  }

  function rewindListText(session) {
    ensureRewindState(session);
    if (!session.rewindCheckpoints.length) {
      return '当前会话还没有可回溯的输入。发送一次 Agent 消息后，1Shell 会自动建立回溯点。';
    }
    const lines = session.rewindCheckpoints.slice(-12).map((checkpoint) => {
      const undoCount = Math.max(0, session.rewindUndoRecords.length - checkpoint.undoStart);
      return `- #${checkpoint.ordinal} ${checkpoint.id} · ${checkpoint.text || '(空输入)'} · 可撤销 ${undoCount} 个文件操作`;
    });
    return [
      '可回溯输入：',
      ...lines,
      '',
      '使用 `/remind #编号` 或 `/rewind #编号` 回到某次输入；使用 `/remind last` 回到最近一次输入。',
      '当前只自动撤销 1Shell 结构化文件工具造成的改动；shell 命令、服务安装、数据库写入等系统级副作用会保留在报告里，需要下一步做主机级快照/补偿。',
    ].join('\n');
  }

  function listRewindPoints(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { ok: true, points: [] };
    ensureRewindState(session);
    const points = session.rewindCheckpoints.map((checkpoint) => ({
      id: checkpoint.id,
      ordinal: checkpoint.ordinal,
      text: checkpoint.text || '',
      createdAt: checkpoint.createdAt || '',
      undoCount: Math.max(0, session.rewindUndoRecords.length - checkpoint.undoStart),
      hostId: checkpoint.hostId || session.hostId || '',
      messageLength: checkpoint.messageLength,
    }));
    return { ok: true, points };
  }

  async function handleRewindCommand({ socket, sessionId, session, command, modelLabel = '' }) {
    const runId = newRunId();
    session.socket = socket;
    session.socketId = socket.id;
    session.currentRunId = runId;
    session.cancelled = false;
    emitToSession(session, socket, 'ide:thinking', { sessionId, runId });

    if (!command.target) {
      emitToSession(session, socket, 'ide:text', { sessionId, runId, text: rewindListText(session) });
      emitToSession(session, socket, 'ide:done', { sessionId, runId, taskStatus: 'done' });
      session.currentRunId = null;
      return;
    }

    const checkpoint = resolveRewindCheckpoint(session, command.target);
    if (!checkpoint) {
      emitToSession(session, socket, 'ide:text', {
        sessionId,
        runId,
        text: `没有找到回溯点：${command.target}\n\n${rewindListText(session)}`,
      });
      emitToSession(session, socket, 'ide:done', { sessionId, runId, taskStatus: 'done' });
      session.currentRunId = null;
      return;
    }

    const checkpointIndex = session.rewindCheckpoints.findIndex((item) => item.id === checkpoint.id);
    const undoEntries = session.rewindUndoRecords.slice(checkpoint.undoStart).reverse();
    const results = [];
    for (const entry of undoEntries) {
      throwIfStopped(session, runId);
      try {
        results.push(await applyRewindUndoRecord(session, entry, runId));
      } catch (err) {
        results.push({ ok: false, summary: err.message || '回溯操作失败' });
      }
    }

    session.messages = session.messages.slice(0, checkpoint.messageLength);
    session.rewindUndoRecords = session.rewindUndoRecords.slice(0, checkpoint.undoStart);
    session.rewindCheckpoints = session.rewindCheckpoints.slice(0, checkpointIndex + 1);
    session.firstUserMessage = deriveSessionTitle(session.messages);
    persistSessionSafe(sessionId, session, { modelLabel });
    emitToSession(session, socket, 'ide:rewind', {
      sessionId,
      runId,
      checkpoint: {
        id: checkpoint.id,
        ordinal: checkpoint.ordinal,
        text: checkpoint.text,
      },
      timeline: projectMessagesToTimeline(session.messages),
    });

    const failed = results.filter((item) => !item.ok);
    const lines = [
      `已回到 #${checkpoint.ordinal}：${checkpoint.text || checkpoint.id}`,
      `已撤销 ${results.length - failed.length}/${results.length} 个结构化文件操作。`,
    ];
    if (results.length) {
      lines.push('', '撤销明细：');
      for (const item of results) lines.push(`- ${item.ok ? 'OK' : 'WARN'} ${item.summary}`);
    }
    if (failed.length) {
      lines.push('', '有些操作无法自动恢复，通常是删除了目录、文件超过快照大小，或变更来自 shell 命令。');
    }
    emitToSession(session, socket, 'ide:text', { sessionId, runId, text: lines.join('\n') });
    emitToSession(session, socket, 'ide:done', { sessionId, runId, taskStatus: failed.length ? 'partial' : 'done' });
    session.currentRunId = null;
  }

  async function requestCompactSummary({ session, sessionId, runId, providerConfig, source, instruction, recentCount }) {
    const prompt = buildCompactPrompt({ source, instruction, recentCount });
    const body = JSON.stringify({
      model: providerConfig.model,
      max_tokens: 4096,
      stream: false,
      system: 'You summarize conversation history for a long-running agent. Return only the compact summary.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0.1,
    });

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_PROVIDER_TRANSIENT_RETRIES; attempt += 1) {
      throwIfStopped(session, runId);
      const ac = new AbortController();
      session.abortController = ac;
      const timeout = setTimeout(() => {
        try { ac.abort(); } catch { /* ignore */ }
      }, 240000);
      try {
        recordTraceEvent('provider', 'compact_request_started', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: 'model_provider',
          summary: `compact attempt=${attempt}`,
          data: { attempt, sourceChars: source.length },
        });
        const resp = await fetch(providerConfig.proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: ac.signal,
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
        }
        const data = await resp.json();
        const text = extractProviderTextContent(data);
        if (!text) throw new Error('Provider 没有返回 compact 摘要');
        recordTraceEvent('provider', 'compact_request_completed', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: 'model_provider',
          summary: `compact summary chars=${text.length}`,
          data: { attempt, summaryChars: text.length },
        });
        return text;
      } catch (err) {
        lastError = ac.signal.aborted && !session.cancelled
          ? new Error('compact 请求超过 240 秒未返回')
          : err;
        const retryable = !isAbortError(lastError) && isTransientProviderError(lastError);
        recordTraceEvent('provider', 'compact_request_failed', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: 'model_provider',
          summary: lastError.message || 'compact request failed',
          data: { attempt, retryable },
        });
        if (session.cancelled || isAbortError(lastError) || !retryable || attempt >= MAX_PROVIDER_TRANSIENT_RETRIES) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      } finally {
        clearTimeout(timeout);
        if (session.abortController === ac) session.abortController = null;
      }
    }
    throw lastError || new Error('compact 请求失败');
  }

  async function handleCompactCommand({ socket, sessionId, session, command }) {
    const runId = newRunId();
    session.socket = socket;
    session.socketId = socket.id;
    session.currentRunId = runId;
    session.cancelled = false;
    session.cancelNotified = false;
    emitToSession(session, socket, 'ide:thinking', { sessionId, runId, phase: 'compact' });

    try {
      sanitizeProviderMessageHistory(session.messages);
      repairDanglingToolUseMessages(session.messages);
      const split = splitMessagesForCompact(session.messages);
      if (split.all.length < COMPACT_MIN_MESSAGES) {
        emitToSession(session, socket, 'ide:text', {
          sessionId,
          runId,
          text: '当前会话还很短，不需要 compact。继续聊就好。',
        });
        emitToSession(session, socket, 'ide:done', { sessionId, runId, taskStatus: 'done' });
        return;
      }

      const providerConfig = resolveIdeProviderConfig();
      if (!providerConfig) {
        emitToSession(session, socket, 'ide:error', { sessionId, runId, error: 'AI Provider 未配置，无法执行 /compact。' });
        return;
      }

      const source = buildCompactSource(split.older);
      if (!source) {
        emitToSession(session, socket, 'ide:text', {
          sessionId,
          runId,
          text: '没有可压缩的旧上下文。最近消息会继续完整保留。',
        });
        emitToSession(session, socket, 'ide:done', { sessionId, runId, taskStatus: 'done' });
        return;
      }

      const summary = await requestCompactSummary({
        session,
        sessionId,
        runId,
        providerConfig,
        source,
        instruction: command.instruction,
        recentCount: split.recent.length,
      });
      throwIfStopped(session, runId);

      const compactedAt = new Date().toISOString();
      session.messages = [
        createCompactSummaryMessage(summary, {
          compactedAt,
          compactedCount: split.older.length,
          keptCount: split.recent.length,
        }),
        ...split.recent,
      ];
      sanitizeProviderMessageHistory(session.messages);
      repairDanglingToolUseMessages(session.messages);
      session.updatedAt = compactedAt;
      if (!session.firstUserMessage) session.firstUserMessage = deriveSessionTitle(session.messages);
      persistSessionSafe(sessionId, session, { modelLabel: providerConfig.model });

      emitToSession(session, socket, 'ide:compact', {
        sessionId,
        runId,
        compactedCount: split.older.length,
        keptCount: split.recent.length,
        summaryChars: summary.length,
        timeline: projectMessagesToTimeline(session.messages),
      });
      emitToSession(session, socket, 'ide:done', { sessionId, runId, taskStatus: 'done' });
    } catch (err) {
      if (isAbortError(err)) {
        emitCancelledOnce(session, sessionId, socket, runId);
      } else {
        logger?.warn?.(`[ide] compact failed: ${err.message}`);
        emitToSession(session, socket, 'ide:error', { sessionId, runId, error: err.message || 'compact 失败' });
      }
    } finally {
      if (session.currentRunId === runId) session.currentRunId = null;
    }
  }

  // ── persisted session history (/agent rail) ──
  // Headless MCP `ask` runs reuse handleMessage with an `mcp-ai-` session id and
  // are deleted immediately afterwards; they must never enter the history rail.
  function isPersistableSessionId(sessionId) {
    return Boolean(sessionId) && !String(sessionId).startsWith('mcp-ai-');
  }

  function isRuntimeInjectedUserText(text = '') {
    const trimmed = String(text || '').trimStart();
    return trimmed.startsWith('RUNTIME_EMPTY_MODEL_RESPONSE')
      || trimmed.startsWith('User input received for the interrupted run.')
      || isDetachedToolResultText(trimmed);
  }

  function sessionTextFromContent(content, options = {}) {
    const preserveWhitespace = options.preserveWhitespace === true;
    const stripLegacyPrefix = options.stripLegacyPrefix === true;
    if (typeof content === 'string') {
      const raw = stripLegacyPrefix ? stripLegacyInjectedUserPrefixes(content) : content;
      if (isCompactSummaryText(raw)) return raw;
      if (isRuntimeInjectedUserText(raw)) return '';
      return preserveWhitespace ? raw : raw.replace(/\s+/g, ' ').trim();
    }
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const blk of content) {
      if (typeof blk === 'string') {
        if (!isRuntimeInjectedUserText(blk)) parts.push(blk);
      } else if (blk && blk.type === 'text' && blk.text && !isRuntimeInjectedUserText(blk.text)) {
        parts.push(blk.text);
      }
    }
    const joined = parts.join('');
    const raw = stripLegacyPrefix ? stripLegacyInjectedUserPrefixes(joined) : joined;
    if (isCompactSummaryText(raw)) return raw;
    if (isRuntimeInjectedUserText(raw)) return '';
    return preserveWhitespace ? raw : raw.replace(/\s+/g, ' ').trim();
  }

  function stringifyToolResultContent(content) {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content.map((blk) => (typeof blk === 'string' ? blk : (blk?.text ?? JSON.stringify(blk))));
      return parts.join('\n');
    }
    return JSON.stringify(content);
  }

  function deriveSessionTitle(messages) {
    for (const msg of messages) {
      if (msg?.role !== 'user') continue;
      const text = sessionTextFromContent(msg.content);
      if (isCompactSummaryText(text)) continue;
      if (text) return text.slice(0, 60);
    }
    return '新对话';
  }

  function deriveSessionPreview(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = sessionTextFromContent(messages[i]?.content);
      if (text) return text.slice(0, 160);
    }
    return '';
  }

  function persistSessionSafe(sessionId, session, { modelLabel } = {}) {
    try {
      if (!ideSessionRepository?.upsertSession || !isPersistableSessionId(sessionId)) return;
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      if (messages.length === 0) return;
      session.updatedAt = new Date().toISOString();
      ideSessionRepository.upsertSession({
        id: sessionId,
        title: session.firstUserMessage ? session.firstUserMessage.slice(0, 60) : deriveSessionTitle(messages),
        entry: session.entry || 'core',
        hostId: session.hostId || '',
        workspaceHostIds: cleanWorkspaceHostIds(session.workspaceHostIds),
        modelLabel: modelLabel || '',
        messages,
        preview: deriveSessionPreview(messages),
      });
    } catch (err) {
      logger?.warn?.(`[ide] persist session failed: ${err.message}`);
    }
  }

  function restoreSessionMessages(sessionId) {
    try {
      if (!ideSessionRepository?.getSession || !isPersistableSessionId(sessionId)) return [];
      const record = ideSessionRepository.getSession(sessionId);
      if (record && Array.isArray(record.messages) && record.messages.length) return record.messages;
    } catch (err) {
      logger?.warn?.(`[ide] restore session failed: ${err.message}`);
    }
    return [];
  }

  // Project the stored model conversation into frontend timeline items so a
  // resumed session shows its tool calls, not just the final text.
  // 附件相关的服务注入文本块（摘要行 / 精确文本 <attachment> 包裹）只给模型看，
  // 时间线气泡里跳过 —— 附件在前端以缩略图/文件卡呈现（消息级 attachments 元数据）
  function isAttachmentServiceTextBlock(blk) {
    if (blk?.type !== 'text' || typeof blk.text !== 'string') return false;
    const text = blk.text.trimStart();
    return text.startsWith('用户随消息发送了以下附件：')
      || text.startsWith('<attachment ')
      || isRuntimeInjectedUserText(text);
  }

  function normalizeStoredAttachmentsMeta(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((att) => att && typeof att === 'object' && att.path)
      .map((att) => ({
        path: String(att.path),
        name: String(att.name || ''),
        mime: String(att.mime || ''),
        kind: String(att.kind || ''),
        size: Number(att.size) || 0,
      }));
  }

  function projectMessagesToTimeline(messages) {
    const items = [];
    const toolIndex = new Map();
    let seq = 0;
    const nextId = (prefix) => `${prefix}-${seq++}`;
    const pushTextItem = (kind, role, rawText) => {
      const text = sessionTextFromContent(String(rawText || ''), { preserveWhitespace: true });
      if (!text || !text.trim()) return;
      items.push({ id: nextId(kind), kind, role, text, status: role === 'assistant' ? 'done' : undefined });
    };
    for (const msg of (Array.isArray(messages) ? messages : [])) {
      const { role, content } = msg || {};
      if (role === 'user') {
        if (Array.isArray(content)) {
          for (const blk of content) {
            if (blk?.type !== 'tool_result') continue;
            const item = toolIndex.get(blk.tool_use_id);
            if (!item) continue;
            item.result = stringifyToolResultContent(blk.content);
            item.isError = Boolean(blk.is_error);
            item.status = blk.is_error ? 'error' : 'done';
          }
        }
        const displayContent = Array.isArray(content)
          ? content.filter((blk) => !isAttachmentServiceTextBlock(blk))
          : content;
        const text = sessionTextFromContent(displayContent, { preserveWhitespace: true, stripLegacyPrefix: true });
        const attachmentsMeta = normalizeStoredAttachmentsMeta(msg.attachments);
        if (text && isCompactSummaryText(text)) {
          items.push({ id: nextId('system'), kind: 'system', title: '/compact', text: compactSummaryTimelineText(text), tone: 'success' });
        } else if ((text && text.trim()) || attachmentsMeta.length) {
          const item = { id: nextId('user'), kind: 'user', role: 'user', text: text && text.trim() ? text : '' };
          if (attachmentsMeta.length) item.attachments = attachmentsMeta;
          items.push(item);
        }
      } else if (role === 'assistant') {
        const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
        let pendingText = '';
        const flushText = () => {
          if (!pendingText) return;
          pushTextItem('assistant', 'assistant', pendingText);
          pendingText = '';
        };
        for (const blk of blocks) {
          if (typeof blk === 'string') {
            pendingText += blk;
            continue;
          }
          if (blk?.type === 'text' && blk.text) {
            pendingText += blk.text;
            continue;
          }
          if (blk?.type !== 'tool_use') continue;
          flushText();
          const item = { id: `tool-${blk.id}`, kind: 'tool', toolUseId: blk.id, name: blk.name || 'unknown', status: 'done', startedAt: 0, input: blk.input, logs: [] };
          // 协议 agent 会话的 tool_use 块带 locations（文件↔会话关联）
          if (Array.isArray(blk.locations) && blk.locations.length) item.locations = blk.locations;
          items.push(item);
          toolIndex.set(blk.id, item);
        }
        flushText();
      }
    }
    return items;
  }

  function sessionRecordToMeta(record) {
    if (!record) return null;
    return {
      id: record.id,
      title: record.title || '',
      entry: record.entry || 'core',
      hostId: record.hostId || '',
      workspaceHostIds: cleanWorkspaceHostIds(record.workspaceHostIds),
      modelLabel: record.modelLabel || '',
      messageCount: record.messageCount || 0,
      preview: record.preview || '',
      agentId: record.agentId || 'oneshell',
      cwd: record.cwd || '',
      createdAt: record.createdAt || record.created_at || '',
      updatedAt: record.updatedAt || record.updated_at || '',
    };
  }

  function liveSessionMeta(sessionId, session, existing = null) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    if (!session?.currentRunId && messages.length === 0) return null;
    const createdAt = existing?.createdAt || session.createdAt || session.updatedAt || new Date().toISOString();
    const updatedAt = session.updatedAt || session.detachedAt || existing?.updatedAt || createdAt;
    return {
      id: sessionId,
      title: existing?.title || (session.firstUserMessage ? session.firstUserMessage.slice(0, 60) : deriveSessionTitle(messages)),
      entry: session.entry || existing?.entry || 'core',
      hostId: session.hostId || existing?.hostId || '',
      workspaceHostIds: Array.isArray(session.workspaceHostIds)
        ? cleanWorkspaceHostIds(session.workspaceHostIds)
        : cleanWorkspaceHostIds(existing?.workspaceHostIds),
      modelLabel: existing?.modelLabel || '',
      messageCount: messages.length || existing?.messageCount || 0,
      preview: deriveSessionPreview(messages) || existing?.preview || '',
      agentId: existing?.agentId || 'oneshell',
      cwd: existing?.cwd || '',
      createdAt,
      updatedAt,
      running: Boolean(session.currentRunId && !session.cancelled),
      awaitingApproval: Boolean(session.awaitingApproval),
    };
  }

  function listSessions(opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
    const keyword = String(opts.keyword || '').trim().toLowerCase();
    const rows = new Map();

    if (ideSessionRepository?.listSessions) {
      const stored = ideSessionRepository.listSessions({ limit: 500, offset: 0 })?.sessions || [];
      for (const row of stored) {
        const meta = sessionRecordToMeta(row);
        if (meta?.id) rows.set(meta.id, meta);
      }
    }

    for (const [sessionId, session] of sessions) {
      if (!isPersistableSessionId(sessionId)) continue;
      const meta = liveSessionMeta(sessionId, session, rows.get(sessionId));
      if (meta?.id) rows.set(meta.id, meta);
    }

    let list = [...rows.values()];
    if (keyword) {
      list = list.filter((row) => `${row.title || ''} ${row.preview || ''}`.toLowerCase().includes(keyword));
    }
    list.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
    return { sessions: list.slice(offset, offset + limit), total: list.length };
  }

  function getSessionDetail(id) {
    const record = ideSessionRepository?.getSession?.(id);
    const live = sessions.get(id);
    if (live && (live.currentRunId || (Array.isArray(live.messages) && live.messages.length))) {
      const meta = liveSessionMeta(id, live, sessionRecordToMeta(record));
      return {
        ...meta,
        files: Array.isArray(record?.files) ? record.files : [],
        timeline: projectMessagesToTimeline(live.messages),
      };
    }
    if (!record) return null;
    return {
      id: record.id,
      title: record.title,
      entry: record.entry,
      hostId: record.hostId,
      workspaceHostIds: cleanWorkspaceHostIds(record.workspaceHostIds),
      modelLabel: record.modelLabel,
      messageCount: record.messageCount,
      agentId: record.agentId || 'oneshell',
      cwd: record.cwd || '',
      settings: record.agentSettings && typeof record.agentSettings === 'object' ? record.agentSettings : {},
      files: Array.isArray(record.files) ? record.files : [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      timeline: projectMessagesToTimeline(record.messages),
    };
  }

  function renameSessionRecord(id, title) {
    return ideSessionRepository?.renameSession ? ideSessionRepository.renameSession(id, title) : false;
  }

  function copySessionRecord(id) {
    if (!ideSessionRepository?.upsertSession) return null;
    const live = sessions.get(id);
    if (live?.currentRunId && !live.cancelled) return null;
    const record = ideSessionRepository?.getSession?.(id);
    const source = live && Array.isArray(live.messages) && live.messages.length
      ? {
          ...record,
          id,
          title: record?.title || live.firstUserMessage?.slice(0, 60) || deriveSessionTitle(live.messages),
          entry: live.entry || record?.entry || 'core',
          hostId: live.hostId || record?.hostId || '',
          workspaceHostIds: cleanWorkspaceHostIds(live.workspaceHostIds || record?.workspaceHostIds),
          modelLabel: record?.modelLabel || '',
          messages: live.messages,
          preview: deriveSessionPreview(live.messages) || record?.preview || '',
        }
      : record;
    if (!source?.id) return null;
    const newId = `agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const messages = Array.isArray(source.messages) ? JSON.parse(JSON.stringify(source.messages)) : [];
    const copied = ideSessionRepository.upsertSession({
      id: newId,
      title: `${String(source.title || '新对话').slice(0, 180)}-copy`,
      entry: source.entry || 'core',
      hostId: source.hostId || '',
      workspaceHostIds: cleanWorkspaceHostIds(source.workspaceHostIds || (source.hostId ? [source.hostId] : [])),
      modelLabel: source.modelLabel || '',
      messageCount: messages.length,
      messages,
      preview: source.preview || deriveSessionPreview(messages),
    });
    return copied ? sessionRecordToMeta(copied) : null;
  }

  function removeSessionRecord(id) {
    deleteSession(id); // cancel + drop any in-memory session
    return ideSessionRepository?.deleteSession ? ideSessionRepository.deleteSession(id) : false;
  }

  // 主机删除联动（4.7.5）：清掉绑定在已删除主机上的会话。
  // isValidHostId 返回 false 的绑定视为已删除主机；剔空的 oneshell 会话连
  // 内存副本一起删（协议 agent 会话跑在本机，repository 层只解绑不删）。
  function pruneSessionsForHosts(isValidHostId) {
    if (typeof ideSessionRepository?.pruneHostBindings !== 'function') return { deletedIds: [], updated: 0 };
    const result = ideSessionRepository.pruneHostBindings(isValidHostId);
    for (const id of result.deletedIds) {
      deleteSession(id); // 取消运行中的回合并丢弃内存副本，防止下次落盘复活
    }
    // 活会话内存里的绑定同步剔除，避免下次 persist 把已删主机写回去
    for (const [, session] of sessions) {
      const ids = cleanWorkspaceHostIds(session?.workspaceHostIds);
      if (!ids.length) continue;
      const remaining = ids.filter((id) => isValidHostId(id));
      if (remaining.length === ids.length) continue;
      session.workspaceHostIds = remaining;
      if (session.hostId && !isValidHostId(session.hostId)) {
        session.hostId = remaining.length ? hostIdForWorkspace(remaining) : '';
      }
    }
    return result;
  }

  // DELETE /api/hosts/:id 用：删除单台主机时级联清理其对话
  function removeSessionsForHost(hostId) {
    const target = String(hostId || '').trim();
    if (!target || target === 'local') return { deletedIds: [], updated: 0 };
    return pruneSessionsForHosts((id) => id !== target);
  }

  // 文件反查会话（IDE 壳）：哪些会话触碰过该文件
  function findSessionsByFile(filePath) {
    return ideSessionRepository?.findSessionsByFile ? ideSessionRepository.findSessionsByFile(filePath) : [];
  }

  // 会话交给协议 agent 前让出 live 状态：先落盘最新消息（协议侧从 repo 重
  // 水化），再丢弃内存副本——否则切回来时 getOrCreateSession 命中的是缺了
  // 协议轮次的旧缓存，历史会分叉。socket 路由在双向切换时调用。
  function releaseLiveSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { ok: true, live: false };
    if (session.currentRunId && !session.cancelled) {
      return { ok: false, error: '当前回合仍在运行，请先停止后再切换 agent' };
    }
    persistSessionSafe(sessionId, session, { modelLabel: '' });
    sessionIdleKeeper.clear(session);
    sessions.delete(sessionId);
    return { ok: true, live: true };
  }

  async function handleMessage({ socket, sessionId, message, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry, approvalMode, attachments = [] }) {
    if (!agentRuntime?.startRun || !agentRuntime?.getState) {
      emitToSession(null, socket, 'ide:error', { sessionId, error: 'Agent runtime 未初始化，1Shell AI 已停止旧聊天降级路径。' });
      return;
    }

    const effectiveEntry = normalizePromptEntry(entry, context, message);
    const contextApprovalMode = context && typeof context === 'object' && !Array.isArray(context) ? (context.approvalMode || context.approval_mode) : null;
    const effectiveApprovalMode = normalizeIdeApprovalMode(approvalMode || contextApprovalMode, { entry: effectiveEntry });
    const session = getOrCreateSession(sessionId, context, effectiveEntry, effectiveApprovalMode);
    sessionIdleKeeper.touch(session);
    ensureSessionCancellation(session);
    if (session.currentRunId && !session.cancelled) {
      cancelSession(sessionId, 'superseded by new user message');
      ensureSessionCancellation(session);
    }
    const runId = newRunId();
    session.currentRunId = runId;
    session.cancelled = false;
    session.cancelNotified = false;
    session.sessionId = sessionId;
    session.socket = socket;
    session.socketId = socket.id;
    session.detachedAt = null;
    session.detachReason = '';

    const ignoredLegacyFlags = {
      safeMode: safeMode === undefined ? undefined : safeMode !== false,
      unlimitedTurns: unlimitedTurns === undefined ? undefined : !!unlimitedTurns,
    };
    if (claudeCodeEnabled !== undefined) {
      session.claudeCodeEnabled = !!claudeCodeEnabled;
    }

    const rewindCommand = parseRewindCommand(message);
    if (rewindCommand) {
      await handleRewindCommand({ socket, sessionId, session, command: rewindCommand });
      return;
    }

    const compactCommand = parseCompactCommand(message);
    if (compactCommand) {
      await handleCompactCommand({ socket, sessionId, session, command: compactCommand });
      return;
    }

    const agentGoalProfile = createIdeAgentGoalProfile({ message, context, entry: session.entry });
    session.agentGoalProfile = agentGoalProfile;
    session.finalizationRepairRounds = 0;
    const activeSkillContext = resolveSessionSkillContext({ message, context, entry: session.entry });
    session.activeSkillContext = activeSkillContext;
    const runContext = {
      ...(context && typeof context === 'object' && !Array.isArray(context) ? context : {}),
      activeSkills: activeSkillContext.skills,
    };

    const { allTools, mcpToolMap } = buildIdeToolCatalog(session);
    const agentState = startIdeAgentRun({
      session,
      sessionId,
      runId,
      message,
      context: runContext,
      entry: session.entry,
      approvalMode: session.approvalMode,
      tools: allTools,
      claudeCodeEnabled: session.claudeCodeEnabled,
      goalProfile: agentGoalProfile,
      legacyFlags: ignoredLegacyFlags,
    });
    recordActiveSkills(runId, sessionId, session, activeSkillContext);
    const agentPolicy = agentState?.spec?.policy || session.agentPolicy || createIdeAgentPolicy({ tools: allTools, entry: session.entry, approvalMode: session.approvalMode, remotePolicy: session.toolPolicy, goalProfile: agentGoalProfile });
    const agentTools = filterToolsForAgent(allTools, agentPolicy);

    sanitizeProviderMessageHistory(session.messages);
    repairDanglingToolUseMessages(session.messages);

    if (!(session.exactTextAttachments instanceof Map)) session.exactTextAttachments = new Map();
    const userContent = buildAgentUserContent({ message, attachments, exactTextRegistry: session.exactTextAttachments });

    // 附件落盘（图床式回显）：base64 仍随消息进模型（1Shell AI 走多模态 block），
    // 同时写一份到 dataDir/agent-attachments/<sessionId>/，落盘元数据挂在消息
    // 记录上 —— 前端经 /api/files/download 显示缩略图，刷新后依然可见
    const { stored: storedAttachments, skipped: skippedAttachments } = materializeAttachments({
      attachments,
      dir: dataDir ? path.join(dataDir, 'agent-attachments', safeSessionDirName(sessionId)) : '',
      logger,
    });

    const userMessageEntry = { role: 'user', content: userContent };
    if (storedAttachments.length) userMessageEntry.attachments = storedAttachments;
    session.messages.push(userMessageEntry);
    if (!session.firstUserMessage) session.firstUserMessage = String(message || '').trim();
    session.updatedAt = new Date().toISOString();
    persistSessionSafe(sessionId, session, { modelLabel: '' });
    createUserRewindCheckpoint(session, message);
    recordTraceEvent('instruction', 'instruction_received', {
      source: 'ide',
      runId,
      sessionId,
      hostId: session.hostId,
      toolName: 'ide_message',
      summary: redactPotentialSecrets(String(message || '')).substring(0, 1000),
    });

    const providerConfig = resolveIdeProviderConfig();
    if (!providerConfig) {
      emitToSession(session, socket, 'ide:error', { sessionId, runId, error: 'AI Provider 未配置。请先在"AI 配置"页添加 Provider。' });
      endIdeAgentRun(runId, { runnerStatus: 'failed', taskStatus: 'blocked', error: 'AI Provider 未配置' });
      return;
    }

    const { model, proxyUrl } = providerConfig;

    emitToSession(session, socket, 'ide:thinking', { sessionId, runId });
    if (storedAttachments.length || skippedAttachments.length) {
      emitToSession(session, socket, 'ide:attachments', { sessionId, runId, attachments: storedAttachments, skipped: skippedAttachments });
    }

    const safeAuditMessage = redactPotentialSecrets(String(message || '')).substring(0, 500);
    auditService?.log?.({ action: 'ide_message', source: 'ide', command: safeAuditMessage, details: JSON.stringify({ sessionId }) });

    logger?.debug?.(`[ide] Agent tool catalog exposed (${agentTools.length}/${allTools.length} allowed by policy)`);

    const MAX_TOOL_ROUNDS = resolveNullablePositiveInteger(agentPolicy.maxTurns) || 128;

    const modelAdapter = createIdeStreamingModelAdapter({ socket, sessionId, runId, session, model, proxyUrl, agentTools, context });
    const dispatchOptionsForAction = createIdeRuntimeDispatchOptions({ socket, sessionId, runId, session, mcpToolMap });

    try {
      let observations = [];
      let lastResult = null;
      let emptyModelResponseRetries = 0;
      let round = 0;
      for (; round < MAX_TOOL_ROUNDS; round++) {
        throwIfStopped(session, runId);
        recordIdeAgentTurn(runId, round + 1, { status: 'running', stage: observations.length > 0 ? 'observe' : 'decide' });
        lastResult = await modelAdapter({ runId, turn: round + 1, observations });
        const toolCalls = Array.isArray(lastResult?.toolCalls) ? lastResult.toolCalls : [];
        if (toolCalls.length === 0) {
          if (isEmptyModelResult(lastResult)) {
            emptyModelResponseRetries += 1;
            recordTraceEvent('provider', 'empty_model_response', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `provider returned empty assistant response (${emptyModelResponseRetries}/${EMPTY_MODEL_RESPONSE_RETRY_LIMIT})`,
              data: { round: round + 1, retry: emptyModelResponseRetries, entry: session.entry },
            });
            if (emptyModelResponseRetries <= EMPTY_MODEL_RESPONSE_RETRY_LIMIT) {
              observations = [createEmptyModelResponseObservation({ attempt: emptyModelResponseRetries })];
              continue;
            }
            throw new Error('Cannot continue IDE agent run: provider returned empty assistant responses repeatedly.');
          }
          break; // model produced a visible final answer
        }
        emptyModelResponseRetries = 0;
        observations = [];
        for (const tc of toolCalls) {
          throwIfStopped(session, runId);
          const extra = dispatchOptionsForAction({ action: { id: tc.id, toolName: tc.toolName, args: tc.args, options: {} } });
          const dispatched = await agentRuntime.dispatchTool(runId, tc.toolName, tc.args || {}, extra);
          observations.push(normalizeIdeToolObservation(tc, dispatched));
        }
      }

      const finalResult = buildIdeFinalResult(runId, [lastResult?.text || lastResult?.report || lastResult?.content || ''], {
        sessionId,
        round,
        entry: session.entry,
      });
      if (isRunCurrent(session, runId)) {
        emitToSession(session, socket, 'ide:done', { sessionId, runId, round, taskStatus: finalResult.taskStatus || 'unverified' });
      }
      recordIdeAgentPhase(runId, 'result', `Final outcome: ${finalResult.taskStatus || 'unverified'}`, { status: 'done', evidence: finalResult.data?.outcomeReasons || [] });
      endIdeAgentRun(runId, { runnerStatus: 'completed', taskStatus: finalResult.taskStatus || 'unverified', result: finalResult });
      return;
    } catch (err) {
      if (isAbortError(err)) {
        recordTraceEvent('runtime', 'run_aborted', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: 'agent_run',
          summary: err.message || 'agent run aborted',
          data: { cancelled: !!session.cancelled, code: err.code || '', name: err.name || '' },
        });
        if (session.currentRunId === runId) emitCancelledOnce(session, sessionId, socket);
        cancelIdeAgentRun(runId, err.message || 'cancelled');
        return;
      }
      logger?.error?.('IDE agent loop failed', { sessionId, error: err.message });
      recordTraceEvent('runtime', 'run_failed', {
        source: 'ide',
        runId,
        sessionId,
        hostId: session.hostId,
        toolName: 'agent_run',
        summary: err.message || 'agent run failed',
        data: { name: err.name || '', stack: String(err.stack || '').slice(0, 2000) },
      });
      if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:error', { sessionId, runId, error: err.message });
      endIdeAgentRun(runId, { runnerStatus: 'failed', taskStatus: 'failed', error: err.message });
      return;
    } finally {
      persistSessionSafe(sessionId, session, { modelLabel: model });
      sessionIdleKeeper.touch(session);
    }

  }

  async function ask({ message, context = null, safeMode = undefined, claudeCodeEnabled = false, unlimitedTurns = undefined, entry = 'core', approvalMode = null, timeoutMs = 300000, approvalAction = 'deny', sessionId: requestedSessionId = '', detached = false } = {}) {
    const text = String(message || '').trim();
    if (!text) throw new Error('message 为空');
    const requestedId = String(requestedSessionId || '').trim();
    const sessionId = requestedId || `mcp-ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const socket = new EventEmitter();
    socket.id = sessionId;
    const events = [];
    const toolCalls = [];
    const maxEvents = 100;
    const maxOutputChars = 200000;
    let output = '';
    let outputTruncated = false;
    let sawDelta = false;
    let error = null;
    const truncateOutput = (value) => {
      const textValue = String(value || '');
      if (textValue.length <= maxOutputChars) return { text: textValue, truncated: false };
      return {
        text: `${textValue.slice(0, maxOutputChars)}\n...(1Shell AI 输出已截断)`,
        truncated: true,
      };
    };
    const replaceOutput = (value) => {
      const next = truncateOutput(value);
      output = next.text;
      outputTruncated = next.truncated;
    };
    const appendOutput = (value) => {
      if (outputTruncated) return;
      const { text: textValue } = truncateOutput(value);
      const remaining = maxOutputChars - output.length;
      if (textValue.length <= remaining) {
        output += textValue;
        return;
      }
      output += textValue.slice(0, Math.max(0, remaining));
      output += '\n...(1Shell AI 输出已截断)';
      outputTruncated = true;
    };
    const redactInput = (value) => {
      try {
        return JSON.parse(JSON.stringify(redactPotentialSecrets(value || {}), (key, item) => {
          if (/token|key|secret|password|auth|credential|content|base64|sensitive|redact/i.test(key)) return '<redacted>';
          if (typeof item === 'string' && item.length > 500) return `${item.slice(0, 500)}…`;
          return item;
        }));
      } catch { return {}; }
    };
    const summarizeEventPayload = (payload = {}) => {
      const summary = { ...payload };
      if (summary.delta) summary.delta = redactCredentialPatterns(String(summary.delta)).slice(0, 200);
      if (summary.text) summary.text = redactCredentialPatterns(String(summary.text)).slice(0, 200);
      if (summary.result) summary.result = redactCredentialPatterns(String(summary.result)).slice(0, 500);
      if (summary.input) summary.input = redactInput(summary.input);
      return summary;
    };
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event, payload = {}) => {
      if (events.length < maxEvents) events.push({ event, payload: summarizeEventPayload(payload) });
      if (event === 'ide:text-delta' && (payload.delta || typeof payload.text === 'string')) {
        sawDelta = true;
        if (typeof payload.text === 'string') replaceOutput(payload.text);
        else appendOutput(payload.delta);
      }
      if (event === 'ide:text-replace' && typeof payload.text === 'string') {
        sawDelta = true;
        replaceOutput(payload.text);
      }
      if (event === 'ide:text' && typeof payload.text === 'string') {
        if (sawDelta) replaceOutput(payload.text);
        else appendOutput(payload.text);
      }
      if (event === 'ide:tool-start') {
        toolCalls.push({ name: payload.name, input: redactInput(payload.input || {}) });
      }
      if (event === 'ide:error') {
        error = String(payload.error || '1Shell AI 执行失败');
      }
      if (event === 'ide:approve-request') {
        setImmediate(() => originalEmit('ide:approve-response', { requestId: payload.requestId, action: approvalAction }));
      }
      if (event === 'ide:ask-user') {
        setImmediate(() => originalEmit('ide:ask-user-response', { requestId: payload.requestId, action: 'deny', reason: 'headless_no_user_input' }));
      }
      if (event === 'ide:secret-request') {
        setImmediate(() => originalEmit('ide:secret-response', { requestId: payload.requestId, action: 'deny', reason: 'headless_no_secret_input' }));
      }
      return originalEmit(event, payload);
    };

    const timeoutMax = detached ? HEADLESS_DETACHED_ASK_MAX_TIMEOUT_MS : HEADLESS_SYNC_ASK_MAX_TIMEOUT_MS;
    const timeoutFallback = detached ? HEADLESS_DETACHED_ASK_DEFAULT_TIMEOUT_MS : 300000;
    const timeout = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), timeoutMax) : Math.min(timeoutFallback, timeoutMax);
    let timer = null;
    try {
      await Promise.race([
        handleMessage({ socket, sessionId, message: text, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry, approvalMode }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            cancelSession(sessionId, `headless timeout (${timeout}ms)`);
            reject(new Error(`1Shell AI 超时 (${timeout}ms)`));
          }, timeout);
        }),
      ]);
      if (error) throw new Error(error);
      return { sessionId, text: output.trim(), events, toolCalls };
    } finally {
      if (timer) clearTimeout(timer);
      sessions.delete(sessionId);
    }
  }

  function cancelSession(sessionId, reason = 'cancelled by user') {
    const session = sessions.get(sessionId);
    if (!session) return false;
    ensureSessionCancellation(session);
    const runId = session.currentRunId;
    recordTraceEvent('runtime', 'session_cancelled', {
      source: 'ide',
      runId,
      sessionId,
      hostId: session.hostId,
      toolName: 'session',
      summary: reason,
    });
    session.cancelled = true;
    if (session.abortController) {
      try { session.abortController.abort(); } catch { /* ignore */ }
      session.abortController = null;
    }
    for (const handler of [...session.cancelHandlers]) {
      try { handler(); } catch { /* ignore */ }
    }
    session.cancelHandlers.clear();
    if (session.activeChildProcess) {
      try { session.activeChildProcess.kill(); } catch { /* ignore */ }
      session.activeChildProcess = null;
    }
    cancelIdeAgentRun(runId, reason);
    if (session.currentRunId === runId) session.currentRunId = null;
    emitCancelledOnce(session, sessionId, session.socket, runId);
    return true;
  }

  function deleteSession(sessionId) {
    cancelSession(sessionId, 'session deleted');
    const session = sessions.get(sessionId);
    if (session) sessionIdleKeeper.clear(session);
    sessions.delete(sessionId);
  }

  function cancelSessionsForSocket(socketId) {
    return detachSessionsForSocket(socketId, 'socket_disconnect_legacy_cancel_hook');
  }

  function detachSessionsForSocket(socketId, reason = 'socket_disconnect') {
    let detached = 0;
    for (const [sessionId, session] of sessions) {
      if (session.socketId !== socketId) continue;
      session.socket = null;
      session.socketId = null;
      session.detachedAt = new Date().toISOString();
      session.detachReason = reason;
      detached += 1;
      recordTraceEvent('runtime', 'session_detached', {
        source: 'ide',
        runId: session.currentRunId,
        sessionId,
        hostId: session.hostId,
        toolName: 'session',
        summary: reason,
      });
    }
    return detached;
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  function setSafeMode(_sessionId, _enabled) {
    return false;
  }

  function getSafeMode(_sessionId) {
    return false;
  }

  function setUnlimitedTurns(_sessionId, _enabled) {
    return false;
  }

  function setClaudeCodeEnabled(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.claudeCodeEnabled = enabled;
  }

  function recordAuthoringUserReply(_sessionId, _input) {
    return { ok: false, error: 'authoring 流程已废弃' };
  }

  function reattachSession(sessionId, socket) {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session 不存在' };
    session.socket = socket;
    session.socketId = socket.id;
    session.detachedAt = null;
    session.detachReason = '';
    sessionIdleKeeper.touch(session);
    recordTraceEvent('runtime', 'session_reattached', {
      source: 'ide',
      runId: session.currentRunId,
      sessionId,
      hostId: session.hostId,
      toolName: 'session',
      summary: `socket=${socket.id || ''}`,
    });
    if (session.currentRunId && !session.cancelled) {
      emitIdeEvent(socket, 'ide:thinking', { sessionId, runId: session.currentRunId });
    }
    return { ok: true, running: !!session.currentRunId && !session.cancelled, runId: session.currentRunId };
  }

  return { handleMessage, ask, cancelSession, cancelSessionsForSocket, detachSessionsForSocket, deleteSession, hasSession, setSafeMode, getSafeMode, setUnlimitedTurns, setClaudeCodeEnabled, recordAuthoringUserReply, reattachSession, listRewindPoints, listSessions, getSessionDetail, renameSessionRecord, copySessionRecord, removeSessionRecord, removeSessionsForHost, pruneSessionsForHosts, findSessionsByFile, releaseLiveSession };
}

module.exports = {
  createIdeService,
  __private: {
    AGENT_ATTACHMENT_MAX_TEXT_BYTES,
    applyRewindSnapshotBudget,
    assistantTraceSummary,
    buildAgentUserContent,
    compactToolResultForModel,
    createSessionIdleKeeper,
    expandExactTextReferences,
    normalizeAgentAttachments,
    projectMessagesForModelApi,
    rewindRecordSnapshotBytes,
    streamAnthropicSSE,
    TOOL_RESULT_MAX_CHARS,
  },
};

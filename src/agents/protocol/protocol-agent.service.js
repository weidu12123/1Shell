'use strict';

// 协议 agent 会话管理器：把第三方 agent（claude stream-json / ACP）的归一化
// 事件翻译成与 1Shell AI 完全相同的 ide:* 事件形状，前端时间线零改动复用。
//
// 职责：
//   - 会话生命周期：创建 / 继续（--resume、session/load）/ 停止 / detach / reattach
//   - 事件翻译：适配器归一化事件 → emitIdeEvent（legacy + 统一 ide:event 双发）
//   - 权限请求挂起/应答：ide:approve-request ↔ ide:approve-response（ask 模式；
//     默认 auto = 完全放行，codex 侧同时以 approval=never + 全量沙箱启动）
//   - 会话内多 agent：每条消息可换 agentId，各 agent 绑定各自原生会话，切换时
//     以会话日志（<dataDir>/agent-session-logs/<id>.log）提示新 agent 自行补课
//   - 目标 VPS：workspaceHostIds 变更时把主机清单注入 prompt，操作走 1Shell MCP
//   - 会话持久化：ide_sessions 表（agent_id / cwd / native_session_id + bindings/settings）
//
// 与 ide.service.js（1Shell AI）的分工见 docs/oneshell-4.7-protocol-agent-ide-plan.md。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { emitIdeEvent } = require('../../ide/ide.events');
const { createAcpClient } = require('./acp-client');
const { createClaudeStreamAgent } = require('./claude-stream-adapter');
const { createCodexAppServerAgent } = require('./codex-adapter');
const { normalizeLocations } = require('./tool-locations');
const { materializeAttachments, buildAttachmentHint } = require('./attachment-store');
const { redactCredentialPatterns, redactPotentialSecrets } = require('../../../lib/secret-redaction');

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_FILES_MAX = 200;
// agent 切换补课：提示新 agent 读会话日志的行数上限（mindfs 同思路，
// 每条消息一行，读最近的即可，更早的历史由 agent 自行决定是否继续读）
const SWITCH_LOG_TAIL_LINES = 80;
const LOG_LINE_MAX_CHARS = 400;

const ONESHELL_AGENT_ID = 'oneshell';

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

// 协议会话运行设置：思考程度、codex fast 档。审批模式固定 auto（完全放行，
// mindfs 同款）——「每次询问」已下线：真实 CLI 上审批卡链路不可靠（agent 的
// MCP 工具调用会被拒导致任务中断），第三方 agent 仅以完全访问权限接入；
// requestApproval 机制保留，作为 ACP/codex/claude 权限请求的自动放行桥。
function normalizeSettings(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const effort = String(raw.effort || '').trim().toLowerCase();
  return {
    approvalMode: 'auto',
    effort: CLAUDE_EFFORTS.has(effort) || CODEX_EFFORTS.has(effort) ? effort : '',
    fast: raw.fast === true,
  };
}

function normalizeWorkspaceHostIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== 'all' && item !== '*'))];
}

function normalizeTargetHosts(hosts, workspaceHostIds) {
  const allowed = new Set(workspaceHostIds);
  const list = Array.isArray(hosts) ? hosts : [];
  return list
    .map((h) => ({ id: String(h?.id || '').trim(), name: String(h?.name || '').trim(), host: String(h?.host || '').trim() }))
    .filter((h) => h.id && allowed.has(h.id));
}

function createProtocolAgentService({ catalog, ideSessionRepository, dataDir = '', logger = console } = {}) {
  const sessions = new Map(); // sessionId -> session
  const approvals = new Map(); // requestId -> { session, finish }
  const sessionLogDir = dataDir ? path.join(dataDir, 'agent-session-logs') : '';

  // ── 会话状态 ─────────────────────────────────────────────────────

  function getOrCreateSession(sessionId, { agentId, cwd }) {
    let session = sessions.get(sessionId);
    if (session) return session;

    const record = ideSessionRepository?.getSession?.(sessionId) || null;
    const recordAgentId = record?.agentId && record.agentId !== ONESHELL_AGENT_ID ? record.agentId : '';
    session = {
      sessionId,
      agentId: recordAgentId || agentId || '',
      cwd: record?.cwd || cwd || '',
      nativeSessionId: record?.nativeSessionId || '',
      // agentId → { nativeSessionId, ctxSeq }：会话内多 agent 各自的原生会话
      // 与已见上下文水位（ctxSeq = 该 agent 最近一次收口时的 messages 长度）
      agentBindings: record?.agentBindings && typeof record.agentBindings === 'object' ? { ...record.agentBindings } : {},
      // 领养 1Shell AI 会话（记录归属还是 oneshell 但已有历史）：首条消息
      // 前注入补课提示，让新 agent 读会话日志恢复上下文
      handoffFromOneshell: Boolean(!recordAgentId && Array.isArray(record?.messages) && record.messages.length > 0),
      settings: normalizeSettings(record?.agentSettings),
      workspaceHostIds: normalizeWorkspaceHostIds(record?.workspaceHostIds),
      targetHosts: [], // [{id,name,host}] 最近一次消息带来的目标主机信息
      lastTargetsKey: '', // 已注入过目标提示的 targets 指纹（进程内）
      clientEffort: '', // claude 进程 spawn 时的 effort（变更需重建进程）
      messages: Array.isArray(record?.messages) ? [...record.messages] : [],
      files: Array.isArray(record?.files) ? [...record.files] : [],
      firstUserMessage: record?.title || '',
      client: null,
      protocol: '',
      acpReady: null, // Promise：ACP initialize + session/new|load 完成
      loading: false, // session/load 历史重放屏蔽窗口
      socket: null,
      socketId: null,
      detachedAt: null,
      detachReason: '',
      currentRunId: null,
      cancelled: false,
      turn: null, // { runId, textBuffer, blocks, openTools: Map }
      idleTimer: null,
    };
    sessions.set(sessionId, session);
    return session;
  }

  function emitToSession(session, event, payload) {
    const target = session?.socket;
    if (!target) return;
    try { emitIdeEvent(target, event, payload); } catch { /* ignore */ }
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function touchIdle(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!sessions.has(session.sessionId)) return; // 已删除的会话不再续期
    session.idleTimer = setTimeout(() => {
      if (session.turn || session.currentRunId) {
        touchIdle(session);
        return;
      }
      logger.info?.(`[protocol-agent] 会话 ${session.sessionId} 空闲回收（进程退出，可 resume）`);
      destroySession(session, { keepRecord: true });
    }, IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  }

  function destroySession(session, { keepRecord = true } = {}) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    rejectPendingApprovals(session, 'session_closed');
    try { session.client?.kill?.(); } catch { /* ignore */ }
    session.client = null;
    sessions.delete(session.sessionId);
    if (!keepRecord) {
      try { ideSessionRepository?.deleteSession?.(session.sessionId); } catch { /* ignore */ }
      const logPath = sessionLogPath(session);
      if (logPath) { try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ } }
    }
  }

  // ── 持久化 ───────────────────────────────────────────────────────

  function previewFromMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i]?.content;
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
      for (const block of blocks) {
        if (block?.type === 'text' && String(block.text || '').trim()) {
          return String(block.text).replace(/\s+/g, ' ').trim().slice(0, 160);
        }
      }
    }
    return '';
  }

  function persistSession(session, { agentIdOverride = '' } = {}) {
    try {
      if (!ideSessionRepository?.upsertSession || session.messages.length === 0) return;
      const spec = catalog?.getAgent?.(session.agentId);
      // entry / hostId 不传：repo 回退到既有行，避免把 1Shell AI 会话的
      // 主机绑定 / 入口洗掉（会话可在 oneshell 与协议 agent 间来回切换）
      ideSessionRepository.upsertSession({
        id: session.sessionId,
        title: String(session.firstUserMessage || '').slice(0, 60) || spec?.name || session.agentId,
        workspaceHostIds: session.workspaceHostIds,
        modelLabel: spec?.name || session.agentId,
        messages: session.messages,
        preview: previewFromMessages(session.messages),
        agentId: agentIdOverride || session.agentId,
        cwd: session.cwd,
        nativeSessionId: agentIdOverride === ONESHELL_AGENT_ID ? '' : (session.nativeSessionId || ''),
        files: session.files,
        agentBindings: session.agentBindings,
        agentSettings: session.settings,
      });
    } catch (err) {
      logger.warn?.(`[protocol-agent] 会话持久化失败: ${err.message}`);
    }
    writeSessionLog(session);
  }

  // ── 会话日志（agent 切换补课用）────────────────────────────────
  // 每条消息一行的纯文本记录。切换 agent 时不重放历史，而是提示新 agent 用
  // 自己的文件工具读日志末尾补上下文（mindfs 的做法，token 成本由 agent 自控）。

  function flattenMessageLine(message, index) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content || '') }];
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text' && String(block.text || '').trim()) {
        parts.push(String(block.text).replace(/\s+/g, ' ').trim());
      } else if (block?.type === 'tool_use') {
        parts.push(`[工具] ${block.name || 'tool'} ${JSON.stringify(block.input ?? {}).slice(0, 160)}`);
      } else if (block?.type === 'tool_result') {
        const text = String(block.content || '').replace(/\s+/g, ' ').trim();
        if (text) parts.push(`[工具结果] ${text.slice(0, 160)}`);
      }
    }
    const text = redactCredentialPatterns(parts.join(' | ')).slice(0, LOG_LINE_MAX_CHARS);
    return `#${index + 1} ${role}: ${text || '(空)'}`;
  }

  function sessionLogPath(session) {
    return sessionLogDir ? path.join(sessionLogDir, `${session.sessionId}.log`) : '';
  }

  function writeSessionLog(session) {
    const logPath = sessionLogPath(session);
    if (!logPath) return;
    try {
      fs.mkdirSync(sessionLogDir, { recursive: true });
      const lines = session.messages.map((message, index) => flattenMessageLine(message, index));
      fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
    } catch (err) {
      logger.warn?.(`[protocol-agent] 会话日志写入失败: ${err.message}`);
    }
  }

  function buildSwitchHint(session, previousCtxSeq) {
    const logPath = sessionLogPath(session);
    if (!logPath || session.messages.length === 0) return '';
    const delta = session.messages.length - Math.max(previousCtxSeq, 0);
    if (delta <= 0) return '';
    const lines = Math.min(delta, SWITCH_LOG_TAIL_LINES);
    return [
      '[会话交接] 本会话此前由其他 agent 处理，你的上下文可能落后于当前会话。',
      `回答前请先用你自带的本地文件读取工具（该文件在本机磁盘上，不要用 1Shell MCP 的远程文件工具）查看会话记录 ${logPath} 的最后 ${lines} 行恢复上下文；若仍不足，可自行往前分批多读（每批不超过 ${SWITCH_LOG_TAIL_LINES} 行）。`,
      '执行顺序：先读历史，再回答；读取失败时简要说明后停止。',
    ].join('\n');
  }

  // ── 目标 VPS 注入 ───────────────────────────────────────────────
  // 协议 agent 通过 1Shell 的 MCP 工具（list_hosts / host_exec / 文件读写等）
  // 操作 VPS。这里只负责把用户选择的目标主机告知 agent，权限由 MCP 侧管。
  // 「local」不算目标：协议 agent 的 CLI 本来就在本机跑（oneshell 会话默认
  // hostId=local，领养时不该为此注入提示）。

  function protocolTargetIds(session) {
    return session.workspaceHostIds.filter((id) => id !== 'local');
  }

  function targetsKey(session) {
    return protocolTargetIds(session).slice().sort().join(',');
  }

  function buildTargetHint(session) {
    const targetIds = protocolTargetIds(session);
    if (!targetIds.length) return '';
    const allowed = new Set(targetIds);
    const described = session.targetHosts.filter((h) => allowed.has(h.id)).length
      ? session.targetHosts.filter((h) => allowed.has(h.id)).map((h) => `${h.name || h.id}（hostId: ${h.id}${h.host ? `, ${h.host}` : ''}）`)
      : targetIds.map((id) => `hostId: ${id}`);
    return [
      `[目标 VPS] 用户为本会话指定了目标主机：${described.join('、')}。`,
      '需要在这些主机上执行命令或读写文件时，请使用 1Shell 提供的 MCP 工具（list_hosts / host_exec / read_remote_file / write_remote_file / upload_file / download_file 等），hostId 按上面给出的值传入。',
      '若你的环境里没有 1Shell 的 MCP 工具且本轮确实需要操作这些主机，再提醒用户接入 1Shell MCP；否则继续正常回答用户的问题，不要因此中断当前任务。',
    ].join('\n');
  }

  // 会话涉及文件：完成的 tool 调用触碰的文件路径聚合（IDE 壳的文件↔会话关联）。
  // 最近触碰的排最前、同路径去重（line 取最新），超上限丢最旧的。
  function mergeSessionFiles(session, locations) {
    const incoming = normalizeLocations(locations);
    if (!incoming.length) return;
    const touched = new Set(incoming.map((loc) => loc.path));
    const rest = session.files.filter((f) => f && !touched.has(f.path));
    session.files = [...incoming, ...rest].slice(0, SESSION_FILES_MAX);
  }

  // ── 权限请求挂起/应答 ────────────────────────────────────────────

  function requestApproval(session, { toolName, title, detail, input, options = [], toolUseId = '' }) {
    // auto（完全放行，默认）：不打卡直接允许——codex 侧本就 approval=never
    // 极少走到这里，claude / ACP 的 can_use_tool 也在此统一放行
    if (session.settings?.approvalMode !== 'ask') {
      return Promise.resolve({ action: 'allow', reason: 'auto_full_access' });
    }
    return new Promise((resolve) => {
      const requestId = `pa-${crypto.randomUUID()}`;
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        approvals.delete(requestId);
        resolve(decision || { action: 'deny', reason: 'no_decision' });
      };
      const timer = setTimeout(() => finish({ action: 'deny', reason: 'approval_timeout' }), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      approvals.set(requestId, { session, finish });

      emitToSession(session, 'ide:approve-request', {
        sessionId: session.sessionId,
        runId: session.currentRunId,
        requestId,
        toolUseId,
        toolName: toolName || 'tool',
        title: title || `${toolName || '工具'} 请求授权`,
        detail: detail || '',
        input: input ?? null,
        approval: {
          title: title || '',
          toolName: toolName || '',
          input: input ?? null,
          // ACP 的多选项（allow_once/allow_always/reject_once…）原样透出，
          // M2 的审批卡片按此渲染动作组；M1 前端只用 allow/deny。
          options: options.map((o) => ({ optionId: o.optionId || '', name: o.name || '', kind: o.kind || '' })),
        },
      });
    });
  }

  function resolveApproval(payload = {}) {
    const requestId = String(payload.requestId || '').trim();
    if (!requestId || !approvals.has(requestId)) return false;
    const { finish } = approvals.get(requestId);
    // optionId：前端审批卡直接选择 ACP 选项（allow_always 等）时透传
    finish({
      action: payload.action === 'allow' ? 'allow' : (payload.action === 'custom' ? 'custom' : 'deny'),
      optionId: String(payload.optionId || ''),
      text: String(payload.text || ''),
    });
    return true;
  }

  function rejectPendingApprovals(session, reason) {
    for (const [requestId, entry] of approvals) {
      if (entry.session !== session) continue;
      approvals.delete(requestId);
      entry.finish({ action: 'deny', reason });
    }
  }

  function pickAcpOption(options, wantAllow) {
    const kinds = wantAllow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    for (const kind of kinds) {
      const hit = options.find((o) => o.kind === kind);
      if (hit) return hit.optionId;
    }
    const prefix = wantAllow ? 'allow' : 'reject';
    const loose = options.find((o) => String(o.kind || '').startsWith(prefix));
    return loose ? loose.optionId : '';
  }

  // ── 归一化事件 → ide:event 翻译 ──────────────────────────────────

  function ensureTurn(session) {
    if (!session.turn) {
      session.turn = { runId: session.currentRunId, textBuffer: '', blocks: [], openTools: new Map() };
    }
    return session.turn;
  }

  function flushTextBlock(session, { emitFinal = false } = {}) {
    const turn = session.turn;
    if (!turn || !turn.textBuffer) return;
    const text = turn.textBuffer;
    turn.textBuffer = '';
    turn.blocks.push({ type: 'text', text });
    if (emitFinal) {
      emitToSession(session, 'ide:text', { sessionId: session.sessionId, runId: turn.runId, text });
    }
  }

  function flushAssistantMessage(session) {
    const turn = session.turn;
    if (!turn) return;
    flushTextBlock(session);
    if (turn.blocks.length) {
      session.messages.push({ role: 'assistant', content: turn.blocks });
      turn.blocks = [];
    }
  }

  function closeDanglingTools(session) {
    const turn = session.turn;
    if (!turn || turn.openTools.size === 0) return;
    for (const [toolCallId, tool] of turn.openTools) {
      flushAssistantMessage(session);
      session.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCallId, content: '', is_error: false }],
      });
      emitToSession(session, 'ide:tool-end', {
        sessionId: session.sessionId,
        runId: turn.runId,
        toolUseId: toolCallId,
        name: tool.name || 'tool',
        result: '',
        is_error: false,
        locations: tool.locations || [],
      });
    }
    turn.openTools.clear();
  }

  function finalizeTurn(session, outcome) {
    const turn = session.turn;
    if (!turn) return;
    const { sessionId } = session;
    const runId = turn.runId;
    closeDanglingTools(session);
    // 剩余流式文本定稿（claude 的 text 事件已定稿过的场景 buffer 为空）
    flushTextBlock(session, { emitFinal: outcome.kind === 'done' && !session.cancelled });
    flushAssistantMessage(session);
    session.turn = null;
    if (session.currentRunId === runId) session.currentRunId = null;
    // 当前 agent 的上下文水位推进到最新（切换 agent 时据此计算补课量）
    if (session.agentId) {
      session.agentBindings[session.agentId] = {
        nativeSessionId: session.nativeSessionId || '',
        ctxSeq: session.messages.length,
      };
    }
    persistSession(session);
    touchIdle(session);

    if (session.cancelled || outcome.kind === 'cancelled') {
      emitToSession(session, 'ide:cancelled', { sessionId, runId });
      return;
    }
    if (outcome.kind === 'error') {
      emitToSession(session, 'ide:error', { sessionId, runId, error: outcome.error || '协议 agent 执行失败' });
      return;
    }
    emitToSession(session, 'ide:done', { sessionId, runId, taskStatus: 'done' });
  }

  function handleAgentEvent(session, event) {
    // session/load 期间 agent 会重放历史（ACP 规范），这些事件不属于当前
    // 回合——历史已在持久化记录里，直接丢弃避免重复。
    if (session.loading) return;
    const turn = session.turn;
    const { sessionId } = session;
    switch (event.type) {
      case 'init':
        if (event.nativeSessionId) session.nativeSessionId = event.nativeSessionId;
        return;
      case 'text_delta': {
        if (!turn || !event.text) return;
        turn.textBuffer += event.text;
        emitToSession(session, 'ide:text-delta', { sessionId, runId: turn.runId, delta: event.text });
        return;
      }
      case 'thinking_delta':
        if (!turn) return;
        emitToSession(session, 'ide:thinking', { sessionId, runId: turn.runId, text: event.text || '' });
        return;
      case 'text': {
        // claude：assistant 消息 text block 定稿，替换此前的流式 delta
        if (!turn) return;
        turn.textBuffer = '';
        if (event.text) {
          turn.blocks.push({ type: 'text', text: event.text });
          emitToSession(session, 'ide:text', { sessionId, runId: turn.runId, text: event.text });
        }
        return;
      }
      case 'tool_start': {
        if (!turn) return;
        // 工具卡片出现前，把已流出的文本段定稿，保持时间线顺序
        flushTextBlock(session, { emitFinal: true });
        const locations = normalizeLocations(event.locations);
        const block = { type: 'tool_use', id: event.toolCallId, name: event.title || 'tool', input: event.input ?? {} };
        // locations 只挂在协议会话的展示记录上；这些 messages 不回传给任何模型 API
        if (locations.length) block.locations = locations;
        turn.blocks.push(block);
        turn.openTools.set(event.toolCallId, { name: event.title || 'tool', locations });
        emitToSession(session, 'ide:tool-start', {
          sessionId,
          runId: turn.runId,
          toolUseId: event.toolCallId,
          name: event.title || 'tool',
          input: event.input ?? null,
          locations,
        });
        return;
      }
      case 'tool_update': {
        if (!turn) return;
        const isFinal = event.status === 'completed' || event.status === 'failed';
        const known = turn.openTools.get(event.toolCallId);
        // ACP 的 tool_call_update 可能中途才带出 locations（如 pending 时还没定位到文件）
        if (known && Array.isArray(event.locations) && event.locations.length) {
          known.locations = normalizeLocations([...(known.locations || []), ...event.locations]);
        }
        if (!isFinal) {
          if (event.content) {
            emitToSession(session, 'ide:tool-delta', {
              sessionId,
              runId: turn.runId,
              toolUseId: event.toolCallId,
              name: known?.name || event.toolName || 'tool',
              stream: 'stdout',
              text: event.content,
            });
          }
          return;
        }
        turn.openTools.delete(event.toolCallId);
        const locations = normalizeLocations([...(known?.locations || []), ...(event.locations || [])]);
        if (event.status === 'completed') mergeSessionFiles(session, locations);
        flushAssistantMessage(session);
        session.messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: event.toolCallId,
            content: String(event.content || ''),
            is_error: event.status === 'failed',
          }],
        });
        emitToSession(session, 'ide:tool-end', {
          sessionId,
          runId: turn.runId,
          toolUseId: event.toolCallId,
          name: known?.name || event.toolName || 'tool',
          result: String(event.content || ''),
          is_error: event.status === 'failed',
          locations,
        });
        return;
      }
      case 'plan':
        // ACP plan：暂无 legacy 对应 UI，走统一事件流供 M2 消费
        emitToSession(session, 'ide:plan', { sessionId, runId: turn?.runId || session.currentRunId, entries: event.entries || [] });
        return;
      case 'done':
        // claude 适配器的回合定稿事件；ACP 走 prompt() resolve 分支
        if (event.nativeSessionId) session.nativeSessionId = event.nativeSessionId;
        finalizeTurn(session, { kind: 'done' });
        return;
      case 'error':
        finalizeTurn(session, { kind: 'error', error: event.message });
        return;
      case 'mode':
      default:
        // 未知事件宽容跳过，保持对各家实现的兼容
    }
  }

  // ── 协议客户端装配 ───────────────────────────────────────────────

  function buildClaudeClient(session, spec) {
    session.clientEffort = CLAUDE_EFFORTS.has(session.settings.effort) ? session.settings.effort : '';
    const client = createClaudeStreamAgent({
      binary: spec.binaryPath,
      cwd: session.cwd,
      effort: session.clientEffort,
      resumeSessionId: session.nativeSessionId || '',
      logger,
      onPermissionRequest: async ({ toolName, input }) => {
        const decision = await requestApproval(session, {
          toolName,
          title: `Claude Code 请求使用 ${toolName}`,
          detail: '',
          input,
        });
        if (decision.action === 'allow') return { behavior: 'allow' };
        return { behavior: 'deny', message: decision.text || (decision.reason === 'approval_timeout' ? '审批超时' : '用户拒绝') };
      },
      onEvent: (event) => handleAgentEvent(session, event),
      onExit: ({ code }) => {
        // 切换 agent / effort 重建时旧进程被主动杀掉，退出事件迟到——只处理
        // 当前 client 的退出，避免误杀新进程的回合
        if (session.client !== client) return;
        session.client = null;
        session.acpReady = null;
        if (session.turn) {
          finalizeTurn(session, { kind: 'error', error: `claude 进程意外退出 (code=${code})` });
        }
      },
    });
    return client;
  }

  function buildCodexClient(session, spec) {
    const client = createCodexAppServerAgent({
      binary: spec.binaryPath,
      args: spec.args || ['app-server'],
      cwd: session.cwd,
      resumeThreadId: session.nativeSessionId || '',
      logger,
      // 每回合读取最新设置：审批/沙箱/effort/fast 变更即时生效，无需重启进程。
      // codex 的 effort 取值域与 claude 不同，这里过滤掉不认识的值。
      sessionSettings: () => ({
        approvalMode: session.settings.approvalMode,
        effort: CODEX_EFFORTS.has(session.settings.effort) ? session.settings.effort : '',
        fast: session.settings.fast === true,
      }),
      onPermissionRequest: async ({ toolName, input }) => {
        const decision = await requestApproval(session, {
          toolName,
          title: `Codex 请求授权：${toolName}`,
          detail: '',
          input,
        });
        if (decision.action === 'allow') return { behavior: 'allow' };
        return { behavior: 'deny', message: decision.text || (decision.reason === 'approval_timeout' ? '审批超时' : '用户拒绝') };
      },
      onEvent: (event) => handleAgentEvent(session, event),
      onExit: ({ code }) => {
        if (session.client !== client) return; // 主动替换的旧进程，忽略
        session.client = null;
        session.acpReady = null;
        if (session.turn) {
          finalizeTurn(session, { kind: 'error', error: `codex 进程意外退出 (code=${code})` });
        }
      },
    });
    return client;
  }

  function buildAcpClient(session, spec) {
    const client = createAcpClient({
      command: spec.binaryPath,
      args: spec.args || [],
      cwd: session.cwd,
      logger,
      onPermissionRequest: async ({ toolCall, options }) => {
        const decision = await requestApproval(session, {
          toolName: toolCall.title || toolCall.kind || 'tool',
          title: `${spec.name} 请求授权：${toolCall.title || '工具调用'}`,
          detail: '',
          input: toolCall.rawInput ?? null,
          options,
          toolUseId: toolCall.toolCallId || '',
        });
        // 前端直接选中某个 ACP 选项（如 allow_always）时按选项应答
        if (decision.optionId && options.some((o) => o.optionId === decision.optionId)) {
          return { optionId: decision.optionId };
        }
        if (decision.action === 'allow') {
          const optionId = pickAcpOption(options, true);
          return optionId ? { optionId } : { cancelled: true };
        }
        const optionId = pickAcpOption(options, false);
        return optionId ? { optionId } : { cancelled: true };
      },
      onEvent: (event) => handleAgentEvent(session, event),
      onExit: ({ code }) => {
        if (session.client !== client) return; // 主动替换的旧进程，忽略
        session.client = null;
        session.acpReady = null;
        if (session.turn) {
          finalizeTurn(session, { kind: 'error', error: `${spec.name} 进程意外退出 (code=${code})` });
        }
      },
    });
    return client;
  }

  async function ensureClient(session, spec) {
    if (session.client?.alive) {
      // claude 的 effort 是 spawn 参数：设置变更时杀进程重建，--resume 续上下文
      const wantEffort = spec.protocol === 'claude-stream' && CLAUDE_EFFORTS.has(session.settings.effort)
        ? session.settings.effort
        : '';
      if (spec.protocol === 'claude-stream' && session.clientEffort !== wantEffort) {
        logger.info?.(`[protocol-agent] 会话 ${session.sessionId} effort 变更（${session.clientEffort || '默认'} → ${wantEffort || '默认'}），重建 claude 进程`);
        try { session.client.kill(); } catch { /* ignore */ }
        session.client = null;
        session.acpReady = null;
      } else {
        if (session.protocol === 'acp' && session.acpReady) await session.acpReady;
        return;
      }
    }
    session.protocol = spec.protocol;
    if (spec.protocol === 'claude-stream') {
      session.client = buildClaudeClient(session, spec);
      return;
    }
    if (spec.protocol === 'codex-app-server') {
      // 回合定稿与 claude 同模式：适配器 emit done/error，handleAgentEvent 收口
      session.client = buildCodexClient(session, spec);
      return;
    }
    if (spec.protocol === 'acp') {
      const client = buildAcpClient(session, spec);
      session.client = client;
      session.acpReady = (async () => {
        await client.initialize();
        const canLoad = Boolean(client.capabilities?.loadSession);
        if (session.nativeSessionId && canLoad) {
          session.loading = true;
          try {
            await client.loadSession({ acpSessionId: session.nativeSessionId, cwd: session.cwd });
          } finally {
            session.loading = false;
          }
        } else {
          const { acpSessionId } = await client.newSession({ cwd: session.cwd });
          session.nativeSessionId = acpSessionId;
        }
      })();
      try {
        await session.acpReady;
      } catch (err) {
        // 初始化失败的进程不可复用：清掉引用让下一条消息重新拉起
        session.acpReady = null;
        session.client = null;
        try { client.kill(); } catch { /* ignore */ }
        throw err;
      }
      return;
    }
    throw new Error(`不支持的协议: ${spec.protocol}`);
  }

  // ── 对外 API ────────────────────────────────────────────────────

  async function handleMessage({ socket, sessionId, message, agentId = '', cwd = '', attachments = [], settings, workspaceHostIds, hosts }) {
    // 切回 1Shell AI 由 socket 路由层调用 releaseSessionToOneshell 完成，消息
    // 不该带着 oneshell 走到这里；在建会话之前显式拒绝（绝不能静默用旧 agent
    // 继续跑，也不能把 oneshell 会话拉进本服务的 live map）
    const incomingAgentId = String(agentId || '').trim();
    if (incomingAgentId === ONESHELL_AGENT_ID) {
      if (socket) emitIdeEvent(socket, 'ide:error', { sessionId, error: '该会话应由 1Shell AI 处理（协议层不接收 oneshell 消息），请重试或刷新页面' });
      return;
    }
    const session = getOrCreateSession(sessionId, {
      agentId: incomingAgentId,
      cwd: String(cwd || '').trim(),
    });
    session.socket = socket || session.socket;
    session.socketId = socket?.id || session.socketId;
    session.detachedAt = null;
    session.detachReason = '';

    const fail = (error) => {
      emitToSession(session, 'ide:error', { sessionId, runId: session.currentRunId, error });
    };

    // 每条消息都可携带最新运行设置 / 目标 VPS（前端 composer 的选择器）
    if (settings !== undefined) session.settings = normalizeSettings(settings);
    if (workspaceHostIds !== undefined) {
      session.workspaceHostIds = normalizeWorkspaceHostIds(workspaceHostIds);
      session.targetHosts = normalizeTargetHosts(hosts, session.workspaceHostIds);
    }

    // agent 中途切换（mindfs 模式）：消息带来的 agentId 与会话当前 agent 不同
    // 时，收下旧 agent 的绑定、换绑新 agent 的原生会话，并准备补课提示
    let switchHint = '';
    if (incomingAgentId && incomingAgentId !== session.agentId && session.agentId) {
      if (session.turn) return fail('上一轮尚未结束，请等待或先停止后再切换 agent');
      const previous = session.agentId;
      session.agentBindings[previous] = {
        nativeSessionId: session.nativeSessionId || '',
        ctxSeq: session.agentBindings[previous]?.ctxSeq ?? session.messages.length,
      };
      rejectPendingApprovals(session, 'agent_switched');
      try { session.client?.kill?.(); } catch { /* ignore */ }
      session.client = null;
      session.acpReady = null;
      session.protocol = '';
      session.agentId = incomingAgentId;
      const binding = session.agentBindings[incomingAgentId] || null;
      session.nativeSessionId = binding?.nativeSessionId || '';
      session.lastTargetsKey = ''; // 新 agent 上下文里还没有目标信息，重新注入
      writeSessionLog(session); // 补课日志刷到最新（含可能的 oneshell 轮次）
      switchHint = buildSwitchHint(session, binding?.ctxSeq ?? 0);
      session.handoffFromOneshell = false;
      logger.info?.(`[protocol-agent] 会话 ${sessionId} 切换 agent：${previous} → ${incomingAgentId}${binding?.nativeSessionId ? '（resume 原生会话）' : '（新建原生会话）'}`);
    }

    if (!session.agentId || session.agentId === ONESHELL_AGENT_ID) {
      return fail('缺少 agentId：协议会话必须指定第三方 agent');
    }
    const spec = catalog?.getAgent?.(session.agentId);
    if (!spec) return fail(`未知的协议 agent: ${session.agentId}`);
    if (!spec.binaryPath) return fail(`未检测到 ${spec.name} 可执行文件（${spec.binary}），请先安装或在 Agent 接入页指定路径`);

    if (!session.cwd) session.cwd = os.homedir();
    if (!fs.existsSync(session.cwd)) return fail(`工作目录不存在: ${session.cwd}`);

    if (session.turn) return fail('上一轮尚未结束，请等待或先停止');

    // 领养 1Shell AI 会话：记录归属原为 oneshell 且已有历史。放在全部校验
    // 之后，避免 binary/cwd 配置错误时白白消耗补课标记。1Shell AI 侧不写
    // 会话日志，这里补写全量后与 agent 间切换一样注入补课提示；该 agent
    // 若有旧绑定（此前切走过）则恢复其原生会话
    if (!switchHint && session.handoffFromOneshell) {
      const binding = session.agentBindings[session.agentId] || null;
      session.nativeSessionId = binding?.nativeSessionId || '';
      session.lastTargetsKey = '';
      writeSessionLog(session);
      switchHint = buildSwitchHint(session, binding?.ctxSeq ?? 0);
      session.handoffFromOneshell = false;
      logger.info?.(`[protocol-agent] 会话 ${sessionId} 从 1Shell AI 交接给 ${session.agentId}${binding?.nativeSessionId ? '（resume 原生会话）' : '（新建原生会话）'}`);
    }

    const runId = newRunId();
    session.currentRunId = runId;
    session.cancelled = false;
    ensureTurn(session);
    touchIdle(session);

    // 附件落盘：base64/text → cwd/.1shell-attachments/ 下的真实文件，agent 用
    // 自己的读取工具查看（CLI 协议不吃内联 base64）。落盘元数据（路径/名称/
    // 类型）挂在用户消息记录上并推给前端 —— 前端经 /api/files/download 回显
    // 缩略图（图床式：同一份文件，前端 HTTP 看、agent 读盘）。
    const { stored: storedAttachments, skipped: skippedAttachments } = materializeAttachments({
      attachments,
      cwd: session.cwd,
      logger,
    });
    const attachmentHint = buildAttachmentHint(storedAttachments, skippedAttachments);

    if (!session.firstUserMessage) session.firstUserMessage = String(message).slice(0, 200);
    const userEntry = { role: 'user', content: [{ type: 'text', text: String(message) }] };
    if (storedAttachments.length) userEntry.attachments = storedAttachments;
    session.messages.push(userEntry);

    emitToSession(session, 'ide:thinking', { sessionId, runId });
    if (storedAttachments.length || skippedAttachments.length) {
      emitToSession(session, 'ide:attachments', { sessionId, runId, attachments: storedAttachments, skipped: skippedAttachments });
    }

    // 目标 VPS 提示：目标集变化时注入一次（切换 agent 后也重新注入）
    let targetHint = '';
    const key = targetsKey(session);
    if (key && key !== session.lastTargetsKey) {
      targetHint = buildTargetHint(session);
      session.lastTargetsKey = key;
    } else if (!key) {
      session.lastTargetsKey = '';
    }

    // 交接/目标/附件提示只进 CLI prompt，不进会话展示记录
    const decorated = [switchHint, targetHint, attachmentHint, String(message)].filter(Boolean).join('\n\n');

    try {
      await ensureClient(session, spec);
      if (session.protocol === 'acp') {
        const { stopReason } = await session.client.prompt({
          acpSessionId: session.nativeSessionId,
          text: decorated,
          attachments: storedAttachments,
        });
        finalizeTurn(session, { kind: stopReason === 'cancelled' ? 'cancelled' : 'done' });
      } else {
        // claude-stream / codex-app-server：回合定稿事件（done/error）在 handleAgentEvent 中处理
        await session.client.prompt({ text: decorated, attachments: storedAttachments });
      }
    } catch (err) {
      if (session.turn && session.turn.runId === runId) {
        finalizeTurn(session, { kind: session.cancelled ? 'cancelled' : 'error', error: err?.message || '协议 agent 执行失败' });
      }
    }
  }

  function cancelSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.turn) return false;
    session.cancelled = true;
    rejectPendingApprovals(session, 'cancelled');
    try {
      if (session.protocol === 'acp') session.client?.cancel?.(session.nativeSessionId);
      else session.client?.cancel?.();
    } catch { /* ignore */ }
    return true;
  }

  function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.cancelled = true;
    destroySession(session, { keepRecord: true });
    return true;
  }

  function detachSessionsForSocket(socketId, reason = 'socket_disconnect') {
    let detached = 0;
    for (const session of sessions.values()) {
      if (session.socketId !== socketId) continue;
      session.socket = null;
      session.socketId = null;
      session.detachedAt = new Date().toISOString();
      session.detachReason = reason;
      detached += 1;
    }
    return detached;
  }

  function reattachSession(sessionId, socket) {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session 不存在' };
    session.socket = socket;
    session.socketId = socket.id;
    session.detachedAt = null;
    session.detachReason = '';
    if (session.currentRunId && !session.cancelled) {
      emitIdeEvent(socket, 'ide:thinking', { sessionId, runId: session.currentRunId });
    }
    return { ok: true, running: Boolean(session.currentRunId) && !session.cancelled, runId: session.currentRunId };
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  // 会话归属：live 会话，或持久化记录标记了第三方 agent
  function ownsSession(sessionId) {
    if (sessions.has(sessionId)) return true;
    try {
      const record = ideSessionRepository?.getSession?.(sessionId);
      return Boolean(record?.agentId && record.agentId !== ONESHELL_AGENT_ID);
    } catch {
      return false;
    }
  }

  // 会话交还 1Shell AI：杀协议进程、留存各 agent 绑定（回来时可 resume）、
  // 记录归属翻转为 oneshell。socket 路由在收到 agentId=oneshell 的消息且本
  // 服务仍持有该会话时调用；成功后消息交 ideService 处理。
  function releaseSessionToOneshell(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      if (session.turn) return { ok: false, error: '上一轮尚未结束，请等待或先停止后再切换 agent' };
      if (session.agentId && session.agentId !== ONESHELL_AGENT_ID) {
        session.agentBindings[session.agentId] = {
          nativeSessionId: session.nativeSessionId || '',
          ctxSeq: session.agentBindings[session.agentId]?.ctxSeq ?? session.messages.length,
        };
      }
      persistSession(session, { agentIdOverride: ONESHELL_AGENT_ID });
      destroySession(session, { keepRecord: true });
      return { ok: true };
    }
    // 非 live：直接翻转持久化记录的归属。repo 的 upsert 对 messages/preview
    // 等字段是整行覆盖语义，必须带全量字段回写。
    let record = null;
    try { record = ideSessionRepository?.getSession?.(sessionId) || null; } catch { record = null; }
    if (!record?.agentId || record.agentId === ONESHELL_AGENT_ID) return { ok: true };
    try {
      ideSessionRepository.upsertSession({
        id: record.id,
        title: record.title,
        entry: record.entry,
        hostId: record.hostId,
        workspaceHostIds: record.workspaceHostIds,
        modelLabel: record.modelLabel,
        messageCount: record.messageCount,
        messages: record.messages,
        preview: record.preview,
        agentId: ONESHELL_AGENT_ID,
        cwd: record.cwd,
        nativeSessionId: '',
        files: record.files,
        agentBindings: record.agentBindings,
        agentSettings: record.agentSettings,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || '切换回 1Shell AI 失败' };
    }
  }

  function listAgents() {
    return catalog?.listAgents?.() || [];
  }

  function shutdown() {
    for (const session of [...sessions.values()]) {
      destroySession(session, { keepRecord: true });
    }
  }

  return {
    handleMessage,
    cancelSession,
    deleteSession,
    detachSessionsForSocket,
    reattachSession,
    hasSession,
    ownsSession,
    releaseSessionToOneshell,
    resolveApproval,
    listAgents,
    shutdown,
  };
}

module.exports = { createProtocolAgentService };

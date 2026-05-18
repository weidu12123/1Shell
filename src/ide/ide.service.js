'use strict';

const fetch = require('node-fetch');
const {
  ONESHELL_CORE_SYSTEM_PROMPT,
  ONESHELL_AUTHORING_SYSTEM_PROMPT,
  SAFE_MODE_ADDENDUM,
} = require('../ai/oneshell-ai-prompt');

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
    let buffer = '';
    let resolved = false;

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
        };
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
            socket.emit('ide:text-delta', { sessionId, runId, delta: d.text });
          }
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
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
        if (resolved) break;
      }
    });

    stream.on('end', () => {
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
const KEEP_RECENT = 8;
const TRUNCATE_TO = 200;

function toolContentPreview(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'image') return '[image]';
    return JSON.stringify(block);
  }).join('\n');
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
      if (text.length <= TRUNCATE_TO) return block;
      return { ...block, content: text.slice(0, TRUNCATE_TO) + `\n...(已压缩，原 ${text.length} 字符)` };
    });
    return { ...msg, content: compacted };
  });
}

function normalizePromptEntry(entry) {
  const value = String(entry || '').trim().toLowerCase();
  return value === 'studio' || value === 'authoring' || value === 'skill-studio' ? 'studio' : 'core';
}

function promptForEntry(entry) {
  return normalizePromptEntry(entry) === 'studio'
    ? ONESHELL_AUTHORING_SYSTEM_PROMPT
    : ONESHELL_CORE_SYSTEM_PROMPT;
}

/**
 * IDE Service — 自由对话模式的创作引擎
 *
 * 与 Skill Runner 的根本区别：
 *   - system prompt 极简，不注入任何 Skill 的 rules/workflows
 *   - 对话历史持久保留，支持多轮迭代
 *   - 工具集更广（read_file / list_artifacts / trigger_program / query_format 等）
 *   - 用户是对话主体，AI 响应用户指令而非自驱执行
 */
function createIdeService({ ideTools, proxyConfigStore, port, hostService, auditService, logger, localMcpService, mcpRegistry }) {

  // sessionId → { messages[], system, hostId, abortController }
  const sessions = new Map();

  const READONLY_TOOLS = new Set([
    'list_hosts', 'read_file', 'list_artifacts', 'query_format',
    'reload_registry', 'list_mcp_servers', 'list_scripts', 'query_audit',
    'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
    'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
    'list_remote_dir', 'read_remote_file',
  ]);

  function makeAbortError(message = 'Cancelled') {
    const err = new Error(message);
    err.name = 'AbortError';
    err.code = 'CANCELLED';
    return err;
  }

  function isAbortError(err) {
    return err?.name === 'AbortError' || err?.code === 'CANCELLED' || err?.code === 'RUN_REPLACED';
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function ensureSessionCancellation(session) {
    if (!session.cancelHandlers) session.cancelHandlers = new Set();
    if (!session.activeSkillRunIds) session.activeSkillRunIds = new Set();
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
    try { socket?.emit?.('ide:cancelled', { sessionId, runId }); } catch { /* ignore */ }
  }

  function getApprovalSummary(tc) {
    const input = tc.input || {};
    switch (tc.name) {
      case 'execute_command':
        return { title: '执行命令', detail: `主机: ${input.hostId || 'local'}\n命令: ${input.command || ''}` };
      case 'write_file':
        return { title: '写入文件', detail: `路径: ${input.path || ''}\n内容: ${(input.content || '').substring(0, 300)}` };
      case 'deploy_local_mcp':
        return { title: '部署本地 MCP', detail: `仓库: ${input.repoUrl || ''}\n名称: ${input.name || ''}` };
      default:
        return { title: tc.name, detail: JSON.stringify(input, null, 2).substring(0, 400) };
    }
  }

  function waitForApproval(socket, sessionId, tc, session, runId) {
    return new Promise((resolve, reject) => {
      const requestId = `apr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const summary = getApprovalSummary(tc);
      let unregisterCancel = null;
      let settled = false;

      const cleanup = () => {
        socket.off('ide:approve-response', handler);
        clearTimeout(timer);
        if (unregisterCancel) unregisterCancel();
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      const handler = (resp) => {
        if (resp.requestId !== requestId) return;
        settle(resolve, resp);
      };
      socket.on('ide:approve-response', handler);

      const timer = setTimeout(() => settle(resolve, { action: 'deny' }), 5 * 60 * 1000);
      unregisterCancel = registerCancelHandler(session, () => settle(reject, makeAbortError()));

      try {
        throwIfStopped(session, runId);
        socket.emit('ide:approve-request', {
          sessionId,
          runId,
          requestId,
          toolName: tc.name,
          title: summary.title,
          detail: summary.detail,
        });
      } catch (err) {
        settle(reject, err);
      }
    });
  }

  function applyPromptEntry(session, entry) {
    if (entry == null || String(entry).trim() === '') return;
    const nextEntry = normalizePromptEntry(entry);
    if (session.entry === nextEntry) return;
    session.entry = nextEntry;
    session.system = promptForEntry(nextEntry);
  }

  function getOrCreateSession(sessionId, context, entry) {
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      applyPromptEntry(session, entry);
      return session;
    }

    let contextBlock = '';
    if (context) {
      const parts = [];
      if (context.hosts?.length > 0) {
        parts.push('**目标主机**：');
        for (const h of context.hosts) {
          parts.push(`  - \`${h.id}\` · ${h.name || h.id} (${h.username || 'root'}@${h.host || '127.0.0.1'}:${h.port || 22})`);
        }
      }
      if (context.files?.length > 0) {
        parts.push('**相关文件**：');
        for (const f of context.files) parts.push(`  - hostId=\`${f.hostId}\` path=\`${f.path}\``);
      }
      if (context.containers?.length > 0) {
        parts.push('**相关容器**：');
        for (const c of context.containers) parts.push(`  - hostId=\`${c.hostId}\` name=\`${c.name || c.id}\`${c.image ? ` image=${c.image}` : ''}`);
      }
      if (context.mcpServers?.length > 0) {
        parts.push('**MCP Server**：');
        for (const s of context.mcpServers) parts.push(`  - \`${s.name}\` → ${s.url}`);
      }
      if (context.skills?.length > 0) {
        parts.push('**用户选择的 Skill**（可通过 read_file 读取其内容，通过 execute_command 在目标主机执行）：');
        for (const s of context.skills) parts.push(`  - \`${s.id}\` · ${s.name}`);
      }
      if (parts.length > 0) contextBlock = parts.join('\n') + '\n\n';
    }

    const promptEntry = normalizePromptEntry(entry);
    const session = {
      messages: [],
      entry: promptEntry,
      system: promptForEntry(promptEntry),
      contextBlock,
      hostId: context?.hosts?.[0]?.id || 'local',
      abortController: null,
      activeChildProcess: null,
      activeSkillRunIds: new Set(),
      cancelHandlers: new Set(),
      cancelNotified: false,
      cancelled: false,
      currentRunId: null,
      socket: null,
      socketId: null,
      safeMode: true,
      unlimitedTurns: false,
      claudeCodeEnabled: false,
    };
    sessions.set(sessionId, session);
    return session;
  }

  async function handleMessage({ socket, sessionId, message, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry }) {
    const session = getOrCreateSession(sessionId, context, entry);
    ensureSessionCancellation(session);
    const runId = newRunId();
    session.currentRunId = runId;
    session.cancelled = false;
    session.cancelNotified = false;
    session.socket = socket;
    session.socketId = socket.id;

    if (safeMode !== undefined) {
      session.safeMode = safeMode !== false;
    }
    if (claudeCodeEnabled !== undefined) {
      session.claudeCodeEnabled = !!claudeCodeEnabled;
    }
    if (unlimitedTurns !== undefined) {
      session.unlimitedTurns = !!unlimitedTurns;
    }

    const userContent = session.messages.length === 0 && session.contextBlock
      ? session.contextBlock + message
      : message;

    session.messages.push({ role: 'user', content: userContent });

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      socket.emit('ide:error', { sessionId, runId, error: 'AI Provider 未配置。请先在"AI 配置"页添加 Provider。' });
      return;
    }

    const model = provider.model || 'claude-sonnet-4-20250514';
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;

    socket.emit('ide:thinking', { sessionId, runId });

    auditService?.log?.({ action: 'ide_message', sessionId, message: message.substring(0, 500) });

    // 合并内置工具 + 已启动的本地 MCP 工具（去重，剥离内部字段）
    const seenToolNames = new Set();
    const allTools = [];
    const mcpToolMap = new Map(); // name → { mcpId, mcpToolName }
    for (const t of ideTools.TOOL_SCHEMAS) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      allTools.push(t);
    }
    // Claude Code 协作：开关开启时注入工具
    if (session.claudeCodeEnabled && ideTools.CLAUDE_CODE_TOOL) {
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
    logger?.info?.(`[ide] tools: ${allTools.length} total (${allTools.map(t => t.name).join(', ')})`);

    const MAX_TOOL_ROUNDS = session.unlimitedTurns ? Infinity : 30;
    let round = 0;

    try {
      while (round < MAX_TOOL_ROUNDS) {
        round++;

        throwIfStopped(session, runId);

        let data;
        try {
          const compactedMessages = compactMessages(session.messages);
          const apiBody = JSON.stringify({
            model,
            max_tokens: 8192,
            stream: true,
            system: session.safeMode ? session.system + SAFE_MODE_ADDENDUM : session.system,
            messages: compactedMessages,
            tools: allTools,
          });

          const MAX_RETRIES = 2;
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const ac = new AbortController();
            session.abortController = ac;
            try {
              const resp = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: apiBody,
                signal: ac.signal,
              });

              if (!resp.ok) {
                session.abortController = null;
                const errText = await resp.text().catch(() => '');
                throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
              }

              // 增量 SSE 解析 — 实时推送 text delta 到前端
              data = await streamAnthropicSSE(resp.body, ac, session, socket, sessionId, runId);
              session.abortController = null;
              break;
            } catch (retryErr) {
              session.abortController = null;
              if (retryErr.name === 'AbortError') throw retryErr;
              const isRetryable = /premature close|ECONNRESET|socket hang up|ETIMEDOUT/i.test(retryErr.message);
              if (!isRetryable || attempt >= MAX_RETRIES) throw retryErr;
              if (isRunCurrent(session, runId)) {
                socket.emit('ide:text-delta', { sessionId, runId, delta: `\n[连接中断，第 ${attempt + 1} 次重试...]\n` });
              }
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
        } catch (err) {
          session.abortController = null;
          if (isAbortError(err)) {
            if (session.currentRunId === runId) emitCancelledOnce(session, sessionId, socket);
            return;
          }
          throw err;
        }

        if (data.type === 'error') {
          throw new Error(data.error?.message || 'API error');
        }

        throwIfStopped(session, runId);

        const textParts = data.content.filter(b => b.type === 'text').map(b => b.text);
        const toolCalls = data.content.filter(b => b.type === 'tool_use');

        // ide:text 仍发一次完整文本（兼容旧前端 / 历史记录用途）
        if (textParts.length > 0) {
          const fullText = textParts.join('');
          if (!data._emittedTextDelta) {
            socket.emit('ide:text-delta', { sessionId, runId, delta: fullText });
          }
          socket.emit('ide:text', { sessionId, runId, text: fullText });
        }

        session.messages.push({ role: 'assistant', content: data.content });

        if (toolCalls.length === 0 || data.stop_reason === 'end_turn') {
          if (isRunCurrent(session, runId)) socket.emit('ide:done', { sessionId, runId, round });
          return;
        }

        // 执行工具调用
        const toolResults = [];
        for (const tc of toolCalls) {
          throwIfStopped(session, runId);

          socket.emit('ide:tool-start', { sessionId, runId, toolUseId: tc.id, name: tc.name, input: tc.input });

          // 安全模式审批门：非只读工具暂停等待用户审批
          let result;
          if (session.safeMode && !READONLY_TOOLS.has(tc.name)) {
            const approval = await waitForApproval(socket, sessionId, tc, session, runId);
            throwIfStopped(session, runId);
            if (approval.action === 'deny') {
              result = { content: '[用户拒绝了此操作]', is_error: true };
              socket.emit('ide:tool-end', { sessionId, runId, toolUseId: tc.id, name: tc.name, result: result.content, is_error: true });
              toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result.content, is_error: true });
              continue;
            }
            if (approval.action === 'custom') {
              result = { content: approval.text || '[用户自定义回复]', is_error: false };
              socket.emit('ide:tool-end', { sessionId, runId, toolUseId: tc.id, name: tc.name, result: result.content, is_error: false });
              toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result.content });
              continue;
            }
            // action === 'allow' → 继续执行
          }

          // MCP 工具通过 mcpToolMap 路由到 localMcpService，其余走内置 handler
          const toolAc = new AbortController();
          const unregisterToolCancel = registerCancelHandler(session, () => toolAc.abort());
          try {
            const mcpInfo = mcpToolMap.get(tc.name);
            if (mcpInfo && localMcpService) {
              try {
                result = await localMcpService.callTool(mcpInfo.mcpId, mcpInfo.mcpToolName, tc.input || {}, {
                  signal: toolAc.signal,
                  killOnAbort: true,
                });
              } catch (err) {
                if (isAbortError(err) || toolAc.signal.aborted) throw makeAbortError();
                result = { content: `[ERROR] ${err.message}`, is_error: true };
              }
            } else {
              result = await ideTools.handle(tc.name, tc.input || {}, {
                socket,
                sessionId,
                safeMode: session.safeMode,
                session,
                signal: toolAc.signal,
              });
            }
          } finally {
            unregisterToolCancel();
          }

          throwIfStopped(session, runId);

          socket.emit('ide:tool-end', {
            sessionId,
            runId,
            toolUseId: tc.id,
            name: tc.name,
            result: toolContentPreview(result.content).substring(0, 4000),
            is_error: result.is_error,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: result.content,
            ...(result.is_error ? { is_error: true } : {}),
          });
        }

        throwIfStopped(session, runId);
        session.messages.push({ role: 'user', content: toolResults });

        if (isRunCurrent(session, runId)) socket.emit('ide:thinking', { sessionId, runId });
      }

      if (isRunCurrent(session, runId)) {
        socket.emit('ide:error', { sessionId, runId, error: `工具调用轮次过多 (${MAX_TOOL_ROUNDS})，已中断。` });
      }
    } catch (err) {
      if (isAbortError(err)) {
        if (session.currentRunId === runId) emitCancelledOnce(session, sessionId, socket);
        return;
      }
      logger?.error?.('IDE 执行异常', { sessionId, error: err.message });
      if (isRunCurrent(session, runId)) socket.emit('ide:error', { sessionId, runId, error: err.message });
    }
  }

  function cancelSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    ensureSessionCancellation(session);
    session.cancelled = true;
    if (session.abortController) {
      try { session.abortController.abort(); } catch { /* ignore */ }
      session.abortController = null;
    }
    for (const handler of [...session.cancelHandlers]) {
      try { handler(); } catch { /* ignore */ }
    }
    for (const runId of [...session.activeSkillRunIds]) {
      try { session.skillRunner?.cancelRun?.(runId); } catch { /* ignore */ }
    }
    if (session.activeChildProcess) {
      try { session.activeChildProcess.kill(); } catch { /* ignore */ }
      session.activeChildProcess = null;
    }
    emitCancelledOnce(session, sessionId);
    return true;
  }

  function deleteSession(sessionId) {
    cancelSession(sessionId);
    sessions.delete(sessionId);
  }

  function cancelSessionsForSocket(socketId) {
    for (const [sessionId, session] of sessions) {
      if (session.socketId === socketId) cancelSession(sessionId);
    }
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  function setSafeMode(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.safeMode = enabled;
  }

  function getSafeMode(sessionId) {
    const session = sessions.get(sessionId);
    return session ? session.safeMode : true;
  }

  function setUnlimitedTurns(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.unlimitedTurns = enabled;
  }

  function setClaudeCodeEnabled(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.claudeCodeEnabled = enabled;
  }

  return { handleMessage, cancelSession, cancelSessionsForSocket, deleteSession, hasSession, setSafeMode, getSafeMode, setUnlimitedTurns, setClaudeCodeEnabled };
}

module.exports = { createIdeService };
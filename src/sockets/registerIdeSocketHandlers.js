'use strict';

const { emitIdeEvent } = require('../ide/ide.events');

/**
 * IDE Socket Handlers
 *
 * 事件（前端 → 后端）：
 *   ide:message   { sessionId, message, context?, agentId?, cwd?, settings?, workspaceHostIds?, hosts? }
 *   ide:stop      { sessionId }
 *   ide:clear     { sessionId }
 *
 * 事件（后端 → 前端）：
 *   兼容事件仍保留：ide:thinking / ide:text-delta / ide:text / ide:tool-start / ide:tool-end / ide:done / ide:error / ide:cancelled
 *   同时额外发统一事件：ide:event { v, type, sessionId, runId, payload, ts }
 *
 * 路由：以消息携带的 agentId 为准双向分流——非 oneshell 的 agentId 走
 * protocolAgentService；显式 oneshell 的走 ideService（若会话此前归协议层，
 * 先 releaseSessionToOneshell 翻转归属）；未携带 agentId 的旧客户端按会话
 * 归属（ownsSession）兜底。双向切换时让出对侧的 live 会话，避免历史分叉。
 */
function registerIdeSocketHandlers(io, { ideService, ideTools, localMcpService, mcpRegistry, protocolAgentService }) {
  function isProtocolSession(sessionId, agentId = '') {
    if (!protocolAgentService) return false;
    if (agentId === 'oneshell') return false;
    if (agentId) return true;
    return protocolAgentService.ownsSession(sessionId);
  }

  io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      ideService.detachSessionsForSocket?.(socket.id, 'socket_disconnect');
      protocolAgentService?.detachSessionsForSocket?.(socket.id, 'socket_disconnect');
    });

    socket.on('ide:reattach', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) return reply({ ok: false, error: 'sessionId 为必填' });
      if (protocolAgentService?.hasSession(sessionId)) {
        return reply(protocolAgentService.reattachSession(sessionId, socket));
      }
      reply(ideService.reattachSession?.(sessionId, socket) || { ok: false, error: '服务未初始化' });
    });

    socket.on('ide:message', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const rawMessage = String(payload.message ?? '');
      const message = rawMessage.replace(/^(?:\r?\n)+|\s+$/g, '');
      if (!sessionId || !rawMessage.trim()) {
        return reply({ ok: false, error: 'sessionId 和 message 为必填' });
      }

      reply({ ok: true });

      const agentId = String(payload.agentId || '').trim();
      if (isProtocolSession(sessionId, agentId)) {
        // 会话若在 1Shell AI 侧还有 live 副本（oneshell → 协议切换），先落
        // 盘让出，协议侧从持久化记录重水化完整历史
        const released = ideService.releaseLiveSession?.(sessionId);
        if (released && !released.ok) {
          emitIdeEvent(socket, 'ide:error', { sessionId, error: released.error || '切换 agent 失败' });
          return;
        }
        Promise.resolve().then(() => protocolAgentService.handleMessage({
          socket,
          sessionId,
          message,
          agentId,
          cwd: String(payload.cwd || '').trim(),
          attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
          // 协议会话运行设置与目标 VPS：composer 每条消息都带最新值
          settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : undefined,
          workspaceHostIds: Array.isArray(payload.workspaceHostIds) ? payload.workspaceHostIds : undefined,
          hosts: Array.isArray(payload.hosts) ? payload.hosts : undefined,
        })).catch((err) => {
          emitIdeEvent(socket, 'ide:error', { sessionId, error: err?.message || 'ide:message 处理失败' });
        });
        return;
      }

      // 显式切回 1Shell AI：协议层若仍持有该会话（live 或记录归属），先交还
      // ——杀协议进程、翻转记录归属，1Shell AI 侧从持久化记录恢复完整历史
      if (agentId === 'oneshell' && protocolAgentService?.ownsSession(sessionId)) {
        const released = protocolAgentService.releaseSessionToOneshell?.(sessionId);
        if (released && !released.ok) {
          emitIdeEvent(socket, 'ide:error', { sessionId, error: released.error || '切换回 1Shell AI 失败' });
          return;
        }
      }

      Promise.resolve().then(() => ideService.handleMessage({
        socket,
        sessionId,
        message,
        context: payload.context || null,
        safeMode: payload.safeMode,
        claudeCodeEnabled: payload.claudeCodeEnabled,
        unlimitedTurns: payload.unlimitedTurns,
        entry: payload.entry || payload.source || '',
        approvalMode: payload.approvalMode || payload.approval_mode || '',
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
      })).catch((err) => {
        emitIdeEvent(socket, 'ide:error', { sessionId, error: err?.message || 'ide:message 处理失败' });
      });
    });

    socket.on('ide:stop', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      let cancelled = false;
      if (sessionId && protocolAgentService?.hasSession(sessionId)) {
        cancelled = protocolAgentService.cancelSession(sessionId);
      } else if (sessionId) {
        cancelled = ideService.cancelSession(sessionId);
      }
      if (sessionId && !cancelled) emitIdeEvent(socket, 'ide:cancelled', { sessionId });
      reply({ ok: true, cancelled });
    });

    socket.on('ide:safe-mode', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      reply({ ok: true, safeMode: false, deprecated: true, ignored: true });
    });

    socket.on('ide:unlimited-turns', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      reply({ ok: true, unlimitedTurns: false, deprecated: true, ignored: true });
    });

    socket.on('ide:claude-code-collab', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setClaudeCodeEnabled(sessionId, enabled);
      reply({ ok: true, claudeCodeEnabled: enabled });
    });

    socket.on('ide:clear', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (sessionId) {
        if (protocolAgentService?.hasSession(sessionId)) protocolAgentService.deleteSession(sessionId);
        else ideService.deleteSession(sessionId);
      }
      reply({ ok: true });
    });

    socket.on('ide:rewind-list', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) return reply({ ok: false, error: 'sessionId is required' });
      const result = ideService.listRewindPoints?.(sessionId) || { ok: false, error: 'rewind is unavailable' };
      reply(result);
    });

    socket.on('ide:authoring-reply', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) return reply({ ok: false, error: 'sessionId 为必填' });
      const result = ideService.recordAuthoringUserReply?.(sessionId, payload) || { ok: false, error: '服务未初始化' };
      if (result.ok && result.session) emitIdeEvent(socket, 'ide:authoring-session', { sessionId, session: result.session });
      reply(result);
    });

    // ─── Agent approval / user-input responses ────────────────────────────────────
    socket.on('ide:approve-response', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      // 协议 agent 的挂起审批优先按 requestId 应答（ide.service 的审批由其
      // 每请求的 socket 监听器自行消费，不经过这里）
      if (protocolAgentService?.resolveApproval(payload)) return reply({ ok: true });
      if (!ideTools) return reply({ ok: false });
      const sessionId = String(payload.sessionId || '').trim();
      const command = String(payload.command || '').trim();
      if (sessionId && command && payload.approved) {
        ideTools.approveCommand(sessionId, command);
      }
      reply({ ok: true });
    });

    // ─── 本地 MCP 启停 ──────────────────────────────────────────
    socket.on('ide:mcp-start', async (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService || !mcpRegistry) return reply({ ok: false, error: '服务未初始化' });
      const mcpId = String(payload.mcpId || '').trim();
      if (!mcpId) return reply({ ok: false, error: 'mcpId 必填' });
      const server = mcpRegistry.getServer(mcpId);
      if (!server) return reply({ ok: false, error: `MCP 不存在: ${mcpId}` });
      if (!server.enabled) return reply({ ok: false, error: '该 MCP 已禁用' });
      if (!server.exposeToIde) return reply({ ok: false, error: '该 MCP 未开放给 IDE AI' });
      if (server.type !== 'local' && !server.command) return reply({ ok: false, error: '该 MCP 不是本地类型' });
      const result = await localMcpService.start(mcpId, server.command, { cwd: server.installDir || undefined });
      emitIdeEvent(io, 'ide:mcp-status', { mcpId, ...localMcpService.getStatus(mcpId) });
      reply(result);
    });

    socket.on('ide:mcp-stop', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService) return reply({ ok: false });
      const mcpId = String(payload.mcpId || '').trim();
      if (mcpId) localMcpService.stop(mcpId);
      emitIdeEvent(io, 'ide:mcp-status', { mcpId, status: 'stopped', tools: [] });
      reply({ ok: true });
    });

    socket.on('ide:mcp-status', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService) return reply({ ok: false, status: 'unavailable' });
      const mcpId = String(payload.mcpId || '').trim();
      reply({ ok: true, ...localMcpService.getStatus(mcpId) });
    });
  });
}

module.exports = { registerIdeSocketHandlers };

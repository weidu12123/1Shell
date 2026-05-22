'use strict';

/**
 * IDE Socket Handlers
 *
 * 事件（前端 → 后端）：
 *   ide:message   { sessionId, message, context? }
 *   ide:stop      { sessionId }
 *   ide:clear     { sessionId }
 *
 * 事件（后端 → 前端，由 ide.service 内部 emit）：
 *   ide:thinking     { sessionId }
 *   ide:text         { sessionId, text }
 *   ide:tool-start   { sessionId, toolUseId, name, input }
 *   ide:tool-end     { sessionId, toolUseId, name, result, is_error }
 *   ide:done         { sessionId, round }
 *   ide:error        { sessionId, error }
 *   ide:cancelled    { sessionId }
 */
function registerIdeSocketHandlers(io, { ideService, ideTools, localMcpService, mcpRegistry }) {
  io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      ideService.cancelSessionsForSocket?.(socket.id);
    });

    socket.on('ide:message', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const message = String(payload.message || '').trim();
      if (!sessionId || !message) {
        return reply({ ok: false, error: 'sessionId 和 message 为必填' });
      }

      reply({ ok: true });

      Promise.resolve().then(() => ideService.handleMessage({
        socket,
        sessionId,
        message,
        context: payload.context || null,
        safeMode: payload.safeMode,
        claudeCodeEnabled: payload.claudeCodeEnabled,
        unlimitedTurns: payload.unlimitedTurns,
        refinedMode: payload.refinedMode,
        entry: payload.entry || payload.source || '',
      })).catch((err) => {
        socket.emit('ide:error', { sessionId, error: err?.message || 'ide:message 处理失败' });
      });
    });

    socket.on('ide:stop', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const cancelled = sessionId ? ideService.cancelSession(sessionId) : false;
      if (sessionId && !cancelled) socket.emit('ide:cancelled', { sessionId });
      reply({ ok: true, cancelled });
    });

    socket.on('ide:safe-mode', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setSafeMode(sessionId, enabled);
      reply({ ok: true, safeMode: enabled });
    });

    socket.on('ide:unlimited-turns', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setUnlimitedTurns(sessionId, enabled);
      reply({ ok: true, unlimitedTurns: enabled });
    });

    socket.on('ide:claude-code-collab', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setClaudeCodeEnabled(sessionId, enabled);
      reply({ ok: true, claudeCodeEnabled: enabled });
    });

    socket.on('ide:refined-mode', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled === true;
      if (sessionId) ideService.setRefinedMode(sessionId, enabled);
      reply({ ok: true, refinedMode: enabled });
    });

    socket.on('ide:clear', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (sessionId) ideService.deleteSession(sessionId);
      reply({ ok: true });
    });

    socket.on('ide:authoring-reply', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) return reply({ ok: false, error: 'sessionId 为必填' });
      const result = ideService.recordAuthoringUserReply?.(sessionId, payload) || { ok: false, error: '服务未初始化' };
      if (result.ok && result.session) socket.emit('ide:authoring-session', { sessionId, session: result.session });
      reply(result);
    });

    // ─── 安全模式审批响应 ────────────────────────────────────
    socket.on('ide:approve-response', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
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
      io.emit('ide:mcp-status', { mcpId, ...localMcpService.getStatus(mcpId) });
      reply(result);
    });

    socket.on('ide:mcp-stop', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService) return reply({ ok: false });
      const mcpId = String(payload.mcpId || '').trim();
      if (mcpId) localMcpService.stop(mcpId);
      io.emit('ide:mcp-status', { mcpId, status: 'stopped', tools: [] });
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

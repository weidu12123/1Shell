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

    socket.on('ide:message', (payload = {}, reply = () => {}) => {
      const sessionId = String(payload.sessionId || '').trim();
      const message = String(payload.message || '').trim();
      if (!sessionId || !message) {
        return reply({ ok: false, error: 'sessionId 和 message 为必填' });
      }

      ideService.handleMessage({
        socket,
        sessionId,
        message,
        context: payload.context || null,
      }).catch(() => {});

      reply({ ok: true });
    });

    socket.on('ide:stop', (payload = {}, reply = () => {}) => {
      const sessionId = String(payload.sessionId || '').trim();
      if (sessionId) ideService.cancelSession(sessionId);
      reply({ ok: true });
    });

    socket.on('ide:safe-mode', (payload = {}, reply = () => {}) => {
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setSafeMode(sessionId, enabled);
      reply({ ok: true, safeMode: enabled });
    });

    socket.on('ide:unlimited-turns', (payload = {}, reply = () => {}) => {
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setUnlimitedTurns(sessionId, enabled);
      reply({ ok: true, unlimitedTurns: enabled });
    });

    socket.on('ide:clear', (payload = {}, reply = () => {}) => {
      const sessionId = String(payload.sessionId || '').trim();
      if (sessionId) ideService.deleteSession(sessionId);
      reply({ ok: true });
    });

    // ─── 安全模式审批响应 ────────────────────────────────────
    socket.on('ide:approve-response', (payload = {}, reply = () => {}) => {
      if (!ideTools) return reply({ ok: false });
      const sessionId = String(payload.sessionId || '').trim();
      const command = String(payload.command || '').trim();
      if (sessionId && command && payload.approved) {
        ideTools.approveCommand(sessionId, command);
      }
      reply({ ok: true });
    });

    // ─── 本地 MCP 启停 ──────────────────────────────────────────
    socket.on('ide:mcp-start', async (payload = {}, reply = () => {}) => {
      if (!localMcpService || !mcpRegistry) return reply({ ok: false, error: '服务未初始化' });
      const mcpId = String(payload.mcpId || '').trim();
      if (!mcpId) return reply({ ok: false, error: 'mcpId 必填' });
      const server = mcpRegistry.getServer(mcpId);
      if (!server) return reply({ ok: false, error: `MCP 不存在: ${mcpId}` });
      if (server.type !== 'local' && !server.command) return reply({ ok: false, error: '该 MCP 不是本地类型' });
      const result = await localMcpService.start(mcpId, server.command, { cwd: server.installDir || undefined });
      io.emit('ide:mcp-status', { mcpId, ...localMcpService.getStatus(mcpId) });
      reply(result);
    });

    socket.on('ide:mcp-stop', (payload = {}, reply = () => {}) => {
      if (!localMcpService) return reply({ ok: false });
      const mcpId = String(payload.mcpId || '').trim();
      if (mcpId) localMcpService.stop(mcpId);
      io.emit('ide:mcp-status', { mcpId, status: 'stopped', tools: [] });
      reply({ ok: true });
    });

    socket.on('ide:mcp-status', (payload = {}, reply = () => {}) => {
      if (!localMcpService) return reply({ ok: false, status: 'unavailable' });
      const mcpId = String(payload.mcpId || '').trim();
      reply({ ok: true, ...localMcpService.getStatus(mcpId) });
    });
  });
}

module.exports = { registerIdeSocketHandlers };
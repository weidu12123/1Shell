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
function registerIdeSocketHandlers(io, { ideService }) {
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

    socket.on('ide:clear', (payload = {}, reply = () => {}) => {
      const sessionId = String(payload.sessionId || '').trim();
      if (sessionId) ideService.deleteSession(sessionId);
      reply({ ok: true });
    });
  });
}

module.exports = { registerIdeSocketHandlers };
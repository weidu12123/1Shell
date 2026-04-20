'use strict';

/**
 * Guardian Socket Handlers
 *
 * 订阅前端事件：
 *   guardian:answer  { sessionId, toolUseId, answer }
 *   guardian:cancel  { sessionId }
 *
 * 下发事件由 guardianService 自己通过 io.emit 发出，这里只处理反向请求。
 */
function registerGuardianSocketHandlers(io, { guardianService }) {
  io.on('connection', (socket) => {
    socket.on('guardian:answer', (payload = {}, reply = () => {}) => {
      try {
        const sessionId = String(payload.sessionId || '').trim();
        const toolUseId = String(payload.toolUseId || '').trim();
        if (!sessionId || !toolUseId) {
          return reply({ ok: false, error: 'sessionId / toolUseId 必填' });
        }
        const ok = guardianService.submitAnswer(sessionId, toolUseId, payload.answer);
        reply({ ok });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('guardian:cancel', (payload = {}, reply = () => {}) => {
      try {
        const sessionId = String(payload.sessionId || '').trim();
        if (!sessionId) return reply({ ok: false, error: 'sessionId 必填' });
        guardianService.cancel(sessionId);
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });
  });
}

module.exports = { registerGuardianSocketHandlers };
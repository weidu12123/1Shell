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
function registerGuardianSocketHandlers(io, { guardianService, skillStepExecutor, programRegistry }) {
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

    socket.on('guardian:set-unlimited-turns', (payload = {}, reply = () => {}) => {
      const enabled = payload.enabled !== false;
      guardianService.setUnlimitedTurns(enabled);
      reply({ ok: true, unlimitedTurns: enabled });
    });

    socket.on('guardian:get-unlimited-turns', (payload = {}, reply = () => {}) => {
      reply({ ok: true, unlimitedTurns: guardianService.getUnlimitedTurns() });
    });

    // ─── L2 Skill Step Executor ────────────────────────────────────
    if (skillStepExecutor) {
      socket.on('l2:set-unlimited-turns', (payload = {}, reply = () => {}) => {
        const enabled = payload.enabled !== false;
        skillStepExecutor.setUnlimitedTurns(enabled);
        reply({ ok: true, unlimitedTurns: enabled });
      });

      socket.on('l2:get-unlimited-turns', (payload = {}, reply = () => {}) => {
        reply({ ok: true, unlimitedTurns: skillStepExecutor.getUnlimitedTurns() });
      });

      socket.on('l2:improve', async (payload = {}, reply = () => {}) => {
        try {
          const { programId, hostId, skillId, goal, execLog } = payload;
          if (!programId || !skillId) return reply({ ok: false, error: 'programId / skillId 必填' });

          const program = programRegistry?.get?.(programId)
            || { id: programId, name: programId, actions: {} };

          reply({ ok: true, message: '改进 session 已启动' });

          skillStepExecutor.improve({
            program,
            hostId: hostId || 'local',
            skillId,
            goal: goal || '',
            execLog: execLog || '(无日志)',
            runId: `improve_${Date.now().toString(36)}`,
          }).catch((err) => {
            console.error('[l2:improve] error', err.message);
          });
        } catch (err) {
          reply({ ok: false, error: err.message });
        }
      });
    }
  });
}

module.exports = { registerGuardianSocketHandlers };
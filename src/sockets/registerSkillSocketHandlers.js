'use strict';

const {
  validateSkillContinuePayload,
  validateSkillRunPayload,
  validateSkillStopPayload,
} = require('../utils/validators');

/**
 * Skill Runner Socket Handlers
 *
 * 事件订阅：
 *   skill:run      — 启动一个 Skill 任务
 *   skill:continue — 对 ask_user 回复
 *   skill:stop     — 取消当前任务
 *
 * 事件下发（由 runner 内部发出）：
 *   skill:run-started, skill:thinking, skill:thought,
 *   skill:exec, skill:exec-result,
 *   skill:render, skill:ask,
 *   skill:done, skill:error, skill:cancelled
 */
function registerSkillSocketHandlers(io, { skillRunner }) {
  io.on('connection', (socket) => {
    socket.on('skill:run', (payload = {}, reply = () => {}) => {
      try {
        const validated = validateSkillRunPayload(payload);
        // 异步触发，不阻塞 ack
        skillRunner.run({
          socket,
          runId: validated.runId,
          skillId: validated.skillId,
          hostId: validated.hostId,
          inputs: validated.inputs || {},
          rescuerSkillId: validated.rescuerSkillId || '',
        }).catch(() => {
          // 已由 runner 内部 catch 并 emit skill:error
        });
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });

    socket.on('skill:continue', (payload = {}, reply = () => {}) => {
      try {
        const validated = validateSkillContinuePayload(payload);
        const ok = skillRunner.continueRun({
          runId: validated.runId,
          toolUseId: validated.toolUseId,
          answer: payload.answer,
        });
        reply({ ok });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });

    socket.on('skill:stop', (payload = {}, reply = () => {}) => {
      try {
        const validated = validateSkillStopPayload(payload);
        skillRunner.cancelRun(validated.runId);
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });

    socket.on('disconnect', () => {
      skillRunner.cancelAllForSocket(socket.id);
    });
  });
}

module.exports = { registerSkillSocketHandlers };
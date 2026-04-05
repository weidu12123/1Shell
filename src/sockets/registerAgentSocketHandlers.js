'use strict';

const {
  validateAgentFocusPayload,
  validateAgentInputPayload,
  validateAgentResizePayload,
  validateAgentStartPayload,
  validateAgentStopPayload,
} = require('../utils/validators');
const {
  AGENT_DEFAULT_PROVIDER,
} = require('../config/env');

function registerAgentSocketHandlers(io, { agentPtyService }) {
  io.on('connection', (socket) => {
    socket.on('agent:providers', (reply = () => {}) => {
      try {
        reply({
          ok: true,
          providers: agentPtyService.listProviders(),
          defaultProviderId: AGENT_DEFAULT_PROVIDER,
        });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });

    socket.on('agent:start', (payload = {}, reply = () => {}) => {
      try {
        const validated = validateAgentStartPayload(payload);
        const session = agentPtyService.createAgentSession(socket, validated);
        reply({ ok: true, session: agentPtyService.serializeAgentSession(session) });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });

    socket.on('agent:input', (payload = {}) => {
      try {
        const validated = validateAgentInputPayload(payload);
        agentPtyService.writeToAgentSession(socket.id, validated.agentSessionId, validated.data);
      } catch {
        // ignore invalid payload
      }
    });

    socket.on('agent:resize', (payload = {}) => {
      try {
        const validated = validateAgentResizePayload(payload);
        agentPtyService.resizeAgentSession(socket.id, validated.agentSessionId, validated.cols, validated.rows);
      } catch {
        // ignore invalid payload
      }
    });

    socket.on('agent:focus-host', (payload = {}, reply = () => {}) => {
      try {
        const validated = validateAgentFocusPayload(payload);
        agentPtyService.focusAgentHost(socket, validated.agentSessionId, validated.hostId);
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });

    socket.on('agent:stop', (payload = {}) => {
      try {
        const validated = validateAgentStopPayload(payload);
        agentPtyService.stopAgentSession(socket, validated.agentSessionId);
      } catch {
        // ignore invalid payload
      }
    });

    socket.on('disconnect', () => {
      agentPtyService.stopAllSocketAgentSessions(socket);
    });
  });
}

module.exports = {
  registerAgentSocketHandlers,
};

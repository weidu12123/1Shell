'use strict';

const os = require('os');
const pty = require('node-pty');

const {
  AGENT_DEFAULT_COLS,
  AGENT_DEFAULT_ROWS,
  AGENT_MAX_SESSIONS_PER_SOCKET,
} = require('../config/env');
const {
  createId,
  nowIso,
} = require('../utils/common');

function createAgentPtyService({ hostService, providerRegistry }) {
  const socketAgentSessions = new Map();

  function getSocketAgentSessionMap(socketId) {
    let sessions = socketAgentSessions.get(socketId);
    if (!sessions) {
      sessions = new Map();
      socketAgentSessions.set(socketId, sessions);
    }
    return sessions;
  }

  function removeSocketAgentSession(socketId, agentSessionId) {
    const sessions = socketAgentSessions.get(socketId);
    if (!sessions) return;
    sessions.delete(agentSessionId);
    if (sessions.size === 0) {
      socketAgentSessions.delete(socketId);
    }
  }

  function serializeAgentSession(session) {
    return {
      id: session.id,
      providerId: session.providerId,
      providerLabel: session.providerLabel,
      hostId: session.hostId,
      hostName: session.hostName,
      status: session.status,
      createdAt: session.createdAt,
      lastError: session.lastError || null,
    };
  }

  function emitAgentStatus(socket, session, extra = {}) {
    socket.emit('agent:status', {
      ...serializeAgentSession(session),
      ...extra,
    });
  }

  function emitAgentOutput(socket, session, data, stream = 'stdout') {
    socket.emit('agent:output', {
      agentSessionId: session.id,
      providerId: session.providerId,
      hostId: session.hostId,
      stream,
      data,
    });
  }

  function buildHostBanner(host) {
    const hostName = host?.name || '未知主机';
    const hostMeta = host?.type === 'local'
      ? '本机 / 控制节点'
      : `${host.username}@${host.host}:${host.port}`;

    return [
      '[1Shell System]',
      `当前目标主机：${hostName} (${hostMeta})`,
      '请把后续任务的目标锁定到该主机。',
      '不要修改 1Shell 主控机本地文件；需要远端执行时优先使用后续提供的 1Shell Bridge。',
    ].join('\n');
  }

  function finalizeAgentSession(socket, session, status, extra = {}) {
    if (!session || session.isFinalized) return;

    session.isFinalized = true;
    session.status = status;
    session.lastError = extra.error || null;
    removeSocketAgentSession(socket.id, session.id);

    try {
      session.dispose?.();
    } catch {
      // ignore
    }

    emitAgentStatus(socket, session, extra);
  }

  function getExistingAgentSession(socketId) {
    const sessions = socketAgentSessions.get(socketId);
    if (!sessions) return null;

    for (const session of sessions.values()) {
      if (!session.isFinalized) return session;
    }

    return null;
  }

  function createAgentSession(socket, {
    providerId,
    hostId,
    cols = AGENT_DEFAULT_COLS,
    rows = AGENT_DEFAULT_ROWS,
  }) {
    const sessions = getSocketAgentSessionMap(socket.id);
    const existing = getExistingAgentSession(socket.id);
    if (existing) {
      return existing;
    }
    if (sessions.size >= AGENT_MAX_SESSIONS_PER_SOCKET) {
      throw new Error('当前连接的 Agent 会话数量已达上限');
    }

    const provider = providerRegistry.getProvider(providerId);
    if (!provider) {
      throw new Error('不支持的 Agent Provider');
    }

    const host = hostService.findHost(hostId);
    if (!host) {
      throw new Error('主机不存在');
    }

    const session = {
      id: createId('agent'),
      providerId: provider.id,
      providerLabel: provider.label,
      hostId: host.id,
      hostName: host.name,
      status: 'starting',
      createdAt: nowIso(),
      isFinalized: false,
      lastError: null,
      process: null,
      write: () => {},
      resize: () => {},
      dispose: () => {},
    };

    sessions.set(session.id, session);
    emitAgentStatus(socket, session);

    try {
      const ptyProcess = pty.spawn(provider.command, provider.args || [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(provider.env || {}),
        },
      });

      session.process = ptyProcess;
      session.write = (data) => {
        if (session.isFinalized) return;
        ptyProcess.write(String(data || ''));
      };
      session.resize = (nextCols, nextRows) => {
        if (session.isFinalized) return;
        try {
          ptyProcess.resize(nextCols, nextRows);
        } catch {
          // ignore
        }
      };
      session.dispose = () => {
        try { ptyProcess.kill(); } catch { /* ignore */ }
      };

      ptyProcess.onData((data) => {
        if (session.isFinalized) return;
        emitAgentOutput(socket, session, data, 'stdout');
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        finalizeAgentSession(socket, session, 'stopped', {
          exitCode,
          signal,
        });
      });

      session.status = 'ready';
      emitAgentStatus(socket, session);
      ptyProcess.write(`${buildHostBanner(host)}\r`);
      return session;
    } catch (error) {
      finalizeAgentSession(socket, session, 'error', { error: error.message });
      throw error;
    }
  }

  function writeToAgentSession(socketId, agentSessionId, data) {
    const session = getSocketAgentSessionMap(socketId).get(agentSessionId);
    if (!session || session.isFinalized) return;
    session.write(data);
  }

  function resizeAgentSession(socketId, agentSessionId, cols, rows) {
    const session = getSocketAgentSessionMap(socketId).get(agentSessionId);
    if (!session || session.isFinalized) return;
    session.resize(cols, rows);
  }

  function focusAgentHost(socket, agentSessionId, hostId) {
    const session = getSocketAgentSessionMap(socket.id).get(agentSessionId);
    if (!session || session.isFinalized) return;

    const host = hostService.findHost(hostId);
    if (!host) {
      throw new Error('主机不存在');
    }

    session.hostId = host.id;
    session.hostName = host.name;
    emitAgentStatus(socket, session);
    session.process?.write(`${buildHostBanner(host)}\r`);
  }

  function stopAgentSession(socket, agentSessionId) {
    const session = getSocketAgentSessionMap(socket.id).get(agentSessionId);
    if (!session) return;
    finalizeAgentSession(socket, session, 'stopped');
  }

  function stopAllSocketAgentSessions(socket) {
    const sessions = socketAgentSessions.get(socket.id);
    if (!sessions) return;

    for (const session of [...sessions.values()]) {
      finalizeAgentSession(socket, session, 'stopped');
    }
  }

  return {
    createAgentSession,
    focusAgentHost,
    listProviders: providerRegistry.listProviders,
    resizeAgentSession,
    serializeAgentSession,
    stopAgentSession,
    stopAllSocketAgentSessions,
    writeToAgentSession,
  };
}

module.exports = {
  createAgentPtyService,
};

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

  function createAgentSession(socket, {
    providerId,
    hostId,
    cols = AGENT_DEFAULT_COLS,
    rows = AGENT_DEFAULT_ROWS,
  }) {
    const sessions = getSocketAgentSessionMap(socket.id);
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
      const isWin = os.platform() === 'win32';
      let command = provider.command;
      let args = provider.args || [];

      // Windows 兼容：npm 全局包（如 claude）是 .ps1 脚本，node-pty 无法直接执行
      // 改为通过 powershell.exe 调用
      if (isWin) {
        const { findExecutableCommand } = require('./windows-compat');
        const resolved = findExecutableCommand(command);
        if (resolved) {
          command = resolved.command;
          args = [...resolved.args, ...args];
        }
      }

      const ptyProcess = pty.spawn(command, args, {
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

      // 注入目标主机上下文：claude 启动后等待界面就绪，再发送初始提示
      if (host.id !== 'local') {
        const hostDesc = `${host.username}@${host.host}:${host.port}`;
        const prompt = `你现在的任务是通过 1Shell MCP 工具管理远程主机 ${hostDesc}（主机ID: ${host.id}，名称: ${host.name}）。执行任何 shell 命令时，必须调用 mcp__1shell__execute_command 工具并传入 hostId="${host.id}"，不要在本机直接执行命令。`;
        setTimeout(() => {
          if (!session.isFinalized) session.write(prompt + '\r');
        }, 2500);
      }

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

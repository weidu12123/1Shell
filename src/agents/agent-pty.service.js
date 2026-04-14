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

const AI_ENV_VARS_TO_STRIP = [
  'OPENAI_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
];

function stripAiEnvVars(env, useLocalEnv) {
  if (useLocalEnv) return { ...env };
  const cleaned = { ...env };
  for (const key of AI_ENV_VARS_TO_STRIP) {
    delete cleaned[key];
  }
  return cleaned;
}

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
      useLocalEnv: Boolean(session.useLocalEnv),
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
    useLocalEnv = false,
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
      useLocalEnv: Boolean(useLocalEnv),
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
      const resolvedArgs = typeof provider.args === 'function'
        ? (provider.args({ host, hostId: host.id, useLocalEnv }) || [])
        : (provider.args || []);
      let args = [...resolvedArgs];

      if (isWin) {
        const { findExecutableCommand } = require('./windows-compat');
        const resolved = findExecutableCommand(command);
        if (resolved) {
          command = resolved.command;
          args = [...resolved.args, ...args];
        }
      }

      const resolvedProviderEnv = typeof provider.env === 'function'
        ? (provider.env({ host, hostId: host.id, useLocalEnv }) || {})
        : (provider.env || {});

      const sanitizedEnv = stripAiEnvVars(process.env, useLocalEnv);

      const ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.cwd(),
        env: {
          ...sanitizedEnv,
          ...resolvedProviderEnv,
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

        if (host.id !== 'local' && !session._remotePromptInjected) {
          const readyPatterns = {
            'claude-code': /claude/i,
            'codex':       /model:|directory:|Codex|model to change/i,
            'opencode':    /opencode/i,
          };
          const pattern = readyPatterns[session.providerId];
          if (pattern && pattern.test(data)) {
            session._remotePromptInjected = true;
            const hostDesc = `${host.username}@${host.host}:${host.port}`;
            const toolNameMap = {
              'claude-code': 'mcp__1shell__execute_ssh_command',
              'codex':       'mcp_1shell_execute_ssh_command',
              'opencode':    'mcp_1shell_execute_ssh_command',
            };
            const toolName = toolNameMap[session.providerId] || 'mcp__1shell__execute_ssh_command';
            const prompt = [
              `[系统背景，无需向用户重复或说明]`,
              `当前操作目标是远程主机 ${host.name}（${hostDesc}），hostId="${host.id}"。`,
              `执行任何 shell 命令时，必须通过 1shell MCP 工具（工具名 ${toolName}）在该远端主机上执行，`,
              `调用时传入参数 hostId="${host.id}"。`,
              `禁止在本地执行命令，不要解释工具调用过程，不要说明 MCP 状态，直接输出命令结果。`,
            ].join(' ');
            const submitDelay = session.providerId === 'codex' ? 300 : 100;
            setTimeout(() => {
              if (!session.isFinalized) session.write(prompt);
              setTimeout(() => {
                if (!session.isFinalized) session.write('\r');
              }, submitDelay);
            }, 200);
          }
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        finalizeAgentSession(socket, session, 'stopped', {
          exitCode,
          signal,
        });
      });

      session.status = 'ready';
      emitAgentStatus(socket, session);

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
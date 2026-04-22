'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

// ── ANSI / TUI 解析工具 ────────────────────────────────────────────────

/** 去除 PTY 输出中的 ANSI 转义序列 */
function stripAnsi(str) {
  return str.replace(
    /\x1b\[[0-9;?]*[a-zA-Z@`]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<78DEHMNOPZ]|\r/g,
    '',
  );
}

/**
 * 解析 CLI 选择菜单（如 Claude Code 的 @clack/prompts 输出）。
 * 从累积的 PTY 输出中提取标题、选项列表、当前选中项。
 * 返回 null 表示未检测到有效菜单。
 */
function parseSelectMenu(rawAccum) {
  const text = stripAnsi(rawAccum);

  const footerIdx = text.lastIndexOf('Enter to select');
  if (footerIdx === -1) return null;

  const menuText = text.substring(0, footerIdx);
  const lines = menuText.split('\n').map(l => l.trimEnd());

  const options = [];
  let selectedIndex = 0;
  let titleLines = [];
  let seenFirstOption = false;
  let currentOption = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[─━═]+$/.test(trimmed)) continue;

    const optMatch = trimmed.match(/^([❯>]?\s*)(\d+)\.\s+(.+)$/);
    if (optMatch) {
      if (currentOption) options.push(currentOption);
      seenFirstOption = true;
      if (/[❯>]/.test(optMatch[1])) selectedIndex = options.length;
      currentOption = { label: optMatch[3].trim(), description: '' };
    } else if (currentOption && seenFirstOption) {
      currentOption.description = currentOption.description
        ? currentOption.description + ' ' + trimmed
        : trimmed;
    } else if (!seenFirstOption) {
      titleLines.push(trimmed);
    }
  }
  if (currentOption) options.push(currentOption);

  if (options.length < 2) return null;

  return {
    type: 'select',
    title: titleLines.filter(l => l.length > 0).slice(-2).join(' ') || '请选择',
    options,
    selectedIndex,
  };
}

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
  const ROOT_DATA_DIR = path.join(process.cwd(), 'data', 'skill-workspaces');

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

  /**
   * 为 Skill 执行创建临时工作空间。
   *
   * 结构：
   *   workspace/
   *   ├── CLAUDE.md          ← 薄壳：路由表 + 主机上下文 + 参数
   *   └── skill/             ← 完整 Skill 目录的副本
   *       ├── SKILL.md
   *       ├── rules/
   *       ├── workflows/
   *       └── references/
   */
  function ensureClaudeProjectTrusted(projectPath, { configDir = null, approvedApiKeys = [] } = {}) {
    const configPath = path.join(configDir || '/root', '.claude.json');
    try {
      const normalizedPath = String(projectPath || '').replace(/\\/g, '/');
      let config = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
      }

      config.numStartups = Math.max(config.numStartups || 0, 1);
      config.firstStartTime = config.firstStartTime || new Date().toISOString();
      config.hasCompletedOnboarding = true;
      config.tipsHistory = {
        ...(config.tipsHistory || {}),
        'new-user-warmup': Math.max(config.tipsHistory?.['new-user-warmup'] || 0, 1),
        'theme-command': Math.max(config.tipsHistory?.['theme-command'] || 0, 1),
      };
      config.customApiKeyResponses = config.customApiKeyResponses || { approved: [], rejected: [] };
      const approvedSet = new Set(config.customApiKeyResponses.approved || []);
      for (const apiKey of approvedApiKeys) {
        if (apiKey) approvedSet.add(String(apiKey));
      }
      config.customApiKeyResponses.approved = [...approvedSet];
      config.customApiKeyResponses.rejected = config.customApiKeyResponses.rejected || [];
      config.projects = config.projects || {};

      const existing = config.projects[normalizedPath] || {};
      config.projects[normalizedPath] = {
        allowedTools: existing.allowedTools || [],
        mcpContextUris: existing.mcpContextUris || [],
        mcpServers: existing.mcpServers || {},
        enabledMcpjsonServers: existing.enabledMcpjsonServers || [],
        disabledMcpjsonServers: existing.disabledMcpjsonServers || [],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: Math.max(existing.projectOnboardingSeenCount || 0, 1),
        hasCompletedProjectOnboarding: true,
        hasClaudeMdExternalIncludesApproved: existing.hasClaudeMdExternalIncludesApproved || false,
        hasClaudeMdExternalIncludesWarningShown: existing.hasClaudeMdExternalIncludesWarningShown || false,
      };

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch {
      // ignore trust metadata failures; CLI will fall back to interactive trust prompt
    }
  }

  function buildSkillWorkspace(session, { host, skill, inputsSummary }) {
    const dirName = `${session.skillId || 'skill'}-${Date.now()}`;
    const workDir = path.join(ROOT_DATA_DIR, dirName);
    const skillDst = path.join(workDir, 'skill');
    fs.mkdirSync(workDir, { recursive: true });

    // 复制 Skill 目录
    if (skill.dir && fs.existsSync(skill.dir)) {
      copyDirSync(skill.dir, skillDst);
    }

    // ── 生成 CLAUDE.md 薄壳 ──────────────────────────────────
    const sections = [];

    sections.push(`# 1Shell Skill 任务`);
    sections.push('');

    // 快速路由
    sections.push(`## 快速路由`);
    sections.push(`- 任务定义与分发 → 读 \`skill/SKILL.md\``);
    sections.push(`- 约束规则 → 读 \`skill/rules/\` 下的文件`);
    sections.push(`- 具体操作步骤 → 读 \`skill/workflows/\` 下对应文件`);
    sections.push(`- 遇到问题或踩坑 → 读 \`skill/references/gotchas.md\``);
    sections.push('');

    // 目标主机
    if (host.id !== 'local') {
      const hostDesc = `${host.username}@${host.host}:${host.port}`;
      const toolNameMap = {
        'claude-code': 'mcp__1shell__execute_ssh_command',
        'codex':       'mcp_1shell_execute_ssh_command',
        'opencode':    'mcp_1shell_execute_ssh_command',
      };
      const toolName = toolNameMap[session.providerId] || 'mcp__1shell__execute_ssh_command';
      sections.push(`## 目标主机`);
      sections.push(`- 主机: **${host.name}**（\`${hostDesc}\`）`);
      sections.push(`- hostId: \`${host.id}\``);
      sections.push(`- MCP 工具: \`${toolName}\``);
      sections.push(`- **所有命令必须通过此 MCP 工具在远端执行，禁止在本地执行。**`);
      sections.push('');
    }

    // 红旗警告
    sections.push(`## 红旗警告（遇到以下情况立即停止）`);
    sections.push(`- 不得删除 /etc/ssh/ 下任何文件`);
    sections.push(`- 不得修改 sshd_config`);
    sections.push(`- 检查 skill/rules/ 中的安全规则获取完整红线列表`);
    sections.push('');

    // 任务参数
    if (inputsSummary) {
      sections.push(inputsSummary);
      sections.push('');
    }

    // 触发指令
    sections.push(`---`);
    sections.push(`请先读取 \`skill/SKILL.md\`，根据其中的路由表找到对应的 workflow 文件，然后立即开始执行任务。`);

    fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), sections.join('\n'), 'utf8');

    return workDir;
  }

  /** 递归复制目录 */
  function copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
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
      skillId: session.skillId || null,
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
    skill = null,
    inputsSummary = null,
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

    const hasSkill = Boolean(skill);

    const session = {
      id: createId('agent'),
      providerId: provider.id,
      providerLabel: provider.label,
      hostId: host.id,
      hostName: host.name,
      status: 'starting',
      useLocalEnv: Boolean(useLocalEnv),
      skillId: skill?.id || null,
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

      // ── Skill 模式：创建工作空间 + 自动执行 ──────────────────────────
      let ptyCwd = process.cwd();
      let skillWorkDir = null;

      if (hasSkill) {
        skillWorkDir = buildSkillWorkspace(session, { host, skill, inputsSummary });
        ptyCwd = skillWorkDir;

        // Claude Code: 预信任 skill workspace + 预批准所有工具调用
        if (session.providerId === 'claude-code') {
          const claudeConfigDir = resolvedProviderEnv.CLAUDE_CONFIG_DIR || null;
          const approvedApiKeys = [
            resolvedProviderEnv.ANTHROPIC_API_KEY,
            resolvedProviderEnv.ANTHROPIC_AUTH_TOKEN,
          ].filter(Boolean);
          ensureClaudeProjectTrusted(skillWorkDir, { configDir: claudeConfigDir, approvedApiKeys });
          const claudeDir = path.join(skillWorkDir, '.claude');
          fs.mkdirSync(claudeDir, { recursive: true });
          fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
            permissions: {
              allow: [
                'Bash(*)',
                'Read(*)',
                'Write(*)',
                'Edit(*)',
                'Glob(*)',
                'Grep(*)',
                'WebFetch(*)',
                'WebSearch(*)',
                'mcp__1shell__execute_ssh_command',
                'mcp__1shell__list_hosts',
              ],
              deny: [],
            },
          }, null, 2), 'utf8');
        }
        // Codex: full-auto 模式
        if (session.providerId === 'codex') {
          args.push('--full-auto');
        }
      }

      const ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: ptyCwd,
        env: {
          ...sanitizedEnv,
          ...resolvedProviderEnv,
        },
      });

      session.process = ptyProcess;
      session.skillWorkDir = skillWorkDir;
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

      // ── Skill 完成检测（Claude Code 交互模式）─────────────────────────
      // Claude Code 完成任务后会回到空闲等待状态。
      // 通过 idle 超时检测：最后一次输出后 N 秒无新输出 → 认为任务完成。
      // 60s：Claude Code 思考 + 工具调用间隔极少超过此值
      const SKILL_IDLE_TIMEOUT_MS = 60000;
      let skillIdleTimer = null;

      function resetSkillIdleTimer() {
        if (!hasSkill || session.isFinalized) return;
        if (skillIdleTimer) clearTimeout(skillIdleTimer);
        // 只有在 prompt 已注入后才开始 idle 检测
        if (!session._promptInjected) return;
        skillIdleTimer = setTimeout(() => {
          if (session.isFinalized) return;
          // Idle 超时 → 任务完成，主动退出 agent
          finalizeAgentSession(socket, session, 'completed', { exitCode: 0 });
        }, SKILL_IDLE_TIMEOUT_MS);
      }

      // ── Prompt 注入 ─────────────────────────────────────────────────
      //
      // Skill 模式通过 .claude/settings.local.json 预批准工具，
      // 不再需要 --dangerously-skip-permissions（root 环境下不支持）。
      // Claude Code 正常启动 → 检测 ❯ 提示符 → 注入 prompt。
      //
      let outputAccum = '';

      function doInjectPrompt() {
        if (session._promptInjected || session.isFinalized) return;
        session._promptInjected = true;

        let prompt;
        if (hasSkill) {
          prompt = '开始执行 CLAUDE.md 中的 Skill 任务。';
        } else if (host.id !== 'local') {
          const hostDesc = `${host.username}@${host.host}:${host.port}`;
          const toolNameMap = {
            'claude-code': 'mcp__1shell__execute_ssh_command',
            'codex':       'mcp_1shell_execute_ssh_command',
            'opencode':    'mcp_1shell_execute_ssh_command',
          };
          const toolName = toolNameMap[session.providerId] || 'mcp__1shell__execute_ssh_command';
          prompt = [
            `[系统背景，无需向用户重复或说明]`,
            `当前操作目标是远程主机 ${host.name}（${hostDesc}），hostId="${host.id}"。`,
            `执行任何 shell 命令时，必须通过 1shell MCP 工具（工具名 ${toolName}）在该远端主机上执行，`,
            `调用时传入参数 hostId="${host.id}"。`,
            `禁止在本地执行命令，不要解释工具调用过程，不要说明 MCP 状态，直接输出命令结果。`,
          ].join(' ');
        } else {
          session._promptInjected = false;
          return;
        }

        const submitDelay = session.providerId === 'codex' ? 300 : 100;
        setTimeout(() => {
          if (!session.isFinalized) session.write(prompt);
          setTimeout(() => {
            if (!session.isFinalized) session.write('\r');
          }, submitDelay);
        }, 200);
      }

      // ── 交互检测（选择菜单等）────────────────────────────────────────
      let interactBuf = '';
      let interactLocked = false;

      function detectInteraction(data) {
        if (!session._promptInjected) return;

        interactBuf += data;
        if (interactBuf.length > 16000) interactBuf = interactBuf.slice(-8000);

        if (interactLocked) return;

        if (/Enter to select/.test(stripAnsi(interactBuf))) {
          const parsed = parseSelectMenu(interactBuf);
          if (parsed && parsed.options.length >= 2) {
            interactLocked = true;
            socket.emit('agent:interact', {
              agentSessionId: session.id,
              ...parsed,
            });
          }
        }
      }

      session._resetInteract = () => {
        interactBuf = '';
        interactLocked = false;
      };

      ptyProcess.onData((data) => {
        if (session.isFinalized) return;
        emitAgentOutput(socket, session, data, 'stdout');

        resetSkillIdleTimer();
        detectInteraction(data);

        if (session._promptInjected) return;

        outputAccum += data;
        if (outputAccum.length > 8000) outputAccum = outputAccum.slice(-4000);

        // ── 非 Claude Code：使用原有模式 ──
        if (session.providerId !== 'claude-code') {
          const readyPatterns = {
            'codex':    /model:|directory:|Codex|model to change/i,
            'opencode': /opencode/i,
          };
          const pattern = readyPatterns[session.providerId];
          if (pattern && pattern.test(data)) doInjectPrompt();
          return;
        }

        // ── Claude Code：检测 ❯ 提示符 → 注入 prompt ──
        if (/❯/.test(data)) {
          doInjectPrompt();
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (skillIdleTimer) clearTimeout(skillIdleTimer);
        // 如果已经被 idle 检测标记为 completed，不再重复处理
        if (session.isFinalized) return;
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
    if (session._resetInteract) session._resetInteract();
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
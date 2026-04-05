'use strict';

const {
  AGENT_DEFAULT_PROVIDER,
} = require('../../config/env');

/**
 * Agent Provider 注册表
 *
 * 每个 provider 描述如何在主控机上启动对应的 AI CLI 工具（PTY spawn）。
 *
 * 字段说明：
 *   id      — 唯一标识，前后端通信使用
 *   label   — 用户可见名称
 *   command — 可执行文件名（需在 PATH 中）
 *   args    — 启动参数
 *   env     — 额外环境变量（合并到 process.env）
 *
 * 注意：command 若不存在，PTY spawn 会抛出错误并被 agent-pty.service.js 捕获。
 * 前端展示所有 provider，启动时才会知道是否真正可用。
 */

function createClaudeCodeProvider() {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    args: [],
    env: {
      CLAUDE_CODE_ENTRYPOINT: '1shell-agent-panel',
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    },
  };
}

function createGeminiCliProvider() {
  return {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    command: 'gemini',
    args: [],
    env: {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    },
  };
}

function createOpenCodeProvider() {
  return {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: [],
    env: {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    },
  };
}

function createAgentProviders() {
  const providers = [
    createClaudeCodeProvider(),
    createGeminiCliProvider(),
    createOpenCodeProvider(),
  ];

  const providerMap = new Map(providers.map((p) => [p.id, p]));

  function listProviders() {
    return providers.map((p) => ({
      id: p.id,
      label: p.label,
      isDefault: p.id === AGENT_DEFAULT_PROVIDER,
    }));
  }

  function getProvider(providerId = AGENT_DEFAULT_PROVIDER) {
    return providerMap.get(providerId)
      || providerMap.get(AGENT_DEFAULT_PROVIDER)
      || providers[0]
      || null;
  }

  return { getProvider, listProviders };
}

module.exports = { createAgentProviders };

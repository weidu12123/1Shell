'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Router } = require('express');
const { BRIDGE_TOKEN, PORT } = require('../config/env');

/**
 * Agent Setup Routes
 *
 * 一键将 1Shell MCP Server 注册到各 CLI 工具的配置文件，
 * 让用户无需手动编辑任何 JSON 或 YAML。
 *
 * GET  /api/agent/mcp-status
 *   检查各 CLI 工具的 MCP 配置现状
 *
 * POST /api/agent/mcp-setup
 *   Body: { provider: 'claude-code' | 'gemini-cli' | 'opencode', serverUrl?: string }
 *   自动写入/更新对应工具的配置文件，完成 MCP 接入
 *
 * POST /api/agent/mcp-remove
 *   Body: { provider: 'claude-code' | 'gemini-cli' | 'opencode' }
 *   从配置文件中移除 1shell 条目
 */
function createAgentSetupRouter() {
  const router = Router();

  // ─── 各 CLI 工具的 MCP 配置路径与写入逻辑 ──────────────────────────────

  /**
   * 构造 1Shell MCP server 条目（供各 provider 写入）。
   */
  function buildMcpEntry(serverUrl) {
    return {
      type: 'sse',
      url: `${serverUrl}/mcp/sse`,
      headers: { 'X-Bridge-Token': BRIDGE_TOKEN },
    };
  }

  /**
   * Claude Code：~/.claude/settings.json
   * 结构：{ mcpServers: { "1shell": { type, url, headers } } }
   */
  function setupClaudeCode(serverUrl) {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};

    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      // 文件不存在或格式错误，从空对象开始
    }

    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
      settings.mcpServers = {};
    }

    settings.mcpServers['1shell'] = buildMcpEntry(serverUrl);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return { configFile: settingsPath, key: 'mcpServers["1shell"]' };
  }

  /**
   * 检查 Claude Code 当前配置状态。
   */
  function statusClaudeCode() {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const entry = settings?.mcpServers?.['1shell'];
      if (entry) {
        return { configured: true, configFile: settingsPath, url: entry.url };
      }
    } catch {
      // 未配置
    }
    return { configured: false, configFile: settingsPath };
  }

  /**
   * 从 Claude Code 配置中移除 1shell 条目。
   */
  function removeClaudeCode() {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings?.mcpServers?.['1shell']) {
        delete settings.mcpServers['1shell'];
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return { removed: true, configFile: settingsPath };
      }
    } catch {
      // 文件不存在，忽略
    }
    return { removed: false, configFile: settingsPath };
  }

  // ─── 路由处理 ─────────────────────────────────────────────────────────────

  function resolveServerUrl(reqBody, req) {
    if (reqBody?.serverUrl && typeof reqBody.serverUrl === 'string') {
      return reqBody.serverUrl.replace(/\/$/, '');
    }
    // 从当前请求推断本机地址
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }

  const SUPPORTED_PROVIDERS = ['claude-code', 'gemini-cli', 'opencode'];

  // GET /api/agent/mcp-status
  router.get('/agent/mcp-status', (req, res) => {
    const bridgeReady = Boolean(BRIDGE_TOKEN);
    const status = {
      bridgeReady,
      providers: {
        'claude-code': statusClaudeCode(),
        // Gemini CLI 和 OpenCode 暂不支持 MCP，跳过
      },
    };
    return res.json({ ok: true, status });
  });

  // POST /api/agent/mcp-setup
  router.post('/agent/mcp-setup', (req, res) => {
    const { provider } = req.body || {};

    if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        ok: false,
        error: `provider 必须为 ${SUPPORTED_PROVIDERS.join(' / ')} 之一`,
        code: 'BAD_REQUEST',
      });
    }

    if (!BRIDGE_TOKEN) {
      return res.status(503).json({
        ok: false,
        error: 'BRIDGE_TOKEN 尚未就绪（服务器启动异常）',
        code: 'BRIDGE_NOT_READY',
      });
    }

    const serverUrl = resolveServerUrl(req.body, req);

    try {
      if (provider === 'claude-code') {
        const result = setupClaudeCode(serverUrl);
        return res.json({ ok: true, provider, ...result, serverUrl });
      }

      // Gemini CLI / OpenCode：尚未正式支持 MCP，返回提示
      return res.json({
        ok: true,
        provider,
        note: `${provider} 暂不支持 MCP 协议，已使用 PTY 透传 + 1shell-exec 方式接入，无需额外配置。`,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message, code: 'WRITE_ERROR' });
    }
  });

  // POST /api/agent/mcp-remove
  router.post('/agent/mcp-remove', (req, res) => {
    const { provider } = req.body || {};

    try {
      if (provider === 'claude-code') {
        const result = removeClaudeCode();
        return res.json({ ok: true, provider, ...result });
      }
      return res.json({ ok: true, provider, removed: false, note: '该 provider 无需移除配置' });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message, code: 'WRITE_ERROR' });
    }
  });

  return router;
}

module.exports = { createAgentSetupRouter };

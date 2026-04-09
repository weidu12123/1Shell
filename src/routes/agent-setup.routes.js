'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Router } = require('express');
const { BRIDGE_TOKEN, PORT } = require('../config/env');

/**
 * Agent Setup Routes — 2.0 重构
 *
 * 统一的 AI CLI 检测 / 一键接入 / 断开 / 诊断 框架。
 *
 * GET  /api/agent/scan           扫描所有已知 CLI 工具（安装 + 配置状态）
 * GET  /api/agent/endpoints      返回 1Shell 的 Bridge / MCP 端点信息
 * GET  /api/agent/diagnostics    连通性诊断
 * POST /api/agent/mcp-setup      一键接入指定 CLI
 * POST /api/agent/mcp-remove     断开指定 CLI
 * GET  /api/agent/mcp-status     （兼容旧接口）
 */
function createAgentSetupRouter() {
  const router = Router();
  const isWindows = os.platform() === 'win32';
  const home = os.homedir();

  // ─── CLI 工具注册表 ─────────────────────────────────────────────────
  // 每个 CLI 定义：
  //   id, name, icon, gradient, repo, description,
  //   binary: 用于 which/where 检测的命令名,
  //   configPath: 配置文件路径（绝对），
  //   protocol: 'mcp' | 'bridge' | 'none'
  //   setup(serverUrl): 写入配置 → { configFile, detail }
  //   check(): 检查配置状态 → { configured, configFile, detail }
  //   remove(): 移除配置 → { removed, configFile }

  const CLI_REGISTRY = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      icon: '✦',
      gradient: 'from-orange-400 to-pink-500',
      repo: 'anthropics/claude-code',
      description: 'Anthropic 官方 CLI，通过 MCP server 调用 1Shell 的主机连接、命令执行能力。',
      binary: 'claude',
      configPath: path.join(home, '.claude', 'settings.json'),
      protocol: 'mcp',
      setup(serverUrl) {
        let settings = safeReadJSON(this.configPath) || {};
        if (!settings.mcpServers || typeof settings.mcpServers !== 'object') settings.mcpServers = {};
        settings.mcpServers['1shell'] = buildMcpEntry(serverUrl);
        safeWriteJSON(this.configPath, settings);
        return { configFile: this.configPath, detail: 'mcpServers["1shell"] 已写入' };
      },
      check() {
        const settings = safeReadJSON(this.configPath);
        const entry = settings?.mcpServers?.['1shell'];
        return entry
          ? { configured: true, configFile: this.configPath, detail: `MCP URL: ${entry.url}` }
          : { configured: false, configFile: this.configPath };
      },
      remove() {
        const settings = safeReadJSON(this.configPath);
        if (settings?.mcpServers?.['1shell']) {
          delete settings.mcpServers['1shell'];
          safeWriteJSON(this.configPath, settings);
          return { removed: true, configFile: this.configPath };
        }
        return { removed: false, configFile: this.configPath };
      },
    },
    {
      id: 'cursor',
      name: 'Cursor',
      icon: '⌬',
      gradient: 'from-violet-500 to-fuchsia-500',
      repo: 'cursor-ai/cursor',
      description: 'AI 代码编辑器，支持通过 MCP 调用远程工具。',
      binary: isWindows ? 'cursor.cmd' : 'cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      protocol: 'mcp',
      setup(serverUrl) {
        let config = safeReadJSON(this.configPath) || {};
        if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
        config.mcpServers['1shell'] = buildMcpEntry(serverUrl);
        safeWriteJSON(this.configPath, config);
        return { configFile: this.configPath, detail: 'mcpServers["1shell"] 已写入' };
      },
      check() {
        const config = safeReadJSON(this.configPath);
        const entry = config?.mcpServers?.['1shell'];
        return entry
          ? { configured: true, configFile: this.configPath, detail: `MCP URL: ${entry.url}` }
          : { configured: false, configFile: this.configPath };
      },
      remove() {
        const config = safeReadJSON(this.configPath);
        if (config?.mcpServers?.['1shell']) {
          delete config.mcpServers['1shell'];
          safeWriteJSON(this.configPath, config);
          return { removed: true, configFile: this.configPath };
        }
        return { removed: false, configFile: this.configPath };
      },
    },
    {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      icon: '◎',
      gradient: 'from-slate-700 to-slate-900',
      repo: 'openai/codex',
      description: 'OpenAI 官方终端 Agent，通过 MCP 与 1Shell 协作执行远程命令。',
      binary: 'codex',
      configPath: path.join(home, '.codex', 'mcp.json'),
      protocol: 'mcp',
      setup(serverUrl) {
        let config = safeReadJSON(this.configPath) || {};
        if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
        config.mcpServers['1shell'] = buildMcpEntry(serverUrl);
        safeWriteJSON(this.configPath, config);
        return { configFile: this.configPath, detail: 'mcpServers["1shell"] 已写入' };
      },
      check() {
        const config = safeReadJSON(this.configPath);
        const entry = config?.mcpServers?.['1shell'];
        return entry
          ? { configured: true, configFile: this.configPath, detail: `MCP URL: ${entry.url}` }
          : { configured: false, configFile: this.configPath };
      },
      remove() {
        const config = safeReadJSON(this.configPath);
        if (config?.mcpServers?.['1shell']) {
          delete config.mcpServers['1shell'];
          safeWriteJSON(this.configPath, config);
          return { removed: true, configFile: this.configPath };
        }
        return { removed: false, configFile: this.configPath };
      },
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      icon: '◈',
      gradient: 'from-blue-400 to-cyan-500',
      repo: 'google/gemini-cli',
      description: 'Google 官方 Gemini 终端 CLI，支持 MCP 协议扩展。',
      binary: 'gemini',
      configPath: path.join(home, '.gemini', 'settings.json'),
      protocol: 'mcp',
      setup(serverUrl) {
        let config = safeReadJSON(this.configPath) || {};
        if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
        config.mcpServers['1shell'] = buildMcpEntry(serverUrl);
        safeWriteJSON(this.configPath, config);
        return { configFile: this.configPath, detail: 'mcpServers["1shell"] 已写入' };
      },
      check() {
        const config = safeReadJSON(this.configPath);
        const entry = config?.mcpServers?.['1shell'];
        return entry
          ? { configured: true, configFile: this.configPath, detail: `MCP URL: ${entry.url}` }
          : { configured: false, configFile: this.configPath };
      },
      remove() {
        const config = safeReadJSON(this.configPath);
        if (config?.mcpServers?.['1shell']) {
          delete config.mcpServers['1shell'];
          safeWriteJSON(this.configPath, config);
          return { removed: true, configFile: this.configPath };
        }
        return { removed: false, configFile: this.configPath };
      },
    },
    {
      id: 'cline',
      name: 'Cline',
      icon: '⬢',
      gradient: 'from-amber-400 to-orange-500',
      repo: 'cline/cline',
      description: 'VSCode AI Agent 插件，通过 MCP 协议与 1Shell 协作。',
      binary: null, // VSCode 插件，没有独立二进制
      configPath: path.join(home, '.vscode', 'cline_mcp_settings.json'),
      protocol: 'mcp',
      setup(serverUrl) {
        let config = safeReadJSON(this.configPath) || {};
        if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
        config.mcpServers['1shell'] = buildMcpEntry(serverUrl);
        safeWriteJSON(this.configPath, config);
        return { configFile: this.configPath, detail: 'mcpServers["1shell"] 已写入' };
      },
      check() {
        const config = safeReadJSON(this.configPath);
        const entry = config?.mcpServers?.['1shell'];
        return entry
          ? { configured: true, configFile: this.configPath, detail: `MCP URL: ${entry.url}` }
          : { configured: false, configFile: this.configPath };
      },
      remove() {
        const config = safeReadJSON(this.configPath);
        if (config?.mcpServers?.['1shell']) {
          delete config.mcpServers['1shell'];
          safeWriteJSON(this.configPath, config);
          return { removed: true, configFile: this.configPath };
        }
        return { removed: false, configFile: this.configPath };
      },
    },
    {
      id: 'aider',
      name: 'Aider',
      icon: '⬡',
      gradient: 'from-green-400 to-emerald-500',
      repo: 'paul-gauthier/aider',
      description: '开源 AI pair programmer，暂不支持 MCP，可通过 1Shell Bridge API 手动集成。',
      binary: 'aider',
      configPath: null,
      protocol: 'none',
      setup() { return { configFile: null, detail: 'Aider 暂不支持 MCP 协议，请使用 Bridge API 手动集成' }; },
      check() { return { configured: false, configFile: null, detail: '暂不支持自动配置' }; },
      remove() { return { removed: false, configFile: null }; },
    },
  ];

  // ─── 工具函数 ─────────────────────────────────────────────────────────

  function buildMcpEntry(serverUrl) {
    return {
      type: 'sse',
      url: `${serverUrl}/mcp/sse`,
      headers: { 'X-Bridge-Token': BRIDGE_TOKEN },
    };
  }

  function safeReadJSON(filePath) {
    if (!filePath) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  }

  function safeWriteJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  function detectBinary(name) {
    if (!name) return { installed: false };
    try {
      const cmd = isWindows ? `where ${name} 2>NUL` : `which ${name} 2>/dev/null`;
      const result = execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim();
      if (result) {
        return { installed: true, path: result.split('\n')[0].trim() };
      }
    } catch { /* not found */ }
    return { installed: false };
  }

  function resolveServerUrl(reqBody, req) {
    if (reqBody?.serverUrl && typeof reqBody.serverUrl === 'string') {
      return reqBody.serverUrl.replace(/\/$/, '');
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }

  function maskToken(token) {
    if (!token || token.length < 12) return '****';
    return token.substring(0, 6) + '…' + token.substring(token.length - 4);
  }

  // ─── 路由 ─────────────────────────────────────────────────────────────

  // 扫描所有 CLI 工具
  router.get('/agent/scan', (_req, res) => {
    const tools = CLI_REGISTRY.map((cli) => {
      const binary = detectBinary(cli.binary);
      const config = cli.check();
      let status;
      if (config.configured) status = 'connected';
      else if (binary.installed || (cli.binary === null && fs.existsSync(cli.configPath || ''))) status = 'detected';
      else status = 'missing';

      return {
        id: cli.id,
        name: cli.name,
        icon: cli.icon,
        gradient: cli.gradient,
        repo: cli.repo,
        description: cli.description,
        protocol: cli.protocol,
        status,
        binary: { name: cli.binary, ...binary },
        config: { ...config, configPath: cli.configPath },
      };
    });

    const counts = {
      total: tools.length,
      connected: tools.filter((t) => t.status === 'connected').length,
      detected: tools.filter((t) => t.status === 'detected').length,
      missing: tools.filter((t) => t.status === 'missing').length,
    };

    return res.json({ ok: true, tools, counts });
  });

  // 端点信息
  router.get('/agent/endpoints', (req, res) => {
    const serverUrl = resolveServerUrl(null, req);
    return res.json({
      ok: true,
      endpoints: {
        bridge: { url: `${serverUrl}/api/bridge`, protocol: 'REST' },
        mcp: { url: `${serverUrl}/mcp/sse`, protocol: 'SSE' },
      },
      token: {
        masked: maskToken(BRIDGE_TOKEN),
        ready: Boolean(BRIDGE_TOKEN),
      },
    });
  });

  // 诊断
  router.get('/agent/diagnostics', async (req, res) => {
    const serverUrl = resolveServerUrl(null, req);
    const checks = [];

    // Bridge 端点自检
    try {
      const start = Date.now();
      const resp = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      checks.push({ name: 'Bridge 端点响应', ok: resp.ok, ms: Date.now() - start });
    } catch (err) {
      checks.push({ name: 'Bridge 端点响应', ok: false, error: err.message });
    }

    // MCP SSE 端点自检
    try {
      const start = Date.now();
      const resp = await fetch(`${serverUrl}/mcp/sse`, {
        headers: { 'X-Bridge-Token': BRIDGE_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
      // SSE 会 200 并保持连接，我们只需确认 200
      checks.push({ name: 'MCP SSE 握手', ok: resp.ok || resp.status === 200, ms: Date.now() - start });
      // 立即中断连接
      try { resp.body?.cancel(); } catch { /* ignore */ }
    } catch (err) {
      checks.push({ name: 'MCP SSE 握手', ok: false, error: err.message });
    }

    // Token 检查
    checks.push({ name: 'Bridge Token', ok: Boolean(BRIDGE_TOKEN), detail: BRIDGE_TOKEN ? '已配置' : '未配置' });

    return res.json({ ok: true, checks });
  });

  // 一键接入
  router.post('/agent/mcp-setup', (req, res) => {
    const { provider } = req.body || {};
    const cli = CLI_REGISTRY.find((c) => c.id === provider);
    if (!cli) {
      return res.status(400).json({ ok: false, error: `不支持的 provider: ${provider}` });
    }
    if (!BRIDGE_TOKEN) {
      return res.status(503).json({ ok: false, error: 'BRIDGE_TOKEN 尚未就绪' });
    }
    try {
      const serverUrl = resolveServerUrl(req.body, req);
      const result = cli.setup(serverUrl);
      return res.json({ ok: true, provider: cli.id, ...result, serverUrl });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 断开
  router.post('/agent/mcp-remove', (req, res) => {
    const { provider } = req.body || {};
    const cli = CLI_REGISTRY.find((c) => c.id === provider);
    if (!cli) {
      return res.status(400).json({ ok: false, error: `不支持的 provider: ${provider}` });
    }
    try {
      const result = cli.remove();
      return res.json({ ok: true, provider: cli.id, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 兼容旧接口
  router.get('/agent/mcp-status', (_req, res) => {
    const tools = CLI_REGISTRY.map((cli) => ({ id: cli.id, ...cli.check() }));
    return res.json({ ok: true, bridgeReady: Boolean(BRIDGE_TOKEN), providers: tools });
  });

  return router;
}

module.exports = { createAgentSetupRouter };

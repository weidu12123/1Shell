'use strict';

const { Router } = require('express');
const { BRIDGE_TOKEN, PORT } = require('../config/env');
const { getAllManifests, getManifest, UPSTREAM_LABELS } = require('../agents/cli-manifest');

/**
 * Agent Setup Routes — 3.0 Sandbox
 *
 * GET  /api/agent/scan                            扫描所有 CLI（含沙箱状态）
 * GET  /api/agent/endpoints                       1Shell 端点信息
 * GET  /api/agent/diagnostics                     连通性诊断
 * POST /api/agent/sandbox/ensure/:cliId           确保沙箱就绪
 * POST /api/agent/sandbox/reset/:cliId            重置沙箱
 * GET  /api/agent/sandbox/status/:cliId           查询沙箱状态
 * GET  /api/agent/launch-command/:cliId           获取启动命令
 * GET  /api/agent/providers/:cliId                列出某 CLI 的所有 Provider
 * POST /api/agent/providers/:cliId                添加 Provider
 * PUT  /api/agent/providers/:cliId/:pid            更新 Provider
 * DELETE /api/agent/providers/:cliId/:pid          删除 Provider
 * PUT  /api/agent/providers/:cliId/:pid/activate    设为活跃
 */
function createAgentSetupRouter({ proxyConfigStore, cliSandbox } = {}) {
  const router = Router();

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

  // ─── 扫描所有 CLI 工具 ────────────────────────────────────────────────
  router.get('/agent/scan', (req, res) => {
    if (!cliSandbox) {
      return res.json({ ok: false, error: 'CLI 沙箱管理器未初始化' });
    }

    const tools = cliSandbox.getScanInfo();

    const counts = {
      total: tools.length,
      sandboxed: tools.filter(t => t.status === 'sandboxed').length,
      detected: tools.filter(t => t.status === 'detected').length,
      missing: tools.filter(t => t.status === 'missing').length,
    };

    return res.json({ ok: true, tools, counts, upstreamLabels: UPSTREAM_LABELS });
  });

  // ─── 端点信息 ─────────────────────────────────────────────────────────
  router.get('/agent/endpoints', (req, res) => {
    const serverUrl = resolveServerUrl(null, req);
    return res.json({
      ok: true,
      endpoints: {
        bridge: { url: `${serverUrl}/api/bridge`, protocol: 'REST' },
        mcp: { url: `${serverUrl}/mcp/sse`, protocol: 'SSE' },
      },
      token: { masked: maskToken(BRIDGE_TOKEN), ready: Boolean(BRIDGE_TOKEN) },
    });
  });

  // ─── 诊断 ─────────────────────────────────────────────────────────────
  router.get('/agent/diagnostics', async (req, res) => {
    const serverUrl = resolveServerUrl(null, req);
    const checks = [];
    try {
      const start = Date.now();
      const resp = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      checks.push({ name: 'Bridge 端点响应', ok: resp.ok, ms: Date.now() - start });
    } catch (err) {
      checks.push({ name: 'Bridge 端点响应', ok: false, error: err.message });
    }
    try {
      const start = Date.now();
      const resp = await fetch(`${serverUrl}/mcp/sse`, {
        headers: { 'X-Bridge-Token': BRIDGE_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
      checks.push({ name: 'MCP SSE 握手', ok: resp.ok || resp.status === 200, ms: Date.now() - start });
      try { resp.body?.cancel(); } catch { /* ignore */ }
    } catch (err) {
      checks.push({ name: 'MCP SSE 握手', ok: false, error: err.message });
    }
    checks.push({ name: 'Bridge Token', ok: Boolean(BRIDGE_TOKEN), detail: BRIDGE_TOKEN ? '已配置' : '未配置' });
    return res.json({ ok: true, checks });
  });

  // ─── 沙箱管理 ──────────────────────────────────────────────────────────

  function requireSandbox(req, res) {
    if (!cliSandbox) {
      res.status(503).json({ ok: false, error: 'CLI 沙箱管理器未初始化' });
      return false;
    }
    return true;
  }

  function validateCli(cliId, res) {
    if (!getManifest(cliId)) {
      res.status(400).json({ ok: false, error: `未知 CLI: ${cliId}` });
      return false;
    }
    return true;
  }

  router.post('/agent/sandbox/ensure/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateCli(cliId, res)) return;

    try {
      const dir = cliSandbox.ensureSandbox(cliId, { cwd: req.body?.cwd || process.cwd() });
      const status = cliSandbox.getSandboxStatus(cliId);
      return res.json({ ok: true, cliId, sandboxDir: dir, ...status });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/sandbox/reset/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateCli(cliId, res)) return;

    const ok = cliSandbox.resetSandbox(cliId);
    return res.json({ ok, cliId });
  });

  router.get('/agent/sandbox/status/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateCli(cliId, res)) return;

    const status = cliSandbox.getSandboxStatus(cliId);
    return res.json({ ok: true, cliId, ...status });
  });

  router.get('/agent/launch-command/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateCli(cliId, res)) return;

    const shell = req.query.shell || (process.platform === 'win32' ? 'powershell' : 'bash');
    try {
      const command = cliSandbox.buildShellCommand(cliId, { shell });
      const manifest = getManifest(cliId);
      return res.json({
        ok: true,
        cliId,
        shell,
        command,
        vars: Object.fromEntries(
          Object.entries(cliSandbox.buildLaunchEnv(cliId))
            .filter(([k]) => k !== '1SHELL_MCP_TOKEN')
        ),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Per-CLI Provider CRUD ─────────────────────────────────────────────

  router.get('/agent/providers/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const result = proxyConfigStore.listProviders(req.params.cliId);
    return res.json({ ok: true, ...result });
  });

  router.post('/agent/providers/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const body = req.body || {};
    if (!body.apiBase || !body.apiKey) {
      return res.status(400).json({ ok: false, error: 'apiBase 和 apiKey 不能为空' });
    }
    const cli = getManifest(req.params.cliId);
    const allowed = cli?.supportedUpstream || ['openai'];
    const upstream = body.upstreamProtocol || 'openai';
    if (!allowed.includes(upstream)) {
      return res.status(400).json({ ok: false, error: `${cli.name} 不支持 ${upstream} 上游协议，可选: ${allowed.join(', ')}` });
    }
    const id = proxyConfigStore.addProvider(req.params.cliId, body);
    return res.json({ ok: true, id });
  });

  router.put('/agent/providers/:cliId/:pid', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const ok = proxyConfigStore.updateProvider(req.params.cliId, req.params.pid, req.body || {});
    if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
    return res.json({ ok: true });
  });

  router.delete('/agent/providers/:cliId/:pid', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const ok = proxyConfigStore.deleteProvider(req.params.cliId, req.params.pid);
    if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
    return res.json({ ok: true });
  });

  router.put('/agent/providers/:cliId/:pid/activate', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const ok = proxyConfigStore.setActive(req.params.cliId, req.params.pid);
    if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAgentSetupRouter };
'use strict';

const { Router } = require('express');

/**
 * MCP Servers Registry Routes
 *
 * GET    /api/mcp-servers           列表（authToken 掩码）
 * GET    /api/mcp-servers/:id       详情（authToken 掩码）
 * POST   /api/mcp-servers           新建
 * PUT    /api/mcp-servers/:id       更新
 * DELETE /api/mcp-servers/:id       删除
 */
function createMcpRegistryRouter({ mcpRegistry, localMcpService, localMcpDeployer }) {
  const router = Router();

  router.get('/mcp-servers', (_req, res) => {
    res.json({ ok: true, servers: mcpRegistry.listServers().map(enrichStatus) });
  });

  router.get('/mcp-servers/:id', (req, res) => {
    const s = mcpRegistry.getServer(req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'MCP Server 不存在' });
    const { authToken, ...rest } = s;
    res.json({ ok: true, server: enrichStatus({ ...rest, authTokenSet: Boolean(authToken) }) });
  });

  router.post('/mcp-servers', async (req, res) => {
    try {
      const server = mcpRegistry.createServer(req.body || {});
      await preloadIfExposed(server.id);
      res.status(201).json({ ok: true, server: enrichStatus(server) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/mcp-servers/deploy/inspect', async (req, res) => {
    if (!localMcpDeployer) return res.status(503).json({ ok: false, error: '本地 MCP 部署器未启用' });
    try {
      const result = await localMcpDeployer.inspect(req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/mcp-servers/deploy/register', async (req, res) => {
    if (!localMcpDeployer) return res.status(503).json({ ok: false, error: '本地 MCP 部署器未启用' });
    try {
      const result = await localMcpDeployer.register(req.body || {});
      res.status(201).json({
        ok: true,
        server: enrichStatus(result.server),
        steps: result.steps || [],
        preload: result.preload || null,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/mcp-servers/:id', async (req, res) => {
    try {
      const server = mcpRegistry.updateServer(req.params.id, req.body || {});
      if (!server) return res.status(404).json({ ok: false, error: 'MCP Server 不存在' });
      await syncRuntime(server.id);
      res.json({ ok: true, server: enrichStatus(server) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/mcp-servers/:id', (req, res) => {
    localMcpService?.stop?.(req.params.id);
    const ok = mcpRegistry.deleteServer(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'MCP Server 不存在' });
    res.json({ ok: true });
  });

  function enrichStatus(server) {
    if (!server) return server;
    const isLocal = server.type === 'local' || Boolean(server.command);
    const status = isLocal && localMcpService
      ? localMcpService.getStatus(server.id)
      : { status: isLocal ? 'unavailable' : 'remote', tools: [] };
    return {
      ...server,
      runtimeStatus: status.status,
      runtimeError: status.error || '',
      toolCount: Array.isArray(status.tools) ? status.tools.length : 0,
    };
  }

  async function syncRuntime(id) {
    const server = mcpRegistry.getServer(id);
    if (!server || !localMcpService) return;
    const isLocal = server.type === 'local' || Boolean(server.command);
    if (!isLocal) return;
    if (!server.enabled) {
      localMcpService.stop(server.id);
      return;
    }
    if (server.autoStart || server.exposeToIde !== false) {
      await preloadIfExposed(server.id);
    }
  }

  async function preloadIfExposed(id) {
    const server = mcpRegistry.getServer(id);
    if (!server || !localMcpService) return;
    const isLocal = server.type === 'local' || Boolean(server.command);
    if (!isLocal || !server.command || !server.enabled) return;
    if (server.exposeToIde === false && !server.autoStart) return;
    await localMcpService.start(server.id, server.command, { cwd: server.installDir || undefined });
  }

  return router;
}

module.exports = { createMcpRegistryRouter };
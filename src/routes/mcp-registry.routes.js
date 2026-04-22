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
function createMcpRegistryRouter({ mcpRegistry }) {
  const router = Router();

  router.get('/mcp-servers', (_req, res) => {
    res.json({ ok: true, servers: mcpRegistry.listServers() });
  });

  router.get('/mcp-servers/:id', (req, res) => {
    const s = mcpRegistry.getServer(req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'MCP Server 不存在' });
    const { authToken, ...rest } = s;
    res.json({ ok: true, server: { ...rest, authTokenSet: Boolean(authToken) } });
  });

  router.post('/mcp-servers', (req, res) => {
    try {
      const server = mcpRegistry.createServer(req.body || {});
      res.status(201).json({ ok: true, server });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/mcp-servers/:id', (req, res) => {
    try {
      const server = mcpRegistry.updateServer(req.params.id, req.body || {});
      if (!server) return res.status(404).json({ ok: false, error: 'MCP Server 不存在' });
      res.json({ ok: true, server });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/mcp-servers/:id', (req, res) => {
    const ok = mcpRegistry.deleteServer(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'MCP Server 不存在' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createMcpRegistryRouter };
'use strict';

const { Router } = require('express');

/**
 * MCP Routes
 *
 * GET  /mcp/sse      — 建立 SSE 长连接，客户端订阅此端点
 * POST /mcp/message  — 客户端发送 JSON-RPC 消息
 *
 * 鉴权：Header X-Bridge-Token（与 Bridge API 共享同一 token）。
 * 如果未配置 BRIDGE_TOKEN，MCP 端点返回 503。
 */
function createMcpRouter({ mcpService }) {
  const router = Router();

  function requireToken(req, res, next) {
    // 只接受 header 传 token，禁止 query param（防止进 access log / 浏览器历史）
    let token = req.headers['x-bridge-token'];
    if (!token) {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }
    if (!mcpService.validateToken(token)) {
      return res.status(401).json({
        ok: false,
        error: 'MCP Token 无效或未配置 BRIDGE_TOKEN',
        code: 'UNAUTHORIZED',
      });
    }
    return next();
  }

  // Streamable HTTP MCP：POST /mcp/sse — Codex v0.120+ 使用此协议
  router.post('/sse', requireToken, async (req, res) => {
    const msg = req.body;

    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    }

    const batch = Array.isArray(msg) ? msg : [msg];
    const results = [];

    for (const item of batch) {
      const result = await mcpService.handleDirectRequest(item);
      if (result) results.push(result);
    }

    if (results.length === 0) {
      return res.status(202).end();
    }

    if (Array.isArray(msg)) {
      return res.json(results);
    }
    return res.json(results[0]);
  });

  // SSE 连接端点
  router.get('/sse', requireToken, (req, res) => {
    // 设置 SSE 必要响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 关闭 nginx 缓冲
    res.flushHeaders();

    // 构造 baseUrl 用于生成 endpoint 事件
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const baseUrl = `${proto}://${host}`;

    const sessionId = mcpService.connect(res, baseUrl);

    // 客户端断开时清理 session
    req.on('close', () => {
      mcpService.disconnect(sessionId);
    });
  });

  // JSON-RPC 消息端点
  router.post('/message', requireToken, async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: '缺少 sessionId 参数', code: 'BAD_REQUEST' });
    }

    const msg = req.body;
    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({ ok: false, error: '请求体必须为 JSON 对象', code: 'BAD_REQUEST' });
    }

    const found = await mcpService.receiveMessage(sessionId, msg);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'MCP session 不存在或已断开', code: 'SESSION_NOT_FOUND' });
    }

    // MCP 规范：POST 响应为空 202
    return res.status(202).end();
  });

  return router;
}

module.exports = { createMcpRouter };

'use strict';

const { Router } = require('express');
const { BRIDGE_TOKEN } = require('../config/env');
const { normalizePort } = require('../utils/common');
const { BRIDGE_EXEC_TIMEOUT_MS } = require('../config/env');

/**
 * Bridge Routes
 *
 * 内部 HTTP API，供 1shell-exec 包装器和 MCP 工具调用。
 * 鉴权：Header X-Bridge-Token 必须匹配环境变量 BRIDGE_TOKEN。
 *
 * POST /api/internal/bridge/exec
 *   Body: { hostId: string, command: string, timeout?: number }
 *   Response: { ok: true, stdout, stderr, exitCode, durationMs }
 *         或  { ok: false, error: string, code: string }
 */
function createBridgeRouter({ bridgeService }) {
  const router = Router();

  // Token 鉴权中间件（仅限 /api/internal/** 路由使用）
  function requireBridgeToken(req, res, next) {
    if (!BRIDGE_TOKEN) {
      return res.status(503).json({
        ok: false,
        error: 'Bridge API 未启用：未配置 BRIDGE_TOKEN',
        code: 'BRIDGE_DISABLED',
      });
    }

    const token = req.headers['x-bridge-token'];
    if (!token || token !== BRIDGE_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: 'Bridge Token 无效',
        code: 'UNAUTHORIZED',
      });
    }

    return next();
  }

  router.post('/internal/bridge/exec', requireBridgeToken, async (req, res) => {
    const { hostId, command, timeout } = req.body || {};

    if (!hostId || typeof hostId !== 'string') {
      return res.status(400).json({ ok: false, error: 'hostId 必须为非空字符串', code: 'BAD_REQUEST' });
    }

    if (!command || typeof command !== 'string') {
      return res.status(400).json({ ok: false, error: 'command 必须为非空字符串', code: 'BAD_REQUEST' });
    }

    const timeoutMs = normalizePort(timeout, BRIDGE_EXEC_TIMEOUT_MS);

    try {
      const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip;
      const result = await bridgeService.execOnHost(hostId, command, timeoutMs, { source: 'bridge_api', clientIp });
      return res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === 'HOST_NOT_FOUND') {
        return res.status(404).json({ ok: false, error: err.message, code: err.code });
      }
      if (err.code === 'EXEC_TIMEOUT') {
        return res.status(408).json({ ok: false, error: err.message, code: err.code });
      }
      return res.status(500).json({ ok: false, error: err.message, code: err.code || 'INTERNAL_ERROR' });
    }
  });

  return router;
}

module.exports = { createBridgeRouter };

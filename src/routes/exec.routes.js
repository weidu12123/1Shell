'use strict';

const { Router } = require('express');

/**
 * Web Exec Routes — 前端直接执行远程命令（走 Web session 鉴权）
 *
 * 比 Bridge API（BRIDGE_TOKEN 鉴权）更轻量，专供前端 JS 直接调用。
 * 适用于容器管理等已知操作，不需要经过 AI Agent。
 *
 * POST /api/exec
 *   Body: { hostId, command, timeout? }
 *   Response: { ok, stdout, stderr, exitCode, durationMs }
 */
function createExecRouter({ bridgeService, hostService }) {
  const router = Router();

  router.post('/exec', async (req, res) => {
    const { hostId, command, timeout } = req.body || {};

    if (!hostId || typeof hostId !== 'string') {
      return res.status(400).json({ ok: false, error: 'hostId 不能为空' });
    }
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ ok: false, error: 'command 不能为空' });
    }

    // 安全检查：禁止明确的破坏性命令
    const dangerous = /\brm\s+-rf\s+\/\b|\bdd\s+if=|\bmkfs\b|\bsshd_config\b/i;
    if (dangerous.test(command)) {
      return res.status(403).json({ ok: false, error: '命令被安全策略阻止' });
    }

    const host = hostService.findHost(hostId);
    if (!host) {
      return res.status(404).json({ ok: false, error: '主机不存在' });
    }

    const timeoutMs = (typeof timeout === 'number' && timeout > 0) ? Math.min(timeout, 300000) : 30000;

    try {
      const result = await bridgeService.execOnHost(hostId, command, timeoutMs, { source: 'web_exec' });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createExecRouter };
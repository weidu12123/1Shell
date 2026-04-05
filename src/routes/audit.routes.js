'use strict';

const { Router } = require('express');

/**
 * Audit Routes
 *
 * GET /api/audit/logs?limit=50&offset=0
 *   查询审计日志（分页，最新在前）
 */
function createAuditRouter({ auditService }) {
  const router = Router();

  router.get('/audit/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = auditService.query({ limit, offset });
    res.json({ ok: true, ...result });
  });

  return router;
}

module.exports = { createAuditRouter };

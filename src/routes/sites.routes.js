'use strict';

const { Router } = require('express');

/**
 * Sites Routes — 网站配置扫描 + 删除 API
 *
 * POST /api/sites/scan            { hostId } → 扫描
 * POST /api/sites/delete/preview  { hostId, domain, confPath? } → 列出所有残留路径
 * POST /api/sites/delete          { hostId, domain, confPath?, options, flags } → 执行删除
 */
function createSitesRouter({ siteScanService, siteDeleteService, hostService }) {
  const router = Router();

  router.post('/sites/scan', async (req, res) => {
    const { hostId } = req.body || {};

    if (!hostId || typeof hostId !== 'string') {
      return res.status(400).json({ ok: false, error: 'hostId 不能为空' });
    }

    const host = hostService.findHost(hostId);
    if (!host) {
      return res.status(404).json({ ok: false, error: '主机不存在' });
    }

    try {
      console.log('[sites-route] Calling scanHost for:', hostId);
      const result = await siteScanService.scanHost(hostId);
      console.log('[sites-route] Scan completed, servers:', result.servers?.length);
      return res.json(result);
    } catch (err) {
      console.error('[sites-route] Error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/sites/delete/preview', async (req, res) => {
    const { hostId, domain, confPath } = req.body || {};
    if (!hostId || typeof hostId !== 'string') {
      return res.status(400).json({ ok: false, error: 'hostId 不能为空' });
    }
    if (!hostService.findHost(hostId)) {
      return res.status(404).json({ ok: false, error: '主机不存在' });
    }
    try {
      const result = await siteDeleteService.previewResidue(hostId, domain, confPath);
      return res.json(result);
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  router.post('/sites/delete', async (req, res) => {
    const { hostId, domain, confPath, options, flags } = req.body || {};
    if (!hostId || typeof hostId !== 'string') {
      return res.status(400).json({ ok: false, error: 'hostId 不能为空' });
    }
    if (!hostService.findHost(hostId)) {
      return res.status(404).json({ ok: false, error: '主机不存在' });
    }
    try {
      const result = await siteDeleteService.executeDelete(hostId, domain, confPath, options, flags);
      return res.json(result);
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSitesRouter };
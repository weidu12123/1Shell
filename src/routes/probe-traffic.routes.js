'use strict';

const express = require('express');

function createProbeTrafficRouter({ trafficService, hostService }) {
  const router = express.Router();

  function ensureHostExists(hostId) {
    if (hostId === 'local') return true;
    if (!hostService?.findHost) return true;
    return Boolean(hostService.findHost(hostId));
  }

  router.get('/probe-traffic/:hostId', (req, res, next) => {
    try {
      if (!ensureHostExists(req.params.hostId)) return res.status(404).json({ ok: false, error: '主机不存在' });
      const detail = trafficService.getDetail(req.params.hostId);
      res.json({ ok: true, ...detail });
    } catch (error) { next(error); }
  });

  router.put('/probe-traffic/:hostId/settings', (req, res, next) => {
    try {
      if (!ensureHostExists(req.params.hostId)) return res.status(404).json({ ok: false, error: '主机不存在' });
      const usage = trafficService.updateSettings(req.params.hostId, req.body || {});
      res.json({ ok: true, ...usage });
    } catch (error) { next(error); }
  });

  router.post('/probe-traffic/:hostId/calibrate', (req, res, next) => {
    try {
      if (!ensureHostExists(req.params.hostId)) return res.status(404).json({ ok: false, error: '主机不存在' });
      const usage = trafficService.calibrate(req.params.hostId, req.body?.valueBytes);
      res.json({ ok: true, ...usage });
    } catch (error) { next(error); }
  });

  router.post('/probe-traffic/:hostId/reset', (req, res, next) => {
    try {
      if (!ensureHostExists(req.params.hostId)) return res.status(404).json({ ok: false, error: '主机不存在' });
      const usage = trafficService.resetMonthly(req.params.hostId, { reason: 'manual' });
      if (!usage) return res.status(404).json({ ok: false, error: '该主机暂无流量记录' });
      res.json({ ok: true, ...usage });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = {
  createProbeTrafficRouter,
};

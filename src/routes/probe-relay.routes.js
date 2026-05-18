'use strict';

const express = require('express');

function createProbeRelayPublicRouter({ probeRelayService }) {
  const router = express.Router();

  router.get('/agent/probe/relay-snapshot', (req, res, next) => {
    try {
      probeRelayService.requireRelayToken(req);
      res.json(probeRelayService.buildRelaySnapshot());
    } catch (error) {
      next(error);
    }
  });

  router.post('/agent/probe/relay/install-token', (req, res, next) => {
    try {
      probeRelayService.requireRelayToken(req);
      const result = probeRelayService.createRelayInstallToken(req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function createProbeRelayAdminRouter({ probeRelayService, probeRelayInstallerService }) {
  const router = express.Router();

  router.post('/probe-relay/tokens', (req, res, next) => {
    try {
      res.json({ ok: true, ...probeRelayService.createRelayToken(req.body || {}) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/probe-relay/upstreams', (req, res, next) => {
    try {
      res.json({ ok: true, upstreams: probeRelayService.listUpstreams() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-relay/upstreams', (req, res, next) => {
    try {
      res.json({ ok: true, upstream: probeRelayService.upsertUpstream(req.body || {}) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-relay/upstreams/install', async (req, res, next) => {
    try {
      if (!probeRelayInstallerService) return res.status(501).json({ ok: false, error: 'Relay Agent 安装器未启用' });
      const result = await probeRelayInstallerService.installUpstream({ ...(req.body || {}), clientIp: req.ip });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/probe-relay/upstreams/:id', (req, res, next) => {
    try {
      res.json(probeRelayService.deleteUpstream(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-relay/upstreams/:id/sync', async (req, res, next) => {
    try {
      const probes = await probeRelayService.syncUpstreamById(req.params.id);
      res.json({ ok: true, count: probes.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createProbeRelayAdminRouter,
  createProbeRelayPublicRouter,
};

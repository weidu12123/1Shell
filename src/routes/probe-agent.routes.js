'use strict';

const express = require('express');
const { PORT } = require('../config/env');

function resolveServerUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function parseTimeQuery(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return new Date(String(value)).getTime();
}

function createProbeAgentPublicRouter({ probeAgentService }) {
  const router = express.Router();

  router.post('/agent/probe/register', (req, res, next) => {
    try {
      const result = probeAgentService.registerAgent(req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.post('/agent/probe/report', (req, res, next) => {
    try {
      const agent = probeAgentService.authenticateAgent(req.headers.authorization);
      if (!agent) return res.status(401).json({ ok: false, error: 'agent token 无效' });
      const result = probeAgentService.saveReport(agent, req.body || {});
      return res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/agent/probe/commands/next', async (req, res, next) => {
    try {
      const agent = probeAgentService.authenticateAgent(req.headers.authorization);
      if (!agent) return res.status(401).json({ ok: false, error: 'agent token 无效' });
      const command = await probeAgentService.waitForNextCommand(agent);
      if (!command) return res.status(204).end();
      return res.json({ ok: true, command });
    } catch (error) {
      next(error);
    }
  });

  router.post('/agent/probe/commands/:commandId/result', (req, res, next) => {
    try {
      const agent = probeAgentService.authenticateAgent(req.headers.authorization);
      if (!agent) return res.status(401).json({ ok: false, error: 'agent token 无效' });
      const result = probeAgentService.completeCommand(agent, req.params.commandId, req.body || {});
      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function createProbeAgentAdminRouter({ probeAgentService, probeAgentInstallerService, probeAggregatorService }) {
  const router = express.Router();

  router.post('/probe-agents/:hostId/install-token', (req, res, next) => {
    try {
      const result = probeAgentService.generateInstallToken(req.params.hostId);
      const serverUrl = String(req.body?.serverUrl || resolveServerUrl(req)).replace(/\/$/, '');
      res.json({
        ok: true,
        ...result,
        serverUrl,
        config: {
          hostId: result.hostId,
          installToken: result.installToken,
          serverUrl,
          registerUrl: `${serverUrl}/api/agent/probe/register`,
          reportUrl: `${serverUrl}/api/agent/probe/report`,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-agents/:hostId/install', async (req, res, next) => {
    try {
      if (!probeAgentInstallerService) return res.status(501).json({ ok: false, error: 'Agent 安装器未启用' });
      const serverUrl = String(req.body?.serverUrl || resolveServerUrl(req)).replace(/\/$/, '');
      const intervalSec = typeof req.body?.intervalSec === 'number' ? req.body.intervalSec : undefined;
      const relayUpstreamId = typeof req.body?.relayUpstreamId === 'string' ? req.body.relayUpstreamId : undefined;
      const install = await probeAgentInstallerService.install(req.params.hostId, {
        serverUrl,
        intervalSec,
        relayUpstreamId,
        clientIp: req.ip,
      });
      res.json({
        ok: true,
        hostId: install.hostId,
        expiresAt: install.expiresAt,
        serverUrl: install.serverUrl || serverUrl,
        relayUpstreamId: install.relayUpstreamId,
        result: install.result,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-agents/:hostId/uninstall', async (req, res, next) => {
    try {
      if (!probeAgentInstallerService) return res.status(501).json({ ok: false, error: 'Agent 安装器未启用' });
      const result = await probeAgentInstallerService.uninstall(req.params.hostId, { clientIp: req.ip });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-agents/:hostId/revoke', (req, res, next) => {
    try {
      res.json(probeAgentService.revokeAgent(req.params.hostId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-agents/:hostId/restart', async (req, res, next) => {
    try {
      if (!probeAgentInstallerService) return res.status(501).json({ ok: false, error: 'Agent 安装器未启用' });
      const result = await probeAgentInstallerService.restart(req.params.hostId, { clientIp: req.ip });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/probe-agents/:hostId/logs', async (req, res, next) => {
    try {
      if (!probeAgentInstallerService) return res.status(501).json({ ok: false, error: 'Agent 安装器未启用' });
      const lines = parseInt(req.query.lines, 10) || 200;
      const result = await probeAgentInstallerService.fetchLogs(req.params.hostId, { clientIp: req.ip, lines });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/probe-agents/:hostId/samples', (req, res, next) => {
    try {
      const minutes = parseInt(req.query.minutes, 10);
      const sinceMs = Number.isFinite(minutes) && minutes > 0
        ? Math.min(minutes, 60 * 24) * 60 * 1000
        : 60 * 60 * 1000;
      const samples = probeAgentService.getSampleHistory(req.params.hostId, { sinceMs });
      res.json({ ok: true, hostId: req.params.hostId, sinceMs, samples });
    } catch (error) {
      next(error);
    }
  });

  router.post('/probe-agents/samples-bulk', (req, res, next) => {
    try {
      const minutes = Number(req.body?.minutes);
      const sinceMs = Number.isFinite(minutes) && minutes > 0
        ? Math.min(minutes, 60 * 24) * 60 * 1000
        : 60 * 60 * 1000;
      const hostIds = Array.isArray(req.body?.hostIds) ? req.body.hostIds.filter((id) => typeof id === 'string').slice(0, 200) : [];
      const result = {};
      for (const hostId of hostIds) {
        result[hostId] = probeAgentService.getSampleHistory(hostId, { sinceMs });
      }
      res.json({ ok: true, sinceMs, samples: result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/probe-agents/:hostId/timeseries', (req, res, next) => {
    try {
      if (!probeAggregatorService) return res.status(501).json({ ok: false, error: '聚合服务未启用' });
      const now = Date.now();
      const to = parseTimeQuery(req.query.to, now);
      const from = parseTimeQuery(req.query.from, to - 24 * 60 * 60 * 1000);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        return res.status(400).json({ ok: false, error: 'from/to 参数非法' });
      }
      const resolution = typeof req.query.resolution === 'string' ? req.query.resolution : 'auto';
      const result = probeAggregatorService.listTimeseries(req.params.hostId, {
        fromMs: from,
        toMs: to,
        resolution,
      });
      res.json({
        ok: true,
        hostId: req.params.hostId,
        fromMs: from,
        toMs: to,
        resolution: result.resolution,
        points: result.points,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createProbeAgentAdminRouter,
  createProbeAgentPublicRouter,
};

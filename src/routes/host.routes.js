'use strict';

const express = require('express');
const { LOCAL_HOST_ID } = require('../config/env');
const { validateHostPayload, validateManualLocation } = require('../utils/validators');

function createHostRouter({ hostRepository, hostService, auditService, isUsingFallbackSecret, probeService, probeAgentService, probeRelayService, probeTrafficService, probeAggregatorService, alertService }) {
  const router = express.Router();

  function buildProbeMap() {
    const snapshot = probeService?.getLatestSnapshot?.();
    if (!snapshot?.generatedAt) {
      probeService?.refreshSnapshot?.().catch?.(() => {});
      return new Map();
    }
    const probes = Array.isArray(snapshot?.probes) ? snapshot.probes : [];
    return new Map(probes.filter((probe) => probe?.hostId).map((probe) => [probe.hostId, probe]));
  }

  function buildAlertCountMap() {
    const events = alertService?.listEvents?.({ status: 'firing', limit: 1000 }) || [];
    const counts = new Map();
    for (const event of events) {
      if (!event?.hostId) continue;
      counts.set(event.hostId, (counts.get(event.hostId) || 0) + 1);
    }
    return counts;
  }

  function cleanupProbeState(hostId) {
    probeAgentService?.purgeHost?.(hostId);
    probeService?.removeHost?.(hostId);
    probeRelayService?.evictHost?.(hostId);
    probeTrafficService?.deleteHost?.(hostId);
    probeAggregatorService?.deleteHost?.(hostId);
    alertService?.deleteHost?.(hostId);
  }

  router.get('/hosts', (_req, res) => {
    res.json({
      hosts: hostService.listHostsWithPreferences(),
      warnings: {
        usingFallbackSecret: isUsingFallbackSecret(),
      },
    });
  });

  router.get('/hosts/repository', async (_req, res, next) => {
    try {
      res.json({
        hosts: hostService.listRepositoryHosts({
          probeMap: buildProbeMap(),
          alertCountMap: buildAlertCountMap(),
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/hosts/console', (_req, res) => {
    res.json({
      hosts: hostService.listConsoleHosts(),
      warnings: {
        usingFallbackSecret: isUsingFallbackSecret(),
      },
    });
  });

  router.post('/hosts/console-order', (req, res, next) => {
    try {
      const hosts = hostService.setConsoleOrder(req.body?.hostIds, { replace: req.body?.replace === true });
      auditService?.log({
        action: 'host_console_order_update',
        source: 'web_ui',
        details: JSON.stringify({ count: Array.isArray(req.body?.hostIds) ? req.body.hostIds.length : 0, replace: req.body?.replace === true }),
        clientIp: req.ip,
      });
      res.json({ hosts });
    } catch (error) {
      next(error);
    }
  });

  router.post('/hosts', (req, res, next) => {
    try {
      const hosts = hostRepository.readStoredHosts();
      const nextHost = hostService.buildStoredHost(validateHostPayload(req.body));
      hosts.push(nextHost);
      hostRepository.writeStoredHosts(hosts);
      hostService.ensureDefaultPreference(nextHost.id);
      auditService?.log({ action: 'host_create', source: 'web_ui', hostId: nextHost.id, hostName: nextHost.name, clientIp: req.ip });
      res.status(201).json({ host: hostService.toPublicHost(nextHost) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/hosts/local-config', (req, res, next) => {
    try {
      const config = {
        name: String(req.body?.name || '').trim() || '本机',
        links: Array.isArray(req.body?.links) ? req.body.links : [],
      };
      hostService.saveLocalHostConfig(config);
      auditService?.log({ action: 'local_config_update', source: 'web_ui', hostId: LOCAL_HOST_ID, clientIp: req.ip });
      return res.json({ ok: true, config });
    } catch (error) {
      next(error);
    }
  });

  router.put('/hosts/:id', (req, res, next) => {
    try {
      const hostId = req.params.id;
      if (hostId === LOCAL_HOST_ID) {
        return res.status(400).json({ error: '请使用 PUT /api/hosts/local-config 更新本机配置' });
      }

      const hosts = hostRepository.readStoredHosts();
      const index = hosts.findIndex((item) => item.id === hostId);
      if (index === -1) return res.status(404).json({ error: '主机不存在' });

      const nextHost = hostService.buildStoredHost(validateHostPayload(req.body, { isEditing: true }), hosts[index]);
      hosts[index] = nextHost;
      hostRepository.writeStoredHosts(hosts);
      auditService?.log({ action: 'host_update', source: 'web_ui', hostId: nextHost.id, hostName: nextHost.name, clientIp: req.ip });
      return res.json({ host: hostService.toPublicHost(nextHost) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/hosts/:id/preference', (req, res, next) => {
    try {
      const preference = hostService.updateHostPreference(req.params.id, req.body || {});
      if (preference.archived) cleanupProbeState(req.params.id);
      auditService?.log({
        action: 'host_preference_update',
        source: 'web_ui',
        hostId: req.params.id,
        details: JSON.stringify(req.body || {}),
        clientIp: req.ip,
      });
      res.json({ preference });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/hosts/:id/location', (req, res, next) => {
    try {
      const hostId = req.params.id;
      const body = req.body || {};
      const nextLocation = 'manualLocation' in body
        ? validateManualLocation(body.manualLocation)
        : null;

      if (hostId === LOCAL_HOST_ID) {
        hostService.updateLocalHostManualLocation(nextLocation);
        auditService?.log({
          action: nextLocation ? 'host_location_set' : 'host_location_clear',
          source: 'web_ui',
          hostId,
          hostName: '本机',
          clientIp: req.ip,
        });
        return res.json({ host: hostService.getLocalHost() });
      }

      const hosts = hostRepository.readStoredHosts();
      const index = hosts.findIndex((item) => item.id === hostId);
      if (index === -1) return res.status(404).json({ error: '主机不存在' });

      hosts[index] = {
        ...hosts[index],
        manualLocation: nextLocation,
        updatedAt: new Date().toISOString(),
      };
      hostRepository.writeStoredHosts(hosts);

      auditService?.log({
        action: nextLocation ? 'host_location_set' : 'host_location_clear',
        source: 'web_ui',
        hostId,
        hostName: hosts[index].name,
        clientIp: req.ip,
      });

      return res.json({ host: hostService.toPublicHost(hosts[index]) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/hosts/:id', (req, res) => {
    const hostId = req.params.id;
    if (hostId === LOCAL_HOST_ID) {
      return res.status(400).json({ error: '本机为内置主机，不能删除' });
    }

    const hosts = hostRepository.readStoredHosts();
    const nextHosts = hosts.filter((item) => item.id !== hostId);
    if (nextHosts.length === hosts.length) {
      return res.status(404).json({ error: '主机不存在' });
    }

    hostRepository.writeStoredHosts(nextHosts);
    hostRepository.deleteHostPreference(hostId);
    cleanupProbeState(hostId);
    const deleted = hosts.find((item) => item.id === hostId);
    auditService?.log({ action: 'host_delete', source: 'web_ui', hostId, hostName: deleted?.name, clientIp: req.ip });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = {
  createHostRouter,
};

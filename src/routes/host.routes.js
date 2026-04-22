'use strict';

const express = require('express');
const { LOCAL_HOST_ID } = require('../config/env');
const { validateHostPayload } = require('../utils/validators');

function createHostRouter({ hostRepository, hostService, auditService, isUsingFallbackSecret }) {
  const router = express.Router();

  router.get('/hosts', (_req, res) => {
    res.json({
      hosts: hostService.listHosts(),
      warnings: {
        usingFallbackSecret: isUsingFallbackSecret(),
      },
    });
  });

  router.post('/hosts', (req, res, next) => {
    try {
      const hosts = hostRepository.readStoredHosts();
      const nextHost = hostService.buildStoredHost(validateHostPayload(req.body));
      hosts.push(nextHost);
      hostRepository.writeStoredHosts(hosts);
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
    const deleted = hosts.find((item) => item.id === hostId);
    auditService?.log({ action: 'host_delete', source: 'web_ui', hostId, hostName: deleted?.name, clientIp: req.ip });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = {
  createHostRouter,
};

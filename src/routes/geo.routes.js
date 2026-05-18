'use strict';

const express = require('express');

function createGeoRouter({ hostService, geoIpService, probeService }) {
  const router = express.Router();

  function pickProbeStatus(probe) {
    if (!probe) return {};
    return {
      online: Boolean(probe.online),
      stale: Boolean(probe.stale),
      probeSource: probe.source || 'ssh',
      probeCheckedAt: probe.checkedAt || null,
      probeLastSuccessAt: probe.lastSuccessAt || null,
      probeAgentOnline: typeof probe.agentOnline === 'boolean' ? probe.agentOnline : null,
      probeSshOnline: typeof probe.sshOnline === 'boolean' ? probe.sshOnline : null,
      probeError: probe.error || null,
    };
  }

  router.get('/geo/hosts', async (req, res, next) => {
    try {
      const hosts = hostService.listHosts();
      const resolved = [];
      const unresolved = [];
      let probeByHostId = new Map();

      if (probeService?.getLatestSnapshot) {
        const snapshot = probeService.getLatestSnapshot();
        probeByHostId = new Map((snapshot.probes || []).map((probe) => [probe.hostId, probe]));
      }

      const ROUTE_TIMEOUT_MS = 15_000;
      const deadline = Date.now() + ROUTE_TIMEOUT_MS;

      for (const h of hosts) {
        const probeStatus = pickProbeStatus(probeByHostId.get(h.id));
        if (Date.now() > deadline) {
          unresolved.push({ id: h.id, name: h.name, reason: 'timeout', ...probeStatus });
          continue;
        }
        const r = await geoIpService.resolveHost(h);
        if (r.ok) {
          resolved.push({
            id: h.id,
            name: h.name,
            host: h.host,
            ip: r.ip,
            country: r.country,
            countryCode: r.countryCode,
            region: r.region,
            regionName: r.regionName,
            city: r.city,
            lat: r.lat,
            lng: r.lng,
            source: r.source,
            ...probeStatus,
          });
        } else {
          unresolved.push({ id: h.id, name: h.name, reason: r.reason, ...probeStatus });
        }
      }

      res.json({
        hosts: resolved,
        unresolved,
        geoip: {
          provider: geoIpService.provider(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createGeoRouter };

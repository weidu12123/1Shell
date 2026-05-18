'use strict';

const express = require('express');

function createProbeDiagRouter({ diagService }) {
  const router = express.Router();

  function wrap(fn) {
    return async (req, res, next) => {
      try {
        const result = await fn(req);
        res.json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    };
  }

  router.post('/probe-diag/:hostId/ping', wrap((req) => diagService.ping(req.params.hostId, {
    target: req.body?.target,
    count: req.body?.count,
    timeoutSec: req.body?.timeoutSec,
    clientIp: req.ip,
  })));

  router.post('/probe-diag/:hostId/http', wrap((req) => diagService.http(req.params.hostId, {
    url: req.body?.url,
    method: req.body?.method,
    timeoutSec: req.body?.timeoutSec,
    clientIp: req.ip,
  })));

  router.post('/probe-diag/:hostId/dns', wrap((req) => diagService.dns(req.params.hostId, {
    name: req.body?.name,
    clientIp: req.ip,
  })));

  return router;
}

module.exports = {
  createProbeDiagRouter,
};

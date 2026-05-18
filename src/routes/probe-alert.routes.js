'use strict';

const express = require('express');

function createProbeAlertRouter({ alertService }) {
  const router = express.Router();

  router.get('/probe-alerts/rules', (req, res, next) => {
    try {
      res.json({ ok: true, rules: alertService.listRules() });
    } catch (error) { next(error); }
  });

  router.post('/probe-alerts/rules', (req, res, next) => {
    try {
      const rule = alertService.createRule(req.body || {});
      res.status(201).json({ ok: true, rule });
    } catch (error) { next(error); }
  });

  router.put('/probe-alerts/rules/:id', (req, res, next) => {
    try {
      const rule = alertService.updateRule(req.params.id, req.body || {});
      res.json({ ok: true, rule });
    } catch (error) { next(error); }
  });

  router.delete('/probe-alerts/rules/:id', (req, res, next) => {
    try {
      alertService.deleteRule(req.params.id);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/probe-alerts/events', (req, res, next) => {
    try {
      const status = String(req.query.status || 'open');
      const limit = parseInt(req.query.limit, 10);
      const offset = parseInt(req.query.offset, 10);
      const events = alertService.listEvents({ status, limit, offset });
      res.json({ ok: true, events, openCount: alertService.countOpenEvents() });
    } catch (error) { next(error); }
  });

  router.post('/probe-alerts/events/ack-all', (req, res, next) => {
    try {
      const result = alertService.ackOpenEvents();
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  router.post('/probe-alerts/events/:id/ack', (req, res, next) => {
    try {
      const result = alertService.ackEvent(req.params.id);
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = {
  createProbeAlertRouter,
};

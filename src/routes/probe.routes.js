'use strict';

const express = require('express');

function createProbeRouter({ probeService }) {
  const router = express.Router();

  router.get('/probes', async (req, res, next) => {
    try {
      const snapshot = await probeService.getSnapshot({ refresh: req.query.refresh === '1' });
      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createProbeRouter,
};

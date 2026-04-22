'use strict';

const express = require('express');

function createAuthRouter(authService) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      enabled: authService.isAuthEnabled(),
      authenticated: authService.isRequestAuthenticated(req),
    });
  });

  router.post('/login', (req, res, next) => {
    try {
      const ip = authService.getClientIp(req);
      const result = authService.login(req.body?.username, req.body?.password, ip);
      if (result.sessionId) {
        authService.setAuthCookie(res, result.sessionId, result.csrfToken, req);
      }
      res.json({
        ok: result.ok,
        enabled: result.enabled,
        authenticated: result.authenticated,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', (req, res) => {
    authService.logout(req);
    authService.clearAuthCookie(res);
    res.json({ ok: true });
  });

  return router;
}

module.exports = {
  createAuthRouter,
};

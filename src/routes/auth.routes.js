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

  router.put('/credentials', authService.requireAuth, (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username && !password) {
        return res.status(400).json({ error: '请提供用户名或密码' });
      }
      authService.updateCredentials(username, password);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
};

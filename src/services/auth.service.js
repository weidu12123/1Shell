'use strict';

const crypto = require('crypto');

const {
  AUTH_PASSWORD,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} = require('../config/env');
const { parseCookies } = require('../utils/common');

function createAuthService() {
  const authSessions = new Map();

  // 暴力破解防护：记录每个 IP 的失败次数与解锁时间
  const loginFailMap = new Map();
  const MAX_FAIL_COUNT = 5;
  const LOCKOUT_MS = 60 * 1000;

  function getClientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.socket?.remoteAddress || req.ip || 'unknown';
  }

  function isIpLockedOut(ip) {
    const record = loginFailMap.get(ip);
    if (!record) return false;
    if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
    // 解锁后清除记录
    if (record.lockedUntil && Date.now() >= record.lockedUntil) {
      loginFailMap.delete(ip);
    }
    return false;
  }

  function recordLoginFailure(ip) {
    const record = loginFailMap.get(ip) || { count: 0, lockedUntil: null };
    record.count += 1;
    if (record.count >= MAX_FAIL_COUNT) {
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    loginFailMap.set(ip, record);
  }

  function clearLoginFailure(ip) {
    loginFailMap.delete(ip);
  }

  function createAuthSession() {
    const sessionId = crypto.randomUUID();
    authSessions.set(sessionId, {
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return sessionId;
  }

  function clearExpiredAuthSessions() {
    const now = Date.now();
    for (const [sessionId, session] of authSessions.entries()) {
      if (!session || session.expiresAt <= now) {
        authSessions.delete(sessionId);
      }
    }
  }

  function getAuthSessionId(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[SESSION_COOKIE_NAME] || '';
  }

  function isRequestAuthenticated(req) {
    if (!AUTH_PASSWORD) return true;
    clearExpiredAuthSessions();
    const sessionId = getAuthSessionId(req);
    const session = authSessions.get(sessionId);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      authSessions.delete(sessionId);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return true;
  }

  function setAuthCookie(res, sessionId) {
    const secure = process.env.NODE_ENV === 'production';
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function requireAuth(req, res, next) {
    if (isRequestAuthenticated(req)) return next();
    return res.status(401).json({ error: '未登录或登录已失效' });
  }

  function isAuthEnabled() {
    return Boolean(AUTH_PASSWORD);
  }

  function login(password, ip = 'unknown') {
    if (!AUTH_PASSWORD) {
      return { ok: true, enabled: false, authenticated: true, sessionId: '' };
    }

    if (isIpLockedOut(ip)) {
      const error = new Error('登录失败次数过多，请 60 秒后再试');
      error.status = 429;
      throw error;
    }

    const normalizedPassword = String(password || '');
    // 使用 timingSafeEqual 防止时序攻击
    const passwordMatch = normalizedPassword.length === AUTH_PASSWORD.length
      && crypto.timingSafeEqual(Buffer.from(normalizedPassword), Buffer.from(AUTH_PASSWORD));
    if (!normalizedPassword || !passwordMatch) {
      recordLoginFailure(ip);
      const error = new Error('登录口令错误');
      error.status = 401;
      throw error;
    }

    clearLoginFailure(ip);
    return {
      ok: true,
      enabled: true,
      authenticated: true,
      sessionId: createAuthSession(),
    };
  }

  function logout(req) {
    const sessionId = getAuthSessionId(req);
    if (sessionId) authSessions.delete(sessionId);
  }

  function authenticateSocket(socket, next) {
    if (!AUTH_PASSWORD) return next();

    clearExpiredAuthSessions();

    const cookieHeader = socket.handshake.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies[SESSION_COOKIE_NAME] || '';
    const session = authSessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) authSessions.delete(sessionId);
      return next(new Error('UNAUTHORIZED'));
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    socket.authSessionId = sessionId;
    return next();
  }

  return {
    authenticateSocket,
    clearAuthCookie,
    clearExpiredAuthSessions,
    getClientIp,
    isAuthEnabled,
    isRequestAuthenticated,
    login,
    logout,
    requireAuth,
    setAuthCookie,
  };
}

module.exports = {
  createAuthService,
};

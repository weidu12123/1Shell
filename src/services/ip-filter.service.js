'use strict';

/**
 * IP 访问控制服务
 *
 * 支持白名单模式和黑名单模式：
 * - 白名单开启时：只允许名单内的 IP/CIDR 访问
 * - 黑名单开启时：拒绝名单内的 IP/CIDR 访问
 * - 两者可同时开启（先白名单，再黑名单）
 * - 均关闭时：不做任何限制
 *
 * 规则存储在 SQLite，热更新无需重启。
 */

const { TRUSTED_PROXY_IPS } = require('../config/env');

function createIpFilterService({ db }) {
  // 初始化数据库表
  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ip_filter_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('allow', 'deny')),
        cidr TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ip_filter_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO ip_filter_config(key, value) VALUES ('allowlist_enabled', '0');
      INSERT OR IGNORE INTO ip_filter_config(key, value) VALUES ('denylist_enabled', '0');
    `);
  }

  // ── 内存缓存（避免每次请求读库）──────────────────────────
  let cache = null;

  function loadCache() {
    if (!db) return { allowlistEnabled: false, denylistEnabled: false, allow: [], deny: [] };
    const cfgRows = db.prepare('SELECT key, value FROM ip_filter_config').all();
    const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
    const rules = db.prepare('SELECT type, cidr FROM ip_filter_rules').all();
    return {
      allowlistEnabled: cfg.allowlist_enabled === '1',
      denylistEnabled: cfg.denylist_enabled === '1',
      allow: rules.filter(r => r.type === 'allow').map(r => r.cidr),
      deny: rules.filter(r => r.type === 'deny').map(r => r.cidr),
    };
  }

  function getCache() {
    if (!cache) cache = loadCache();
    return cache;
  }

  function invalidateCache() {
    cache = null;
  }

  // ── CIDR 匹配工具 ─────────────────────────────────────────
  function ipToInt(ip) {
    // 处理 IPv4-mapped IPv6（::ffff:x.x.x.x）
    const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) ip = v4mapped[1];
    if (!ip.includes('.')) return null; // 纯 IPv6 暂不做 CIDR 细粒度匹配
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
  }

  function matchesCidr(ip, cidr) {
    // 支持精确 IP 和 CIDR 两种格式
    if (!cidr.includes('/')) return ip === cidr;
    const [base, bits] = cidr.split('/');
    const prefix = parseInt(bits, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
    const ipInt = ipToInt(ip);
    const baseInt = ipToInt(base);
    if (ipInt === null || baseInt === null) return ip === base; // IPv6 精确匹配
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }

  function isIpInList(ip, list) {
    return list.some(cidr => matchesCidr(ip, cidr));
  }

  // ── 提取客户端真实 IP ──────────────────────────────────────
  function getClientIp(req) {
    const remoteIp = req.socket?.remoteAddress || req.ip || 'unknown';
    if (TRUSTED_PROXY_IPS.length > 0 && TRUSTED_PROXY_IPS.includes(remoteIp)) {
      const forwarded = req.headers?.['x-forwarded-for'];
      if (forwarded) return String(forwarded).split(',')[0].trim();
    }
    return remoteIp;
  }

  // ── Express 中间件 ────────────────────────────────────────
  function ipFilterMiddleware(req, res, next) {
    const { allowlistEnabled, denylistEnabled, allow, deny } = getCache();
    if (!allowlistEnabled && !denylistEnabled) return next();

    const ip = getClientIp(req);

    if (allowlistEnabled && allow.length > 0) {
      if (!isIpInList(ip, allow)) {
        return res.status(403).json({ error: `IP ${ip} 不在访问白名单中` });
      }
    }

    if (denylistEnabled && deny.length > 0) {
      if (isIpInList(ip, deny)) {
        return res.status(403).json({ error: `IP ${ip} 已被列入黑名单` });
      }
    }

    return next();
  }

  // ── 规则 CRUD ─────────────────────────────────────────────
  function getRules() {
    if (!db) return { rules: [], allowlistEnabled: false, denylistEnabled: false };
    const { allowlistEnabled, denylistEnabled } = getCache();
    const rules = db.prepare('SELECT id, type, cidr, note, created_at FROM ip_filter_rules ORDER BY type, id').all();
    return { rules, allowlistEnabled, denylistEnabled };
  }

  function addRule({ type, cidr, note = '' }) {
    if (!db) throw Object.assign(new Error('数据库不可用'), { status: 503 });
    if (!['allow', 'deny'].includes(type)) throw Object.assign(new Error('type 必须为 allow 或 deny'), { status: 400 });
    if (!cidr || typeof cidr !== 'string') throw Object.assign(new Error('cidr 不能为空'), { status: 400 });
    // 基本格式校验
    const clean = cidr.trim();
    if (!/^[\d.:a-fA-F/]+$/.test(clean)) throw Object.assign(new Error('cidr 格式非法'), { status: 400 });

    const result = db.prepare(
      'INSERT INTO ip_filter_rules(type, cidr, note) VALUES (?, ?, ?)'
    ).run(type, clean, String(note).slice(0, 100));

    invalidateCache();
    return { id: result.lastInsertRowid, type, cidr: clean, note };
  }

  function deleteRule(id) {
    if (!db) throw Object.assign(new Error('数据库不可用'), { status: 503 });
    const result = db.prepare('DELETE FROM ip_filter_rules WHERE id = ?').run(Number(id));
    if (result.changes === 0) throw Object.assign(new Error('规则不存在'), { status: 404 });
    invalidateCache();
  }

  function setConfig({ allowlistEnabled, denylistEnabled }) {
    if (!db) throw Object.assign(new Error('数据库不可用'), { status: 503 });
    const upsert = db.prepare(
      'INSERT INTO ip_filter_config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    if (allowlistEnabled !== undefined) upsert.run('allowlist_enabled', allowlistEnabled ? '1' : '0');
    if (denylistEnabled !== undefined) upsert.run('denylist_enabled', denylistEnabled ? '1' : '0');
    invalidateCache();
  }

  return {
    ipFilterMiddleware,
    getRules,
    addRule,
    deleteRule,
    setConfig,
  };
}

module.exports = { createIpFilterService };
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('express');

/**
 * DNS Provider Routes — 管理域名 DNS 验证凭据（Cloudflare API Token 等）
 *
 * 持久化存储在 data/dns-providers.json，结构：
 * [
 *   { id, domain, provider, token, note, createdAt }
 * ]
 *
 * GET    /api/dns-providers         — 列出所有（token 脱敏）
 * POST   /api/dns-providers         — 添加
 * PUT    /api/dns-providers/:id     — 更新
 * DELETE /api/dns-providers/:id     — 删除
 */
function createDnsProviderRouter({ dataDir }) {
  const router = Router();
  const filePath = path.join(dataDir, 'dns-providers.json');

  function readAll() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return []; }
  }

  function writeAll(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function maskToken(token) {
    if (!token || token.length < 10) return '****';
    return token.substring(0, 5) + '…' + token.substring(token.length - 4);
  }

  function sanitize(entry) {
    return {
      id: entry.id,
      domain: entry.domain,
      provider: entry.provider,
      token: maskToken(entry.token),
      tokenSet: Boolean(entry.token),
      note: entry.note || '',
      createdAt: entry.createdAt,
    };
  }

  // 列出（脱敏）
  router.get('/dns-providers', (_req, res) => {
    const all = readAll();
    res.json({ ok: true, providers: all.map(sanitize) });
  });

  // 获取原始 token（仅内部使用，按 domain 查询）
  router.get('/dns-providers/token/:domain', (req, res) => {
    const domain = req.params.domain;
    const all = readAll();
    const entry = all.find(e => e.domain === domain);
    if (!entry) return res.status(404).json({ ok: false, error: '未找到该域名的 DNS 凭据' });
    res.json({ ok: true, token: entry.token, provider: entry.provider });
  });

  // 添加
  router.post('/dns-providers', (req, res) => {
    const { domain, provider, token, note } = req.body || {};
    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ ok: false, error: '域名不能为空' });
    }
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'API Token 不能为空' });
    }

    const all = readAll();
    // 同域名去重
    const existing = all.findIndex(e => e.domain === domain.trim());
    if (existing >= 0) {
      return res.status(409).json({ ok: false, error: `域名 ${domain} 已存在，请编辑而非重复添加` });
    }

    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      domain: domain.trim().toLowerCase(),
      provider: provider || 'cloudflare',
      token: token.trim(),
      note: (note || '').trim(),
      createdAt: new Date().toISOString(),
    };
    all.push(entry);
    writeAll(all);
    res.json({ ok: true, id: entry.id });
  });

  // 更新
  router.put('/dns-providers/:id', (req, res) => {
    const all = readAll();
    const idx = all.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: '不存在' });

    const { domain, provider, token, note } = req.body || {};
    if (domain) all[idx].domain = domain.trim().toLowerCase();
    if (provider) all[idx].provider = provider;
    if (token) all[idx].token = token.trim();
    if (note !== undefined) all[idx].note = (note || '').trim();
    writeAll(all);
    res.json({ ok: true });
  });

  // 删除
  router.delete('/dns-providers/:id', (req, res) => {
    const all = readAll();
    const idx = all.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: '不存在' });
    all.splice(idx, 1);
    writeAll(all);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createDnsProviderRouter };
'use strict';

const crypto = require('crypto');
const { createId, normalizeHttpUrl, nowIso } = require('../utils/common');

const RELAY_SYNC_TIMEOUT_MS = 10000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function maskToken(token) {
  const text = String(token || '');
  if (text.length <= 8) return '********';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function createProbeRelayService({ db, hostService, probeAgentService }) {
  const memory = {
    tokens: new Map(),
    upstreams: new Map(),
    latestByUpstream: new Map(),
  };

  const stmts = db ? {
    insertToken: db.prepare(`
      INSERT INTO probe_relay_tokens (token_hash, name, created_at, revoked_at)
      VALUES (?, ?, ?, NULL)
    `),
    getToken: db.prepare('SELECT * FROM probe_relay_tokens WHERE token_hash = ? AND revoked_at IS NULL'),
    insertUpstream: db.prepare(`
      INSERT INTO probe_relay_upstreams (id, name, relay_host_id, server_url, sync_token, enabled, last_sync_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `),
    updateUpstream: db.prepare(`
      UPDATE probe_relay_upstreams
      SET name = ?, relay_host_id = ?, server_url = ?, sync_token = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `),
    listUpstreams: db.prepare('SELECT * FROM probe_relay_upstreams ORDER BY created_at ASC'),
    getUpstream: db.prepare('SELECT * FROM probe_relay_upstreams WHERE id = ?'),
    deleteUpstream: db.prepare('DELETE FROM probe_relay_upstreams WHERE id = ?'),
    markSync: db.prepare('UPDATE probe_relay_upstreams SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?'),
    markError: db.prepare('UPDATE probe_relay_upstreams SET last_error = ?, updated_at = ? WHERE id = ?'),
  } : null;

  function createRelayToken({ name } = {}) {
    const token = createToken();
    const tokenHash = hashToken(token);
    const createdAt = nowIso();
    const label = String(name || 'Relay Token').trim() || 'Relay Token';

    if (stmts) stmts.insertToken.run(tokenHash, label, createdAt);
    else memory.tokens.set(tokenHash, { token_hash: tokenHash, name: label, created_at: createdAt, revoked_at: null });

    return { token, name: label, createdAt };
  }

  function authenticateRelayToken(authorization) {
    const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const tokenHash = hashToken(match[1]);
    return stmts ? stmts.getToken.get(tokenHash) : memory.tokens.get(tokenHash) || null;
  }

  function requireRelayToken(req) {
    const token = authenticateRelayToken(req.headers.authorization);
    if (!token) {
      const error = new Error('Relay token 无效');
      error.status = 401;
      throw error;
    }
    return token;
  }

  function normalizeUpstream(row, { includeToken = false } = {}) {
    let relayPort = null;
    try { relayPort = new URL(row.server_url).port || (new URL(row.server_url).protocol === 'https:' ? '443' : '80'); } catch { relayPort = null; }
    return {
      id: row.id,
      name: row.name,
      relayHostId: row.relay_host_id || '',
      relayPort,
      serverUrl: row.server_url,
      syncToken: includeToken ? row.sync_token : undefined,
      syncTokenMasked: maskToken(row.sync_token),
      enabled: Boolean(row.enabled),
      lastSyncAt: row.last_sync_at || null,
      lastError: row.last_error || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listUpstreams({ includeToken = false } = {}) {
    const rows = stmts ? stmts.listUpstreams.all() : Array.from(memory.upstreams.values());
    return rows.map((row) => normalizeUpstream(row, { includeToken }));
  }

  function buildServerUrlFromHost(host, portValue) {
    const port = Math.max(1, Math.min(parseInt(portValue, 10) || 3301, 65535));
    return `http://${host.host}:${port}`;
  }

  function upsertUpstream(payload = {}) {
    const id = String(payload.id || '').trim() || createId('probe_relay');
    const relayHostId = String(payload.relayHostId || '').trim();
    const relayHost = relayHostId ? hostService?.findHost(relayHostId) : null;
    const name = String(payload.name || relayHost?.name || 'Probe Relay').trim() || 'Probe Relay';
    const serverUrl = relayHost
      ? buildServerUrlFromHost(relayHost, payload.relayPort)
      : normalizeHttpUrl(String(payload.serverUrl || '')).replace(/\/$/, '');
    const requestedSyncToken = String(payload.syncToken || '').trim();
    const enabled = payload.enabled === false ? 0 : 1;
    const now = nowIso();
    const existing = stmts ? stmts.getUpstream.get(id) : memory.upstreams.get(id);
    const syncToken = requestedSyncToken || existing?.sync_token || '';

    if (relayHostId && !relayHost) {
      const error = new Error('选择的 Relay VPS 不存在');
      error.status = 404;
      throw error;
    }
    if (relayHost?.type === 'local') {
      const error = new Error('Relay 不能选择本机，请选择一台 VPS');
      error.status = 400;
      throw error;
    }
    if (!serverUrl) {
      const error = new Error('Relay Server URL 无效');
      error.status = 400;
      throw error;
    }
    if (!syncToken) {
      const error = new Error('Relay sync token 不能为空');
      error.status = 400;
      throw error;
    }

    if (stmts) {
      if (existing) stmts.updateUpstream.run(name, relayHostId || null, serverUrl, syncToken, enabled, now, id);
      else stmts.insertUpstream.run(id, name, relayHostId || null, serverUrl, syncToken, enabled, now, now);
      return normalizeUpstream(stmts.getUpstream.get(id));
    }

    const row = {
      id,
      name,
      relay_host_id: relayHostId || null,
      server_url: serverUrl,
      sync_token: syncToken,
      enabled,
      last_sync_at: existing?.last_sync_at || null,
      last_error: existing?.last_error || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    memory.upstreams.set(id, row);
    return normalizeUpstream(row);
  }

  function deleteUpstream(id) {
    if (stmts) stmts.deleteUpstream.run(id);
    else memory.upstreams.delete(id);
    memory.latestByUpstream.delete(id);
    return { ok: true };
  }

  function markSync(id, when = nowIso()) {
    if (stmts) stmts.markSync.run(when, when, id);
    else {
      const row = memory.upstreams.get(id);
      if (row) { row.last_sync_at = when; row.last_error = null; row.updated_at = when; }
    }
  }

  function markError(id, message) {
    const now = nowIso();
    if (stmts) stmts.markError.run(String(message || '').slice(0, 1000), now, id);
    else {
      const row = memory.upstreams.get(id);
      if (row) { row.last_error = String(message || '').slice(0, 1000); row.updated_at = now; }
    }
  }

  async function fetchJson(url, token, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_SYNC_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        const error = new Error(data?.error || text || `Relay 请求失败 (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (err) {
      if (err?.name === 'AbortError') {
        const error = new Error(`Relay 请求超时：${url}`);
        error.status = 504;
        throw error;
      }
      if (err?.message === 'fetch failed') {
        const error = new Error(`Relay 无法连接：${url}`);
        error.status = 502;
        throw error;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function timestampMs(...values) {
    for (const value of values) {
      const ms = new Date(value || 0).getTime();
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return 0;
  }

  function relayProbeRank(probe) {
    const lastSeenMs = timestampMs(probe.agentLastSeenAt, probe.checkedAt, probe.lastSuccessAt);
    return (probe.agentTrusted ? 2_000_000_000_000_000 : 0)
      + (probe.agentOnline || probe.online ? 1_000_000_000_000_000 : 0)
      + lastSeenMs;
  }

  function preferRelayProbe(current, next) {
    if (!current) return next;
    return relayProbeRank(next) >= relayProbeRank(current) ? next : current;
  }

  function dedupeRelayProbes(probes) {
    const byHostId = new Map();
    for (const probe of probes) {
      if (!probe?.hostId) continue;
      byHostId.set(probe.hostId, preferRelayProbe(byHostId.get(probe.hostId), probe));
    }
    return Array.from(byHostId.values());
  }

  function removeCachedHost(hostId, upstreamId = null) {
    let removed = 0;
    for (const [id, cached] of memory.latestByUpstream.entries()) {
      if (upstreamId && id !== upstreamId) continue;
      const probes = Array.isArray(cached?.probes) ? cached.probes : [];
      const kept = probes.filter((probe) => probe?.hostId !== hostId);
      removed += probes.length - kept.length;
      memory.latestByUpstream.set(id, { ...cached, probes: kept });
    }
    return removed;
  }

  function cachedUpstreamIdsForHost(hostId) {
    const ids = [];
    for (const [id, cached] of memory.latestByUpstream.entries()) {
      if (Array.isArray(cached?.probes) && cached.probes.some((probe) => probe?.hostId === hostId)) ids.push(id);
    }
    return ids;
  }

  function evictHost(hostId) {
    const cleanHostId = String(hostId || '').trim();
    if (!cleanHostId) return { ok: false, removedCached: 0 };
    return { ok: true, removedCached: removeCachedHost(cleanHostId) };
  }

  async function requestInstallToken(upstreamId, { hostId, ttlMs } = {}) {
    const row = stmts ? stmts.getUpstream.get(upstreamId) : memory.upstreams.get(upstreamId);
    if (!row) {
      const error = new Error('Relay 上游不存在');
      error.status = 404;
      throw error;
    }
    if (!row.enabled) {
      const error = new Error('Relay 上游未启用');
      error.status = 400;
      throw error;
    }
    const result = await fetchJson(`${row.server_url}/api/agent/probe/relay/install-token`, row.sync_token, { hostId, ttlMs });
    return { ...result, serverUrl: row.server_url };
  }

  async function forgetHost(hostId, { upstreamId = null } = {}) {
    const cleanHostId = String(hostId || '').trim();
    if (!cleanHostId) {
      const error = new Error('hostId 不能为空');
      error.status = 400;
      throw error;
    }
    const cachedIds = new Set(cachedUpstreamIdsForHost(cleanHostId));
    const cleanupRequired = Boolean(upstreamId || cachedIds.size > 0);
    const rows = (stmts ? stmts.listUpstreams.all() : Array.from(memory.upstreams.values()))
      .filter((row) => Boolean(row.enabled))
      .filter((row) => (upstreamId ? row.id === upstreamId : cachedIds.size === 0 || cachedIds.has(row.id)));
    const failures = [];
    let removedCached = 0;
    let touched = 0;

    for (const row of rows) {
      try {
        const result = await fetchJson(`${row.server_url}/api/agent/probe/relay/forget-host`, row.sync_token, { hostId: cleanHostId });
        touched += 1;
        removedCached += removeCachedHost(cleanHostId, row.id);
        markSync(row.id);
        if (result?.removedAgents || result?.removedLatest) continue;
      } catch (err) {
        markError(row.id, err.message);
        failures.push(`${row.name || row.id}: ${err.message}`);
      }
    }

    if (failures.length && cleanupRequired) {
      const error = new Error(`Relay 残留状态清理失败：${failures.join('；')}`);
      error.status = 502;
      error.removedCached = removedCached;
      error.touched = touched;
      throw error;
    }
    if (rows.length === 0) removedCached += removeCachedHost(cleanHostId, upstreamId);
    return { ok: true, hostId: cleanHostId, upstreamCount: touched, removedCached };
  }

  async function syncUpstream(row) {
    const startedAt = nowIso();
    try {
      const lastSyncMs = timestampMs(row.last_sync_at);
      const since = lastSyncMs
        ? `?since=${encodeURIComponent(new Date(lastSyncMs - 60_000).toISOString())}`
        : '';
      const snapshot = await fetchJson(`${row.server_url}/api/agent/probe/relay-snapshot${since}`, row.sync_token);
      const decorate = (probe) => ({
        ...probe,
        source: 'relay_agent',
        relaySource: true,
        relayId: row.id,
        relayName: row.name,
      });
      const samples = Array.isArray(snapshot?.samples) ? snapshot.samples.map(decorate) : [];
      for (const sample of samples) {
        if (hostService?.findHost && !hostService.findHost(sample.hostId)) continue;
        probeAgentService.saveExternalProbeSample?.(sample, { source: 'relay_agent' });
      }
      const probes = dedupeRelayProbes(Array.isArray(snapshot?.probes) ? snapshot.probes.map(decorate) : []);
      for (const probe of probes) {
        if (hostService?.findHost && !hostService.findHost(probe.hostId)) continue;
        probeAgentService.saveExternalProbeSample?.(probe, { source: 'relay_agent' });
      }
      memory.latestByUpstream.set(row.id, { generatedAt: snapshot?.generatedAt || startedAt, probes });
      markSync(row.id, startedAt);
      return probes;
    } catch (err) {
      markError(row.id, err.message);
      return memory.latestByUpstream.get(row.id)?.probes || [];
    }
  }

  async function syncUpstreamById(id) {
    const row = stmts ? stmts.getUpstream.get(id) : memory.upstreams.get(id);
    if (!row) {
      const error = new Error('Relay 上游不存在');
      error.status = 404;
      throw error;
    }
    if (!row.enabled) {
      const error = new Error('Relay 上游未启用');
      error.status = 400;
      throw error;
    }
    return syncUpstream(row);
  }

  async function syncAll() {
    const rows = (stmts ? stmts.listUpstreams.all() : Array.from(memory.upstreams.values()))
      .filter((row) => Boolean(row.enabled));
    if (rows.length === 0) return [];
    const batches = await Promise.all(rows.map(syncUpstream));
    return dedupeRelayProbes(batches.flat());
  }

  function buildRelaySnapshot() {
    const snapshot = probeAgentService.getRelaySnapshot();
    return { ok: true, relay: true, ...snapshot };
  }

  /**
   * 返回当前各 Relay 上游缓存里 Agent 在线的主机状态映射。
   * 用于 collectAllProbes() 在本地 SSH 探测前判断是否跳过。
   */
  function getRelayAgentStatusMap() {
    const map = new Map();
    const probes = [];
    for (const cached of memory.latestByUpstream.values()) {
      if (Array.isArray(cached?.probes)) probes.push(...cached.probes);
    }
    for (const probe of dedupeRelayProbes(probes)) {
      if (!probe?.hostId || !probe.agentOnline) continue;
      map.set(probe.hostId, {
        agentOnline: true,
        agentTrusted: Boolean(probe.agentTrusted),
        agentConsecutiveOk: Number(probe.agentConsecutiveOk || 0),
        agentFirstHealthyAt: probe.agentFirstHealthyAt || null,
        agentInstalled: true,
        agentLastSeenAt: probe.agentLastSeenAt || null,
        agentVersion: probe.agentVersion || null,
        agentStatus: probe.agentStatus || 'online',
        relaySource: true,
        relayId: probe.relayId || null,
        relayName: probe.relayName || null,
      });
    }
    return map;
  }

  function createRelayInstallToken({ hostId, ttlMs } = {}) {
    if (!hostId || typeof hostId !== 'string') {
      const error = new Error('hostId 不能为空');
      error.status = 400;
      throw error;
    }
    return probeAgentService.generateInstallToken(hostId, { ttlMs, skipHostCheck: true });
  }

  return {
    buildRelaySnapshot,
    createRelayInstallToken,
    createRelayToken,
    deleteUpstream,
    evictHost,
    forgetHost,
    getRelayAgentStatusMap,
    listUpstreams,
    requestInstallToken,
    requireRelayToken,
    syncAll,
    syncUpstreamById,
    upsertUpstream,
  };
}

module.exports = {
  createProbeRelayService,
};

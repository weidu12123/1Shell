'use strict';

const crypto = require('crypto');
const { createId, nowIso, parseNumber } = require('../utils/common');

const INSTALL_TOKEN_TTL_MS = 15 * 60 * 1000;
const AGENT_STALE_AFTER_MS = 3 * 60 * 1000;
const SAMPLE_RETENTION_MS = 24 * 60 * 60 * 1000;
const SAMPLE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const TRUST_MIN_HEARTBEATS = 1;
const TRUST_RESET_GAP_MS = 2 * AGENT_STALE_AFTER_MS;
const HEARTBEAT_COUNT_CAP = 10;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function usageFromBytes(value) {
  if (!value || !Number.isFinite(Number(value.total)) || Number(value.total) <= 0) return null;
  const used = Number(value.used || 0);
  const total = Number(value.total);
  return Number(((used / total) * 100).toFixed(2));
}

function isPayloadHealthy(body) {
  if (!body || typeof body !== 'object') return false;
  const cpu = parseNumber(body.cpu?.usage);
  const mem = parseNumber(body.memory?.usage) ?? usageFromBytes(body.memory);
  return Number.isFinite(cpu) && Number.isFinite(mem);
}

function normalizeAgentPayload(payload, agent = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const memoryUsage = parseNumber(body.memory?.usage) ?? usageFromBytes(body.memory);
  const swapUsage = parseNumber(body.swap?.usage) ?? usageFromBytes(body.swap);
  const diskUsage = parseNumber(body.disk?.usage)
    ?? parseNumber(body.disk?.partitions?.find?.((item) => item.mount === '/')?.usage)
    ?? parseNumber(body.disk?.partitions?.[0]?.usage);
  const reportedAt = body.timestamp || agent.last_seen_at || nowIso();

  return {
    hostId: agent.host_id || body.hostId,
    name: body.name,
    hostname: body.hostname,
    online: true,
    source: 'agent',
    agentInstalled: true,
    agentOnline: true,
    agentVersion: body.agentVersion || agent.agent_version || null,
    agentLastSeenAt: agent.last_seen_at || reportedAt,
    platform: body.platform || null,
    platformInfo: body.platformInfo && typeof body.platformInfo === 'object' ? body.platformInfo : null,
    latencyMs: null,
    cpuUsage: parseNumber(body.cpu?.usage),
    cpuCores: Array.isArray(body.cpu?.cores) ? body.cpu.cores.map(parseNumber).filter((v) => v !== null) : [],
    memoryUsage,
    swapUsage,
    diskUsage,
    diskPartitions: Array.isArray(body.disk?.partitions) ? body.disk.partitions : [],
    uptimeSec: Number.isFinite(Number(body.uptimeSec)) ? Number(body.uptimeSec) : null,
    checkedAt: reportedAt,
    lastSuccessAt: reportedAt,
    stale: false,
    error: null,
    errorCode: null,
    load1: parseNumber(body.load?.load1),
    load5: parseNumber(body.load?.load5),
    load15: parseNumber(body.load?.load15),
    processCount: Number.isFinite(Number(body.processCount)) ? Number(body.processCount) : null,
    keyProcesses: Array.isArray(body.keyProcesses) ? body.keyProcesses : [],
    bandwidthRxBps: parseNumber(body.network?.rxBps),
    bandwidthTxBps: parseNumber(body.network?.txBps),
    networkRxBytes: Number.isFinite(Number(body.network?.rxBytes)) ? Number(body.network.rxBytes) : null,
    networkTxBytes: Number.isFinite(Number(body.network?.txBytes)) ? Number(body.network.txBytes) : null,
    networkInterfaces: Array.isArray(body.network?.interfaces) ? body.network.interfaces : [],
    diskReadBps: parseNumber(body.disk?.readBps),
    diskWriteBps: parseNumber(body.disk?.writeBps),
  };
}

function createProbeAgentService({ db, hostService, trafficService = null }) {
  const memory = {
    installTokens: new Map(),
    agentsByHost: new Map(),
    agentsByTokenHash: new Map(),
    latest: new Map(),
    samples: new Map(), // hostId -> Array<sampleRow>
  };

  let lastSampleCleanupAt = 0;

  const stmts = db ? {
    insertInstallToken: db.prepare(`
      INSERT INTO probe_agent_install_tokens (token_hash, host_id, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, NULL)
    `),
    getInstallToken: db.prepare('SELECT * FROM probe_agent_install_tokens WHERE token_hash = ?'),
    consumeInstallToken: db.prepare('UPDATE probe_agent_install_tokens SET consumed_at = ? WHERE token_hash = ?'),
    upsertAgent: db.prepare(`
      INSERT INTO probe_agents (host_id, agent_id, token_hash, agent_version, status, last_seen_at, installed_at, revoked_at)
      VALUES (?, ?, ?, ?, 'online', ?, ?, NULL)
      ON CONFLICT(host_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        token_hash = excluded.token_hash,
        agent_version = excluded.agent_version,
        status = 'online',
        last_seen_at = excluded.last_seen_at,
        revoked_at = NULL
    `),
    getAgentByToken: db.prepare('SELECT * FROM probe_agents WHERE token_hash = ? AND revoked_at IS NULL'),
    getAgentByHost: db.prepare('SELECT * FROM probe_agents WHERE host_id = ?'),
    listAgents: db.prepare('SELECT * FROM probe_agents'),
    revokeAgent: db.prepare('UPDATE probe_agents SET status = ?, revoked_at = ? WHERE host_id = ?'),
    touchAgent: db.prepare(`
      UPDATE probe_agents
      SET status = ?,
          agent_version = COALESCE(?, agent_version),
          last_seen_at = ?,
          consecutive_ok_count = ?,
          first_healthy_at = ?
      WHERE host_id = ?
    `),
    upsertLatest: db.prepare(`
      INSERT INTO probe_agent_latest (host_id, payload, reported_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        payload = excluded.payload,
        reported_at = excluded.reported_at,
        updated_at = excluded.updated_at
    `),
    listLatest: db.prepare('SELECT * FROM probe_agent_latest'),
    insertSample: db.prepare(`
      INSERT INTO probe_samples (
        host_id, source, reported_at,
        cpu_usage, memory_usage, swap_usage, disk_usage,
        load1, load5, load15,
        rx_bps, tx_bps, rx_bytes, tx_bytes,
        process_count, uptime_sec, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listSamplesByHost: db.prepare(`
      SELECT host_id, source, reported_at,
        cpu_usage, memory_usage, swap_usage, disk_usage,
        load1, load5, load15,
        rx_bps, tx_bps, rx_bytes, tx_bytes,
        process_count, uptime_sec
      FROM probe_samples
      WHERE host_id = ? AND reported_at >= ?
      ORDER BY reported_at ASC
    `),
    getSampleByKey: db.prepare('SELECT id FROM probe_samples WHERE host_id = ? AND source = ? AND reported_at = ? LIMIT 1'),
    cleanupSamples: db.prepare('DELETE FROM probe_samples WHERE reported_at < ?'),
  } : null;

  function ensureHost(hostId) {
    const host = hostService.findHost(hostId);
    if (!host) {
      const error = new Error('主机不存在');
      error.status = 404;
      throw error;
    }
    return host;
  }

  function generateInstallToken(hostId, { ttlMs = INSTALL_TOKEN_TTL_MS, skipHostCheck = false } = {}) {
    if (!skipHostCheck) ensureHost(hostId);
    const token = createToken();
    const tokenHash = hashToken(token);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    if (stmts) {
      stmts.insertInstallToken.run(tokenHash, hostId, createdAt, expiresAt);
    } else {
      memory.installTokens.set(tokenHash, { token_hash: tokenHash, host_id: hostId, created_at: createdAt, expires_at: expiresAt, consumed_at: null });
    }

    return { hostId, installToken: token, expiresAt };
  }

  function registerAgent({ hostId, installToken, agentVersion }) {
    const tokenHash = hashToken(installToken);
    const tokenRow = stmts ? stmts.getInstallToken.get(tokenHash) : memory.installTokens.get(tokenHash);
    const now = nowIso();

    if (!tokenRow || tokenRow.host_id !== hostId) {
      const error = new Error('安装令牌无效');
      error.status = 401;
      throw error;
    }
    if (tokenRow.consumed_at) {
      const error = new Error('安装令牌已使用');
      error.status = 401;
      throw error;
    }
    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      const error = new Error('安装令牌已过期');
      error.status = 401;
      throw error;
    }

    const agentId = createId('probe_agent');
    const agentToken = createToken();
    const agentTokenHash = hashToken(agentToken);
    const version = String(agentVersion || '').trim() || null;

    if (stmts) {
      const tx = db.transaction(() => {
        stmts.consumeInstallToken.run(now, tokenHash);
        stmts.upsertAgent.run(hostId, agentId, agentTokenHash, version, now, now);
      });
      tx();
    } else {
      tokenRow.consumed_at = now;
      const agent = { host_id: hostId, agent_id: agentId, token_hash: agentTokenHash, agent_version: version, status: 'online', last_seen_at: now, installed_at: now, revoked_at: null };
      memory.agentsByHost.set(hostId, agent);
      memory.agentsByTokenHash.set(agentTokenHash, agent);
    }

    return { hostId, agentId, agentToken };
  }

  function authenticateAgent(authorization) {
    const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const tokenHash = hashToken(match[1]);
    return stmts ? stmts.getAgentByToken.get(tokenHash) : memory.agentsByTokenHash.get(tokenHash) || null;
  }

  function buildSampleRow(hostId, body, reportedAt, source = 'agent') {
    const memoryUsage = parseNumber(body.memory?.usage) ?? usageFromBytes(body.memory);
    const swapUsage = parseNumber(body.swap?.usage) ?? usageFromBytes(body.swap);
    const diskUsage = parseNumber(body.disk?.usage)
      ?? parseNumber(body.disk?.partitions?.find?.((item) => item.mount === '/')?.usage)
      ?? parseNumber(body.disk?.partitions?.[0]?.usage);
    return {
      host_id: hostId,
      source,
      reported_at: reportedAt,
      cpu_usage: parseNumber(body.cpu?.usage),
      memory_usage: memoryUsage,
      swap_usage: swapUsage,
      disk_usage: diskUsage,
      load1: parseNumber(body.load?.load1),
      load5: parseNumber(body.load?.load5),
      load15: parseNumber(body.load?.load15),
      rx_bps: parseNumber(body.network?.rxBps),
      tx_bps: parseNumber(body.network?.txBps),
      rx_bytes: Number.isFinite(Number(body.network?.rxBytes)) ? Number(body.network.rxBytes) : null,
      tx_bytes: Number.isFinite(Number(body.network?.txBytes)) ? Number(body.network.txBytes) : null,
      process_count: Number.isFinite(Number(body.processCount)) ? Number(body.processCount) : null,
      uptime_sec: Number.isFinite(Number(body.uptimeSec)) ? Number(body.uptimeSec) : null,
    };
  }

  function buildSampleRowFromProbe(probe, source = 'relay_agent') {
    const reportedAt = probe.checkedAt || probe.lastSuccessAt || probe.agentLastSeenAt || nowIso();
    return {
      host_id: probe.hostId,
      source,
      reported_at: reportedAt,
      cpu_usage: parseNumber(probe.cpuUsage),
      memory_usage: parseNumber(probe.memoryUsage),
      swap_usage: parseNumber(probe.swapUsage),
      disk_usage: parseNumber(probe.diskUsage),
      load1: parseNumber(probe.load1),
      load5: parseNumber(probe.load5),
      load15: parseNumber(probe.load15),
      rx_bps: parseNumber(probe.bandwidthRxBps),
      tx_bps: parseNumber(probe.bandwidthTxBps),
      rx_bytes: Number.isFinite(Number(probe.networkRxBytes)) ? Number(probe.networkRxBytes) : null,
      tx_bytes: Number.isFinite(Number(probe.networkTxBytes)) ? Number(probe.networkTxBytes) : null,
      process_count: Number.isFinite(Number(probe.processCount)) ? Number(probe.processCount) : null,
      uptime_sec: Number.isFinite(Number(probe.uptimeSec)) ? Number(probe.uptimeSec) : null,
    };
  }

  function hasSampleMetrics(row) {
    return [
      row.cpu_usage,
      row.memory_usage,
      row.swap_usage,
      row.disk_usage,
      row.load1,
      row.load5,
      row.load15,
      row.rx_bps,
      row.tx_bps,
      row.rx_bytes,
      row.tx_bytes,
      row.process_count,
      row.uptime_sec,
    ].some((value) => value !== null && value !== undefined);
  }

  function insertSampleRow(row, payloadJson) {
    if (stmts) {
      const existing = stmts.getSampleByKey.get(row.host_id, row.source, row.reported_at);
      if (existing) return false;
      stmts.insertSample.run(
        row.host_id, row.source, row.reported_at,
        row.cpu_usage, row.memory_usage, row.swap_usage, row.disk_usage,
        row.load1, row.load5, row.load15,
        row.rx_bps, row.tx_bps, row.rx_bytes, row.tx_bytes,
        row.process_count, row.uptime_sec, payloadJson,
      );
      return true;
    }

    const list = memory.samples.get(row.host_id) || [];
    if (list.some((item) => item.source === row.source && item.reported_at === row.reported_at)) return false;
    list.push(row);
    memory.samples.set(row.host_id, list);
    return true;
  }

  function maybeCleanupSamples() {
    const now = Date.now();
    if (now - lastSampleCleanupAt < SAMPLE_CLEANUP_INTERVAL_MS) return;
    lastSampleCleanupAt = now;
    const cutoff = new Date(now - SAMPLE_RETENTION_MS).toISOString();
    if (stmts) {
      try { stmts.cleanupSamples.run(cutoff); } catch { /* ignore cleanup errors */ }
      return;
    }
    for (const [hostId, list] of memory.samples) {
      const filtered = list.filter((row) => row.reported_at >= cutoff);
      if (filtered.length === 0) memory.samples.delete(hostId);
      else memory.samples.set(hostId, filtered);
    }
  }

  function saveReport(agent, payload) {
    const body = payload && typeof payload === 'object' ? payload : {};
    if (body.hostId && body.hostId !== agent.host_id) {
      const error = new Error('上报 hostId 与 agent 绑定主机不一致');
      error.status = 403;
      throw error;
    }

    const reportedAt = body.timestamp || nowIso();
    const updatedAt = nowIso();
    const normalizedPayload = { ...body, hostId: agent.host_id };
    const version = String(body.agentVersion || agent.agent_version || '').trim() || null;
    const sampleRow = buildSampleRow(agent.host_id, body, reportedAt);
    const payloadJson = JSON.stringify(normalizedPayload);

    const previousAgent = stmts
      ? (stmts.getAgentByHost.get(agent.host_id) || agent)
      : (memory.agentsByHost.get(agent.host_id) || agent);
    const healthy = isPayloadHealthy(body);
    const lastSeenMs = previousAgent.last_seen_at ? new Date(previousAgent.last_seen_at).getTime() : 0;
    const gapMs = lastSeenMs ? Date.now() - lastSeenMs : Infinity;
    const previousCount = Number(previousAgent.consecutive_ok_count || 0);

    let nextCount;
    let nextFirstHealthy;
    if (!healthy) {
      nextCount = 0;
      nextFirstHealthy = null;
    } else if (gapMs > TRUST_RESET_GAP_MS || previousCount === 0) {
      nextCount = 1;
      nextFirstHealthy = updatedAt;
    } else {
      nextCount = Math.min(previousCount + 1, HEARTBEAT_COUNT_CAP);
      nextFirstHealthy = previousAgent.first_healthy_at || updatedAt;
    }

    if (stmts) {
      const tx = db.transaction(() => {
        stmts.touchAgent.run('online', version, updatedAt, nextCount, nextFirstHealthy, agent.host_id);
        stmts.upsertLatest.run(agent.host_id, payloadJson, reportedAt, updatedAt);
        insertSampleRow(sampleRow, payloadJson);
      });
      tx();
    } else {
      const nextAgent = {
        ...agent,
        status: 'online',
        agent_version: version || agent.agent_version,
        last_seen_at: updatedAt,
        consecutive_ok_count: nextCount,
        first_healthy_at: nextFirstHealthy,
      };
      memory.agentsByHost.set(agent.host_id, nextAgent);
      memory.agentsByTokenHash.set(agent.token_hash, nextAgent);
      memory.latest.set(agent.host_id, { host_id: agent.host_id, payload: payloadJson, reported_at: reportedAt, updated_at: updatedAt });
      insertSampleRow(sampleRow, payloadJson);
    }

    maybeCleanupSamples();

    if (trafficService) {
      try {
        trafficService.recordSample(
          agent.host_id,
          sampleRow.rx_bytes,
          sampleRow.tx_bytes,
          reportedAt,
        );
      } catch { /* traffic 累计失败不应影响上报主流程 */ }
    }

    return { hostId: agent.host_id, reportedAt };
  }

  function saveExternalProbeSample(probe, { source = 'relay_agent' } = {}) {
    if (!probe?.hostId) return false;
    const sampleRow = buildSampleRowFromProbe(probe, source);
    if (!sampleRow.reported_at || Number.isNaN(new Date(sampleRow.reported_at).getTime())) return false;
    if (!hasSampleMetrics(sampleRow)) return false;
    const payloadJson = JSON.stringify({ ...probe, source });
    const inserted = insertSampleRow(sampleRow, payloadJson);
    maybeCleanupSamples();

    if (inserted && trafficService) {
      try {
        trafficService.recordSample(
          sampleRow.host_id,
          sampleRow.rx_bytes,
          sampleRow.tx_bytes,
          sampleRow.reported_at,
        );
      } catch { /* traffic 累计失败不应影响 Relay 样本写入 */ }
    }

    return inserted;
  }

  function getSampleHistory(hostId, { sinceMs = SAMPLE_RETENTION_MS } = {}) {
    if (!hostId) return [];
    const cutoff = new Date(Date.now() - sinceMs).toISOString();
    if (stmts) return stmts.listSamplesByHost.all(hostId, cutoff);
    const list = memory.samples.get(hostId) || [];
    return list.filter((row) => row.reported_at >= cutoff);
  }

  function revokeAgent(hostId) {
    ensureHost(hostId);
    const now = nowIso();
    if (stmts) {
      stmts.revokeAgent.run('revoked', now, hostId);
    } else {
      const agent = memory.agentsByHost.get(hostId);
      if (agent) {
        const next = { ...agent, status: 'revoked', revoked_at: now };
        memory.agentsByHost.set(hostId, next);
        memory.agentsByTokenHash.delete(agent.token_hash);
      }
    }
    return { ok: true };
  }

  function listAgents() {
    return stmts ? stmts.listAgents.all() : Array.from(memory.agentsByHost.values());
  }

  function listLatestRows() {
    return stmts ? stmts.listLatest.all() : Array.from(memory.latest.values());
  }

  function getAgentStatusMap() {
    const map = new Map();
    for (const agent of listAgents()) {
      const lastSeenMs = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0;
      const recent = !agent.revoked_at && Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= AGENT_STALE_AFTER_MS;
      const consecutiveOk = Number(agent.consecutive_ok_count || 0);
      const trusted = recent && consecutiveOk >= TRUST_MIN_HEARTBEATS;
      const status = agent.revoked_at
        ? 'revoked'
        : trusted ? 'online'
        : recent ? 'pending'
        : 'stale';
      map.set(agent.host_id, {
        agentInstalled: !agent.revoked_at,
        agentOnline: recent,
        agentTrusted: trusted,
        agentConsecutiveOk: consecutiveOk,
        agentFirstHealthyAt: agent.first_healthy_at || null,
        agentVersion: agent.agent_version || null,
        agentLastSeenAt: agent.last_seen_at || null,
        agentStatus: status,
      });
    }
    return map;
  }

  function getLatestProbeMap() {
    const agents = new Map(listAgents().map((agent) => [agent.host_id, agent]));
    const map = new Map();

    for (const row of listLatestRows()) {
      const payload = safeJsonParse(row.payload, {});
      const agent = agents.get(row.host_id) || { host_id: row.host_id, last_seen_at: row.reported_at };
      const probe = normalizeAgentPayload(payload, agent);
      const reportedMs = new Date(row.reported_at || probe.checkedAt).getTime();
      const stale = !Number.isFinite(reportedMs) || Date.now() - reportedMs > AGENT_STALE_AFTER_MS;
      map.set(row.host_id, {
        ...probe,
        online: !stale,
        stale,
        agentOnline: !stale,
        agentStatus: stale ? 'stale' : 'online',
      });
    }

    return map;
  }

  function getRelaySnapshot() {
    const statuses = getAgentStatusMap();
    const latest = getLatestProbeMap();
    const probes = [];

    for (const [hostId, status] of statuses.entries()) {
      const probe = latest.get(hostId);
      probes.push(probe ? { ...probe, ...status, relaySource: true } : {
        hostId,
        name: hostId,
        hostname: hostId,
        online: false,
        stale: true,
        checkedAt: status.agentLastSeenAt,
        lastSuccessAt: status.agentLastSeenAt,
        source: 'relay_agent',
        relaySource: true,
        ...status,
      });
    }

    for (const [hostId, probe] of latest.entries()) {
      if (!statuses.has(hostId)) probes.push({ ...probe, source: 'relay_agent', relaySource: true });
    }

    return { generatedAt: nowIso(), probes };
  }

  function decorateProbes(probes) {
    const statuses = getAgentStatusMap();
    const latest = getLatestProbeMap();

    return probes.map((probe) => {
      const status = statuses.get(probe.hostId);
      const agentProbe = latest.get(probe.hostId);
      if (agentProbe && !agentProbe.stale) {
        return {
          ...probe,
          ...agentProbe,
          name: probe.name || agentProbe.name,
          hostname: agentProbe.hostname || probe.hostname,
          sshOnline: probe.online,
        };
      }
      if (status) return { ...probe, ...status };
      return { ...probe, agentInstalled: false, agentOnline: false, agentStatus: 'missing' };
    });
  }

  return {
    authenticateAgent,
    decorateProbes,
    generateInstallToken,
    getAgentStatusMap,
    getLatestProbeMap,
    getRelaySnapshot,
    getSampleHistory,
    registerAgent,
    revokeAgent,
    saveExternalProbeSample,
    saveReport,
  };
}

module.exports = {
  createProbeAgentService,
};

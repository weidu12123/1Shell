'use strict';

const { createId, nowIso } = require('../utils/common');

const DEFAULT_BREACHES = 3;
const METRIC_LABELS = {
  cpuUsage: 'CPU',
  memoryUsage: '内存',
  diskUsage: '磁盘',
  swapUsage: 'Swap',
};

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function pickMetric(probe, metric) {
  const v = probe?.[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function compare(value, op, target) {
  switch (op) {
    case '>': return value > target;
    case '>=': return value >= target;
    case '<': return value < target;
    case '<=': return value <= target;
    case '==': return value === target;
    default: return false;
  }
}

const DEFAULT_RULES = [
  { name: 'CPU 持续过高', kind: 'threshold', level: 'warn', config: { metric: 'cpuUsage', op: '>', value: 90, breaches: 3 } },
  { name: '内存持续过高', kind: 'threshold', level: 'warn', config: { metric: 'memoryUsage', op: '>', value: 90, breaches: 3 } },
  { name: '磁盘空间告急', kind: 'threshold', level: 'critical', config: { metric: 'diskUsage', op: '>', value: 90, breaches: 1 } },
  { name: '探针离线', kind: 'offline', level: 'critical', config: { breaches: 2 } },
  { name: '月度流量超阈值', kind: 'traffic_quota', level: 'warn', config: { breaches: 1 } },
];

function createProbeAlertService({ db, hostService, logger } = {}) {
  const memory = {
    rules: new Map(),
    events: [],
    eventSeq: 0,
  };

  // 内存里的违规状态机：key = `${ruleId}:${hostId}`
  const firingState = new Map();
  let alertHandlers = [];

  const stmts = db ? {
    listRules: db.prepare('SELECT * FROM probe_alert_rules ORDER BY created_at ASC'),
    getRule: db.prepare('SELECT * FROM probe_alert_rules WHERE id = ?'),
    insertRule: db.prepare(`
      INSERT INTO probe_alert_rules (id, name, enabled, scope_host_ids, kind, config, level, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateRule: db.prepare(`
      UPDATE probe_alert_rules SET name = ?, enabled = ?, scope_host_ids = ?, kind = ?, config = ?, level = ?, updated_at = ?
      WHERE id = ?
    `),
    deleteRule: db.prepare('DELETE FROM probe_alert_rules WHERE id = ?'),
    countRules: db.prepare('SELECT COUNT(*) AS n FROM probe_alert_rules'),
    insertEvent: db.prepare(`
      INSERT INTO probe_alert_events (rule_id, rule_name, rule_kind, host_id, host_name, level, message, started_at, snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    resolveEvent: db.prepare('UPDATE probe_alert_events SET resolved_at = ? WHERE id = ?'),
    ackEvent: db.prepare('UPDATE probe_alert_events SET ack_at = ? WHERE id = ?'),
    ackOpenEvents: db.prepare('UPDATE probe_alert_events SET ack_at = ? WHERE ack_at IS NULL'),
    listEvents: db.prepare(`
      SELECT * FROM probe_alert_events
      WHERE (? = 0 OR resolved_at IS NULL)
        AND (? = 0 OR ack_at IS NULL)
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `),
    countOpenEvents: db.prepare(`
      SELECT COUNT(*) AS n FROM probe_alert_events
      WHERE resolved_at IS NULL AND ack_at IS NULL
    `),
    deleteEventsByHost: db.prepare('DELETE FROM probe_alert_events WHERE host_id = ?'),
  } : null;

  function ruleRowToObject(row) {
    return {
      id: row.id,
      name: row.name,
      enabled: !!row.enabled,
      scopeHostIds: safeJsonParse(row.scope_host_ids, null),
      kind: row.kind,
      config: safeJsonParse(row.config, {}),
      level: row.level,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listRules() {
    if (stmts) return stmts.listRules.all().map(ruleRowToObject);
    return Array.from(memory.rules.values());
  }

  function getRule(id) {
    if (stmts) {
      const row = stmts.getRule.get(id);
      return row ? ruleRowToObject(row) : null;
    }
    return memory.rules.get(id) || null;
  }

  function persistRule(rule, isUpdate) {
    const scopeJson = rule.scopeHostIds ? JSON.stringify(rule.scopeHostIds) : null;
    const configJson = JSON.stringify(rule.config || {});
    if (stmts) {
      if (isUpdate) {
        stmts.updateRule.run(rule.name, rule.enabled ? 1 : 0, scopeJson, rule.kind, configJson, rule.level, rule.updatedAt, rule.id);
      } else {
        stmts.insertRule.run(rule.id, rule.name, rule.enabled ? 1 : 0, scopeJson, rule.kind, configJson, rule.level, rule.createdAt, rule.updatedAt);
      }
    } else {
      memory.rules.set(rule.id, rule);
    }
  }

  function validateRulePayload(payload) {
    const kind = String(payload?.kind || '').trim();
    if (!['threshold', 'offline', 'traffic_quota'].includes(kind)) {
      const err = new Error('未知规则类型 kind');
      err.status = 400;
      throw err;
    }
    const level = ['info', 'warn', 'critical'].includes(payload?.level) ? payload.level : 'warn';
    const name = String(payload?.name || '').trim();
    if (!name) {
      const err = new Error('name 不能为空');
      err.status = 400;
      throw err;
    }
    const config = payload?.config && typeof payload.config === 'object' ? payload.config : {};
    if (kind === 'threshold') {
      if (!METRIC_LABELS[config.metric]) {
        const err = new Error('threshold.metric 必须是 cpuUsage / memoryUsage / diskUsage / swapUsage');
        err.status = 400;
        throw err;
      }
      if (!['>', '>=', '<', '<='].includes(config.op)) {
        const err = new Error('threshold.op 必须是 > / >= / < / <=');
        err.status = 400;
        throw err;
      }
      if (!Number.isFinite(Number(config.value))) {
        const err = new Error('threshold.value 必须是数字');
        err.status = 400;
        throw err;
      }
      config.value = Number(config.value);
    }
    if (!Number.isFinite(Number(config.breaches)) || Number(config.breaches) < 1) {
      config.breaches = DEFAULT_BREACHES;
    } else {
      config.breaches = Math.floor(Number(config.breaches));
    }
    return {
      name,
      enabled: payload?.enabled !== false,
      scopeHostIds: Array.isArray(payload?.scopeHostIds) && payload.scopeHostIds.length ? payload.scopeHostIds.map(String) : null,
      kind,
      config,
      level,
    };
  }

  function createRule(payload) {
    const data = validateRulePayload(payload);
    const id = createId('alert_rule');
    const now = nowIso();
    const rule = { id, ...data, createdAt: now, updatedAt: now };
    persistRule(rule, false);
    return rule;
  }

  function updateRule(id, payload) {
    const existing = getRule(id);
    if (!existing) {
      const err = new Error('规则不存在');
      err.status = 404;
      throw err;
    }
    const data = validateRulePayload(payload);
    const rule = { ...existing, ...data, updatedAt: nowIso() };
    persistRule(rule, true);
    // 修改规则 → 清掉相关 firing 状态，下个 tick 重新评估
    for (const key of [...firingState.keys()]) {
      if (key.startsWith(`${id}:`)) firingState.delete(key);
    }
    return rule;
  }

  function deleteRule(id) {
    if (stmts) stmts.deleteRule.run(id);
    else memory.rules.delete(id);
    for (const key of [...firingState.keys()]) {
      if (key.startsWith(`${id}:`)) firingState.delete(key);
    }
  }

  function ensureDefaults() {
    const count = stmts ? Number(stmts.countRules.get().n) : memory.rules.size;
    if (count > 0) return;
    for (const tpl of DEFAULT_RULES) {
      try { createRule(tpl); } catch (e) { logger?.warn?.(`[probe-alert] seed default failed: ${e.message}`); }
    }
    logger?.info?.(`[probe-alert] seeded ${DEFAULT_RULES.length} default rules`);
  }

  function insertEvent(ev) {
    if (stmts) {
      const result = stmts.insertEvent.run(
        ev.ruleId, ev.ruleName, ev.ruleKind, ev.hostId, ev.hostName,
        ev.level, ev.message, ev.startedAt, ev.snapshot ? JSON.stringify(ev.snapshot) : null,
      );
      return Number(result.lastInsertRowid);
    }
    memory.eventSeq += 1;
    memory.events.push({ ...ev, id: memory.eventSeq, snapshot: ev.snapshot || null });
    return memory.eventSeq;
  }

  function resolveEventInDb(id, resolvedAt) {
    if (stmts) stmts.resolveEvent.run(resolvedAt, id);
    else {
      const ev = memory.events.find((e) => e.id === id);
      if (ev) ev.resolved_at = resolvedAt;
    }
  }

  function ackEvent(id) {
    const at = nowIso();
    if (stmts) stmts.ackEvent.run(at, id);
    else {
      const ev = memory.events.find((e) => Number(e.id) === Number(id));
      if (ev) ev.ack_at = at;
    }
    return { ok: true, ackAt: at };
  }

  function ackOpenEvents() {
    const at = nowIso();
    if (stmts) {
      const result = stmts.ackOpenEvents.run(at);
      return { ok: true, ackAt: at, count: result.changes || 0 };
    }
    let count = 0;
    for (const ev of memory.events) {
      if (ev.ack_at) continue;
      ev.ack_at = at;
      count += 1;
    }
    return { ok: true, ackAt: at, count };
  }

  function eventRowToObject(row) {
    return {
      id: Number(row.id),
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      ruleKind: row.rule_kind,
      hostId: row.host_id,
      hostName: row.host_name,
      level: row.level,
      message: row.message,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      ackAt: row.ack_at,
      snapshot: safeJsonParse(row.snapshot, null),
    };
  }

  function listEvents({ status = 'open', limit = 100, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const firingOnly = status === 'firing' ? 1 : 0;
    const unackOnly = status === 'open' || status === 'firing' ? 1 : 0;
    if (stmts) return stmts.listEvents.all(firingOnly, unackOnly, lim, off).map(eventRowToObject);
    return memory.events
      .filter((e) => (firingOnly ? !e.resolved_at : true) && (unackOnly ? !e.ack_at : true))
      .slice(off, off + lim)
      .map((row) => eventRowToObject({
        id: row.id, rule_id: row.ruleId, rule_name: row.ruleName, rule_kind: row.ruleKind,
        host_id: row.hostId, host_name: row.hostName, level: row.level, message: row.message,
        started_at: row.startedAt, resolved_at: row.resolved_at || null, ack_at: row.ack_at || null,
        snapshot: row.snapshot ? JSON.stringify(row.snapshot) : null,
      }));
  }

  function countOpenEvents() {
    if (stmts) return Number(stmts.countOpenEvents.get().n);
    return memory.events.filter((e) => !e.resolved_at && !e.ack_at).length;
  }

  function deleteHost(hostId) {
    const cleanHostId = String(hostId || '').trim();
    if (!cleanHostId) return { ok: false, count: 0 };
    for (const key of [...firingState.keys()]) {
      if (key.endsWith(`:${cleanHostId}`)) firingState.delete(key);
    }
    if (stmts) {
      const result = stmts.deleteEventsByHost.run(cleanHostId);
      return { ok: true, count: result.changes || 0 };
    }
    const before = memory.events.length;
    memory.events = memory.events.filter((event) => event.hostId !== cleanHostId && event.host_id !== cleanHostId);
    return { ok: true, count: before - memory.events.length };
  }

  // ── 评估器 ─────────────────────────────────────────────────────────────

  function checkBreach(rule, probe) {
    if (rule.kind === 'threshold') {
      const value = pickMetric(probe, rule.config.metric);
      if (value === null) return { breach: false, value: null };
      return { breach: compare(value, rule.config.op, rule.config.value), value };
    }
    if (rule.kind === 'offline') {
      return { breach: probe.online === false, value: probe.online === false ? 1 : 0 };
    }
    if (rule.kind === 'traffic_quota') {
      const percent = probe.trafficPercent;
      const alert = probe.trafficAlertPercent;
      if (typeof percent !== 'number' || typeof alert !== 'number' || !Number.isFinite(percent) || !Number.isFinite(alert)) {
        return { breach: false, value: null };
      }
      return { breach: percent >= alert, value: percent };
    }
    return { breach: false, value: null };
  }

  function buildMessage(rule, probe, value) {
    const name = probe.name || probe.hostId;
    if (rule.kind === 'threshold') {
      const label = METRIC_LABELS[rule.config.metric] || rule.config.metric;
      const num = value === null || value === undefined ? '--' : `${Number(value).toFixed(1)}%`;
      return `${name}: ${label} ${num} ${rule.config.op} ${rule.config.value}%（持续 ${rule.config.breaches} 次）`;
    }
    if (rule.kind === 'offline') {
      return `${name}: 探针离线（持续 ${rule.config.breaches} 次心跳）`;
    }
    if (rule.kind === 'traffic_quota') {
      const num = value === null || value === undefined ? '--' : `${Number(value).toFixed(1)}%`;
      return `${name}: 月度流量已达 ${num}（≥ 阈值 ${probe.trafficAlertPercent ?? '--'}%）`;
    }
    return `${name}: ${rule.name}`;
  }

  function ruleAppliesToHost(rule, hostId) {
    if (!rule.scopeHostIds || rule.scopeHostIds.length === 0) return true;
    return rule.scopeHostIds.includes(hostId);
  }

  function evaluate(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.probes)) return { firedEvents: [], resolvedEventIds: [] };
    const rules = listRules().filter((r) => r.enabled);
    const firedEvents = [];
    const resolvedEventIds = [];
    const now = nowIso();

    for (const rule of rules) {
      for (const probe of snapshot.probes) {
        if (!probe?.hostId) continue;
        if (!ruleAppliesToHost(rule, probe.hostId)) continue;

        const key = `${rule.id}:${probe.hostId}`;
        const state = firingState.get(key) || { breachCount: 0, eventId: null, firingSince: null, lastValue: null };
        const { breach, value } = checkBreach(rule, probe);

        if (breach) {
          state.breachCount += 1;
          state.lastValue = value;
          if (!state.eventId && state.breachCount >= rule.config.breaches) {
            const ev = {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleKind: rule.kind,
              hostId: probe.hostId,
              hostName: probe.name || probe.hostId,
              level: rule.level,
              message: buildMessage(rule, probe, value),
              startedAt: now,
              snapshot: { value, metric: rule.config.metric || null, op: rule.config.op || null, threshold: rule.config.value ?? null },
            };
            const id = insertEvent(ev);
            state.eventId = id;
            state.firingSince = now;
            firedEvents.push({ id, ...ev });
            logger?.info?.(`[probe-alert] FIRE ${rule.name} on ${probe.hostId} (value=${value})`);
          }
        } else {
          if (state.eventId) {
            resolveEventInDb(state.eventId, now);
            resolvedEventIds.push(state.eventId);
            logger?.info?.(`[probe-alert] RESOLVE ${rule.name} on ${probe.hostId}`);
          }
          state.breachCount = 0;
          state.eventId = null;
          state.firingSince = null;
        }

        firingState.set(key, state);
      }
    }

    if (firedEvents.length || resolvedEventIds.length) {
      for (const handler of alertHandlers) {
        try { handler({ firedEvents, resolvedEventIds }); } catch { /* ignore */ }
      }
    }

    return { firedEvents, resolvedEventIds };
  }

  function onAlertChange(handler) {
    if (typeof handler === 'function') alertHandlers.push(handler);
    return () => { alertHandlers = alertHandlers.filter((h) => h !== handler); };
  }

  return {
    ensureDefaults,
    listRules,
    getRule,
    createRule,
    updateRule,
    deleteRule,
    listEvents,
    countOpenEvents,
    deleteHost,
    ackEvent,
    ackOpenEvents,
    evaluate,
    onAlertChange,
  };
}

module.exports = {
  createProbeAlertService,
};

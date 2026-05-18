'use strict';

const { nowIso } = require('../utils/common');

const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 31;
const MONTHS_PER_YEAR = 12;
const MONTHLY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时检查一次月度重置

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function toFiniteInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : null;
}

function ensureBuffer(raw, size) {
  const arr = Array.isArray(raw) ? raw.slice(0, size) : [];
  while (arr.length < size) arr.push(0);
  return arr.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function bucketsFromTimestamp(ms) {
  const d = new Date(ms);
  return {
    hour: d.getUTCHours(),
    day: d.getUTCDate() - 1,
    month: d.getUTCMonth(),
  };
}

function isResetDue(now, resetDay, lastResetAt) {
  const reset = Math.max(1, Math.min(28, Number(resetDay) || 1));
  if (now.getUTCDate() < reset) return false;
  if (!lastResetAt) return true;
  const last = new Date(lastResetAt);
  if (Number.isNaN(last.getTime())) return true;
  // 同年同月并且重置日已经在 last 之后或同一天，不再重置
  const currentMonthKey = now.getUTCFullYear() * 100 + now.getUTCMonth();
  const lastMonthKey = last.getUTCFullYear() * 100 + last.getUTCMonth();
  if (lastMonthKey >= currentMonthKey) return false;
  return true;
}

function createProbeTrafficService({ db, logger } = {}) {
  const memory = new Map();

  const stmts = db ? {
    get: db.prepare('SELECT * FROM probe_traffic WHERE host_id = ?'),
    list: db.prepare('SELECT * FROM probe_traffic'),
    upsert: db.prepare(`
      INSERT INTO probe_traffic (
        host_id, hs, ds, ms,
        last_rx_bytes, last_tx_bytes, last_sample_at,
        last_hour_index, last_day_index, last_month_index,
        current_month_used_bytes,
        traffic_limit_bytes, reset_day, alert_percent,
        last_reset_at, calibration_at, calibration_value_bytes,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        hs = excluded.hs,
        ds = excluded.ds,
        ms = excluded.ms,
        last_rx_bytes = excluded.last_rx_bytes,
        last_tx_bytes = excluded.last_tx_bytes,
        last_sample_at = excluded.last_sample_at,
        last_hour_index = excluded.last_hour_index,
        last_day_index = excluded.last_day_index,
        last_month_index = excluded.last_month_index,
        current_month_used_bytes = excluded.current_month_used_bytes,
        traffic_limit_bytes = excluded.traffic_limit_bytes,
        reset_day = excluded.reset_day,
        alert_percent = excluded.alert_percent,
        last_reset_at = excluded.last_reset_at,
        calibration_at = excluded.calibration_at,
        calibration_value_bytes = excluded.calibration_value_bytes,
        updated_at = excluded.updated_at
    `),
    delete: db.prepare('DELETE FROM probe_traffic WHERE host_id = ?'),
  } : null;

  function loadRow(hostId) {
    if (stmts) return stmts.get.get(hostId) || null;
    return memory.get(hostId) || null;
  }

  function listRows() {
    if (stmts) return stmts.list.all();
    return Array.from(memory.values());
  }

  function buildDefaults(hostId) {
    return {
      host_id: hostId,
      hs: JSON.stringify(new Array(HOURS_PER_DAY).fill(0)),
      ds: JSON.stringify(new Array(DAYS_PER_MONTH).fill(0)),
      ms: JSON.stringify(new Array(MONTHS_PER_YEAR).fill(0)),
      last_rx_bytes: null,
      last_tx_bytes: null,
      last_sample_at: null,
      last_hour_index: null,
      last_day_index: null,
      last_month_index: null,
      current_month_used_bytes: 0,
      traffic_limit_bytes: null,
      reset_day: 1,
      alert_percent: 80,
      last_reset_at: null,
      calibration_at: null,
      calibration_value_bytes: null,
      updated_at: nowIso(),
    };
  }

  function persist(row) {
    row.updated_at = nowIso();
    if (stmts) {
      stmts.upsert.run(
        row.host_id, row.hs, row.ds, row.ms,
        row.last_rx_bytes, row.last_tx_bytes, row.last_sample_at,
        row.last_hour_index, row.last_day_index, row.last_month_index,
        row.current_month_used_bytes,
        row.traffic_limit_bytes, row.reset_day, row.alert_percent,
        row.last_reset_at, row.calibration_at, row.calibration_value_bytes,
        row.updated_at,
      );
    } else {
      memory.set(row.host_id, { ...row });
    }
  }

  function recordSample(hostId, rxBytes, txBytes, reportedAt) {
    if (!hostId) return;
    const rx = toFiniteInt(rxBytes);
    const tx = toFiniteInt(txBytes);
    if (rx === null || tx === null) return;
    if (rx < 0 || tx < 0) return;

    const sampleMs = (() => {
      const t = reportedAt ? new Date(reportedAt).getTime() : Date.now();
      return Number.isFinite(t) ? t : Date.now();
    })();
    const sampleIso = new Date(sampleMs).toISOString();
    const row = loadRow(hostId) || buildDefaults(hostId);

    const hs = ensureBuffer(safeJsonParse(row.hs, []), HOURS_PER_DAY);
    const ds = ensureBuffer(safeJsonParse(row.ds, []), DAYS_PER_MONTH);
    const ms = ensureBuffer(safeJsonParse(row.ms, []), MONTHS_PER_YEAR);

    const lastRx = toFiniteInt(row.last_rx_bytes);
    const lastTx = toFiniteInt(row.last_tx_bytes);

    let delta = 0;
    if (lastRx !== null && lastTx !== null && rx >= lastRx && tx >= lastTx) {
      delta = (rx - lastRx) + (tx - lastTx);
    }
    // delta < 0 视为 agent 重启，跳过本次累计但记录新基线

    const { hour, day, month } = bucketsFromTimestamp(sampleMs);
    const prevHour = toFiniteInt(row.last_hour_index);
    const prevDay = toFiniteInt(row.last_day_index);
    const prevMonth = toFiniteInt(row.last_month_index);

    // 跨小时/日/月 → 新桶清零（滚动 buffer 行为，参考 dstatus）
    if (prevHour !== null && prevHour !== hour) hs[hour] = 0;
    if (prevDay !== null && prevDay !== day) ds[day] = 0;
    if (prevMonth !== null && prevMonth !== month) ms[month] = 0;

    if (delta > 0) {
      hs[hour] += delta;
      ds[day] += delta;
      ms[month] += delta;
      row.current_month_used_bytes = Number(row.current_month_used_bytes || 0) + delta;
    }

    row.hs = JSON.stringify(hs);
    row.ds = JSON.stringify(ds);
    row.ms = JSON.stringify(ms);
    row.last_rx_bytes = rx;
    row.last_tx_bytes = tx;
    row.last_sample_at = sampleIso;
    row.last_hour_index = hour;
    row.last_day_index = day;
    row.last_month_index = month;

    persist(row);
  }

  function rowToUsage(row) {
    const used = Number(row.current_month_used_bytes || 0);
    const limit = row.traffic_limit_bytes !== null && row.traffic_limit_bytes !== undefined
      ? Number(row.traffic_limit_bytes)
      : null;
    const percent = limit && limit > 0 ? Number(((used / limit) * 100).toFixed(2)) : null;
    return {
      hostId: row.host_id,
      trafficUsedBytes: used,
      trafficLimitBytes: limit,
      trafficPercent: percent,
      trafficResetDay: Number(row.reset_day || 1),
      trafficAlertPercent: Number(row.alert_percent || 0),
      trafficLastResetAt: row.last_reset_at || null,
      trafficLastSampleAt: row.last_sample_at || null,
      trafficCalibrationAt: row.calibration_at || null,
      trafficCalibrationValueBytes: row.calibration_value_bytes !== null && row.calibration_value_bytes !== undefined
        ? Number(row.calibration_value_bytes)
        : null,
    };
  }

  function getUsage(hostId) {
    const row = loadRow(hostId);
    if (!row) return null;
    return rowToUsage(row);
  }

  function getUsageMap() {
    const map = new Map();
    for (const row of listRows()) map.set(row.host_id, rowToUsage(row));
    return map;
  }

  function getDetail(hostId) {
    const row = loadRow(hostId) || buildDefaults(hostId);
    const usage = rowToUsage(row);
    return {
      ...usage,
      hourly: safeJsonParse(row.hs, []),
      daily: safeJsonParse(row.ds, []),
      monthly: safeJsonParse(row.ms, []),
    };
  }

  function updateSettings(hostId, { trafficLimitBytes, resetDay, alertPercent } = {}) {
    if (!hostId) return null;
    const row = loadRow(hostId) || buildDefaults(hostId);
    if (trafficLimitBytes !== undefined) {
      const v = trafficLimitBytes === null ? null : toFiniteInt(trafficLimitBytes);
      row.traffic_limit_bytes = (v !== null && v >= 0) ? v : null;
    }
    if (resetDay !== undefined) {
      const v = toFiniteInt(resetDay);
      if (v !== null) row.reset_day = Math.max(1, Math.min(28, v));
    }
    if (alertPercent !== undefined) {
      const v = Number(alertPercent);
      if (Number.isFinite(v)) row.alert_percent = Math.max(0, Math.min(100, v));
    }
    persist(row);
    return rowToUsage(row);
  }

  function calibrate(hostId, valueBytes) {
    if (!hostId) return null;
    const v = toFiniteInt(valueBytes);
    if (v === null || v < 0) {
      const err = new Error('校准值必须是非负整数（字节）');
      err.status = 400;
      throw err;
    }
    const row = loadRow(hostId) || buildDefaults(hostId);
    row.current_month_used_bytes = v;
    row.calibration_at = nowIso();
    row.calibration_value_bytes = v;
    persist(row);
    return rowToUsage(row);
  }

  function resetMonthly(hostId, { reason = 'manual' } = {}) {
    if (!hostId) return null;
    const row = loadRow(hostId);
    if (!row) return null;
    row.current_month_used_bytes = 0;
    row.last_reset_at = nowIso();
    persist(row);
    logger?.info?.(`[probe-traffic] reset ${hostId} (${reason})`);
    return rowToUsage(row);
  }

  function checkMonthlyResets() {
    const now = new Date();
    for (const row of listRows()) {
      if (isResetDue(now, row.reset_day, row.last_reset_at)) {
        resetMonthly(row.host_id, { reason: 'cron' });
      }
    }
  }

  function deleteHost(hostId) {
    if (!hostId) return;
    if (stmts) stmts.delete.run(hostId);
    else memory.delete(hostId);
  }

  let cronTimer = null;
  function startScheduler() {
    if (cronTimer) return;
    try { checkMonthlyResets(); } catch (e) { logger?.warn?.(`[probe-traffic] cron error: ${e.message}`); }
    cronTimer = setInterval(() => {
      try { checkMonthlyResets(); } catch (e) { logger?.warn?.(`[probe-traffic] cron error: ${e.message}`); }
    }, MONTHLY_CHECK_INTERVAL_MS);
    cronTimer.unref?.();
  }

  function stopScheduler() {
    if (!cronTimer) return;
    clearInterval(cronTimer);
    cronTimer = null;
  }

  return {
    recordSample,
    getUsage,
    getUsageMap,
    getDetail,
    updateSettings,
    calibrate,
    resetMonthly,
    deleteHost,
    startScheduler,
    stopScheduler,
  };
}

module.exports = {
  createProbeTrafficService,
};

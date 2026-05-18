'use strict';

/**
 * B1 多层时序聚合服务
 *
 * 设计：
 *   - 三层聚合表：probe_samples_1m / _1h / _1d
 *   - 每个 cron 把"上一个完整桶"的下层数据聚合成一行（避免聚合到当前还在累积的桶）
 *   - 聚合用 SQL INSERT...SELECT...GROUP BY，避免 N+1
 *   - 保留期清理：1m > 7d、1h > 180d；1d 长期保留
 *
 * 上游来源：
 *   - 1m 聚合：源表 probe_samples（raw，24h 滚动）
 *   - 1h 聚合：源表 probe_samples_1m
 *   - 1d 聚合：源表 probe_samples_1h
 */

const { nowIso } = require('../utils/common');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const RETENTION = {
  '1m': 7 * DAY_MS,
  '1h': 180 * DAY_MS,
  '1d': null, // 长期保留
};

const CRON_INTERVAL = {
  '1m': 60 * 1000,           // 每分钟跑一次
  '1h': 15 * MINUTE_MS,      // 每 15 分钟跑一次（小时桶满 15 分钟内会落库）
  '1d': HOUR_MS,             // 每小时跑一次（日桶满 1 小时内会落库）
};

function createProbeAggregatorService({ db, logger } = {}) {
  if (!db) return { startScheduler() {}, stopScheduler() {}, runOnce() {} };

  // 把时间戳向下截到桶起始
  function floorToBucket(ms, sizeMs) {
    return Math.floor(ms / sizeMs) * sizeMs;
  }

  function isoFromMs(ms) {
    return new Date(ms).toISOString();
  }

  // ── SQL：把源表里 [from, to) 区间的所有 host 数据按桶聚合，INSERT OR REPLACE 到目标表 ──

  const stmts = {
    aggregate1m: db.prepare(`
      INSERT OR REPLACE INTO probe_samples_1m
        (host_id, bucket_at, cpu_avg, cpu_max, memory_avg, memory_max, swap_avg,
         disk_avg, disk_max, load1_avg, load1_max,
         rx_bps_avg, rx_bps_max, tx_bps_avg, tx_bps_max, sample_count)
      SELECT
        host_id,
        strftime('%Y-%m-%dT%H:%M:00.000Z', reported_at) AS bucket_at,
        AVG(cpu_usage), MAX(cpu_usage),
        AVG(memory_usage), MAX(memory_usage),
        AVG(swap_usage),
        AVG(disk_usage), MAX(disk_usage),
        AVG(load1), MAX(load1),
        AVG(rx_bps), MAX(rx_bps),
        AVG(tx_bps), MAX(tx_bps),
        COUNT(*)
      FROM probe_samples
      WHERE reported_at >= ? AND reported_at < ?
      GROUP BY host_id, bucket_at
    `),
    aggregate1h: db.prepare(`
      INSERT OR REPLACE INTO probe_samples_1h
        (host_id, bucket_at, cpu_avg, cpu_max, memory_avg, memory_max, swap_avg,
         disk_avg, disk_max, load1_avg, load1_max,
         rx_bps_avg, rx_bps_max, tx_bps_avg, tx_bps_max, sample_count)
      SELECT
        host_id,
        strftime('%Y-%m-%dT%H:00:00.000Z', bucket_at) AS hour_bucket,
        AVG(cpu_avg), MAX(cpu_max),
        AVG(memory_avg), MAX(memory_max),
        AVG(swap_avg),
        AVG(disk_avg), MAX(disk_max),
        AVG(load1_avg), MAX(load1_max),
        AVG(rx_bps_avg), MAX(rx_bps_max),
        AVG(tx_bps_avg), MAX(tx_bps_max),
        SUM(sample_count)
      FROM probe_samples_1m
      WHERE bucket_at >= ? AND bucket_at < ?
      GROUP BY host_id, hour_bucket
    `),
    aggregate1d: db.prepare(`
      INSERT OR REPLACE INTO probe_samples_1d
        (host_id, bucket_at, cpu_avg, cpu_max, memory_avg, memory_max, swap_avg,
         disk_avg, disk_max, load1_avg, load1_max,
         rx_bps_avg, rx_bps_max, tx_bps_avg, tx_bps_max, sample_count)
      SELECT
        host_id,
        strftime('%Y-%m-%dT00:00:00.000Z', bucket_at) AS day_bucket,
        AVG(cpu_avg), MAX(cpu_max),
        AVG(memory_avg), MAX(memory_max),
        AVG(swap_avg),
        AVG(disk_avg), MAX(disk_max),
        AVG(load1_avg), MAX(load1_max),
        AVG(rx_bps_avg), MAX(rx_bps_max),
        AVG(tx_bps_avg), MAX(tx_bps_max),
        SUM(sample_count)
      FROM probe_samples_1h
      WHERE bucket_at >= ? AND bucket_at < ?
      GROUP BY host_id, day_bucket
    `),
    cleanup1m: db.prepare('DELETE FROM probe_samples_1m WHERE bucket_at < ?'),
    cleanup1h: db.prepare('DELETE FROM probe_samples_1h WHERE bucket_at < ?'),
    // probe_samples_1d 不清理
  };

  function rollup1m() {
    // 聚合过去 10 个完整分钟桶（避免服务重启时漏数据；INSERT OR REPLACE 保证幂等）
    const now = Date.now();
    const currentBucket = floorToBucket(now, MINUTE_MS);
    const fromMs = currentBucket - 10 * MINUTE_MS;
    const toMs = currentBucket;
    const result = stmts.aggregate1m.run(isoFromMs(fromMs), isoFromMs(toMs));
    return { table: '1m', from: isoFromMs(fromMs), to: isoFromMs(toMs), changes: result.changes };
  }

  function rollup1h() {
    // 聚合过去 6 个完整小时桶
    const now = Date.now();
    const currentBucket = floorToBucket(now, HOUR_MS);
    const fromMs = currentBucket - 6 * HOUR_MS;
    const toMs = currentBucket;
    const result = stmts.aggregate1h.run(isoFromMs(fromMs), isoFromMs(toMs));
    return { table: '1h', from: isoFromMs(fromMs), to: isoFromMs(toMs), changes: result.changes };
  }

  function rollup1d() {
    // 聚合过去 7 个完整天桶
    const now = Date.now();
    const currentBucket = floorToBucket(now, DAY_MS);
    const fromMs = currentBucket - 7 * DAY_MS;
    const toMs = currentBucket;
    const result = stmts.aggregate1d.run(isoFromMs(fromMs), isoFromMs(toMs));
    return { table: '1d', from: isoFromMs(fromMs), to: isoFromMs(toMs), changes: result.changes };
  }

  function cleanup() {
    const now = Date.now();
    const cutoff1m = isoFromMs(now - RETENTION['1m']);
    const cutoff1h = isoFromMs(now - RETENTION['1h']);
    const r1 = stmts.cleanup1m.run(cutoff1m);
    const r2 = stmts.cleanup1h.run(cutoff1h);
    return { deleted1m: r1.changes, deleted1h: r2.changes };
  }

  function runOnce() {
    try {
      const r1m = rollup1m();
      const r1h = rollup1h();
      const r1d = rollup1d();
      const cleaned = cleanup();
      logger?.info?.(`[probe-aggregator] 1m:${r1m.changes} 1h:${r1h.changes} 1d:${r1d.changes} cleanup:${cleaned.deleted1m}/${cleaned.deleted1h}`);
      return { r1m, r1h, r1d, cleaned };
    } catch (e) {
      logger?.warn?.(`[probe-aggregator] rollup failed: ${e.message}`);
      return null;
    }
  }

  // ── 调度器 ─────────────────────────────────────────────────────────────

  const timers = { '1m': null, '1h': null, '1d': null };

  function scheduleRoll(tier, fn) {
    if (timers[tier]) return;
    // 启动后立即跑一次（不阻塞 server.listen），然后定时
    setTimeout(() => { try { fn(); } catch (e) { logger?.warn?.(`[probe-aggregator] ${tier} initial failed: ${e.message}`); } }, 5000);
    timers[tier] = setInterval(() => {
      try { fn(); } catch (e) { logger?.warn?.(`[probe-aggregator] ${tier} tick failed: ${e.message}`); }
    }, CRON_INTERVAL[tier]);
    timers[tier].unref?.();
  }

  function startScheduler() {
    scheduleRoll('1m', rollup1m);
    scheduleRoll('1h', () => { rollup1h(); cleanup(); });
    scheduleRoll('1d', rollup1d);
  }

  function stopScheduler() {
    for (const tier of Object.keys(timers)) {
      if (timers[tier]) {
        clearInterval(timers[tier]);
        timers[tier] = null;
      }
    }
  }

  // ── 查询 ───────────────────────────────────────────────────────────────

  function pickResolution(fromMs, toMs, requested) {
    if (requested && requested !== 'auto') return requested;
    const range = toMs - fromMs;
    if (range <= 6 * HOUR_MS) return '1m';
    if (range <= 30 * DAY_MS) return '1h';
    return '1d';
  }

  function listTimeseries(hostId, { fromMs, toMs, resolution = 'auto' } = {}) {
    if (!hostId || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { resolution: null, points: [] };
    const res = pickResolution(fromMs, toMs, resolution);
    const table = res === '1m' ? 'probe_samples_1m'
      : res === '1h' ? 'probe_samples_1h'
      : 'probe_samples_1d';
    const rows = db.prepare(`
      SELECT bucket_at, cpu_avg, cpu_max, memory_avg, memory_max, swap_avg,
             disk_avg, disk_max, load1_avg, load1_max,
             rx_bps_avg, rx_bps_max, tx_bps_avg, tx_bps_max, sample_count
      FROM ${table}
      WHERE host_id = ? AND bucket_at >= ? AND bucket_at < ?
      ORDER BY bucket_at ASC
    `).all(hostId, isoFromMs(fromMs), isoFromMs(toMs));
    return { resolution: res, points: rows };
  }

  return {
    runOnce,
    startScheduler,
    stopScheduler,
    listTimeseries,
    _internal: { rollup1m, rollup1h, rollup1d, cleanup },
  };
}

module.exports = {
  createProbeAggregatorService,
};

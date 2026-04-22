'use strict';

/**
 * Program State Service — 持久化 Program 实例状态与运行历史。
 *
 * 表设计：
 *   program_instances  每个 (program_id, host_id) 一行，存启用状态和最新快照
 *   program_runs       每次 action 执行一行（手动/定时/escalation）
 *
 * 两张表都用 idempotent CREATE，不依赖 db.js 的 migration。
 */

function createProgramStateService({ db }) {
  if (!db) {
    // DB 不可用时返回 no-op（不持久化只是失去历史）
    return createNoopStateService();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS program_instances (
      program_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_id INTEGER,
      last_status TEXT,
      last_run_at TEXT,
      last_trigger_id TEXT,
      last_action TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (program_id, host_id)
    );

    CREATE TABLE IF NOT EXISTS program_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      steps_total INTEGER NOT NULL DEFAULT 0,
      steps_completed INTEGER NOT NULL DEFAULT 0,
      rescue_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      details TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_program_runs_program ON program_runs(program_id);
    CREATE INDEX IF NOT EXISTS idx_program_runs_host ON program_runs(host_id);
    CREATE INDEX IF NOT EXISTS idx_program_runs_started ON program_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_program_runs_status ON program_runs(status);
  `);

  // 迁移：为已有表添加 renders 列（存储 render step 输出，用于页面刷新后恢复）
  try { db.exec(`ALTER TABLE program_runs ADD COLUMN renders TEXT`); } catch { /* 已存在则跳过 */ }

  const stmtRunStart = db.prepare(`
    INSERT INTO program_runs (program_id, host_id, trigger_id, trigger_type, action)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtRunEnd = db.prepare(`
    UPDATE program_runs
       SET status = ?, steps_total = ?, steps_completed = ?,
           rescue_count = ?, error = ?, details = ?, renders = ?,
           finished_at = datetime('now')
     WHERE id = ?
  `);
  const stmtInstanceUpsert = db.prepare(`
    INSERT INTO program_instances (program_id, host_id, enabled, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(program_id, host_id) DO UPDATE
       SET enabled = excluded.enabled, updated_at = datetime('now')
  `);
  const stmtInstanceTouch = db.prepare(`
    UPDATE program_instances
       SET last_run_id = ?, last_status = ?, last_run_at = datetime('now'),
           last_trigger_id = ?, last_action = ?, last_error = ?,
           updated_at = datetime('now')
     WHERE program_id = ? AND host_id = ?
  `);
  const stmtInstanceGet = db.prepare(`
    SELECT * FROM program_instances WHERE program_id = ? AND host_id = ?
  `);
  const stmtInstanceList = db.prepare(`
    SELECT * FROM program_instances WHERE program_id = ? ORDER BY host_id
  `);
  const stmtInstanceListAll = db.prepare(`
    SELECT * FROM program_instances ORDER BY program_id, host_id
  `);
  const stmtRunsList = db.prepare(`
    SELECT * FROM program_runs
     WHERE (? IS NULL OR program_id = ?)
       AND (? IS NULL OR host_id = ?)
     ORDER BY started_at DESC
     LIMIT ?
  `);
  const stmtRunGet = db.prepare(`SELECT * FROM program_runs WHERE id = ?`);
  // 获取某个 (program, host) 最近一次已完成 run 的 renders
  const stmtLastRenders = db.prepare(`
    SELECT renders FROM program_runs
     WHERE program_id = ? AND host_id = ? AND renders IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1
  `);

  function recordRunStart({ programId, hostId, triggerId, triggerType, action }) {
    const info = stmtRunStart.run(programId, hostId, triggerId, triggerType, action);
    // 确保 instance 行存在
    stmtInstanceUpsert.run(programId, hostId, 1);
    stmtInstanceTouch.run(info.lastInsertRowid, 'running', triggerId, action, null, programId, hostId);
    return info.lastInsertRowid;
  }

  function recordRunEnd(runId, { status, stepsTotal = 0, stepsCompleted = 0, rescueCount = 0, error = null, details = null, renders = null } = {}) {
    const rendersJson = Array.isArray(renders) && renders.length > 0
      ? JSON.stringify(renders)
      : null;
    stmtRunEnd.run(
      status,
      stepsTotal,
      stepsCompleted,
      rescueCount,
      error,
      typeof details === 'string' ? details : (details ? JSON.stringify(details) : null),
      rendersJson,
      runId,
    );
    const row = stmtRunGet.get(runId);
    if (row) {
      stmtInstanceTouch.run(runId, status, row.trigger_id, row.action, error, row.program_id, row.host_id);
    }
  }

  function setEnabled(programId, hostId, enabled) {
    stmtInstanceUpsert.run(programId, hostId, enabled ? 1 : 0);
  }

  function isEnabled(programId, hostId) {
    const row = stmtInstanceGet.get(programId, hostId);
    if (!row) return true; // 未初始化默认启用
    return row.enabled === 1;
  }

  function getInstance(programId, hostId) {
    return stmtInstanceGet.get(programId, hostId) || null;
  }

  function listInstances(programId) {
    return programId ? stmtInstanceList.all(programId) : stmtInstanceListAll.all();
  }

  function listRuns({ programId = null, hostId = null, limit = 50 } = {}) {
    const cap = Math.min(Math.max(1, Number(limit) || 50), 500);
    return stmtRunsList.all(programId, programId, hostId, hostId, cap);
  }

  function getRun(runId) {
    return stmtRunGet.get(runId) || null;
  }

  // 返回某 (program, host) 最近一次有 render 输出的 run 的 renders 数组
  function getLastRenders(programId, hostId) {
    const row = stmtLastRenders.get(programId, hostId);
    if (!row || !row.renders) return [];
    try { return JSON.parse(row.renders); } catch { return []; }
  }

  return {
    recordRunStart,
    recordRunEnd,
    setEnabled,
    isEnabled,
    getInstance,
    listInstances,
    listRuns,
    getRun,
    getLastRenders,
  };
}

function createNoopStateService() {
  let counter = 0;
  const enabled = new Map();
  return {
    recordRunStart: () => ++counter,
    recordRunEnd: () => {},
    setEnabled: (pid, hid, v) => { enabled.set(`${pid}::${hid}`, v); },
    isEnabled: (pid, hid) => enabled.get(`${pid}::${hid}`) !== false,
    getInstance: () => null,
    listInstances: () => [],
    listRuns: () => [],
    getRun: () => null,
    getLastRenders: () => [],
  };
}

module.exports = { createProgramStateService };
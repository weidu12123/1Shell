'use strict';

/**
 * Script Repository
 *
 * 脚本库的存储层，SQLite。
 * 与 host.repository.js 不同的是，脚本库是 2.0 新增功能，没有 JSON 迁移需求。
 * 如果 db 不可用，返回一个"只读空库"的 stub，让上层 service/route 正常响应但不实际存储。
 */

const crypto = require('crypto');

function createScriptRepository(db) {
  // ─── 无 db 时的 stub（避免 host 上没装 better-sqlite3 时整站崩溃）──────
  if (!db) {
    const empty = {
      listScripts: () => [],
      findScript: () => null,
      createScript: () => { throw new Error('脚本库需要 SQLite 支持，当前环境不可用'); },
      updateScript: () => { throw new Error('脚本库需要 SQLite 支持，当前环境不可用'); },
      deleteScript: () => false,
      incrementRunCount: () => {},
      createRun: () => { throw new Error('脚本库需要 SQLite 支持，当前环境不可用'); },
      updateRun: () => {},
      findRun: () => null,
      listRunsByScript: () => ({ runs: [], total: 0 }),
      listAllRuns: () => ({ runs: [], total: 0 }),
    };
    return empty;
  }

  // ─── 预编译语句 ───────────────────────────────────────────────────────
  const stmts = {
    // scripts 表
    selectAll: db.prepare('SELECT * FROM scripts ORDER BY updated_at DESC'),
    selectByCategory: db.prepare('SELECT * FROM scripts WHERE category = ? ORDER BY updated_at DESC'),
    selectOne: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    insertScript: db.prepare(`
      INSERT INTO scripts (id, name, icon, category, tags, risk_level, description, content, parameters, run_count, created_at, updated_at)
      VALUES (@id, @name, @icon, @category, @tags, @risk_level, @description, @content, @parameters, 0, datetime('now'), datetime('now'))
    `),
    updateScript: db.prepare(`
      UPDATE scripts
      SET name = @name,
          icon = @icon,
          category = @category,
          tags = @tags,
          risk_level = @risk_level,
          description = @description,
          content = @content,
          parameters = @parameters,
          updated_at = datetime('now')
      WHERE id = @id
    `),
    deleteScript: db.prepare('DELETE FROM scripts WHERE id = ?'),
    incrementRunCount: db.prepare('UPDATE scripts SET run_count = run_count + 1 WHERE id = ?'),

    // script_runs 表
    insertRun: db.prepare(`
      INSERT INTO script_runs (script_id, script_name, host_id, host_name, params, rendered_command, status, started_at)
      VALUES (@script_id, @script_name, @host_id, @host_name, @params, @rendered_command, 'running', datetime('now'))
    `),
    updateRun: db.prepare(`
      UPDATE script_runs
      SET status = @status,
          exit_code = @exit_code,
          duration_ms = @duration_ms,
          stdout = @stdout,
          stderr = @stderr,
          error = @error,
          finished_at = datetime('now')
      WHERE id = @id
    `),
    selectRun: db.prepare('SELECT * FROM script_runs WHERE id = ?'),
    selectRunsByScript: db.prepare(`
      SELECT * FROM script_runs
      WHERE script_id = ?
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `),
    countRunsByScript: db.prepare('SELECT COUNT(*) AS total FROM script_runs WHERE script_id = ?'),
    selectAllRuns: db.prepare(`
      SELECT * FROM script_runs
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `),
    countAllRuns: db.prepare('SELECT COUNT(*) AS total FROM script_runs'),
  };

  // ─── 内部工具：row → 对外对象 ─────────────────────────────────────────
  function rowToScript(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      icon: row.icon || '',
      category: row.category || 'other',
      tags: safeParseArray(row.tags),
      riskLevel: row.risk_level || 'safe',
      description: row.description || '',
      content: row.content || '',
      parameters: safeParseArray(row.parameters),
      runCount: row.run_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      scriptId: row.script_id,
      scriptName: row.script_name || '',
      hostId: row.host_id || '',
      hostName: row.host_name || '',
      params: safeParseObject(row.params),
      renderedCommand: row.rendered_command || '',
      status: row.status,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      stdout: row.stdout || '',
      stderr: row.stderr || '',
      error: row.error || '',
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  function safeParseArray(s) {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function safeParseObject(s) {
    if (!s) return {};
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  // ─── 对外接口：scripts ───────────────────────────────────────────────
  function listScripts({ category, keyword } = {}) {
    let rows;
    if (category && category !== 'all') {
      rows = stmts.selectByCategory.all(category);
    } else {
      rows = stmts.selectAll.all();
    }

    if (keyword) {
      const kw = keyword.trim().toLowerCase();
      if (kw) {
        rows = rows.filter((row) => {
          const name = (row.name || '').toLowerCase();
          const desc = (row.description || '').toLowerCase();
          const tags = (row.tags || '').toLowerCase();
          return name.includes(kw) || desc.includes(kw) || tags.includes(kw);
        });
      }
    }

    return rows.map(rowToScript);
  }

  function findScript(id) {
    return rowToScript(stmts.selectOne.get(id));
  }

  function createScript(payload) {
    const id = payload.id || `script-${crypto.randomBytes(8).toString('hex')}`;
    stmts.insertScript.run({
      id,
      name: payload.name,
      icon: payload.icon || null,
      category: payload.category || 'other',
      tags: JSON.stringify(payload.tags || []),
      risk_level: payload.riskLevel || 'safe',
      description: payload.description || null,
      content: payload.content,
      parameters: JSON.stringify(payload.parameters || []),
    });
    return findScript(id);
  }

  function updateScript(id, payload) {
    const existing = stmts.selectOne.get(id);
    if (!existing) return null;
    stmts.updateScript.run({
      id,
      name: payload.name,
      icon: payload.icon || null,
      category: payload.category || 'other',
      tags: JSON.stringify(payload.tags || []),
      risk_level: payload.riskLevel || 'safe',
      description: payload.description || null,
      content: payload.content,
      parameters: JSON.stringify(payload.parameters || []),
    });
    return findScript(id);
  }

  function deleteScript(id) {
    const info = stmts.deleteScript.run(id);
    return info.changes > 0;
  }

  function incrementRunCount(id) {
    stmts.incrementRunCount.run(id);
  }

  // ─── 对外接口：script_runs ───────────────────────────────────────────
  function createRun({ scriptId, scriptName, hostId, hostName, params, renderedCommand }) {
    const info = stmts.insertRun.run({
      script_id: scriptId,
      script_name: scriptName || null,
      host_id: hostId || null,
      host_name: hostName || null,
      params: JSON.stringify(params || {}),
      rendered_command: renderedCommand || null,
    });
    return info.lastInsertRowid;
  }

  function updateRun(id, { status, exitCode, durationMs, stdout, stderr, error }) {
    stmts.updateRun.run({
      id,
      status,
      exit_code: exitCode ?? null,
      duration_ms: durationMs ?? null,
      stdout: truncate(stdout, 16000),
      stderr: truncate(stderr, 8000),
      error: error ? String(error).substring(0, 1000) : null,
    });
  }

  function findRun(id) {
    return rowToRun(stmts.selectRun.get(id));
  }

  function listRunsByScript(scriptId, { limit = 20, offset = 0 } = {}) {
    const rows = stmts.selectRunsByScript.all(scriptId, Math.min(limit, 100), Math.max(offset, 0));
    const { total } = stmts.countRunsByScript.get(scriptId);
    return { runs: rows.map(rowToRun), total };
  }

  function listAllRuns({ limit = 50, offset = 0 } = {}) {
    const rows = stmts.selectAllRuns.all(Math.min(limit, 200), Math.max(offset, 0));
    const { total } = stmts.countAllRuns.get();
    return { runs: rows.map(rowToRun), total };
  }

  function truncate(str, max) {
    if (str == null) return null;
    const s = String(str);
    return s.length > max ? s.substring(0, max) : s;
  }

  return {
    listScripts,
    findScript,
    createScript,
    updateScript,
    deleteScript,
    incrementRunCount,
    createRun,
    updateRun,
    findRun,
    listRunsByScript,
    listAllRuns,
  };
}

module.exports = { createScriptRepository };

'use strict';

const crypto = require('crypto');

/**
 * Playbook Repository
 *
 * Playbook 存储层，SQLite。
 * 每个 playbook 包含有序步骤列表（steps JSON），每步引用一个 script + 目标主机 + 参数。
 */
function createPlaybookRepository(db) {
  if (!db) {
    return {
      listPlaybooks: () => [],
      findPlaybook: () => null,
      createPlaybook: () => { throw new Error('Playbook 需要 SQLite 支持'); },
      updatePlaybook: () => { throw new Error('Playbook 需要 SQLite 支持'); },
      deletePlaybook: () => false,
      createRun: () => { throw new Error('Playbook 需要 SQLite 支持'); },
      updateRun: () => {},
      findRun: () => null,
      listRuns: () => ({ runs: [], total: 0 }),
    };
  }

  const stmts = {
    selectAll: db.prepare('SELECT * FROM playbooks ORDER BY updated_at DESC'),
    selectOne: db.prepare('SELECT * FROM playbooks WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO playbooks (id, name, icon, description, steps, created_at, updated_at)
      VALUES (@id, @name, @icon, @description, @steps, datetime('now'), datetime('now'))
    `),
    update: db.prepare(`
      UPDATE playbooks
      SET name = @name, icon = @icon, description = @description, steps = @steps, updated_at = datetime('now')
      WHERE id = @id
    `),
    delete: db.prepare('DELETE FROM playbooks WHERE id = ?'),

    insertRun: db.prepare(`
      INSERT INTO playbook_runs (playbook_id, playbook_name, status, total_steps, completed_steps, results, started_at)
      VALUES (@playbook_id, @playbook_name, 'running', @total_steps, 0, '[]', datetime('now'))
    `),
    updateRun: db.prepare(`
      UPDATE playbook_runs
      SET status = @status, completed_steps = @completed_steps, results = @results, error = @error, finished_at = datetime('now')
      WHERE id = @id
    `),
    selectRun: db.prepare('SELECT * FROM playbook_runs WHERE id = ?'),
    selectRuns: db.prepare('SELECT * FROM playbook_runs ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    countRuns: db.prepare('SELECT COUNT(*) AS total FROM playbook_runs'),
    selectRunsByPlaybook: db.prepare('SELECT * FROM playbook_runs WHERE playbook_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    countRunsByPlaybook: db.prepare('SELECT COUNT(*) AS total FROM playbook_runs WHERE playbook_id = ?'),
  };

  function safeParseArray(s) {
    if (!s) return [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  function rowToPlaybook(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      icon: row.icon || '',
      description: row.description || '',
      steps: safeParseArray(row.steps),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      playbookId: row.playbook_id,
      playbookName: row.playbook_name || '',
      status: row.status,
      totalSteps: row.total_steps,
      completedSteps: row.completed_steps,
      results: safeParseArray(row.results),
      error: row.error || '',
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  function listPlaybooks() {
    return stmts.selectAll.all().map(rowToPlaybook);
  }

  function findPlaybook(id) {
    return rowToPlaybook(stmts.selectOne.get(id));
  }

  function createPlaybook(payload) {
    const id = payload.id || `pb-${crypto.randomBytes(8).toString('hex')}`;
    stmts.insert.run({
      id,
      name: payload.name,
      icon: payload.icon || null,
      description: payload.description || null,
      steps: JSON.stringify(payload.steps || []),
    });
    return findPlaybook(id);
  }

  function updatePlaybook(id, payload) {
    const existing = stmts.selectOne.get(id);
    if (!existing) return null;
    stmts.update.run({
      id,
      name: payload.name,
      icon: payload.icon || null,
      description: payload.description || null,
      steps: JSON.stringify(payload.steps || []),
    });
    return findPlaybook(id);
  }

  function deletePlaybook(id) {
    return stmts.delete.run(id).changes > 0;
  }

  function createRun({ playbookId, playbookName, totalSteps }) {
    const info = stmts.insertRun.run({
      playbook_id: playbookId,
      playbook_name: playbookName || null,
      total_steps: totalSteps,
    });
    return info.lastInsertRowid;
  }

  function updateRun(id, { status, completedSteps, results, error }) {
    stmts.updateRun.run({
      id,
      status,
      completed_steps: completedSteps ?? 0,
      results: JSON.stringify(results || []),
      error: error ? String(error).substring(0, 1000) : null,
    });
  }

  function findRun(id) {
    return rowToRun(stmts.selectRun.get(id));
  }

  function listRuns({ playbookId, limit = 20, offset = 0 } = {}) {
    if (playbookId) {
      const rows = stmts.selectRunsByPlaybook.all(playbookId, Math.min(limit, 100), Math.max(offset, 0));
      const { total } = stmts.countRunsByPlaybook.get(playbookId);
      return { runs: rows.map(rowToRun), total };
    }
    const rows = stmts.selectRuns.all(Math.min(limit, 100), Math.max(offset, 0));
    const { total } = stmts.countRuns.get();
    return { runs: rows.map(rowToRun), total };
  }

  return {
    listPlaybooks,
    findPlaybook,
    createPlaybook,
    updatePlaybook,
    deletePlaybook,
    createRun,
    updateRun,
    findRun,
    listRuns,
  };
}

module.exports = { createPlaybookRepository };
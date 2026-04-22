'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../../lib/logger');

/**
 * Host Repository
 *
 * 存储层：SQLite 优先，JSON 文件 fallback。
 * 首次启动时自动将 hosts.json 中的已有数据迁移到 SQLite。
 *
 * 接口保持不变：readStoredHosts / writeStoredHosts / ensureHostsFile
 * 上层（host.service.js、host.routes.js）无需任何改动。
 */
function createHostRepository(hostsFile, db) {
  const jsonDir = path.dirname(hostsFile);

  // ─── JSON 文件操作（fallback / 迁移源）────────────────────────────────

  function ensureHostsFile() {
    if (!fs.existsSync(jsonDir)) fs.mkdirSync(jsonDir, { recursive: true });
    if (!fs.existsSync(hostsFile)) fs.writeFileSync(hostsFile, '[]\n', 'utf8');
  }

  function readJsonHosts() {
    try {
      const raw = fs.readFileSync(hostsFile, 'utf8').trim() || '[]';
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeJsonHosts(hosts) {
    ensureHostsFile();
    fs.writeFileSync(hostsFile, `${JSON.stringify(hosts, null, 2)}\n`, 'utf8');
  }

  // ─── 无 SQLite 时使用 JSON fallback ───────────────────────────────────

  if (!db) {
    return {
      ensureHostsFile,
      readStoredHosts: () => { ensureHostsFile(); return readJsonHosts(); },
      writeStoredHosts: writeJsonHosts,
    };
  }

  // ─── SQLite 操作 ──────────────────────────────────────────────────────

  const stmts = {
    selectAll: db.prepare('SELECT data FROM hosts ORDER BY created_at ASC'),
    selectOne: db.prepare('SELECT data FROM hosts WHERE id = ?'),
    upsert: db.prepare(`
      INSERT INTO hosts (id, data, created_at, updated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
    `),
    deleteOne: db.prepare('DELETE FROM hosts WHERE id = ?'),
    deleteAll: db.prepare('DELETE FROM hosts'),
    count: db.prepare('SELECT COUNT(*) as cnt FROM hosts'),
  };

  const upsertMany = db.transaction((hosts) => {
    for (const host of hosts) {
      stmts.upsert.run(host.id, JSON.stringify(host));
    }
  });

  const replaceAll = db.transaction((hosts) => {
    stmts.deleteAll.run();
    for (const host of hosts) {
      stmts.upsert.run(host.id, JSON.stringify(host));
    }
  });

  // ─── 自动迁移 ─────────────────────────────────────────────────────────

  function migrateFromJson() {
    const { cnt } = stmts.count.get();
    if (cnt > 0) return; // SQLite 中已有数据，跳过

    ensureHostsFile();
    const jsonHosts = readJsonHosts();
    if (jsonHosts.length === 0) return;

    upsertMany(jsonHosts);
    log.info('已从 hosts.json 迁移主机到 SQLite', { count: jsonHosts.length });

    // 备份原文件
    const backupPath = hostsFile + '.migrated';
    try {
      fs.copyFileSync(hostsFile, backupPath);
    } catch {
      // ignore
    }
  }

  migrateFromJson();

  // ─── 对外接口（与 JSON 版完全一致）────────────────────────────────────

  function readStoredHosts() {
    const rows = stmts.selectAll.all();
    return rows.map((row) => {
      try { return JSON.parse(row.data); } catch { return null; }
    }).filter(Boolean);
  }

  function writeStoredHosts(hosts) {
    replaceAll(hosts);
    // 同步写 JSON 作为备份（不阻塞，不报错）
    try { writeJsonHosts(hosts); } catch { /* ignore */ }
  }

  return {
    ensureHostsFile,
    readStoredHosts,
    writeStoredHosts,
  };
}

module.exports = {
  createHostRepository,
};

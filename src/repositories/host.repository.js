'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../../lib/logger');

function createHostRepository(hostsFile, db) {
  const jsonDir = path.dirname(hostsFile);
  const preferencesFile = path.join(jsonDir, 'host-preferences.json');

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

  function readJsonPreferences() {
    try {
      const raw = fs.readFileSync(preferencesFile, 'utf8').trim() || '{}';
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return Object.fromEntries(parsed.map((item) => [item.hostId, item]).filter(([id]) => id));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeJsonPreferencesMap(map) {
    ensureHostsFile();
    fs.writeFileSync(preferencesFile, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }

  function parsePreferenceRow(row) {
    if (!row) return null;
    let tags = [];
    try { tags = JSON.parse(row.tags_json || '[]'); } catch { tags = []; }
    return {
      hostId: row.host_id,
      showInConsole: Boolean(row.show_in_console),
      consoleOrder: Number(row.console_order) || 0,
      pinned: Boolean(row.pinned),
      role: row.role || null,
      tags: Array.isArray(tags) ? tags : [],
      archived: Boolean(row.archived),
      updatedAt: row.updated_at || null,
    };
  }

  if (!db) {
    return {
      ensureHostsFile,
      readStoredHosts: () => { ensureHostsFile(); return readJsonHosts(); },
      writeStoredHosts: writeJsonHosts,
      readHostPreferences: () => Object.values(readJsonPreferences()),
      readHostPreference: (hostId) => readJsonPreferences()[hostId] || null,
      writeHostPreference: (preference) => {
        const map = readJsonPreferences();
        map[preference.hostId] = preference;
        writeJsonPreferencesMap(map);
      },
      deleteHostPreference: (hostId) => {
        const map = readJsonPreferences();
        delete map[hostId];
        writeJsonPreferencesMap(map);
      },
    };
  }

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
    selectPreferences: db.prepare('SELECT * FROM host_preferences'),
    selectPreference: db.prepare('SELECT * FROM host_preferences WHERE host_id = ?'),
    upsertPreference: db.prepare(`
      INSERT INTO host_preferences (
        host_id, show_in_console, console_order, pinned, role, tags_json, archived, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        show_in_console = excluded.show_in_console,
        console_order = excluded.console_order,
        pinned = excluded.pinned,
        role = excluded.role,
        tags_json = excluded.tags_json,
        archived = excluded.archived,
        updated_at = excluded.updated_at
    `),
    deletePreference: db.prepare('DELETE FROM host_preferences WHERE host_id = ?'),
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

  function migrateFromJson() {
    const { cnt } = stmts.count.get();
    if (cnt > 0) return;

    ensureHostsFile();
    const jsonHosts = readJsonHosts();
    if (jsonHosts.length === 0) return;

    upsertMany(jsonHosts);
    log.info('已从 hosts.json 迁移主机到 SQLite', { count: jsonHosts.length });

    const backupPath = hostsFile + '.migrated';
    try {
      fs.copyFileSync(hostsFile, backupPath);
    } catch {
      // ignore
    }
  }

  migrateFromJson();

  function readStoredHosts() {
    const rows = stmts.selectAll.all();
    return rows.map((row) => {
      try { return JSON.parse(row.data); } catch { return null; }
    }).filter(Boolean);
  }

  function writeStoredHosts(hosts) {
    replaceAll(hosts);
    try { writeJsonHosts(hosts); } catch { /* ignore */ }
  }

  function readHostPreferences() {
    return stmts.selectPreferences.all().map(parsePreferenceRow).filter(Boolean);
  }

  function readHostPreference(hostId) {
    return parsePreferenceRow(stmts.selectPreference.get(hostId));
  }

  function writeHostPreference(preference) {
    stmts.upsertPreference.run(
      preference.hostId,
      preference.showInConsole ? 1 : 0,
      Number(preference.consoleOrder) || 0,
      preference.pinned ? 1 : 0,
      preference.role || null,
      JSON.stringify(Array.isArray(preference.tags) ? preference.tags : []),
      preference.archived ? 1 : 0,
      preference.updatedAt || new Date().toISOString()
    );
  }

  function deleteHostPreference(hostId) {
    stmts.deletePreference.run(hostId);
  }

  return {
    ensureHostsFile,
    readStoredHosts,
    writeStoredHosts,
    readHostPreferences,
    readHostPreference,
    writeHostPreference,
    deleteHostPreference,
  };
}

module.exports = {
  createHostRepository,
};

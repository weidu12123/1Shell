'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createDatabase } = require('../src/database/db');
const { createHostRepository } = require('../src/repositories/host.repository');

// 检测 better-sqlite3 是否可用
let sqliteAvailable = false;
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-probe-'));
  const testDb = createDatabase(path.join(tmp, 'probe.db'));
  if (testDb) { sqliteAvailable = true; testDb.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* not available */ }

describe('host.repository (SQLite mode)', { skip: !sqliteAvailable }, () => {
  let tmpDir, db, repo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-test-'));
    db = createDatabase(path.join(tmpDir, 'test.db'));
    repo = createHostRepository(path.join(tmpDir, 'hosts.json'), db);
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with empty hosts', () => {
    const hosts = repo.readStoredHosts();
    assert.deepEqual(hosts, []);
  });

  it('writes and reads hosts', () => {
    const hosts = [
      { id: 'h1', name: 'Host 1', host: '1.1.1.1', type: 'ssh' },
      { id: 'h2', name: 'Host 2', host: '2.2.2.2', type: 'ssh' },
    ];
    repo.writeStoredHosts(hosts);
    const result = repo.readStoredHosts();
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'h1');
    assert.equal(result[1].id, 'h2');
  });

  it('replaceAll overwrites existing data', () => {
    repo.writeStoredHosts([{ id: 'old', name: 'Old' }]);
    repo.writeStoredHosts([{ id: 'new', name: 'New' }]);
    const result = repo.readStoredHosts();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'new');
  });

  it('also writes JSON backup', () => {
    repo.writeStoredHosts([{ id: 'h1', name: 'Host 1' }]);
    const jsonPath = path.join(tmpDir, 'hosts.json');
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(json.length, 1);
    assert.equal(json[0].id, 'h1');
  });

  it('migrates from existing hosts.json on first create', () => {
    if (db) db.close();

    // Pre-populate hosts.json
    const jsonPath = path.join(tmpDir, 'hosts2.json');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { id: 'migrated1', name: 'Migrated' },
    ]));

    const db2 = createDatabase(path.join(tmpDir, 'test2.db'));
    const repo2 = createHostRepository(jsonPath, db2);
    const result = repo2.readStoredHosts();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'migrated1');
    db2.close();
  });
});

describe('host.repository (JSON fallback)', () => {
  let tmpDir, repo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-test-'));
    repo = createHostRepository(path.join(tmpDir, 'hosts.json'), null);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('works without SQLite', () => {
    repo.writeStoredHosts([{ id: 'j1', name: 'JSON Host' }]);
    const result = repo.readStoredHosts();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'j1');
  });
});

'use strict';

const { describe, it, beforeEach, afterEach, skip } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createDatabase } = require('../src/database/db');
const { createAuditService } = require('../src/services/audit.service');

const HAS_SQLITE = Boolean(createDatabase);

// 尝试创建测试数据库，判断 better-sqlite3 是否可用
let sqliteAvailable = false;
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-probe-'));
  const testDb = createDatabase(path.join(tmp, 'probe.db'));
  if (testDb) { sqliteAvailable = true; testDb.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* not available */ }

describe('audit.service (SQLite)', { skip: !sqliteAvailable }, () => {
  let tmpDir, db, audit;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-test-'));
    db = createDatabase(path.join(tmpDir, 'test.db'));
    audit = createAuditService({ db, dataDir: tmpDir });
  });

  afterEach(() => {
    try { if (db) db.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs and queries entries', () => {
    audit.log({ action: 'bridge_exec', hostId: 'h1', command: 'uname -r', exitCode: 0, durationMs: 100 });
    audit.log({ action: 'host_create', hostId: 'h2', hostName: 'Test Host' });

    const result = audit.query({ limit: 10 });
    assert.equal(result.source, 'sqlite');
    assert.equal(result.total, 2);
    assert.equal(result.logs.length, 2);
    assert.equal(result.logs[0].action, 'host_create');
    assert.equal(result.logs[1].action, 'bridge_exec');
  });

  it('truncates long commands', () => {
    const longCmd = 'x'.repeat(3000);
    audit.log({ action: 'bridge_exec', command: longCmd });
    const result = audit.query({ limit: 1 });
    assert.ok(result.logs[0].command.length <= 2000);
  });

  it('supports pagination', () => {
    for (let i = 0; i < 10; i++) {
      audit.log({ action: 'test', details: String(i) });
    }
    const page1 = audit.query({ limit: 3, offset: 0 });
    const page2 = audit.query({ limit: 3, offset: 3 });
    assert.equal(page1.logs.length, 3);
    assert.equal(page2.logs.length, 3);
    assert.equal(page1.total, 10);
    assert.notEqual(page1.logs[0].id, page2.logs[0].id);
  });
});

describe('audit.service (file fallback)', () => {
  let tmpDir, audit;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-test-'));
    audit = createAuditService({ db: null, dataDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes to file when no db', () => {
    audit.log({ action: 'file_test', command: 'echo hi' });
    const logFile = path.join(tmpDir, 'audit.log');
    assert.ok(fs.existsSync(logFile));
    const line = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    assert.equal(line.action, 'file_test');
  });
});

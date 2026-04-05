'use strict';

const path = require('path');

/**
 * SQLite 数据库管理
 *
 * 使用 better-sqlite3（同步 API，无需 async），替代 hosts.json 文件存储。
 * 表结构：
 *   - hosts: 主机信息（含加密凭据）
 *   - audit_logs: 操作审计日志
 */

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  // better-sqlite3 未安装时降级为 null
  Database = null;
}

function createDatabase(dbPath) {
  if (!Database) {
    return null;
  }

  let db;
  try {
    db = new Database(dbPath, { fileMustExist: false });
  } catch {
    // native binding 缺失时降级为无数据库模式
    console.warn('[DB] better-sqlite3 native binding 不可用，降级为文件存储模式');
    // 注意：此处保留 console.warn 因为 logger 可能依赖尚未初始化的模块
    return null;
  }

  // WAL 模式，提升并发读性能
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 初始化表结构
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      host_id TEXT,
      host_name TEXT,
      command TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      client_ip TEXT,
      error TEXT,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_host_id ON audit_logs(host_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
  `);

  return db;
}

module.exports = { createDatabase };

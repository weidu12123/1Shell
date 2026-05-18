'use strict';

const { runMigrations } = require('./migrations');

/**
 * SQLite 数据库管理
 *
 * 使用 better-sqlite3（同步 API）。表结构由 migrations.js 统一管理。
 */

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  // better-sqlite3 未安装时降级为 null
  Database = null;
}

function createDatabase(dbPath, { logger } = {}) {
  if (!Database) {
    return null;
  }

  let db;
  try {
    db = new Database(dbPath, { fileMustExist: false });
  } catch {
    // native binding 缺失时降级为无数据库模式
    console.warn('[DB] better-sqlite3 native binding 不可用，降级为文件存储模式');
    return null;
  }

  // WAL 模式，提升并发读性能
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 通过版本化 migrations 初始化 / 升级表结构
  runMigrations(db, { logger });

  return db;
}

module.exports = { createDatabase };

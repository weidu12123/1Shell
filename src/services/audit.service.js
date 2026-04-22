'use strict';

/**
 * 审计日志服务
 *
 * 记录所有通过 Bridge API / MCP / SSH Session 执行的操作。
 * 审计日志仅追加，不支持删除（满足合规要求）。
 *
 * 如果 SQLite 不可用，降级为文件日志。
 */

const fs = require('fs');
const path = require('path');

function createAuditService({ db, dataDir }) {
  const LOG_FILE = path.join(dataDir, 'audit.log');

  // SQLite 模式
  const insertStmt = db
    ? db.prepare(`
        INSERT INTO audit_logs (action, source, host_id, host_name, command, exit_code, duration_ms, client_ip, error, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    : null;

  // 筛选查询通过动态拼接 WHERE 子句实现（参数化防注入）

  /**
   * 记录一条审计日志。
   *
   * @param {object} entry
   * @param {string} entry.action - 操作类型：bridge_exec / mcp_tool_call / ssh_session_open / ssh_session_close / host_create / host_update / host_delete / login
   * @param {string} [entry.source] - 来源：bridge_api / mcp / web_ui / socket
   * @param {string} [entry.hostId] - 目标主机 ID
   * @param {string} [entry.hostName] - 目标主机名称
   * @param {string} [entry.command] - 执行的命令
   * @param {number} [entry.exitCode] - 退出码
   * @param {number} [entry.durationMs] - 执行耗时
   * @param {string} [entry.clientIp] - 客户端 IP
   * @param {string} [entry.error] - 错误信息
   * @param {string} [entry.details] - 额外信息（JSON string）
   */
  function log(entry) {
    try {
      if (insertStmt) {
        insertStmt.run(
          entry.action || 'unknown',
          entry.source || 'unknown',
          entry.hostId || null,
          entry.hostName || null,
          entry.command ? entry.command.substring(0, 2000) : null,
          entry.exitCode ?? null,
          entry.durationMs ?? null,
          entry.clientIp || null,
          entry.error ? String(entry.error).substring(0, 1000) : null,
          entry.details || null,
        );
      } else {
        // 降级：追加文件
        const line = JSON.stringify({
          timestamp: new Date().toISOString(),
          ...entry,
          command: entry.command ? entry.command.substring(0, 2000) : undefined,
        });
        fs.appendFileSync(LOG_FILE, line + '\n');
      }
    } catch {
      // 审计日志写入失败不应阻塞业务
    }
  }

  /**
   * 查询审计日志（分页 + 筛选）。
   */
  function query({ limit = 50, offset = 0, action, source, hostId, keyword } = {}) {
    if (!db) {
      return { logs: [], total: 0, source: 'file' };
    }

    const conditions = [];
    const params = [];

    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (source) {
      conditions.push('source = ?');
      params.push(source);
    }
    if (hostId) {
      conditions.push('(host_id = ? OR host_name = ?)');
      params.push(hostId, hostId);
    }
    if (keyword) {
      conditions.push('(command LIKE ? OR host_name LIKE ? OR error LIKE ? OR details LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const logs = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(limit, 200), Math.max(offset, 0));
    const { total } = db.prepare(`SELECT COUNT(*) as total FROM audit_logs ${where}`)
      .get(...params);

    return { logs, total, source: 'sqlite' };
  }

  return { log, query };
}

module.exports = { createAuditService };

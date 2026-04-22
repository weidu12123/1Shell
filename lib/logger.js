'use strict';

/**
 * 轻量结构化日志
 *
 * 替代散落的 console.log，提供分级输出和结构化 JSON 格式。
 * 生产环境输出 JSON 便于采集，开发环境保持可读文本。
 *
 * 使用方式：
 *   const log = require('./lib/logger');
 *   log.info('服务器启动', { port: 3301 });
 *   log.error('连接失败', { hostId, error: err.message });
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const ENV_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN_LEVEL = LOG_LEVELS[ENV_LEVEL] ?? LOG_LEVELS.info;
const IS_PROD = process.env.NODE_ENV === 'production';

function formatDev(level, msg, meta) {
  const ts = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const metaStr = meta && Object.keys(meta).length > 0
    ? ' ' + JSON.stringify(meta)
    : '';
  return `${ts} [${tag}] ${msg}${metaStr}`;
}

function formatJson(level, msg, meta) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  });
}

function emit(level, msg, meta = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;

  const line = IS_PROD ? formatJson(level, msg, meta) : formatDev(level, msg, meta);

  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};

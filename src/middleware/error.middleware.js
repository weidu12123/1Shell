'use strict';

const log = require('../../lib/logger');

/**
 * 全局错误处理中间件
 *
 * 分类处理不同错误类型，结构化响应，记录日志。
 */
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  // JSON 解析错误
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: '请求体 JSON 格式错误' });
  }

  const status = Number.isInteger(err?.status) ? err.status : 500;
  const message = err?.message || '服务内部错误';
  const code = err?.code || undefined;

  // 5xx 错误记录详细日志
  if (status >= 500) {
    log.error('服务内部错误', {
      method: req.method,
      url: req.originalUrl,
      status,
      code,
      message,
      stack: err?.stack?.split('\n').slice(0, 3).join(' ← '),
    });
  } else if (status >= 400) {
    // 4xx 记录 warn 级别
    log.warn('客户端错误', {
      method: req.method,
      url: req.originalUrl,
      status,
      message,
    });
  }

  const body = { error: message };
  if (code) body.code = code;

  return res.status(status).json(body);
}

module.exports = {
  errorHandler,
};

'use strict';

/**
 * 简易滑动窗口限流中间件
 *
 * 按 IP 地址限制请求频率，防止 AI 接口被滥用或触发上游 API 限流。
 * 不依赖外部存储，内存内维护滑动窗口计数。
 */
function createRateLimiter({
  windowMs = 60 * 1000,
  maxRequests = 30,
  message = '请求过于频繁，请稍后再试',
} = {}) {
  // Map<ip, { timestamps: number[] }>
  const clients = new Map();

  // 定期清理过期记录，防止内存泄漏
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of clients.entries()) {
      record.timestamps = record.timestamps.filter((t) => now - t < windowMs);
      if (record.timestamps.length === 0) clients.delete(ip);
    }
  }, windowMs * 2);
  cleanupInterval.unref?.();

  return function rateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown';

    const now = Date.now();
    let record = clients.get(ip);
    if (!record) {
      record = { timestamps: [] };
      clients.set(ip, record);
    }

    // 清除窗口外的时间戳
    record.timestamps = record.timestamps.filter((t) => now - t < windowMs);

    if (record.timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((record.timestamps[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    record.timestamps.push(now);
    return next();
  };
}

module.exports = { createRateLimiter };

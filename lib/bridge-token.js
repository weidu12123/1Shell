'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Bridge Token 自动管理
 *
 * 优先级：
 *   1. process.env.BRIDGE_TOKEN（用户手动设置时优先）
 *   2. data/bridge-token.json（已自动生成的持久化 token）
 *   3. 自动生成并持久化到 data/bridge-token.json
 *
 * 结果会写回 process.env.BRIDGE_TOKEN，
 * 确保 src/config/env.js 后续读取时能拿到正确的值。
 */
function ensureBridgeToken(dataDir) {
  if (process.env.BRIDGE_TOKEN && process.env.BRIDGE_TOKEN.trim()) {
    return process.env.BRIDGE_TOKEN.trim();
  }

  const tokenFile = path.join(dataDir, 'bridge-token.json');

  // 尝试从持久化文件读取
  try {
    const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (saved && typeof saved.token === 'string' && saved.token.trim()) {
      process.env.BRIDGE_TOKEN = saved.token.trim();
      return saved.token.trim();
    }
  } catch {
    // 文件不存在或格式错误，继续生成
  }

  // 首次启动：自动生成
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2));
  process.env.BRIDGE_TOKEN = token;
  return token;
}

module.exports = { ensureBridgeToken };

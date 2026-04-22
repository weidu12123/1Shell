'use strict';

const crypto = require('crypto');

const FALLBACK_SECRET = 'change-me-before-production';
const LEGACY_SALT = 'ai-web-terminal';

function resolveSecret() {
  return process.env.APP_SECRET || process.env.WEB_TERMINAL_SECRET || '';
}

function deriveKey(salt) {
  const secret = resolveSecret() || FALLBACK_SECRET;
  return crypto.scryptSync(secret, salt, 32);
}

function encryptText(plainText) {
  if (!plainText) return null;

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final(),
  ]);

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64'),
  };
}

function decryptText(payload) {
  if (!payload || !payload.value) return '';

  // 有 salt 字段则使用随机盐，否则回退到旧版硬编码盐（向后兼容）
  const salt = payload.salt
    ? Buffer.from(payload.salt, 'base64')
    : LEGACY_SALT;

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveKey(salt),
      Buffer.from(payload.iv, 'base64'),
    );

    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.value, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      '凭据解密失败：APP_SECRET 可能与加密时不一致。请使用原始 APP_SECRET，或重新编辑该主机的凭据。'
    );
  }
}

function isUsingFallbackSecret() {
  return !resolveSecret();
}

module.exports = {
  decryptText,
  encryptText,
  isUsingFallbackSecret,
};

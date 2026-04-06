'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { encryptText, decryptText, isUsingFallbackSecret } = require('../lib/crypto');

describe('crypto', () => {
  it('encrypts and decrypts text', () => {
    const plain = 'my-secret-password-123!@#';
    const encrypted = encryptText(plain);
    assert.ok(encrypted.salt, 'should have random salt');
    assert.ok(encrypted.iv);
    assert.ok(encrypted.tag);
    assert.ok(encrypted.value);
    assert.equal(decryptText(encrypted), plain);
  });

  it('handles empty/null input', () => {
    assert.equal(encryptText(null), null);
    assert.equal(encryptText(''), null);
    assert.equal(decryptText(null), '');
    assert.equal(decryptText({}), '');
  });

  it('throws friendly error on tampered data', () => {
    const encrypted = encryptText('test');
    encrypted.value = 'AAAA' + encrypted.value.substring(4);
    assert.throws(() => decryptText(encrypted), /凭据解密失败/);
  });

  it('each encryption produces unique salt', () => {
    const a = encryptText('same-text');
    const b = encryptText('same-text');
    assert.notEqual(a.salt, b.salt, 'salts should differ per encryption');
    assert.equal(decryptText(a), 'same-text');
    assert.equal(decryptText(b), 'same-text');
  });

  it('decrypts legacy payload without salt field (backward compat)', () => {
    // Simulate a payload encrypted with old hardcoded salt
    const crypto = require('crypto');
    const secret = process.env.APP_SECRET || process.env.WEB_TERMINAL_SECRET || 'change-me-before-production';
    const legacySalt = 'ai-web-terminal';
    const key = crypto.scryptSync(secret, legacySalt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('legacy-data', 'utf8'), cipher.final()]);
    const legacyPayload = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      value: encrypted.toString('base64'),
      // no salt field
    };
    assert.equal(decryptText(legacyPayload), 'legacy-data');
  });

  it('reports fallback secret status', () => {
    // 在测试环境中 APP_SECRET 可能未设置
    assert.equal(typeof isUsingFallbackSecret(), 'boolean');
  });
});

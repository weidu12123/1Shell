'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { encryptText, decryptText, isUsingFallbackSecret } = require('../lib/crypto');

describe('crypto', () => {
  it('encrypts and decrypts text', () => {
    const plain = 'my-secret-password-123!@#';
    const encrypted = encryptText(plain);
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

  it('reports fallback secret status', () => {
    // 在测试环境中 APP_SECRET 可能未设置
    assert.equal(typeof isUsingFallbackSecret(), 'boolean');
  });
});

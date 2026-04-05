'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── validators ────────────────────────────────────────────────────────────

const {
  validateHostPayload,
  validateSessionCreatePayload,
  validateChatRequestBody,
} = require('../src/utils/validators');

describe('validators', () => {
  describe('validateHostPayload', () => {
    it('accepts valid password host', () => {
      const result = validateHostPayload({
        name: 'test', host: '1.2.3.4', port: 22,
        username: 'root', authType: 'password', password: 'secret',
      });
      assert.equal(result.name, 'test');
      assert.equal(result.authType, 'password');
    });

    it('accepts proxyHostId', () => {
      const result = validateHostPayload({
        name: 'test', host: '10.0.0.1', port: 22,
        username: 'root', authType: 'password', password: 'pw',
        proxyHostId: 'host_abc123',
      });
      assert.equal(result.proxyHostId, 'host_abc123');
    });

    it('normalizes null proxyHostId', () => {
      const result = validateHostPayload({
        name: 'test', host: '10.0.0.1', port: 22,
        username: 'root', authType: 'password', password: 'pw',
        proxyHostId: '',
      });
      assert.equal(result.proxyHostId, null);
    });

    it('rejects empty name', () => {
      assert.throws(() => validateHostPayload({
        name: '', host: '1.2.3.4', port: 22,
        username: 'root', authType: 'password', password: 'pw',
      }), /名称/);
    });

    it('rejects invalid port', () => {
      assert.throws(() => validateHostPayload({
        name: 'test', host: '1.2.3.4', port: 99999,
        username: 'root', authType: 'password', password: 'pw',
      }), /端口/);
    });

    it('rejects missing password for password auth', () => {
      assert.throws(() => validateHostPayload({
        name: 'test', host: '1.2.3.4', port: 22,
        username: 'root', authType: 'password',
      }), /密码/);
    });

    it('rejects invalid authType', () => {
      assert.throws(() => validateHostPayload({
        name: 'test', host: '1.2.3.4', port: 22,
        username: 'root', authType: 'invalid', password: 'pw',
      }), /认证/);
    });

    it('accepts links array', () => {
      const result = validateHostPayload({
        name: 'test', host: '1.2.3.4', port: 22,
        username: 'root', authType: 'password', password: 'pw',
        links: [{ name: 'site', url: 'https://example.com' }],
      });
      assert.equal(result.links.length, 1);
      assert.equal(result.links[0].name, 'site');
    });
  });

  describe('validateSessionCreatePayload', () => {
    it('accepts valid payload', () => {
      const result = validateSessionCreatePayload({ hostId: 'local' });
      assert.equal(result.hostId, 'local');
    });

    it('rejects empty hostId', () => {
      assert.throws(() => validateSessionCreatePayload({ hostId: '' }), /hostId/);
    });
  });

  describe('validateChatRequestBody', () => {
    it('accepts valid chat messages', () => {
      const result = validateChatRequestBody({
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(result.messages.length, 1);
    });

    it('rejects empty messages', () => {
      assert.throws(() => validateChatRequestBody({ messages: [] }), /messages/);
    });
  });
});

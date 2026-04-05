'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// ─── Mock 依赖 ──────────────────────────────────────────────────────────────

class MockStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.written = [];
  }
  write(data) { this.written.push(data); }
}

class MockClient extends EventEmitter {
  constructor({ execError, exitCode = 0, stdout = '', stderr = '' } = {}) {
    super();
    this._execError = execError;
    this._exitCode = exitCode;
    this._stdout = stdout;
    this._stderr = stderr;
  }
  exec(cmd, cb) {
    if (this._execError) return cb(this._execError);
    const stream = new MockStream();
    cb(null, stream);
    // 模拟异步输出
    process.nextTick(() => {
      if (this._stdout) stream.emit('data', Buffer.from(this._stdout));
      if (this._stderr) stream.stderr.emit('data', Buffer.from(this._stderr));
      stream.emit('close', this._exitCode);
    });
  }
  end() {}
}

function createMockHostService(hosts = {}) {
  return {
    findHost: (id) => hosts[id] || null,
    connectToHost: (id) => {
      const host = hosts[id];
      if (!host) return Promise.reject(new Error('主机不存在'));
      if (host._client) return Promise.resolve({ client: host._client, proxyClient: null });
      return Promise.resolve({ client: new MockClient(host._mockExec || {}), proxyClient: null });
    },
  };
}

function createMockSshPool(hostService) {
  const pool = new Map();
  return {
    acquire: async (hostId) => {
      const { client, proxyClient } = await hostService.connectToHost(hostId);
      pool.set(hostId, { client, proxyClient });
      return { client, proxyClient, fromPool: false };
    },
    returnToPool: (hostId) => { pool.delete(hostId); },
    release: (hostId) => { pool.delete(hostId); },
    closeAll: () => { pool.clear(); },
  };
}

function createMockAuditService() {
  const logs = [];
  return {
    log: (entry) => { logs.push(entry); },
    query: () => ({ logs, total: logs.length, source: 'mock' }),
    getLogs: () => logs,
  };
}

// ─── Bridge Service 测试 ────────────────────────────────────────────────────

const { createBridgeService } = require('../src/services/bridge.service');

describe('BridgeService', () => {
  let hostService, sshPool, auditService, bridgeService;

  beforeEach(() => {
    hostService = createMockHostService({
      'host_1': {
        id: 'host_1', type: 'ssh', name: 'Test VPS',
        host: '1.2.3.4', port: 22, username: 'root',
        _mockExec: { stdout: 'hello world\n', exitCode: 0 },
      },
      'host_fail': {
        id: 'host_fail', type: 'ssh', name: 'Fail VPS',
        host: '5.6.7.8', port: 22, username: 'root',
        _mockExec: { execError: new Error('exec failed') },
      },
    });
    sshPool = createMockSshPool(hostService);
    auditService = createMockAuditService();
    bridgeService = createBridgeService({ hostService, auditService, sshPool });
  });

  it('execOnHost returns stdout and exitCode', async () => {
    const result = await bridgeService.execOnHost('host_1', 'echo hello', 5000);
    assert.equal(result.stdout, 'hello world\n');
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.durationMs, 'number');
  });

  it('execOnHost records audit log', async () => {
    await bridgeService.execOnHost('host_1', 'test cmd', 5000);
    const logs = auditService.getLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'bridge_exec');
    assert.equal(logs[0].hostId, 'host_1');
  });

  it('execOnHost rejects for unknown host', async () => {
    await assert.rejects(
      () => bridgeService.execOnHost('nonexistent', 'cmd', 5000),
      /主机不存在/,
    );
  });

  it('execOnHost handles exec error', async () => {
    await assert.rejects(
      () => bridgeService.execOnHost('host_fail', 'cmd', 5000),
      /SSH exec 失败/,
    );
  });

  it('execOnHost captures stderr', async () => {
    hostService = createMockHostService({
      'host_err': {
        id: 'host_err', type: 'ssh', name: 'Err VPS',
        host: '1.1.1.1', port: 22, username: 'root',
        _mockExec: { stdout: '', stderr: 'not found\n', exitCode: 1 },
      },
    });
    sshPool = createMockSshPool(hostService);
    bridgeService = createBridgeService({ hostService, auditService, sshPool });

    const result = await bridgeService.execOnHost('host_err', 'bad cmd', 5000);
    assert.equal(result.stderr, 'not found\n');
    assert.equal(result.exitCode, 1);
  });
});

// ─── File Service 测试 ──────────────────────────────────────────────────────

const { createFileService } = require('../src/services/file.service');
const os = require('os');
const path = require('path');

describe('FileService', () => {
  let fileService;

  beforeEach(() => {
    const hostService = createMockHostService({
      local: { id: 'local', type: 'local', name: '本机' },
    });
    const sshPool = createMockSshPool(hostService);
    fileService = createFileService({ hostService });
  });

  it('listDir returns items for local home directory', async () => {
    const result = await fileService.listDir('local', os.homedir());
    assert.equal(typeof result.path, 'string');
    assert.equal(typeof result.parent, 'string');
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length > 0);
  });

  it('listDir items have correct shape', async () => {
    const result = await fileService.listDir('local', os.homedir());
    const item = result.items[0];
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.path, 'string');
    assert.equal(typeof item.isDir, 'boolean');
    assert.equal(typeof item.size, 'number');
  });

  it('listDir sorts directories first', async () => {
    const result = await fileService.listDir('local', os.homedir());
    const firstFile = result.items.findIndex((i) => !i.isDir);
    const lastDir = result.items.length - 1 - [...result.items].reverse().findIndex((i) => i.isDir);
    // 所有目录应在文件之前
    if (firstFile !== -1 && lastDir !== -1) {
      assert.ok(lastDir < firstFile, '目录应排在文件之前');
    }
  });

  it('listDir rejects for unknown host', async () => {
    await assert.rejects(
      () => fileService.listDir('nonexistent', '/'),
      /主机不存在/,
    );
  });

  it('readFile reads a local text file', async () => {
    // 读取 package.json 作为测试
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const result = await fileService.readFile('local', pkgPath);
    assert.ok(result.content.includes('"name"'));
    assert.ok(result.size > 0);
  });

  it('readFile rejects for nonexistent file', async () => {
    await assert.rejects(
      () => fileService.readFile('local', '/nonexistent/file.txt'),
    );
  });
});

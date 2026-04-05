'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const { createHostService } = require('../src/services/host.service');
const { createHostRepository } = require('../src/repositories/host.repository');

// ─── Mock SSH2 Client ─────────────────────────────────────────────────────
// 替换 require('ssh2').Client，验证 connectToHost 的级联逻辑

class MockStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.destroyed = false;
  }
  write() {}
  destroy() { this.destroyed = true; }
  setWindow() {}
}

class MockClient extends EventEmitter {
  constructor() {
    super();
    this._connectCfg = null;
    this._forwardOutCb = null;
  }
  connect(cfg) {
    this._connectCfg = cfg;
    // 模拟异步 ready
    process.nextTick(() => this.emit('ready'));
  }
  exec(cmd, cb) {
    const stream = new MockStream();
    cb(null, stream);
    // 模拟命令输出
    process.nextTick(() => {
      stream.emit('data', Buffer.from(`mock-output-for: ${cmd}\n`));
      stream.emit('close', 0);
    });
  }
  shell(opts, cb) {
    const stream = new MockStream();
    cb(null, stream);
  }
  forwardOut(srcIP, srcPort, dstHost, dstPort, cb) {
    const stream = new MockStream();
    stream._dstHost = dstHost;
    stream._dstPort = dstPort;
    cb(null, stream);
  }
  end() {}
}

// ─── 测试用的加密/存储环境 ───────────────────────────────────────────────

describe('host.service.connectToHost', () => {
  let tmpDir, hostService, mockClientInstances;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-integ-'));
    const hostRepository = createHostRepository(path.join(tmpDir, 'hosts.json'), null);

    // 设置 APP_SECRET 确保加密可用
    process.env.APP_SECRET = 'test-secret-for-integration-tests-2026';

    hostService = createHostService({ hostRepository });

    // 写入测试主机
    const directHost = hostService.buildStoredHost({
      name: 'Direct Host',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'direct-pw',
    });

    const proxyHost = hostService.buildStoredHost({
      name: 'Proxy Host',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'proxy-pw',
    });

    const targetBehindProxy = hostService.buildStoredHost({
      name: 'Target Behind Proxy',
      host: '192.168.1.100',
      port: 22,
      username: 'user',
      authType: 'password',
      password: 'target-pw',
      proxyHostId: proxyHost.id,
    });

    hostRepository.writeStoredHosts([directHost, proxyHost, targetBehindProxy]);

    // 替换 ssh2.Client
    mockClientInstances = [];
    const origRequire = require('ssh2');
    // 因为 host.service 内部 require('ssh2')，我们需要 mock
    // 通过修改 require cache 实现
    require.cache[require.resolve('ssh2')] = {
      id: require.resolve('ssh2'),
      filename: require.resolve('ssh2'),
      loaded: true,
      exports: {
        ...origRequire,
        Client: class extends MockClient {
          constructor() {
            super();
            mockClientInstances.push(this);
          }
        },
      },
    };

    // 重新加载 host.service 以获取 mock
    delete require.cache[require.resolve('../src/services/host.service')];
    const { createHostService: recreate } = require('../src/services/host.service');
    hostService = recreate({ hostRepository });
  });

  afterEach(() => {
    // 恢复原始 ssh2
    delete require.cache[require.resolve('ssh2')];
    delete require.cache[require.resolve('../src/services/host.service')];
    delete process.env.APP_SECRET;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('直连主机：创建一个 Client 实例', async () => {
    const hosts = hostService.listHosts().filter(h => h.name === 'Direct Host');
    assert.equal(hosts.length, 1);

    const { client, proxyClient } = await hostService.connectToHost(hosts[0].id);
    assert.ok(client);
    assert.equal(proxyClient, null);
    assert.equal(mockClientInstances.length, 1);
    // 验证连接配置
    assert.equal(mockClientInstances[0]._connectCfg.host, '10.0.0.1');
    assert.equal(mockClientInstances[0]._connectCfg.username, 'root');
  });

  it('跳板连接：创建两个 Client 实例（proxy + target）', async () => {
    const hosts = hostService.listHosts().filter(h => h.name === 'Target Behind Proxy');
    assert.equal(hosts.length, 1);

    const { client, proxyClient } = await hostService.connectToHost(hosts[0].id);
    assert.ok(client);
    assert.ok(proxyClient);
    // proxy + target = 2 个实例
    assert.equal(mockClientInstances.length, 2);
    // 第一个是 proxy，连接到 1.2.3.4
    assert.equal(mockClientInstances[0]._connectCfg.host, '1.2.3.4');
    // 第二个是 target，通过 sock 连接（无 host 字段）
    assert.equal(mockClientInstances[1]._connectCfg.host, undefined);
    assert.ok(mockClientInstances[1]._connectCfg.sock); // sock 来自 forwardOut
  });

  it('不存在的主机：抛出错误', async () => {
    await assert.rejects(
      () => hostService.connectToHost('nonexistent-host'),
      /主机不存在/
    );
  });

  it('拒绝多级跳板', async () => {
    // 创建一个 proxy 的 proxy
    const hosts = hostService.listHosts().filter(h => h.type === 'ssh');
    const proxyHost = hosts.find(h => h.name === 'Proxy Host');
    const targetHost = hosts.find(h => h.name === 'Target Behind Proxy');

    // 手动给 proxyHost 设置 proxyHostId（造成多级跳板）
    const allHosts = require(path.join(tmpDir, 'hosts.json'));
    const proxyRaw = allHosts.find(h => h.id === proxyHost.id);
    if (proxyRaw) {
      proxyRaw.proxyHostId = targetHost.id; // 循环引用
      fs.writeFileSync(path.join(tmpDir, 'hosts.json'), JSON.stringify(allHosts, null, 2));
    }

    // 重新创建 service 读取更新后的数据
    const { createHostRepository: reCreateRepo } = require('../src/repositories/host.repository');
    const { createHostService: reCreate } = require('../src/services/host.service');
    const newRepo = reCreateRepo(path.join(tmpDir, 'hosts.json'), null);
    const newService = reCreate({ hostRepository: newRepo });

    await assert.rejects(
      () => newService.connectToHost(targetHost.id),
      /多级跳板/
    );
  });
});

// ─── Bridge Service 集成测试 ────────────────────────────────────────────

describe('bridge.service integration', () => {
  let tmpDir, bridgeService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-bridge-'));
    process.env.APP_SECRET = 'test-secret-bridge-2026';

    const hostRepository = createHostRepository(path.join(tmpDir, 'hosts.json'), null);
    const hostService = createHostService({ hostRepository });

    const host = hostService.buildStoredHost({
      name: 'Bridge Test Host',
      host: '10.0.0.99',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'bridge-pw',
    });
    hostRepository.writeStoredHosts([host]);

    // Mock ssh2
    const origRequire = require('ssh2');
    require.cache[require.resolve('ssh2')] = {
      id: require.resolve('ssh2'),
      filename: require.resolve('ssh2'),
      loaded: true,
      exports: {
        ...origRequire,
        Client: MockClient,
      },
    };

    delete require.cache[require.resolve('../src/services/host.service')];
    delete require.cache[require.resolve('../src/services/bridge.service')];
    const { createHostService: reCreate } = require('../src/services/host.service');
    const { createBridgeService } = require('../src/services/bridge.service');

    const newHostService = reCreate({ hostRepository });
    bridgeService = createBridgeService({
      hostService: newHostService,
      auditService: { log() {} },
      sshPool: null,
    });

    // 保存 hostId 供测试使用
    this.testHostId = host.id;
  });

  afterEach(() => {
    delete require.cache[require.resolve('ssh2')];
    delete require.cache[require.resolve('../src/services/host.service')];
    delete require.cache[require.resolve('../src/services/bridge.service')];
    delete process.env.APP_SECRET;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('execOnHost 返回 mock 输出', async (t) => {
    const hosts = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hosts.json'), 'utf8'));
    const hostId = hosts[0].id;
    const result = await bridgeService.execOnHost(hostId, 'whoami');
    assert.ok(result.stdout.includes('mock-output-for: whoami'));
    assert.equal(result.exitCode, 0);
    assert.ok(result.durationMs >= 0);
  });

  it('不存在的 hostId 抛出错误', async () => {
    await assert.rejects(
      () => bridgeService.execOnHost('fake-id', 'echo test'),
      /主机不存在/
    );
  });
});

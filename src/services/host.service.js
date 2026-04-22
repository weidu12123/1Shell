'use strict';

const fs = require('fs');
const path = require('path');
const { decryptText, encryptText } = require('../../lib/crypto');
const { LOCAL_HOST_ID, ROOT_DIR } = require('../config/env');
const {
  createId,
  hasOwn,
  normalizeHttpUrl,
  normalizePort,
  nowIso,
} = require('../utils/common');

function createValidationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

const LOCAL_HOST_CONFIG_FILE = path.join(ROOT_DIR, 'data', 'local-host-config.json');

function loadLocalHostConfig() {
  try {
    const raw = fs.readFileSync(LOCAL_HOST_CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveLocalHostConfig(config) {
  fs.mkdirSync(path.dirname(LOCAL_HOST_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_HOST_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function createHostService({ hostRepository }) {
  function normalizeHostLinks(links) {
    if (!Array.isArray(links)) return [];

    return links
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || '').trim() || createId('link'),
        name: String(item.name || '').trim(),
        url: normalizeHttpUrl(item.url),
        description: String(item.description || '').trim(),
      }))
      .filter((link) => link.name && link.url);
  }

  function getLocalHost() {
    const config = loadLocalHostConfig();
    return {
      id: LOCAL_HOST_ID,
      type: 'local',
      name: config.name || '本机',
      host: '127.0.0.1',
      port: null,
      username: process.env.USER || process.env.USERNAME || 'local',
      authType: 'local',
      description: config.description || '部署当前项目的控制节点',
      links: config.links || [],
      createdAt: null,
      updatedAt: null,
    };
  }

  function toPublicHost(host) {
    if (!host) return null;

    if (host.id === LOCAL_HOST_ID || host.type === 'local') {
      return getLocalHost();
    }

    return {
      id: host.id,
      type: 'ssh',
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      authType: host.authType,
      proxyHostId: host.proxyHostId || null,
      links: normalizeHostLinks(host.links),
      hasPassword: Boolean(host.encryptedPassword),
      hasPrivateKey: Boolean(host.encryptedPrivateKey),
      hasPassphrase: Boolean(host.encryptedPassphrase),
      createdAt: host.createdAt || null,
      updatedAt: host.updatedAt || null,
    };
  }

  function listHosts() {
    return [getLocalHost(), ...hostRepository.readStoredHosts().map(toPublicHost)];
  }

  function findStoredHost(hostId) {
    return hostRepository.readStoredHosts().find((item) => item.id === hostId) || null;
  }

  function findHost(hostId) {
    if (hostId === LOCAL_HOST_ID) return getLocalHost();
    return findStoredHost(hostId);
  }

  function buildStoredHost(payload, existing = null) {
    const authType = payload.authType === 'privateKey' ? 'privateKey' : 'password';
    const timestamp = nowIso();

    const host = {
      id: existing?.id || createId('host'),
      type: 'ssh',
      name: String(payload.name || existing?.name || '').trim(),
      host: String(payload.host || existing?.host || '').trim(),
      port: normalizePort(payload.port ?? existing?.port, 22),
      username: String(payload.username || existing?.username || '').trim(),
      authType,
      proxyHostId: hasOwn(payload, 'proxyHostId')
        ? (String(payload.proxyHostId || '').trim() || null)
        : (existing?.proxyHostId || null),
      links: normalizeHostLinks(hasOwn(payload, 'links') ? payload.links : existing?.links),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      encryptedPassword: null,
      encryptedPrivateKey: null,
      encryptedPassphrase: null,
    };

    if (!host.name) throw createValidationError('主机名称不能为空');
    if (!host.host) throw createValidationError('主机地址不能为空');
    if (!host.username) throw createValidationError('用户名不能为空');

    if (authType === 'password') {
      let encryptedPassword = existing?.authType === 'password' ? existing.encryptedPassword : null;

      if (hasOwn(payload, 'password') && String(payload.password || '').trim()) {
        encryptedPassword = encryptText(String(payload.password));
      }

      if (!encryptedPassword) {
        throw createValidationError('密码认证需要填写密码');
      }

      host.encryptedPassword = encryptedPassword;
    } else {
      let encryptedPrivateKey = existing?.authType === 'privateKey' ? existing.encryptedPrivateKey : null;
      let encryptedPassphrase = existing?.authType === 'privateKey' ? existing.encryptedPassphrase : null;

      if (hasOwn(payload, 'privateKey') && String(payload.privateKey || '').trim()) {
        encryptedPrivateKey = encryptText(String(payload.privateKey));
      }

      if (hasOwn(payload, 'passphrase')) {
        encryptedPassphrase = String(payload.passphrase || '').trim()
          ? encryptText(String(payload.passphrase))
          : null;
      }

      if (!encryptedPrivateKey) {
        throw createValidationError('私钥认证需要填写私钥内容');
      }

      host.encryptedPrivateKey = encryptedPrivateKey;
      host.encryptedPassphrase = encryptedPassphrase;
    }

    return host;
  }

  function buildConnectionConfig(host) {
    if (!host || host.type !== 'ssh') {
      throw new Error('仅远程 SSH 主机需要连接配置');
    }

    const config = {
      host: host.host,
      port: normalizePort(host.port, 22),
      username: host.username,
      readyTimeout: 15000,
      keepaliveInterval: 10000,   // 每 10 秒发送 SSH keepalive，防止服务端关闭空闲连接
      keepaliveCountMax: 3,        // 最多 3 次无响应后视为断开，触发 error 事件
    };

    if (host.authType === 'privateKey') {
      config.privateKey = decryptText(host.encryptedPrivateKey);
      const passphrase = decryptText(host.encryptedPassphrase);
      if (passphrase) config.passphrase = passphrase;
    } else {
      config.password = decryptText(host.encryptedPassword);
    }

    return config;
  }

  /**
   * 建立到目标主机的 ssh2 Client 连接（自动处理跳板机级联）。
   *
   * 如果目标主机设置了 proxyHostId，会先连接到跳板机，
   * 通过 forwardOut 获取 stream 后再建立端到端加密连接。
   *
   * @param {string} hostId - 目标主机 ID
   * @param {object} [options] - 额外选项
   * @param {number} [options.readyTimeout] - 连接超时毫秒数
   * @returns {Promise<{client: Client, proxyClient: Client|null}>}
   */
  function connectToHost(hostId, options = {}) {
    const { Client } = require('ssh2');

    return new Promise((resolve, reject) => {
      const host = findStoredHost(hostId);
      if (!host) return reject(new Error(`主机不存在: ${hostId}`));
      if (host.type !== 'ssh') return reject(new Error('仅支持 SSH 主机'));

      const targetConfig = buildConnectionConfig(host);
      if (options.readyTimeout) targetConfig.readyTimeout = options.readyTimeout;

      const proxyHostId = host.proxyHostId;

      // 无跳板机：直连
      if (!proxyHostId) {
        const client = new Client();
        client.on('ready', () => resolve({ client, proxyClient: null }));
        client.on('error', (err) => reject(new Error(`SSH 连接失败: ${err.message}`)));
        try {
          client.connect(targetConfig);
        } catch (err) {
          reject(new Error(`SSH 配置构建失败: ${err.message}`));
        }
        return;
      }

      // 有跳板机：先连 proxy，再 forwardOut 到 target
      const proxyHost = findStoredHost(proxyHostId);
      if (!proxyHost) return reject(new Error(`跳板机不存在: ${proxyHostId}`));
      if (proxyHost.proxyHostId) return reject(new Error('暂不支持多级跳板机级联'));

      const proxyConfig = buildConnectionConfig(proxyHost);
      if (options.readyTimeout) proxyConfig.readyTimeout = options.readyTimeout;

      const proxyClient = new Client();

      proxyClient.on('ready', () => {
        const targetHost = targetConfig.host;
        const targetPort = targetConfig.port || 22;

        proxyClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
          if (err) {
            proxyClient.end();
            return reject(new Error(`跳板机 forwardOut 失败: ${err.message}`));
          }

          // 通过 forwardOut 的 stream 建立到目标机的连接
          const targetClient = new Client();
          const targetConnConfig = { ...targetConfig, sock: stream };
          delete targetConnConfig.host;
          delete targetConnConfig.port;

          targetClient.on('ready', () => resolve({ client: targetClient, proxyClient }));
          targetClient.on('error', (err2) => {
            proxyClient.end();
            reject(new Error(`目标主机连接失败（经跳板机）: ${err2.message}`));
          });

          try {
            targetClient.connect(targetConnConfig);
          } catch (err3) {
            proxyClient.end();
            reject(new Error(`目标主机配置构建失败: ${err3.message}`));
          }
        });
      });

      proxyClient.on('error', (err) => reject(new Error(`跳板机连接失败: ${err.message}`)));

      try {
        proxyClient.connect(proxyConfig);
      } catch (err) {
        reject(new Error(`跳板机配置构建失败: ${err.message}`));
      }
    });
  }

  return {
    buildConnectionConfig,
    buildStoredHost,
    connectToHost,
    findHost,
    findStoredHost,
    getLocalHost,
    listHosts,
    saveLocalHostConfig,
    toPublicHost,
  };
}

module.exports = {
  createHostService,
};

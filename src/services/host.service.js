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

function createNotFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

const LOCAL_HOST_CONFIG_FILE = path.join(ROOT_DIR, 'data', 'local-host-config.json');
const HOST_ROLES = new Set(['primary', 'project', 'probe', 'proxy', 'relay', 'test', 'archive']);

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
      manualLocation: config.manualLocation || null,
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
      manualLocation: host.manualLocation || null,
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
      manualLocation: hasOwn(payload, 'manualLocation')
        ? payload.manualLocation
        : (existing?.manualLocation || null),
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
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
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

  function connectToHost(hostId, options = {}) {
    const { Client } = require('ssh2');

    return new Promise((resolve, reject) => {
      const host = findStoredHost(hostId);
      if (!host) return reject(new Error(`主机不存在: ${hostId}`));
      if (host.type !== 'ssh') return reject(new Error('仅支持 SSH 主机'));

      const targetConfig = buildConnectionConfig(host);
      if (options.readyTimeout) targetConfig.readyTimeout = options.readyTimeout;

      const proxyHostId = host.proxyHostId;

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

  function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const result = [];
    for (const tag of tags) {
      const value = String(tag || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  function normalizePreference(hostId, raw = null, fallbackOrder = 0) {
    const consoleOrder = Number(raw?.consoleOrder);
    const role = raw?.role && HOST_ROLES.has(raw.role) ? raw.role : null;
    return {
      hostId,
      showInConsole: raw?.showInConsole !== false,
      consoleOrder: Number.isFinite(consoleOrder) ? consoleOrder : fallbackOrder,
      pinned: Boolean(raw?.pinned),
      role,
      tags: normalizeTags(raw?.tags),
      archived: Boolean(raw?.archived),
      updatedAt: raw?.updatedAt || nowIso(),
    };
  }

  function listPreferenceMap() {
    return new Map(hostRepository.readHostPreferences().map((preference) => [preference.hostId, preference]));
  }

  function ensureHostPreferences(hosts = listHosts()) {
    const map = listPreferenceMap();
    const maxOrder = [...map.values()].reduce((max, preference) => {
      const order = Number(preference.consoleOrder);
      return Number.isFinite(order) ? Math.max(max, order) : max;
    }, -1);
    let nextOrder = maxOrder + 1;

    return hosts.map((host, index) => {
      const existing = map.get(host.id);
      const fallbackOrder = existing ? index : nextOrder++;
      const preference = normalizePreference(host.id, existing, fallbackOrder);
      if (!existing) hostRepository.writeHostPreference(preference);
      return { ...host, preference };
    });
  }

  function ensurePreference(hostId) {
    const host = listHosts().find((item) => item.id === hostId);
    if (!host) throw createNotFoundError('主机不存在');
    const existing = hostRepository.readHostPreference(hostId);
    const preference = normalizePreference(hostId, existing, nextConsoleOrder());
    if (!existing) hostRepository.writeHostPreference(preference);
    return preference;
  }

  function nextConsoleOrder() {
    return hostRepository.readHostPreferences().reduce((max, preference) => {
      const order = Number(preference.consoleOrder);
      return Number.isFinite(order) ? Math.max(max, order) : max;
    }, -1) + 1;
  }

  function sortConsoleHosts(a, b) {
    if (a.preference.pinned !== b.preference.pinned) return a.preference.pinned ? -1 : 1;
    if (a.preference.consoleOrder !== b.preference.consoleOrder) {
      return a.preference.consoleOrder - b.preference.consoleOrder;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
  }

  function listHostsWithPreferences() {
    return ensureHostPreferences(listHosts());
  }

  function listConsoleHosts() {
    return listHostsWithPreferences()
      .filter((host) => host.preference.showInConsole && !host.preference.archived)
      .sort(sortConsoleHosts);
  }

  function detectProbeMode(probe) {
    if (!probe) return 'none';
    if (probe.source === 'relay_agent' || probe.relaySource) return 'relay';
    if (probe.source === 'agent' || probe.agentInstalled || probe.agentOnline) return 'agent';
    return 'agentless';
  }

  function getProbePlatformText(probe) {
    if (!probe) return null;
    if (probe.platform) return probe.platform;
    const info = probe.platformInfo;
    if (!info) return null;
    const name = info.prettyName || [info.distroId, info.versionId].filter(Boolean).join(' ') || info.os;
    const suffix = [info.arch, info.kernel].filter(Boolean).join(' / ');
    return [name, suffix].filter(Boolean).join(' / ') || null;
  }

  function toProbeSummary(probe, alertCount = 0) {
    if (!probe) {
      return {
        status: 'unknown',
        mode: 'none',
        cpu: null,
        cpuIowait: null,
        cpuSteal: null,
        memory: null,
        disk: null,
        load: null,
        trafficMonth: null,
        trafficPercent: null,
        lastSampleAt: null,
        alertCount,
        platform: null,
      };
    }
    return {
      status: probe.online === true ? 'online' : 'offline',
      mode: detectProbeMode(probe),
      cpu: probe.cpuUsage ?? null,
      cpuIowait: probe.cpuIowait ?? null,
      cpuSteal: probe.cpuSteal ?? null,
      memory: probe.memoryUsage ?? null,
      disk: probe.diskUsage ?? null,
      load: probe.load1 ?? null,
      trafficMonth: probe.trafficUsedBytes ?? null,
      trafficPercent: probe.trafficPercent ?? null,
      lastSampleAt: probe.checkedAt || probe.agentLastSeenAt || probe.trafficLastSampleAt || probe.lastSuccessAt || null,
      alertCount,
      platform: getProbePlatformText(probe),
    };
  }

  function toRepositoryItem(host, { probeMap, alertCountMap } = {}) {
    const probe = probeMap?.get(host.id) || null;
    return {
      id: host.id,
      name: host.name,
      type: host.type,
      host: host.host,
      user: host.username,
      username: host.username,
      port: host.port,
      authType: host.authType,
      proxyHostId: host.proxyHostId || null,
      links: host.links || [],
      manualLocation: host.manualLocation || null,
      preference: host.preference,
      probe: toProbeSummary(probe, alertCountMap?.get(host.id) || 0),
    };
  }

  function listRepositoryHosts(context = {}) {
    return listHostsWithPreferences().map((host) => toRepositoryItem(host, context));
  }

  function updateHostPreference(hostId, patch) {
    const current = ensurePreference(hostId);
    const next = { ...current };

    if (hasOwn(patch, 'showInConsole')) next.showInConsole = Boolean(patch.showInConsole);
    if (hasOwn(patch, 'consoleOrder')) {
      const order = Number(patch.consoleOrder);
      if (!Number.isFinite(order)) throw createValidationError('主控排序必须是数字');
      next.consoleOrder = order;
    }
    if (hasOwn(patch, 'pinned')) next.pinned = Boolean(patch.pinned);
    if (hasOwn(patch, 'role')) {
      const role = patch.role ? String(patch.role) : null;
      if (role && !HOST_ROLES.has(role)) throw createValidationError('未知主机角色');
      next.role = role;
    }
    if (hasOwn(patch, 'tags')) next.tags = normalizeTags(patch.tags);
    if (hasOwn(patch, 'archived')) next.archived = Boolean(patch.archived);

    next.updatedAt = nowIso();
    const normalized = normalizePreference(hostId, next, next.consoleOrder);
    hostRepository.writeHostPreference(normalized);
    return normalized;
  }

  function setConsoleOrder(hostIds, { replace = false } = {}) {
    if (!Array.isArray(hostIds)) throw createValidationError('hostIds 必须是数组');
    const allHosts = listHosts();
    const validIds = new Set(allHosts.map((host) => host.id));
    const uniqueIds = [];
    const seen = new Set();

    for (const id of hostIds) {
      const hostId = String(id || '').trim();
      if (!hostId || seen.has(hostId)) continue;
      if (!validIds.has(hostId)) throw createNotFoundError(`主机不存在: ${hostId}`);
      seen.add(hostId);
      uniqueIds.push(hostId);
    }

    ensureHostPreferences(allHosts);
    uniqueIds.forEach((hostId, index) => {
      updateHostPreference(hostId, {
        showInConsole: true,
        archived: false,
        consoleOrder: index,
      });
    });

    if (replace) {
      for (const host of allHosts) {
        if (!seen.has(host.id)) updateHostPreference(host.id, { showInConsole: false });
      }
    }

    return listConsoleHosts();
  }

  function ensureDefaultPreference(hostId) {
    const existing = hostRepository.readHostPreference(hostId);
    if (existing) return normalizePreference(hostId, existing, nextConsoleOrder());
    const preference = normalizePreference(hostId, null, nextConsoleOrder());
    hostRepository.writeHostPreference(preference);
    return preference;
  }

  function updateLocalHostManualLocation(manualLocation) {
    const existing = loadLocalHostConfig();
    saveLocalHostConfig({
      ...existing,
      manualLocation: manualLocation || null,
    });
  }

  return {
    buildConnectionConfig,
    buildStoredHost,
    connectToHost,
    ensureDefaultPreference,
    findHost,
    findStoredHost,
    getLocalHost,
    listConsoleHosts,
    listHosts,
    listHostsWithPreferences,
    listRepositoryHosts,
    saveLocalHostConfig,
    setConsoleOrder,
    toPublicHost,
    updateHostPreference,
    updateLocalHostManualLocation,
  };
}

module.exports = {
  createHostService,
};

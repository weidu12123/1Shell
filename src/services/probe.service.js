'use strict';

const os = require('os');
const { exec } = require('child_process');

const {
  LOCAL_HOST_ID,
  PROBE_INTERVAL_MS,
  PROBE_REMOTE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
} = require('../config/env');
const {
  nowIso,
  parseNumber,
  splitLoad,
} = require('../utils/common');
const {
  LOCAL_LINUX_EXTRA_COMMAND,
  REMOTE_PROBE_COMMAND,
} = require('./probe/commands');
const {
  parseDiskBytesText,
  parseInteger,
  parseKeyProcesses,
  parseNetworkBytesText,
  parseProbeOutput,
} = require('./probe/parsers');

function createProbeService({ hostRepository, hostService, sshShellPool }) {
  let lastLocalCpuSample = null;
  let latestSnapshot = {
    generatedAt: null,
    probes: [],
    sampleIntervalMs: PROBE_INTERVAL_MS,
  };
  let refreshInFlight = null;
  let schedulerTimer = null;
  const lastSuccessfulProbeMap = new Map();
  // 自适应超时：记录每台主机的历史延迟，动态调整超时
  const hostLatencyHistory = new Map(); // Map<hostId, number[]>

  /**
   * 获取自适应超时时间
   * 基于历史延迟的 2 倍 + 基础余量，上限为配置的 PROBE_TIMEOUT_MS
   */
  function getAdaptiveTimeout(hostId) {
    const history = hostLatencyHistory.get(hostId);
    if (!history || history.length === 0) return PROBE_TIMEOUT_MS;
    const avg = history.reduce((s, v) => s + v, 0) / history.length;
    const adaptive = Math.round(avg * 2 + 3000); // 2倍平均延迟 + 3秒余量
    return Math.min(Math.max(adaptive, 5000), PROBE_TIMEOUT_MS); // 最少5秒，不超过配置值
  }

  function recordLatency(hostId, latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;
    let history = hostLatencyHistory.get(hostId);
    if (!history) { history = []; hostLatencyHistory.set(hostId, history); }
    history.push(latencyMs);
    if (history.length > 10) history.shift(); // 保留最近10次
  }

  function execCommand(command, timeout = 4000) {
    return new Promise((resolve, reject) => {
      exec(command, { timeout }, (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve((stdout || stderr || '').trim());
      });
    });
  }

  function sampleLocalCpu() {
    const totals = os.cpus().map((cpu) => {
      const values = Object.values(cpu.times);
      const total = values.reduce((sum, item) => sum + item, 0);
      return { idle: cpu.times.idle, total };
    });

    const totalIdle = totals.reduce((sum, item) => sum + item.idle, 0);
    const totalTotal = totals.reduce((sum, item) => sum + item.total, 0);
    return { idle: totalIdle, total: totalTotal };
  }

  function getLocalCpuUsage() {
    const current = sampleLocalCpu();
    const previous = lastLocalCpuSample;
    lastLocalCpuSample = current;

    if (!previous) return null;

    const totalDiff = current.total - previous.total;
    const idleDiff = current.idle - previous.idle;
    if (totalDiff <= 0) return null;

    return Number((((totalDiff - idleDiff) / totalDiff) * 100).toFixed(2));
  }

  function buildRate(previousValue, currentValue, elapsedSeconds) {
    if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue) || elapsedSeconds <= 0) {
      return null;
    }

    const delta = currentValue - previousValue;
    if (delta < 0) return null;
    return Number((delta / elapsedSeconds).toFixed(2));
  }

  function buildTransferRates(previous, currentCheckedAtMs, currentProbe) {
    if (!previous) {
      return {
        bandwidthRxBps: null,
        bandwidthTxBps: null,
        diskReadBps: null,
        diskWriteBps: null,
      };
    }

    const elapsedSeconds = (currentCheckedAtMs - previous.checkedAtMs) / 1000;
    if (elapsedSeconds <= 0) {
      return {
        bandwidthRxBps: null,
        bandwidthTxBps: null,
        diskReadBps: null,
        diskWriteBps: null,
      };
    }

    return {
      bandwidthRxBps: buildRate(previous.networkRxBytes, currentProbe._networkRxBytes, elapsedSeconds),
      bandwidthTxBps: buildRate(previous.networkTxBytes, currentProbe._networkTxBytes, elapsedSeconds),
      diskReadBps: buildRate(previous.diskReadBytes, currentProbe._diskReadBytes, elapsedSeconds),
      diskWriteBps: buildRate(previous.diskWriteBytes, currentProbe._diskWriteBytes, elapsedSeconds),
    };
  }

  function cloneKeyProcesses(keyProcesses) {
    if (!Array.isArray(keyProcesses)) return [];
    return keyProcesses.map((item) => ({
      name: item.name,
      count: item.count,
      running: Boolean(item.running),
    }));
  }

  function rememberSuccessfulProbe(probe, checkedAtMs) {
    lastSuccessfulProbeMap.set(probe.hostId, {
      checkedAt: probe.checkedAt,
      checkedAtMs,
      hostname: probe.hostname || null,
      cpuUsage: probe.cpuUsage ?? null,
      memoryUsage: probe.memoryUsage ?? null,
      diskUsage: probe.diskUsage ?? null,
      uptimeSec: probe.uptimeSec ?? null,
      load1: probe.load1 ?? null,
      load5: probe.load5 ?? null,
      load15: probe.load15 ?? null,
      processCount: probe.processCount ?? null,
      keyProcesses: cloneKeyProcesses(probe.keyProcesses),
      bandwidthRxBps: probe.bandwidthRxBps ?? null,
      bandwidthTxBps: probe.bandwidthTxBps ?? null,
      diskReadBps: probe.diskReadBps ?? null,
      diskWriteBps: probe.diskWriteBps ?? null,
      networkRxBytes: probe._networkRxBytes ?? null,
      networkTxBytes: probe._networkTxBytes ?? null,
      diskReadBytes: probe._diskReadBytes ?? null,
      diskWriteBytes: probe._diskWriteBytes ?? null,
    });
  }

  function classifyProbeError(message) {
    const text = String(message || '').toLowerCase();
    if (!text) return 'UNKNOWN';
    if (text.includes('timed out') || text.includes('timeout') || text.includes('超时')) return 'TIMEOUT';
    if (text.includes('all configured authentication methods failed') || text.includes('permission denied') || text.includes('authentication')) return 'AUTH_FAILED';
    if (text.includes('getaddrinfo') || text.includes('enotfound') || text.includes('name or service not known')) return 'DNS_ERROR';
    if (text.includes('connection refused') || text.includes('econnrefused')) return 'CONNECTION_REFUSED';
    if (text.includes('no route to host')) return 'NO_ROUTE';
    if (text.includes('network is unreachable')) return 'NETWORK_UNREACHABLE';
    return 'SSH_ERROR';
  }

  function normalizeSuccessfulProbe(probe) {
    const checkedAtMs = probe._checkedAtMs || Date.now();
    const previous = lastSuccessfulProbeMap.get(probe.hostId);
    const transferRates = buildTransferRates(previous, checkedAtMs, probe);

    const normalized = {
      hostId: probe.hostId,
      name: probe.name,
      hostname: probe.hostname || probe.name,
      online: true,
      latencyMs: probe.latencyMs ?? null,
      cpuUsage: probe.cpuUsage ?? null,
      memoryUsage: probe.memoryUsage ?? null,
      diskUsage: probe.diskUsage ?? null,
      uptimeSec: probe.uptimeSec ?? null,
      checkedAt: probe.checkedAt,
      lastSuccessAt: probe.checkedAt,
      stale: false,
      error: null,
      errorCode: null,
      load1: probe.load1 ?? null,
      load5: probe.load5 ?? null,
      load15: probe.load15 ?? null,
      processCount: probe.processCount ?? null,
      keyProcesses: cloneKeyProcesses(probe.keyProcesses),
      bandwidthRxBps: transferRates.bandwidthRxBps,
      bandwidthTxBps: transferRates.bandwidthTxBps,
      diskReadBps: transferRates.diskReadBps,
      diskWriteBps: transferRates.diskWriteBps,
      _networkRxBytes: probe._networkRxBytes ?? null,
      _networkTxBytes: probe._networkTxBytes ?? null,
      _diskReadBytes: probe._diskReadBytes ?? null,
      _diskWriteBytes: probe._diskWriteBytes ?? null,
    };

    rememberSuccessfulProbe(normalized, checkedAtMs);
    delete normalized._networkRxBytes;
    delete normalized._networkTxBytes;
    delete normalized._diskReadBytes;
    delete normalized._diskWriteBytes;
    return normalized;
  }

  function normalizeFailedProbe(probe) {
    const previous = lastSuccessfulProbeMap.get(probe.hostId);
    const errorCode = probe.errorCode || classifyProbeError(probe.error);

    if (!previous) {
      return {
        hostId: probe.hostId,
        name: probe.name,
        hostname: probe.hostname || probe.name,
        online: false,
        latencyMs: probe.latencyMs ?? null,
        cpuUsage: null,
        memoryUsage: null,
        diskUsage: null,
        uptimeSec: null,
        checkedAt: probe.checkedAt,
        lastSuccessAt: null,
        stale: false,
        error: probe.error || '探测失败',
        errorCode,
        load1: null,
        load5: null,
        load15: null,
        processCount: null,
        keyProcesses: [],
        bandwidthRxBps: null,
        bandwidthTxBps: null,
        diskReadBps: null,
        diskWriteBps: null,
      };
    }

    return {
      hostId: probe.hostId,
      name: probe.name,
      hostname: previous.hostname || probe.hostname || probe.name,
      online: false,
      latencyMs: probe.latencyMs ?? null,
      cpuUsage: previous.cpuUsage,
      memoryUsage: previous.memoryUsage,
      diskUsage: previous.diskUsage,
      uptimeSec: previous.uptimeSec,
      checkedAt: probe.checkedAt,
      lastSuccessAt: previous.checkedAt,
      stale: true,
      error: probe.error || '探测失败',
      errorCode,
      load1: previous.load1,
      load5: previous.load5,
      load15: previous.load15,
      processCount: previous.processCount,
      keyProcesses: cloneKeyProcesses(previous.keyProcesses),
      bandwidthRxBps: null,
      bandwidthTxBps: null,
      diskReadBps: null,
      diskWriteBps: null,
    };
  }

  async function getLocalDiskUsage() {
    if (os.platform() === 'win32') return null;

    try {
      const output = await execCommand("df -Pk / | awk 'NR==2 {gsub(/%/, \"\", $5); print $5}'");
      return parseNumber(output);
    } catch {
      return null;
    }
  }

  async function getLocalLinuxExtras() {
    if (os.platform() === 'win32') {
      return {
        networkRxBytes: null,
        networkTxBytes: null,
        diskReadBytes: null,
        diskWriteBytes: null,
        processCount: null,
        keyProcesses: [],
      };
    }

    try {
      const output = await execCommand(LOCAL_LINUX_EXTRA_COMMAND);
      const parsed = parseProbeOutput(output);
      const network = parseNetworkBytesText(output, 'RX', 'TX');
      const disk = parseDiskBytesText(output, 'DISK_READ_BYTES', 'DISK_WRITE_BYTES');
      return {
        networkRxBytes: network.rxBytes,
        networkTxBytes: network.txBytes,
        diskReadBytes: disk.diskReadBytes,
        diskWriteBytes: disk.diskWriteBytes,
        processCount: parseInteger(parsed.PROC_COUNT),
        keyProcesses: parseKeyProcesses(parsed.KEY_PROC),
      };
    } catch {
      return {
        networkRxBytes: null,
        networkTxBytes: null,
        diskReadBytes: null,
        diskWriteBytes: null,
        processCount: null,
        keyProcesses: [],
      };
    }
  }

  async function probeLocalHost() {
    const checkedAtMs = Date.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const diskUsage = await getLocalDiskUsage();
    const extras = await getLocalLinuxExtras();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = totalMem > 0
      ? Number((((totalMem - freeMem) / totalMem) * 100).toFixed(2))
      : null;

    return {
      hostId: LOCAL_HOST_ID,
      name: '本机',
      hostname: os.hostname(),
      online: true,
      latencyMs: 0,
      cpuUsage: getLocalCpuUsage(),
      memoryUsage,
      diskUsage,
      uptimeSec: Math.round(os.uptime()),
      checkedAt,
      error: null,
      errorCode: null,
      processCount: extras.processCount,
      keyProcesses: extras.keyProcesses,
      _checkedAtMs: checkedAtMs,
      _networkRxBytes: extras.networkRxBytes,
      _networkTxBytes: extras.networkTxBytes,
      _diskReadBytes: extras.diskReadBytes,
      _diskWriteBytes: extras.diskWriteBytes,
      ...splitLoad(os.loadavg().join(' ')),
    };
  }

  function probeRemoteHost(host) {
    // 优先使用持久 shell 池（复用长连接，避免频繁 TCP 连接触发云安全告警）
    if (sshShellPool) {
      return probeRemoteViaShellPool(host);
    }
    return probeRemoteViaConnect(host);
  }

  /**
   * 通过持久 shell 池探测远程主机
   */
  async function probeRemoteViaShellPool(host) {
    const startedAt = Date.now();
    const timeout = getAdaptiveTimeout(host.id);

    try {
      const result = await sshShellPool.exec(host.id, REMOTE_PROBE_COMMAND, timeout);
      const latencyMs = Date.now() - startedAt;
      const stdout = result.stdout || '';

      if (result.exitCode !== 0 && !stdout.trim()) {
        return {
          hostId: host.id,
          name: host.name,
          checkedAt: nowIso(),
          online: false,
          latencyMs,
          error: result.stderr || `exit code ${result.exitCode}`,
          errorCode: 'REMOTE_ERROR',
        };
      }

      const parsed = parseProbeOutput(stdout);
      const disk = parseDiskBytesText(stdout, 'DISK_READ_BYTES', 'DISK_WRITE_BYTES');
      const load = splitLoad(parsed.LOAD);

      recordLatency(host.id, latencyMs);

      return {
        hostId: host.id,
        name: host.name,
        checkedAt: nowIso(),
        online: true,
        latencyMs,
        hostname: parsed.HOSTNAME || host.host,
        cpuUsage: parseNumber(parsed.CPU),
        memoryUsage: parseNumber(parsed.MEM),
        diskUsage: parseNumber(parsed.DISK),
        uptimeSec: parseInt(parsed.UPTIME, 10) || 0,
        error: null,
        errorCode: null,
        processCount: parseInteger(parsed.PROC_COUNT),
        keyProcesses: parseKeyProcesses(parsed.KEY_PROC),
        _checkedAtMs: Date.now(),
        _networkRxBytes: parseInteger(parsed.NET_RX),
        _networkTxBytes: parseInteger(parsed.NET_TX),
        _diskReadBytes: disk.diskReadBytes,
        _diskWriteBytes: disk.diskWriteBytes,
        ...load,
      };
    } catch (err) {
      return {
        hostId: host.id,
        name: host.name,
        checkedAt: nowIso(),
        online: false,
        latencyMs: Date.now() - startedAt,
        error: err.message,
        errorCode: classifyProbeError(err.message),
      };
    }
  }

  /**
   * 通过独立 SSH 连接探测远程主机（后备方案）
   */
  function probeRemoteViaConnect(host) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      let latencyMs = null;
      let targetClient = null;
      let proxyClient = null;
      const timeout = getAdaptiveTimeout(host.id);

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { targetClient?.end(); } catch { /* ignore */ }
        try { proxyClient?.end(); } catch { /* ignore */ }
        // 记录成功延迟用于自适应超时
        if (payload.online && payload.latencyMs > 0) {
          recordLatency(host.id, payload.latencyMs);
        }
        resolve({
          hostId: host.id,
          name: host.name,
          checkedAt: nowIso(),
          errorCode: payload.error ? (payload.errorCode || classifyProbeError(payload.error)) : null,
          ...payload,
        });
      };

      const timer = setTimeout(() => {
        finish({
          online: false,
          latencyMs,
          error: '探测超时',
          errorCode: 'TIMEOUT',
        });
      }, timeout);

      hostService.connectToHost(host.id, { readyTimeout: timeout })
        .then(({ client, proxyClient: proxy }) => {
          targetClient = client;
          proxyClient = proxy;
          latencyMs = Date.now() - startedAt;

          client.exec(REMOTE_PROBE_COMMAND, (err, stream) => {
            if (err) {
              finish({
                online: false,
                latencyMs,
                error: err.message,
                errorCode: 'EXEC_ERROR',
              });
              return;
            }

            let stdout = '';
            let stderr = '';

            stream.on('data', (chunk) => {
              stdout += chunk.toString('utf8');
            });

            stream.stderr?.on('data', (chunk) => {
              stderr += chunk.toString('utf8');
            });

            stream.on('close', () => {
              if (stderr.trim() && !stdout.trim()) {
                finish({
                  online: false,
                  latencyMs,
                  error: stderr.trim(),
                  errorCode: 'REMOTE_ERROR',
                });
                return;
              }

              const parsed = parseProbeOutput(stdout);
              const disk = parseDiskBytesText(stdout, 'DISK_READ_BYTES', 'DISK_WRITE_BYTES');
              const load = splitLoad(parsed.LOAD);

              finish({
                online: true,
                latencyMs,
                hostname: parsed.HOSTNAME || host.host,
                cpuUsage: parseNumber(parsed.CPU),
                memoryUsage: parseNumber(parsed.MEM),
                diskUsage: parseNumber(parsed.DISK),
                uptimeSec: parseInt(parsed.UPTIME, 10) || 0,
                error: null,
                processCount: parseInteger(parsed.PROC_COUNT),
                keyProcesses: parseKeyProcesses(parsed.KEY_PROC),
                _checkedAtMs: Date.now(),
                _networkRxBytes: parseInteger(parsed.NET_RX),
                _networkTxBytes: parseInteger(parsed.NET_TX),
                _diskReadBytes: disk.diskReadBytes,
                _diskWriteBytes: disk.diskWriteBytes,
                ...load,
              });
            });
          });

          client.on('error', (err) => {
            finish({
              online: false,
              latencyMs,
              error: err.message,
            });
          });

          client.on('close', () => {
            // 如果已经 settled（比如 exec 已完成），忽略
            if (!settled) {
              finish({
                online: false,
                latencyMs,
                error: 'SSH 连接意外关闭',
              });
            }
          });
        })
        .catch((err) => {
          finish({
            online: false,
            latencyMs,
            error: err.message,
          });
        });
    });
  }

  async function mapWithConcurrency(items, limit, iteratee) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function collectLocalProbe() {
    try {
      return normalizeSuccessfulProbe(await probeLocalHost());
    } catch (error) {
      return normalizeFailedProbe({
        hostId: LOCAL_HOST_ID,
        name: '本机',
        hostname: os.hostname(),
        latencyMs: 0,
        checkedAt: nowIso(),
        error: error.message,
      });
    }
  }

  async function collectAllProbes() {
    const storedHosts = hostRepository.readStoredHosts();
    const localProbe = await collectLocalProbe();
    const remoteProbes = await mapWithConcurrency(
      storedHosts,
      PROBE_REMOTE_CONCURRENCY,
      async (host) => {
        const probe = await probeRemoteHost(host);
        return probe.online
          ? normalizeSuccessfulProbe(probe)
          : normalizeFailedProbe(probe);
      },
    );

    return [localProbe, ...remoteProbes];
  }

  function buildSnapshot(probes) {
    latestSnapshot = {
      generatedAt: nowIso(),
      probes,
      sampleIntervalMs: PROBE_INTERVAL_MS,
    };
    return latestSnapshot;
  }

  async function refreshSnapshot() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = collectAllProbes()
      .then((probes) => buildSnapshot(probes))
      .finally(() => {
        refreshInFlight = null;
      });

    return refreshInFlight;
  }

  async function getSnapshot({ refresh = false } = {}) {
    if (refresh || !latestSnapshot.generatedAt) {
      return refreshSnapshot();
    }
    return latestSnapshot;
  }

  function startScheduler({ onUpdate } = {}) {
    if (schedulerTimer) return;

    const run = async () => {
      try {
        const snapshot = await refreshSnapshot();
        onUpdate?.(snapshot);
      } catch {
        // ignore scheduler-level refresh errors
      }
    };

    run();
    schedulerTimer = setInterval(run, PROBE_INTERVAL_MS);
    schedulerTimer.unref?.();
  }

  function stopScheduler() {
    if (!schedulerTimer) return;
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  return {
    collectAllProbes,
    getSnapshot,
    getSampleIntervalMs: () => PROBE_INTERVAL_MS,
    refreshSnapshot,
    startScheduler,
    stopScheduler,
  };
}

module.exports = {
  createProbeService,
};

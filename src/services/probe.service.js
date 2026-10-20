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
const { WINDOWS_PROBE_SCRIPT } = require('./probe/windows-commands');
const {
  parseInteger,
  parseKeyProcesses,
  parsePlatformInfo,
  parseProbeOutput,
  parseSystemHealth,
} = require('./probe/parsers');
const { buildWindowsPayload, decodeClixml, decodeRemoteOutput } = require('../../lib/win-shell');

function createProbeService({ hostRepository, hostService, sshShellPool, bridgeService, probeAgentService, probeRelayService, probeTrafficService }) {
  // bridgeService 在 server.js 里晚于 probeService 构建（Windows 探测才需要它），
  // 所以允许事后注入；setBridgeService 之前 Windows 主机会明确报"监控不可用"。
  let bridge = bridgeService || null;
  function setBridgeService(next) { bridge = next || null; }
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

  /**
   * 本机跑 Windows 探针脚本。
   *
   * 必须走 EncodedCommand：脚本里有多行 try/catch，经 `powershell -Command -`
   * 的 stdin 喂进去时空行会截断语句块（实测 try 和 catch 会双双执行，
   * 输出里出现重复键），EncodedCommand 则解析正常。
   */
  function runLocalWindowsProbe() {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const payload = buildWindowsPayload(WINDOWS_PROBE_SCRIPT, {});
      const encoded = Buffer.from(payload, 'utf16le').toString('base64');
      let child;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
      } catch {
        return resolve('');
      }
      const out = [];
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve('');
      }, PROBE_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', () => { /* CLIXML 噪音，忽略 */ });
      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(decodeRemoteOutput(Buffer.concat(out)));
      });
    });
  }

  function buildRemoteProbePayload(host, stdout, latencyMs) {
    const parsed = parseProbeOutput(stdout);
    const load = splitLoad(parsed.LOAD);

    return {
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
      systemHealth: parseSystemHealth(parsed),
      platformInfo: parsePlatformInfo(parsed),
      _checkedAtMs: Date.now(),
      _networkRxBytes: parseInteger(parsed.NET_RX),
      _networkTxBytes: parseInteger(parsed.NET_TX),
      _diskReadBytes: parseInteger(parsed.DISK_READ_BYTES),
      _diskWriteBytes: parseInteger(parsed.DISK_WRITE_BYTES),
      ...load,
    };
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

  function cloneSystemHealth(systemHealth) {
    if (!systemHealth || typeof systemHealth !== 'object') return null;
    return JSON.parse(JSON.stringify(systemHealth));
  }

  function clonePlatformInfo(platformInfo) {
    if (!platformInfo || typeof platformInfo !== 'object') return null;
    return JSON.parse(JSON.stringify(platformInfo));
  }

  function formatPlatformText(platformInfo) {
    if (!platformInfo || typeof platformInfo !== 'object') return null;
    const name = platformInfo.prettyName || [platformInfo.distroId, platformInfo.versionId].filter(Boolean).join(' ') || platformInfo.os;
    const suffix = [platformInfo.arch, platformInfo.kernel].filter(Boolean).join(' / ');
    return [name, suffix].filter(Boolean).join(' / ') || null;
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
      systemHealth: cloneSystemHealth(probe.systemHealth),
      platform: probe.platform || formatPlatformText(probe.platformInfo) || null,
      platformInfo: clonePlatformInfo(probe.platformInfo),
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
      systemHealth: cloneSystemHealth(probe.systemHealth),
      platform: probe.platform || formatPlatformText(probe.platformInfo) || null,
      platformInfo: clonePlatformInfo(probe.platformInfo),
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
    if (normalized.hostId && normalized.hostId !== LOCAL_HOST_ID && normalized.platformInfo) {
      try {
        hostService?.syncHostOsInfo?.(normalized.hostId, normalized.platformInfo);
      } catch { /* ignore */ }
    }
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
        systemHealth: null,
        platform: null,
        platformInfo: null,
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
      systemHealth: cloneSystemHealth(previous.systemHealth),
      platform: previous.platform || formatPlatformText(previous.platformInfo) || null,
      platformInfo: clonePlatformInfo(previous.platformInfo),
      bandwidthRxBps: null,
      bandwidthTxBps: null,
      diskReadBps: null,
      diskWriteBps: null,
    };
  }

  async function getLocalDiskUsage() {
    // Windows 的磁盘占用率由 Windows 探针脚本一并采集（DISK 键），见 getLocalExtras
    if (os.platform() === 'win32') return null;

    try {
      const output = await execCommand("df -Pk / | awk 'NR==2 {gsub(/%/, \"\", $5); print $5}'");
      return parseNumber(output);
    } catch {
      return null;
    }
  }

  const EMPTY_LOCAL_EXTRAS = {
    networkRxBytes: null,
    networkTxBytes: null,
    diskReadBytes: null,
    diskWriteBytes: null,
    processCount: null,
    keyProcesses: [],
    systemHealth: null,
    platformInfo: null,
  };

  /**
   * 本机的扩展指标。原来这里在 win32 直接返回空对象（函数名带 Linux 是诚实的），
   * 于是本机 Windows 的磁盘/进程数/平台/健康度全是 null —— 现在补上 PowerShell 版。
   */
  async function getLocalExtras() {
    if (os.platform() === 'win32') {
      const output = await runLocalWindowsProbe();
      if (!output.trim()) return { ...EMPTY_LOCAL_EXTRAS };
      const parsed = parseProbeOutput(output);
      return {
        networkRxBytes: parseInteger(parsed.NET_RX),
        networkTxBytes: parseInteger(parsed.NET_TX),
        diskReadBytes: parseInteger(parsed.DISK_READ_BYTES),
        diskWriteBytes: parseInteger(parsed.DISK_WRITE_BYTES),
        processCount: parseInteger(parsed.PROC_COUNT),
        keyProcesses: parseKeyProcesses(parsed.KEY_PROC),
        systemHealth: parseSystemHealth(parsed),
        platformInfo: parsePlatformInfo(parsed),
        // Windows 专有：这两项本机原本拿不到，顺带从同一次采集里取出来
        diskUsage: parseNumber(parsed.DISK),
        cpuUsage: parseNumber(parsed.CPU),
      };
    }

    try {
      const output = await execCommand(LOCAL_LINUX_EXTRA_COMMAND);
      const parsed = parseProbeOutput(output);
      return {
        networkRxBytes: parseInteger(parsed.RX),
        networkTxBytes: parseInteger(parsed.TX),
        diskReadBytes: parseInteger(parsed.DISK_READ_BYTES),
        diskWriteBytes: parseInteger(parsed.DISK_WRITE_BYTES),
        processCount: parseInteger(parsed.PROC_COUNT),
        keyProcesses: parseKeyProcesses(parsed.KEY_PROC),
        systemHealth: parseSystemHealth(parsed),
        platformInfo: parsePlatformInfo(parsed),
      };
    } catch {
      return { ...EMPTY_LOCAL_EXTRAS };
    }
  }

  async function probeLocalHost() {
    const checkedAtMs = Date.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const [diskUsage, extras] = await Promise.all([
      getLocalDiskUsage(),
      getLocalExtras(),
    ]);
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
      // Windows 上 os.cpus() 的 times 不随负载更新，用探针脚本采到的值兜底
      cpuUsage: getLocalCpuUsage() ?? (extras.cpuUsage ?? null),
      memoryUsage,
      diskUsage: diskUsage ?? (extras.diskUsage ?? null),
      uptimeSec: Math.round(os.uptime()),
      checkedAt,
      error: null,
      errorCode: null,
      processCount: extras.processCount,
      keyProcesses: extras.keyProcesses,
      systemHealth: extras.systemHealth,
      platform: formatPlatformText(extras.platformInfo),
      platformInfo: extras.platformInfo,
      _checkedAtMs: checkedAtMs,
      _networkRxBytes: extras.networkRxBytes,
      _networkTxBytes: extras.networkTxBytes,
      _diskReadBytes: extras.diskReadBytes,
      _diskWriteBytes: extras.diskWriteBytes,
      ...splitLoad(os.loadavg().join(' ')),
    };
  }

  function probeRemoteHost(host) {
    // Windows 主机：POSIX 探针脚本（/proc、awk、df）在它上面一个都不成立，
    // 且 shell 池的边界标记协议也是 POSIX 的。必须走 bridge —— 由 bridge 负责
    // PowerShell 包装、exec 模式路由与解码。
    if (isWindowsHost(host)) {
      return probeRemoteWindows(host);
    }
    // 优先使用持久 shell 池（复用长连接，避免频繁 TCP 连接触发云安全告警）
    if (sshShellPool) {
      return probeRemoteViaShellPool(host);
    }
    return probeRemoteViaConnect(host);
  }

  function isWindowsHost(host) {
    return String(host?.osInfo?.os || '').trim().toLowerCase() === 'windows';
  }

  /**
   * Windows 远端探测：经 bridgeService 发 PowerShell 脚本。
   * 没有 bridgeService（老装配/测试替身）时明确标为不支持，
   * 而不是退回 POSIX 路径去拿一份"在线但全 null"的假数据。
   */
  async function probeRemoteWindows(host) {
    const startedAt = Date.now();
    const timeout = getAdaptiveTimeout(host.id);

    if (!bridge?.execOnHost) {
      return {
        hostId: host.id,
        name: host.name,
        checkedAt: nowIso(),
        online: false,
        latencyMs: Date.now() - startedAt,
        error: 'Windows 主机监控需要 bridge 服务',
        errorCode: 'WINDOWS_PROBE_UNAVAILABLE',
      };
    }

    try {
      const result = await bridge.execOnHost(host.id, WINDOWS_PROBE_SCRIPT, timeout, {
        source: 'probe',
        auditCommand: 'windows probe',
      });
      const latencyMs = Date.now() - startedAt;
      const stdout = decodeClixml(String(result.stdout || ''));

      // 解析不出任何键 = 脚本没真正跑起来，明确报错而不是给一份全 null 的"在线"
      const parsed = parseProbeOutput(stdout);
      if (!parsed.PLATFORM_OS && parsed.UPTIME === undefined && parsed.MEM === undefined) {
        return {
          hostId: host.id,
          name: host.name,
          checkedAt: nowIso(),
          online: false,
          latencyMs,
          error: trimProbeError(result.stderr || stdout) || `exit code ${result.exitCode}`,
          errorCode: 'REMOTE_ERROR',
        };
      }

      recordLatency(host.id, latencyMs);

      return {
        hostId: host.id,
        name: host.name,
        checkedAt: nowIso(),
        errorCode: null,
        ...buildRemoteProbePayload(host, stdout, latencyMs),
      };
    } catch (err) {
      return {
        hostId: host.id,
        name: host.name,
        checkedAt: nowIso(),
        online: false,
        latencyMs: Date.now() - startedAt,
        error: err.message,
        errorCode: err.code === 'EXEC_TIMEOUT' ? 'TIMEOUT' : 'REMOTE_ERROR',
      };
    }
  }

  function trimProbeError(text) {
    return String(text || '').trim().split(/\r?\n/)[0]?.slice(0, 300) || '';
  }

  /**
   * 通过持久 shell 池探测远程主机
   */
  async function probeRemoteViaShellPool(host) {
    const startedAt = Date.now();
    const timeout = getAdaptiveTimeout(host.id);

    try {
      const result = await sshShellPool.exec(host.id, REMOTE_PROBE_COMMAND, timeout);
      // 扣除 REMOTE_PROBE_COMMAND 内置的 sleep 0.2 (200ms) CPU 采样停顿
      const latencyMs = Math.max(1, (Date.now() - startedAt) - 200);
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

      recordLatency(host.id, latencyMs);

      return {
        hostId: host.id,
        name: host.name,
        checkedAt: nowIso(),
        errorCode: null,
        ...buildRemoteProbePayload(host, stdout, latencyMs),
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
          // 若已超时结束，连接迟到才建好：直接关掉，否则泄漏
          if (settled) {
            try { client?.end(); } catch { /* ignore */ }
            try { proxy?.end(); } catch { /* ignore */ }
            return;
          }
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

            const stdoutChunks = [];
            const stderrChunks = [];

            stream.on('data', (chunk) => {
              stdoutChunks.push(chunk);
            });

            stream.stderr?.on('data', (chunk) => {
              stderrChunks.push(chunk);
            });

            stream.on('close', () => {
              const stdout = Buffer.concat(stdoutChunks).toString('utf8');
              const stderr = Buffer.concat(stderrChunks).toString('utf8');
              if (stderr.trim() && !stdout.trim()) {
                finish({
                  online: false,
                  latencyMs,
                  error: stderr.trim(),
                  errorCode: 'REMOTE_ERROR',
                });
                return;
              }

              finish(buildRemoteProbePayload(host, stdout, latencyMs));
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

  function buildAgentOnlyPlaceholder(host, status, reason = 'agent_online') {
    const isRelay = reason === 'relay_agent_online' || status.relaySource;
    return {
      hostId: host.id,
      name: host.name,
      hostname: host.host || host.name,
      online: true,
      source: isRelay ? 'relay_agent' : 'agent',
      latencyMs: null,
      cpuUsage: null,
      memoryUsage: null,
      diskUsage: null,
      uptimeSec: null,
      checkedAt: status.agentLastSeenAt || nowIso(),
      lastSuccessAt: status.agentLastSeenAt || null,
      stale: false,
      error: null,
      errorCode: null,
      load1: null,
      load5: null,
      load15: null,
      processCount: null,
      keyProcesses: [],
      bandwidthRxBps: null,
      bandwidthTxBps: null,
      diskReadBps: null,
      diskWriteBps: null,
      ...status,
      sshSkipped: true,
      sshSkipReason: reason,
    };
  }

  async function collectAllProbes() {
    const archivedHostIds = new Set(
      hostRepository.readHostPreferences()
        .filter((preference) => preference.archived)
        .map((preference) => preference.hostId),
    );
    const storedHosts = hostRepository.readStoredHosts()
      .filter((host) => !archivedHostIds.has(host.id));
    const agentStatuses = probeAgentService ? probeAgentService.getAgentStatusMap() : new Map();
    const relayStatuses = probeRelayService?.getRelayAgentStatusMap
      ? probeRelayService.getRelayAgentStatusMap()
      : new Map();
    const localProbe = await collectLocalProbe();
    const remoteProbes = await mapWithConcurrency(
      storedHosts,
      PROBE_REMOTE_CONCURRENCY,
      async (host) => {
        const agentStatus = agentStatuses.get(host.id);
        if (agentStatus?.agentTrusted) return buildAgentOnlyPlaceholder(host, agentStatus, 'agent_online');

        const relayStatus = relayStatuses.get(host.id);
        if (relayStatus?.agentTrusted) return buildAgentOnlyPlaceholder(host, relayStatus, 'relay_agent_online');

        const probe = await probeRemoteHost(host);
        return probe.online
          ? normalizeSuccessfulProbe(probe)
          : normalizeFailedProbe(probe);
      },
    );

    return [localProbe, ...remoteProbes];
  }

  function mergeRelayProbes(baseProbes, relayProbes = []) {
    if (!Array.isArray(relayProbes) || relayProbes.length === 0) return baseProbes;
    const byHostId = new Map(baseProbes.map((probe) => [probe.hostId, probe]));

    for (const relayProbe of relayProbes) {
      if (!relayProbe?.hostId) continue;
      const existing = byHostId.get(relayProbe.hostId);
      if (!existing) continue;
      byHostId.set(relayProbe.hostId, {
        ...existing,
        ...relayProbe,
        name: existing.name || relayProbe.name,
        hostname: relayProbe.hostname || existing.hostname,
        sshOnline: existing.online,
        source: 'relay_agent',
      });
    }

    return Array.from(byHostId.values());
  }

  function buildSnapshot(probes, relayProbes = []) {
    const decorated = probeAgentService ? probeAgentService.decorateProbes(probes) : probes;
    const merged = mergeRelayProbes(decorated, relayProbes);
    const trafficMap = probeTrafficService?.getUsageMap?.() || null;
    const withTraffic = trafficMap
      ? merged.map((probe) => {
          const usage = trafficMap.get(probe.hostId);
          return usage ? { ...probe, ...usage } : probe;
        })
      : merged;
    latestSnapshot = {
      generatedAt: nowIso(),
      probes: withTraffic,
      sampleIntervalMs: PROBE_INTERVAL_MS,
    };
    return latestSnapshot;
  }

  async function refreshSnapshot() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const [relayProbes, probes] = await Promise.all([
        probeRelayService ? probeRelayService.syncAll() : [],
        collectAllProbes(),
      ]);
      return buildSnapshot(probes, relayProbes);
    })()
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

  function removeHost(hostId) {
    const cleanHostId = String(hostId || '').trim();
    if (!cleanHostId) return { ok: false };
    latestSnapshot = {
      ...latestSnapshot,
      probes: latestSnapshot.probes.filter((probe) => probe?.hostId !== cleanHostId),
    };
    lastSuccessfulProbeMap.delete(cleanHostId);
    hostLatencyHistory.delete(cleanHostId);
    return { ok: true };
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
    getLatestSnapshot: () => latestSnapshot,
    getSampleIntervalMs: () => PROBE_INTERVAL_MS,
    refreshSnapshot,
    removeHost,
    setBridgeService,
    startScheduler,
    stopScheduler,
  };
}

module.exports = {
  createProbeService,
};

'use strict';

/**
 * 探针诊断服务（C1 MVP）：
 *   - 通过 bridgeService.execOnHost 在目标主机上跑 ping / curl / getent 三类只读命令
 *   - 所有用户输入做严格白名单 + 单引号转义，杜绝 shell 注入
 *   - 不依赖 agent 反向通道；agent 没装也能用（只要主机已纳管 SSH）
 *
 * iperf3 / mtr / 主动通道版本留 C1.2。
 */

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.\-]{0,253}[a-zA-Z0-9])?$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
const URL_RE = /^https?:\/\/[a-zA-Z0-9._\-:/%?=&#@+,;~]+$/;

function isHostnameOrIp(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 255) return false;
  return HOSTNAME_RE.test(value) || IPV4_RE.test(value) || IPV6_RE.test(value);
}

function isSafeUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 2048) return false;
  return URL_RE.test(value);
}

function shellSingleQuote(value) {
  // 把字符串用单引号包裹，并把内部单引号转成 '\'' 序列
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

// ── 解析器 ───────────────────────────────────────────────────────────────

function parsePingOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  const samples = [];
  for (const line of lines) {
    const m = line.match(/time[=<]([\d.]+)\s*ms/i);
    if (m) samples.push(Number(m[1]));
  }
  const lossMatch = stdout.match(/([\d.]+)%\s*packet\s*loss/i);
  const summaryMatch = stdout.match(/(?:min\/avg\/max(?:\/mdev)?|round-trip\s+min\/avg\/max(?:\/stddev)?)\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/[\d.]+)?/i);
  const transmittedMatch = stdout.match(/(\d+)\s+packets\s+transmitted/i);
  const receivedMatch = stdout.match(/(\d+)\s+(?:packets\s+)?received/i);
  return {
    samples,
    transmitted: transmittedMatch ? Number(transmittedMatch[1]) : null,
    received: receivedMatch ? Number(receivedMatch[1]) : null,
    lossPercent: lossMatch ? Number(lossMatch[1]) : null,
    rttMinMs: summaryMatch ? Number(summaryMatch[1]) : null,
    rttAvgMs: summaryMatch ? Number(summaryMatch[2]) : null,
    rttMaxMs: summaryMatch ? Number(summaryMatch[3]) : null,
  };
}

function parseHttpOutput(stdout) {
  // 我们用 curl -w 'STATUS=%{http_code}\nNAMELOOKUP=%{time_namelookup}\nCONNECT=%{time_connect}\nSTARTTRANSFER=%{time_starttransfer}\nTOTAL=%{time_total}\nSIZE=%{size_download}\n'
  const result = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  const toNumSec = (k) => result[k] !== undefined ? Number(result[k]) : null;
  return {
    statusCode: result.STATUS ? Number(result.STATUS) : null,
    nameLookupMs: toNumSec('NAMELOOKUP') !== null ? Math.round(toNumSec('NAMELOOKUP') * 1000) : null,
    connectMs: toNumSec('CONNECT') !== null ? Math.round(toNumSec('CONNECT') * 1000) : null,
    firstByteMs: toNumSec('STARTTRANSFER') !== null ? Math.round(toNumSec('STARTTRANSFER') * 1000) : null,
    totalMs: toNumSec('TOTAL') !== null ? Math.round(toNumSec('TOTAL') * 1000) : null,
    sizeBytes: result.SIZE ? Number(result.SIZE) : null,
  };
}

function parseDnsOutput(stdout) {
  // 解析 `getent hosts NAME` 或 `dig +short NAME` 输出 —— 都是每行一条记录
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    // getent hosts NAME 输出 "1.2.3.4   hostname canonical-name"，取第一列
    const ipMatch = line.match(/^([\da-fA-F.:]+)\b/);
    if (ipMatch) records.push(ipMatch[1]);
  }
  return { records };
}

// ── 主服务 ───────────────────────────────────────────────────────────────

function createProbeDiagService({ bridgeService, hostService, auditService, logger } = {}) {
  if (!bridgeService) throw new Error('probe-diag.service: bridgeService required');

  async function runOnHost(hostId, command, { timeoutMs = 30000, clientIp, auditCommand } = {}) {
    if (!hostService?.findHost?.(hostId)) {
      const err = new Error('主机不存在');
      err.status = 404;
      throw err;
    }
    const startedAt = Date.now();
    const result = await bridgeService.execOnHost(hostId, command, timeoutMs, {
      source: 'probe_diag',
      clientIp,
      auditCommand: auditCommand || command,
    });
    return { ...result, durationMs: result.durationMs || (Date.now() - startedAt) };
  }

  async function ping(hostId, { target, count, timeoutSec, clientIp } = {}) {
    if (!isHostnameOrIp(target)) {
      const err = new Error('target 必须是合法主机名或 IP 地址');
      err.status = 400;
      throw err;
    }
    const n = clampInt(count, 1, 20, 4);
    const w = clampInt(timeoutSec, 1, 10, 2);
    const cmd = `ping -c ${n} -W ${w} ${shellSingleQuote(target)} 2>&1 || true`;
    const exec = await runOnHost(hostId, cmd, { timeoutMs: (n + 2) * w * 1000 + 5000, clientIp });
    const parsed = parsePingOutput(exec.stdout);
    auditService?.recordEvent?.({
      action: 'probe.diag.ping', source: 'probe_diag', hostId, command: cmd, exitCode: exec.exitCode, durationMs: exec.durationMs, clientIp,
    });
    return { kind: 'ping', target, count: n, timeoutSec: w, exec, parsed };
  }

  async function http(hostId, { url, timeoutSec, method, clientIp } = {}) {
    if (!isSafeUrl(url)) {
      const err = new Error('url 必须是合法的 http(s) URL，且不包含 shell 特殊字符');
      err.status = 400;
      throw err;
    }
    const t = clampInt(timeoutSec, 1, 30, 10);
    const m = (typeof method === 'string' && /^(GET|HEAD)$/i.test(method)) ? method.toUpperCase() : 'GET';
    const format = 'STATUS=%{http_code}\\nNAMELOOKUP=%{time_namelookup}\\nCONNECT=%{time_connect}\\nSTARTTRANSFER=%{time_starttransfer}\\nTOTAL=%{time_total}\\nSIZE=%{size_download}\\n';
    const methodFlag = m === 'HEAD' ? '-I' : '-s';
    const cmd = `curl ${methodFlag} -L -o /dev/null --max-time ${t} -w ${shellSingleQuote(format)} ${shellSingleQuote(url)} 2>&1 || true`;
    const exec = await runOnHost(hostId, cmd, { timeoutMs: (t + 5) * 1000, clientIp });
    const parsed = parseHttpOutput(exec.stdout);
    auditService?.recordEvent?.({
      action: 'probe.diag.http', source: 'probe_diag', hostId, command: cmd, exitCode: exec.exitCode, durationMs: exec.durationMs, clientIp,
    });
    return { kind: 'http', url, method: m, timeoutSec: t, exec, parsed };
  }

  async function dns(hostId, { name, clientIp } = {}) {
    if (!isHostnameOrIp(name)) {
      const err = new Error('name 必须是合法主机名');
      err.status = 400;
      throw err;
    }
    // 优先 getent（基本所有 Linux 都有），回退 dig +short，再回退 nslookup
    const target = shellSingleQuote(name);
    const cmd = `(getent ahosts ${target} 2>/dev/null | awk '{print $1}' | sort -u) || (dig +short ${target} 2>/dev/null) || (nslookup ${target} 2>/dev/null) || true`;
    const exec = await runOnHost(hostId, cmd, { timeoutMs: 15000, clientIp });
    const parsed = parseDnsOutput(exec.stdout);
    auditService?.recordEvent?.({
      action: 'probe.diag.dns', source: 'probe_diag', hostId, command: cmd, exitCode: exec.exitCode, durationMs: exec.durationMs, clientIp,
    });
    return { kind: 'dns', name, exec, parsed };
  }

  return {
    ping,
    http,
    dns,
    // 暴露给测试 / 单元用
    _internal: { isHostnameOrIp, isSafeUrl, parsePingOutput, parseHttpOutput, parseDnsOutput },
  };
}

module.exports = {
  createProbeDiagService,
};

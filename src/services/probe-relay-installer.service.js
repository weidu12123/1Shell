'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_INSTALL_TIMEOUT_MS = 180000;
const INSTALL_DIR = '/opt/1shell/probe-relay';
const CONFIG_FILE = '/etc/1shell-probe-relay.env';
const SERVICE_FILE = '/etc/systemd/system/1shell-probe-relay.service';
const STATE_FILE = '/var/lib/1shell-probe-relay/state.json';

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeRelayPort(value) {
  return Math.max(1, Math.min(parseInt(value, 10) || 3301, 65535));
}

function createProbeRelayInstallerService({ rootDir, hostService, bridgeService, probeRelayService }) {
  function ensureRemoteLinuxTarget(hostId) {
    const host = hostService?.findHost(hostId);
    if (!host) {
      const error = new Error('主机不存在');
      error.status = 404;
      throw error;
    }
    if (host.type === 'local') {
      const error = new Error('Relay Agent 仅支持安装到远端 Linux VPS');
      error.status = 400;
      throw error;
    }
    return host;
  }

  async function detectArch(hostId, clientIp) {
    const result = await bridgeService.execOnHost(hostId, `#!/bin/sh
set -eu
UNAME_M=$(uname -m)
case "$UNAME_M" in
  x86_64|amd64) printf 'amd64\\n' ;;
  aarch64|arm64) printf 'arm64\\n' ;;
  *) echo "不支持的 CPU 架构：$UNAME_M" >&2; exit 1 ;;
esac
`, 30000, {
      source: 'probe_relay_arch_detect',
      clientIp,
      auditCommand: 'Detect 1Shell Probe Relay Agent architecture',
    });
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || result.stdout || 'Relay Agent 架构探测失败');
      error.status = 400;
      throw error;
    }
    return String(result.stdout || '').trim();
  }

  function requireLocalFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
      const error = new Error(`缺少 ${label}：${path.relative(rootDir, filePath)}，请先运行 npm run build:agent`);
      error.status = 500;
      throw error;
    }
    return filePath;
  }

  function resolveRelayBinaryPath(arch) {
    return requireLocalFile(path.join(rootDir, 'agent', 'dist', `probe-relay-agent-linux-${arch}`), 'Relay Agent 二进制');
  }

  function resolveProbeBinaryPath(arch) {
    return requireLocalFile(path.join(rootDir, 'agent', 'dist', `probe-agent-linux-${arch}`), 'Probe Agent 二进制');
  }

  function resolveInstallScriptPath() {
    return requireLocalFile(path.join(rootDir, 'agent', 'install.sh'), 'Agent 安装脚本');
  }

  async function uploadBinary(hostId, localPath, remotePath) {
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 30000 });
    try {
      const sftp = await new Promise((resolve, reject) => {
        client.sftp((err, s) => (err ? reject(new Error(`SFTP 会话创建失败: ${err.message}`)) : resolve(s)));
      });
      await new Promise((resolve, reject) => {
        const reader = fs.createReadStream(localPath);
        const writer = sftp.createWriteStream(remotePath, { mode: 0o755 });
        reader.on('error', reject);
        writer.on('error', reject);
        writer.on('close', resolve);
        reader.pipe(writer);
      });
      try { sftp.end(); } catch { /* ignore */ }
    } finally {
      try { client.end(); } catch { /* ignore */ }
      try { proxyClient?.end(); } catch { /* ignore */ }
    }
  }

  function buildFinalizeScript({ tmpBinary, tmpInstallScript, tmpProbeAmd64, tmpProbeArm64, syncToken, relayPort }) {
    return `#!/bin/sh
set -eu
if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 用户安装 1Shell Probe Relay Agent" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统不支持 systemd，暂不支持一键安装 Relay Agent" >&2
  exit 1
fi
mkdir -p ${shellQuote(INSTALL_DIR)} /var/lib/1shell-probe-relay
chmod 700 /var/lib/1shell-probe-relay
mv -f ${shellQuote(tmpBinary)} ${shellQuote(`${INSTALL_DIR}/probe-relay-agent`)}
mv -f ${shellQuote(tmpInstallScript)} ${shellQuote(`${INSTALL_DIR}/install.sh`)}
mv -f ${shellQuote(tmpProbeAmd64)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-amd64`)}
mv -f ${shellQuote(tmpProbeArm64)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-arm64`)}
chmod 755 ${shellQuote(`${INSTALL_DIR}/probe-relay-agent`)} ${shellQuote(`${INSTALL_DIR}/install.sh`)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-amd64`)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-arm64`)}
cat > ${shellQuote(CONFIG_FILE)} <<CONFIG_EOF
LISTEN_ADDR=0.0.0.0:${relayPort}
SYNC_TOKEN=${syncToken}
STATE_FILE=${STATE_FILE}
AGENT_DIST_DIR=${INSTALL_DIR}
CONFIG_EOF
chmod 600 ${shellQuote(CONFIG_FILE)}
cat > ${shellQuote(SERVICE_FILE)} <<SERVICE_EOF
[Unit]
Description=1Shell Probe Relay Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONFIG_FILE}
ExecStart=${INSTALL_DIR}/probe-relay-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF
systemctl daemon-reload
systemctl enable --now 1shell-probe-relay.service
systemctl restart 1shell-probe-relay.service
systemctl status 1shell-probe-relay.service --no-pager --lines=8 || true
printf '\\n1Shell Probe Relay Agent installed on port %s\\n' ${shellQuote(String(relayPort))}
`;
  }

  async function installUpstream({ id, relayHostId, relayPort, name, enabled = true, clientIp } = {}) {
    const host = ensureRemoteLinuxTarget(relayHostId);
    const port = normalizeRelayPort(relayPort);
    const syncToken = createToken();
    const arch = await detectArch(relayHostId, clientIp);
    const relayBinaryPath = resolveRelayBinaryPath(arch);
    const installScriptPath = resolveInstallScriptPath();
    const probeAmd64Path = resolveProbeBinaryPath('amd64');
    const probeArm64Path = resolveProbeBinaryPath('arm64');
    const stamp = Date.now();
    const tmpBinary = `/tmp/1shell-probe-relay-agent-${stamp}`;
    const tmpInstallScript = `/tmp/1shell-probe-install-${stamp}.sh`;
    const tmpProbeAmd64 = `/tmp/1shell-probe-agent-linux-amd64-${stamp}`;
    const tmpProbeArm64 = `/tmp/1shell-probe-agent-linux-arm64-${stamp}`;

    await uploadBinary(relayHostId, relayBinaryPath, tmpBinary);
    await uploadBinary(relayHostId, installScriptPath, tmpInstallScript);
    await uploadBinary(relayHostId, probeAmd64Path, tmpProbeAmd64);
    await uploadBinary(relayHostId, probeArm64Path, tmpProbeArm64);
    const result = await bridgeService.execOnHost(relayHostId, buildFinalizeScript({ tmpBinary, tmpInstallScript, tmpProbeAmd64, tmpProbeArm64, syncToken, relayPort: port }), DEFAULT_INSTALL_TIMEOUT_MS, {
      source: 'probe_relay_install',
      clientIp,
      auditCommand: 'Install 1Shell Probe Relay Agent (token redacted)',
    });

    if (result.exitCode !== 0) {
      return { upstream: null, result, relayHostId, relayPort: String(port) };
    }

    const upstream = probeRelayService.upsertUpstream({
      id,
      name: name || host.name || 'Probe Relay',
      relayHostId,
      relayPort: port,
      syncToken,
      enabled,
    });

    return { upstream, result, relayHostId, relayPort: String(port) };
  }

  return { installUpstream };
}

module.exports = {
  createProbeRelayInstallerService,
};

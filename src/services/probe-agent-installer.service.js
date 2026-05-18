'use strict';

const DEFAULT_INSTALL_TIMEOUT_MS = 180000;
const DEFAULT_AGENT_INTERVAL_SEC = 30;

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

function createProbeAgentInstallerService({ bridgeService, hostService, probeAgentService, probeRelayService }) {
  function ensureRemoteLinuxTarget(hostId) {
    const host = hostService?.findHost(hostId);
    if (!host) {
      const error = new Error('主机不存在');
      error.status = 404;
      throw error;
    }
    if (host.type === 'local') {
      const error = new Error('一键安装 Agent 仅支持远端 Linux 主机');
      error.status = 400;
      throw error;
    }
    return host;
  }

  function buildInstallScript({ hostId, installToken, serverUrl, intervalSec = DEFAULT_AGENT_INTERVAL_SEC }) {
    const cleanServerUrl = String(serverUrl || '').replace(/\/+$/, '');
    const safeInterval = Math.max(10, Math.min(Number(intervalSec) || DEFAULT_AGENT_INTERVAL_SEC, 3600));

    return `#!/bin/sh
set -eu

HOST_ID=${shellQuote(hostId)}
INSTALL_TOKEN=${shellQuote(installToken)}
SERVER_URL=${shellQuote(cleanServerUrl)}
INTERVAL_SEC=${shellQuote(String(safeInterval))}
INSTALL_SH="/tmp/1shell-probe-install-$$.sh"
INSTALL_URL="$SERVER_URL/install.sh"

if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 用户安装 1Shell Probe Agent" >&2
  exit 1
fi

cleanup() {
  rm -f "$INSTALL_SH"
}
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$INSTALL_URL" -o "$INSTALL_SH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$INSTALL_SH" "$INSTALL_URL"
else
  echo "缺少 curl 或 wget，请先安装其中之一" >&2
  exit 1
fi

sh "$INSTALL_SH" --host-id "$HOST_ID" --token "$INSTALL_TOKEN" --server "$SERVER_URL" --interval "$INTERVAL_SEC"
`;
  }

  function buildUninstallScript() {
    return `#!/bin/sh
set -eu
if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 用户卸载 1Shell Probe Agent" >&2
  exit 1
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now 1shell-probe-agent.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/1shell-probe-agent.service
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
if command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
  rc-service 1shell-probe-agent stop >/dev/null 2>&1 || true
  rc-update del 1shell-probe-agent default >/dev/null 2>&1 || true
  rm -f /etc/init.d/1shell-probe-agent
fi
rm -rf /opt/1shell/probe-agent /var/lib/1shell-probe-agent
rm -f /etc/1shell-probe-agent.env
printf '1Shell Probe Agent uninstalled\n'
`;
  }

  function buildVerifyInstallScript() {
    return `#!/bin/sh
set -eu
test -x /opt/1shell/probe-agent/probe-agent
test -f /etc/1shell-probe-agent.env
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl is-active --quiet 1shell-probe-agent.service
elif command -v rc-service >/dev/null 2>&1; then
  rc-service 1shell-probe-agent status >/dev/null 2>&1
else
  pgrep -f '/opt/1shell/probe-agent/probe-agent' >/dev/null 2>&1
fi
`;
  }

  function buildVerifyUninstallScript() {
    return `#!/bin/sh
set -eu
failed=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if systemctl is-active --quiet 1shell-probe-agent.service 2>/dev/null; then
    echo "systemd 服务仍在运行" >&2
    failed=1
  fi
fi
if command -v rc-service >/dev/null 2>&1; then
  if rc-service 1shell-probe-agent status >/dev/null 2>&1; then
    echo "OpenRC 服务仍在运行" >&2
    failed=1
  fi
fi
if pgrep -f '/opt/1shell/probe-agent/probe-agent' >/dev/null 2>&1; then
  echo "probe-agent 进程仍在运行" >&2
  failed=1
fi
if [ -e /opt/1shell/probe-agent ] || [ -e /etc/1shell-probe-agent.env ] || [ -e /etc/systemd/system/1shell-probe-agent.service ] || [ -e /etc/init.d/1shell-probe-agent ]; then
  echo "Agent 文件或服务文件仍残留" >&2
  ls -ld /opt/1shell/probe-agent /etc/1shell-probe-agent.env /etc/systemd/system/1shell-probe-agent.service /etc/init.d/1shell-probe-agent 2>/dev/null || true
  failed=1
fi
exit "$failed"
`;
  }

  function mergeVerifyFailure(result, verifyResult, message = '安装命令已返回成功，但未在目标机验证到运行中的 1Shell Probe Agent。') {
    const stderr = [
      result.stderr,
      message,
      verifyResult.stderr || verifyResult.stdout,
    ].filter(Boolean).join('\n');
    return {
      ...result,
      stderr,
      exitCode: verifyResult.exitCode || 1,
      durationMs: (result.durationMs || 0) + (verifyResult.durationMs || 0),
    };
  }

  function mergeCleanupFailure(result, error) {
    return {
      ...result,
      stderr: [
        result.stderr,
        '目标机卸载已验证成功，但 Relay 残留状态清理失败，探针页可能仍会显示旧 Agent 状态。',
        error.message,
      ].filter(Boolean).join('\n'),
      exitCode: 1,
    };
  }

  async function install(hostId, { serverUrl, intervalSec, clientIp, relayUpstreamId } = {}) {
    ensureRemoteLinuxTarget(hostId);
    const tokenResult = relayUpstreamId
      ? await probeRelayService.requestInstallToken(relayUpstreamId, { hostId })
      : probeAgentService.generateInstallToken(hostId);
    const targetServerUrl = String(tokenResult.serverUrl || serverUrl || '').replace(/\/+$/, '');
    if (!targetServerUrl) {
      const error = new Error('缺少 Agent 安装入口地址');
      error.status = 400;
      throw error;
    }
    const command = buildInstallScript({
      hostId: tokenResult.hostId,
      installToken: tokenResult.installToken,
      serverUrl: targetServerUrl,
      intervalSec,
    });
    let result = await bridgeService.execOnHost(hostId, command, DEFAULT_INSTALL_TIMEOUT_MS, {
      source: relayUpstreamId ? 'probe_agent_relay_install' : 'probe_agent_install',
      clientIp,
      auditCommand: relayUpstreamId ? 'Install 1Shell Probe Agent via Relay (tokens redacted)' : 'Install 1Shell Probe Agent (tokens redacted)',
    });
    if (result.exitCode === 0) {
      const verifyResult = await bridgeService.execOnHost(hostId, buildVerifyInstallScript(), 30000, {
        source: 'probe_agent_install_verify',
        clientIp,
        auditCommand: 'Verify 1Shell Probe Agent installation',
      });
      if (verifyResult.exitCode !== 0) result = mergeVerifyFailure(result, verifyResult);
    }
    if (result.exitCode === 0 && relayUpstreamId) {
      probeRelayService.syncUpstreamById(relayUpstreamId).catch(() => {});
    }
    return { ...tokenResult, serverUrl: targetServerUrl, relayUpstreamId: relayUpstreamId || null, result };
  }

  async function uninstall(hostId, { clientIp } = {}) {
    ensureRemoteLinuxTarget(hostId);
    const command = buildUninstallScript();
    let result = await bridgeService.execOnHost(hostId, command, DEFAULT_INSTALL_TIMEOUT_MS, {
      source: 'probe_agent_uninstall',
      clientIp,
      auditCommand: 'Uninstall 1Shell Probe Agent',
    });
    if (result.exitCode === 0) {
      const verifyResult = await bridgeService.execOnHost(hostId, buildVerifyUninstallScript(), 30000, {
        source: 'probe_agent_uninstall_verify',
        clientIp,
        auditCommand: 'Verify 1Shell Probe Agent uninstallation',
      });
      if (verifyResult.exitCode !== 0) {
        result = mergeVerifyFailure(result, verifyResult, '卸载命令已返回成功，但目标机仍残留运行中的服务、进程或 Agent 文件。');
      }
    }
    if (result.exitCode === 0) {
      probeAgentService.revokeAgent(hostId);
      try {
        await probeRelayService?.forgetHost?.(hostId);
      } catch (error) {
        result = mergeCleanupFailure(result, error);
      }
    }
    return { result };
  }

  async function restart(hostId, { clientIp } = {}) {
    ensureRemoteLinuxTarget(hostId);
    const command = `#!/bin/sh
set -eu
if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 用户重启 1Shell Probe Agent" >&2
  exit 1
fi
CONFIG_FILE="/etc/1shell-probe-agent.env"
AGENT_BIN="/opt/1shell/probe-agent/probe-agent"
if [ -f "$CONFIG_FILE" ]; then
  set -a
  . "$CONFIG_FILE"
  set +a
fi
case "$(uname -m)" in
  x86_64|amd64) AGENT_ARCH=amd64 ;;
  aarch64|arm64) AGENT_ARCH=arm64 ;;
  *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
esac
fetch_to_file() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 5 --max-time 60 "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -T 60 -qO "$out" "$url"
  else
    echo "缺少 curl 或 wget，请先安装其中之一" >&2
    return 1
  fi
}
if [ -n "\${SERVER_URL:-}" ]; then
  SERVER_URL=\${SERVER_URL%/}
  TMP_BIN="/opt/1shell/probe-agent/.probe-agent.update.$$"
  fetch_to_file "$SERVER_URL/agent-dist/probe-agent-linux-$AGENT_ARCH" "$TMP_BIN"
  chmod 755 "$TMP_BIN"
  mv -f "$TMP_BIN" "$AGENT_BIN"
  echo "Agent 二进制已更新：$SERVER_URL/agent-dist/probe-agent-linux-$AGENT_ARCH"
else
  echo "未找到 SERVER_URL，跳过二进制更新，仅重启服务" >&2
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl restart 1shell-probe-agent.service
  systemctl status 1shell-probe-agent.service --no-pager --lines=5 || true
elif command -v rc-service >/dev/null 2>&1; then
  rc-service 1shell-probe-agent restart
  rc-service 1shell-probe-agent status || true
else
  echo "当前系统不支持 systemd/OpenRC 服务管理" >&2
  exit 1
fi
`;
    let result = await bridgeService.execOnHost(hostId, command, 120000, {
      source: 'probe_agent_restart',
      clientIp,
      auditCommand: 'Update and restart 1Shell Probe Agent',
    });
    if (result.exitCode === 0) {
      const verifyResult = await bridgeService.execOnHost(hostId, buildVerifyInstallScript(), 30000, {
        source: 'probe_agent_restart_verify',
        clientIp,
        auditCommand: 'Verify 1Shell Probe Agent after restart',
      });
      if (verifyResult.exitCode !== 0) {
        result = mergeVerifyFailure(result, verifyResult, '重启命令已返回成功，但未在目标机验证到运行中的 1Shell Probe Agent。');
      }
    }
    return { result };
  }

  async function fetchLogs(hostId, { clientIp, lines = 200 } = {}) {
    ensureRemoteLinuxTarget(hostId);
    const safeLines = Math.max(20, Math.min(parseInt(lines, 10) || 200, 1000));
    const command = `#!/bin/sh
set -eu
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u 1shell-probe-agent.service --no-pager --lines=${safeLines} 2>&1 || true
elif [ -f /var/log/1shell-probe-agent.log ] || [ -f /var/log/1shell-probe-agent.err ]; then
  tail -n ${safeLines} /var/log/1shell-probe-agent.log /var/log/1shell-probe-agent.err 2>&1 || true
else
  echo "当前系统未找到 1Shell Probe Agent 日志" >&2
  exit 1
fi
`;
    const result = await bridgeService.execOnHost(hostId, command, 30000, {
      source: 'probe_agent_logs',
      clientIp,
      auditCommand: `View 1Shell Probe Agent logs (last ${safeLines} lines)`,
    });
    return { result, lines: safeLines };
  }

  return {
    buildInstallScript,
    buildUninstallScript,
    install,
    uninstall,
    restart,
    fetchLogs,
  };
}

module.exports = {
  createProbeAgentInstallerService,
};

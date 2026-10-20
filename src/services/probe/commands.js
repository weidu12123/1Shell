'use strict';

const DEFAULT_KEY_PROCESS_NAMES = Object.freeze([
  'nginx',
  'docker',
  'redis-server',
  'mysqld',
  'postgres',
  'pm2',
  'node',
  'sshd',
]);
const KEY_PROCESS_NAMES = Object.freeze(resolveKeyProcessNames());

function resolveKeyProcessNames() {
  const source = process.env.PROBE_KEY_PROCESSES || DEFAULT_KEY_PROCESS_NAMES.join(',');
  return source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildNetworkBytesCommand(rxKey, txKey) {
  return `awk 'NR>2 && index($0, ":") > 0 {split($0, a, ":"); iface=a[1]; gsub(/^[ \\t]+|[ \\t]+$/, "", iface); if (iface !~ /^(lo|docker[0-9]*|br-.*|veth.*|virbr.*|tun[0-9]*|tap[0-9]*|wg[0-9]*|tailscale[0-9]*|zt.*|cni[0-9]*|flannel.*|cali.*|kube-.*)$/) {sub(/^[ \\t]+/, "", a[2]); split(a[2], f, /[ \\t]+/); rx+=f[1]; tx+=f[9]}} END {printf "${rxKey}=%.0f\\n${txKey}=%.0f\\n", rx+0, tx+0}' /proc/net/dev 2>/dev/null`;
}

function buildDiskIoBytesCommand(readKey, writeKey) {
  return `awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+)$/ {read+=$6; write+=$10} END {printf "${readKey}=%.0f\\n${writeKey}=%.0f\\n", read*512, write*512}' /proc/diskstats 2>/dev/null`;
}

function buildCpuUsageCommand(outputVar) {
  const sample = `awk '/^cpu / {idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; printf "%s %s", idle, total; exit}' /proc/stat 2>/dev/null`;
  return `${outputVar}_SAMPLE_A=$(${sample}); sleep 0.2 2>/dev/null || sleep 1; ${outputVar}_SAMPLE_B=$(${sample}); ${outputVar}=$(awk -v a="$${outputVar}_SAMPLE_A" -v b="$${outputVar}_SAMPLE_B" 'BEGIN {split(a,x," "); split(b,y," "); total=y[2]-x[2]; idle=y[1]-x[1]; if (total>0) printf "%.2f", (total-idle)*100/total}')`;
}

function buildProcessCountCommand(outputKey) {
  return `printf '${outputKey}=%s\n' "$(ps -eo pid= 2>/dev/null | wc -l | tr -d ' ')"`;
}

function buildKeyProcessSummaryCommand(outputKey) {
  if (!KEY_PROCESS_NAMES.length) {
    return `printf '${outputKey}=\n'`;
  }

  const names = shellQuote(KEY_PROCESS_NAMES.join('\n'));
  return `KEY_PROC_TARGETS=${names}; KEY_PROC_VALUE=$(ps -eo comm= 2>/dev/null | awk -v targets="$KEY_PROC_TARGETS" 'BEGIN {n=split(targets,names,"\\n"); for (i=1; i<=n; i++) counts[names[i]]=0} {if ($1 in counts) counts[$1]++} END {for (i=1; i<=n; i++) printf "%s:%s%s", names[i], counts[names[i]]+0, i<n ? "," : ""}'); printf '${outputKey}=%s\n' "$KEY_PROC_VALUE"`;
}

function buildPlatformInfoCommands() {
  return [
    `OS_RELEASE=$(cat /etc/os-release 2>/dev/null); OS_ID=$(printf '%s\n' "$OS_RELEASE" | awk -F= '$1=="ID" {print $2; exit}' | tr -d '"'); OS_VERSION_ID=$(printf '%s\n' "$OS_RELEASE" | awk -F= '$1=="VERSION_ID" {print $2; exit}' | tr -d '"'); OS_PRETTY=$(printf '%s\n' "$OS_RELEASE" | awk -F= '$1=="PRETTY_NAME" {print $2; exit}' | tr -d '"' | sed 's/[|=]/ /g'); printf 'PLATFORM_OS=%s\n' "$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"; printf 'PLATFORM_DISTRO_ID=%s\n' "$OS_ID"; printf 'PLATFORM_VERSION_ID=%s\n' "$OS_VERSION_ID"; printf 'PLATFORM_PRETTY_NAME=%s\n' "$OS_PRETTY"; printf 'PLATFORM_ARCH=%s\n' "$(uname -m 2>/dev/null)"; printf 'PLATFORM_KERNEL=%s\n' "$(uname -r 2>/dev/null)"`,
    `LSCPU=$(lscpu 2>/dev/null); CPU_VENDOR=$(printf '%s\n' "$LSCPU" | awk -F: '/Vendor ID/ {gsub(/^[ \\t]+/,"",$2); print $2; exit}'); CPU_MODEL=$(printf '%s\n' "$LSCPU" | awk -F: '/Model name/ {gsub(/^[ \\t]+/,"",$2); print $2; exit}'); PKG_MANAGER=unknown; for cmd in dnf yum apt-get apt rpm dpkg; do if command -v "$cmd" >/dev/null 2>&1; then PKG_MANAGER=$cmd; break; fi; done; printf 'CPU_VENDOR=%s\n' "$(printf '%s' "$CPU_VENDOR" | sed 's/[|=]/ /g')"; printf 'CPU_MODEL=%s\n' "$(printf '%s' "$CPU_MODEL" | sed 's/[|=]/ /g')"; printf 'PACKAGE_MANAGER=%s\n' "$PKG_MANAGER"`,
  ];
}

function buildSystemHealthCommands() {
  return [
    `SS_LISTEN=$(ss -tulnp -H 2>/dev/null); printf 'LISTEN_PORT_COUNT=%s\n' "$(printf '%s\n' "$SS_LISTEN" | sed '/^$/d' | wc -l | tr -d ' ')"`,
    `printf 'TCP_CONN_COUNT=%s\n' "$(ss -tan -H 2>/dev/null | wc -l | tr -d ' ')"`,
    `printf 'ZOMBIE_COUNT=%s\n' "$(ps -eo stat= 2>/dev/null | awk '$1 ~ /^Z/ {count++} END {print count + 0}')"`,
    `printf 'TOP_LISTEN_PORTS=%s\n' "$(printf '%s\n' "$SS_LISTEN" | awk 'BEGIN{ORS=""; q=sprintf("%c",34)} NR<=5 {proto=$1; local=$5; proc=$0; if (index(proc,"users:")) {split(proc,a,q); proc=a[2]} else {proc=""}; n=split(local,a,":"); port=a[n]; gsub(/[,|=]/," ",proc); printf "%s:%s:%s,", proto, port, proc}')"`,
    `FAILED_SERVICE_LINES=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}'); printf 'FAILED_SERVICE_COUNT=%s\n' "$(printf '%s\n' "$FAILED_SERVICE_LINES" | sed '/^$/d' | wc -l | tr -d ' ')"; printf 'FAILED_SERVICES=%s\n' "$(printf '%s\n' "$FAILED_SERVICE_LINES" | head -5 | paste -sd, -)"`,
    `RECENT_ERROR_LOGS=$(journalctl -p err..alert --since '1 hour ago' -n 200 --no-pager -q 2>/dev/null); printf 'RECENT_ERROR_COUNT=%s\n' "$(printf '%s\n' "$RECENT_ERROR_LOGS" | sed '/^$/d' | wc -l | tr -d ' ')"; printf 'RECENT_ERRORS=%s\n' "$(printf '%s\n' "$RECENT_ERROR_LOGS" | tail -3 | sed 's/[|=]/ /g' | paste -sd '|' - | cut -c1-500)"`,
    `if command -v firewall-cmd >/dev/null 2>&1; then FIREWALL_STATE=$(firewall-cmd --state 2>&1 | sed 's/\x1b\\[[0-9;]*m//g; s/[|=]/ /g' | head -1 | awk '{$1=$1; print}'); if [ -z "$FIREWALL_STATE" ]; then FIREWALL_STATE=$(systemctl is-active firewalld 2>/dev/null || echo unknown); fi; elif command -v ufw >/dev/null 2>&1; then FIREWALL_STATE=$(ufw status 2>/dev/null | head -1 | sed 's/[|=]/ /g'); elif command -v systemctl >/dev/null 2>&1; then FIREWALL_STATE=$(systemctl is-active firewalld 2>/dev/null || echo unknown); else FIREWALL_STATE=unknown; fi; printf 'FIREWALL_STATE=%s\n' "$FIREWALL_STATE"`,
    `if command -v getenforce >/dev/null 2>&1; then SELINUX_STATE=$(getenforce 2>/dev/null || echo unknown); else SELINUX_STATE=unknown; fi; printf 'SELINUX_STATE=%s\n' "$SELINUX_STATE"`,
  ];
}

const PLATFORM_INFO_COMMANDS = buildPlatformInfoCommands();
const SYSTEM_HEALTH_COMMANDS = buildSystemHealthCommands();

const REMOTE_PROBE_COMMAND = [
  'export LC_ALL=C LANG=C',
  buildCpuUsageCommand('CPU'),
  'HOSTNAME=$(hostname 2>/dev/null || echo unknown)',
  'UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)',
  "LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1\" \"$2\" \"$3}')",
  "MEM=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {if (t>0) printf \"%.2f\", (t-a)*100/t; else print \"\"}' /proc/meminfo 2>/dev/null)",
  "DISK=$(df -Pk / 2>/dev/null | awk 'NR==2 {gsub(/%/, \"\", $5); print $5}')",
  buildNetworkBytesCommand('NET_RX', 'NET_TX'),
  buildDiskIoBytesCommand('DISK_READ_BYTES', 'DISK_WRITE_BYTES'),
  buildProcessCountCommand('PROC_COUNT'),
  buildKeyProcessSummaryCommand('KEY_PROC'),
  ...PLATFORM_INFO_COMMANDS,
  ...SYSTEM_HEALTH_COMMANDS,
  "printf 'HOSTNAME=%s\n' \"$HOSTNAME\"",
  "printf 'UPTIME=%s\n' \"$UPTIME\"",
  "printf 'LOAD=%s\n' \"$LOAD\"",
  "printf 'CPU=%s\n' \"$CPU\"",
  "printf 'MEM=%s\n' \"$MEM\"",
  "printf 'DISK=%s\n' \"$DISK\"",
].join('; ');

const LOCAL_LINUX_EXTRA_COMMAND = [
  buildNetworkBytesCommand('RX', 'TX'),
  buildDiskIoBytesCommand('DISK_READ_BYTES', 'DISK_WRITE_BYTES'),
  buildProcessCountCommand('PROC_COUNT'),
  buildKeyProcessSummaryCommand('KEY_PROC'),
  ...PLATFORM_INFO_COMMANDS,
  ...SYSTEM_HEALTH_COMMANDS,
].join('; ');

module.exports = {
  KEY_PROCESS_NAMES,
  LOCAL_LINUX_EXTRA_COMMAND,
  REMOTE_PROBE_COMMAND,
};

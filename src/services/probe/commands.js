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
  return `awk -F'[: ]+' 'NR>2 && $2 != "lo" {rx+=$3; tx+=$11} END {printf "${rxKey}=%s\\n${txKey}=%s\\n", rx+0, tx+0}' /proc/net/dev 2>/dev/null`;
}

function buildDiskIoBytesCommand(readKey, writeKey) {
  return `awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+)$/ {read+=$6; write+=$10} END {printf "${readKey}=%s\\n${writeKey}=%s\\n", read*512, write*512}' /proc/diskstats 2>/dev/null`;
}

function buildProcessCountCommand(outputKey) {
  return `printf '${outputKey}=%s\\n' "$(ps -eo pid= 2>/dev/null | wc -l | tr -d ' ')"`;
}

function buildKeyProcessSummaryCommand(outputKey) {
  if (!KEY_PROCESS_NAMES.length) {
    return `printf '${outputKey}=\\n'`;
  }

  const names = KEY_PROCESS_NAMES.map(shellQuote).join(' ');
  return `KEY_PROC_BUFFER=""; for name in ${names}; do count=$(ps -eo comm= 2>/dev/null | awk -v target="$name" '$1 == target {count += 1} END {print count + 0}'); KEY_PROC_BUFFER="\${KEY_PROC_BUFFER}\${name}:\${count},"; done; printf '${outputKey}=%s\\n' "\${KEY_PROC_BUFFER%,}"`;
}

const REMOTE_PROBE_COMMAND = [
  'export LC_ALL=C LANG=C',
  'HOSTNAME=$(hostname 2>/dev/null || echo unknown)',
  'UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)',
  "LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1\" \"$2\" \"$3}')",
  "MEM=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {if (t>0) printf \"%.2f\", (t-a)*100/t; else print \"\"}' /proc/meminfo 2>/dev/null)",
  "DISK=$(df -Pk / 2>/dev/null | awk 'NR==2 {gsub(/%/, \"\", $5); print $5}')",
  "CPU=$(top -bn1 2>/dev/null | awk -F'[, ]+' '/^%?Cpu/ {for (i=1; i<=NF; i++) {if ($i == \"id\") {printf \"%.2f\", 100-$(i-1); exit}}}')",
  buildNetworkBytesCommand('NET_RX', 'NET_TX'),
  buildDiskIoBytesCommand('DISK_READ_BYTES', 'DISK_WRITE_BYTES'),
  buildProcessCountCommand('PROC_COUNT'),
  buildKeyProcessSummaryCommand('KEY_PROC'),
  "printf 'HOSTNAME=%s\\n' \"$HOSTNAME\"",
  "printf 'UPTIME=%s\\n' \"$UPTIME\"",
  "printf 'LOAD=%s\\n' \"$LOAD\"",
  "printf 'CPU=%s\\n' \"$CPU\"",
  "printf 'MEM=%s\\n' \"$MEM\"",
  "printf 'DISK=%s\\n' \"$DISK\"",
].join('; ');

const LOCAL_LINUX_EXTRA_COMMAND = [
  buildNetworkBytesCommand('RX', 'TX'),
  buildDiskIoBytesCommand('DISK_READ_BYTES', 'DISK_WRITE_BYTES'),
  buildProcessCountCommand('PROC_COUNT'),
  buildKeyProcessSummaryCommand('KEY_PROC'),
].join('; ');

module.exports = {
  KEY_PROCESS_NAMES,
  LOCAL_LINUX_EXTRA_COMMAND,
  REMOTE_PROBE_COMMAND,
};

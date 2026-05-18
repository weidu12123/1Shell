'use strict';

const DANGEROUS_PATTERNS = [
  { id: 'rm-rf-root', pattern: /\brm\s+-rf\s+(?:\/|\*)/, label: '递归删除根目录或通配路径' },
  { id: 'disk-write', pattern: /\bdd\s+(?:if=|of=)/, label: '底层磁盘写入' },
  { id: 'mkfs', pattern: /\bmkfs(?:\.|\s|$)/, label: '格式化文件系统' },
  { id: 'fork-bomb', pattern: /:\(\)\{:\|:&\};:/, label: 'fork bomb' },
  { id: 'chmod-root', pattern: /\bchmod\s+-R\s+[0-7]{3,4}\s+\//, label: '递归修改根目录权限' },
  { id: 'shutdown', pattern: /\bshutdown\b/, label: '关机' },
  { id: 'reboot', pattern: /\breboot\b/, label: '重启' },
  { id: 'ssh-config', pattern: /\/etc\/ssh\/|\bsshd_config\b/, label: '修改 SSH 配置' },
];

function assessCommandRisk(command) {
  const text = String(command || '');
  const matches = DANGEROUS_PATTERNS.filter((item) => item.pattern.test(text));
  return {
    dangerous: matches.length > 0,
    matches,
    reason: matches.map((m) => m.label).join('、'),
  };
}

function isDangerousCommand(command) {
  return assessCommandRisk(command).dangerous;
}

module.exports = { DANGEROUS_PATTERNS, assessCommandRisk, isDangerousCommand };

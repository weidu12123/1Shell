// terminal.ts — MainConsole 刀 2 终端相关共享类型
// 与老 [public/session-terminal.js](public/session-terminal.js) + [public/terminal-ai.js](public/terminal-ai.js) 1:1 对应

import type { ITheme } from '@xterm/xterm';

/* ───── 会话 ─────────────────────────────────────────── */

export type SessionStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

export interface SessionInfo {
  id: string;
  hostId: string;
  hostName?: string;
  status: SessionStatus;
  warning?: string;
  lastError?: string;
  cols?: number;
  rows?: number;
  createdAt?: number;
}

export interface SessionInputMeta {
  source?: string;
  [key: string]: unknown;
}

export interface SessionOutputPayload {
  sessionId: string;
  data: string;
}

export type LifecycleType =
  | 'host-switch-start'
  | 'session-change'
  | 'session-status'
  | 'session-error'
  | 'socket-connect'
  | 'socket-disconnect'
  | 'socket-error'
  | 'clear'
  | 'reset';

export interface LifecyclePayload {
  type: LifecycleType | string;
  hostId?: string;
  sessionId?: string;
  status?: SessionStatus;
  error?: string;
  reason?: string;
  forceReconnect?: boolean;
}

/* ───── xterm 主题（与老 session-terminal.js DARK_THEME/LIGHT_THEME 1:1） ───── */

export const DARK_THEME: ITheme = {
  background: '#0f1729',
  foreground: '#dbeafe',
  cursor: '#4f8cff',
  selectionBackground: 'rgba(79, 140, 255, 0.28)',
  black: '#1f2937', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5eefc',
  brightBlack: '#4b5563', brightRed: '#fca5a5', brightGreen: '#86efac',
  brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9', brightWhite: '#f8fafc',
};

export const LIGHT_THEME: ITheme = {
  background: '#f8fafc',
  foreground: '#1e293b',
  cursor: '#3b82f6',
  selectionBackground: 'rgba(59, 130, 246, 0.18)',
  black: '#374151', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#7c3aed', cyan: '#0891b2', white: '#f8fafc',
  brightBlack: '#6b7280', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
  brightCyan: '#06b6d4', brightWhite: '#ffffff',
};

/* ───── 缓冲/超时常量 ─────────────────────────────────── */

/** 单会话历史缓冲上限,与老 session-terminal.js .slice(-200000) 一致 */
export const SESSION_BUFFER_LIMIT = 200_000;

/** 重连指数退避起点 ms */
export const RECONNECT_DELAY_MIN = 1000;
/** 重连指数退避上限 ms */
export const RECONNECT_DELAY_MAX = 10_000;

/** terminal-ai debounce — 与老 terminal-ai.js DEBOUNCE_MS 一致 */
export const AI_DEBOUNCE_MS = 600;

/** terminal-ai 本地回显窗口 — 与老 OUTPUT_ECHO_GRACE_MS 一致 */
export const AI_ECHO_GRACE_MS = 1500;

/* ───── terminal-ai 已知命令字典（与老 terminal-ai.js COMMON_COMMANDS 1:1） ───── */

export const COMMON_COMMANDS: readonly string[] = [
  // 高频 Linux/Mac 工具
  'git', 'docker', 'kubectl', 'sudo', 'ssh', 'curl', 'wget',
  'ls', 'cat', 'grep', 'find', 'ps', 'kill', 'mkdir', 'rm', 'cp', 'mv',
  'echo', 'cd', 'pwd', 'touch', 'ln', 'chmod', 'chown', 'stat', 'df', 'du',
  'vim', 'nano', 'vi', 'less', 'more', 'man',
  'systemctl', 'journalctl', 'service',
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew',
  'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3',
  'python', 'python3', 'node', 'go', 'java', 'ruby', 'php',
  'rustc', 'cargo', 'make', 'cmake', 'gradle', 'mvn',
  'helm', 'terraform', 'ansible', 'vagrant',
  // 文本处理
  'sed', 'awk', 'sort', 'uniq', 'cut', 'head', 'tail',
  'wc', 'tr', 'xargs', 'tee', 'diff', 'patch',
  // 网络
  'ping', 'netstat', 'ss', 'ip', 'ifconfig', 'nmap',
  'dig', 'host', 'nslookup', 'traceroute', 'scp', 'rsync', 'nc',
  // 压缩归档
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz',
  // 系统监控
  'top', 'htop', 'free', 'vmstat', 'iostat', 'sar',
  'lsof', 'strace', 'ltrace', 'perf',
  // 系统信息
  'uname', 'hostname', 'uptime', 'who', 'whoami', 'id', 'w',
  'which', 'whereis', 'type', 'env', 'export', 'alias', 'history',
  // 进程/会话
  'screen', 'tmux', 'nohup', 'at', 'crontab', 'watch',
  // 权限/挂载
  'mount', 'umount', 'lsblk', 'fdisk', 'blkid', 'chroot',
  'useradd', 'usermod', 'userdel', 'groupadd', 'passwd',
  // 其他 Shell
  'bash', 'sh', 'zsh', 'fish', 'dash',
  // 数据库客户端
  'mysql', 'psql', 'redis-cli', 'mongo', 'sqlite3',
  // 安全/加密
  'openssl', 'ssh-keygen', 'gpg', 'base64',
  // 云/容器
  'aws', 'az', 'gcloud', 'doctl', 'minikube', 'kind', 'podman',
  // 其他常用
  'jq', 'yq', 'fzf', 'bat', 'fd', 'rg', 'ripgrep', 'eza',
  'nginx', 'apache2', 'httpd', 'php-fpm',
  'composer', 'gem', 'conda', 'pipenv', 'poetry',
  'svn', 'hg',
  // Windows 常用
  'dir', 'copy', 'del', 'move', 'ren', 'md', 'rd', 'rmdir',
  'ipconfig', 'tasklist', 'taskkill', 'powershell', 'where',
  'cls', 'attrib', 'chkdsk', 'sfc', 'reg', 'sc', 'runas',
  'shutdown', 'systeminfo', 'robocopy', 'xcopy', 'findstr', 'notepad',
  'diskpart', 'format', 'net', 'netsh',
];

export const COMMON_COMMANDS_SET: ReadonlySet<string> = new Set(COMMON_COMMANDS);

/* ───── AI 命令面板 / Ghost 浮层 类型 ───────────────── */

export interface GhostState {
  ghostText: string;
  ghostVisible: boolean;
  hint: string;
}

export interface AiApiConfig {
  apiBase?: string;
  apiKey?: string;
  model?: string;
}

/* ───── 终端区按钮 emit 类型(辅助) ───────────────── */

export interface TerminalAreaEmits {
  (e: 'host-change', hostId: string): void;
  (e: 'host-close', hostId: string): void;
  (e: 'fullscreen-toggle', value: boolean): void;
  (e: 'open-script-inject'): void;
  (e: 'open-playbook-inject'): void;
}

// mainConsole.ts — MainConsole 主控台共享类型
// 与老 [public/app.js](public/app.js) + [public/hosts.js](public/hosts.js) + [public/auth.js](public/auth.js) + [public/layout.js](public/layout.js) 字段 1:1 对应

/* ───── 主机（扩展自 stores/hosts.ts 的 Host） ────────── */

export interface HostLink {
  id?: string;
  name: string;
  url: string;
  description?: string;
}

export type HostAuthType = 'password' | 'privateKey';
export type HostType = 'local' | 'ssh';

export interface MainHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  type?: HostType;
  authType?: HostAuthType;
  proxyHostId?: string | null;
  links?: HostLink[];
  status?: string;
  tags?: string[];
}

export interface HostFormPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: HostAuthType;
  proxyHostId: string | null;
  links: HostLink[];
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface LocalHostConfigPayload {
  name: string;
  links: HostLink[];
}

/* ───── 登录态 ────────────────────────────────────── */

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

/* ───── 顶栏探针 ──────────────────────────────────── */

export interface ProbeStats {
  cpu?: number;       // 百分比 0-100
  memory?: number;    // 百分比
  load?: number;      // 1 分钟负载
  disk?: number;      // 百分比
}

export interface ProbeUpdatePayload {
  hostId: string;
  cpu?: number;
  memory?: number;
  load?: number;
  disk?: number;
}

/* ───── IP 访问控制 ───────────────────────────────── */

export interface IpFilterRule {
  id: string;
  type: 'allow' | 'deny';
  cidr: string;
  note?: string;
}

export interface IpFilterConfig {
  allowlistEnabled: boolean;
  denylistEnabled: boolean;
  rules: IpFilterRule[];
}

/* ───── 常量 ────────────────────────────────────── */

export const LOCAL_HOST_ID = 'local';
export const AUTH_TOKEN_KEY = 'auth_token'; // 向下兼容旧 useAuthStore key

/* ───── 帮手 ────────────────────────────────────── */

export function formatHostMeta(host: MainHost | null | undefined): string {
  if (!host) return '';
  if (host.type === 'local' || host.id === LOCAL_HOST_ID) return '部署节点 / 本地 Shell';
  return `${host.username || 'root'}@${host.host}:${host.port || 22}`;
}

export function isLocalHost(host: MainHost | null | undefined): boolean {
  return host?.id === LOCAL_HOST_ID || host?.type === 'local';
}

/** 检测是否 HTTP + 非 localhost — 用于 cookie 拦截警告 */
export function shouldShowHttpWarning(): boolean {
  if (typeof window === 'undefined') return false;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return proto === 'http:' && !isLocalhost;
}

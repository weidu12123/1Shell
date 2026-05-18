export type UpstreamProtocol = 'openai' | 'anthropic';

export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  repo: string;
  icon: string;
  gradient?: string;
  status: CliStatus;
  supportedUpstream?: UpstreamProtocol[];
  binary?: { name?: string; path?: string; installed: boolean };
  sandbox?: { sandboxed: boolean; sandboxDir?: string };
  proxy?: {
    providerCount: number;
    activeProvider?: ProviderInfo;
  };
}

export type CliStatus = 'sandboxed' | 'detected' | 'missing';

export interface ProviderInfo {
  id: string;
  name?: string;
  upstreamProtocol: UpstreamProtocol;
  apiBase?: string;
  apiKey?: string;
  apiKeySet: boolean;
  model?: string;
}

export interface ScanCounts {
  total: number;
  sandboxed: number;
  detected: number;
  missing: number;
}

export interface ScanResponse {
  ok: boolean;
  tools: ToolInfo[];
  counts: ScanCounts;
}

export interface EndpointsResponse {
  ok: boolean;
  endpoints: {
    bridge: { url: string; protocol: string };
    mcp: { url: string; protocol: string };
  };
  token: { masked: string; ready: boolean };
}

export interface DiagnosticsCheck {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
  error?: string;
}

export interface DiagnosticsResponse {
  ok: boolean;
  checks: DiagnosticsCheck[];
}

export interface ProvidersResponse {
  ok: boolean;
  providers: ProviderInfo[];
  activeProviderId?: string;
}

export interface LaunchCommandResponse {
  ok: boolean;
  cliId: string;
  shell: string;
  command: string;
  vars?: Record<string, string>;
}

export interface SandboxOpResponse {
  ok: boolean;
  cliId?: string;
  sandboxDir?: string;
  error?: string;
}

export const UPSTREAM_LABELS: Record<UpstreamProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
};

export interface StatusLabel {
  text: string;
  cls: string;
  icon: string;
}

export const STATUS_LABELS: Record<CliStatus, StatusLabel> = {
  sandboxed: { text: '沙箱就绪', cls: 'status-connected', icon: '●' },
  detected:  { text: '已检测',   cls: 'status-detected',  icon: '●' },
  missing:   { text: '未安装',   cls: 'status-missing',   icon: '○' },
};

export const FILTER_OPTIONS: Array<{ value: 'all' | CliStatus; label: string }> = [
  { value: 'all',       label: '全部' },
  { value: 'sandboxed', label: '沙箱就绪' },
  { value: 'detected',  label: '已检测' },
  { value: 'missing',   label: '未安装' },
];

export const SKILLS_SLOT_ID = 'skills';

export function detectShell(): 'powershell' | 'bash' {
  return navigator.platform.includes('Win') ? 'powershell' : 'bash';
}

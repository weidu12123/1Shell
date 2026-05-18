export interface SkillInfo {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  category?: 'system' | string;
}

export interface ClaudeCodeSkillEntry {
  id: string;
  name?: string;
  description?: string;
  path?: string;
  tags?: string[];
  userInvocable?: boolean;
}

export interface ClaudeCodeSkillInfo {
  id: string;
  kind?: 'claude-code-skill' | string;
  name?: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
  repoUrl?: string;
  installDir?: string;
  sourceDir?: string;
  importedAt?: string;
  updatedAt?: string;
  skills?: ClaudeCodeSkillEntry[];
}

export interface McpInfo {
  id: string;
  name: string;
  // 远程
  url?: string;
  authTokenSet?: boolean;
  // 本地
  type?: 'local' | string;
  command?: string;
  installDir?: string;
  // 通用
  description?: string;
  tags?: string[];
  enabled?: boolean;
  autoStart?: boolean;
  exposeToIde?: boolean;
  runtimeStatus?: string;
  runtimeError?: string;
  toolCount?: number;
}

export interface SkillsResponse {
  skills: SkillInfo[];
}

export interface McpServersResponse {
  servers: McpInfo[];
}

export interface ClaudeCodeSkillsResponse {
  skills: ClaudeCodeSkillInfo[];
}

export type TabKey = 'skill' | 'claude' | 'mcp' | 'local';

/** 与老版 warehouse-page.js:129-130 一致：本地 = 显式 type='local' 或 有 command */
export function isLocalMcp(m: McpInfo): boolean {
  return m.type === 'local' || !!m.command;
}

/** 输入框逗号串 → 去空 trim 数组 */
export function parseTags(raw: string): string[] {
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/** tags 数组 → 输入框逗号串展示 */
export function serializeTags(tags: string[] | undefined): string {
  return (tags || []).join(', ');
}

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * MCP Registry — 全局 MCP Server 登记册。
 *
 * 存储：data/mcp-servers.json
 * 形态：{ servers: [{ id, name, url, authToken, description, tags[], createdAt }] }
 *
 * 用途：
 *   - 仓库页管理（增删改查）
 *   - 创作台从这里选"工具"
 *   - 生成的 Playbook frontmatter 里 mcpServers 引用这里的 id（运行时再展开）
 *
 * 仅支持远程 URL 类 MCP（与现有 runner 能力一致）。
 */
function createMcpRegistry({ dataDir }) {
  const filePath = path.join(dataDir, 'mcp-servers.json');

  function ensureFile() {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ servers: [] }, null, 2), 'utf8');
    }
  }

  function _read() {
    ensureFile();
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.servers)) return { servers: [] };
      return parsed;
    } catch {
      return { servers: [] };
    }
  }

  function _write(data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function listServers() {
    return _read().servers.map(maskIfNeeded);
  }

  function listServersWithSecrets() {
    return _read().servers;
  }

  function getServer(id) {
    return _read().servers.find(s => s.id === id) || null;
  }

  function createServer(input) {
    const { name, url } = input || {};
    if (!name || typeof name !== 'string') throw new Error('name 不能为空');
    if (!url || typeof url !== 'string') throw new Error('url 不能为空');
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s):// 开头');

    const data = _read();
    const id = (input.id || kebab(name)).slice(0, 64);
    if (data.servers.find(s => s.id === id)) {
      throw new Error(`同名 MCP 已存在: ${id}`);
    }
    const server = {
      id,
      name: name.trim(),
      url: url.trim(),
      authToken: typeof input.authToken === 'string' ? input.authToken : '',
      description: typeof input.description === 'string' ? input.description : '',
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      createdAt: new Date().toISOString(),
    };
    data.servers.push(server);
    _write(data);
    return maskIfNeeded(server);
  }

  function updateServer(id, patch) {
    const data = _read();
    const idx = data.servers.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const s = data.servers[idx];
    if (typeof patch.name === 'string' && patch.name.trim()) s.name = patch.name.trim();
    if (typeof patch.url === 'string' && patch.url.trim()) {
      if (!/^https?:\/\//i.test(patch.url)) throw new Error('url 必须是 http(s):// 开头');
      s.url = patch.url.trim();
    }
    if (typeof patch.authToken === 'string') s.authToken = patch.authToken;
    if (typeof patch.description === 'string') s.description = patch.description;
    if (Array.isArray(patch.tags)) s.tags = patch.tags.map(String);
    _write(data);
    return maskIfNeeded(s);
  }

  function deleteServer(id) {
    const data = _read();
    const before = data.servers.length;
    data.servers = data.servers.filter(s => s.id !== id);
    if (data.servers.length === before) return false;
    _write(data);
    return true;
  }

  function kebab(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
  }

  function maskIfNeeded(s) {
    if (!s) return s;
    const { authToken, ...rest } = s;
    return { ...rest, authTokenSet: Boolean(authToken) };
  }

  return {
    listServers,
    listServersWithSecrets,
    getServer,
    createServer,
    updateServer,
    deleteServer,
  };
}

module.exports = { createMcpRegistry };
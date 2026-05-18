'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../../lib/logger');

const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');

/**
 * 启动时同步 ~/.claude.json 中 1shell MCP 条目的 token / url。
 *
 * 设计原则（保守、最小侵入）：
 *   - ~/.claude.json 不存在 → 跳过（用户没装 Claude Code）
 *   - 1shell 条目不存在 → 创建 SSE 配置（首次启动自动注册）
 *   - 1shell 条目已存在 → 只更新 token 和 url，不改变用户选的传输类型 / 参数
 *   - 已是最新 → 不写文件，不打日志
 *   - 设置 ONESHELL_SKIP_CLAUDE_SYNC=1 → 完全跳过（逃生通道）
 */
function syncGlobalClaudeMcp({ port, bridgeToken }) {
  if (process.env.ONESHELL_SKIP_CLAUDE_SYNC === '1') return;
  if (!bridgeToken || !port) return;
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8'));
  } catch (err) {
    log.warn('[claude-config-sync] 跳过 ~/.claude.json：读/解析失败', { error: err.message });
    return;
  }
  if (!config || typeof config !== 'object') return;

  const desiredUrl = `http://127.0.0.1:${port}/mcp/sse`;
  config.mcpServers = config.mcpServers || {};
  const current = config.mcpServers['1shell'];

  let action = null;
  let oldTokenPreview = null;

  if (!current) {
    // 首次注册 — 创建 SSE 配置
    config.mcpServers['1shell'] = {
      type: 'sse',
      url: desiredUrl,
      headers: { 'X-Bridge-Token': bridgeToken },
    };
    action = 'created';
  } else if (current.type === 'sse' || current.url) {
    // 用户保留 SSE 配置 — 只更新 token / url
    const currentToken = current.headers && current.headers['X-Bridge-Token'];
    if (currentToken !== bridgeToken || current.url !== desiredUrl) {
      oldTokenPreview = currentToken ? currentToken.slice(0, 12) + '…' : '(空)';
      current.url = desiredUrl;
      current.headers = { ...(current.headers || {}), 'X-Bridge-Token': bridgeToken };
      action = 'updated-sse';
    }
  } else if (current.type === 'stdio' || current.command) {
    // 用户选了 stdio — 尊重传输类型，只更新 env 中的 token / url
    const env = current.env || {};
    const currentToken = env.ONESHELL_TOKEN;
    const currentUrl = env.ONESHELL_URL;
    const desiredOriginUrl = `http://127.0.0.1:${port}`;
    if (currentToken !== bridgeToken || currentUrl !== desiredOriginUrl) {
      oldTokenPreview = currentToken ? currentToken.slice(0, 12) + '…' : '(空)';
      current.env = { ...env, ONESHELL_URL: desiredOriginUrl, ONESHELL_TOKEN: bridgeToken };
      action = 'updated-stdio';
    }
  }

  if (!action) return;

  try {
    const tmp = `${CLAUDE_CONFIG_FILE}.1shell-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, CLAUDE_CONFIG_FILE);

    if (action === 'created') {
      log.info('[claude-config-sync] 已在 ~/.claude.json 注册 1shell MCP（SSE）');
    } else {
      log.info(`[claude-config-sync] 已同步 1shell ${action === 'updated-sse' ? 'SSE' : 'stdio'} token`, {
        from: oldTokenPreview,
        to: bridgeToken.slice(0, 12) + '…',
      });
    }
  } catch (err) {
    log.warn('[claude-config-sync] 写入 ~/.claude.json 失败', { error: err.message });
  }
}

module.exports = { syncGlobalClaudeMcp };

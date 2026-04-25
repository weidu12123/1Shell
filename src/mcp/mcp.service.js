'use strict';

const crypto = require('crypto');
const { createId } = require('../utils/common');
const { BRIDGE_TOKEN } = require('../config/env');
const { TOOLS, makeTextContent, formatExecResult } = require('./mcp.tools');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: '1shell-bridge', version: '1.0.0' };

/**
 * MCP Service
 *
 * 实现 MCP HTTP SSE 传输协议（JSON-RPC 2.0）。
 *
 * 连接生命周期：
 *   1. 客户端 GET /mcp/sse → 建立 SSE 长连接，收到 endpoint 事件
 *   2. 客户端 POST /mcp/message?sessionId=xxx → 发送 JSON-RPC 请求
 *   3. 服务端通过 SSE 回发 JSON-RPC 响应
 *   4. 客户端断开 → 清理 session
 *
 * 支持的 JSON-RPC 方法：
 *   - initialize / initialized
 *   - ping
 *   - tools/list
 *   - tools/call
 */
function createMcpService({ bridgeService, hostService, auditService, bridgeToken, localMcpService, mcpRegistry }) {
  // Map<sessionId, { res: Response, initialized: boolean }>
  const sessions = new Map();

  // ─── SSE 工具函数 ────────────────────────────────────────────────────────

  function sseWrite(res, event, data) {
    // message 事件的 data 是 JSON 对象，需要序列化；
    // endpoint 事件的 data 是裸 URL 字符串，不能额外加引号
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`event: ${event}\ndata: ${dataStr}\n\n`);
  }

  function sendMessage(sessionId, payload) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    sseWrite(session.res, 'message', payload);
    return true;
  }

  function makeResponse(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  function makeError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  // ─── 工具调用分发 ─────────────────────────────────────────────────────────

  async function callTool(name, args) {
    if (name === 'list_hosts') {
      const hosts = hostService.listHosts()
        .filter((h) => h.type === 'ssh')
        .map((h) => `id=${h.id}  name=${h.name}  ${h.host}:${h.port || 22}`);

      const text = hosts.length > 0
        ? hosts.join('\n')
        : '（当前没有已配置的远程 SSH 主机）';

      return { content: makeTextContent(text), isError: false };
    }

    if (name === 'execute_ssh_command') {
      const { hostId, command, timeout } = args || {};

      if (!hostId || !command) {
        return {
          content: makeTextContent('hostId 和 command 为必填参数', true),
          isError: true,
        };
      }

      try {
        const result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'mcp' });
        return {
          content: makeTextContent(formatExecResult(result)),
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        return {
          content: makeTextContent(err.message, true),
          isError: true,
        };
      }
    }

    if (name === 'list_mcp_tools') {
      const lines = [];
      // 列出仓库中的本地 MCP
      const servers = mcpRegistry ? mcpRegistry.listServers().filter(s => s.type === 'local' || s.command) : [];
      if (servers.length === 0) {
        return { content: makeTextContent('1Shell 平台上暂无已注册的本地 MCP Server。'), isError: false };
      }
      for (const s of servers) {
        const status = localMcpService ? localMcpService.getStatus(s.id) : { status: 'unavailable', tools: [] };
        lines.push(`\n## ${s.name} (id: ${s.id})`);
        lines.push(`状态: ${status.status} | 命令: ${s.command || '(无)'}`);
        if (s.description) lines.push(`描述: ${s.description}`);
        if (status.tools.length > 0) {
          lines.push(`工具 (${status.tools.length}):`);
          for (const t of status.tools) {
            lines.push(`  - ${t.name}: ${(t.description || '').slice(0, 100)}`);
          }
        } else if (status.status === 'running') {
          lines.push('工具: (无)');
        } else {
          lines.push('工具: (未启动，调用 call_mcp_tool 时会自动启动)');
        }
      }
      return { content: makeTextContent(lines.join('\n')), isError: false };
    }

    if (name === 'call_mcp_tool') {
      const { mcpId, toolName, args: toolArgs } = args || {};
      if (!mcpId || !toolName) {
        return { content: makeTextContent('mcpId 和 toolName 为必填参数', true), isError: true };
      }
      if (!localMcpService) {
        return { content: makeTextContent('本地 MCP 服务未初始化', true), isError: true };
      }
      // 如果未运行，自动启动
      const status = localMcpService.getStatus(mcpId);
      if (status.status !== 'running') {
        const server = mcpRegistry ? mcpRegistry.getServer(mcpId) : null;
        if (!server || (!server.command && server.type !== 'local')) {
          return { content: makeTextContent(`MCP "${mcpId}" 不存在或不是本地类型`, true), isError: true };
        }
        const startResult = await localMcpService.start(mcpId, server.command, { cwd: server.installDir || undefined });
        if (!startResult.ok) {
          return { content: makeTextContent(`MCP "${mcpId}" 启动失败: ${startResult.error}`, true), isError: true };
        }
      }
      try {
        const result = await localMcpService.callTool(mcpId, toolName, toolArgs || {});
        return { content: makeTextContent(result.content), isError: result.is_error || false };
      } catch (err) {
        return { content: makeTextContent(err.message, true), isError: true };
      }
    }

    return {
      content: makeTextContent(`未知工具: ${name}`, true),
      isError: true,
    };
  }

  // ─── JSON-RPC 消息处理 ────────────────────────────────────────────────────

  async function handleMessage(sessionId, msg) {
    const { id, method, params } = msg;

    // 通知类消息（无 id），不需要回复
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        const session = sessions.get(sessionId);
        if (session) session.initialized = true;
      }
      return;
    }

    if (method === 'initialize') {
      const session = sessions.get(sessionId);
      if (session) session.initializing = true;

      sendMessage(sessionId, makeResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }));
      return;
    }

    if (method === 'ping') {
      sendMessage(sessionId, makeResponse(id, {}));
      return;
    }

    if (method === 'tools/list') {
      sendMessage(sessionId, makeResponse(id, { tools: TOOLS }));
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const toolResult = await callTool(name, args);
      sendMessage(sessionId, makeResponse(id, toolResult));
      return;
    }

    sendMessage(sessionId, makeError(id, -32601, `未知方法: ${method}`));
  }

  // ─── Session 管理（供 Routes 调用）────────────────────────────────────────

  /**
   * 建立 SSE 连接，返回 sessionId。
   * Route 层负责设置 SSE 响应头，本函数只注册 session 并发送 endpoint 事件。
   *
   * @param {object} res - Express Response 对象（已设置 SSE headers）
   * @param {string} baseUrl - 如 "http://localhost:3301"
   * @returns {string} sessionId
   */
  function connect(res, baseUrl) {
    const sessionId = createId('mcp');
    sessions.set(sessionId, { res, initialized: false });

    // 不把 token 拼进 URL（防止进 access log / 浏览器历史）
    // 客户端应通过 X-Bridge-Token header 或 Authorization: Bearer 传递 token
    sseWrite(res, 'endpoint', `${baseUrl}/mcp/message?sessionId=${sessionId}`);

    return sessionId;
  }

  /**
   * 清理 SSE session。
   */
  function disconnect(sessionId) {
    sessions.delete(sessionId);
  }

  /**
   * 处理来自 POST /mcp/message 的 JSON-RPC 消息。
   * 返回 true 表示 session 存在并已处理，false 表示 session 不存在。
   */
  async function receiveMessage(sessionId, msg) {
    if (!sessions.has(sessionId)) return false;
    await handleMessage(sessionId, msg);
    return true;
  }

  /**
   * 验证请求的 Bridge Token。
   */
  function validateToken(token) {
    if (!BRIDGE_TOKEN || !token) return false;
    if (token.length !== BRIDGE_TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(BRIDGE_TOKEN));
  }

  /**
   * 处理 Streamable HTTP MCP 请求（无状态，不需要 SSE session）。
   * 返回 JSON-RPC 响应对象，或 null（通知类消息）。
   */
  async function handleDirectRequest(msg) {
    const { id, method, params } = msg;

    if (id === undefined || id === null) {
      return null;
    }

    if (method === 'initialize') {
      return makeResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === 'ping') {
      return makeResponse(id, {});
    }

    if (method === 'tools/list') {
      return makeResponse(id, { tools: TOOLS });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const toolResult = await callTool(name, args);
      return makeResponse(id, toolResult);
    }

    return makeError(id, -32601, `未知方法: ${method}`);
  }

  return { connect, disconnect, receiveMessage, handleDirectRequest, validateToken };
}

module.exports = { createMcpService };

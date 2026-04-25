'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Local MCP Service — 本地 MCP Server 进程管理 + stdio JSON-RPC 客户端
 *
 * 职责：
 *   - spawn / kill 本地 MCP 进程（stdio 传输）
 *   - 通过 JSON-RPC 2.0 over stdio 与 MCP 通信
 *   - 发现工具（tools/list）、调用工具（tools/call）
 *   - 选中时启动、取消时停止
 */
function createLocalMcpService({ logger }) {
  // mcpId → { process, tools[], status, error?, buffer }
  const instances = new Map();
  let nextReqId = 1;

  /**
   * 启动一个本地 MCP Server 进程，通过 stdio 初始化并发现工具。
   * @returns {Promise<{ ok, tools?, error? }>}
   */
  async function start(mcpId, command, { cwd, env } = {}) {
    if (instances.has(mcpId)) {
      const inst = instances.get(mcpId);
      if (inst.status === 'running') return { ok: true, tools: inst.tools };
      stop(mcpId);
    }

    const inst = {
      process: null,
      tools: [],
      status: 'starting',
      error: null,
      buffer: '',
      pending: new Map(),
    };
    instances.set(mcpId, inst);

    try {
      const parts = parseCommand(command);
      if (parts.length === 0) throw new Error('command 为空');

      const child = spawn(parts[0], parts.slice(1), {
        cwd: cwd || undefined,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
      inst.process = child;

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        logger?.debug?.(`[local-mcp:${mcpId}] stderr: ${text.slice(0, 200)}`);
      });

      child.stdout.on('data', (chunk) => {
        inst.buffer += chunk.toString();
        drainBuffer(inst);
      });

      child.on('error', (err) => {
        inst.status = 'error';
        inst.error = err.message;
        logger?.error?.(`[local-mcp:${mcpId}] process error`, err.message);
      });

      child.on('exit', (code) => {
        if (inst.status !== 'stopped') {
          inst.status = 'exited';
          inst.error = `进程退出 code=${code}`;
        }
        for (const [, p] of inst.pending) {
          p.reject(new Error('MCP 进程已退出'));
        }
        inst.pending.clear();
      });

      // 初始化 MCP 协议
      const initResult = await sendRequest(inst, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '1shell', version: '1.0.0' },
      }, 10000);

      // 发送 initialized 通知
      sendNotification(inst, 'notifications/initialized', {});

      // 发现工具
      const toolsResult = await sendRequest(inst, 'tools/list', {}, 10000);
      inst.tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      inst.status = 'running';

      logger?.info?.(`[local-mcp:${mcpId}] started, ${inst.tools.length} tools discovered`);
      return { ok: true, tools: inst.tools };

    } catch (err) {
      inst.status = 'error';
      inst.error = err.message;
      killProcess(inst);
      logger?.error?.(`[local-mcp:${mcpId}] start failed`, err.message);
      return { ok: false, error: err.message };
    }
  }

  function stop(mcpId) {
    const inst = instances.get(mcpId);
    if (!inst) return;
    inst.status = 'stopped';
    killProcess(inst);
    instances.delete(mcpId);
  }

  function getStatus(mcpId) {
    const inst = instances.get(mcpId);
    if (!inst) return { status: 'stopped', tools: [] };
    return { status: inst.status, tools: inst.tools, error: inst.error };
  }

  function getTools(mcpId) {
    const inst = instances.get(mcpId);
    return inst?.status === 'running' ? inst.tools : [];
  }

  /**
   * 获取所有运行中实例的工具，转为 Anthropic tool 格式。
   * 工具名加前缀 `mcp__<mcpId>__`，总长 ≤ 64 字符（Anthropic 限制）。
   */
  function getAllActiveTools() {
    const MAX_NAME = 64;
    const OVERHEAD = 'mcp____'.length; // mcp__ + __
    const result = [];
    const seen = new Set();
    for (const [mcpId, inst] of instances) {
      if (inst.status !== 'running') continue;
      const sid = sanitizeId(mcpId);
      const maxToolLen = Math.max(...inst.tools.map(t => t.name.length), 0);
      const sidLen = Math.max(4, Math.min(sid.length, MAX_NAME - OVERHEAD - maxToolLen));
      const prefix = `mcp__${sid.substring(0, sidLen)}__`;

      for (const t of inst.tools) {
        let name = `${prefix}${t.name}`;
        if (name.length > MAX_NAME) {
          name = name.substring(0, MAX_NAME);
        }
        if (seen.has(name)) continue;
        seen.add(name);
        result.push({
          name,
          description: `[MCP: ${mcpId}] ${t.description || ''}`,
          input_schema: t.inputSchema || { type: 'object', properties: {} },
          _mcpId: mcpId,
          _mcpToolName: t.name,
        });
      }
    }
    return result;
  }

  /**
   * 调用本地 MCP 的工具。
   */
  async function callTool(mcpId, toolName, args, timeout = 60000) {
    const inst = instances.get(mcpId);
    if (!inst || inst.status !== 'running') {
      throw new Error(`MCP "${mcpId}" 未运行`);
    }

    const result = await sendRequest(inst, 'tools/call', {
      name: toolName,
      arguments: args || {},
    }, timeout);

    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return '[image]';
      return JSON.stringify(c);
    }).join('\n');

    return { content: text || '(empty)', is_error: result?.isError || false };
  }

  /**
   * 路由一个带 mcp__ 前缀的工具调用到对应的本地 MCP。
   * @returns {{ handled: boolean, result? }}
   */
  async function routeToolCall(toolName, args) {
    const match = toolName.match(/^mcp__([^_]+)__(.+)$/);
    if (!match) return { handled: false };
    const mcpId = match[1];
    const realToolName = match[2];
    try {
      const result = await callTool(mcpId, realToolName, args);
      return { handled: true, result };
    } catch (err) {
      return { handled: true, result: { content: `[ERROR] ${err.message}`, is_error: true } };
    }
  }

  function listActive() {
    const out = [];
    for (const [id, inst] of instances) {
      out.push({ id, status: inst.status, toolCount: inst.tools.length, error: inst.error });
    }
    return out;
  }

  // ─── stdio JSON-RPC helpers ─────────────────────────────────────────

  function sendRequest(inst, method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!inst.process?.stdin?.writable) {
        return reject(new Error('stdin 不可写'));
      }
      const id = nextReqId++;
      const timer = setTimeout(() => {
        inst.pending.delete(id);
        reject(new Error(`${method} 超时 (${timeout}ms)`));
      }, timeout);

      inst.pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      inst.process.stdin.write(msg);
    });
  }

  function sendNotification(inst, method, params) {
    if (!inst.process?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    inst.process.stdin.write(msg);
  }

  function drainBuffer(inst) {
    let idx;
    while ((idx = inst.buffer.indexOf('\n')) !== -1) {
      const line = inst.buffer.slice(0, idx).trim();
      inst.buffer = inst.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && inst.pending.has(msg.id)) {
          const p = inst.pending.get(msg.id);
          inst.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // not JSON, ignore (might be startup logs)
      }
    }
  }

  function killProcess(inst) {
    try {
      if (inst.process && !inst.process.killed) {
        inst.process.kill('SIGTERM');
        setTimeout(() => {
          try { if (!inst.process.killed) inst.process.kill('SIGKILL'); } catch {}
        }, 3000);
      }
    } catch {}
  }

  function parseCommand(cmd) {
    const trimmed = String(cmd || '').trim();
    if (!trimmed) return [];
    // Simple split on spaces, respecting quotes
    const parts = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of trimmed) {
      if (inQuote) {
        if (ch === quoteChar) { inQuote = false; continue; }
        current += ch;
      } else {
        if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; continue; }
        if (ch === ' ' || ch === '\t') {
          if (current) { parts.push(current); current = ''; }
          continue;
        }
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  function sanitizeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function stopAll() {
    for (const id of [...instances.keys()]) stop(id);
  }

  return {
    start, stop, getStatus, getTools,
    getAllActiveTools, callTool, routeToolCall,
    listActive, stopAll,
  };
}

module.exports = { createLocalMcpService };

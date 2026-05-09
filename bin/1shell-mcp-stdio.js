#!/usr/bin/env node
'use strict';

/**
 * 1Shell MCP stdio 桥接
 *
 * 将 stdin/stdout 的 JSON-RPC 消息转发到 1Shell 的 Streamable HTTP MCP 端点。
 * 用于 Codex / OpenCode 等仅支持 stdio 传输的 MCP 客户端。
 *
 * 环境变量：
 *   ONESHELL_URL   — 1Shell 服务地址（默认 http://127.0.0.1:3301）
 *   ONESHELL_TOKEN — Bridge Token
 */

const http = require('http');
const readline = require('readline');

const BASE_URL = (process.env.ONESHELL_URL || 'http://127.0.0.1:3301').replace(/\/$/, '');
const TOKEN = process.env.ONESHELL_TOKEN || '';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  postMessage(msg)
    .then((result) => {
      if (result !== null) {
        process.stdout.write(JSON.stringify(result) + '\n');
      }
    })
    .catch((err) => {
      if (msg.id != null) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: err.message },
        }) + '\n');
      }
    });
});

function postMessage(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${BASE_URL}/mcp/sse`);

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Bridge-Token': TOKEN,
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 202) {
          resolve(null);
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`Invalid JSON from server: ${text.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Request timeout'));
    });

    req.write(payload);
    req.end();
  });
}

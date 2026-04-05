'use strict';

/**
 * MCP 协议端到端测试
 *
 * 模拟 claude-code 的完整交互流程：
 *   1. 建立 SSE 连接 → 收到 endpoint 事件
 *   2. 发送 initialize 请求 → 收到 serverInfo
 *   3. 发送 tools/list → 收到工具列表
 *   4. 调用 execute_ssh_command → 收到执行结果
 *   5. 调用 list_hosts → 收到主机列表
 *   6. 断开 SSE → 验证清理
 */

const http = require('http');
const https = require('https');

class McpTestClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.sessionId = null;
    this.postEndpoint = null;
    this.messages = [];
    this.pendingResolvers = new Map(); // id → resolve
    this.nextId = 1;
    this.sseReq = null;
  }

  // ─── SSE 连接 ───────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL('/mcp/sse', this.baseUrl);
      const mod = url.protocol === 'https:' ? https : http;

      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'X-Bridge-Token': this.token,
        },
        rejectUnauthorized: false,
      };

      this.sseReq = mod.request(opts, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connect failed: HTTP ${res.statusCode}`));
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          this._processSSEBuffer(buffer);
          buffer = buffer.substring(buffer.lastIndexOf('\n\n') + 2);

          // 收到 endpoint 事件后 resolve
          if (this.postEndpoint && !this._connected) {
            this._connected = true;
            resolve();
          }
        });

        res.on('end', () => {
          // SSE 断开
        });
      });

      this.sseReq.on('error', reject);
      this.sseReq.end();
    });
  }

  _processSSEBuffer(buffer) {
    const events = buffer.split('\n\n').filter(Boolean);
    for (const event of events) {
      const lines = event.split('\n');
      let eventType = '';
      let data = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.substring(7);
        if (line.startsWith('data: ')) data = line.substring(6);
      }

      if (eventType === 'endpoint' && data) {
        try {
          this.postEndpoint = JSON.parse(data);
        } catch {
          this.postEndpoint = data;
        }
      } else if (eventType === 'message' && data) {
        try {
          const msg = JSON.parse(data);
          this.messages.push(msg);
          if (msg.id !== undefined && this.pendingResolvers.has(msg.id)) {
            this.pendingResolvers.get(msg.id)(msg);
            this.pendingResolvers.delete(msg.id);
          }
        } catch { /* ignore */ }
      }
    }
  }

  // ─── JSON-RPC 请求 ─────────────────────────────────────────────────

  sendRequest(method, params = {}) {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      this.pendingResolvers.set(id, resolve);

      // 超时
      setTimeout(() => {
        if (this.pendingResolvers.has(id)) {
          this.pendingResolvers.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);

      const url = new URL(this.postEndpoint);
      const mod = url.protocol === 'https:' ? https : http;

      const req = mod.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Token': this.token,
        },
        rejectUnauthorized: false,
      }, (res) => {
        // MCP spec: POST 返回 202
        if (res.statusCode !== 202) {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            this.pendingResolvers.delete(id);
            reject(new Error(`POST failed: HTTP ${res.statusCode} - ${body}`));
          });
          return;
        }
        res.resume();
      });

      req.on('error', (err) => {
        this.pendingResolvers.delete(id);
        reject(err);
      });
      req.end(body);
    });
  }

  sendNotification(method, params = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    const url = new URL(this.postEndpoint);
    const mod = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Token': this.token,
        },
        rejectUnauthorized: false,
      }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.end(body);
    });
  }

  disconnect() {
    if (this.sseReq) {
      this.sseReq.destroy();
      this.sseReq = null;
    }
  }
}

// ─── 测试执行 ─────────────────────────────────────────────────────────

async function runTest(baseUrl, token, testHostId) {
  const client = new McpTestClient(baseUrl, token);
  const results = [];
  let pass = 0;
  let fail = 0;

  function check(name, condition, detail = '') {
    if (condition) {
      results.push(`  ✔ ${name}`);
      pass++;
    } else {
      results.push(`  ✖ ${name}${detail ? ': ' + detail : ''}`);
      fail++;
    }
  }

  try {
    // 1. SSE 连接
    console.log('1. Connecting SSE...');
    await client.connect();
    check('SSE 连接建立', Boolean(client.postEndpoint));
    check('endpoint URL 合法', client.postEndpoint.includes('/mcp/message?sessionId='));

    // 2. initialize
    console.log('2. Sending initialize...');
    const initResp = await client.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: '1shell-test-client', version: '1.0.0' },
    });
    check('initialize 返回 protocolVersion', initResp.result?.protocolVersion === '2024-11-05');
    check('initialize 返回 serverInfo', initResp.result?.serverInfo?.name === '1shell-bridge');
    check('initialize 返回 tools 能力', Boolean(initResp.result?.capabilities?.tools));

    // 3. initialized 通知
    await client.sendNotification('notifications/initialized');
    check('initialized 通知已发送', true);

    // 4. tools/list
    console.log('3. Listing tools...');
    const toolsResp = await client.sendRequest('tools/list');
    const tools = toolsResp.result?.tools || [];
    check('tools/list 返回工具列表', tools.length >= 2);
    check('包含 execute_ssh_command', tools.some(t => t.name === 'execute_ssh_command'));
    check('包含 list_hosts', tools.some(t => t.name === 'list_hosts'));
    check('execute_ssh_command 有 inputSchema', Boolean(tools.find(t => t.name === 'execute_ssh_command')?.inputSchema));

    // 5. list_hosts
    console.log('4. Calling list_hosts...');
    const hostsResp = await client.sendRequest('tools/call', {
      name: 'list_hosts',
      arguments: {},
    });
    const hostsText = hostsResp.result?.content?.[0]?.text || '';
    check('list_hosts 返回内容', hostsText.length > 0);
    check('list_hosts 包含主机信息', hostsText.includes('id='));

    // 6. execute_ssh_command
    if (testHostId) {
      console.log('5. Calling execute_ssh_command...');
      const execResp = await client.sendRequest('tools/call', {
        name: 'execute_ssh_command',
        arguments: { hostId: testHostId, command: 'echo MCP_E2E_OK && hostname' },
      });
      const execText = execResp.result?.content?.[0]?.text || '';
      check('execute_ssh_command 返回结果', execText.includes('MCP_E2E_OK'));
      check('execute_ssh_command 包含 exitCode', execText.includes('[exitCode] 0'));
      check('execute_ssh_command 包含 durationMs', execText.includes('[durationMs]'));
    }

    // 7. ping
    console.log('6. Ping...');
    const pingResp = await client.sendRequest('ping');
    check('ping 返回成功', pingResp.result !== undefined);

    // 8. 未知方法
    console.log('7. Unknown method...');
    const unknownResp = await client.sendRequest('nonexistent/method');
    check('未知方法返回错误', Boolean(unknownResp.error));
    check('错误码 -32601', unknownResp.error?.code === -32601);

    // 9. execute_ssh_command 错误场景
    console.log('8. Error scenarios...');
    const badHostResp = await client.sendRequest('tools/call', {
      name: 'execute_ssh_command',
      arguments: { hostId: 'nonexistent', command: 'echo test' },
    });
    check('不存在的 hostId 返回错误', badHostResp.result?.isError === true);

    const missingArgsResp = await client.sendRequest('tools/call', {
      name: 'execute_ssh_command',
      arguments: {},
    });
    check('缺少参数返回错误', missingArgsResp.result?.isError === true);

  } catch (err) {
    results.push(`  ✖ 异常: ${err.message}`);
    fail++;
  } finally {
    client.disconnect();
  }

  console.log('\n=== MCP 协议联调结果 ===');
  results.forEach(r => console.log(r));
  console.log(`\n总计: ${pass + fail} 项, 通过: ${pass}, 失败: ${fail}`);
  return { pass, fail };
}

// 从命令行参数或环境变量获取配置
const baseUrl = process.argv[2] || 'http://localhost:3301';
const token = process.argv[3] || process.env.BRIDGE_TOKEN || '';
const hostId = process.argv[4] || '';

if (!token) {
  // 无 token 时跳过（CI 环境通过 npm test 运行不应失败）
  console.log('SKIP: MCP E2E 测试需要 BRIDGE_TOKEN，跳过');
  console.log('Usage: node test/mcp-e2e.test.js <baseUrl> <bridgeToken> [hostId]');
  process.exit(0);
}

runTest(baseUrl, token, hostId).then(({ fail }) => {
  process.exit(fail > 0 ? 1 : 0);
});

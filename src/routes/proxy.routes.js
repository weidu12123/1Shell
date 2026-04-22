'use strict';

/**
 * 多协议转换代理 — 每个 CLI 独立端点，多 Provider 支持
 *
 * 每个 CLI 的活跃 Provider 决定 upstreamProtocol:
 *   'openai'    — 上游是 OpenAI 兼容 API
 *   'anthropic' — 上游是 Anthropic Messages API（透传）
 *
 * 路由根据 CLI 的 clientProtocol（CLI 发过来的格式）+ upstreamProtocol 自动选择转换方案：
 *   client=anthropic + upstream=openai  → Anthropic→OpenAI 转换
 *   client=anthropic + upstream=anthropic → 透传
 *   client=openai    + upstream=openai  → 透传
 *   ...以此类推
 */

const { Router } = require('express');
const fetch = require('node-fetch');
const log = require('../../lib/logger');

// ═══════════════════════════════════════════════════════════════════════
//  共用工具
// ═══════════════════════════════════════════════════════════════════════

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function normalizeBase(apiBase) {
  let base = apiBase.replace(/\/$/, '');
  if (!/\/v1$/.test(base)) base += '/v1';
  return base;
}

function errResponse(res, code, msg, format) {
  if (format === 'anthropic') {
    return res.status(code).json({ type: 'error', error: { type: 'api_error', message: msg } });
  }
  return res.status(code).json({ error: { message: msg } });
}

async function callOpenAIUpstream(base, apiKey, body) {
  return fetch(`${normalizeBase(base)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

async function callOpenAIResponsesUpstream(base, apiKey, body) {
  return fetch(`${normalizeBase(base)}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

async function callAnthropicUpstream(base, apiKey, body, extraHeaders) {
  let url = base.replace(/\/$/, '');
  if (!/\/v1$/.test(url)) url += '/v1';
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v != null && v !== '') headers[k] = String(v);
    }
  }
  return fetch(`${url}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  Anthropic ↔ OpenAI 转换
// ═══════════════════════════════════════════════════════════════════════

/** Anthropic tools → OpenAI tools */
function convertAnthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/** OpenAI tools → Anthropic tools */
function convertOpenAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => ({
    name: tool.function?.name || tool.name || '',
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} },
  }));
}

/** OpenAI messages[] → Anthropic messages[]（处理 tool/tool_calls） */
function openaiMessagesToAnthropic(messages) {
  const result = [];
  for (const msg of (messages || [])) {
    if (msg.role === 'system') continue;
    if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of (msg.tool_calls || [])) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Date.now().toString(36)}`,
          name: tc.function?.name || 'unknown',
          input,
        });
      }
      if (content.length > 0) result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // OpenAI tool result → Anthropic tool_result，尽量合并到前一条 user 消息
      const last = result[result.length - 1];
      const tr = { type: 'tool_result', tool_use_id: msg.tool_call_id || 'unknown', content: msg.content || '' };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(tr);
      } else {
        result.push({ role: 'user', content: [tr] });
      }
    } else {
      result.push({ role: 'user', content: msg.content || '' });
    }
  }
  return result;
}

/** 将一条 Anthropic assistant 消息转为 OpenAI assistant 消息（含 tool_calls） */
function convertAnthropicAssistantMsg(msg) {
  if (typeof msg.content === 'string') {
    return msg.content ? { role: 'assistant', content: msg.content } : null;
  }
  if (!Array.isArray(msg.content)) {
    const c = String(msg.content || '');
    return c ? { role: 'assistant', content: c } : null;
  }

  const textBlocks = msg.content.filter(b => b.type === 'text' || b.type === 'thinking');
  const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');

  const textContent = textBlocks
    .map(b => b.type === 'thinking' ? (b.thinking || '') : (b.text || ''))
    .filter(Boolean).join('\n') || null;

  if (toolUseBlocks.length === 0) {
    return textContent ? { role: 'assistant', content: textContent } : null;
  }

  return {
    role: 'assistant',
    content: textContent,  // null 时 OpenAI 接受
    tool_calls: toolUseBlocks.map(tu => ({
      id: tu.id || `call_${Date.now().toString(36)}`,
      type: 'function',
      function: {
        name: tu.name,
        arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
      },
    })),
  };
}

/** 将一条 Anthropic user 消息转为 OpenAI 消息列表（tool_result → tool role） */
function convertAnthropicUserMsg(msg) {
  if (typeof msg.content === 'string') {
    return msg.content ? [{ role: 'user', content: msg.content }] : [];
  }
  if (!Array.isArray(msg.content)) {
    const c = String(msg.content || '');
    return c ? [{ role: 'user', content: c }] : [];
  }

  const result = [];
  const toolResults = msg.content.filter(b => b.type === 'tool_result');
  const textParts = msg.content.filter(b => b.type === 'text');

  for (const tr of toolResults) {
    const content = typeof tr.content === 'string' ? tr.content
      : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n') : '';
    result.push({ role: 'tool', tool_call_id: tr.tool_use_id || 'unknown', content: content || '' });
  }

  const textContent = textParts.map(b => b.text || '').join('\n');
  if (textContent) result.push({ role: 'user', content: textContent });

  return result;
}

function anthropicToOpenAIMessages(anthropicSystem, anthropicMessages) {
  const messages = [];
  if (anthropicSystem) {
    const sysText = typeof anthropicSystem === 'string'
      ? anthropicSystem
      : (Array.isArray(anthropicSystem) ? anthropicSystem.map(b => b.text || '').join('\n') : '');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const msg of anthropicMessages || []) {
    if (msg.role === 'assistant') {
      const m = convertAnthropicAssistantMsg(msg);
      if (m) messages.push(m);
    } else {
      const ms = convertAnthropicUserMsg(msg);
      messages.push(...ms);
    }
  }
  return messages;
}

function openaiToAnthropicResponse(openaiResp, requestModel) {
  const choice = openaiResp.choices?.[0] || {};
  const content = [];

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const tc of (choice.message?.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${Date.now().toString(36)}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const stop_reason = choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';

  return {
    id: `msg_${openaiResp.id || Date.now().toString(36)}`,
    type: 'message', role: 'assistant', model: requestModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function normalizeOpenAIToolName(name) {
  let value = String(name || '');
  if (!value) return value;

  let changed = true;
  while (changed && value.length > 1) {
    changed = false;
    if (value.length % 2 !== 0) break;
    const half = value.length / 2;
    const left = value.slice(0, half);
    const right = value.slice(half);
    if (left && left === right) {
      value = left;
      changed = true;
    }
  }

  return value;
}

function mergeOpenAIToolName(currentName, nextChunk) {
  const current = normalizeOpenAIToolName(currentName);
  const next = normalizeOpenAIToolName(nextChunk);

  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  return normalizeOpenAIToolName(current + next);
}

function streamOpenAIToAnthropic(res, stream, requestModel) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  sendSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant',
      model: requestModel, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let outputTokens = 0, buffer = '';
  let textBlockStarted = false;
  let nextBlockIndex = 0;
  // Map<openaiToolIndex, { id, name, anthropicIndex, started }>
  const toolBlocks = new Map();
  let finishReason = null;

  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        flushAndFinishAnthropic(res, outputTokens, textBlockStarted, toolBlocks, finishReason);
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        finishReason = choice.finish_reason || finishReason;
        const delta = choice.delta || {};

        // 文本内容
        if (delta.content) {
          if (!textBlockStarted) {
            sendSSE(res, 'content_block_start', {
              type: 'content_block_start', index: nextBlockIndex,
              content_block: { type: 'text', text: '' },
            });
            textBlockStarted = true;
            nextBlockIndex++;
          }
          outputTokens++;
          sendSSE(res, 'content_block_delta', {
            type: 'content_block_delta', index: nextBlockIndex - 1,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        // 工具调用
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index ?? 0;
            if (!toolBlocks.has(tcIdx)) {
              const anthropicIdx = nextBlockIndex++;
              toolBlocks.set(tcIdx, {
                id: tc.id || `toolu_${Date.now().toString(36)}_${tcIdx}`,
                name: tc.function?.name || '',
                anthropicIndex: anthropicIdx,
                started: false,
              });
            }
            const block = toolBlocks.get(tcIdx);
            if (tc.id) block.id = tc.id;
            if (tc.function?.name) {
              block.name = mergeOpenAIToolName(block.name, tc.function.name);
            }

            // 拿到 name 之后才能发 content_block_start
            if (!block.started && block.name) {
              block.started = true;
              sendSSE(res, 'content_block_start', {
                type: 'content_block_start', index: block.anthropicIndex,
                content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
              });
            }

            if (tc.function?.arguments && block.started) {
              outputTokens++;
              sendSSE(res, 'content_block_delta', {
                type: 'content_block_delta', index: block.anthropicIndex,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              });
            }
          }
        }
      } catch { /* ignore */ }
    }
  });
  stream.on('end', () => {
    if (!res.writableEnded) flushAndFinishAnthropic(res, outputTokens, textBlockStarted, toolBlocks, finishReason);
  });
  stream.on('error', (err) => {
    log.error('代理流错误', { error: err.message });
    if (!res.writableEnded) { sendSSE(res, 'error', { type: 'error', error: { message: err.message } }); res.end(); }
  });
}

function flushAndFinishAnthropic(res, outputTokens, textBlockStarted, toolBlocks, finishReason) {
  if (res.writableEnded) return;

  let blocksClosed = 0;
  if (textBlockStarted) {
    sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: blocksClosed });
    blocksClosed++;
  }
  for (const [, block] of toolBlocks) {
    if (block.started) {
      sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: block.anthropicIndex });
    }
  }

  // 保底：如果一个块都没开，补一个空文本块（防止 Claude Code 解析出错）
  if (!textBlockStarted && toolBlocks.size === 0) {
    sendSSE(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  }

  const stopReason = finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'length' ? 'max_tokens' : 'end_turn';

  sendSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sendSSE(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ═══════════════════════════════════════════════════════════════════════
//  OpenAI / Anthropic 流式透传
// ═══════════════════════════════════════════════════════════════════════

function streamPassthrough(res, stream, contentType) {
  res.setHeader('Content-Type', contentType || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  stream.pipe(res);
}

// ═══════════════════════════════════════════════════════════════════════
//  Router — 按 clientProtocol × upstreamProtocol 分发
// ═══════════════════════════════════════════════════════════════════════

function createProxyRouter({ proxyConfigStore }) {
  const router = Router();

  /** 获取某个 CLI 的活跃 provider 配置 */
  function getActive(cliId) {
    return proxyConfigStore.getActiveProvider(cliId);
  }

  function requireProvider(cliId, cliLabel, res) {
    const p = getActive(cliId);
    if (!p || !p.apiBase || !p.apiKey) {
      errResponse(res, 503, `1Shell 代理未配置 ${cliLabel} 的 API，请在接入页「⚙ 配置」中添加 Provider`, 'anthropic');
      return null;
    }
    return p;
  }

  // ─── Claude Code 端点 (clientProtocol = anthropic) ──────────────────

  async function handleAnthropicClient(cliId, cliLabel, req, res) {
    const provider = requireProvider(cliId, cliLabel, res);
    if (!provider) return;

    const body = req.body || {};
    const isStream = body.stream === true;
    const upstream = provider.upstreamProtocol || 'openai';

    if (upstream === 'anthropic') {
      // 透传到 Anthropic API
      try {
        const upResp = await callAnthropicUpstream(provider.apiBase, provider.apiKey, body);
        if (isStream) {
          streamPassthrough(res, upResp.body, 'text/event-stream');
        } else {
          const data = await upResp.json();
          res.status(upResp.status).json(data);
        }
      } catch (err) {
        log.error(`${cliLabel} Anthropic 透传失败`, { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'anthropic');
      }
    } else {
      // upstream = openai → 转换 Anthropic → OpenAI
      const targetModel = provider.model || 'gpt-4o';
      const openaiTools = convertAnthropicToolsToOpenAI(body.tools);
      const openaiBody = {
        model: targetModel,
        messages: anthropicToOpenAIMessages(body.system, body.messages),
        max_tokens: body.max_tokens || 4096,
        stream: isStream,
      };
      if (body.temperature != null) openaiBody.temperature = body.temperature;
      if (body.top_p != null) openaiBody.top_p = body.top_p;
      if (openaiTools && openaiTools.length > 0) {
        openaiBody.tools = openaiTools;
        openaiBody.tool_choice = 'auto';
      }
      try {
        const upResp = await callOpenAIUpstream(provider.apiBase, provider.apiKey, openaiBody);
        if (!upResp.ok) {
          const errText = await upResp.text().catch(() => '');
          return errResponse(res, upResp.status, `上游 API 返回 ${upResp.status}: ${errText.substring(0, 500)}`, 'anthropic');
        }
        if (isStream) {
          streamOpenAIToAnthropic(res, upResp.body, body.model || targetModel);
        } else {
          const data = await upResp.json();
          res.json(openaiToAnthropicResponse(data, body.model || targetModel));
        }
      } catch (err) {
        log.error(`${cliLabel} 代理请求失败`, { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'anthropic');
      }
    }
  }

  router.post('/claude/v1/messages', (req, res) => handleAnthropicClient('claude-code', 'Claude Code', req, res));

  // ─── Skill Runner 专用端点 ─────────────────────────────────────────
  //   Skill SDK 模式下的内部回环调用。读 'skills' 槽位的 provider，
  //   未配置时回退到 'claude-code' 的 provider，实现"零配置开箱可用"。
  async function handleSkillsClient(req, res) {
    const active = proxyConfigStore.getActiveProvider('skills')
                || proxyConfigStore.getActiveProvider('claude-code');
    if (!active || !active.apiBase || !active.apiKey) {
      return errResponse(res, 503, '1Shell Skill Runner 未配置 Provider，请在"接入"页给 Claude Code 或 Skills 添加 Provider', 'anthropic');
    }

    const body = req.body || {};
    const isStream = body.stream === true;
    const upstream = active.upstreamProtocol || 'openai';

    if (upstream === 'anthropic') {
      try {
        // 若请求体包含 mcp_servers，自动附带 mcp-client beta header
        const extra = {};
        if (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0) {
          extra['anthropic-beta'] = 'mcp-client-2025-04-04';
        }
        const upResp = await callAnthropicUpstream(active.apiBase, active.apiKey, body, extra);
        if (isStream) {
          streamPassthrough(res, upResp.body, 'text/event-stream');
        } else {
          const data = await upResp.json();
          res.status(upResp.status).json(data);
        }
      } catch (err) {
        log.error('Skill Runner Anthropic 透传失败', { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'anthropic');
      }
    } else {
      const targetModel = active.model || 'gpt-4o';
      const openaiTools = convertAnthropicToolsToOpenAI(body.tools);
      const openaiBody = {
        model: targetModel,
        messages: anthropicToOpenAIMessages(body.system, body.messages),
        max_tokens: body.max_tokens || 4096,
        stream: isStream,
      };
      if (body.temperature != null) openaiBody.temperature = body.temperature;
      if (body.top_p != null) openaiBody.top_p = body.top_p;
      if (openaiTools && openaiTools.length > 0) {
        openaiBody.tools = openaiTools;
        openaiBody.tool_choice = 'auto';
      }
      try {
        const upResp = await callOpenAIUpstream(active.apiBase, active.apiKey, openaiBody);
        if (!upResp.ok) {
          const errText = await upResp.text().catch(() => '');
          return errResponse(res, upResp.status, `上游 API 返回 ${upResp.status}: ${errText.substring(0, 500)}`, 'anthropic');
        }
        if (isStream) {
          streamOpenAIToAnthropic(res, upResp.body, body.model || targetModel);
        } else {
          const data = await upResp.json();
          res.json(openaiToAnthropicResponse(data, body.model || targetModel));
        }
      } catch (err) {
        log.error('Skill Runner 代理请求失败', { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'anthropic');
      }
    }
  }

  router.post('/skills/v1/messages', handleSkillsClient);

  router.get('/claude/v1/models', (_req, res) => {
    res.json({ data: [
      { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', created_at: '2025-05-14' },
      { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', created_at: '2025-05-14' },
      { id: 'claude-haiku-4-20250514', display_name: 'Claude Haiku 4', created_at: '2025-05-14' },
    ] });
  });

  // ─── Codex / OpenCode 端点 (clientProtocol = openai) ────────────────

  async function handleOpenAIClient(cliId, cliLabel, req, res) {
    const provider = requireProvider(cliId, cliLabel, res);
    if (!provider) return;

    const body = req.body || {};
    const isStream = body.stream === true;
    const upstream = provider.upstreamProtocol || 'openai';

    if (upstream === 'openai') {
      // 透传
      if (provider.model) body.model = provider.model;
      try {
        const upResp = await callOpenAIUpstream(provider.apiBase, provider.apiKey, { ...body, stream: isStream });
        if (!upResp.ok) {
          const errText = await upResp.text().catch(() => '');
          return errResponse(res, upResp.status, `上游 API 返回 ${upResp.status}: ${errText.substring(0, 500)}`, 'openai');
        }
        if (isStream) { streamPassthrough(res, upResp.body); } else { res.json(await upResp.json()); }
      } catch (err) {
        log.error(`${cliLabel} 透传失败`, { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'openai');
      }
    } else if (upstream === 'anthropic') {
      // OpenAI request → 转换为 Anthropic → 调上游 → 转回 OpenAI
      const system = (body.messages || []).filter(m => m.role === 'system').map(m => m.content || '').join('\n') || undefined;
      const anthropicTools = convertOpenAIToolsToAnthropic(body.tools);
      const anthropicBody = {
        model: provider.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
        system,
        messages: openaiMessagesToAnthropic(body.messages),
        stream: isStream,
      };
      if (body.temperature != null) anthropicBody.temperature = body.temperature;
      if (body.top_p != null) anthropicBody.top_p = body.top_p;
      if (anthropicTools && anthropicTools.length > 0) anthropicBody.tools = anthropicTools;
      try {
        const upResp = await callAnthropicUpstream(provider.apiBase, provider.apiKey, anthropicBody);
        if (!upResp.ok) {
          const errText = await upResp.text().catch(() => '');
          return errResponse(res, upResp.status, `上游 Anthropic API 返回 ${upResp.status}: ${errText.substring(0, 500)}`, 'openai');
        }
        if (isStream) {
          streamAnthropicToOpenAI(res, upResp.body);
        } else {
          const data = await upResp.json();
          res.json(anthropicToOpenAIResponse(data));
        }
      } catch (err) {
        log.error(`${cliLabel} Anthropic 转换失败`, { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'openai');
      }
    } else {
      errResponse(res, 400, `不支持的 upstreamProtocol: ${upstream}`, 'openai');
    }
  }

  router.post('/codex/v1/chat/completions', (req, res) => handleOpenAIClient('codex', 'Codex', req, res));
  router.post('/opencode/v1/chat/completions', (req, res) => handleOpenAIClient('opencode', 'OpenCode', req, res));

  // ─── Codex Responses API 端点 (wire_api = responses) ───────────────
  //   Codex v0.120+ 强制使用 Responses API，不再支持 wire_api="chat"。
  //   当上游也是 OpenAI 兼容时直接透传；上游是 Anthropic 时暂不支持。

  async function handleResponsesClient(cliId, cliLabel, req, res) {
    const provider = requireProvider(cliId, cliLabel, res);
    if (!provider) return;

    const body = req.body || {};
    const isStream = body.stream === true;
    const upstream = provider.upstreamProtocol || 'openai';

    if (upstream !== 'openai') {
      return errResponse(res, 400, `Responses API 目前仅支持 OpenAI 兼容上游，当前上游协议: ${upstream}`, 'openai');
    }

    if (provider.model) body.model = provider.model;
    try {
      const upResp = await callOpenAIResponsesUpstream(provider.apiBase, provider.apiKey, body);
      if (!upResp.ok) {
        const errText = await upResp.text().catch(() => '');
        return errResponse(res, upResp.status, `上游 API 返回 ${upResp.status}: ${errText.substring(0, 500)}`, 'openai');
      }
      if (isStream) {
        streamPassthrough(res, upResp.body);
      } else {
        res.json(await upResp.json());
      }
    } catch (err) {
      log.error(`${cliLabel} Responses API 透传失败`, { error: err.message });
      errResponse(res, 502, `代理请求失败: ${err.message}`, 'openai');
    }
  }

  router.post('/codex/v1/responses', (req, res) => handleResponsesClient('codex', 'Codex', req, res));
  router.post('/codex/responses', (req, res) => handleResponsesClient('codex', 'Codex', req, res));
  router.post('/opencode/v1/responses', (req, res) => handleResponsesClient('opencode', 'OpenCode', req, res));
  router.post('/opencode/responses', (req, res) => handleResponsesClient('opencode', 'OpenCode', req, res));
  router.get('/codex/v1/models', (_req, res) => proxyModelsList('codex', res));
  router.get('/opencode/v1/models', (_req, res) => proxyModelsList('opencode', res));

  function proxyModelsList(cliId, res) {
    const p = getActive(cliId);
    const model = p?.model || 'gpt-4o';
    res.json({ object: 'list', data: [{ id: model, object: 'model', owned_by: '1shell-proxy' }] });
  }

  // ─── 兼容旧路径 /v1/messages → Claude ──────────────────────────────
  router.post('/v1/messages', (req, res) => handleAnthropicClient('claude-code', 'Claude Code', req, res));
  router.get('/v1/models', (_req, res) => {
    res.json({ data: [
      { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', created_at: '2025-05-14' },
      { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', created_at: '2025-05-14' },
    ] });
  });

  return router;
}

// ═══════════════════════════════════════════════════════════════════════
//  Anthropic → OpenAI 反向转换 (给 Codex/OpenCode 调 Anthropic 上游)
// ═══════════════════════════════════════════════════════════════════════

function anthropicToOpenAIResponse(anthropicResp) {
  const content = anthropicResp.content || [];
  const text = content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  const toolUseBlocks = content.filter(b => b.type === 'tool_use');

  const message = { role: 'assistant', content: text || null };
  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map(tu => {
      const args = typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {});
      return {
        id: tu.id || `call_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: tu.name, arguments: args },
      };
    });
  }
  if (!text && toolUseBlocks.length === 0) message.content = '';

  const finish_reason = anthropicResp.stop_reason === 'tool_use' ? 'tool_calls'
    : anthropicResp.stop_reason === 'max_tokens' ? 'length' : 'stop';

  return {
    id: `chatcmpl-${anthropicResp.id || Date.now().toString(36)}`,
    object: 'chat.completion',
    model: anthropicResp.model || 'unknown',
    choices: [{ index: 0, message, finish_reason }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  };
}

function streamAnthropicToOpenAI(res, stream) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let buffer = '';
  // Map<anthropicBlockIndex, { id, name, openaiIndex }>
  const toolBlocks = new Map();
  let nextToolCallIndex = 0;

  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          const cb = parsed.content_block;
          const openaiIdx = nextToolCallIndex++;
          toolBlocks.set(parsed.index, { id: cb.id, name: cb.name, openaiIndex: openaiIdx });
          res.write(`data: ${JSON.stringify({
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {
              tool_calls: [{ index: openaiIdx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }],
            }, finish_reason: null }],
          })}\n\n`);

        } else if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
            res.write(`data: ${JSON.stringify({
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: parsed.delta.text }, finish_reason: null }],
            })}\n\n`);
          } else if (parsed.delta?.type === 'input_json_delta') {
            const block = toolBlocks.get(parsed.index);
            if (block) {
              res.write(`data: ${JSON.stringify({
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {
                  tool_calls: [{ index: block.openaiIndex, function: { arguments: parsed.delta.partial_json || '' } }],
                }, finish_reason: null }],
              })}\n\n`);
            }
          }

        } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
          const fr = parsed.delta.stop_reason === 'tool_use' ? 'tool_calls'
            : parsed.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
          res.write(`data: ${JSON.stringify({
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: fr }],
          })}\n\n`);

        } else if (parsed.type === 'message_stop') {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      } catch { /* ignore */ }
    }
  });
  stream.on('end', () => {
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
  stream.on('error', (err) => {
    log.error('Anthropic→OpenAI 流错误', { error: err.message });
    if (!res.writableEnded) res.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  Multi-Provider 配置持久化
// ═══════════════════════════════════════════════════════════════════════

function createProxyConfigStore(dataDir) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const configPath = path.join(dataDir, 'proxy-configs.json');

  function _readAll() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
  }
  function _writeAll(data) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  }
  function _ensureCli(all, cliId) {
    if (!all[cliId]) all[cliId] = { providers: [], activeProviderId: null };
    if (!Array.isArray(all[cliId].providers)) all[cliId].providers = [];
    return all[cliId];
  }

  function maskKey(key) {
    if (!key || key.length < 10) return '****';
    return key.substring(0, 5) + '…' + key.substring(key.length - 4);
  }

  function maskProvider(p) {
    return {
      id: p.id, name: p.name || '',
      apiBase: p.apiBase || '',
      apiKey: p.apiKey ? maskKey(p.apiKey) : '',
      apiKeySet: Boolean(p.apiKey),
      model: p.model || '',
      upstreamProtocol: p.upstreamProtocol || 'openai',
    };
  }

  /** 列出某 CLI 的所有 Provider（脱敏） */
  function listProviders(cliId) {
    const cli = _readAll()[cliId];
    if (!cli) return { providers: [], activeProviderId: null };
    return {
      providers: (cli.providers || []).map(maskProvider),
      activeProviderId: cli.activeProviderId,
    };
  }

  /** 获取某 CLI 的活跃 Provider（原始，含 apiKey） */
  function getActiveProvider(cliId) {
    const cli = _readAll()[cliId];
    if (!cli || !cli.providers?.length) return null;
    const active = cli.providers.find(p => p.id === cli.activeProviderId);
    return active || cli.providers[0];
  }

  /** 添加 Provider，返回新 ID */
  function addProvider(cliId, data) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const id = crypto.randomBytes(4).toString('hex');
    const provider = {
      id,
      name: data.name || `Provider ${cli.providers.length + 1}`,
      apiBase: (data.apiBase || '').trim(),
      apiKey: (data.apiKey || '').trim(),
      model: (data.model || '').trim(),
      upstreamProtocol: data.upstreamProtocol || 'openai',
    };
    cli.providers.push(provider);
    if (!cli.activeProviderId) cli.activeProviderId = id;
    _writeAll(all);
    return id;
  }

  /** 更新 Provider */
  function updateProvider(cliId, providerId, partial) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const p = cli.providers.find(x => x.id === providerId);
    if (!p) return false;
    if (typeof partial.name === 'string') p.name = partial.name.trim();
    if (typeof partial.apiBase === 'string') p.apiBase = partial.apiBase.trim();
    if (typeof partial.apiKey === 'string') p.apiKey = partial.apiKey.trim();
    if (typeof partial.model === 'string') p.model = partial.model.trim();
    if (typeof partial.upstreamProtocol === 'string') p.upstreamProtocol = partial.upstreamProtocol;
    _writeAll(all);
    return true;
  }

  /** 删除 Provider */
  function deleteProvider(cliId, providerId) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const idx = cli.providers.findIndex(x => x.id === providerId);
    if (idx === -1) return false;
    cli.providers.splice(idx, 1);
    if (cli.activeProviderId === providerId) {
      cli.activeProviderId = cli.providers[0]?.id || null;
    }
    _writeAll(all);
    return true;
  }

  /** 设为活跃 Provider */
  function setActive(cliId, providerId) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    if (!cli.providers.find(x => x.id === providerId)) return false;
    cli.activeProviderId = providerId;
    _writeAll(all);
    return true;
  }

  /** 获取所有 CLI 的摘要（前端 scan 用） */
  function getAllSummary() {
    const all = _readAll();
    const result = {};
    for (const [cliId, cli] of Object.entries(all)) {
      const active = (cli.providers || []).find(p => p.id === cli.activeProviderId) || (cli.providers || [])[0];
      result[cliId] = {
        providerCount: (cli.providers || []).length,
        activeProvider: active ? { name: active.name, model: active.model, upstreamProtocol: active.upstreamProtocol, apiKeySet: Boolean(active.apiKey) } : null,
      };
    }
    return result;
  }

  return { listProviders, getActiveProvider, addProvider, updateProvider, deleteProvider, setActive, getAllSummary, maskKey };
}

module.exports = { createProxyRouter, createProxyConfigStore };

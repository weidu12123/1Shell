'use strict';

const fetch = require('node-fetch');
const { validateChatMessages } = require('../utils/validators');

const {
  ENV_API_BASE,
  ENV_API_KEY,
  ENV_MODEL,
} = require('../config/env');

const COMPLETION_PROMPTS = Object.freeze({
  chat: '你是智能输入补全引擎。根据前缀预测并补全内容。只返回补全部分，不重复前缀，不加解释，不超过两句话。',
  command: '你是 Linux Shell 专家。根据自然语言描述返回完整可执行命令，只返回命令本身，无解释，无 markdown。危险命令前加 # DANGER: 注释。',
  terminalInline: '你是终端命令行内联补全引擎。用户正在 shell 中输入命令或参数。只返回当前光标后需要追加的补全文本（不含已有输入），不加解释，不换行，不加 markdown，不返回多条候选。补全应优先考虑常见 CLI 命令名（如 curl、grep、docker 等）或合法参数，而不是普通英文单词。若输入已是完整命令或不适合补全则返回空字符串。',
  generateScript: `你是 Linux 运维脚本专家。用户描述一个运维目标，你生成一个可复用的参数化 Bash 脚本。
返回纯 JSON（不加 markdown 包裹），格式如下：
{
  "name": "脚本名称（中文，简短）",
  "icon": "一个 emoji 图标",
  "category": "system|docker|network|backup|security|other",
  "tags": ["标签1", "标签2"],
  "riskLevel": "safe|confirm|danger",
  "description": "一段描述，说明脚本的用途（30 字以内）",
  "content": "#!/bin/bash\\nset -e\\n# 脚本内容，使用 {{变量名}} 作为参数占位符",
  "parameters": [
    {"name": "变量名", "type": "string|number|boolean|select", "label": "参数显示名", "required": true, "default": "默认值"}
  ]
}
规则：
- content 中的参数一律用 {{name}} 形式引用，不要用 $1 或 $VAR 形式。
- content 中不要出现 \`\`\` 代码块标记。
- 脚本开头加 set -e，写好注释。
- 若涉及 rm -rf / shutdown / reboot 等操作，riskLevel 设为 danger。
- 若涉及 restart / stop 等操作，riskLevel 设为 confirm。
- 只输出纯 JSON，不加任何注释、markdown 或额外文字。`,
  analyzeSelection: `你是终端输出诊断专家。用户在终端中选中了一段文本，请分析并返回如下 JSON（无任何额外字段，无 markdown 包裹）：
{
  "summary": "一句话摘要，说明选中内容是什么（命令输出/错误/普通文本）",
  "errorType": "若识别为错误返回分类，如 permission_denied / command_not_found / oom / network_error / syntax_error / other，否则返回 null",
  "fixSuggestion": "若有修复建议返回可执行命令字符串（仅命令本身），否则返回 null",
  "riskLevel": "若 fixSuggestion 非 null，返回 safe / caution / danger，否则返回 null"
}
规则：
- summary 必须是字符串，不超过 30 字。
- 若无法判断错误类型，errorType 返回 null。
- fixSuggestion 只返回单条命令，不加解释，不加 markdown，不带换行。
- riskLevel=danger 仅用于 rm -rf / dd / mkfs / shutdown 等破坏性命令。
- 只输出纯 JSON，不加任何注释或包裹。`,
});

const INLINE_COMPLETION_TIMEOUT_MS = 7000;

function createAIService({ fetchImpl = fetch } = {}) {
  function resolveConfig(body = {}) {
    let rawBase = (body.apiBase || ENV_API_BASE) + '';
    // 自动补 /v1 后缀（兼容 One-API / New-API 等中转站）
    if (rawBase && !/\/v1$/.test(rawBase)) {
      rawBase = rawBase.replace(/\/$/, '') + '/v1';
    }
    return {
      base: rawBase.replace(/\/$/, ''),
      key: body.apiKey || ENV_API_KEY,
      model: body.model || ENV_MODEL,
    };
  }

  function extractTextContent(content) {
    if (typeof content === 'string') {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
      .trim();
  }

  async function requestChatCompletionText({
    base,
    key,
    maxTokens,
    messages,
    model,
    retryCount = 2,
    temperature,
  }) {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: false,
          }),
        });

        if (!response.ok) {
          continue;
        }

        const data = await response.json();
        const message = data.choices?.[0]?.message || {};
        const text = extractTextContent(message.content);

        if (text) {
          return text;
        }

        if (message.content == null && attempt + 1 < retryCount) {
          continue;
        }

        return '';
      } catch {
        if (attempt + 1 >= retryCount) {
          return '';
        }
      }
    }

    return '';
  }

  async function createChatUpstream(body = {}) {
    validateChatMessages(body.messages);
    const { base, key, model } = resolveConfig(body);
    return fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        stream: true,
      }),
    });
  }

  async function requestCompletion(body = {}) {
    const prefix = String(body.prefix || '');
    if (prefix.trim().length < 3) return '';

    const mode = body.mode || 'chat';
    const { base, key, model } = resolveConfig(body);

    const request = async () => {
      return requestChatCompletionText({
        base,
        key,
        model,
        messages: [
          { role: 'system', content: COMPLETION_PROMPTS[mode] || COMPLETION_PROMPTS.chat },
          { role: 'user', content: prefix },
        ],
        maxTokens: 120,
        temperature: 0.2,
      });
    };

    return Promise.race([
      request(),
      new Promise((resolve) => {
        setTimeout(() => resolve(''), 6000);
      }),
    ]);
  }

  async function requestTerminalInlineCompletion(body = {}) {
    const currentInput = String(body.currentInput || '');
    const cursorIndex = Number.isInteger(body.cursorIndex) ? body.cursorIndex : currentInput.length;
    const inputPrefix = currentInput.slice(0, cursorIndex);
    if (inputPrefix.trim().length < 3) {
      return {
        requestId: '',
        completion: '',
        confidence: 'low',
      };
    }

    const shellType = String(body.shellType || 'bash').trim() || 'bash';
    const platform = String(body.platform || '').trim();
    const cwd = String(body.cwd || '').trim();
    const recentCommands = Array.isArray(body.recentCommands)
      ? body.recentCommands.filter((item) => typeof item === 'string' && item.trim()).slice(-3).map((item) => item.slice(0, 200))
      : [];
    const { base, key, model } = resolveConfig(body);

    const prompt = [
      `shellType: ${shellType}`,
      platform ? `platform: ${platform}` : '',
      cwd ? `cwd: ${cwd}` : '',
      recentCommands.length ? `recentCommands: ${recentCommands.join(' | ')}` : '',
      `currentInput: ${inputPrefix}`,
    ].filter(Boolean).join('\n');

    const request = async () => {
      const raw = await requestChatCompletionText({
        base,
        key,
        model,
        messages: [
          { role: 'system', content: COMPLETION_PROMPTS.terminalInline },
          { role: 'user', content: prompt },
        ],
        maxTokens: 80,
        temperature: 0.15,
      });
      const completion = sanitizeInlineCompletion(raw, inputPrefix);
      return {
        requestId: createRequestId(),
        completion,
        confidence: completion ? classifyInlineConfidence(completion, inputPrefix) : 'low',
      };
    };

    return Promise.race([
      request(),
      new Promise((resolve) => {
        setTimeout(() => resolve({
          requestId: '',
          completion: '',
          confidence: 'low',
        }), INLINE_COMPLETION_TIMEOUT_MS);
      }),
    ]);
  }
  function classifyInlineConfidence(completion, inputPrefix) {
    if (!completion) return 'low';

    const completionText = String(completion);
    const prefixText = String(inputPrefix || '');
    if (completionText.length <= 4) return 'high';
    if (/^[\w./-]+$/u.test(completionText) && prefixText.trim()) return 'high';
    if (completionText.includes(' --') || completionText.includes(' -')) return 'medium';
    return 'medium';
  }

  function sanitizeInlineCompletion(raw, inputPrefix) {
    if (!raw) return '';

    let text = String(raw)
      .replace(/\r/g, '')
      .replace(/^```[\w-]*\s*/u, '')
      .replace(/\s*```$/u, '')
      .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '')
      .split('\n')[0]
      .replace(/\s+$/u, '');

    if (!text.trim()) return '';
    if (text.startsWith(inputPrefix)) {
      text = text.slice(inputPrefix.length);
    }

    text = text
      .replace(/^[:：\-\s]+/u, '')
      .replace(/[。；;，,]+$/u, '')
      .replace(/\s{2,}/gu, ' ');

    if (!text.trim() || /[`]/.test(text)) return '';
    if (/^(补全|建议|command|completion)[:：]/iu.test(text)) return '';
    return text;
  }

  const VALID_RISK_LEVELS = new Set(['safe', 'caution', 'danger']);
  const VALID_ERROR_TYPES = new Set([
    'permission_denied', 'command_not_found', 'oom', 'network_error', 'syntax_error', 'other',
  ]);

  function parseAnalyzeSelectionResponse(raw) {
    const fallback = {
      summary: '无法解析分析结果',
      errorType: null,
      fixSuggestion: null,
      riskLevel: null,
    };

    if (!raw) return fallback;

    try {
      const jsonText = raw
        .replace(/^```(?:json)?\s*/u, '')
        .replace(/\s*```$/u, '')
        .trim();
      const parsed = JSON.parse(jsonText);

      const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 60)
        : '无摘要';

      const errorType = typeof parsed.errorType === 'string' && VALID_ERROR_TYPES.has(parsed.errorType)
        ? parsed.errorType
        : null;

      const fixSuggestion = typeof parsed.fixSuggestion === 'string' && parsed.fixSuggestion.trim()
        ? parsed.fixSuggestion.trim().split('\n')[0].trim()
        : null;

      const riskLevel = fixSuggestion && typeof parsed.riskLevel === 'string' && VALID_RISK_LEVELS.has(parsed.riskLevel)
        ? parsed.riskLevel
        : (fixSuggestion ? 'caution' : null);

      return { summary, errorType, fixSuggestion, riskLevel };
    } catch {
      return fallback;
    }
  }

  async function analyzeSelection(body = {}) {
    const selectedText = String(body.selectedText || '').trim();
    if (!selectedText) {
      return { summary: '选区为空', errorType: null, fixSuggestion: null, riskLevel: null };
    }

    const shellType = String(body.shellType || 'bash').trim() || 'bash';
    const platform = String(body.platform || '').trim();
    const recentCommands = Array.isArray(body.recentCommands)
      ? body.recentCommands.filter((item) => typeof item === 'string' && item.trim()).slice(-3).map((item) => item.slice(0, 200))
      : [];
    const { base, key, model } = resolveConfig(body);

    const contextLines = [
      `shellType: ${shellType}`,
      platform ? `platform: ${platform}` : '',
      recentCommands.length ? `recentCommands: ${recentCommands.join(' | ')}` : '',
      `selectedText:\n${selectedText.slice(0, 2000)}`,
    ].filter(Boolean).join('\n');

    const request = async () => {
      const raw = await requestChatCompletionText({
        base,
        key,
        model,
        messages: [
          { role: 'system', content: COMPLETION_PROMPTS.analyzeSelection },
          { role: 'user', content: contextLines },
        ],
        maxTokens: 300,
        temperature: 0.1,
        retryCount: 2,
      });
      return parseAnalyzeSelectionResponse(raw);
    };

    return Promise.race([
      request(),
      new Promise((resolve) => {
        setTimeout(() => resolve({
          summary: '分析超时',
          errorType: null,
          fixSuggestion: null,
          riskLevel: null,
        }), 10000);
      }),
    ]);
  }

  function createRequestId() {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async function fetchModelList(body = {}) {
    const { base, key } = resolveConfig(body);
    const paths = ['/models', '/models'];
    for (const p of paths) {
      try {
        const res = await fetchImpl(`${base}${p}`, {
          headers: { Authorization: `Bearer ${key}` },
          timeout: 8000,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.data && Array.isArray(data.data)) {
            return data.data.map((m) => m.id).filter(Boolean);
          }
        }
      } catch { /* try next */ }
    }
    return [];
  }

  async function generateScript(body = {}) {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      return { error: '请描述你想要的脚本' };
    }

    const { base, key, model } = resolveConfig(body);

    const raw = await requestChatCompletionText({
      base,
      key,
      model,
      messages: [
        { role: 'system', content: COMPLETION_PROMPTS.generateScript },
        { role: 'user', content: prompt },
      ],
      maxTokens: 2000,
      temperature: 0.3,
      retryCount: 2,
    });

    if (!raw) {
      return { error: 'AI 未返回有效内容，请检查 API 配置或重试' };
    }

    try {
      const jsonText = raw
        .replace(/^```(?:json)?\s*/u, '')
        .replace(/\s*```$/u, '')
        .trim();
      const parsed = JSON.parse(jsonText);

      // 基本校验
      if (!parsed.name || !parsed.content) {
        return { error: 'AI 返回的脚本结构不完整，请重试' };
      }

      return {
        script: {
          name: String(parsed.name).slice(0, 120),
          icon: String(parsed.icon || '📜').slice(0, 4),
          category: ['system', 'docker', 'network', 'backup', 'security', 'other'].includes(parsed.category) ? parsed.category : 'other',
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 10) : [],
          riskLevel: ['safe', 'confirm', 'danger'].includes(parsed.riskLevel) ? parsed.riskLevel : 'safe',
          description: String(parsed.description || '').slice(0, 2000),
          content: String(parsed.content),
          parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
        },
      };
    } catch {
      return { error: 'AI 返回的 JSON 格式异常，请重试' };
    }
  }

  return {
    createChatUpstream,
    fetchModelList,
    generateScript,
    requestCompletion,
    requestTerminalInlineCompletion,
    analyzeSelection,
  };
}

module.exports = {
  createAIService,
};

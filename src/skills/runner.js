'use strict';

/**
 * Skill Runner — 基于 Anthropic Messages API 的 Skill 执行引擎。
 *
 * 不再通过 spawn Claude Code CLI + PTY + TUI 抓屏。
 * 改为直接 loop-back 到本地 /api/proxy/skills/v1/messages 端点，
 * 以标准 tool-use 模式驱动一个有限步骤的 agent loop。
 *
 * 工具集：
 *   - execute_command: 在目标主机（SSH 或本机）上执行 shell 命令
 *   - render_result:   向前端推送结构化结果卡片（table / keyvalue / message / list）
 *   - ask_user:        向前端发出交互请求（select / confirm / input），等待用户回复
 *
 * 事件（通过 socket 发出，前端订阅）：
 *   skill:run-started  — 任务开始
 *   skill:thinking     — 开始本轮模型调用
 *   skill:thought      — 模型返回了 assistant 文本（可选展示）
 *   skill:exec         — 调用 execute_command，参数
 *   skill:exec-result  — execute_command 执行完成
 *   skill:render       — render_result 触发，携带结构化渲染数据
 *   skill:ask          — ask_user 触发，等待前端通过 skill:continue 回复
 *   skill:done         — 任务结束（end_turn）
 *   skill:error        — 任务异常
 *   skill:cancelled    — 任务被用户取消
 */

const fs = require('fs');
const path = require('path');
const { exec: childExec } = require('child_process');
const fetch = require('node-fetch');

const { parseFrontmatter } = require('./registry');
const { ROOT_DIR } = require('../config/env');
const { loadPlaybook } = require('./playbook-schema');
const { createPlaybookExecutor } = require('./playbook-executor');
const { createRescuer } = require('./rescuer');

const MAX_TURNS = 50;
const DEFAULT_EXEC_TIMEOUT_MS = 30000;

// ─── Tool schemas (Anthropic Messages API 格式) ──────────────────────────

const TOOLS = [
  {
    name: 'execute_command',
    description:
      '在目标主机上执行一条非交互式 shell 命令，返回 stdout/stderr/exitCode 的文本。注意：' +
      '\n- 不要使用交互式命令（如 vim、top 无 -n 1）' +
      '\n- 包管理器请加 -y 参数' +
      '\n- 长时间命令（docker pull / apt install / 大文件下载等）请把 timeout 设为 120000 或更大' +
      '\n- 默认在绑定主机上执行；若需要在其他已托管主机上执行（如探测 VPS），通过 host_id 指定' +
      '\n- 绝对禁止在命令里使用 ssh/scp 去连接主机——直接写命令本身即可',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000，耗时命令可设大' },
        host_id: { type: 'string', description: '（可选）在指定主机上执行；省略则在绑定主机上执行' },
      },
      required: ['command'],
    },
  },
  {
    name: 'render_result',
    description:
      '把一个阶段性结果以结构化方式推给用户前端。这是用户看到成果的唯一方式——' +
      '**不要只把结果放在 assistant 文本里**，必须通过本工具渲染。' +
      '支持四种 format：table（表格）/ keyvalue（详情卡）/ list（列表）/ message（提示消息）。',
    input_schema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['table', 'keyvalue', 'list', 'message'],
          description: '渲染格式',
        },
        title: { type: 'string', description: '卡片标题' },
        subtitle: { type: 'string', description: '副标题 / 摘要说明' },
        level: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: '语义级别，影响配色。默认 info',
        },
        // table
        columns: {
          type: 'array',
          description: '(table) 列名数组',
          items: { type: 'string' },
        },
        rows: {
          type: 'array',
          description: '(table) 二维字符串数组；每行长度应与 columns 相同',
          items: { type: 'array', items: { type: 'string' } },
        },
        rowActions: {
          type: 'array',
          description:
            '(table) 每行操作按钮列表，如 [{"label":"删除","value":"delete"}]。' +
            '点击后前端自动以第一列值 + action value 调用 rowActionSkill。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        rowActionSkill: {
          type: 'string',
          description:
            '(table) 点击 rowActions 按钮时要调用的 Skill ID。' +
            '前端会以 { action: <value>, <rowInputKey>: <第一列值> } 作为 inputs 启动该 Skill。',
        },
        rowInputKey: {
          type: 'string',
          description:
            '(table) 第一列值传给 rowActionSkill 时的 input 参数名（默认 "container"）。' +
            '例如网站表格用 "domain"，主机表格用 "hostId"。',
        },
        // keyvalue
        items: {
          type: 'array',
          description: '(keyvalue) [{"key":"名称","value":"nginx"}] 形式',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        // list
        listItems: {
          type: 'array',
          description: '(list) 列表项 [{"title":"...","description":"..."}]',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        // message
        content: { type: 'string', description: '(message) 纯文本内容' },
      },
      required: ['format'],
    },
  },
  {
    name: 'ask_user',
    description:
      '向用户提问以继续任务。使用场景：' +
      '\n- 需要用户从多个候选中挑一个（如"要查看哪个容器的日志？"）' +
      '\n- 危险操作前的二次确认（如"确认删除容器？"）' +
      '\n- 需要用户补充输入（如"输入新的端口号"）' +
      '\n返回值为 JSON 字符串：select 返回 {value, label}，confirm 返回 {confirmed:bool}，input 返回 {value}。',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['select', 'confirm', 'input'],
          description: '交互类型',
        },
        title: { type: 'string', description: '问题标题' },
        description: { type: 'string', description: '问题补充说明（可选）' },
        options: {
          type: 'array',
          description:
            '(select) 候选项 [{"value":"nginx","label":"nginx","description":"..."}]',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        danger: {
          type: 'boolean',
          description: '(confirm) 是否危险操作，影响按钮配色',
        },
        confirmLabel: { type: 'string', description: '(confirm) 确认按钮文案，默认"确定"' },
        cancelLabel: { type: 'string', description: '(confirm) 取消按钮文案，默认"取消"' },
        placeholder: { type: 'string', description: '(input) 输入框占位文本' },
        defaultValue: { type: 'string', description: '(input) 预填值' },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'write_local_file',
    description:
      '将文本内容写入 1Shell 宿主机（本机）的文件系统。' +
      '路径白名单：data/skills/ (Skill/Rescue Skill)、data/playbooks/ (Playbook)、data/programs/ (Program)。' +
      '用于创建或更新产物文件（SKILL.md、workflow/*.md、rules/*.md、playbook.yaml、program.yaml 等）。' +
      '自动创建父目录。**创建或修改这三类产物时必须用此工具，不要用 execute_command + node 写文件。**',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对于 1Shell 根目录的路径，如 data/skills/my-skill/SKILL.md、data/programs/my-prog/program.yaml',
        },
        content: {
          type: 'string',
          description: '文件的完整内容（UTF-8 字符串）',
        },
        mkdir: {
          type: 'boolean',
          description: '是否自动创建父目录，默认 true',
        },
      },
      required: ['path', 'content'],
    },
  },
];

// ─── Prompt 构造 ────────────────────────────────────────────────────────

function buildSystemPrompt(skill, host, remoteHosts = [], rules = '') {
  const hostDesc = host.id === 'local'
    ? '1Shell 本机（通过 child_process 执行）'
    : `${host.name} (${host.username || 'root'}@${host.host}:${host.port || 22})`;

  const skillsAbsPath    = path.join(ROOT_DIR, 'data', 'skills').replace(/\\/g, '/');
  const playbooksAbsPath = path.join(ROOT_DIR, 'data', 'playbooks').replace(/\\/g, '/');
  const rootAbsPath      = ROOT_DIR.replace(/\\/g, '/');

  const localPathNote = host.id === 'local'
    ? [
        `- **路径说明（重要）**：本机命令的工作目录固定为 \`${rootAbsPath}\`。`,
        `  - Skill 文件目录：\`data/skills/<skill-id>/\`（绝对路径：\`${skillsAbsPath}/<skill-id>/\`）`,
        `  - Playbook 文件目录：\`data/playbooks/<playbook-id>/\`（绝对路径：\`${playbooksAbsPath}/<playbook-id>/\`）`,
        `  - **禁止使用 $HOME 拼接路径。**`,
        `  - **宿主机为 Windows，execute_command 在 Windows cmd/PowerShell 环境下运行，没有 ls/grep/cat 等 Unix 命令。**`,
        `    不要用 ls 检查目录是否存在，直接用 write_local_file 写入文件（会自动创建父目录）。`,
      ].join('\n')
    : null;

  const lines = [
    `你是 1Shell 的运维 AI Agent。你正在通过工具调用完成一个结构化的 Skill 任务。`,
    ``,
    `## 目标主机`,
    `- 名称: ${hostDesc}`,
    `- hostId: \`${host.id}\``,
    `- 你调用 execute_command 时不需要指定主机，所有命令自动在上述主机上执行。`,
    localPathNote,
    ``,
    `## 工具使用原则（非常重要）`,
    `- **execute_command**: 执行非交互式 shell 命令。包管理器一律加 -y，长耗时命令请主动把 timeout 设大。**绝对禁止**在命令里使用 ssh/scp/sftp——直接写命令本身即可。` +
      (remoteHosts.length > 0
        ? `\n  默认在本机执行（写文件用）；若需探测/操作远端 VPS，传 host_id 参数路由到对应主机。`
        : ''),
    remoteHosts.length > 0
      ? [`## 可用远端主机（探测时通过 host_id 路由）`,
          ...remoteHosts.map(h => `- \`${h.id}\` · ${h.name} (${h.username || 'root'}@${h.host}:${h.port || 22})`),
         ``].join('\n')
      : null,
    IS_WINDOWS && host.id === 'local'
      ? `  ⚠️ **本机为 Windows**：execute_command 在 Windows cmd 下执行。` +
        `**命令和参数中只能使用 ASCII 字符（英文）**，绝对不要在命令参数里使用中文或其他非 ASCII 字符，否则会乱码。` +
        `探测或调试时用 \`echo test\` 而非 \`echo 中文\`。` +
        `没有 ls/grep/cat/find；目录检查请直接用 write_local_file（自动创建父目录）。`
      : null,
    `- **write_local_file**: 将内容写入 1Shell 本机（宿主机）的文件系统，路径限定在 data/skills/ 或 data/playbooks/ 目录内。创建或修改 Skill / Playbook 文件时必须用此工具，不要用 execute_command + node/echo 写文件。自动创建父目录，无需提前 mkdir。`,
    `- **render_result**: 每完成一个阶段性成果就调用本工具推给前端。用户看不到 assistant 文本——只有 render_result 的内容才会显示。` +
      `\n  table 格式支持行操作按钮：rowActions（按钮定义）+ rowActionSkill（点击后运行哪个 Skill）+ rowInputKey（第一列值的参数名，如 "domain"/"container"）。`,
    `- **ask_user**: 需要用户选择、确认或补充输入时调用，不要替用户做决定。`,
    ``,
    `## 响应风格`,
    `- 极简，不要啰嗦解释过程。`,
    `- 一次响应中可以并行调用多个工具。`,
    `- 任务完成后用一句话简短收尾即可。`,
    ``,
    `## 通用红线（绝对禁止）`,
    `- 不得操作名称包含 "1shell" 的容器/服务/文件`,
    `- 不得修改 /etc/ssh/ 下任何文件，不得修改 sshd_config`,
    `- 不得执行 rm -rf /、dd、mkfs 等可能破坏系统的命令`,
  ];

  // ── Skill 自带的 rules/ 作为硬约束注入（不是参考资料，是必须遵守的规则）──
  if (rules && rules.trim()) {
    lines.push(
      ``,
      `---`,
      ``,
      `## 本 Skill 的硬约束（rules/ — 必须全部遵守，优先级高于 workflow）`,
      ``,
      rules.trim(),
    );
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * 读 Skill 的 rules/*.md 合并为一份硬约束文本，注入 system prompt。
 * 与 loadSkillDocs 分离：rules 是给 AI 看的"法律"，workflows/references 是"操作手册"。
 */
function loadSkillRules(skillDir) {
  const rulesDir = path.join(skillDir, 'rules');
  if (!fs.existsSync(rulesDir)) return '';
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort();
  const parts = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(rulesDir, file), 'utf8');
    parts.push(`### ${file}\n\n${content}`);
  }
  return parts.join('\n\n');
}

function loadSkillDocs(skillDir) {
  const parts = [];

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const { body } = parseFrontmatter(raw);
    parts.push(`# SKILL.md\n\n${body}`);
  }

  // 注意：rules 已经通过 loadSkillRules → system prompt 注入，这里不再重复
  for (const subdir of ['workflows', 'references']) {
    const dir = path.join(skillDir, subdir);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      parts.push(`## ${subdir}/${file}\n\n${content}`);
    }
  }

  return parts.join('\n\n---\n\n');
}

function buildUserMessage(skill, inputs, skillRegistry) {
  const inputsSummary = skillRegistry.renderInputsSummary(skill, inputs);
  const docs = loadSkillDocs(skill.dir);

  // 加载 SKILL.md frontmatter 里声明的 referencedSkills 的 docs
  const refDocs = [];
  for (const refId of (skill.referencedSkills || [])) {
    const refSkill = skillRegistry.getSkill?.(refId);
    if (refSkill?.dir) {
      const d = loadSkillDocs(refSkill.dir);
      if (d) refDocs.push(`## 引用 Skill: ${refSkill.name || refId} (\`${refId}\`)\n\n${d}`);
    }
  }

  const parts = [
    `请执行以下 Skill 任务。`,
    ``,
    inputsSummary,
    ``,
    `---`,
    ``,
    docs,
  ];

  if (refDocs.length > 0) {
    parts.push(``, `---`, ``, `## 引用 Skill（可在执行中参考其规则与工作流）`, ...refDocs);
  }

  parts.push(
    ``,
    `---`,
    ``,
    `请按 SKILL.md 的 Common Tasks 路由选择合适的 workflow，` +
    `严格遵守 rules，完成后用 render_result 展示结构化成果。` +
    `若中途需要用户选择或确认，用 ask_user。`,
  );

  return parts.join('\n');
}

// ─── Anthropic SSE 流解析 → 完整 message 对象 ────────────────────────────────
//
// Anthropic SSE 格式：
//   event: message_start        → { message: { id, model, usage, ... } }
//   event: content_block_start  → { index, content_block: { type, text|id|name|input } }
//   event: content_block_delta  → { index, delta: { type, text|partial_json } }
//   event: content_block_stop   → { index }
//   event: message_delta        → { delta: { stop_reason, stop_sequence }, usage }
//   event: message_stop         → {}
//   event: error                → { error: { type, message } }
//
// 若上游是 OpenAI（经 proxy 转换为 Anthropic SSE），格式相同。
//
function parseAnthropicSSE(stream) {
  return new Promise((resolve, reject) => {
    const blocks = [];          // content blocks，按 index 索引
    let stopReason = 'end_turn';
    let stopSeq = null;
    let modelId = '';
    let inputTokens = 0, outputTokens = 0;
    let buffer = '';

    function processLine(line) {
      if (!line.startsWith('data: ')) return;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') return;
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

      if (!evt.type) return;

      if (evt.type === 'error') {
        reject(new Error(evt.error?.message || 'SSE error'));
        return;
      }
      if (evt.type === 'message_start') {
        modelId = evt.message?.model || modelId;
        inputTokens = evt.message?.usage?.input_tokens || 0;
        outputTokens = evt.message?.usage?.output_tokens || 0;
        return;
      }
      if (evt.type === 'content_block_start') {
        const cb = evt.content_block || {};
        blocks[evt.index] = {
          type: cb.type,
          // text block
          text: cb.text || '',
          // tool_use block
          id: cb.id || '',
          name: cb.name || '',
          _inputJson: '',
        };
        return;
      }
      if (evt.type === 'content_block_delta') {
        const blk = blocks[evt.index];
        if (!blk) return;
        const d = evt.delta || {};
        if (d.type === 'text_delta') blk.text += d.text || '';
        if (d.type === 'input_json_delta') blk._inputJson += d.partial_json || '';
        return;
      }
      if (evt.type === 'content_block_stop') {
        const blk = blocks[evt.index];
        if (blk && blk._inputJson) {
          try { blk.input = JSON.parse(blk._inputJson); } catch { blk.input = {}; }
          delete blk._inputJson;
        }
        return;
      }
      if (evt.type === 'message_delta') {
        stopReason = evt.delta?.stop_reason || stopReason;
        stopSeq    = evt.delta?.stop_sequence || stopSeq;
        outputTokens = evt.usage?.output_tokens || outputTokens;
        return;
      }
      if (evt.type === 'message_stop') {
        // 流结束，整理 content
        const content = blocks
          .filter(Boolean)
          .map(blk => {
            if (blk.type === 'text') return { type: 'text', text: blk.text };
            if (blk.type === 'tool_use') return { type: 'tool_use', id: blk.id, name: blk.name, input: blk.input || {} };
            return blk;
          });
        resolve({
          type: 'message',
          role: 'assistant',
          model: modelId,
          content,
          stop_reason: stopReason,
          stop_sequence: stopSeq,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
      }
    }

    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    stream.on('end', () => {
      // 若 message_stop 没收到（异常截断），尝试用已收集的数据构造
      // resolve 只会被调用一次
      const content = blocks.filter(Boolean).map(blk => {
        if (blk.type === 'text') return { type: 'text', text: blk.text };
        if (blk.type === 'tool_use') {
          let input = blk.input;
          if (!input && blk._inputJson) {
            try { input = JSON.parse(blk._inputJson); } catch { input = {}; }
          }
          return { type: 'tool_use', id: blk.id, name: blk.name, input: input || {} };
        }
        return blk;
      });
      resolve({
        type: 'message',
        role: 'assistant',
        model: modelId,
        content,
        stop_reason: stopReason,
        stop_sequence: stopSeq,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    });

    stream.on('error', reject);
  });
}

// ─── 命令执行（SSH / 本地） ─────────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32';

// Windows GBK → UTF-8 转换（iconv-lite 可选；无则降级用 latin1 替换）
let iconvLite = null;
try { iconvLite = require('iconv-lite'); } catch { /* optional dep */ }

function decodeWindowsOutput(buf) {
  if (!buf || !buf.length) return '';
  if (iconvLite) {
    try { return iconvLite.decode(buf, 'gbk'); } catch { /* fall through */ }
  }
  // 无 iconv-lite：把 GBK 双字节序列替换为 ? 避免乱码
  return buf.toString('utf8').replace(/\uFFFD/g, '?');
}

function execLocal(command, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS);
  const startAt = Date.now();
  return new Promise((resolve) => {
    // Windows：不指定 encoding，拿 Buffer 再自行解码（默认 GBK）
    const opts = {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      cwd: ROOT_DIR,
      ...(IS_WINDOWS ? {} : { encoding: 'utf8' }),
    };
    childExec(command, opts, (err, stdout, stderr) => {
      const decodeOut = IS_WINDOWS
        ? decodeWindowsOutput(stdout)
        : (stdout || '');
      const decodeErr = IS_WINDOWS
        ? decodeWindowsOutput(stderr)
        : (stderr || '');
      resolve({
        stdout: decodeOut,
        stderr: decodeErr || (err && !decodeErr ? String(err.message || '') : ''),
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        durationMs: Date.now() - startAt,
      });
    });
  });
}

function formatExecResult({ stdout, stderr, exitCode, durationMs }) {
  const parts = [];
  const trimmedStdout = (stdout || '').trimEnd();
  const trimmedStderr = (stderr || '').trimEnd();
  if (trimmedStdout) parts.push(`[stdout]\n${trimmedStdout}`);
  if (trimmedStderr) parts.push(`[stderr]\n${trimmedStderr}`);
  if (!trimmedStdout && !trimmedStderr) parts.push('[stdout] (空)');
  parts.push(`[exitCode] ${exitCode}`);
  parts.push(`[durationMs] ${durationMs}`);
  return parts.join('\n\n');
}

/**
 * 把内部 mcpServers 归一化对象转成 Anthropic Messages API 的 mcp_servers 入参格式。
 * 参考：https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector
 */
function toAnthropicMcp(s) {
  const out = { type: 'url', url: s.url, name: s.name };
  if (s.authToken) out.authorization_token = s.authToken;
  if (s.tool_configuration) out.tool_configuration = s.tool_configuration;
  return out;
}

// ─── Runner Factory ─────────────────────────────────────────────────────

function createSkillRunner({
  bridgeService,
  hostService,
  skillRegistry,
  proxyConfigStore,
  port,
  auditService,
  logger,
  onFileWritten,   // 可选回调：write_local_file 成功后调用，用于触发 registry reload
}) {
  // runId → { socket, cancelled, pendingAsk:{toolUseId, resolve, reject} }
  const activeRuns = new Map();

  // L2 AI Rescuer（在 verify 失败时介入，最小 token 消耗）
  const rescuer = createRescuer({
    bridgeService,
    hostService,
    proxyConfigStore,
    port,
    logger,
    skillRegistry,
  });

  // L1 确定性执行器（供 playbook.yaml 型 Skill 使用）
  const playbookExecutor = createPlaybookExecutor({
    bridgeService,
    hostService,
    auditService,
    rescuer,
    logger,
  });

  async function run({ socket, runId, skillId, hostId, inputs = {}, rescuerSkillId = '' }) {
    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      socket.emit('skill:error', { runId, error: `Skill 不存在: ${skillId}` });
      return;
    }

    // forceLocal: true 的 Skill 永远在本机执行（如 skill-authoring 写本地文件）
    const effectiveHostId = skill.forceLocal ? 'local' : hostId;

    const host = hostService.findHost(effectiveHostId) || (effectiveHostId === 'local' ? { id: 'local', name: '本机' } : null);
    if (!host) {
      socket.emit('skill:error', { runId, error: `主机不存在: ${effectiveHostId}` });
      return;
    }

    if (skill.forceLocal && hostId !== 'local') {
      // 告知前端实际运行在本机
      socket.emit('skill:info', { runId, message: `「${skill.name}」固定在本机执行（与目标主机选择无关）` });
    }

    // ─── 分流规则（硬边界）────────────────────────────────────────
    //   kind='skill'    → 永远走 AI-Loop。Skill 是"给 AI 读的能力包"，
    //                     即使目录下有 playbook.yaml 也**绝不**绕开 AI。
    //                     （registry 已拒载 skills 下带 playbook.yaml 的目录，
    //                      这里的守卫是二次保障。）
    //   kind='playbook' → 有 playbook.yaml 走 L1 确定性执行，失败由 L2 Rescuer 接管；
    //                     无 playbook.yaml 退回 AI-Loop。
    if (skill.kind === 'playbook' && skill.hasPlaybook) {
      let playbook;
      try {
        playbook = loadPlaybook(skill.dir);
      } catch (err) {
        socket.emit('skill:error', { runId, error: `Playbook 解析失败: ${err.message}` });
        return;
      }
      if (!playbook) {
        socket.emit('skill:error', { runId, error: 'Playbook 文件存在但加载失败' });
        return;
      }

      // 运行时 Rescue Skill 覆盖（优先级：runtime > playbook frontmatter）
      const override = String(rescuerSkillId || '').trim();
      if (override) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(override)) {
          socket.emit('skill:error', { runId, error: `Rescue Skill id 不合法: ${override}` });
          return;
        }
        playbook.rescuer_skill = override;
        socket.emit('skill:info', {
          runId,
          message: `🛟 运行时指定 Rescue Skill: ${override}（覆盖 Playbook 默认）`,
        });
      }

      return playbookExecutor.run({ socket, runId, skill, playbook, hostId: effectiveHostId, inputs });
    }

    // ─── Skill 或无 playbook.yaml 的 Playbook → AI-Loop ───

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider || !provider.apiBase || !provider.apiKey) {
      socket.emit('skill:error', {
        runId,
        error: 'Skill Provider 未配置。请先在"接入"页给 Claude Code 添加 Provider。',
      });
      return;
    }

    // 远程 MCP 仅在 Anthropic 上游（Messages API + mcp-client beta）下可用
    const mcpServers = Array.isArray(skill.mcpServers) ? skill.mcpServers : [];
    const upstream = provider.upstreamProtocol || 'openai';
    if (mcpServers.length > 0 && upstream !== 'anthropic') {
      socket.emit('skill:error', {
        runId,
        error: `此 Skill 声明了 ${mcpServers.length} 个 MCP server，但当前 Provider 上游为 ${upstream}。请切换到 Anthropic 直连上游后重试。`,
      });
      return;
    }

    const runState = {
      socket, cancelled: false, pendingAsk: null, abortController: null,
      meta: {
        runId, itemId: skillId, itemName: skill.name, itemKind: skill.kind || 'skill',
        mode: 'ai-loop',
        hostId: effectiveHostId, hostName: host.name,
        startedAt: Date.now(),
      },
    };
    activeRuns.set(runId, runState);

    socket.emit('skill:run-started', {
      runId,
      skillId,
      hostId: effectiveHostId,
      hostName: host.name,
      provider: { model: provider.model || '', name: provider.name || '' },
    });

    auditService?.log?.({
      action: 'skill_run_start',
      source: 'skill',
      hostId: effectiveHostId,
      hostName: host.name,
      skillId,
    });

    // skill-authoring 在本机运行但需要知道可用远端主机（用于 host_id 路由探测）
    const remoteHosts = skill.forceLocal
      ? (hostService.listHosts?.() || []).filter(h => h.id !== 'local')
      : [];

    // 加载 rules（硬约束）— 合并本 Skill + 所有 referencedSkills 的 rules
    const ruleParts = [];
    const selfRules = loadSkillRules(skill.dir);
    if (selfRules) ruleParts.push(selfRules);
    for (const refId of (skill.referencedSkills || [])) {
      const refSkill = skillRegistry.getSkill?.(refId);
      if (refSkill?.dir) {
        const r = loadSkillRules(refSkill.dir);
        if (r) ruleParts.push(`### 引用 Skill: ${refSkill.name || refId}\n\n${r}`);
      }
    }
    const rules = ruleParts.join('\n\n');

    const system = buildSystemPrompt(skill, host, remoteHosts, rules);
    const messages = [{ role: 'user', content: buildUserMessage(skill, inputs, skillRegistry) }];
    const model = provider.model || 'claude-sonnet-4-20250514';
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;

    // SSH 连接预热：避免第一条命令因建连耗时而超时
    // 连接建立后会被复用，后续命令无需重新握手
    if (effectiveHostId !== 'local') {
      try {
        await bridgeService.execOnHost(effectiveHostId, 'echo 1', 15000, { source: 'skill-warmup' });
      } catch { /* 预热失败静默忽略，不影响 Skill 执行 */ }
    }

    let turn = 0;
    let finalReason = 'end_turn';

    try {
      while (!runState.cancelled && turn < MAX_TURNS) {
        turn++;
        socket.emit('skill:thinking', { runId, turn });

        // ── 以流式（SSE）方式调用 proxy，彻底消除 504 网关超时 ──────────
        let data;
        try {
          const ac = new AbortController();
          runState.abortController = ac;
          const reqBody = JSON.stringify({
            model,
            max_tokens: 8192,
            stream: true,
            system,
            messages,
            tools: TOOLS,
            ...(mcpServers.length > 0 ? { mcp_servers: mcpServers.map(toAnthropicMcp) } : {}),
          });

          const resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: reqBody,
            signal: ac.signal,
          });
          runState.abortController = null;

          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
          }

          // 解析 Anthropic SSE 流 → 还原成完整 message 对象
          data = await parseAnthropicSSE(resp.body);

        } catch (err) {
          runState.abortController = null;
          if (err.name === 'AbortError' || runState.cancelled) break;
          throw new Error(`调用 Provider 失败: ${err.message}`);
        }

        if (data.type === 'error') {
          throw new Error(data.error?.message || 'Provider 返回错误');
        }

        const content = Array.isArray(data.content) ? data.content : [];
        messages.push({ role: 'assistant', content });

        // 推送 text 块（让用户看到 AI 的简短叙述）
        for (const block of content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            socket.emit('skill:thought', { runId, text: block.text });
          }
        }

        if (data.stop_reason === 'end_turn') { finalReason = 'end_turn'; break; }
        if (data.stop_reason !== 'tool_use') { finalReason = data.stop_reason || 'stopped'; break; }

        const toolUses = content.filter((b) => b.type === 'tool_use');
        const toolResults = [];
        for (const tu of toolUses) {
          if (runState.cancelled) break;
          const result = await runTool(tu, { runId, hostId: effectiveHostId, runState });
          toolResults.push(result);
        }

        if (runState.cancelled) break;
        messages.push({ role: 'user', content: toolResults });
      }

      if (runState.cancelled) {
        socket.emit('skill:cancelled', { runId });
        auditService?.log?.({ action: 'skill_run_cancel', source: 'skill', skillId, hostId });
      } else if (turn >= MAX_TURNS) {
        socket.emit('skill:error', { runId, error: `任务超出最大轮次 (${MAX_TURNS})，已终止` });
        auditService?.log?.({ action: 'skill_run_truncated', source: 'skill', skillId, hostId });
      } else {
        socket.emit('skill:done', { runId, reason: finalReason, turns: turn });
        auditService?.log?.({ action: 'skill_run_done', source: 'skill', skillId, hostId, turns: turn });
      }
    } catch (err) {
      logger?.error?.('Skill 执行异常', { runId, skillId, error: err.message });
      socket.emit('skill:error', { runId, error: err.message });
      auditService?.log?.({
        action: 'skill_run_error',
        source: 'skill',
        skillId,
        hostId,
        error: err.message,
      });
    } finally {
      activeRuns.delete(runId);
    }
  }

  async function runTool(tu, ctx) {
    const { name, input = {}, id } = tu;
    const { runId, hostId, runState } = ctx;

    try {
      if (name === 'execute_command') {
        return await handleExec(runId, hostId, id, input, runState);
      }
      if (name === 'write_local_file') {
        return await handleWriteLocalFile(runId, id, input, runState);
      }
      if (name === 'render_result') {
        runState.socket.emit('skill:render', { runId, toolUseId: id, payload: input });
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'OK - card rendered to user. Continue with next step.',
        };
      }
      if (name === 'ask_user') {
        runState.socket.emit('skill:ask', { runId, toolUseId: id, payload: input });
        const answer = await new Promise((resolve, reject) => {
          runState.pendingAsk = { toolUseId: id, resolve, reject };
        });
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: typeof answer === 'string' ? answer : JSON.stringify(answer),
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: `Unknown tool: ${name}`,
        is_error: true,
      };
    } catch (err) {
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: `Tool execution failed: ${err.message}`,
        is_error: true,
      };
    }
  }

  async function handleExec(runId, hostId, toolUseId, input, runState) {
    const command = String(input.command || '').trim();
    const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : DEFAULT_EXEC_TIMEOUT_MS;

    // AI 可以通过 host_id 指定在其他已托管主机上运行（如探测 VPS）
    const targetHostId = input.host_id ? String(input.host_id).trim() : hostId;

    if (!command) {
      runState.socket.emit('skill:exec-result', {
        runId, toolUseId, error: 'empty command', durationMs: 0,
      });
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: '[ERROR] command 参数为空',
        is_error: true,
      };
    }

    runState.socket.emit('skill:exec', { runId, toolUseId, command, timeout, hostId: targetHostId });

    let result;
    try {
      if (targetHostId === 'local') {
        result = await execLocal(command, timeout);
      } else {
        result = await bridgeService.execOnHost(targetHostId, command, timeout, { source: 'skill' });
      }
    } catch (err) {
      runState.socket.emit('skill:exec-result', {
        runId, toolUseId, error: err.message, durationMs: 0,
      });
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `[ERROR] ${err.message}`,
        is_error: true,
      };
    }

    runState.socket.emit('skill:exec-result', {
      runId,
      toolUseId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: formatExecResult(result),
      is_error: result.exitCode !== 0,
    };
  }

  /**
   * write_local_file — 始终写入本机（1Shell 宿主）的文件系统。
   * 路径限制在 data/skills/ / data/playbooks/ / data/programs/ 内，防止越权写入系统文件。
   */
  async function handleWriteLocalFile(runId, toolUseId, input, runState) {
    const rawPath = String(input.path || '').trim();
    const content = input.content != null ? String(input.content) : '';
    const mkdir   = input.mkdir !== false; // 默认 true

    if (!rawPath) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: '[ERROR] path 参数为空',
        is_error: true,
      };
    }

    // 安全：允许写入 data/skills/、data/playbooks/、data/programs/ 下的文件
    const skillsDir    = path.join(ROOT_DIR, 'data', 'skills');
    const playbooksDir = path.join(ROOT_DIR, 'data', 'playbooks');
    const programsDir  = path.join(ROOT_DIR, 'data', 'programs');
    const resolved     = path.resolve(ROOT_DIR, rawPath);
    const underSkills    = resolved.startsWith(skillsDir + path.sep) || resolved === skillsDir;
    const underPlaybooks = resolved.startsWith(playbooksDir + path.sep) || resolved === playbooksDir;
    const underPrograms  = resolved.startsWith(programsDir + path.sep) || resolved === programsDir;
    if (!underSkills && !underPlaybooks && !underPrograms) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `[ERROR] 路径越界：write_local_file 只能写入 data/skills/、data/playbooks/ 或 data/programs/ 目录内（收到: ${rawPath}）`,
        is_error: true,
      };
    }

    try {
      if (mkdir) {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
      }
      fs.writeFileSync(resolved, content, 'utf8');

      const relPath = path.relative(ROOT_DIR, resolved).replace(/\\/g, '/');
      runState.socket.emit('skill:info', { runId, message: `📄 写入: ${relPath}` });

      // 写入后触发 registry reload，让剧本库立即可见新增 Playbook
      if (typeof onFileWritten === 'function') {
        try { onFileWritten(relPath); } catch { /* reload 失败不影响主流程 */ }
      }

      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `OK — 文件已写入: ${relPath} (${Buffer.byteLength(content, 'utf8')} bytes)`,
      };
    } catch (err) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `[ERROR] 写入失败: ${err.message}`,
        is_error: true,
      };
    }
  }

  function continueRun({ runId, toolUseId, answer }) {
    const state = activeRuns.get(runId);
    if (!state || !state.pendingAsk) return false;
    if (state.pendingAsk.toolUseId !== toolUseId) return false;
    const { resolve } = state.pendingAsk;
    state.pendingAsk = null;
    resolve(answer);
    return true;
  }

  function cancelRun(runId) {
    // 同时取消 playbook 模式的 run
    playbookExecutor.cancelRun(runId);
    const state = activeRuns.get(runId);
    if (!state) return;
    state.cancelled = true;
    // 中断正在等待的 API 调用
    if (state.abortController) {
      try { state.abortController.abort(); } catch { /* ignore */ }
      state.abortController = null;
    }
    if (state.pendingAsk) {
      const { reject } = state.pendingAsk;
      state.pendingAsk = null;
      reject(new Error('Cancelled by user'));
    }
  }

  function cancelAllForSocket(socketId) {
    playbookExecutor.cancelAllForSocket(socketId);
    for (const [runId, state] of activeRuns) {
      if (state.socket?.id === socketId) {
        state.cancelled = true;
        if (state.abortController) {
          try { state.abortController.abort(); } catch { /* ignore */ }
          state.abortController = null;
        }
        if (state.pendingAsk) {
          const { reject } = state.pendingAsk;
          state.pendingAsk = null;
          reject(new Error('Socket disconnected'));
        }
        activeRuns.delete(runId);
      }
    }
  }

  function listActiveRuns() {
    const aiRuns = [...activeRuns.entries()].map(([runId, s]) => ({
      runId,
      ...(s.meta || {}),
      socketId: s.socket?.id,
    }));
    const pbRuns = (playbookExecutor.listActiveRuns?.() || []).map(r =>
      typeof r === 'string' ? { runId: r, mode: 'playbook' } : r
    );
    return [...aiRuns, ...pbRuns];
  }

  return { run, continueRun, cancelRun, cancelAllForSocket, listActiveRuns };
}

module.exports = { createSkillRunner, parseAnthropicSSE };
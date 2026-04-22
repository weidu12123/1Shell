'use strict';

const fetch = require('node-fetch');
const { parseAnthropicSSE } = require('../skills/runner');

/**
 * IDE Service — 自由对话模式的创作引擎
 *
 * 与 Skill Runner 的根本区别：
 *   - system prompt 极简，不注入任何 Skill 的 rules/workflows
 *   - 对话历史持久保留，支持多轮迭代
 *   - 工具集更广（read_file / list_artifacts / trigger_program / query_format 等）
 *   - 用户是对话主体，AI 响应用户指令而非自驱执行
 */
function createIdeService({ ideTools, proxyConfigStore, port, hostService, auditService, logger }) {

  // sessionId → { messages[], system, hostId, abortController }
  const sessions = new Map();

  const SYSTEM_PROMPT = `你是 1Shell IDE 创作助手。你通过工具调用帮用户在真实主机上完成运维任务、创建和迭代 1Shell 产物。

## 你是谁
你运行在 1Shell 平台内部，拥有对已托管主机的完整 SSH 执行权限和对 1Shell 产物文件系统的读写权限。

## 核心认知：1Shell 的三种产物

### Skill（AI 能力包）
Skill 是**文件夹，不是文件**。结构：
  data/skills/<skill-id>/
    SKILL.md              — 路由中心（≤100 行），只做导航不做百科
    rules/                — 硬约束（安全红线、禁止操作），AI 执行时不可违反
    workflows/            — 软规则（执行步骤），AI 可读取并按需修订
    references/           — 参考资料（领域知识、命令模板），按需加载

四类内容**严格分离**，不混写。
SKILL.md 的 description 是触发条件（最重要），Always Read + Common Tasks 是路由表。
不确定格式时调用 query_format("skill") 获取完整规范。

### Playbook（确定性剧本）
  data/playbooks/<id>/
    SKILL.md + playbook.yaml + rules/ + workflows/
playbook.yaml 存在时走 L1 确定性执行器（零 token），失败才唤醒 L2 AI Rescuer。
不确定格式时调用 query_format("playbook")。

### Program（长驻守护程序）
  data/programs/<id>/program.yaml
由 triggers(cron/manual) 驱动，在绑定主机上持续运行。
步骤失败且 on_fail=escalate 时唤醒 L3 Guardian AI 自愈。
不确定格式时调用 query_format("program")。

## 工作原则
- 用户告诉你需求，你**自行判断**应该创建哪种产物，不要反问"你想创建 Skill 还是 Playbook"
- 创建产物前先用 execute_command 探测目标主机环境（OS、已装软件、路径结构）
- 写完产物文件后调用 reload_registry 使其立即可见
- 可用 trigger_program 或 execute_command 直接测试刚创建的产物
- 用 list_artifacts 查看已有产物，用 read_file 读取并修改
- 格式不确定时用 query_format 按需查询，不要凭记忆猜

## 安全红线
- 禁止 rm -rf /、dd if=、mkfs、fork bomb、shutdown、reboot
- 禁止操作名称包含 "1shell" 的容器/服务/文件
- 禁止修改 /etc/ssh/ 下任何文件
- 破坏性操作执行前必须先告知用户`;

  function getOrCreateSession(sessionId, context) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);

    let contextBlock = '';
    if (context) {
      const parts = [];
      if (context.hosts?.length > 0) {
        parts.push('**目标主机**：');
        for (const h of context.hosts) {
          parts.push(`  - \`${h.id}\` · ${h.name || h.id} (${h.username || 'root'}@${h.host || '127.0.0.1'}:${h.port || 22})`);
        }
      }
      if (context.files?.length > 0) {
        parts.push('**相关文件**：');
        for (const f of context.files) parts.push(`  - hostId=\`${f.hostId}\` path=\`${f.path}\``);
      }
      if (context.containers?.length > 0) {
        parts.push('**相关容器**：');
        for (const c of context.containers) parts.push(`  - hostId=\`${c.hostId}\` name=\`${c.name || c.id}\`${c.image ? ` image=${c.image}` : ''}`);
      }
      if (context.mcpServers?.length > 0) {
        parts.push('**MCP Server**：');
        for (const s of context.mcpServers) parts.push(`  - \`${s.name}\` → ${s.url}`);
      }
      if (parts.length > 0) contextBlock = parts.join('\n') + '\n\n';
    }

    const session = {
      messages: [],
      system: SYSTEM_PROMPT,
      contextBlock,
      hostId: context?.hosts?.[0]?.id || 'local',
      abortController: null,
    };
    sessions.set(sessionId, session);
    return session;
  }

  async function handleMessage({ socket, sessionId, message, context }) {
    const session = getOrCreateSession(sessionId, context);

    const userContent = session.messages.length === 0 && session.contextBlock
      ? session.contextBlock + message
      : message;

    session.messages.push({ role: 'user', content: userContent });

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      socket.emit('ide:error', { sessionId, error: 'AI Provider 未配置。请先在"AI 配置"页添加 Provider。' });
      return;
    }

    const model = provider.model || 'claude-sonnet-4-20250514';
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;

    socket.emit('ide:thinking', { sessionId });

    auditService?.log?.({ action: 'ide_message', sessionId, message: message.substring(0, 500) });

    const MAX_TOOL_ROUNDS = 30;
    let round = 0;

    try {
      while (round < MAX_TOOL_ROUNDS) {
        round++;

        let data;
        try {
          const apiBody = JSON.stringify({
            model,
            max_tokens: 8192,
            stream: true,
            system: session.system,
            messages: session.messages,
            tools: ideTools.TOOL_SCHEMAS,
          });

          const MAX_RETRIES = 2;
          let lastErr;
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const ac = new AbortController();
            session.abortController = ac;
            try {
              const resp = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: apiBody,
                signal: ac.signal,
              });
              session.abortController = null;

              if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
              }

              data = await parseAnthropicSSE(resp.body);
              lastErr = null;
              break;
            } catch (retryErr) {
              session.abortController = null;
              if (retryErr.name === 'AbortError') throw retryErr;
              lastErr = retryErr;
              const isRetryable = /premature close|ECONNRESET|socket hang up|ETIMEDOUT/i.test(retryErr.message);
              if (!isRetryable || attempt >= MAX_RETRIES) throw retryErr;
              socket.emit('ide:text', { sessionId, text: `\n[连接中断，第 ${attempt + 1} 次重试...]\n` });
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
        } catch (err) {
          session.abortController = null;
          if (err.name === 'AbortError') {
            socket.emit('ide:cancelled', { sessionId });
            return;
          }
          throw err;
        }

        if (data.type === 'error') {
          throw new Error(data.error?.message || 'API error');
        }

        // 提取文本
        const textParts = data.content.filter(b => b.type === 'text').map(b => b.text);
        const toolCalls = data.content.filter(b => b.type === 'tool_use');

        if (textParts.length > 0) {
          socket.emit('ide:text', { sessionId, text: textParts.join('') });
        }

        // 追加 assistant 消息到历史
        session.messages.push({ role: 'assistant', content: data.content });

        if (toolCalls.length === 0 || data.stop_reason === 'end_turn') {
          socket.emit('ide:done', { sessionId, round });
          return;
        }

        // 执行工具调用
        const toolResults = [];
        for (const tc of toolCalls) {
          socket.emit('ide:tool-start', { sessionId, toolUseId: tc.id, name: tc.name, input: tc.input });

          const result = await ideTools.handle(tc.name, tc.input || {}, { socket, sessionId });

          socket.emit('ide:tool-end', {
            sessionId,
            toolUseId: tc.id,
            name: tc.name,
            result: result.content.substring(0, 4000),
            is_error: result.is_error,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: result.content,
            ...(result.is_error ? { is_error: true } : {}),
          });
        }

        session.messages.push({ role: 'user', content: toolResults });

        socket.emit('ide:thinking', { sessionId });
      }

      socket.emit('ide:error', { sessionId, error: `工具调用轮次过多 (${MAX_TOOL_ROUNDS})，已中断。` });
    } catch (err) {
      logger?.error?.('IDE 执行异常', { sessionId, error: err.message });
      socket.emit('ide:error', { sessionId, error: err.message });
    }
  }

  function cancelSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session?.abortController) {
      try { session.abortController.abort(); } catch { /* ignore */ }
      session.abortController = null;
    }
  }

  function deleteSession(sessionId) {
    cancelSession(sessionId);
    sessions.delete(sessionId);
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  return { handleMessage, cancelSession, deleteSession, hasSession };
}

module.exports = { createIdeService };
(() => {
  'use strict';

  function createAiChatModule({
    escapeHtml,
    getActiveHost,
    handleAuthExpired,
    showErrorMessage,
  }) {
    const clearChatBtnEl = document.getElementById('clear-chat-btn');
    const chatMessagesEl = document.getElementById('chat-messages');
    const chatInputEl = document.getElementById('chat-input');
    const sendBtnEl = document.getElementById('send-btn');
    const SYSTEM_PROMPT = '你是一位专业的 Linux / DevOps 终端助手。用户通过多主机 Web SSH 控制台操作服务器。回复时优先给出安全、可执行、简洁的建议。';
    const INTRO_MESSAGE = '已切换到多主机控制台。你可以询问当前主机的排障命令、巡检思路或脚本建议。';
    const conversationMap = new Map();
    let initialized = false;
    let isStreaming = false;

    function createConversationHistory() {
      return [{ role: 'system', content: SYSTEM_PROMPT }];
    }

    function getActiveHostKey() {
      return getActiveHost()?.id || 'local';
    }

    function getConversationHistory(hostKey = getActiveHostKey()) {
      if (!conversationMap.has(hostKey)) {
        conversationMap.set(hostKey, createConversationHistory());
      }
      return conversationMap.get(hostKey);
    }

    function renderMarkdown(text) {
      return escapeHtml(String(text || ''))
        .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
          const langAttr = lang ? ` data-lang="${lang}"` : '';
          return `<pre${langAttr}><code>${code.replace(/\n$/, '')}</code></pre>`;
        })
        .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/(^[ \t]*[-*+] .+(?:\n|$))+/gm, (list) => {
          const items = list
            .trim()
            .split(/\n/)
            .map((line) => line.replace(/^[ \t]*[-*+] (.+)$/, '<li>$1</li>'))
            .join('');
          return `<ul>${items}</ul>`;
        })
        .replace(/\n/g, '<br>');
    }

    function appendBubble(role, html) {
      const row = document.createElement('div');
      row.className = `message ${role}`;

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = role === 'user' ? '你' : 'AI';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = html;

      row.appendChild(avatar);
      row.appendChild(bubble);
      chatMessagesEl.appendChild(row);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      return bubble;
    }

    function renderConversation() {
      const history = getConversationHistory();
      const visibleMessages = history.filter((message) => message.role !== 'system');
      chatMessagesEl.innerHTML = '';

      if (!visibleMessages.length) {
        appendBubble('assistant', escapeHtml(INTRO_MESSAGE));
        return;
      }

      visibleMessages.forEach((message) => {
        if (message.role === 'user') {
          appendBubble('user', escapeHtml(message.displayContent || message.content));
          return;
        }
        appendBubble('assistant', renderMarkdown(message.content));
      });
    }

    function resetChat() {
      conversationMap.set(getActiveHostKey(), createConversationHistory());
      renderConversation();
    }

    function syncActiveHost() {
      renderConversation();
    }

    function setStreaming(flag) {
      isStreaming = flag;
      sendBtnEl.disabled = flag;
      sendBtnEl.textContent = flag ? '发送中…' : '发送';
    }

    async function sendMessage() {
      const userContent = chatInputEl.value.trim();
      if (!userContent || isStreaming) return;

      const host = getActiveHost();
      const conversationHistory = getConversationHistory();
      const upstreamContent = `[当前主机: ${host?.name || '未知'}]\n${userContent}`;
      conversationHistory.push({
        role: 'user',
        content: upstreamContent,
        displayContent: userContent,
      });
      appendBubble('user', escapeHtml(userContent));
      chatInputEl.value = '';
      setStreaming(true);

      const bubble = appendBubble('assistant', '思考中…');
      let fullReply = '';

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: conversationHistory.map(({ role, content }) => ({ role, content })),
          }),
        });

        if (response.status === 401) {
          const data = await response.json().catch(() => ({}));
          const message = data.error || '登录已失效，请重新登录';
          handleAuthExpired(message);
          throw new Error(message);
        }

        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || '聊天请求失败');
        }

        bubble.innerHTML = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            const raw = trimmed.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            const parsed = JSON.parse(raw);
            if (parsed.error) throw new Error(parsed.error);

            const delta = parsed?.choices?.[0]?.delta?.content;
            if (delta) {
              fullReply += delta;
              bubble.innerHTML = renderMarkdown(fullReply);
              chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
            }
          }
        }

        if (!fullReply) {
          bubble.textContent = '（无文字回复）';
        } else {
          conversationHistory.push({ role: 'assistant', content: fullReply });
        }
      } catch (error) {
        bubble.textContent = `请求失败：${error.message}`;
      } finally {
        setStreaming(false);
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      }
    }

    function initialize() {
      if (initialized) return;
      initialized = true;

      clearChatBtnEl.addEventListener('click', () => {
        resetChat();
      });
      sendBtnEl.addEventListener('click', () => {
        sendMessage().catch(showErrorMessage);
      });
      chatInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.ctrlKey) {
          event.preventDefault();
          sendMessage().catch(showErrorMessage);
        }
      });
    }

    return {
      initialize,
      resetChat,
      sendMessage,
      syncActiveHost,
    };
  }

  window.createAiChatModule = createAiChatModule;
})();

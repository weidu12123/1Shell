(() => {
  'use strict';

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

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
        const requestBody = {
          messages: conversationHistory.map(({ role, content }) => ({ role, content })),
        };

        // 附加自定义 API 配置
        const customConfig = window.__aiApiConfig || {};
        if (customConfig.apiBase) requestBody.apiBase = customConfig.apiBase;
        if (customConfig.apiKey) requestBody.apiKey = customConfig.apiKey;
        if (customConfig.model) requestBody.model = customConfig.model;

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify(requestBody),
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

      loadSavedConfig();

      clearChatBtnEl.addEventListener('click', () => {
        resetChat();
      });

      const apiConfigBtn = document.getElementById('ai-api-config-btn');
      if (apiConfigBtn) {
        apiConfigBtn.addEventListener('click', openApiConfigModal);
      }

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

    function loadSavedConfig() {
      try {
        const saved = localStorage.getItem('1shell-ai-config');
        if (saved) {
          const config = JSON.parse(saved);
          if (config.apiBase || config.apiKey || config.model) {
            window.__aiApiConfig = config;
          }
        }
      } catch { /* ignore */ }
    }

    function openApiConfigModal() {
      const modal = document.getElementById('ai-api-modal');
      const apiBaseEl = document.getElementById('ai-api-base');
      const apiKeyEl = document.getElementById('ai-api-key');
      const modelEl = document.getElementById('ai-model');
      const errorEl = document.getElementById('ai-api-error');
      if (!modal) return;

      const config = window.__aiApiConfig || {};
      apiBaseEl.value = config.apiBase || '';
      apiKeyEl.value = config.apiKey || '';
      modelEl.value = config.model || '';
      errorEl.textContent = '';
      modal.classList.remove('hidden');

      const form = document.getElementById('ai-api-form');
      const closeBtn = document.getElementById('ai-api-modal-close');
      const fetchBtn = document.getElementById('fetch-models-btn');

      // 获取模型列表（走后端代理，避免 CORS）
      const handleFetchModels = async () => {
        const apiBase = apiBaseEl.value.trim().replace(/\/$/, '');
        const apiKey = apiKeyEl.value.trim();

        if (!apiBase || !apiKey) {
          errorEl.textContent = '请先填写 API 地址和 Key';
          return;
        }

        fetchBtn.textContent = '获取中…';
        fetchBtn.disabled = true;
        errorEl.textContent = '';

        try {
          const res = await fetch('/api/ai/models', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': getCsrfToken(),
            },
            body: JSON.stringify({ apiBase, apiKey }),
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `请求失败 (${res.status})`);
          }

          const data = await res.json();
          const models = data.models || [];

          if (models.length === 0) {
            errorEl.textContent = '未能获取到模型列表，请手动输入';
            return;
          }

          // 填充 datalist
          const datalist = document.getElementById('ai-model-list');
          datalist.innerHTML = models.map((m) => `<option value="${m}">`).join('');

          window.appShared?.showToast?.(`已获取 ${models.length} 个模型`, 'success', 2000);
        } catch (e) {
          errorEl.textContent = '获取模型失败: ' + e.message;
        } finally {
          fetchBtn.textContent = '获取模型';
          fetchBtn.disabled = false;
        }
      };

      const handleSubmit = (e) => {
        e.preventDefault();
        errorEl.textContent = '';

        const apiBase = apiBaseEl.value.trim().replace(/\/$/, '');
        const apiKey = apiKeyEl.value.trim();
        const model = modelEl.value.trim();

        if (!apiBase) {
          errorEl.textContent = 'API 基础地址不能为空';
          return;
        }

        try { new URL(apiBase); } catch {
          errorEl.textContent = 'API 基础地址格式不正确';
          return;
        }

        const newConfig = { apiBase, apiKey, model };
        window.__aiApiConfig = newConfig;
        localStorage.setItem('1shell-ai-config', JSON.stringify(newConfig));
        modal.classList.add('hidden');
        window.appShared?.showToast?.('AI API 配置已保存', 'success', 2000);
        form.removeEventListener('submit', handleSubmit);
        closeBtn.removeEventListener('click', handleClose);
        fetchBtn.removeEventListener('click', handleFetchModels);
      };

      const handleClose = () => {
        modal.classList.add('hidden');
        form.removeEventListener('submit', handleSubmit);
        closeBtn.removeEventListener('click', handleClose);
        fetchBtn.removeEventListener('click', handleFetchModels);
      };

      form.addEventListener('submit', handleSubmit);
      closeBtn.addEventListener('click', handleClose);
      fetchBtn.addEventListener('click', handleFetchModels);
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

// useAiChat.ts — MainConsole 刀 4 · AI Chat 右栏面板
// 1:1 复刻 [public/ai-chat.js](public/ai-chat.js)（365 行）
// 单例：每主机会话隔离 conversationMap / SSE 流式接收 / Markdown 渲染 / API 配置 localStorage

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';

import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useAuthStore } from '@/stores/auth';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';

const SYSTEM_PROMPT = '你是一位专业的 Linux / DevOps 终端助手。用户通过多主机 Web SSH 控制台操作服务器。回复时优先给出安全、可执行、简洁的建议。';
const INTRO_MESSAGE = '已切换到多主机控制台。你可以询问当前主机的排障命令、巡检思路或脚本建议。';

const AI_CONFIG_KEY = '1shell-ai-config';

export interface AiConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** 上行内容（user 消息含 "[当前主机: xxx]" 前缀） */
  content: string;
  /** UI 显示内容（user 消息为用户原始输入） */
  displayContent?: string;
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  /** 已转义 + Markdown 渲染后的 HTML（user 为 escaped 纯文本） */
  html: string;
  /** 临时气泡（如"思考中…"） */
  pending?: boolean;
}

// window.__aiApiConfig 全局已由 @/utils/terminal AiApiConfig 声明,这里直接复用,不重复 declare global

export interface AiChatApi {
  readonly displayMessages: ComputedRef<DisplayMessage[]>;
  readonly isStreaming: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly config: Ref<AiConfig>;
  /** Topbar 按钮触发 */
  readonly configModalOpen: Ref<boolean>;

  initialize(): void;
  sendMessage(): Promise<void>;
  stopStreaming(): void;
  resetCurrentChat(): void;
  openConfigModal(): void;
  closeConfigModal(): void;
  saveConfig(next: AiConfig): void;
  fetchModels(apiBase: string, apiKey: string): Promise<string[]>;
}

let _instance: AiChatApi | null = null;

export function useAiChat(): AiChatApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetAiChatSingleton(): void {
  _instance = null;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * 1:1 复刻 ai-chat.js:40-61 — 先 escapeHtml 防 XSS,再正则插入安全的 HTML 标签
 */
export function renderMarkdown(text: string): string {
  return escapeHtml(String(text || ''))
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
      const langAttr = lang ? ` data-lang="${lang}"` : '';
      return `<pre${langAttr}><code>${code.replace(/\n$/, '')}</code></pre>`;
    })
    .replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/(^[ \t]*[-*+] .+(?:\n|$))+/gm, (list: string) => {
      const items = list.trim().split(/\n/)
        .map((line) => line.replace(/^[ \t]*[-*+] (.+)$/, '<li>$1</li>'))
        .join('');
      return `<ul>${items}</ul>`;
    })
    .replace(/\n/g, '<br>');
}

function create(): AiChatApi {
  const router = useRouter();
  const sessionTerminal = useSessionTerminal();
  const hosts = useHostsStore();
  const auth = useAuthStore();
  const notify = useNotifyStore();

  const conversationMap = new Map<string, ChatMessage[]>();
  // 流式拼接 buffer：当前主机 assistant 增量回复（驱动 UI 即时刷新）
  const streamingHostKey = ref<string>('');
  const streamingPartial = ref<string>('');
  const isStreaming = ref(false);
  const inputText = ref('');
  const configModalOpen = ref(false);

  const config = ref<AiConfig>({ apiBase: '', apiKey: '', model: '' });

  let currentAbortController: AbortController | null = null;

  // forceVersion：使 displayMessages 在 history.push 后立即重算（Map 内部 mutate Vue 不追踪）
  const historyVersion = ref(0);

  function activeHostKey(): string {
    return sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  }

  function getOrCreateHistory(hostKey: string): ChatMessage[] {
    if (!conversationMap.has(hostKey)) {
      conversationMap.set(hostKey, [{ role: 'system', content: SYSTEM_PROMPT }]);
    }
    return conversationMap.get(hostKey)!;
  }

  /**
   * 当前可见对话（system 消息隐藏；空对话显 INTRO）
   * 流式中追加"流式 partial"作为最后一条 assistant 气泡（pending=true 直到完成）
   */
  const displayMessages = computed<DisplayMessage[]>(() => {
    void historyVersion.value;
    const hostKey = activeHostKey();
    const history = getOrCreateHistory(hostKey);
    const visible = history.filter((m) => m.role !== 'system');
    const list: DisplayMessage[] = [];

    if (!visible.length && !(isStreaming.value && streamingHostKey.value === hostKey)) {
      list.push({ role: 'assistant', html: escapeHtml(INTRO_MESSAGE) });
      return list;
    }

    for (const m of visible) {
      if (m.role === 'user') {
        list.push({ role: 'user', html: escapeHtml(m.displayContent || m.content) });
      } else if (m.role === 'assistant') {
        list.push({ role: 'assistant', html: renderMarkdown(m.content) });
      }
    }

    if (isStreaming.value && streamingHostKey.value === hostKey) {
      const partial = streamingPartial.value;
      list.push({
        role: 'assistant',
        html: partial ? renderMarkdown(partial) : escapeHtml('思考中…'),
        pending: true,
      });
    }

    return list;
  });

  function bumpHistory(): void { historyVersion.value += 1; }

  function resetCurrentChat(): void {
    const hostKey = activeHostKey();
    conversationMap.set(hostKey, [{ role: 'system', content: SYSTEM_PROMPT }]);
    bumpHistory();
  }

  function handleAuthExpired(message: string): void {
    auth.setAuthenticated(false);
    notify.error(message || '登录已失效，请重新登录');
    router.push('/').catch(() => { /* 静默 */ });
  }

  async function sendMessage(): Promise<void> {
    const userContent = inputText.value.trim();
    if (!userContent || isStreaming.value) return;

    const hostKey = activeHostKey();
    const host = hosts.hostMap.get(hostKey) || hosts.hostMap.get(LOCAL_HOST_ID) || null;
    const history = getOrCreateHistory(hostKey);
    const hostName = host?.name || '未知';
    const upstreamContent = `[当前主机: ${hostName}]\n${userContent}`;

    history.push({ role: 'user', content: upstreamContent, displayContent: userContent });
    bumpHistory();
    inputText.value = '';

    streamingHostKey.value = hostKey;
    streamingPartial.value = '';
    isStreaming.value = true;
    currentAbortController = new AbortController();

    let fullReply = '';

    try {
      const requestBody: Record<string, unknown> = {
        messages: history.map(({ role, content }) => ({ role, content })),
      };
      const customConfig = window.__aiApiConfig || config.value;
      if (customConfig.apiBase) requestBody.apiBase = customConfig.apiBase;
      if (customConfig.apiKey) requestBody.apiKey = customConfig.apiKey;
      if (customConfig.model) requestBody.model = customConfig.model;

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify(requestBody),
        signal: currentAbortController!.signal,
      });

      if (response.status === 401) {
        const data = await response.json().catch(() => ({}));
        const msg = (data as { error?: string }).error || '登录已失效，请重新登录';
        handleAuthExpired(msg);
        throw new Error(msg);
      }
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || '聊天请求失败');
      }

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
          let parsed: { error?: string; choices?: Array<{ delta?: { content?: string } }> };
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (parsed.error) throw new Error(parsed.error);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullReply += delta;
            streamingPartial.value = fullReply;
          }
        }
      }

      if (fullReply) {
        history.push({ role: 'assistant', content: fullReply });
      } else {
        history.push({ role: 'assistant', content: '（无文字回复）' });
      }
      bumpHistory();
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      if (isAbort) {
        // 用户主动停止 — 保留已收到的部分回复
        if (fullReply) {
          history.push({ role: 'assistant', content: fullReply });
        } else {
          history.push({ role: 'assistant', content: '（已停止）' });
        }
      } else {
        const errMsg = (err as Error).message || '请求失败';
        history.push({ role: 'assistant', content: `请求失败：${errMsg}` });
      }
      bumpHistory();
    } finally {
      currentAbortController = null;
      streamingHostKey.value = '';
      streamingPartial.value = '';
      isStreaming.value = false;
    }
  }

  function stopStreaming(): void {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  }

  function loadConfig(): void {
    try {
      const saved = localStorage.getItem(AI_CONFIG_KEY);
      if (!saved) return;
      const obj = JSON.parse(saved) as Partial<AiConfig>;
      const merged: AiConfig = {
        apiBase: obj.apiBase || '',
        apiKey: obj.apiKey || '',
        model: obj.model || '',
      };
      config.value = merged;
      if (merged.apiBase || merged.apiKey || merged.model) {
        window.__aiApiConfig = merged;
      }
    } catch { /* 静默 */ }
  }

  function saveConfig(next: AiConfig): void {
    config.value = { ...next };
    window.__aiApiConfig = { ...next };
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(next));
  }

  async function fetchModels(apiBase: string, apiKey: string): Promise<string[]> {
    const cleanBase = apiBase.trim().replace(/\/$/, '');
    if (!cleanBase || !apiKey.trim()) throw new Error('请先填写 API 地址和 Key');
    const res = await fetch('/api/ai/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
      body: JSON.stringify({ apiBase: cleanBase, apiKey: apiKey.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || `请求失败 (${res.status})`);
    }
    const data = await res.json().catch(() => ({})) as { models?: string[] };
    return data.models || [];
  }

  function openConfigModal(): void { configModalOpen.value = true; }
  function closeConfigModal(): void { configModalOpen.value = false; }

  let initialized = false;
  function initialize(): void {
    if (initialized) return;
    initialized = true;
    loadConfig();
  }

  return {
    displayMessages,
    isStreaming,
    inputText,
    config,
    configModalOpen,
    initialize,
    sendMessage,
    stopStreaming,
    resetCurrentChat,
    openConfigModal,
    closeConfigModal,
    saveConfig,
    fetchModels,
  };
}

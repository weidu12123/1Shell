import { defineStore } from 'pinia';
import { ref } from 'vue';

export type IdeRole = 'user' | 'assistant' | 'tool' | 'system';

export interface IdeMessage {
  role: IdeRole;
  text: string;
  ts: number;
  toolUseId?: string;
  toolName?: string;
}

export const useIdeStore = defineStore('ide', () => {
  const sessionId = ref<string | null>(null);
  const messages = ref<IdeMessage[]>([]);
  const thinking = ref(false);
  const safeMode = ref(true);
  const claudeCodeEnabled = ref(false);
  const unlimitedTurns = ref(false);

  function reset(): void {
    sessionId.value = null;
    messages.value = [];
    thinking.value = false;
  }

  function push(msg: IdeMessage): void {
    messages.value.push(msg);
  }

  function appendText(role: IdeRole, text: string): void {
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === role) {
      last.text += text;
    } else {
      push({ role, text, ts: Date.now() });
    }
  }

  return {
    sessionId,
    messages,
    thinking,
    safeMode,
    claudeCodeEnabled,
    unlimitedTurns,
    reset,
    push,
    appendText,
  };
});

import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface TerminalSession {
  id: string;
  hostId: string;
  cols: number;
  rows: number;
  createdAt: number;
}

export const useSessionsStore = defineStore('sessions', () => {
  const items = ref<TerminalSession[]>([]);
  const activeId = ref<string | null>(null);

  function add(session: TerminalSession): void {
    items.value.push(session);
    if (!activeId.value) activeId.value = session.id;
  }

  function remove(id: string): void {
    items.value = items.value.filter((s) => s.id !== id);
    if (activeId.value === id) {
      activeId.value = items.value[0]?.id ?? null;
    }
  }

  function setActive(id: string | null): void {
    activeId.value = id;
  }

  function clear(): void {
    items.value = [];
    activeId.value = null;
  }

  return { items, activeId, add, remove, setActive, clear };
});

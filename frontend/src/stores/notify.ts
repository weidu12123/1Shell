import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  ts: number;
}

let nextId = 1;

export const useNotifyStore = defineStore('notify', () => {
  const toasts = ref<Toast[]>([]);

  function show(kind: ToastKind, text: string, ttlMs = 4000): number {
    const id = nextId++;
    toasts.value.push({ id, kind, text, ts: Date.now() });
    if (ttlMs > 0) {
      setTimeout(() => dismiss(id), ttlMs);
    }
    return id;
  }

  const info    = (text: string, ttl?: number) => show('info', text, ttl);
  const success = (text: string, ttl?: number) => show('success', text, ttl);
  const warn    = (text: string, ttl?: number) => show('warn', text, ttl);
  const error   = (text: string, ttl?: number) => show('error', text, ttl);

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function clear(): void {
    toasts.value = [];
  }

  return { toasts, show, info, success, warn, error, dismiss, clear };
});

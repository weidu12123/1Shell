import { ref, watch, type Ref } from 'vue';

export const DEFAULT_PAGE_STATE_TTL_MS = 45_000;

interface CacheEntry<T> {
  value: T;
  updatedAt: number;
}

interface ScrollPosition {
  top: number;
  left: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

function now(): number {
  return Date.now();
}

export function getCachedPageState<T>(key: string): CacheEntry<T> | null {
  const entry = memoryCache.get(key) as CacheEntry<T> | undefined;
  return entry ?? null;
}

export function setCachedPageState<T>(key: string, value: T, updatedAt = now()): void {
  memoryCache.set(key, { value, updatedAt });
}

export function isPageStateFresh(key: string, ttlMs = DEFAULT_PAGE_STATE_TTL_MS): boolean {
  const entry = memoryCache.get(key);
  return Boolean(entry && now() - entry.updatedAt <= ttlMs);
}

export function readStorageState<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorageState<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode */
  }
}

export function usePersistedRef<T>(key: string, initialValue: T): Ref<T> {
  const state = ref(readStorageState<T>(key, initialValue)) as Ref<T>;
  watch(state, (value) => writeStorageState(key, value), { deep: true });
  return state;
}

export function captureElementScroll(key: string, el: HTMLElement | null | undefined): void {
  if (!el) return;
  setCachedPageState<ScrollPosition>(`${key}:scroll`, { top: el.scrollTop, left: el.scrollLeft });
}

export function restoreElementScroll(key: string, el: HTMLElement | null | undefined): void {
  if (!el) return;
  const entry = getCachedPageState<ScrollPosition>(`${key}:scroll`);
  if (!entry) return;
  requestAnimationFrame(() => {
    el.scrollTop = entry.value.top;
    el.scrollLeft = entry.value.left;
  });
}

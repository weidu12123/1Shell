import { defineStore } from 'pinia';
import { shallowRef, ref, computed } from 'vue';
import type { MainHost } from '@/utils/mainConsole';

/** 重导出以保持其它页面（已迁 7 页）import { Host } from '@/stores/hosts' 不变 */
export type Host = MainHost;

export const useHostsStore = defineStore('hosts', () => {
  const items = shallowRef<MainHost[]>([]);
  const selectedId = ref<string | null>(null);
  /** 后端 `usingFallbackSecret` 警告（首次 loadHosts 时填充） */
  const secretWarning = ref<boolean>(false);
  /** 主机搜索关键字（左栏 host-search 输入） */
  const filterKeyword = ref<string>('');

  const selected = computed<MainHost | null>(() => {
    if (!selectedId.value) return null;
    return items.value.find((h) => h.id === selectedId.value) ?? null;
  });

  const hostMap = computed<Map<string, MainHost>>(() => {
    return new Map(items.value.map((h) => [h.id, h]));
  });

  const filteredItems = computed<MainHost[]>(() => {
    const kw = filterKeyword.value.trim().toLowerCase();
    if (!kw) return items.value;
    return items.value.filter((h) =>
      [h.name, h.host, h.username].filter(Boolean).some((s) => String(s).toLowerCase().includes(kw))
    );
  });

  function setHosts(list: MainHost[]): void {
    items.value = list;
  }

  function setSecretWarning(v: boolean): void {
    secretWarning.value = v;
  }

  function setFilterKeyword(s: string): void {
    filterKeyword.value = s;
  }

  function upsert(host: MainHost): void {
    const idx = items.value.findIndex((h) => h.id === host.id);
    const next = items.value.slice();
    if (idx === -1) next.push(host);
    else next[idx] = host;
    items.value = next;
  }

  function remove(id: string): void {
    items.value = items.value.filter((h) => h.id !== id);
    if (selectedId.value === id) selectedId.value = null;
  }

  function select(id: string | null): void {
    selectedId.value = id;
  }

  return {
    items, selectedId, selected, hostMap, filteredItems,
    secretWarning, filterKeyword,
    setHosts, setSecretWarning, setFilterKeyword,
    upsert, remove, select,
  };
});

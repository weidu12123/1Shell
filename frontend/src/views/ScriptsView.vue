<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import AiGenModal from '@/components/scripts/AiGenModal.vue';
import AppIcon from '@/components/AppIcon.vue';
import HistoryPane from '@/components/scripts/HistoryPane.vue';
import RunModal from '@/components/scripts/RunModal.vue';
import ScriptDetail from '@/components/scripts/ScriptDetail.vue';
import ScriptList from '@/components/scripts/ScriptList.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import { useNotifyStore } from '@/stores/notify';
import {
  CATEGORIES,
  deepClone,
  makeDraftScript,
  type HostInfo,
  type HostsListResponse,
  type ScriptCategory,
  type ScriptInfo,
  type ScriptsListResponse,
} from '@/utils/scripts';

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const { confirm } = useConfirm();

interface ScriptsPrefs {
  currentId: string | null;
  categoryFilter: 'all' | ScriptCategory;
  keyword: string;
  view: 'scripts' | 'history';
}

interface ScriptsCache {
  scripts: ScriptInfo[];
  hosts: HostInfo[];
}

const SCRIPTS_PREFS_KEY = '1shell.scripts.prefs.v1';
const SCRIPTS_CACHE_KEY = 'scripts.page.cache.v1';
const SCRIPTS_CACHE_TTL_MS = 45_000;
const savedPrefs = readStorageState<ScriptsPrefs>(SCRIPTS_PREFS_KEY, {
  currentId: null,
  categoryFilter: 'all',
  keyword: '',
  view: 'scripts',
});

const scripts = shallowRef<ScriptInfo[]>([]);
const hosts = ref<HostInfo[]>([]);
const currentId = ref<string | null>(savedPrefs.currentId);
const currentDraft = ref<ScriptInfo | null>(null);
const isNew = ref(false);
const categoryFilter = ref<'all' | ScriptCategory>(savedPrefs.categoryFilter);
const keyword = ref(savedPrefs.keyword);
const view = ref<'scripts' | 'history'>(savedPrefs.view);
const saving = ref(false);
const runModalOpen = ref(false);
const aiGenModalOpen = ref(false);

function saveScriptsPrefs(): void {
  writeStorageState<ScriptsPrefs>(SCRIPTS_PREFS_KEY, {
    currentId: currentId.value,
    categoryFilter: categoryFilter.value,
    keyword: keyword.value,
    view: view.value,
  });
}

function saveScriptsCache(): void {
  setCachedPageState<ScriptsCache>(SCRIPTS_CACHE_KEY, {
    scripts: scripts.value,
    hosts: hosts.value,
  });
}

function syncCurrentDraft(): void {
  if (!currentId.value || isNew.value) return;
  const current = scripts.value.find((s) => s.id === currentId.value);
  currentDraft.value = current ? deepClone(current) : null;
  if (!current) currentId.value = null;
}

function restoreScriptsCache(): boolean {
  const entry = getCachedPageState<ScriptsCache>(SCRIPTS_CACHE_KEY);
  if (!entry) return false;
  scripts.value = entry.value.scripts || [];
  hosts.value = entry.value.hosts || [];
  syncCurrentDraft();
  return true;
}

const categoryCounts = computed(() => {
  const c: Record<string, number> = { all: scripts.value.length };
  for (const s of scripts.value) {
    const cat = s.category || 'other';
    c[cat] = (c[cat] || 0) + 1;
  }
  return c;
});

const totalCount = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return scripts.value.filter((s) => {
    if (categoryFilter.value !== 'all' && s.category !== categoryFilter.value) return false;
    if (!kw) return true;
    const hay = `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
    return hay.includes(kw);
  }).length;
});

const runModalScript = computed(() => {
  if (!currentId.value) return null;
  return scripts.value.find((s) => s.id === currentId.value) || null;
});

async function loadScripts(): Promise<void> {
  try {
    const resp = await requestJson<ScriptsListResponse>('/api/scripts');
    scripts.value = Array.isArray(resp.scripts) ? resp.scripts : [];
    syncCurrentDraft();
    saveScriptsCache();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
    scripts.value = [];
  }
}

async function loadHosts(): Promise<void> {
  try {
    const resp = await requestJson<HostsListResponse>('/api/hosts');
    hosts.value = Array.isArray(resp.hosts) ? resp.hosts : [];
    saveScriptsCache();
  } catch {
    hosts.value = [];
  }
}

function selectScript(id: string): void {
  const s = scripts.value.find((x) => x.id === id);
  if (!s) return;
  currentId.value = id;
  isNew.value = false;
  currentDraft.value = deepClone(s);
  if (view.value === 'history') view.value = 'scripts';
  saveScriptsPrefs();
}

function newScript(): void {
  currentId.value = null;
  isNew.value = true;
  currentDraft.value = makeDraftScript();
  if (view.value === 'history') view.value = 'scripts';
  saveScriptsPrefs();
}

async function onSave(draft: ScriptInfo): Promise<void> {
  if (!draft.name.trim()) { notify.warn('请填写脚本名称'); return; }
  if (!draft.content.trim()) { notify.warn('请填写脚本内容'); return; }

  saving.value = true;
  try {
    if (isNew.value) {
      const payload: Partial<ScriptInfo> = { ...draft };
      delete payload.id;
      const resp = await requestJson<{ ok: boolean; script: ScriptInfo }>('/api/scripts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const saved = resp.script;
      scripts.value = [saved, ...scripts.value];
      isNew.value = false;
      currentId.value = saved.id;
      currentDraft.value = deepClone(saved);
      saveScriptsPrefs();
      saveScriptsCache();
      notify.success('脚本已创建');
    } else if (currentId.value) {
      const resp = await requestJson<{ ok: boolean; script: ScriptInfo }>(
        `/api/scripts/${encodeURIComponent(currentId.value)}`,
        { method: 'PUT', body: JSON.stringify(draft) },
      );
      const saved = resp.script;
      const idx = scripts.value.findIndex((s) => s.id === currentId.value);
      if (idx !== -1) {
        const next = scripts.value.slice();
        next[idx] = saved;
        scripts.value = next;
      }
      currentDraft.value = deepClone(saved);
      saveScriptsPrefs();
      saveScriptsCache();
      notify.success('脚本已保存');
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    saving.value = false;
  }
}

async function onDelete(): Promise<void> {
  if (isNew.value || !currentId.value) {
    isNew.value = false;
    currentId.value = null;
    currentDraft.value = null;
    return;
  }
  const target = scripts.value.find((s) => s.id === currentId.value);
  const ok = await confirm({
    title: '确认删除脚本',
    message: `此操作不可撤销，确定要删除脚本"${target?.name || currentId.value}"吗？`,
    okText: '确认删除',
  });
  if (!ok) return;

  try {
    await requestJson(`/api/scripts/${encodeURIComponent(currentId.value)}`, { method: 'DELETE' });
    scripts.value = scripts.value.filter((s) => s.id !== currentId.value);
    currentId.value = null;
    currentDraft.value = null;
    saveScriptsPrefs();
    saveScriptsCache();
    notify.success('脚本已删除');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

function onRunOpen(): void {
  if (isNew.value || !currentId.value) {
    notify.warn('请先保存脚本后再执行');
    return;
  }
  runModalOpen.value = true;
}

function onRanComplete(scriptId: string, count: number): void {
  const idx = scripts.value.findIndex((s) => s.id === scriptId);
  if (idx !== -1) {
    const next = scripts.value.slice();
    next[idx] = { ...next[idx], runCount: (next[idx].runCount || 0) + count };
    scripts.value = next;
  }
}

function onAiGenerated(scriptData: Partial<ScriptInfo>): void {
  const draft = makeDraftScript();
  Object.assign(draft, {
    name: scriptData.name || draft.name,
    icon: scriptData.icon || draft.icon,
    category: scriptData.category || draft.category,
    tags: scriptData.tags || [],
    riskLevel: scriptData.riskLevel || 'safe',
    description: scriptData.description || '',
    content: scriptData.content || '',
    parameters: scriptData.parameters || [],
  });
  currentId.value = null;
  isNew.value = true;
  currentDraft.value = draft;
  if (view.value === 'history') view.value = 'scripts';
}

function showHistory(): void { view.value = 'history'; saveScriptsPrefs(); }
function backFromHistory(): void { view.value = 'scripts'; saveScriptsPrefs(); }

function onExportClick(): void {
  notify.info('导入/导出功能将在 P1 阶段上线');
}

watch([categoryFilter, keyword], saveScriptsPrefs);

onMounted(() => {
  const restored = restoreScriptsCache();
  if (!restored || !isPageStateFresh(SCRIPTS_CACHE_KEY, SCRIPTS_CACHE_TTL_MS)) {
    void loadScripts();
    void loadHosts();
  }
});
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-300 flex items-center justify-center">
          <AppIcon name="terminal" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            脚本库
            <span class="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300 font-semibold">BETA</span>
          </div>
          <div class="text-[11px] text-slate-400">沉淀、复用、审计地操作主机</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          class="h-8 px-3 rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/10 text-xs font-semibold text-purple-600 dark:text-purple-300 hover:border-purple-400 hover:bg-purple-100 transition-all"
          @click="aiGenModalOpen = true"
        >✦ AI 生成</button>
        <button
          type="button"
          class="h-8 px-3 rounded-lg bg-gradient-to-r from-purple-500 to-purple-600 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all"
          @click="newScript"
        >+ 新建脚本</button>
      </div>
    </header>

    <div class="flex-1 min-h-0 flex gap-2">
      <aside class="w-48 shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
          <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">标签分类</span>
          <button type="button" class="text-[10px] text-purple-500 hover:underline" title="管理标签">+ 新标签</button>
        </div>
        <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          <button
            v-for="c in CATEGORIES"
            :key="c.value"
            type="button"
            class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors"
            :class="categoryFilter === c.value
              ? 'text-purple-600 bg-purple-50 border-purple-200 dark:bg-purple-500/15 dark:border-purple-500/30 dark:text-purple-300'
              : 'text-slate-500 dark:text-slate-400 border-transparent hover:bg-slate-50 dark:hover:bg-slate-800'"
            @click="categoryFilter = c.value"
          >
            <AppIcon :name="c.icon" :size="14" />
            <span>{{ c.label }}</span>
            <span class="ml-auto text-[10px] text-slate-400">{{ categoryCounts[c.value] || 0 }}</span>
          </button>
        </div>
        <div class="border-t border-slate-100 dark:border-[#1e293b] p-2 flex flex-col gap-1">
          <button type="button" class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800" @click="showHistory">
            <AppIcon name="history" :size="14" /><span>执行历史</span>
          </button>
          <button type="button" class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800" @click="onExportClick">
            <AppIcon name="download" :size="14" /><span>导入 / 导出</span>
          </button>
        </div>
      </aside>

      <aside class="w-80 shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div class="shrink-0 p-2.5 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-2">
          <input
            v-model="keyword"
            type="text"
            placeholder="搜索脚本、标签、描述…"
            class="flex-1 h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-100"
          />
          <button type="button" class="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-slate-400 hover:text-purple-500 hover:border-purple-300 text-xs" title="排序">⇅</button>
        </div>
        <ScriptList
          :scripts="scripts"
          :current-id="currentId"
          :category="categoryFilter"
          :keyword="keyword"
          @select="selectScript"
        />
        <div class="shrink-0 px-3 py-2 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between text-[10px] text-slate-400">
          <span>共 <b class="text-slate-600 dark:text-slate-300">{{ totalCount }}</b> 个脚本</span>
          <span>按更新时间排序</span>
        </div>
      </aside>

      <main class="flex-1 flex flex-col min-w-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <HistoryPane v-if="view === 'history'" @back="backFromHistory" />
        <ScriptDetail
          v-else
          :script="currentDraft"
          :is-new="isNew"
          :saving="saving"
          @save="onSave"
          @delete="onDelete"
          @run="onRunOpen"
        />
      </main>
    </div>

    <RunModal
      v-model:open="runModalOpen"
      :script="runModalScript"
      :hosts="hosts"
      @ran="onRanComplete"
    />
    <AiGenModal
      v-model:open="aiGenModalOpen"
      @generated="onAiGenerated"
    />
  </div>
</template>

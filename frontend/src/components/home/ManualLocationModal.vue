<script setup lang="ts">
// 手动定位选择器
// - 国家可搜索（中文名/英文代码两种命中）
// - 可选填城市
// - 已有手动定位时支持「清除」恢复自动解析
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { COUNTRIES, getCountry, type CountryInfo } from '@/data/countries';

interface Existing {
  countryCode?: string | null;
  country?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
}

const props = defineProps<{
  hostId: string;
  hostName: string;
  existing?: Existing | null;
}>();

const emit = defineEmits<{
  'close': [];
  'saved': [hostId: string];
}>();

const { requestJson } = useApiClient();

const search = ref('');
const selectedCode = ref<string>(props.existing?.countryCode || '');
const city = ref<string>(props.existing?.city || '');
const submitting = ref(false);
const errorMsg = ref('');
const searchInput = ref<HTMLInputElement | null>(null);

const filtered = computed<CountryInfo[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return COUNTRIES;
  return COUNTRIES.filter(
    (c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
  );
});

const selected = computed(() => getCountry(selectedCode.value));
const canSave = computed(() => Boolean(selected.value) && !submitting.value);

function pick(code: string): void {
  selectedCode.value = code;
}

function close(): void {
  emit('close');
}

async function onSave(): Promise<void> {
  if (!selected.value) return;
  errorMsg.value = '';
  submitting.value = true;
  try {
    await requestJson(`/api/hosts/${encodeURIComponent(props.hostId)}/location`, {
      method: 'PATCH',
      body: JSON.stringify({
        manualLocation: {
          countryCode: selected.value.code,
          country: selected.value.name,
          city: city.value.trim() || null,
          lat: selected.value.lat,
          lng: selected.value.lng,
        },
      }),
    });
    emit('saved', props.hostId);
    emit('close');
  } catch (err) {
    errorMsg.value = (err as ApiError | Error).message || '保存失败';
  } finally {
    submitting.value = false;
  }
}

async function onClear(): Promise<void> {
  errorMsg.value = '';
  submitting.value = true;
  try {
    await requestJson(`/api/hosts/${encodeURIComponent(props.hostId)}/location`, {
      method: 'PATCH',
      body: JSON.stringify({ manualLocation: null }),
    });
    emit('saved', props.hostId);
    emit('close');
  } catch (err) {
    errorMsg.value = (err as ApiError | Error).message || '清除失败';
  } finally {
    submitting.value = false;
  }
}

function flagEmoji(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '🌐';
  const base = 0x1F1E6 - 'A'.charCodeAt(0);
  const upper = code.toUpperCase();
  return String.fromCodePoint(base + upper.charCodeAt(0)) + String.fromCodePoint(base + upper.charCodeAt(1));
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

onMounted(async () => {
  await nextTick();
  searchInput.value?.focus();
  window.addEventListener('keydown', onKey);
});

watch(
  () => props.hostId,
  () => {
    selectedCode.value = props.existing?.countryCode || '';
    city.value = props.existing?.city || '';
    search.value = '';
    errorMsg.value = '';
  },
);
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
    @click="close"
    @keydown.esc.stop="close"
  >
    <div
      class="w-[28rem] max-w-[92vw] max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl
             bg-white border-slate-200 text-slate-800
             dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      @click.stop
    >
      <!-- 标题栏 -->
      <div class="px-5 pt-4 pb-3 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-base font-semibold flex items-center gap-2">
            <span>📍</span>
            <span>手动定位</span>
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
            {{ hostName }}
          </div>
        </div>
        <button
          class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-lg leading-none"
          aria-label="关闭"
          @click="close"
        >✕</button>
      </div>

      <!-- 选择国家 -->
      <div class="px-5 py-3 border-b border-slate-200 dark:border-slate-700">
        <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">国家 / 地区</label>
        <input
          ref="searchInput"
          v-model="search"
          type="text"
          placeholder="搜索国家名或代码（例：日本 / JP）"
          class="mt-1 w-full h-9 px-3 rounded-lg border text-sm outline-none transition
                 border-slate-300 bg-white text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-100
                 dark:border-slate-600 dark:bg-slate-800/70 dark:text-slate-100 dark:focus:border-sky-400 dark:focus:ring-sky-900/40"
        />
      </div>

      <!-- 国家列表 -->
      <div class="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        <div v-if="filtered.length === 0" class="text-center text-sm text-slate-400 py-6">
          没有匹配的国家
        </div>
        <button
          v-for="c in filtered"
          :key="c.code"
          type="button"
          class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition
                 hover:bg-slate-100 dark:hover:bg-slate-800/70"
          :class="selectedCode === c.code
            ? 'bg-sky-50 dark:bg-sky-900/30 ring-1 ring-sky-300 dark:ring-sky-600'
            : ''"
          @click="pick(c.code)"
        >
          <span class="text-lg">{{ flagEmoji(c.code) }}</span>
          <span class="flex-1 truncate">
            <span class="font-medium">{{ c.name }}</span>
            <span class="ml-1 text-xs text-slate-400">{{ c.code }}</span>
          </span>
          <span
            v-if="selectedCode === c.code"
            class="text-sky-500 dark:text-sky-400 text-sm"
          >✓</span>
        </button>
      </div>

      <!-- 城市（选填）+ 错误信息 -->
      <div class="px-5 py-3 border-t border-slate-200 dark:border-slate-700">
        <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">
          城市 <span class="font-normal text-slate-400">（选填，仅展示用）</span>
        </label>
        <input
          v-model="city"
          type="text"
          placeholder="例：东京"
          class="mt-1 w-full h-9 px-3 rounded-lg border text-sm outline-none transition
                 border-slate-300 bg-white text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-100
                 dark:border-slate-600 dark:bg-slate-800/70 dark:text-slate-100 dark:focus:border-sky-400 dark:focus:ring-sky-900/40"
        />
        <div v-if="errorMsg" class="mt-2 text-xs text-red-500">{{ errorMsg }}</div>
      </div>

      <!-- 操作按钮 -->
      <div class="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2">
        <button
          v-if="existing && existing.countryCode"
          type="button"
          class="px-3 h-9 rounded-lg text-sm border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          :disabled="submitting"
          @click="onClear"
        >清除手动定位</button>
        <div class="flex-1"></div>
        <button
          type="button"
          class="px-3 h-9 rounded-lg text-sm border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          @click="close"
        >取消</button>
        <button
          type="button"
          class="px-4 h-9 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-sky-500 to-blue-600 shadow hover:shadow-lg disabled:opacity-50"
          :disabled="!canSave"
          @click="onSave"
        >保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  PARAM_TYPES,
  RISK_BADGES,
  RISK_LABEL_ACTIVE_CLS,
  isEmojiIcon,
  type ParamDef,
  type ScriptCategory,
  type ScriptInfo,
  type ScriptRisk,
} from '@/utils/scripts';

interface Props {
  script: ScriptInfo | null;
  isNew: boolean;
  saving: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [draft: ScriptInfo];
  delete: [];
  run: [];
}>();

const draft = ref<ScriptInfo | null>(null);
const tagInput = ref('');
const nameInputRef = ref<HTMLInputElement | null>(null);

watch(() => props.script, async (s) => {
  draft.value = s ? { ...s, tags: [...(s.tags || [])], parameters: (s.parameters || []).map((p) => ({ ...p })) } : null;
  if (props.isNew && draft.value) {
    await nextTick();
    nameInputRef.value?.focus();
    nameInputRef.value?.select();
  }
}, { immediate: true });

const headerIcon = computed(() => {
  if (!draft.value) return 'terminal';
  return draft.value.icon || CATEGORY_ICONS[draft.value.category] || 'terminal';
});

const headerMeta = computed(() => {
  if (!draft.value) return '';
  if (props.isNew) return '草稿（尚未保存）';
  const d = draft.value;
  return `ID: ${d.id} · 创建于 ${d.createdAt || '-'} · 更新 ${d.updatedAt || '-'} · 运行 ${d.runCount || 0} 次`;
});

const riskBadge = computed(() => {
  if (!draft.value) return RISK_BADGES.safe;
  return RISK_BADGES[draft.value.riskLevel] || RISK_BADGES.safe;
});

const allCategories = computed<ScriptCategory[]>(() => Object.keys(CATEGORY_LABELS) as ScriptCategory[]);

// ── 标签 ──────────────────────────────────────────────
function onTagKeydown(e: KeyboardEvent): void {
  if (!draft.value) return;
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const v = tagInput.value.trim();
    if (v && !draft.value.tags.includes(v)) {
      draft.value.tags.push(v);
    }
    tagInput.value = '';
  } else if (e.key === 'Backspace' && tagInput.value === '' && draft.value.tags.length > 0) {
    draft.value.tags.pop();
  }
}

function removeTag(tag: string): void {
  if (!draft.value) return;
  draft.value.tags = draft.value.tags.filter((t) => t !== tag);
}

// ── 参数行 ────────────────────────────────────────────
function addParam(): void {
  if (!draft.value) return;
  draft.value.parameters.push({ name: '', type: 'string', label: '', default: '', required: false });
}

function removeParam(i: number): void {
  if (!draft.value) return;
  draft.value.parameters.splice(i, 1);
}

// ── 风险等级 ──────────────────────────────────────────
function setRisk(r: ScriptRisk): void {
  if (draft.value) draft.value.riskLevel = r;
}

function riskLabelClass(r: ScriptRisk): string {
  if (!draft.value) return 'border-slate-200 bg-slate-50 dark:border-[#1e293b] dark:bg-[#0b1324]';
  return draft.value.riskLevel === r
    ? RISK_LABEL_ACTIVE_CLS[r]
    : 'border-slate-200 bg-slate-50 dark:border-[#1e293b] dark:bg-[#0b1324]';
}

// ── 保存 / 删除 / 执行 ────────────────────────────────
function onSave(): void {
  if (!draft.value) return;
  // 清掉空 name 的参数行
  const cleaned: ScriptInfo = {
    ...draft.value,
    name: draft.value.name.trim() || '未命名脚本',
    icon: draft.value.icon?.trim() || '',
    description: draft.value.description?.trim() || '',
    parameters: draft.value.parameters
      .filter((p: ParamDef) => p.name.trim())
      .map((p: ParamDef) => ({
        ...p,
        name: p.name.trim(),
        label: p.label?.trim() || '',
      })),
  };
  emit('save', cleaned);
}
</script>

<template>
  <div v-if="!draft" class="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
    <AppIcon name="terminal" :size="56" class="opacity-40" />
    <div class="text-sm">从左侧列表选择一个脚本进行查看和编辑</div>
    <div class="text-[11px]">或点击右上角"+ 新建脚本"开始</div>
  </div>

  <div v-else class="flex-1 flex flex-col min-h-0">
    <!-- 详情头部 -->
    <div class="shrink-0 px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <span v-if="isEmojiIcon(headerIcon)" class="text-xl shrink-0">{{ headerIcon }}</span>
        <AppIcon v-else :name="headerIcon" :size="22" class="shrink-0 text-slate-500 dark:text-slate-300" />
        <div class="min-w-0 flex-1">
          <input
            ref="nameInputRef"
            v-model="draft.name"
            type="text"
            placeholder="脚本名称"
            class="min-w-0 w-full text-sm font-bold text-slate-700 dark:text-slate-200 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-purple-400 outline-none"
          />
          <div class="mt-0.5 text-[10px] text-slate-400 truncate">{{ headerMeta }}</div>
        </div>
        <span class="shrink-0 text-[9px] px-1.5 py-0.5 rounded border" :class="riskBadge.cls">{{ riskBadge.text }}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button
          v-if="!isNew"
          type="button"
          class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:border-red-200 hover:text-red-500 transition-all"
          @click="emit('delete')"
        >删除</button>
        <button
          v-else
          type="button"
          class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:border-red-200 hover:text-red-500 transition-all"
          @click="emit('delete')"
        >丢弃草稿</button>
        <button
          type="button"
          :disabled="saving"
          class="h-8 px-3 rounded-lg bg-slate-100 dark:bg-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          @click="onSave"
        >{{ saving ? '保存中...' : '保存' }}</button>
        <button
          v-if="!isNew"
          type="button"
          class="h-8 px-3 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all"
          @click="emit('run')"
        >▶ 执行</button>
      </div>
    </div>

    <!-- 编辑表单 -->
    <div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
      <!-- 图标 + 分类 -->
      <div class="grid grid-cols-3 gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">图标（可选 emoji）</label>
          <input
            v-model="draft.icon"
            type="text"
            maxlength="4"
            placeholder="留空 → 用分类图标"
            class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-sm text-slate-700 dark:text-slate-200 text-center outline-none focus:border-purple-400"
          />
        </div>
        <div class="col-span-2 flex flex-col gap-1">
          <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">分类</label>
          <select
            v-model="draft.category"
            class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
          >
            <option v-for="c in allCategories" :key="c" :value="c">{{ CATEGORY_LABELS[c] }}</option>
          </select>
        </div>
      </div>

      <!-- 标签 -->
      <div class="flex flex-col gap-1">
        <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">标签</label>
        <div class="flex items-center gap-1 flex-wrap p-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] min-h-[40px]">
          <span
            v-for="tag in draft.tags"
            :key="tag"
            class="h-6 px-2 rounded-full border border-purple-200 bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:border-purple-500/30 dark:text-purple-300 text-[10px] font-medium flex items-center gap-1"
          >
            {{ tag }}
            <button type="button" class="text-purple-400 hover:text-red-500" @click="removeTag(tag)">✕</button>
          </span>
          <input
            v-model="tagInput"
            type="text"
            placeholder="输入标签后按 Enter..."
            class="flex-1 min-w-[100px] h-6 px-2 bg-transparent text-[11px] text-slate-700 dark:text-slate-200 outline-none border-none"
            @keydown="onTagKeydown"
          />
        </div>
      </div>

      <!-- 风险等级 -->
      <div class="flex flex-col gap-1">
        <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">风险等级</label>
        <div class="flex items-center gap-2">
          <label
            v-for="(meta, key) in { safe: { icon: '🟢', label: '安全', cls: 'text-emerald-600 dark:text-emerald-300', sub: '直接执行，无需确认' },
                                   confirm: { icon: '🟡', label: '需确认', cls: 'text-amber-600 dark:text-amber-300', sub: '执行前二次确认' },
                                   danger: { icon: '🔴', label: '危险', cls: 'text-red-600 dark:text-red-300', sub: '需显式确认后执行' } }"
            :key="key"
            class="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all"
            :class="riskLabelClass(key as ScriptRisk)"
          >
            <input
              type="radio"
              name="risk"
              :value="key"
              :checked="draft.riskLevel === key"
              class="accent-purple-500"
              @change="setRisk(key as ScriptRisk)"
            />
            <div class="flex-1">
              <div class="text-xs font-semibold" :class="meta.cls">{{ meta.icon }} {{ meta.label }}</div>
              <div class="text-[10px] text-slate-400">{{ meta.sub }}</div>
            </div>
          </label>
        </div>
      </div>

      <!-- 描述 -->
      <div class="flex flex-col gap-1">
        <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">描述</label>
        <textarea
          v-model="draft.description"
          rows="2"
          placeholder="简要说明这个脚本的用途..."
          class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none resize-none focus:border-purple-400"
        ></textarea>
      </div>

      <!-- 参数定义 -->
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">参数定义</label>
          <button type="button" class="text-[10px] text-purple-500 hover:underline font-semibold" @click="addParam">+ 添加参数</button>
        </div>
        <div class="rounded-lg border border-slate-200 dark:border-[#1e293b] divide-y divide-slate-100 dark:divide-[#1e293b] bg-white dark:bg-slate-800 min-h-[44px]">
          <div v-if="draft.parameters.length === 0" class="p-3 text-[10px] text-slate-400 text-center">暂无参数，点击右上角"+ 添加参数"</div>
          <div
            v-for="(p, i) in draft.parameters"
            :key="i"
            class="p-2.5 flex items-center gap-2 flex-wrap"
          >
            <input
              v-model="p.name"
              type="text"
              placeholder="变量名"
              class="w-32 h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
            />
            <select
              v-model="p.type"
              class="h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none"
            >
              <option v-for="t in PARAM_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <input
              v-model="p.label"
              type="text"
              placeholder="显示名"
              class="flex-1 min-w-[120px] h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none"
            />
            <input
              v-model="p.default"
              type="text"
              placeholder="默认值"
              class="w-28 h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none"
            />
            <label class="flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
              <input v-model="p.required" type="checkbox" class="accent-purple-500" /> 必填
            </label>
            <button
              type="button"
              class="h-7 w-7 flex items-center justify-center rounded border border-slate-200 dark:border-[#1e293b] text-slate-400 hover:text-red-500 text-xs"
              @click="removeParam(i)"
            >✕</button>
          </div>
        </div>
      </div>

      <!-- 脚本内容 -->
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">脚本内容（Bash / PowerShell）</label>
          <span class="text-[10px] text-slate-400">
            使用
            <code class="font-mono text-purple-500 dark:text-purple-300 bg-purple-50 dark:bg-purple-500/10 px-1 rounded" v-text="'{{变量名}}'"></code>
            引用参数
          </span>
        </div>
        <textarea
          v-model="draft.content"
          rows="12"
          placeholder="#!/bin/bash"
          class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-900 text-slate-100 font-mono text-xs outline-none resize-y focus:border-purple-400 leading-relaxed"
        ></textarea>
      </div>
    </div>
  </div>
</template>

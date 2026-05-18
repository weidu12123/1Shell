<script setup lang="ts">
import { computed } from 'vue';
import type { HostInfo, ScriptInfo, WorkflowInfo } from '@/utils/scripts';

interface Props {
  draft: WorkflowInfo;
  scripts: ScriptInfo[];
  hosts: HostInfo[];
  isNew: boolean;
  saving: boolean;
  running: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [];
  run: [];
  delete: [];
}>();

const hostOptions = computed<HostInfo[]>(() => {
  const list: HostInfo[] = [{ id: 'local', name: '本机' }];
  for (const h of props.hosts) {
    if (h.id === 'local') continue;
    list.push(h);
  }
  return list;
});

function moveUp(i: number): void {
  if (i <= 0) return;
  const arr = props.draft.steps;
  [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
}

function moveDown(i: number): void {
  const arr = props.draft.steps;
  if (i >= arr.length - 1) return;
  [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
}

function removeStep(i: number): void {
  props.draft.steps.splice(i, 1);
}

function addStep(): void {
  props.draft.steps.push({ scriptId: '', scriptName: '', hostId: '', params: {}, stopOnFail: true });
}

function onScriptChange(i: number, e: Event): void {
  const target = e.target as HTMLSelectElement;
  const id = target.value;
  const s = props.scripts.find((x) => x.id === id);
  props.draft.steps[i].scriptId = id;
  props.draft.steps[i].scriptName = s?.name || '';
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <!-- name + icon -->
    <div class="shrink-0 px-5 py-3 flex items-center gap-3">
      <input
        v-model="draft.name"
        type="text"
        placeholder="Playbook 名称"
        class="flex-1 h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs font-bold text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
      />
      <input
        v-model="draft.icon"
        type="text"
        maxlength="4"
        placeholder="📘"
        class="w-12 h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-sm text-slate-700 dark:text-slate-200 text-center outline-none focus:border-purple-400"
      />
    </div>

    <!-- description -->
    <div class="shrink-0 px-5 py-2">
      <input
        v-model="draft.description"
        type="text"
        placeholder="描述（可选）"
        class="w-full h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
      />
    </div>

    <!-- 步骤标题 + 添加 -->
    <div class="shrink-0 px-5 py-2 flex items-center gap-2">
      <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">步骤列表</span>
      <button
        type="button"
        class="h-6 px-2 rounded border border-dashed border-slate-300 dark:border-slate-600 text-[10px] text-slate-500 dark:text-slate-400 hover:border-purple-400 hover:text-purple-500"
        @click="addStep"
      >+ 添加步骤</button>
    </div>

    <!-- 步骤列表 -->
    <div class="flex-1 overflow-y-auto px-5 pb-4 space-y-2">
      <div v-if="draft.steps.length === 0" class="text-center text-slate-400 text-xs py-6">
        点击"+ 添加步骤"来组装编排
      </div>
      <div
        v-for="(step, i) in draft.steps"
        :key="i"
        class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3"
      >
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <span class="text-[10px] font-bold text-slate-400 w-5 text-center shrink-0">{{ i + 1 }}</span>
          <select
            :value="step.scriptId"
            class="flex-1 min-w-[160px] h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
            @change="onScriptChange(i, $event)"
          >
            <option value="">选择脚本</option>
            <option v-for="s in scripts" :key="s.id" :value="s.id">{{ s.icon || '📜' }} {{ s.name }}</option>
          </select>
          <select
            v-model="step.hostId"
            class="w-36 h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-purple-400"
          >
            <option value="">选择主机（可选）</option>
            <option v-for="h in hostOptions" :key="h.id" :value="h.id">{{ h.name }}<span v-if="h.host"> ({{ h.host }})</span></option>
          </select>
          <button
            type="button"
            :disabled="i === 0"
            class="w-6 h-6 flex items-center justify-center rounded border border-slate-200 dark:border-[#1e293b] text-[10px] text-slate-400 hover:text-blue-500 disabled:opacity-30 disabled:cursor-not-allowed"
            @click="moveUp(i)"
          >↑</button>
          <button
            type="button"
            :disabled="i === draft.steps.length - 1"
            class="w-6 h-6 flex items-center justify-center rounded border border-slate-200 dark:border-[#1e293b] text-[10px] text-slate-400 hover:text-blue-500 disabled:opacity-30 disabled:cursor-not-allowed"
            @click="moveDown(i)"
          >↓</button>
          <button
            type="button"
            class="w-6 h-6 flex items-center justify-center rounded border border-slate-200 dark:border-[#1e293b] text-[10px] text-red-400 hover:text-red-600"
            @click="removeStep(i)"
          >✕</button>
        </div>
        <div class="pl-7 text-[10px] text-slate-400">
          {{ step.scriptName || '' }}<span v-if="step.hostId"> → {{ step.hostId }}</span>
        </div>
      </div>
    </div>

    <!-- 底部按钮 -->
    <div class="shrink-0 px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between gap-2">
      <button
        v-if="!isNew"
        type="button"
        class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 hover:border-red-200 hover:text-red-500 transition-all"
        @click="emit('delete')"
      >删除</button>
      <div v-else></div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          :disabled="saving"
          class="h-8 px-4 rounded-lg bg-slate-100 dark:bg-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          @click="emit('save')"
        >{{ saving ? '保存中...' : '保存' }}</button>
        <button
          type="button"
          :disabled="running || isNew"
          class="h-8 px-4 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold shadow hover:shadow-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          @click="emit('run')"
        >{{ running ? '执行中...' : '▶ 执行' }}</button>
      </div>
    </div>
  </div>
</template>

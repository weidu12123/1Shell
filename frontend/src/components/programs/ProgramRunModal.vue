<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { ProgramInfo, ProgramInputDef } from '@/utils/programs';

interface RunRequest {
  program: ProgramInfo;
  hostId: string;
  actionName?: string;
}

const props = defineProps<{ request: RunRequest | null }>();
const emit = defineEmits<{
  run: [inputs: Record<string, unknown>];
  cancel: [];
}>();

const values = reactive<Record<string, string | number | boolean>>({});
const errors = reactive<Record<string, string>>({});

const action = computed(() => {
  const name = props.request?.actionName;
  return name ? props.request?.program.actions?.[name] : null;
});

const inputDefs = computed<ProgramInputDef[]>(() => [
  ...(props.request?.program.inputs || []),
  ...(action.value?.inputs || []),
]);

const title = computed(() => action.value?.label || action.value?.name || props.request?.actionName || '触发 Program');

watch(() => props.request, () => {
  for (const key of Object.keys(values)) delete values[key];
  for (const key of Object.keys(errors)) delete errors[key];
  for (const input of inputDefs.value) {
    const defaultValue = input.default ?? (input.type === 'boolean' ? false : '');
    values[input.name] = typeof defaultValue === 'boolean' || typeof defaultValue === 'number' ? defaultValue : String(defaultValue);
  }
}, { immediate: true });

function validate(): boolean {
  for (const key of Object.keys(errors)) delete errors[key];
  for (const input of inputDefs.value) {
    const value = values[input.name];
    const empty = value === undefined || value === null || String(value).trim() === '';
    if (input.required && empty) {
      errors[input.name] = '必填';
      continue;
    }
    if (empty) continue;
    if (input.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) errors[input.name] = '必须是数字';
      else if (input.min != null && n < Number(input.min)) errors[input.name] = `必须 ≥ ${input.min}`;
      else if (input.max != null && n > Number(input.max)) errors[input.name] = `必须 ≤ ${input.max}`;
    }
  }
  return Object.keys(errors).length === 0;
}

function submit(): void {
  if (!validate()) return;
  emit('run', { ...values });
}
</script>

<template>
  <div v-if="request" class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4">
    <div class="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
      <div class="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <div class="text-base font-bold text-slate-800 dark:text-slate-100">{{ title }}</div>
        <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">主机：{{ request.hostId }}</div>
      </div>

      <div class="max-h-[65vh] space-y-4 overflow-auto px-5 py-4">
        <div v-if="inputDefs.length === 0" class="text-sm text-slate-500">该 action 不需要额外参数。</div>
        <label v-for="input in inputDefs" :key="input.name" class="block">
          <div class="mb-1 flex items-center gap-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span>{{ input.label || input.name }}</span>
            <span v-if="input.required" class="text-red-500">*</span>
          </div>
          <select
            v-if="input.type === 'select'"
            :value="String(values[input.name] || '')"
            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-950"
            @change="values[input.name] = ($event.target as HTMLSelectElement).value"
          >
            <option value="">请选择</option>
            <option v-for="option in input.options || []" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <textarea
            v-else-if="input.type === 'text'"
            :value="String(values[input.name] || '')"
            class="min-h-24 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-950"
            :placeholder="input.placeholder"
            @input="values[input.name] = ($event.target as HTMLTextAreaElement).value"
          />
          <input
            v-else-if="input.type === 'boolean'"
            :checked="values[input.name] === true"
            type="checkbox"
            class="h-4 w-4 rounded border-slate-300 text-blue-600"
            @change="values[input.name] = ($event.target as HTMLInputElement).checked"
          />
          <input
            v-else
            :value="String(values[input.name] || '')"
            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-950"
            :type="input.secret || input.type === 'password' ? 'password' : input.type === 'number' ? 'number' : 'text'"
            :placeholder="input.placeholder"
            :min="input.min ?? undefined"
            :max="input.max ?? undefined"
            @input="values[input.name] = ($event.target as HTMLInputElement).value"
          />
          <div v-if="input.description" class="mt-1 text-[11px] text-slate-400">{{ input.description }}</div>
          <div v-if="errors[input.name]" class="mt-1 text-[11px] text-red-500">{{ errors[input.name] }}</div>
        </label>
      </div>

      <div class="flex justify-end gap-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
        <button class="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800" @click="emit('cancel')">取消</button>
        <button class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" @click="submit">开始执行</button>
      </div>
    </div>
  </div>
</template>

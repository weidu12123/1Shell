<script setup lang="ts">
import { computed } from 'vue';
import type { RenderTablePayload } from '@/utils/playbooks';

interface Props { payload: RenderTablePayload }
const props = defineProps<Props>();
const emit = defineEmits<{
  rowAction: [rowIndex: number, action: string];
}>();

const cols = computed(() => props.payload.columns || []);
const rows = computed(() => props.payload.rows || []);
const actions = computed(() => props.payload.rowActions || []);

function isProtectedRow(row: unknown): boolean {
  if (!Array.isArray(row)) return false;
  const name = String(row[0] || '');
  return /1shell/i.test(name);
}

function cellText(c: unknown): string {
  return String(c == null ? '' : c);
}
</script>

<template>
  <div v-if="rows.length === 0" class="text-xs text-slate-400 italic">（空）</div>
  <div v-else class="overflow-x-auto">
    <table class="pb-result-table">
      <thead>
        <tr>
          <th v-for="(c, i) in cols" :key="i">{{ c }}</th>
          <th v-if="actions.length" class="text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in rows" :key="rowIndex">
          <template v-if="Array.isArray(row)">
            <td v-for="(c, ci) in row" :key="ci" class="align-middle">{{ cellText(c) }}</td>
          </template>
          <td v-else :colspan="cols.length" class="text-slate-400">{{ String(row) }}</td>
          <td v-if="actions.length" class="text-right align-middle whitespace-nowrap">
            <span v-if="isProtectedRow(row)" class="text-[10px] text-slate-400 italic">受保护</span>
            <template v-else>
              <button
                v-for="(a, ai) in actions"
                :key="ai"
                class="text-[10px] px-2 py-1 rounded border border-slate-200 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 hover:border-blue-400 text-slate-600 dark:text-slate-300 mr-1 transition-all"
                @click="emit('rowAction', rowIndex, String(a.value || ''))"
              >{{ a.label || a.value || '执行' }}</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

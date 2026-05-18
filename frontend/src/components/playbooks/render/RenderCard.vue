<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type {
  PlaybookInfo,
  RenderPayload,
  RenderTablePayload,
  RenderKeyValuePayload,
  RenderListPayload,
  RenderCodePayload,
  RenderMessagePayload,
} from '@/utils/playbooks';
import RenderTable from './RenderTable.vue';
import RenderKeyValue from './RenderKeyValue.vue';
import RenderList from './RenderList.vue';
import RenderCode from './RenderCode.vue';
import RenderMessage from './RenderMessage.vue';
import RowActionPicker from '../RowActionPicker.vue';

interface Props {
  payload: RenderPayload;
  allSkillsAndPlaybooks?: PlaybookInfo[];
}
const props = withDefaults(defineProps<Props>(), {
  allSkillsAndPlaybooks: () => [],
});
const emit = defineEmits<{
  rowAction: [rowIndex: number, action: string, pickerSkillId: string];
}>();

const format = computed(() => (props.payload as { format?: string }).format || 'message');
const level = computed(() => (props.payload.level || 'info'));

const showPicker = computed<boolean>(() => {
  if (format.value !== 'table') return false;
  const p = props.payload as RenderTablePayload;
  if (!Array.isArray(p.rowActions) || p.rowActions.length === 0) return false;
  // 无 skill 选项时不显（programs 复用本组件不传该 prop，picker 静默隐藏）
  return props.allSkillsAndPlaybooks.length > 0;
});

// 每张表格独立的 picker 状态，默认取 payload.rowActionSkill
const pickerSkillId = ref<string>('');
watch(
  () => props.payload,
  (now) => {
    if (format.value === 'table') {
      const p = now as RenderTablePayload;
      pickerSkillId.value = p.rowActionSkill || '';
    }
  },
  { immediate: true },
);

function onTableRowAction(rowIndex: number, action: string): void {
  emit('rowAction', rowIndex, action, pickerSkillId.value);
}
</script>

<template>
  <div>
    <div class="pb-render-card p-3.5" :class="`level-${level}`">
      <div v-if="payload.title" class="text-[13px] font-bold text-slate-700 dark:text-slate-200 mb-0.5">{{ payload.title }}</div>
      <div v-if="payload.subtitle" class="text-[11px] text-slate-400 mb-2.5">{{ payload.subtitle }}</div>
      <RenderTable
        v-if="format === 'table'"
        :payload="payload as RenderTablePayload"
        @row-action="onTableRowAction"
      />
      <RenderKeyValue
        v-else-if="format === 'keyvalue'"
        :payload="payload as RenderKeyValuePayload"
      />
      <RenderList
        v-else-if="format === 'list'"
        :payload="payload as RenderListPayload"
      />
      <RenderCode
        v-else-if="format === 'code'"
        :payload="payload as RenderCodePayload"
      />
      <RenderMessage
        v-else
        :payload="payload as RenderMessagePayload"
      />
    </div>
    <RowActionPicker
      v-if="showPicker"
      v-model="pickerSkillId"
      :options="allSkillsAndPlaybooks"
    />
  </div>
</template>

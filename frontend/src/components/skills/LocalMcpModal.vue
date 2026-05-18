<script setup lang="ts">
import { ref, watch } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { parseTags } from '@/utils/skills';

interface Props { open: boolean }
const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const fName = ref('');
const fCmd = ref('');
const fDesc = ref('');
const fTags = ref('');
const saving = ref(false);

watch(() => props.open, (now) => {
  if (!now) return;
  fName.value = '';
  fCmd.value = '';
  fDesc.value = '';
  fTags.value = '';
});

function close(): void { emit('update:open', false); }
function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

async function save(): Promise<void> {
  const name = fName.value.trim();
  const command = fCmd.value.trim();
  if (!name)    { notify.error('请填写名称'); return; }
  if (!command) { notify.error('请填写启动命令'); return; }

  saving.value = true;
  try {
    await requestJson('/api/mcp-servers', {
      method: 'POST',
      body: JSON.stringify({
        name,
        command,
        description: fDesc.value.trim(),
        tags: parseTags(fTags.value),
      }),
    });
    notify.success('本地 MCP 已添加');
    emit('saved');
    close();
  } catch (err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '操作失败';
    notify.error(msg, 5000);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    @click="onBackdrop"
  >
    <div class="bg-white dark:bg-[#0f172a] rounded-2xl border border-slate-200 dark:border-[#1e293b] w-[520px] overflow-hidden shadow-2xl text-slate-700 dark:text-slate-200">
      <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center">
        <span class="text-sm font-semibold flex-1">添加本地 MCP Server</span>
        <button class="text-xl text-slate-400 hover:text-red-500" @click="close">✕</button>
      </div>
      <div class="p-5 flex flex-col gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">名称</span>
          <input v-model="fName" class="fld" placeholder="如 filesystem-server" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">启动命令（stdio 模式）</span>
          <input v-model="fCmd" class="fld" placeholder="如 npx -y @modelcontextprotocol/server-filesystem /path" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">描述（可选）</span>
          <textarea v-model="fDesc" class="fld" rows="2" placeholder="这个 MCP 提供什么能力？"></textarea>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">标签（逗号分隔，可选）</span>
          <input v-model="fTags" class="fld" placeholder="local,filesystem" />
        </label>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2">
        <button class="flex-1 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#1e293b]" @click="close">取消</button>
        <button
          class="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 disabled:opacity-60"
          :disabled="saving"
          @click="save"
        >{{ saving ? '保存中...' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

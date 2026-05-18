<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { parseTags, serializeTags, type McpInfo } from '@/utils/skills';

interface Props {
  open: boolean;
  /** 编辑模式时传入；null = 新建 */
  editing: McpInfo | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const fName = ref('');
const fUrl = ref('');
const fToken = ref('');
const fDesc = ref('');
const fTags = ref('');
const saving = ref(false);

const title = computed(() => props.editing ? `编辑 MCP · ${props.editing.name}` : '添加 MCP Server');
const tokenPlaceholder = computed(() => {
  if (!props.editing) return '（可选）';
  return props.editing.authTokenSet ? '已有 token，留空则不修改' : '（可选）';
});

// 每次打开时重填字段（关闭不清，与老版一致）
watch(() => props.open, (now) => {
  if (!now) return;
  if (props.editing) {
    fName.value = props.editing.name || '';
    fUrl.value = props.editing.url || '';
    fToken.value = '';
    fDesc.value = props.editing.description || '';
    fTags.value = serializeTags(props.editing.tags);
  } else {
    fName.value = '';
    fUrl.value = '';
    fToken.value = '';
    fDesc.value = '';
    fTags.value = '';
  }
});

function close(): void { emit('update:open', false); }
function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

async function save(): Promise<void> {
  const name = fName.value.trim();
  const url = fUrl.value.trim();
  if (!name) { notify.error('请填写名称'); return; }
  if (!url)  { notify.error('请填写 URL'); return; }

  const payload: Record<string, unknown> = {
    name, url,
    description: fDesc.value.trim(),
    tags: parseTags(fTags.value),
  };
  const token = fToken.value.trim();
  // 编辑时空 token 表示不修改；新建时空 token 也传（含义"没有 token"）
  if (props.editing && token) payload.authToken = token;
  if (!props.editing) payload.authToken = token;

  saving.value = true;
  try {
    if (props.editing) {
      await requestJson(`/api/mcp-servers/${encodeURIComponent(props.editing.id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      notify.success('已更新');
    } else {
      await requestJson('/api/mcp-servers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      notify.success('已添加');
    }
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
    <div class="bg-white dark:bg-[#0f172a] rounded-2xl border border-slate-200 dark:border-[#1e293b] w-[520px] overflow-hidden shadow-2xl">
      <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center">
        <span class="text-sm font-semibold flex-1">{{ title }}</span>
        <button class="text-xl text-slate-400 hover:text-red-500" @click="close">✕</button>
      </div>
      <div class="p-5 flex flex-col gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">名称</span>
          <input v-model="fName" class="fld" placeholder="如 GitHub Issues" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">URL（HTTP/SSE）</span>
          <input v-model="fUrl" class="fld" placeholder="https://mcp.example.com/sse" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">Authorization Token（可选）</span>
          <input v-model="fToken" class="fld" :placeholder="tokenPlaceholder" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">描述（可选）</span>
          <textarea v-model="fDesc" class="fld" rows="2" placeholder="这个 MCP 提供什么能力？"></textarea>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">标签（逗号分隔，可选）</span>
          <input v-model="fTags" class="fld" placeholder="github,issue" />
        </label>
      </div>
      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2">
        <button class="flex-1 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs" @click="close">取消</button>
        <button
          class="flex-1 py-2 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-600 disabled:opacity-60"
          :disabled="saving"
          @click="save"
        >{{ saving ? '保存中...' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

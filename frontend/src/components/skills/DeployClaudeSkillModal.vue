<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { ApiError, useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { parseTags, serializeTags, type ClaudeCodeSkillInfo } from '@/utils/skills';

interface Props { open: boolean }
interface ImportInspectResponse extends ClaudeCodeSkillInfo { warnings?: string[] }

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const phase = ref<'input' | 'review' | 'done'>('input');
const fUrl = ref('');
const fId = ref('');
const fName = ref('');
const fDescription = ref('');
const fTags = ref('');
const discovered = ref<NonNullable<ClaudeCodeSkillInfo['skills']>>([]);
const warnings = ref<string[]>([]);
const statusText = ref('');
const inspecting = ref(false);
const importing = ref(false);

const busy = computed(() => inspecting.value || importing.value);

watch(() => props.open, (now) => {
  if (!now) return;
  reset();
});

function reset(): void {
  phase.value = 'input';
  fUrl.value = '';
  fId.value = '';
  fName.value = '';
  fDescription.value = '';
  fTags.value = '';
  discovered.value = [];
  warnings.value = [];
  statusText.value = '';
  inspecting.value = false;
  importing.value = false;
}

function close(): void {
  if (busy.value) return;
  emit('update:open', false);
}

function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

async function inspect(): Promise<void> {
  const repoUrl = fUrl.value.trim();
  if (!repoUrl) { notify.error('请粘贴 GitHub 链接'); return; }

  inspecting.value = true;
  statusText.value = '正在 clone/pull 仓库并扫描 SKILL.md...';
  try {
    const data = await requestJson<ImportInspectResponse>('/api/claude-code-skills/import/inspect', {
      method: 'POST',
      body: JSON.stringify({ repoUrl }),
    });
    fUrl.value = data.repoUrl || repoUrl;
    fId.value = data.id || '';
    fName.value = data.name || '';
    fDescription.value = data.description || '';
    fTags.value = serializeTags(data.tags);
    discovered.value = data.skills || [];
    warnings.value = data.warnings || [];
    statusText.value = discovered.value.length
      ? `已发现 ${discovered.value.length} 个 Claude Code Skill，可导入托管。`
      : '未发现 SKILL.md，可继续托管源码供后续手动处理。';
    phase.value = 'review';
  } catch (err) {
    const msg = errorMessage(err, '识别失败');
    statusText.value = msg;
    notify.error(msg, 5000);
  } finally {
    inspecting.value = false;
  }
}

async function importSkill(): Promise<void> {
  if (!fName.value.trim()) { notify.error('请填写名称'); return; }

  importing.value = true;
  statusText.value = '正在登记到 data/claude-code-skills...';
  try {
    const data = await requestJson<{ skill?: ClaudeCodeSkillInfo }>('/api/claude-code-skills/import/register', {
      method: 'POST',
      body: JSON.stringify({
        repoUrl: fUrl.value.trim(),
        id: fId.value.trim(),
        name: fName.value.trim(),
        description: fDescription.value.trim(),
        tags: parseTags(fTags.value),
      }),
    });
    statusText.value = `导入成功：${data.skill?.name || fName.value}\n标准 Claude Code Skill 已托管，暂不直接进入 1Shell runner。`;
    notify.success('Claude Code Skill 已导入');
    emit('saved');
    phase.value = 'done';
  } catch (err) {
    const msg = errorMessage(err, '导入失败');
    statusText.value = msg;
    notify.error(msg, 6000);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    @click="onBackdrop"
  >
    <div class="bg-white dark:bg-[#0f172a] rounded-2xl border border-slate-200 dark:border-[#1e293b] w-[640px] max-h-[88vh] overflow-hidden shadow-2xl flex flex-col text-slate-700 dark:text-slate-200">
      <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center">
        <span class="text-sm font-semibold flex-1 inline-flex items-center gap-1.5">
          <AppIcon name="puzzle" :size="14" />
          <span>导入 Claude Code Skill</span>
        </span>
        <button class="text-xl text-slate-400 hover:text-red-500 disabled:opacity-50" :disabled="busy" @click="close">✕</button>
      </div>

      <div class="p-5 flex flex-col gap-3 overflow-auto">
        <div class="text-[11px] text-slate-400">
          粘贴 GitHub 仓库链接，1Shell 会 clone/pull 到 data/claude-code-skills 并扫描标准 SKILL.md。导入后只作为标准 Skill 托管，不会直接执行远程命令。
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">GitHub 仓库链接</span>
          <input v-model="fUrl" class="fld" :disabled="phase !== 'input' || busy" placeholder="https://github.com/nextlevelbuilder/ui-ux-pro-max-skill" />
        </label>

        <template v-if="phase !== 'input'">
          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">托管 ID</span>
              <input v-model="fId" class="fld font-mono" :disabled="phase === 'done' || busy" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-500">标签</span>
              <input v-model="fTags" class="fld" :disabled="phase === 'done' || busy" placeholder="claude-code-skill, ui" />
            </label>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-500">名称</span>
            <input v-model="fName" class="fld" :disabled="phase === 'done' || busy" />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-500">描述</span>
            <textarea v-model="fDescription" class="fld min-h-[72px]" :disabled="phase === 'done' || busy" />
          </label>

          <div v-if="discovered.length" class="text-[11px] p-3 rounded-lg bg-slate-50 dark:bg-[#1e293b]">
            <div class="font-semibold mb-1">发现的 SKILL.md</div>
            <div v-for="item in discovered" :key="item.path" class="font-mono text-[10px] text-slate-500 dark:text-slate-400">
              {{ item.path }} · {{ item.name || item.id }}
            </div>
          </div>

          <div v-if="warnings.length" class="text-[11px] p-3 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <div v-for="w in warnings" :key="w">{{ w }}</div>
          </div>
        </template>

        <div
          v-if="statusText"
          class="text-[11px] p-3 rounded-lg bg-slate-50 dark:bg-[#1e293b] text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap max-h-[180px] overflow-auto"
        >{{ statusText }}</div>
      </div>

      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2">
        <button class="flex-1 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#1e293b] disabled:opacity-50" :disabled="busy" @click="close">
          {{ phase === 'done' ? '完成' : '取消' }}
        </button>
        <button
          v-if="phase === 'input'"
          class="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-60"
          :disabled="busy"
          @click="inspect"
        >{{ inspecting ? '识别中...' : '识别仓库 →' }}</button>
        <button
          v-else-if="phase === 'review'"
          class="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-60"
          :disabled="busy"
          @click="importSkill"
        >{{ importing ? '导入中...' : '导入托管 →' }}</button>
      </div>
    </div>
  </div>
</template>

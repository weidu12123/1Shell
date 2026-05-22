<script setup lang="ts">
// 中栏 - 对话区 — 老 chat-area
// 渲染：user message → chat-bubble-user；连续 ai message 合并到同一个 chat-turn-ai turn-body
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { SessionMessage, AiLineKind, AuthoringArtifact, AuthoringInteraction, AuthoringOption } from '@/utils/studio';

interface Props {
  messages: SessionMessage[];
  runStatusText: string;
  showClearButton: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  clear: [];
  'authoring-reply': [interaction: AuthoringInteraction, value: string, label: string];
}>();

interface UserTurn { type: 'user'; text: string }
interface AiTurn   { type: 'ai'; lines: Array<{ kind: AiLineKind; content: string }> }
interface AuthoringTurn { type: 'authoring'; interaction?: AuthoringInteraction; artifact?: AuthoringArtifact }
type Turn = UserTurn | AiTurn | AuthoringTurn;

// 把 messages 按"连续 ai 消息块"分组成 turns
const turns = computed<Turn[]>(() => {
  const out: Turn[] = [];
  let cur: AiTurn | null = null;
  let suppressNextToolResult = false;
  for (const m of props.messages) {
    if (m.role === 'user') {
      out.push({ type: 'user', text: m.content });
      cur = null;
      suppressNextToolResult = false;
    } else if (m.role === 'authoring') {
      out.push({ type: 'authoring', interaction: m.interaction, artifact: m.artifact });
      cur = null;
      suppressNextToolResult = false;
    } else {
      const content = m.content.trim();
      if (m.kind === 'info' && content.startsWith('⚙')) {
        suppressNextToolResult = true;
        continue;
      }
      if (suppressNextToolResult && (m.kind === 'stdout' || m.kind === 'stderr')) {
        suppressNextToolResult = false;
        continue;
      }
      suppressNextToolResult = false;
      if (!cur) {
        cur = { type: 'ai', lines: [] };
        out.push(cur);
      }
      cur.lines.push({ kind: m.kind, content: m.content });
    }
  }
  return out;
});

const isEmpty = computed(() => props.messages.length === 0);

function riskClass(risk: AuthoringOption['risk']): string {
  if (risk === 'high') return 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200';
  if (risk === 'low') return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200';
  return 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
}

function choose(interaction: AuthoringInteraction, option: AuthoringOption): void {
  if (interaction.answered) return;
  emit('authoring-reply', interaction, option.id, option.label);
}

function interactionTitle(interaction: AuthoringInteraction): string {
  if (interaction.kind === 'commit_approval') return interaction.title || '确认写入创作产物文件';
  if (interaction.kind === 'options') return interaction.title || '请选择方案';
  return '需要你确认';
}

function formatBytes(bytes: number | undefined): string {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`;
  return `${(b / 1024 / 1024).toFixed(1)}M`;
}

function artifactTypeLabel(type: string): string {
  if (type === 'program_spec') return 'Program Spec';
  if (type === 'skill_spec') return 'Skill Spec';
  if (type === 'authoring_plan') return 'Authoring Plan';
  if (type === 'program_draft') return 'Program Draft';
  if (type === 'skill_draft') return 'Skill Draft';
  if (type === 'authoring_verification') return 'Verification';
  return type;
}

function artifactData(artifact: AuthoringArtifact): Record<string, unknown> {
  return artifact.data || {};
}

function previewFiles(artifact: AuthoringArtifact): Array<{ path: string; content: string }> {
  const files = artifactData(artifact).files;
  return Array.isArray(files) ? files.map((file) => ({
    path: String((file as { path?: unknown }).path || ''),
    content: String((file as { content?: unknown }).content || ''),
  })) : [];
}

function planTasks(artifact: AuthoringArtifact): Array<Record<string, unknown>> {
  const tasks = artifactData(artifact).tasks;
  return Array.isArray(tasks) ? tasks as Array<Record<string, unknown>> : [];
}

function artifactInputs(artifact: AuthoringArtifact): Array<Record<string, unknown>> {
  const inputs = artifactData(artifact).inputs;
  return Array.isArray(inputs) ? inputs as Array<Record<string, unknown>> : [];
}

function verificationChecks(artifact: AuthoringArtifact): Array<Record<string, unknown>> {
  const checks = artifactData(artifact).checks;
  return Array.isArray(checks) ? checks as Array<Record<string, unknown>> : [];
}

function smokeRunIds(artifact: AuthoringArtifact): string[] {
  const smoke = artifactData(artifact).smokeTest as { runIds?: unknown } | undefined;
  return Array.isArray(smoke?.runIds) ? smoke.runIds.map(String) : [];
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// 自动滚到底
const scrollRef = ref<HTMLElement | null>(null);
async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
}
watch(() => props.messages.length, scrollToBottom);
</script>

<template>
  <div class="flex-1 min-h-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] flex flex-col overflow-hidden">
    <div class="col-header">
      <div class="flex items-center gap-2">
        <span>创作对话</span>
        <span class="text-[10px] text-slate-400 font-normal normal-case">{{ runStatusText }}</span>
      </div>
      <button
        v-if="showClearButton"
        class="text-[10px] normal-case font-normal text-slate-400 hover:text-red-500"
        @click="emit('clear')"
      >清空</button>
    </div>
    <div ref="scrollRef" class="flex-1 overflow-auto p-4 flex flex-col gap-3">
      <div v-if="isEmpty" class="text-[11px] text-slate-400 text-center py-10 flex flex-col items-center gap-2">
        <AppIcon name="terminal" :size="36" class="opacity-50" />
        <span>选好主机和上下文后，在下方输入你的需求<br/>AI 会自由探索、创建、测试、迭代，支持多轮对话</span>
      </div>
      <template v-for="(t, i) in turns" :key="i">
        <div v-if="t.type === 'user'" class="chat-bubble-user">{{ t.text }}</div>
        <div v-else-if="t.type === 'authoring' && t.interaction" class="rounded-2xl border border-purple-200 bg-purple-50/70 p-3 text-xs text-slate-700 dark:border-purple-500/20 dark:bg-purple-500/10 dark:text-slate-200">
          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="font-semibold text-purple-700 dark:text-purple-200">
              {{ interactionTitle(t.interaction) }}
            </div>
            <span v-if="t.interaction.answered" class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200">已选择</span>
          </div>
          <p v-if="t.interaction.description" class="mb-3 text-slate-500 dark:text-slate-400">{{ t.interaction.description }}</p>
          <p v-if="t.interaction.question" class="mb-3 whitespace-pre-wrap">{{ t.interaction.question }}</p>
          <div v-if="t.interaction.kind === 'commit_approval'" class="mb-3 grid gap-2">
            <div v-if="t.interaction.summary" class="rounded-xl bg-white/80 p-2 dark:bg-slate-900/40">
              <div class="font-semibold text-purple-700 dark:text-purple-200">写入摘要</div>
              <div class="mt-1 whitespace-pre-wrap">{{ t.interaction.summary }}</div>
            </div>
            <div v-if="t.interaction.files?.length" class="rounded-xl bg-white/80 p-2 dark:bg-slate-900/40">
              <div class="font-semibold text-purple-700 dark:text-purple-200">拟写入文件</div>
              <ul class="mt-1 grid gap-1">
                <li v-for="file in t.interaction.files" :key="file.path" class="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-2 py-1 dark:bg-slate-950/60">
                  <span class="font-mono text-[11px] break-all">{{ file.path }}</span>
                  <span class="shrink-0 text-[10px] text-slate-400">{{ formatBytes(file.bytes) }}</span>
                </li>
              </ul>
            </div>
            <div v-if="t.interaction.dangerousActions?.length" class="rounded-xl border border-red-200 bg-red-50 p-2 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
              <div class="font-semibold">危险动作</div>
              <ul class="list-disc pl-4"><li v-for="item in t.interaction.dangerousActions" :key="item">{{ item }}</li></ul>
            </div>
            <div v-if="t.interaction.irreversibleActions?.length" class="rounded-xl border border-amber-200 bg-amber-50 p-2 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <div class="font-semibold">不可逆动作</div>
              <ul class="list-disc pl-4"><li v-for="item in t.interaction.irreversibleActions" :key="item">{{ item }}</li></ul>
            </div>
            <div v-if="t.interaction.validation" class="rounded-xl border p-2" :class="t.interaction.validation.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'">
              <div class="font-semibold">Validation: {{ t.interaction.validation.ok ? '通过' : '失败' }}</div>
              <ul v-if="t.interaction.validation.errors?.length" class="list-disc pl-4"><li v-for="item in t.interaction.validation.errors" :key="item">{{ item }}</li></ul>
              <ul v-if="t.interaction.validation.warnings?.length" class="list-disc pl-4"><li v-for="item in t.interaction.validation.warnings" :key="item">{{ item }}</li></ul>
            </div>
          </div>
          <div v-if="t.interaction.options?.length" class="grid gap-2">
            <button
              v-for="option in t.interaction.options"
              :key="option.id"
              class="text-left rounded-xl border bg-white/80 p-3 hover:border-purple-400 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-900/40 dark:hover:bg-slate-900/70"
              :disabled="t.interaction.answered"
              @click="choose(t.interaction, option)"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="font-semibold text-slate-800 dark:text-slate-100">
                  {{ option.label }}
                  <span v-if="option.recommended" class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-200">推荐</span>
                </div>
                <span v-if="option.risk" class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border" :class="riskClass(option.risk)">{{ option.risk }}</span>
              </div>
              <div v-if="option.summary || option.description" class="mt-1 text-slate-500 dark:text-slate-400">{{ option.summary || option.description }}</div>
              <div v-if="option.pros?.length || option.cons?.length" class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div v-if="option.pros?.length">
                  <div class="font-semibold text-emerald-600 dark:text-emerald-300">优点</div>
                  <ul class="list-disc pl-4"><li v-for="item in option.pros" :key="item">{{ item }}</li></ul>
                </div>
                <div v-if="option.cons?.length">
                  <div class="font-semibold text-amber-600 dark:text-amber-300">代价</div>
                  <ul class="list-disc pl-4"><li v-for="item in option.cons" :key="item">{{ item }}</li></ul>
                </div>
              </div>
            </button>
          </div>
          <div v-else class="text-slate-500 dark:text-slate-400">请在下方输入框回复。</div>
        </div>
        <div v-else-if="t.type === 'authoring' && t.artifact" class="rounded-2xl border border-blue-200 bg-blue-50/70 p-3 text-xs text-slate-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-slate-200">
          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="font-semibold text-blue-700 dark:text-blue-200">{{ artifactTypeLabel(t.artifact.type) }} · {{ t.artifact.title }}</div>
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-white/80 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">{{ t.artifact.status || 'draft' }}</span>
          </div>

          <template v-if="t.artifact.type === 'program_spec'">
            <div class="grid gap-2">
              <div><span class="font-semibold">目标：</span>{{ artifactData(t.artifact).goal }}</div>
              <div><span class="font-semibold">方案：</span>{{ artifactData(t.artifact).selectedApproach }}</div>
              <div v-if="asStringList(artifactData(t.artifact).risks).length">
                <div class="font-semibold text-red-600 dark:text-red-300">风险</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).risks)" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="asStringList(artifactData(t.artifact).l1Steps).length">
                <div class="font-semibold">L1 Steps</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).l1Steps)" :key="item">{{ item }}</li></ul>
              </div>
              <div><span class="font-semibold">L2：</span>{{ artifactData(t.artifact).l2Policy }}</div>
              <div><span class="font-semibold">L3：</span>{{ artifactData(t.artifact).l3Policy }}</div>
            </div>
          </template>

          <template v-else-if="t.artifact.type === 'skill_spec'">
            <div class="grid gap-2">
              <div><span class="font-semibold">目标：</span>{{ artifactData(t.artifact).goal }}</div>
              <div v-if="asStringList(artifactData(t.artifact).triggerScenarios).length">
                <div class="font-semibold">触发场景</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).triggerScenarios)" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="artifactInputs(t.artifact).length">
                <div class="font-semibold">Inputs</div>
                <ul class="list-disc pl-4"><li v-for="input in artifactInputs(t.artifact)" :key="String(input.id || input.name || input.key)">{{ input.name || input.id || input.key || 'input' }}</li></ul>
              </div>
              <div v-if="asStringList(artifactData(t.artifact).rules).length">
                <div class="font-semibold">Rules</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).rules)" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="asStringList(artifactData(t.artifact).workflows).length">
                <div class="font-semibold">Workflows</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).workflows)" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="asStringList(artifactData(t.artifact).references).length">
                <div class="font-semibold">References</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).references)" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="asStringList(artifactData(t.artifact).risks).length">
                <div class="font-semibold text-red-600 dark:text-red-300">风险</div>
                <ul class="list-disc pl-4"><li v-for="item in asStringList(artifactData(t.artifact).risks)" :key="item">{{ item }}</li></ul>
              </div>
            </div>
          </template>

          <template v-else-if="t.artifact.type === 'authoring_plan'">
            <div class="grid gap-2">
              <div
                v-for="task in planTasks(t.artifact)"
                :key="String(task.id || task.title)"
                class="rounded-xl bg-white/70 p-2 dark:bg-slate-900/40"
              >
                <div class="font-semibold">{{ task.title }}</div>
                <div v-if="task.goal" class="text-slate-500 dark:text-slate-400">{{ task.goal }}</div>
              </div>
            </div>
          </template>

          <template v-else-if="t.artifact.type === 'program_draft' || t.artifact.type === 'skill_draft'">
            <div v-if="t.artifact.dangerousActions?.length" class="mb-2 rounded-xl border border-red-200 bg-red-50 p-2 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
              <div class="font-semibold">危险动作</div>
              <ul class="list-disc pl-4"><li v-for="item in t.artifact.dangerousActions" :key="item">{{ item }}</li></ul>
            </div>
            <div v-if="t.artifact.validation" class="mb-2 rounded-xl border p-2" :class="t.artifact.validation.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'">
              <div class="font-semibold">Validation: {{ t.artifact.validation.ok ? '通过' : '失败' }}</div>
              <ul v-if="t.artifact.validation.errors?.length" class="list-disc pl-4"><li v-for="item in t.artifact.validation.errors" :key="item">{{ item }}</li></ul>
              <ul v-if="t.artifact.validation.warnings?.length" class="list-disc pl-4"><li v-for="item in t.artifact.validation.warnings" :key="item">{{ item }}</li></ul>
            </div>
            <div class="grid gap-2">
              <div v-for="file in previewFiles(t.artifact)" :key="file.path" class="rounded-xl bg-slate-950 text-slate-100 overflow-hidden">
                <div class="px-3 py-1.5 bg-slate-800 text-[11px] text-slate-300">{{ file.path }}</div>
                <pre class="p-3 overflow-auto max-h-72 text-[11px] whitespace-pre-wrap">{{ file.content }}</pre>
              </div>
            </div>
          </template>

          <template v-else-if="t.artifact.type === 'authoring_verification'">
            <div class="grid gap-2">
              <div class="rounded-xl border p-2" :class="t.artifact.validation?.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'">
                <div class="font-semibold">验证结果：{{ t.artifact.validation?.ok ? '通过' : '失败' }}</div>
                <div v-if="artifactData(t.artifact).programId" class="mt-1">Program：{{ artifactData(t.artifact).programId }}</div>
                <div v-if="artifactData(t.artifact).skillId" class="mt-1">Skill：{{ artifactData(t.artifact).skillId }}</div>
                <ul v-if="t.artifact.validation?.errors?.length" class="mt-1 list-disc pl-4"><li v-for="item in t.artifact.validation.errors" :key="item">{{ item }}</li></ul>
                <ul v-if="t.artifact.validation?.warnings?.length" class="mt-1 list-disc pl-4"><li v-for="item in t.artifact.validation.warnings" :key="item">{{ item }}</li></ul>
              </div>
              <div v-if="verificationChecks(t.artifact).length" class="rounded-xl bg-white/70 p-2 dark:bg-slate-900/40">
                <div class="font-semibold text-blue-700 dark:text-blue-200">检查项</div>
                <ul class="mt-1 grid gap-1">
                  <li v-for="check in verificationChecks(t.artifact)" :key="String(check.name)" class="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-2 py-1 dark:bg-slate-950/60">
                    <span>{{ check.name }}</span>
                    <span :class="check.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'">{{ check.ok ? 'ok' : 'failed' }}</span>
                  </li>
                </ul>
              </div>
              <div v-if="smokeRunIds(t.artifact).length" class="rounded-xl bg-white/70 p-2 dark:bg-slate-900/40">
                <div class="font-semibold text-blue-700 dark:text-blue-200">Smoke Run</div>
                <div class="mt-1 font-mono text-[11px] break-all">{{ smokeRunIds(t.artifact).join(', ') }}</div>
              </div>
            </div>
          </template>
        </div>
        <div v-else-if="t.type === 'ai'" class="chat-turn-ai">
          <div class="turn-header">
            <AppIcon name="robot" :size="13" /><span>AI</span>
          </div>
          <div class="turn-body">
            <div
              v-for="(line, j) in t.lines"
              :key="j"
              class="run-line"
              :class="line.kind"
            >{{ line.content }}</div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// 中栏 - 对话区 — 老 chat-area
// 渲染：user message → chat-bubble-user；连续 ai message 合并到同一个 chat-turn-ai turn-body
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { SessionMessage, AiLineKind } from '@/utils/studio';

interface Props {
  messages: SessionMessage[];
  runStatusText: string;
  showClearButton: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  clear: [];
}>();

interface UserTurn { type: 'user'; text: string }
interface AiTurn   { type: 'ai'; lines: Array<{ kind: AiLineKind; content: string }> }
type Turn = UserTurn | AiTurn;

// 把 messages 按"连续 ai 消息块"分组成 turns
const turns = computed<Turn[]>(() => {
  const out: Turn[] = [];
  let cur: AiTurn | null = null;
  for (const m of props.messages) {
    if (m.role === 'user') {
      out.push({ type: 'user', text: m.content });
      cur = null;
    } else {
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
        <div v-else class="chat-turn-ai">
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

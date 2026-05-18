<script setup lang="ts">
// AppAiFab.vue — P5 跨页浮动 1Shell AI
// 1:1 复刻 [public/ai-fab.js](public/ai-fab.js) + 新增拖拽到任意位置（用户拍板）
//
// 用户拍板规则：
// - 排除页：main (MainConsole) + skill-studio（这俩内置 1Shell AI 不重复入口）
// - 拖拽：持久化 + 默认右下 + 边界约束（不允许拖出视窗）
// - 面板跟 FAB：根据 FAB 在屏幕的象限,面板自动靠 FAB 反向展开
// - 业务隔离：sessionId 用 fab-* 前缀,与 MainConsole useIdePanel 完全独立

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useAiFab, type ModuleContext } from '@/composables/useAiFab';

const route = useRoute();
const fab = useAiFab();

// ── 排除页（与刀 5a/5b 内置 1Shell AI 重复入口的页面不显示 FAB） ──
const EXCLUDED_ROUTES = new Set(['console', 'skill-studio']);
const visible = computed(() => !EXCLUDED_ROUTES.has(String(route.name || '')));

// ── 模块感知（按路由 name 查 hint，1:1 沿用 ai-fab.js:8-25 MODULE_MAP） ──
const MODULE_MAP: Record<string, ModuleContext> = {
  scripts: { name: '脚本库', icon: '📜', hint: '当前在脚本库页面。可管理和执行 Shell 脚本。' },
  skills: { name: 'Skill 仓库', icon: '🧩', hint: '当前在 Skill 仓库页面。可查看、运行已有的 AI Skills。' },
  programs: { name: '长驻程序', icon: '⚙', hint: '当前在长驻程序页面。可管理 Programs（定时任务 + 自动修复）。' },
  probe: { name: '探针监控', icon: '🔍', hint: '当前在探针监控页面。可查看主机探针数据和健康状态。' },
  audit: { name: '审计日志', icon: '📋', hint: '当前在审计日志页面。可查询操作日志。' },
  'cli-setup': { name: 'AI 配置', icon: '⚙', hint: '当前在 AI 引擎配置页面。' },
};

watch(
  () => route.name,
  (name) => {
    const key = String(name || '');
    const ctx = MODULE_MAP[key] || { name: '1Shell', icon: '🖥', hint: '' };
    fab.setModuleContext(ctx);
  },
  { immediate: true },
);

onMounted(() => { fab.initialize(); });

// ── 拖拽位置（持久化 + 边界约束） ──
const STORAGE_KEY = '1shell-fab-pos';
const FAB_SIZE = 52;
const FAB_MARGIN = 16;

interface Pos { x: number; y: number; }

function defaultPos(): Pos {
  // 默认右下：right: 28, bottom: 28（与老 ai-fab.js:42 一致）
  const x = window.innerWidth - FAB_SIZE - 28;
  const y = window.innerHeight - FAB_SIZE - 28;
  return { x, y };
}

function clampPos(p: Pos): Pos {
  const maxX = window.innerWidth - FAB_SIZE - FAB_MARGIN;
  const maxY = window.innerHeight - FAB_SIZE - FAB_MARGIN;
  return {
    x: Math.max(FAB_MARGIN, Math.min(maxX, p.x)),
    y: Math.max(FAB_MARGIN, Math.min(maxY, p.y)),
  };
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPos();
    const obj = JSON.parse(raw) as Partial<Pos>;
    if (typeof obj.x !== 'number' || typeof obj.y !== 'number') return defaultPos();
    return clampPos({ x: obj.x, y: obj.y });
  } catch {
    return defaultPos();
  }
}

const pos = ref<Pos>(loadPos());

function persistPos(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pos.value));
}

// 窗口尺寸变化时重新约束（避免 FAB 飞出新视窗）
function onWindowResize(): void {
  pos.value = clampPos(pos.value);
  persistPos();
}

onMounted(() => { window.addEventListener('resize', onWindowResize); });
onBeforeUnmount(() => { window.removeEventListener('resize', onWindowResize); });

// ── 拖拽 vs 点击区分（按下 → 移动超过 4px 算拖拽，否则算点击） ──
const DRAG_THRESHOLD = 4;
let dragStartMouseX = 0;
let dragStartMouseY = 0;
let dragStartPosX = 0;
let dragStartPosY = 0;
let isDragging = false;
let dragStarted = false;

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  dragStartMouseX = e.clientX;
  dragStartMouseY = e.clientY;
  dragStartPosX = pos.value.x;
  dragStartPosY = pos.value.y;
  isDragging = true;
  dragStarted = false;
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent): void {
  if (!isDragging) return;
  const dx = e.clientX - dragStartMouseX;
  const dy = e.clientY - dragStartMouseY;
  if (!dragStarted && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
  dragStarted = true;
  pos.value = clampPos({ x: dragStartPosX + dx, y: dragStartPosY + dy });
}

function onMouseUp(): void {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  isDragging = false;
  if (dragStarted) {
    persistPos();
  } else {
    togglePanel();
  }
}

// ── 面板开关 + 跟 FAB 走 ──
const panelOpen = ref(false);

function togglePanel(): void {
  panelOpen.value = !panelOpen.value;
  if (panelOpen.value) {
    void nextTick(scrollChatToBottom);
  }
}

function closePanel(): void {
  panelOpen.value = false;
}

// 面板根据 FAB 在屏幕哪个象限选展开方向
// - FAB 在屏幕右半 → 面板出现在 FAB 左边（向左展开）；左半 → 右边
// - FAB 在屏幕下半 → 面板向上展开；上半 → 向下展开
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 520;
const PANEL_GAP = 12;

const panelPos = computed<{ left: number; top: number }>(() => {
  const fabX = pos.value.x;
  const fabY = pos.value.y;
  const fabCenterX = fabX + FAB_SIZE / 2;
  const fabCenterY = fabY + FAB_SIZE / 2;
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  // 水平方向
  let left: number;
  if (fabCenterX > winW / 2) {
    // FAB 在右半 → 面板向左展开
    left = fabX - PANEL_WIDTH - PANEL_GAP;
    if (left < FAB_MARGIN) left = FAB_MARGIN;
  } else {
    // FAB 在左半 → 面板向右展开
    left = fabX + FAB_SIZE + PANEL_GAP;
    if (left + PANEL_WIDTH + FAB_MARGIN > winW) left = winW - PANEL_WIDTH - FAB_MARGIN;
  }

  // 垂直方向：尽量与 FAB 对齐顶端,边界外回缩
  let top: number;
  if (fabCenterY > winH / 2) {
    // FAB 在下半 → 面板顶端 ≈ FAB 顶端 - (panel - fab)
    top = fabY + FAB_SIZE - PANEL_HEIGHT;
  } else {
    top = fabY;
  }
  if (top < FAB_MARGIN) top = FAB_MARGIN;
  if (top + PANEL_HEIGHT + FAB_MARGIN > winH) top = winH - PANEL_HEIGHT - FAB_MARGIN;

  return { left, top };
});

// ── 聊天面板交互 ──
const chatEl = ref<HTMLElement | null>(null);

function scrollChatToBottom(): void {
  const el = chatEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

watch(() => fab.turns.value.length, () => { void nextTick(scrollChatToBottom); });
watch(() => fab.turns.value, () => { void nextTick(scrollChatToBottom); }, { deep: true });

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    fab.sendMessage();
  }
}

function lineClass(kind: string): string {
  return {
    stdout: 'ai-fab-line-stdout',
    stderr: 'ai-fab-line-stderr',
    info: 'ai-fab-line-info',
    error: 'ai-fab-line-error',
    success: 'ai-fab-line-success',
    stream: 'ai-fab-line-stdout',
  }[kind] || 'ai-fab-line-stdout';
}

function onApproveKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    fab.approveCustom();
  }
}
</script>

<template>
  <template v-if="visible">
    <!-- FAB 圆形按钮（可拖拽） -->
    <button
      type="button"
      class="ai-fab-btn"
      :class="{ 'ai-fab-btn--open': panelOpen }"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      title="1Shell AI（可拖拽）"
      @mousedown="onMouseDown"
    >{{ panelOpen ? '✕' : '🤖' }}</button>

    <!-- 聊天面板（位置跟 FAB 走） -->
    <div
      v-if="panelOpen"
      class="ai-fab-panel"
      :style="{ left: panelPos.left + 'px', top: panelPos.top + 'px' }"
    >
      <!-- header -->
      <div class="ai-fab-header">
        <span class="ai-fab-header-icon">{{ fab.moduleCtx.value.icon }}</span>
        <span class="ai-fab-title">1Shell AI</span>
        <span class="ai-fab-badge">{{ fab.moduleCtx.value.name }}</span>
        <button
          type="button"
          class="ai-fab-mini-btn ai-fab-stop-header"
          :disabled="!fab.isRunning.value"
          @click="fab.stop"
        >停止</button>
        <label
          class="ai-fab-mini-btn ai-fab-safe-label"
          :class="{ 'ai-fab-safe-label--active': fab.safeMode.value }"
          title="安全模式：写操作需审批"
        >
          <input
            type="checkbox"
            :checked="fab.safeMode.value"
            @change="(e) => fab.setSafeMode((e.target as HTMLInputElement).checked)"
          />
          <span>🛡 安全</span>
        </label>
        <button
          type="button"
          class="ai-fab-mini-btn ai-fab-clear-btn"
          :disabled="fab.isRunning.value"
          @click="fab.resetChat"
        >清空</button>
        <button
          type="button"
          class="ai-fab-mini-btn ai-fab-close-btn"
          @click="closePanel"
        >关闭</button>
      </div>

      <!-- chat -->
      <div ref="chatEl" class="ai-fab-chat">
        <div v-if="!fab.hasMessages.value" class="ai-fab-placeholder">
          <div class="ai-fab-placeholder-icon">🤖</div>
          <div>1Shell AI 助手</div>
          <div class="ai-fab-placeholder-hint">{{ fab.moduleCtx.value.hint || '输入需求，AI 会在你的主机上执行操作' }}</div>
        </div>
        <template v-for="(turn, i) in fab.turns.value" :key="i">
          <div v-if="turn.role === 'user'" class="ai-fab-user-msg">{{ turn.text }}</div>
          <div v-else class="ai-fab-ai-wrap">
            <div class="ai-fab-ai-label">🤖 1Shell AI</div>
            <div class="ai-fab-ai-body">
              <div
                v-for="(line, j) in turn.lines || []"
                :key="j"
                :class="['ai-fab-line', lineClass(line.kind)]"
              >{{ line.text }}</div>
            </div>
          </div>
        </template>
      </div>

      <!-- input -->
      <div class="ai-fab-input-area">
        <textarea
          v-model="fab.inputText.value"
          rows="2"
          placeholder="描述你的需求..."
          class="ai-fab-input"
          spellcheck="false"
          @keydown="onInputKeydown"
        />
        <div class="ai-fab-bottom-row">
          <span class="ai-fab-status">{{ fab.statusText.value }}</span>
          <button
            v-if="!fab.isRunning.value"
            type="button"
            class="ai-fab-send-btn"
            :disabled="!fab.inputText.value.trim()"
            @click="fab.sendMessage"
          >发送 →</button>
          <button
            v-else
            type="button"
            class="ai-fab-stop-btn"
            @click="fab.stop"
          >停止</button>
        </div>
      </div>
    </div>

    <!-- 安全模式审批条（fixed bottom + slide-up） -->
    <Transition name="approve-bar">
      <div v-if="fab.approveRequest.value" class="approve-bar">
        <div class="approve-bar-head">
          <span>🛡</span>
          <span class="approve-bar-title">{{ fab.approveRequest.value.title }}</span>
          <span class="approve-bar-countdown">{{ fab.approveRequest.value.countdown }}s</span>
        </div>
        <div class="approve-bar-body">
          <div class="approve-bar-desc">AI 要执行 {{ fab.approveRequest.value.toolName }}：</div>
          <pre class="approve-bar-detail">{{ fab.approveRequest.value.detail }}</pre>
        </div>
        <div class="approve-bar-foot">
          <button type="button" class="approve-bar-deny" @click="fab.approveDeny">✕ 拒绝</button>
          <div class="approve-bar-custom">
            <input
              v-model="fab.approveCustomText.value"
              type="text"
              class="approve-bar-custom-input"
              placeholder="自定义回复..."
              @keydown="onApproveKeydown"
            />
            <button type="button" class="approve-bar-custom-btn" @click="fab.approveCustom">回复</button>
          </div>
          <button type="button" class="approve-bar-allow" @click="fab.approveAllow">✓ 允许</button>
        </div>
      </div>
    </Transition>
  </template>
</template>

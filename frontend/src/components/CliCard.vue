<script setup lang="ts">
import { computed } from 'vue';
import { STATUS_LABELS, UPSTREAM_LABELS, type ToolInfo } from '@/utils/cliSetup';

interface Props {
  variant: 'tool' | 'engine';
  tool?: ToolInfo;
  launchCommand?: string;
  engineReady?: boolean;
  engineInfo?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'ensure-sandbox': [id: string];
  'reset-sandbox': [id: string];
  'config': [id: string];
  'copy-cmd': [id: string];
  'config-engine': [];
}>();

const status = computed(() => {
  if (props.variant !== 'tool' || !props.tool) return STATUS_LABELS.missing;
  return STATUS_LABELS[props.tool.status] || STATUS_LABELS.missing;
});

const sandboxedCls = computed(() => {
  if (props.variant === 'engine') return props.engineReady ? 'connected' : '';
  return props.tool?.status === 'sandboxed' ? 'connected' : '';
});

const opacityCls = computed(() => {
  return props.variant === 'tool' && props.tool?.status === 'missing' ? 'opacity-70' : '';
});

const binaryInfo = computed(() => {
  const b = props.tool?.binary;
  if (b?.installed) return { ok: true, text: `✓ ${b.path || b.name || ''}` };
  if (b?.name) return { ok: false, text: `未检测到 ${b.name}` };
  return { ok: false, text: '插件形式' };
});

const sandboxInfo = computed(() => {
  const s = props.tool?.sandbox;
  if (s?.sandboxed) return { ok: true, text: `sandbox ✓ ${s.sandboxDir || ''}` };
  return { ok: false, text: '沙箱待创建' };
});

const proxyInfo = computed(() => {
  const p = props.tool?.proxy;
  if (p?.providerCount && p.activeProvider) {
    const ap = p.activeProvider;
    const upLabel = UPSTREAM_LABELS[ap.upstreamProtocol] || ap.upstreamProtocol;
    const modelPart = ap.model ? ` · ${ap.model}` : '';
    const extra = p.providerCount > 1 ? ` (+${p.providerCount - 1} 渠道)` : '';
    return { ready: true, text: `🔌 ${ap.name || '默认'} · ${upLabel}${modelPart}`, extra };
  }
  return { ready: false, text: '🔌 代理未配置', extra: '' };
});
</script>

<template>
  <!-- 1Shell AI 引擎特例卡片（跨整行） -->
  <div
    v-if="variant === 'engine'"
    class="cli-card p-4 rounded-xl bg-white dark:bg-[#0b1324] md:col-span-2"
    :class="sandboxedCls"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-lg shrink-0 font-extrabold">1S</div>
        <div class="min-w-0">
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">1Shell AI 引擎</div>
          <div class="text-[10px] text-slate-400 font-mono">内置 · IDE 创作 / 主控台 AI / Skill &amp; Playbook 运行</div>
        </div>
      </div>
      <span class="status-badge shrink-0" :class="engineReady ? 'status-connected' : 'status-detected'">
        {{ engineReady ? '●' : '○' }} {{ engineReady ? '已配置' : '待配置' }}
      </span>
    </div>
    <div class="mt-3 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
      1Shell 原生 AI 引擎，驱动主控台对话、IDE 工作台创作、Skill/Playbook 执行。支持 Anthropic 和 OpenAI 兼容协议。
    </div>
    <div class="mt-1.5 text-[10px]">
      <span v-if="engineInfo" class="text-emerald-600 dark:text-emerald-400">🔌 {{ engineInfo }}</span>
      <span v-else class="text-amber-500">🔌 API 未配置 — 主控台 AI / IDE 创作 / Skill 运行均需此配置</span>
    </div>
    <div class="mt-3 flex items-center gap-1.5">
      <button
        type="button"
        class="flex-1 h-7 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400"
        @click="emit('config-engine')"
      >⚙ 配置 API</button>
    </div>
  </div>

  <!-- 普通 CLI 卡片 -->
  <div
    v-else-if="tool"
    class="cli-card p-4 rounded-xl bg-white dark:bg-[#0b1324]"
    :class="[sandboxedCls, opacityCls]"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div
          class="w-10 h-10 rounded-lg flex items-center justify-center text-white text-lg shrink-0 bg-gradient-to-br"
          :class="tool.gradient || 'from-slate-400 to-slate-500'"
        >{{ tool.icon }}</div>
        <div class="min-w-0">
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{{ tool.name }}</div>
          <div class="text-[10px] text-slate-400 font-mono truncate">{{ tool.repo }}</div>
        </div>
      </div>
      <span class="status-badge shrink-0" :class="status.cls">{{ status.icon }} {{ status.text }}</span>
    </div>

    <div class="mt-3 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">{{ tool.description }}</div>

    <div class="mt-2 flex items-center gap-1 text-[10px] text-slate-400 flex-wrap">
      <span :class="sandboxInfo.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-cyan-600 dark:text-cyan-400'">{{ sandboxInfo.text }}</span>
      <template v-if="tool.binary?.name">
        <span>·</span>
        <span :class="binaryInfo.ok ? 'text-emerald-600 dark:text-emerald-400' : ''">{{ binaryInfo.text }}</span>
      </template>
    </div>

    <div class="mt-1.5 text-[10px]">
      <span :class="proxyInfo.ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500'">{{ proxyInfo.text }}</span>
      <span v-if="proxyInfo.extra" class="text-slate-400 ml-1">{{ proxyInfo.extra }}</span>
    </div>

    <div class="mt-3 flex items-center gap-1.5">
      <!-- sandboxed: 配置 / 复制 / 重置 -->
      <template v-if="tool.status === 'sandboxed'">
        <button type="button" class="flex-1 h-7 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400" @click="emit('config', tool.id)">⚙ 配置 API</button>
        <button type="button" class="h-7 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300 text-[11px] hover:border-cyan-300 disabled:opacity-50" :disabled="!launchCommand" :title="launchCommand ? '复制启动命令' : '启动命令加载中'" @click="emit('copy-cmd', tool.id)">📋</button>
        <button type="button" class="h-7 px-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 text-[11px] font-semibold hover:bg-amber-100 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-400" title="重置沙箱" @click="emit('reset-sandbox', tool.id)">🔄</button>
      </template>

      <!-- detected: 创建沙箱 / 配置 -->
      <template v-else-if="tool.status === 'detected'">
        <button type="button" class="flex-1 h-7 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-[11px] font-semibold shadow-md hover:shadow-lg" @click="emit('ensure-sandbox', tool.id)">⚡ 创建沙箱</button>
        <button type="button" class="h-7 px-2 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400" title="配置 API 代理" @click="emit('config', tool.id)">⚙</button>
      </template>

      <!-- missing: 先安装后创建 / 配置 -->
      <template v-else>
        <button type="button" class="flex-1 h-7 rounded-lg border border-cyan-300 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400" @click="emit('ensure-sandbox', tool.id)">⚡ 先安装后创建</button>
        <button type="button" class="h-7 px-2 rounded-lg border border-cyan-200 bg-cyan-50 text-cyan-600 text-[11px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400" title="配置 API 代理" @click="emit('config', tool.id)">⚙</button>
      </template>
    </div>
  </div>
</template>

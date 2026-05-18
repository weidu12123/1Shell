<script setup lang="ts">
import { useNotifyStore } from '@/stores/notify';
import type { EndpointsResponse, DiagnosticsCheck } from '@/utils/cliSetup';

interface Props {
  endpoints: EndpointsResponse | null;
  diagnostics: DiagnosticsCheck[];
  loading: boolean;
  errorText: string | null;
}

const props = defineProps<Props>();
const notify = useNotifyStore();

async function copy(text: string, successMsg = '已复制'): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    notify.success(successMsg);
  } catch {
    notify.error('复制失败');
  }
}

function bridgeUrl() { return props.endpoints?.endpoints.bridge.url || ''; }
function mcpUrl()    { return props.endpoints?.endpoints.mcp.url    || ''; }
function bridgeProto() { return props.endpoints?.endpoints.bridge.protocol || ''; }
function mcpProto()    { return props.endpoints?.endpoints.mcp.protocol    || ''; }
function tokenMasked() { return props.endpoints?.token.masked || '****'; }
function tokenReady()  { return !!props.endpoints?.token.ready; }
</script>

<template>
  <aside class="w-72 shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
    <div class="px-4 py-3 border-b border-slate-100 dark:border-[#1e293b]">
      <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">1Shell 接入端点</div>
      <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">供 AI CLI / MCP 客户端连接</div>
    </div>

    <div class="overflow-y-auto p-4 flex flex-col gap-4 flex-1">
      <div v-if="loading" class="text-center text-slate-400 text-xs py-4">加载中...</div>
      <div v-else-if="errorText" class="text-red-400 text-xs py-4">加载失败: {{ errorText }}</div>
      <template v-else-if="endpoints">
        <!-- Bridge URL -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Bridge API</label>
            <span class="text-[10px] text-slate-400">{{ bridgeProto() }}</span>
          </div>
          <div class="flex items-center gap-1">
            <input type="text" readonly :value="bridgeUrl()" class="flex-1 h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] font-mono text-slate-700 dark:text-slate-200 outline-none" />
            <button @click="copy(bridgeUrl())" type="button" class="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-[#1e293b] text-slate-400 hover:text-cyan-500 hover:border-cyan-300 text-xs" title="复制">📋</button>
          </div>
        </div>

        <!-- MCP URL -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">MCP Server</label>
            <span class="text-[10px] text-slate-400">{{ mcpProto() }}</span>
          </div>
          <div class="flex items-center gap-1">
            <input type="text" readonly :value="mcpUrl()" class="flex-1 h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] font-mono text-slate-700 dark:text-slate-200 outline-none" />
            <button @click="copy(mcpUrl())" type="button" class="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-[#1e293b] text-slate-400 hover:text-cyan-500 hover:border-cyan-300 text-xs" title="复制">📋</button>
          </div>
        </div>

        <!-- Bridge Token -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Bridge Token</label>
            <span class="text-[10px]" :class="tokenReady() ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">{{ tokenReady() ? '✓ 已配置' : '✗ 未配置' }}</span>
          </div>
          <div class="flex items-center gap-1">
            <input type="text" readonly :value="tokenMasked()" class="flex-1 h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] font-mono text-slate-700 dark:text-slate-200 outline-none" />
            <button @click="copy(tokenMasked())" type="button" class="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-[#1e293b] text-slate-400 hover:text-cyan-500 hover:border-cyan-300 text-xs" title="复制">📋</button>
          </div>
        </div>

        <!-- 诊断 -->
        <div class="mt-2 flex flex-col gap-2">
          <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">连通性诊断</div>
          <div class="rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 divide-y divide-slate-100 dark:divide-slate-700">
            <div v-if="diagnostics.length === 0" class="p-2.5 text-[10px] text-slate-400 text-center">检测中...</div>
            <div v-else v-for="(c, i) in diagnostics" :key="i" class="p-2.5 flex items-center gap-2 text-xs">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="c.ok ? 'bg-emerald-500' : 'bg-red-500'"></span>
              <span class="flex-1 text-slate-600 dark:text-slate-300">{{ c.name }}</span>
              <span class="text-[10px]" :class="c.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">
                {{ c.ms != null ? `${c.ms}ms` : (c.detail || c.error || '') }}
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { UnresolvedHost, UnresolvedReason } from '@/composables/useGeoHosts';

defineProps<{
  unresolved: UnresolvedHost[];
}>();

const emit = defineEmits<{
  'close': [];
  'locate': [hostId: string, hostName: string];
}>();

const reasonLabel: Record<UnresolvedReason, string> = {
  'local-or-no-ip': '本机或无 IP',
  'dns-failed': '域名解析失败',
  'private-ip': '私有网段',
  'no-data': '在线定位无结果',
  'timeout': '在线定位超时',
};

function close(): void { emit('close'); }
function onLocate(host: UnresolvedHost): void {
  emit('locate', host.id, host.name);
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" @click="close">
    <div class="w-[26rem] max-w-[90vw] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5" @click.stop>
      <div class="flex items-center justify-between mb-3">
        <div class="text-lg font-semibold text-slate-100">未定位主机</div>
        <button class="text-slate-400 hover:text-slate-200" @click="close">✕</button>
      </div>
      <div v-if="unresolved.length === 0" class="text-sm text-slate-400 py-6 text-center">
        所有主机都已成功定位
      </div>
      <ul v-else class="space-y-2 max-h-96 overflow-y-auto">
        <li
          v-for="h in unresolved"
          :key="h.id"
          class="px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700 flex items-center gap-3"
        >
          <div class="flex-1 min-w-0">
            <div class="font-medium text-slate-200 truncate">{{ h.name }}</div>
            <div class="text-xs text-slate-400 mt-0.5">{{ reasonLabel[h.reason] || h.reason }}</div>
          </div>
          <button
            type="button"
            class="shrink-0 px-2.5 h-8 rounded-lg text-xs font-medium border border-sky-700 text-sky-300 hover:bg-sky-900/40 transition"
            @click="onLocate(h)"
          >📍 手动定位</button>
        </li>
      </ul>
    </div>
  </div>
</template>

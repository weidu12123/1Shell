<script setup lang="ts">
import { computed } from 'vue';
import type { GeoHost } from '@/composables/useGeoHosts';

const props = defineProps<{
  host: GeoHost;
  x: number;
  y: number;
}>();

const emit = defineEmits<{
  'connect': [hostId: string];
  'close': [];
  'locate': [hostId: string, hostName: string];
}>();

const hasProbeStatus = computed(() => typeof props.host.online === 'boolean');
const isOnline = computed(() => props.host.online === true);
const statusText = computed(() => {
  if (!hasProbeStatus.value) return '未探测';
  const source = props.host.probeSource === 'agent' || props.host.probeSource === 'relay_agent' ? '探针' : '主动探测';
  const stale = props.host.stale ? ' · 可能过期' : '';
  return `${isOnline.value ? '在线' : '离线'} · ${source}${stale}`;
});

// Convert ISO country code (e.g. "US") to flag emoji using regional indicator symbols
function flagEmoji(code: string | null): string {
  if (!code || code.length !== 2) return '🌐';
  const base = 0x1F1E6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(base + code.toUpperCase().charCodeAt(0))
       + String.fromCodePoint(base + code.toUpperCase().charCodeAt(1));
}

// Auto-flip to left of cursor if too close to right edge.
const positionStyle = computed(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tooltipH = 140;
  const flipX = props.x > vw - 280;
  const flipY = props.y + tooltipH > vh;
  return {
    left: flipX ? `${props.x - 260}px` : `${props.x + 14}px`,
    top: flipY ? `${props.y - tooltipH}px` : `${props.y - 10}px`,
  };
});

const locationText = computed(() => {
  const parts = [props.host.regionName, props.host.city].filter(Boolean);
  return parts.length ? parts.join(' · ') : '';
});

function onConnect(): void {
  emit('connect', props.host.id);
}

function onLocate(): void {
  emit('locate', props.host.id, props.host.name);
}

const isManual = computed(() => props.host.source === 'manual');
</script>

<template>
  <div
    class="host-tooltip fixed z-50 w-60 max-w-[90vw] p-3 rounded-xl bg-slate-900/90 backdrop-blur-md border border-slate-700 shadow-2xl text-slate-100 text-sm"
    :style="positionStyle"
    @click.stop
  >
    <div class="flex items-center gap-2">
      <span class="text-lg">{{ flagEmoji(host.countryCode) }}</span>
      <span class="font-semibold truncate">{{ host.name }}</span>
    </div>
    <div class="mt-1 text-xs text-slate-400 truncate">
      {{ host.ip }}<span v-if="locationText"> · {{ locationText }}</span>
    </div>
    <div
      class="mt-2 flex items-center gap-1.5 text-xs"
      :class="isOnline ? 'text-emerald-300' : 'text-slate-400'"
    >
      <span
        class="inline-block w-1.5 h-1.5 rounded-full"
        :class="isOnline
          ? 'bg-emerald-400 shadow-[0_0_6px_rgb(52,211,153)]'
          : 'bg-slate-500'"
      ></span>
      <span>{{ statusText }}</span>
    </div>
    <div v-if="isManual" class="mt-1 text-[11px] text-amber-300/90 flex items-center gap-1">
      <span>📍</span><span>手动定位</span>
    </div>
    <div class="mt-3 flex items-center gap-2">
      <button
        type="button"
        class="flex-1 h-8 rounded-lg bg-gradient-to-r from-sky-500 to-blue-600 text-white font-medium text-xs hover:shadow-lg transition-all"
        @click="onConnect"
      >
        立即连接 →
      </button>
      <button
        type="button"
        class="shrink-0 h-8 px-2.5 rounded-lg text-xs border border-slate-600 text-slate-300 hover:bg-slate-800 transition"
        :title="isManual ? '修改手动定位' : '手动定位'"
        @click="onLocate"
      >📍</button>
    </div>
  </div>
</template>

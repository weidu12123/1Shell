<script setup lang="ts">
import { computed } from 'vue';
import type { GeoHost, UnresolvedHost } from '@/composables/useGeoHosts';

const props = defineProps<{
  hosts: GeoHost[];
  unresolved: UnresolvedHost[];
}>();

const emit = defineEmits<{
  'show-unresolved': [];
}>();

const countryCount = computed(() => new Set(props.hosts.map((h) => h.countryCode).filter(Boolean)).size);
const cityCount = computed(() => new Set(props.hosts.map((h) => `${h.countryCode}:${h.city}`).filter((s) => !s.endsWith(':null'))).size);

function showUnresolved(): void {
  emit('show-unresolved');
}
</script>

<template>
  <div class="home-hud absolute bottom-8 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-slate-900/60 backdrop-blur border border-slate-700 text-xs text-slate-300 flex items-center gap-3">
    <span><span class="text-cyan-300 font-semibold">{{ hosts.length }}</span> hosts</span>
    <span class="text-slate-600">·</span>
    <span><span class="text-cyan-300 font-semibold">{{ countryCount }}</span> countries</span>
    <span class="text-slate-600">·</span>
    <span><span class="text-cyan-300 font-semibold">{{ cityCount }}</span> cities</span>
    <button
      v-if="unresolved.length > 0"
      type="button"
      class="ml-2 px-2 py-0.5 rounded-md bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors"
      @click="showUnresolved"
    >
      {{ unresolved.length }} 未定位
    </button>
  </div>
</template>

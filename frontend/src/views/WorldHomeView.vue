<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import WorldVectorMap from '@/components/home/WorldVectorMap.vue';
import HostTooltip from '@/components/home/HostTooltip.vue';
import HomeBrand from '@/components/home/HomeBrand.vue';
import HomeHud from '@/components/home/HomeHud.vue';
import HomeSidePanels from '@/components/home/HomeSidePanels.vue';
import UnresolvedModal from '@/components/home/UnresolvedModal.vue';
import ManualLocationModal from '@/components/home/ManualLocationModal.vue';
import { useGeoHosts, type GeoHost } from '@/composables/useGeoHosts';

const router = useRouter();
const geo = useGeoHosts();

const stageRef = ref<HTMLDivElement | null>(null);
const mapRef = ref<HTMLDivElement | null>(null);
const width = ref(1200);
const height = ref(700);

const activeTooltip = ref<{ host: GeoHost; x: number; y: number } | null>(null);
const showUnresolved = ref(false);

interface LocateTarget {
  hostId: string;
  hostName: string;
  existing: {
    countryCode: string | null;
    country: string | null;
    city: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
}
const locateTarget = ref<LocateTarget | null>(null);

const isEmpty = computed(() => geo.hosts.value.length === 0 && geo.unresolved.value.length === 0 && !geo.loading.value);

function updateSize(): void {
  const el = mapRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  width.value = rect.width;
  height.value = rect.height;
}

function onNodeClick(host: GeoHost, x: number, y: number): void {
  // toggle: same host → close
  if (activeTooltip.value?.host.id === host.id) {
    activeTooltip.value = null;
    return;
  }
  activeTooltip.value = { host, x, y };
}

function onStageClick(): void {
  activeTooltip.value = null;
}

function onConnect(hostId: string): void {
  router.push({ path: '/console', query: { host: hostId } });
}

function onLocateFromTooltip(hostId: string, hostName: string): void {
  // 已定位的主机：existing 取自 GeoHost 当前数据（手动或自动均可作为初值）
  const h = geo.hosts.value.find((x) => x.id === hostId);
  locateTarget.value = {
    hostId,
    hostName,
    existing: h
      ? {
          countryCode: h.countryCode,
          country: h.country,
          city: h.city,
          lat: h.lat,
          lng: h.lng,
        }
      : null,
  };
  activeTooltip.value = null;
}

function onLocateFromUnresolved(hostId: string, hostName: string): void {
  // 未定位的主机：existing 必为 null
  locateTarget.value = { hostId, hostName, existing: null };
  showUnresolved.value = false;
}

async function onLocateSaved(): Promise<void> {
  // 重新拉一次地理数据，旗帜立刻刷新到新位置
  await geo.refresh(true);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') activeTooltip.value = null;
}

onMounted(async () => {
  updateSize();
  window.addEventListener('resize', updateSize);
  window.addEventListener('keydown', onKey);
  await geo.refresh();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateSize);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="home-stage w-full h-full relative" @click="onStageClick" style="overflow: hidden;">
    <div ref="stageRef" class="w-full h-full relative">
      <div ref="mapRef" class="map-area">
        <WorldVectorMap
          :hosts="geo.hosts.value"
          :width="width"
          :height="height"
          class="map-enter"
          @node-click="onNodeClick"
        />
      </div>
      <HomeBrand class="brand-enter" />
      <HomeSidePanels class="side-enter" />
      <HomeHud
        :hosts="geo.hosts.value"
        :unresolved="geo.unresolved.value"
        class="hud-enter"
        @show-unresolved="showUnresolved = true"
      />
      <!-- 空状态：没有主机 -->
      <div
        v-if="isEmpty"
        class="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
        <div class="px-6 py-4 rounded-2xl bg-slate-900/80 backdrop-blur border border-slate-700 text-center pointer-events-auto">
          <div class="text-lg font-semibold text-slate-100">还没有 VPS</div>
          <div class="mt-1 text-sm text-slate-400">去主控添加第一台主机</div>
          <button
            type="button"
            class="mt-3 px-4 h-8 rounded-lg bg-gradient-to-r from-sky-500 to-blue-600 text-white text-sm hover:shadow-lg"
            @click.stop="router.push('/console')"
          >
            打开主控 →
          </button>
        </div>
      </div>
      <HostTooltip
        v-if="activeTooltip"
        :host="activeTooltip.host"
        :x="activeTooltip.x"
        :y="activeTooltip.y"
        @connect="onConnect"
        @locate="onLocateFromTooltip"
        @close="activeTooltip = null"
      />
      <UnresolvedModal
        v-if="showUnresolved"
        :unresolved="geo.unresolved.value"
        @close="showUnresolved = false"
        @locate="onLocateFromUnresolved"
      />
      <ManualLocationModal
        v-if="locateTarget"
        :host-id="locateTarget.hostId"
        :host-name="locateTarget.hostName"
        :existing="locateTarget.existing"
        @close="locateTarget = null"
        @saved="onLocateSaved"
      />
    </div>
  </div>
</template>

<style scoped>
.map-area {
  position: absolute;
  left: 50%;
  bottom: -3%;
  transform: translateX(-50%);
  width: 115%;
  height: 85%;
  pointer-events: auto;
  overflow: visible;
}
.map-enter {
  animation: map-in 600ms ease-out 200ms both;
}
.brand-enter {
  animation: brand-in 400ms ease-out 600ms both;
}
.hud-enter {
  animation: hud-in 400ms ease-out 600ms both;
}
.side-enter {
  animation: hud-in 500ms ease-out 700ms both;
}
@keyframes map-in {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes brand-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes hud-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .map-enter, .brand-enter, .hud-enter { animation: none; }
}
@media (max-width: 640px) {
  /* Brand a bit smaller and tighter to top */
  .home-stage :deep(.home-brand) > div:first-child { font-size: 2rem; }
  .home-stage :deep(.home-brand) { top: 1rem; }
  /* HUD wraps to two lines if needed */
  .home-stage :deep(.home-hud) { bottom: 1rem; flex-wrap: wrap; max-width: 90vw; }
}
</style>

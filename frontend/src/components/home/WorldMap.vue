<script setup lang="ts">
import { computed } from 'vue';
import { geoEqualEarth, geoPath, geoGraticule10, geoContains, type GeoProjection } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { GeoHost } from '@/composables/useGeoHosts';
import worldTopo from '@/assets/world-110m.json';

const props = defineProps<{
  hosts: GeoHost[];
  width: number;
  height: number;
}>();

const emit = defineEmits<{
  'node-click': [host: GeoHost, x: number, y: number];
}>();

// world-atlas v2 topojson exposes 'countries' object
const topology = worldTopo as unknown as Topology;
const countriesFC = computed(
  () => feature(topology, topology.objects.countries as any) as unknown as GeoJSON.FeatureCollection,
);

const projection = computed<GeoProjection>(() => {
  return geoEqualEarth().fitSize([props.width, props.height], countriesFC.value);
});

const pathGen = computed(() => geoPath(projection.value));

const graticulePath = computed(() => pathGen.value(geoGraticule10()) || '');

// Outline of all land combined → used for atmosphere mask + outer glow
const landSpherePath = computed(() => pathGen.value({ type: 'Sphere' } as any) || '');

interface PlacedNode {
  host: GeoHost;
  x: number;
  y: number;
}

// hash → stable jitter offset (px) for hosts at identical coords
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function jitter(hostId: string): { dx: number; dy: number } {
  const h = hashStr(hostId);
  const angle = (h % 360) * (Math.PI / 180);
  const r = 4 + (h % 7);
  return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r };
}

const placedNodes = computed<PlacedNode[]>(() => {
  const proj = projection.value;
  const groups = new Map<string, GeoHost[]>();
  for (const h of props.hosts) {
    const key = `${h.lat.toFixed(4)},${h.lng.toFixed(4)}`;
    const arr = groups.get(key) || [];
    arr.push(h);
    groups.set(key, arr);
  }
  const out: PlacedNode[] = [];
  for (const arr of groups.values()) {
    for (const h of arr) {
      const xy = proj([h.lng, h.lat]);
      if (!xy) continue;
      let [x, y] = xy;
      if (arr.length > 1) {
        const j = jitter(h.id);
        x += j.dx;
        y += j.dy;
      }
      out.push({ host: h, x, y });
    }
  }
  return out;
});

// Pre-compute which country features contain at least one host point.
// Using d3-geo.geoContains avoids needing an ISO alpha2 → numeric mapping.
const litCountryIds = computed<Set<string | number>>(() => {
  const lit = new Set<string | number>();
  if (props.hosts.length === 0) return lit;
  for (const f of countriesFC.value.features) {
    const id = f.id ?? '';
    if (lit.has(id)) continue;
    for (const h of props.hosts) {
      if (geoContains(f as any, [h.lng, h.lat])) {
        lit.add(id);
        break;
      }
    }
  }
  return lit;
});

const countryPaths = computed(() => {
  const gen = pathGen.value;
  return countriesFC.value.features.map((f, i) => {
    const id = f.id ?? i;
    return {
      d: gen(f) || '',
      key: id,
      lit: litCountryIds.value.has(id),
    };
  });
});

function onNodeClick(node: PlacedNode, ev: MouseEvent): void {
  emit('node-click', node.host, ev.clientX, ev.clientY);
}
</script>

<template>
  <svg
    :viewBox="`0 0 ${width} ${height}`"
    :width="width"
    :height="height"
    class="world-map"
    role="img"
    aria-label="世界地图 — 1Shell 全球部署"
  >
    <defs>
      <!-- 大气层径向光晕（背景） -->
      <radialGradient id="atmosphere" cx="50%" cy="50%" r="62%">
        <stop offset="0%" stop-color="#0c4a6e" stop-opacity="0.0" />
        <stop offset="55%" stop-color="#0c4a6e" stop-opacity="0.18" />
        <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0" />
      </radialGradient>

      <!-- 默认陆地渐变（深邃但不死黑） -->
      <linearGradient id="landGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#27406b" />
        <stop offset="55%" stop-color="#1c3155" />
        <stop offset="100%" stop-color="#0f1d35" />
      </linearGradient>

      <!-- 点亮国家陆地渐变（蓝-青-紫，发光感） -->
      <linearGradient id="landLitGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#22d3ee" />
        <stop offset="55%" stop-color="#0ea5e9" />
        <stop offset="100%" stop-color="#3b82f6" />
      </linearGradient>

      <!-- 节点光晕 radial gradient（让 host 周围那一块亮起来） -->
      <radialGradient id="nodeHalo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgb(125, 211, 252)" stop-opacity="0.55" />
        <stop offset="35%" stop-color="rgb(56, 189, 248)" stop-opacity="0.28" />
        <stop offset="70%" stop-color="rgb(14, 165, 233)" stop-opacity="0.08" />
        <stop offset="100%" stop-color="rgb(14, 165, 233)" stop-opacity="0" />
      </radialGradient>

      <!-- 点亮国家的高斯模糊滤镜（外辉光） -->
      <filter id="litGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2.4" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>

    <!-- 背景大气层圆 -->
    <rect :width="width" :height="height" fill="url(#atmosphere)" />

    <!-- 经纬网 -->
    <g class="graticule">
      <path :d="graticulePath" />
    </g>

    <!-- 全部陆地外轮廓（提供一个微弱的整体外辉光） -->
    <g class="land-aura">
      <path :d="landSpherePath" />
    </g>

    <!-- 国家：分两层，未点亮在下，点亮在上确保 z-order -->
    <g class="countries">
      <path
        v-for="p in countryPaths"
        v-show="!p.lit"
        :key="`c-${p.key}`"
        :d="p.d"
        class="country"
      />
    </g>
    <g class="countries-lit">
      <path
        v-for="p in countryPaths"
        v-show="p.lit"
        :key="`l-${p.key}`"
        :d="p.d"
        class="country country-lit"
      />
    </g>

    <!-- 节点光晕（在国家之上、节点本体之下） -->
    <g class="halos">
      <circle
        v-for="n in placedNodes"
        :key="`h-${n.host.id}`"
        :cx="n.x"
        :cy="n.y"
        r="46"
        class="halo"
      />
    </g>

    <!-- 节点本体 + 涟漪 -->
    <g class="nodes">
      <g
        v-for="n in placedNodes"
        :key="n.host.id"
        :transform="`translate(${n.x},${n.y})`"
        class="node-group"
        @click.stop="onNodeClick(n, $event)"
      >
        <circle r="5" class="node-ripple" />
        <circle r="3.5" class="node-core" />
        <circle r="2" class="node-dot" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.world-map {
  display: block;
}

/* ---------- 经纬网 ---------- */
.graticule path {
  fill: none;
  stroke: rgb(148 163 184 / 0.08);
  stroke-width: 0.5;
}

/* ---------- 全球外轮廓辉光 ---------- */
.land-aura path {
  fill: none;
  stroke: rgb(56 189 248 / 0.06);
  stroke-width: 1;
  filter: blur(1px);
}

/* ---------- 默认陆地 ---------- */
.country {
  fill: url(#landGrad);
  stroke: rgb(100 139 195 / 0.35);
  stroke-width: 0.4;
  transition: fill 400ms ease, stroke 400ms ease, filter 400ms ease;
}

/* ---------- 点亮国家 ---------- */
.country-lit {
  fill: url(#landLitGrad);
  stroke: rgb(125 211 252 / 0.85);
  stroke-width: 0.7;
  filter: url(#litGlow)
    drop-shadow(0 0 6px rgb(56 189 248 / 0.55))
    drop-shadow(0 0 14px rgb(14 165 233 / 0.35));
  animation: country-breathe 4.2s ease-in-out infinite;
}

@keyframes country-breathe {
  0%,
  100% {
    opacity: 0.92;
  }
  50% {
    opacity: 1;
  }
}

/* ---------- 节点光晕（让该区域整体亮起来） ---------- */
.halo {
  fill: url(#nodeHalo);
  pointer-events: none;
  animation: halo-pulse 3.6s ease-in-out infinite;
  transform-origin: center;
  transform-box: fill-box;
}

@keyframes halo-pulse {
  0%,
  100% {
    opacity: 0.85;
    transform: scale(0.95);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

/* ---------- 节点本体 ---------- */
.node-group {
  cursor: pointer;
}
.node-core {
  fill: rgb(56 189 248);
  filter: drop-shadow(0 0 4px rgb(125 211 252 / 0.95))
    drop-shadow(0 0 10px rgb(56 189 248 / 0.7));
  transition: r 0.2s;
}
.node-dot {
  fill: rgb(240 249 255);
  filter: drop-shadow(0 0 3px rgb(255 255 255 / 0.9));
}
.node-group:hover .node-core {
  r: 5;
}

/* ---------- 涟漪 ---------- */
.node-ripple {
  fill: none;
  stroke: rgb(125 211 252);
  stroke-width: 1.5;
  opacity: 0;
  pointer-events: none;
  transform-origin: center;
  animation: node-ripple 2.4s ease-out infinite;
}
@keyframes node-ripple {
  0% {
    r: 5;
    opacity: 0.7;
    stroke-width: 1.5;
  }
  100% {
    r: 26;
    opacity: 0;
    stroke-width: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .node-ripple,
  .country-lit,
  .halo {
    animation: none;
  }
}

/* ---------- 浅色主题 ---------- */
:global(html:not(.dark)) .country {
  fill: rgb(226 232 240 / 0.85);
  stroke: rgb(148 163 184 / 0.55);
}
:global(html:not(.dark)) .country-lit {
  fill: url(#landLitGrad);
  stroke: rgb(14 165 233 / 0.85);
  filter: drop-shadow(0 0 6px rgb(14 165 233 / 0.45))
    drop-shadow(0 0 12px rgb(56 189 248 / 0.3));
}
:global(html:not(.dark)) .graticule path {
  stroke: rgb(100 116 139 / 0.18);
}
:global(html:not(.dark)) .land-aura path {
  stroke: rgb(14 165 233 / 0.08);
}
:global(html:not(.dark)) .halo {
  opacity: 0.7;
}
:global(html:not(.dark)) .node-core {
  fill: rgb(14 165 233);
  filter: drop-shadow(0 0 4px rgb(14 165 233 / 0.7))
    drop-shadow(0 0 10px rgb(56 189 248 / 0.45));
}
:global(html:not(.dark)) .node-dot {
  fill: rgb(255 255 255);
}
:global(html:not(.dark)) .node-ripple {
  stroke: rgb(14 165 233);
}
</style>

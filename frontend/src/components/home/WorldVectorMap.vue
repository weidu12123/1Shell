<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { feature } from 'topojson-client';
import { geoContains, geoGraticule, geoNaturalEarth1, geoPath } from 'd3-geo';
import type { Topology } from 'topojson-specification';
import worldTopo from '@/assets/world-110m.json';
import type { GeoHost } from '@/composables/useGeoHosts';

const props = defineProps<{
  hosts: GeoHost[];
  width: number;
  height: number;
}>();

const emit = defineEmits<{
  'node-click': [host: GeoHost, x: number, y: number];
}>();

const topology = worldTopo as unknown as Topology;
const countriesFC = feature(
  topology,
  topology.objects.countries as any,
) as unknown as GeoJSON.FeatureCollection;
const graticule = geoGraticule().step([20, 20]);

function flagEmoji(code: string | null): string {
  if (!code || code.length !== 2) return '🌐';
  const base = 0x1F1E6 - 'A'.charCodeAt(0);
  const upper = code.toUpperCase();
  return String.fromCodePoint(base + upper.charCodeAt(0)) + String.fromCodePoint(base + upper.charCodeAt(1));
}

function flagLabel(code: string | null): string {
  if (!code || code.length !== 2) return '??';
  return code.toUpperCase();
}

const svgRef = ref<SVGSVGElement | null>(null);
const isDark = ref(true);
let themeObserver: MutationObserver | null = null;

// Ellipse shape defined by container dimensions (CSS-driven, decoupled from projection aspect).
const ellipse = computed(() => {
  const w = Math.max(1, props.width);
  const h = Math.max(1, props.height);
  return {
    cx: w / 2,
    cy: h / 2,
    rx: w / 2 - 6,
    ry: h / 2 - 6,
  };
});

// Projection: NaturalEarth, cover-fit container width so world fills horizontally even on wide containers.
// Polar regions get clipped vertically — acceptable since they have no hosts.
const projection = computed(() => {
  const w = Math.max(1, props.width);
  const h = Math.max(1, props.height);
  const p = geoNaturalEarth1();
  // initial fit
  p.fitExtent(
    [
      [0, 0],
      [w, h],
    ],
    { type: 'Sphere' } as any,
  );
  // compute current sphere width, then scale to cover container width
  const b = geoPath(p).bounds({ type: 'Sphere' } as any);
  const sphereW = b[1][0] - b[0][0];
  const targetW = w * 1.0; // cover 100% of container width
  if (sphereW > 0 && targetW > sphereW) {
    p.scale((p.scale() * targetW) / sphereW);
  }
  p.translate([w / 2, h / 2]);
  return p;
});

const pathFn = computed(() => geoPath(projection.value));

const graticuleD = computed(() => pathFn.value(graticule()) || '');

// Star particles for backdrop
const stars = computed(() => {
  const w = Math.max(1, props.width);
  const h = Math.max(1, props.height);
  const count = Math.max(50, Math.floor((w * h) / 7000));
  const out: Array<{ x: number; y: number; r: number; o: number }> = [];
  let seed = 1337;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < count; i++) {
    out.push({
      x: rand() * w,
      y: rand() * h,
      r: 0.4 + rand() * 1.3,
      o: 0.25 + rand() * 0.6,
    });
  }
  return out;
});

interface MapRegion {
  key: string;
  feature: any;
}

function splitCountryFeature(f: any, countryIndex: number): MapRegion[] {
  const geom = f.geometry;
  if (!geom) return [];
  if (geom.type === 'Polygon') {
    return [{ key: `c${countryIndex}-p0`, feature: f }];
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.map((coordinates: unknown, polygonIndex: number) => ({
      key: `c${countryIndex}-p${polygonIndex}`,
      feature: {
        type: 'Feature',
        id: `${f.id ?? countryIndex}:${polygonIndex}`,
        properties: f.properties,
        geometry: { type: 'Polygon', coordinates },
      },
    }));
  }
  return [];
}

const countryRegions = computed(() =>
  countriesFC.features.flatMap((f, i) => splitCountryFeature(f as any, i)),
);

// 国家整体高亮：只要该国境内有任意一台 host，整个国家就点亮。
// 不再尝试在省级（admin1）层做精确匹配——IP 地理库精度有限，
// 用 admin1 反而会把"湖北的主机"高亮成"河南"，比国家级高亮更误导。
const countryPaths = computed(() =>
  countryRegions.value.map((region) => ({
    key: region.key,
    d: pathFn.value(region.feature) || '',
    lit: props.hosts.some((h) => geoContains(region.feature, [h.lng, h.lat])),
  })),
);

const nodes = computed(() =>
  props.hosts
    .map((h) => {
      const xy = projection.value([h.lng, h.lat]);
      return xy ? { host: h, x: xy[0], y: xy[1] } : null;
    })
    .filter((n): n is { host: GeoHost; x: number; y: number } => n !== null),
);


const transform = ref({ x: 0, y: 0, k: 1 });

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function zoomAt(px: number, py: number, factor: number): void {
  const newK = clamp(transform.value.k * factor, 1, 8);
  const ratio = newK / transform.value.k;
  transform.value = {
    x: px - (px - transform.value.x) * ratio,
    y: py - (py - transform.value.y) * ratio,
    k: newK,
  };
  clampPan();
}

function clampPan(): void {
  const w = Math.max(1, props.width);
  const h = Math.max(1, props.height);
  const k = transform.value.k;
  // Allow generous overscroll so users can drag the world to any corner.
  // Slack grows with zoom level so high-zoom panning isn't artificially capped.
  const slackX = w * (0.5 + 0.15 * (k - 1));
  const slackY = h * (0.5 + 0.15 * (k - 1));
  const maxX = (w * (k - 1)) / 2 + slackX;
  const maxY = (h * (k - 1)) / 2 + slackY;
  transform.value = {
    ...transform.value,
    x: clamp(transform.value.x, -maxX, maxX),
    y: clamp(transform.value.y, -maxY, maxY),
  };
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (!svgRef.value) return;
  const rect = svgRef.value.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.18 : 0.85;
  zoomAt(px, py, factor);
}

let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginX = 0;
let dragOriginY = 0;
let didDrag = false;

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  dragging = true;
  didDrag = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragOriginX = transform.value.x;
  dragOriginY = transform.value.y;
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  if (!didDrag && Math.abs(dx) + Math.abs(dy) > 3) didDrag = true;
  transform.value = {
    ...transform.value,
    x: dragOriginX + dx,
    y: dragOriginY + dy,
  };
  clampPan();
}

function onPointerUp(e: PointerEvent): void {
  dragging = false;
  try {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  } catch {
    /* noop */
  }
}

function onNodePointerDown(e: PointerEvent): void {
  didDrag = false;
  e.stopPropagation();
}

function onNodePointerUp(e: PointerEvent): void {
  e.stopPropagation();
}

function onNodeClick(host: GeoHost, e: MouseEvent): void {
  e.stopPropagation();
  emit('node-click', host, e.clientX, e.clientY);
}

function zoomCenter(factor: number): void {
  if (!svgRef.value) return;
  const rect = svgRef.value.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
}

function resetView(): void {
  transform.value = { x: 0, y: 0, k: 1 };
}

const transformStr = computed(
  () => `translate(${transform.value.x}, ${transform.value.y}) scale(${transform.value.k})`,
);

const strokeScale = computed(() => 1 / transform.value.k);
const hoveredId = ref<string | null>(null);

function detectTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

onMounted(() => {
  isDark.value = detectTheme();
  themeObserver = new MutationObserver(() => {
    isDark.value = detectTheme();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
});

const uid = Math.random().toString(36).slice(2, 8);
</script>

<template>
  <div
    class="world-vector-map"
    :style="{ width: width + 'px', height: height + 'px' }"
    role="img"
    aria-label="1Shell 全球部署矢量地图"
  >
    <svg
      ref="svgRef"
      class="map-svg"
      :viewBox="`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`"
      :width="width"
      :height="height"
    >
      <defs>
        <!-- Ocean radial gradient -->
        <radialGradient :id="`wm-ocean-dark-${uid}`" cx="50%" cy="48%" r="62%">
          <stop offset="0%" stop-color="#143a64" />
          <stop offset="55%" stop-color="#0a1f3d" />
          <stop offset="100%" stop-color="#040c1d" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="`wm-ocean-light-${uid}`" cx="50%" cy="45%" r="65%">
          <stop offset="0%" stop-color="#e0ebf9" />
          <stop offset="55%" stop-color="#d6e3f3" stop-opacity="0.85" />
          <stop offset="100%" stop-color="#eef5ff" stop-opacity="0" />
        </radialGradient>

        <!-- Land gradients -->
        <linearGradient :id="`wm-land-dark-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2c5a8c" />
          <stop offset="100%" stop-color="#163459" />
        </linearGradient>
        <linearGradient :id="`wm-land-light-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="100%" stop-color="#dbe5f1" />
        </linearGradient>

        <linearGradient :id="`wm-land-lit-dark-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3edbf5" />
          <stop offset="100%" stop-color="#0e7b9c" />
        </linearGradient>
        <linearGradient :id="`wm-land-lit-light-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fca5a5" />
          <stop offset="100%" stop-color="#b91c1c" />
        </linearGradient>

        <!-- Flag face gradient (light theme = red; dark theme reuses land-lit) -->
        <linearGradient :id="`wm-flag-light-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f87171" />
          <stop offset="100%" stop-color="#991b1b" />
        </linearGradient>

        <radialGradient :id="`wm-halo-${uid}`" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#67e8f9" stop-opacity="0.85" />
          <stop offset="55%" stop-color="#22d3ee" stop-opacity="0.3" />
          <stop offset="100%" stop-color="#22d3ee" stop-opacity="0" />
        </radialGradient>

        <!-- Outer halo bloom -->
        <radialGradient :id="`wm-outer-dark-${uid}`" cx="50%" cy="50%" r="55%">
          <stop offset="48%" stop-color="#22d3ee" stop-opacity="0" />
          <stop offset="62%" stop-color="#22d3ee" stop-opacity="0.18" />
          <stop offset="80%" stop-color="#22d3ee" stop-opacity="0.06" />
          <stop offset="100%" stop-color="#22d3ee" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="`wm-outer-light-${uid}`" cx="50%" cy="50%" r="58%">
          <stop offset="48%" stop-color="#7dd3fc" stop-opacity="0" />
          <stop offset="62%" stop-color="#38bdf8" stop-opacity="0.16" />
          <stop offset="80%" stop-color="#0ea5e9" stop-opacity="0.06" />
          <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0" />
        </radialGradient>

        <!-- Inner soft vignette inside ellipse -->
        <radialGradient :id="`wm-inner-${uid}`" cx="50%" cy="50%" r="50%">
          <stop offset="78%" stop-color="#000" stop-opacity="0" />
          <stop offset="100%" stop-color="#000" stop-opacity="0.35" />
        </radialGradient>
        <radialGradient :id="`wm-inner-light-${uid}`" cx="50%" cy="50%" r="50%">
          <stop offset="78%" stop-color="#1e3a5f" stop-opacity="0" />
          <stop offset="100%" stop-color="#1e3a5f" stop-opacity="0.18" />
        </radialGradient>

        <radialGradient :id="`wm-highlight-light-${uid}`" cx="50%" cy="20%" r="40%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.5" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="`wm-highlight-dark-${uid}`" cx="50%" cy="22%" r="42%">
          <stop offset="0%" stop-color="#9be7ff" stop-opacity="0.16" />
          <stop offset="100%" stop-color="#9be7ff" stop-opacity="0" />
        </radialGradient>

        <filter :id="`wm-glow-${uid}`" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <!-- Explicit ellipse clipPath (decoupled from projection sphere) -->
        <clipPath :id="`wm-clip-${uid}`">
          <ellipse :cx="ellipse.cx" :cy="ellipse.cy" :rx="ellipse.rx" :ry="ellipse.ry" />
        </clipPath>
      </defs>

      <!-- Star field (dark only) -->
      <g v-if="isDark" class="stars" pointer-events="none">
        <circle
          v-for="(s, i) in stars"
          :key="i"
          :cx="s.x"
          :cy="s.y"
          :r="s.r"
          fill="#cfe8ff"
          :fill-opacity="s.o"
        />
      </g>

      <!-- Outer halo bloom (atmosphere imitation — dark mode only) -->
      <ellipse
        v-if="isDark"
        :cx="ellipse.cx"
        :cy="ellipse.cy"
        :rx="ellipse.rx * 1.12"
        :ry="ellipse.ry * 1.18"
        :fill="`url(#wm-outer-dark-${uid})`"
        pointer-events="none"
      />

      <!-- Ocean fill -->
      <ellipse
        :cx="ellipse.cx"
        :cy="ellipse.cy"
        :rx="ellipse.rx"
        :ry="ellipse.ry"
        :fill="isDark ? `url(#wm-ocean-dark-${uid})` : `url(#wm-ocean-light-${uid})`"
      />

      <!-- Clipped world content (pan/zoom inside ellipse) -->
      <g :clip-path="`url(#wm-clip-${uid})`">
        <g
          :transform="transformStr"
          class="map-group"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <!-- Transparent backdrop for pointer events inside ellipse -->
          <rect
            x="-2000"
            y="-2000"
            :width="Math.max(1, props.width) + 4000"
            :height="Math.max(1, props.height) + 4000"
            fill="transparent"
          />

          <!-- Graticule -->
          <path
            :d="graticuleD"
            fill="none"
            :stroke="isDark ? '#3aa7c8' : '#7a9bbf'"
            :stroke-opacity="isDark ? 0.24 : 0.3"
            :stroke-width="0.5 * strokeScale"
            stroke-dasharray="1.5,3"
            pointer-events="none"
          />

          <!-- Countries -->
          <g class="countries">
            <path
              v-for="c in countryPaths"
              :key="c.key"
              :d="c.d"
              :fill="
                c.lit
                  ? isDark
                    ? `url(#wm-land-lit-dark-${uid})`
                    : `url(#wm-land-lit-light-${uid})`
                  : isDark
                  ? `url(#wm-land-dark-${uid})`
                  : `url(#wm-land-light-${uid})`
              "
              :stroke="
                c.lit
                  ? isDark
                    ? '#67e8f9'
                    : '#991b1b'
                  : isDark
                  ? 'rgba(150, 200, 240, 0.42)'
                  : 'rgba(100, 116, 139, 0.5)'
              "
              :stroke-width="(c.lit ? 0.9 : 0.55) * strokeScale"
              :filter="c.lit ? `url(#wm-glow-${uid})` : undefined"
              class="country"
            />
          </g>

          <!-- Flag nodes -->
          <g class="nodes">
            <g
              v-for="n in nodes"
              :key="n.host.id"
              class="flag-node"
              :class="{ 'is-hover': hoveredId === n.host.id }"
              :transform="`translate(${n.x}, ${n.y})`"
              @pointerdown="onNodePointerDown"
              @pointerup="onNodePointerUp"
              @pointercancel.stop
              @click="onNodeClick(n.host, $event)"
              @pointerenter="hoveredId = n.host.id"
              @pointerleave="hoveredId = null"
            >
              <!-- hit area covers whole flag silhouette -->
              <rect
                class="hit-area"
                x="-6"
                y="-40"
                width="30"
                height="44"
                fill="transparent"
                pointer-events="all"
              />
              <!-- flagpole outline (white backing for contrast on red lands) -->
              <line
                class="pole-outline"
                x1="0"
                y1="0"
                x2="0"
                y2="-34"
                :stroke="isDark ? '#0b1e3a' : '#ffffff'"
                stroke-width="3.6"
                stroke-linecap="round"
                pointer-events="none"
              />
              <!-- flagpole -->
              <line
                class="pole"
                x1="0"
                y1="0"
                x2="0"
                y2="-34"
                :stroke="isDark ? '#fde68a' : '#b91c1c'"
                stroke-width="2"
                stroke-linecap="round"
                :filter="`url(#wm-glow-${uid})`"
                pointer-events="none"
              />
              <!-- pole top knob -->
              <circle
                class="pole-knob"
                cx="0"
                cy="-34"
                r="1.8"
                :fill="isDark ? '#fde68a' : '#b91c1c'"
                :stroke="isDark ? '#0b1e3a' : '#ffffff'"
                stroke-width="0.5"
                :filter="`url(#wm-glow-${uid})`"
                pointer-events="none"
              />
              <!-- flag face: waving rectangle with country code -->
              <path
                class="flag-face"
                d="M 1 -32 Q 10 -34, 19 -32 L 19 -21 Q 10 -23, 1 -21 Z"
                :fill="isDark ? `url(#wm-land-lit-dark-${uid})` : `url(#wm-flag-light-${uid})`"
                :stroke="isDark ? '#67e8f9' : '#7f1d1d'"
                stroke-width="0.6"
                :filter="`url(#wm-glow-${uid})`"
                pointer-events="none"
              />
              <text
                class="flag-label"
                x="10"
                y="-26.5"
                text-anchor="middle"
                dominant-baseline="central"
                font-size="6.5"
                :fill="isDark ? '#0b1e3a' : '#ffffff'"
                font-weight="700"
                font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
                pointer-events="none"
              >{{ flagLabel(n.host.countryCode) }}</text>
              <!-- anchor dot at coordinate -->
              <circle
                class="anchor"
                r="2.2"
                :fill="isDark ? '#e0f7fa' : '#b91c1c'"
                :stroke="isDark ? '#67e8f9' : '#ffffff'"
                stroke-width="0.8"
                :filter="`url(#wm-glow-${uid})`"
                pointer-events="none"
              />
            </g>
          </g>
        </g>
      </g>

      <!-- Highlight on top of sphere (sky reflection) — dark mode only -->
      <ellipse
        v-if="isDark"
        :cx="ellipse.cx"
        :cy="ellipse.cy"
        :rx="ellipse.rx"
        :ry="ellipse.ry"
        :fill="`url(#wm-highlight-dark-${uid})`"
        pointer-events="none"
      />

      <!-- Inner soft vignette — dark mode only (light mode dissolves to bg) -->
      <ellipse
        v-if="isDark"
        :cx="ellipse.cx"
        :cy="ellipse.cy"
        :rx="ellipse.rx"
        :ry="ellipse.ry"
        :fill="`url(#wm-inner-${uid})`"
        pointer-events="none"
      />
    </svg>

    <!-- Zoom controls -->
    <div class="map-controls">
      <button type="button" class="ctrl-btn" aria-label="放大" @click.stop="zoomCenter(1.4)">+</button>
      <button type="button" class="ctrl-btn" aria-label="缩小" @click.stop="zoomCenter(1 / 1.4)">−</button>
      <button type="button" class="ctrl-btn ctrl-reset" aria-label="重置视角" @click.stop="resetView">⟲</button>
    </div>
  </div>
</template>

<style scoped>
.world-vector-map {
  position: relative;
  display: block;
  user-select: none;
  -webkit-user-select: none;
}

.map-svg {
  display: block;
  overflow: visible;
}
.map-group {
  cursor: grab;
  touch-action: none;
}
.map-group:active {
  cursor: grabbing;
}

.country {
  transition: fill 240ms ease, stroke 240ms ease;
}

.flag-node {
  cursor: pointer;
}
.flag-node .flag-face,
.flag-node .flag-label,
.flag-node .pole,
.flag-node .pole-knob,
.flag-node .anchor {
  transition: transform 180ms ease, filter 180ms ease;
  transform-box: fill-box;
  transform-origin: center;
}
.flag-node.is-hover .flag-face,
.flag-node.is-hover .flag-label {
  transform: scale(1.18);
  transform-origin: left center;
  transform-box: fill-box;
}
.flag-node.is-hover .pole-knob {
  transform: scale(1.4);
}
.flag-node.is-hover .pole {
  filter: drop-shadow(0 0 5px rgba(103, 232, 249, 0.85));
}

.halo {
  transform-origin: center;
  transform-box: fill-box;
}
.halo-2 {
  animation: wm-halo-pulse 2.6s ease-in-out infinite;
}
.halo-3 {
  animation: wm-halo-pulse 2.6s ease-in-out infinite;
  animation-delay: 1.3s;
}

@keyframes wm-halo-pulse {
  0% {
    opacity: 0.85;
    transform: scale(0.4);
  }
  70% {
    opacity: 0.08;
    transform: scale(1.6);
  }
  100% {
    opacity: 0;
    transform: scale(1.8);
  }
}

@media (prefers-reduced-motion: reduce) {
  .halo-2,
  .halo-3 {
    animation: none;
  }
}

.map-controls {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 5;
}
.ctrl-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid rgba(34, 211, 238, 0.35);
  background: rgba(8, 22, 44, 0.7);
  color: #cfeefb;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.ctrl-btn:hover {
  background: rgba(34, 211, 238, 0.18);
  border-color: rgba(34, 211, 238, 0.6);
  transform: translateY(-1px);
}
.ctrl-reset {
  font-size: 14px;
}

:global(html:not(.dark)) .ctrl-btn {
  background: rgba(255, 255, 255, 0.85);
  border-color: rgba(14, 165, 233, 0.4);
  color: #075985;
  box-shadow: 0 2px 8px rgba(30, 58, 95, 0.12);
}
</style>

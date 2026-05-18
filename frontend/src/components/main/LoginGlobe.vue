<script setup lang="ts">
// Decorative rotating globe for the login screen.
// Pure visual — no interaction, no host overlays.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { feature } from 'topojson-client';
import { geoGraticule, geoOrthographic, geoPath } from 'd3-geo';
import type { Topology } from 'topojson-specification';
import worldTopo from '@/assets/world-110m.json';

const props = withDefaults(
  defineProps<{
    width?: number;
    height?: number;
    speed?: number; // degrees per second
  }>(),
  { width: 0, height: 0, speed: 4 },
);

const topology = worldTopo as unknown as Topology;
const countriesFC = feature(
  topology,
  topology.objects.countries as any,
) as unknown as GeoJSON.FeatureCollection;

const graticule = geoGraticule().step([15, 15]);

const containerRef = ref<HTMLDivElement | null>(null);
const measuredW = ref(0);
const measuredH = ref(0);
const lambda = ref(0);
const isDark = ref(true);

let raf = 0;
let lastTs = 0;
let resizeObs: ResizeObserver | null = null;
let themeObs: MutationObserver | null = null;

const w = computed(() => Math.max(1, props.width || measuredW.value));
const h = computed(() => Math.max(1, props.height || measuredH.value));

const projection = computed(() => {
  const sz = Math.min(w.value, h.value);
  // Globe radius ≈ 70% of min dim → comfortable framing with halo.
  return geoOrthographic()
    .scale(sz * 0.42)
    .translate([w.value / 2, h.value / 2])
    .rotate([lambda.value, -18, 0])
    .clipAngle(90);
});

const pathFn = computed(() => geoPath(projection.value));

const spherePath = computed(() => pathFn.value({ type: 'Sphere' } as any) || '');
const graticulePath = computed(() => pathFn.value(graticule()) || '');

const countryPaths = computed(() =>
  countriesFC.features.map((f, i) => ({
    key: i,
    d: pathFn.value(f as any) || '',
  })),
);

// Star particles, deterministic by simple LCG.
const stars = computed(() => {
  const count = Math.max(80, Math.floor((w.value * h.value) / 5000));
  const out: Array<{ x: number; y: number; r: number; o: number }> = [];
  let seed = 0x1f3a4b;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < count; i++) {
    out.push({
      x: rand() * w.value,
      y: rand() * h.value,
      r: 0.4 + rand() * 1.4,
      o: 0.25 + rand() * 0.6,
    });
  }
  return out;
});

const uid = Math.random().toString(36).slice(2, 8);

function tick(ts: number): void {
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  lambda.value = (lambda.value + props.speed * dt) % 360;
  raf = requestAnimationFrame(tick);
}

function detectTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

function measure(): void {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  measuredW.value = rect.width;
  measuredH.value = rect.height;
}

onMounted(() => {
  isDark.value = detectTheme();
  themeObs = new MutationObserver(() => {
    isDark.value = detectTheme();
  });
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  measure();
  resizeObs = new ResizeObserver(() => measure());
  if (containerRef.value) resizeObs.observe(containerRef.value);

  // Respect reduced motion preference: pause rotation.
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  resizeObs?.disconnect();
  themeObs?.disconnect();
});
</script>

<template>
  <div ref="containerRef" class="login-globe absolute inset-0 overflow-hidden" aria-hidden="true">
    <svg
      class="globe-svg"
      :viewBox="`0 0 ${w} ${h}`"
      :width="w"
      :height="h"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient :id="`lg-bg-dark-${uid}`" cx="50%" cy="40%" r="80%">
          <stop offset="0%" stop-color="#0b1e3a" />
          <stop offset="60%" stop-color="#040b1d" />
          <stop offset="100%" stop-color="#000" />
        </radialGradient>
        <radialGradient :id="`lg-bg-light-${uid}`" cx="50%" cy="35%" r="85%">
          <stop offset="0%" stop-color="#eaf2fd" />
          <stop offset="60%" stop-color="#d6e3f5" />
          <stop offset="100%" stop-color="#bccce4" />
        </radialGradient>

        <radialGradient :id="`lg-ocean-dark-${uid}`" cx="50%" cy="48%" r="55%">
          <stop offset="0%" stop-color="#143a64" />
          <stop offset="80%" stop-color="#0a1f3d" />
          <stop offset="100%" stop-color="#040c1d" />
        </radialGradient>
        <radialGradient :id="`lg-ocean-light-${uid}`" cx="50%" cy="45%" r="58%">
          <stop offset="0%" stop-color="#1d4ed8" />
          <stop offset="70%" stop-color="#1e40af" />
          <stop offset="100%" stop-color="#172554" />
        </radialGradient>

        <linearGradient :id="`lg-land-dark-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2c5a8c" />
          <stop offset="100%" stop-color="#163459" />
        </linearGradient>
        <linearGradient :id="`lg-land-light-${uid}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#dbeafe" />
          <stop offset="100%" stop-color="#93c5fd" />
        </linearGradient>

        <radialGradient :id="`lg-halo-dark-${uid}`" cx="50%" cy="50%" r="55%">
          <stop offset="50%" stop-color="#22d3ee" stop-opacity="0" />
          <stop offset="65%" stop-color="#22d3ee" stop-opacity="0.18" />
          <stop offset="85%" stop-color="#22d3ee" stop-opacity="0.05" />
          <stop offset="100%" stop-color="#22d3ee" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="`lg-halo-light-${uid}`" cx="50%" cy="50%" r="58%">
          <stop offset="50%" stop-color="#7dd3fc" stop-opacity="0" />
          <stop offset="65%" stop-color="#38bdf8" stop-opacity="0.15" />
          <stop offset="85%" stop-color="#0ea5e9" stop-opacity="0.05" />
          <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0" />
        </radialGradient>

        <radialGradient :id="`lg-highlight-${uid}`" cx="35%" cy="22%" r="50%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>

        <radialGradient :id="`lg-shadow-${uid}`" cx="50%" cy="50%" r="50%">
          <stop offset="70%" stop-color="#000" stop-opacity="0" />
          <stop offset="100%" stop-color="#000" stop-opacity="0.45" />
        </radialGradient>
      </defs>

      <!-- Backdrop -->
      <rect
        :width="w"
        :height="h"
        :fill="isDark ? `url(#lg-bg-dark-${uid})` : `url(#lg-bg-light-${uid})`"
      />

      <!-- Stars (dark only) -->
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

      <!-- Outer atmosphere halo -->
      <path
        :d="spherePath"
        :fill="isDark ? `url(#lg-halo-dark-${uid})` : `url(#lg-halo-light-${uid})`"
        class="halo"
      />

      <!-- Ocean / sphere fill -->
      <path
        :d="spherePath"
        :fill="isDark ? `url(#lg-ocean-dark-${uid})` : `url(#lg-ocean-light-${uid})`"
      />

      <!-- Graticule -->
      <path
        :d="graticulePath"
        fill="none"
        :stroke="isDark ? '#3aa7c8' : '#ffffff'"
        :stroke-opacity="isDark ? 0.22 : 0.45"
        stroke-width="0.5"
        stroke-dasharray="1.5,3"
      />

      <!-- Countries -->
      <g class="countries">
        <path
          v-for="c in countryPaths"
          :key="c.key"
          :d="c.d"
          :fill="isDark ? `url(#lg-land-dark-${uid})` : `url(#lg-land-light-${uid})`"
          :stroke="isDark ? 'rgba(150, 200, 240, 0.42)' : 'rgba(30, 64, 175, 0.45)'"
          stroke-width="0.4"
        />
      </g>

      <!-- Top-left highlight (sky reflection) -->
      <path :d="spherePath" :fill="`url(#lg-highlight-${uid})`" />

      <!-- Inner shadow vignette -->
      <path :d="spherePath" :fill="`url(#lg-shadow-${uid})`" />
    </svg>
  </div>
</template>

<style scoped>
.login-globe {
  pointer-events: none;
}
.globe-svg {
  display: block;
  width: 100%;
  height: 100%;
}
.halo {
  filter: blur(6px);
}
</style>

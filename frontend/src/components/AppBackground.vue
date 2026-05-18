<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';

const isDark = ref(document.documentElement.classList.contains('dark'));

function rand(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return min + (x - Math.floor(x)) * (max - min);
}

const petals = Array.from({ length: 48 }, (_, i) => ({
  left: `${rand(i, 1, 94).toFixed(1)}%`,
  width: `${rand(i + 100, 5, 12).toFixed(1)}px`,
  height: `${rand(i + 200, 8, 16).toFixed(1)}px`,
  duration: `${rand(i + 300, 10, 18).toFixed(1)}s`,
  delay: `-${rand(i + 400, 0, 14).toFixed(1)}s`,
  rotate: `${rand(i + 500, 0, 360).toFixed(0)}deg`,
  drift: `${rand(i + 600, -70, 70).toFixed(0)}px`,
  hue: `${rand(i + 700, 330, 360).toFixed(0)}`,
}));

const meteors = Array.from({ length: 18 }, (_, i) => ({
  left: `${rand(i + 10, -25, 60).toFixed(1)}%`,
  top: `${rand(i + 20, -15, 75).toFixed(1)}%`,
  length: `${rand(i + 30, 80, 220).toFixed(0)}px`,
  duration: `${rand(i + 40, 5.5, 10).toFixed(1)}s`,
  delay: `-${rand(i + 50, 0, 10).toFixed(1)}s`,
  hue: `${rand(i + 60, 185, 280).toFixed(0)}`,
  distance: `${rand(i + 70, 130, 180).toFixed(0)}vw`,
}));

const stars = Array.from({ length: 80 }, (_, i) => ({
  left: `${rand(i + 100, 0.5, 99).toFixed(1)}%`,
  top: `${rand(i + 110, 1, 96).toFixed(1)}%`,
  size: `${rand(i + 120, 1.2, 4).toFixed(1)}px`,
  duration: `${rand(i + 130, 2.5, 6).toFixed(1)}s`,
  delay: `-${rand(i + 140, 0, 5).toFixed(1)}s`,
  maxOpacity: `${rand(i + 150, 0.4, 1).toFixed(2)}`,
}));

let mo: MutationObserver | null = null;
onMounted(() => {
  mo = new MutationObserver(() => {
    isDark.value = document.documentElement.classList.contains('dark');
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});
onBeforeUnmount(() => mo?.disconnect());
</script>

<template>
  <div class="app-bg-layer" aria-hidden="true">
    <template v-if="!isDark">
      <div class="bg-paper-noise" />
      <div
        v-for="(p, i) in petals"
        :key="`petal-${i}`"
        class="bg-petal"
        :style="{
          left: p.left,
          width: p.width,
          height: p.height,
          animationDuration: p.duration,
          animationDelay: p.delay,
          '--bg-rotate': p.rotate,
          '--bg-drift': p.drift,
          '--bg-hue': p.hue,
        }"
      />
    </template>
  </div>
  <div v-if="isDark" class="app-stars-layer" aria-hidden="true">
    <svg class="bg-moon" viewBox="0 0 70 70" aria-hidden="true">
      <path d="M 44 6 A 28 28 0 1 0 44 64 A 21 21 0 1 1 44 6 Z" fill="#f1f5f9" />
    </svg>
    <div
      v-for="(s, i) in stars"
      :key="`star-${i}`"
      class="bg-star"
      :style="{
        left: s.left,
        top: s.top,
        width: s.size,
        height: s.size,
        animationDuration: s.duration,
        animationDelay: s.delay,
        '--bg-max-opacity': s.maxOpacity,
      }"
    />
    <div
      v-for="(m, i) in meteors"
      :key="`meteor-${i}`"
      class="bg-meteor"
      :style="{
        left: m.left,
        top: m.top,
        width: m.length,
        animationDuration: m.duration,
        animationDelay: m.delay,
        '--bg-hue': m.hue,
        '--bg-meteor-distance': m.distance,
      }"
    />
  </div>
</template>

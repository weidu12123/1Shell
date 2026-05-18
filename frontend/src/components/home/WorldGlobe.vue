<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import ThreeGlobe from 'three-globe';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { feature } from 'topojson-client';
import { geoContains } from 'd3-geo';
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

const container = ref<HTMLDivElement | null>(null);

const topology = worldTopo as unknown as Topology;
const countriesFC = feature(
  topology,
  topology.objects.countries as any,
) as unknown as GeoJSON.FeatureCollection;

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let globe: ThreeGlobe;
let controls: OrbitControls;
let raycaster: THREE.Raycaster;
let pointer: THREE.Vector2;
let stars: THREE.Points;
let frameId: number | null = null;
let lastInteractTs = 0;
let hoveredHostId: string | null = null;
let isDark = true;
let themeObserver: MutationObserver | null = null;
let visibilityHandler: (() => void) | null = null;

interface NodeObj {
  host: GeoHost;
  group: THREE.Group;
  core: THREE.Mesh;
  halo: THREE.Mesh;
}
const nodeObjs: NodeObj[] = [];

function detectTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function computeLitCountries(hosts: GeoHost[]): Set<string | number> {
  const lit = new Set<string | number>();
  if (!hosts.length) return lit;
  for (const f of countriesFC.features) {
    const id = f.id ?? '';
    if (lit.has(id)) continue;
    for (const h of hosts) {
      if (geoContains(f as any, [h.lng, h.lat])) {
        lit.add(id);
        break;
      }
    }
  }
  return lit;
}

interface ArcDatum {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  colorStart: string;
  colorEnd: string;
}

function computeArcs(hosts: GeoHost[]): ArcDatum[] {
  if (hosts.length < 2) return [];
  const arcs: ArcDatum[] = [];
  const palette: [string, string][] = [
    ['#22d3ee', '#a78bfa'],
    ['#38bdf8', '#f472b6'],
    ['#34d399', '#22d3ee'],
  ];
  const pick = (i: number): [string, string] => palette[i % palette.length];

  if (hosts.length <= 10) {
    let k = 0;
    for (let i = 0; i < hosts.length; i++) {
      for (let j = i + 1; j < hosts.length; j++) {
        const [cs, ce] = pick(k++);
        arcs.push({
          startLat: hosts[i].lat,
          startLng: hosts[i].lng,
          endLat: hosts[j].lat,
          endLng: hosts[j].lng,
          colorStart: cs,
          colorEnd: ce,
        });
      }
    }
    return arcs;
  }

  const seen = new Set<string>();
  const maxArcs = 80;
  for (let i = 0; i < hosts.length && arcs.length < maxArcs; i++) {
    const dists: { j: number; d: number }[] = [];
    for (let j = 0; j < hosts.length; j++) {
      if (i === j) continue;
      const dLat = hosts[i].lat - hosts[j].lat;
      const dLng = hosts[i].lng - hosts[j].lng;
      dists.push({ j, d: dLat * dLat + dLng * dLng });
    }
    dists.sort((a, b) => a.d - b.d);
    for (let k = 0; k < Math.min(3, dists.length); k++) {
      const j = dists[k].j;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [cs, ce] = pick(arcs.length);
      arcs.push({
        startLat: hosts[i].lat,
        startLng: hosts[i].lng,
        endLat: hosts[j].lat,
        endLng: hosts[j].lng,
        colorStart: cs,
        colorEnd: ce,
      });
      if (arcs.length >= maxArcs) break;
    }
  }
  return arcs;
}

function makeNodeObject(host: GeoHost): NodeObj {
  const group = new THREE.Group();
  group.userData.host = host;

  const coreColor = new THREE.Color(isDark ? '#e0f7fa' : '#0369a1');
  const haloColor = new THREE.Color(isDark ? '#22d3ee' : '#0ea5e9');

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 16),
    new THREE.MeshBasicMaterial({ color: coreColor }),
  );
  core.userData.hostId = host.id;

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(2.2, 24, 24),
    new THREE.MeshBasicMaterial({
      color: haloColor,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );

  group.add(halo, core);
  return { host, group, core, halo };
}

function disposeNode(n: NodeObj): void {
  n.group.parent?.remove(n.group);
  n.core.geometry.dispose();
  (n.core.material as THREE.Material).dispose();
  n.halo.geometry.dispose();
  (n.halo.material as THREE.Material).dispose();
}

function applyPolygonStyles(): void {
  const litIds = computeLitCountries(props.hosts);
  const litCap = isDark ? 'rgba(34, 211, 238, 0.78)' : 'rgba(14, 165, 233, 0.72)';
  const dimCap = isDark ? 'rgba(22, 42, 78, 0.6)' : 'rgba(148, 163, 184, 0.45)';
  const litSide = isDark ? 'rgba(34, 211, 238, 0.4)' : 'rgba(14, 165, 233, 0.35)';
  const dimSide = isDark ? 'rgba(22, 42, 78, 0.2)' : 'rgba(148, 163, 184, 0.2)';
  const litStroke = isDark ? '#67e8f9' : '#0284c7';
  const dimStroke = isDark ? 'rgba(100, 139, 195, 0.45)' : 'rgba(100, 116, 139, 0.45)';

  globe
    .polygonAltitude((d: any) => (litIds.has(d.id) ? 0.014 : 0.005))
    .polygonCapColor((d: any) => (litIds.has(d.id) ? litCap : dimCap))
    .polygonSideColor((d: any) => (litIds.has(d.id) ? litSide : dimSide))
    .polygonStrokeColor((d: any) => (litIds.has(d.id) ? litStroke : dimStroke));
}

function applyHosts(): void {
  for (const n of nodeObjs) disposeNode(n);
  nodeObjs.length = 0;

  const data = props.hosts.map((h) => ({ lat: h.lat, lng: h.lng, host: h }));
  globe
    .customLayerData(data)
    .customThreeObject((d: any) => {
      const n = makeNodeObject(d.host);
      nodeObjs.push(n);
      return n.group;
    })
    .customThreeObjectUpdate((obj: any, d: any) => {
      Object.assign(obj.position, globe.getCoords(d.lat, d.lng, 0.012));
    });

  const arcs = computeArcs(props.hosts);
  globe
    .arcsData(arcs)
    .arcColor((d: any) => [d.colorStart, d.colorEnd])
    .arcDashLength(0.45)
    .arcDashGap(1.6)
    .arcDashAnimateTime(prefersReducedMotion() ? 0 : 2600)
    .arcStroke(0.32)
    .arcAltitudeAutoScale(0.45);

  applyPolygonStyles();
}

function makeStars(): THREE.Points {
  const geo = new THREE.BufferGeometry();
  const count = 1500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const phi = Math.random() * Math.PI * 2;
    const theta = Math.acos(Math.random() * 2 - 1);
    const r = 600 + Math.random() * 200;
    positions[i * 3] = r * Math.sin(theta) * Math.cos(phi);
    positions[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
    positions[i * 3 + 2] = r * Math.cos(theta);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: isDark ? 0xaaccff : 0x88aacc,
    size: 1.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: isDark ? 0.6 : 0.18,
  });
  return new THREE.Points(geo, mat);
}

function onPointerMove(e: PointerEvent): void {
  if (!container.value) return;
  const rect = container.value.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function onPointerLeave(): void {
  pointer.x = -9999;
  pointer.y = -9999;
}

function onClick(e: MouseEvent): void {
  if (!nodeObjs.length) return;
  raycaster.setFromCamera(pointer, camera);
  const targets = nodeObjs.map((n) => n.core);
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    const obj = hits[0].object;
    const node = nodeObjs.find((n) => n.core === obj);
    if (node) {
      emit('node-click', node.host, e.clientX, e.clientY);
    }
  }
}

function updateHover(): void {
  if (!nodeObjs.length) {
    if (hoveredHostId) {
      hoveredHostId = null;
      if (container.value) container.value.style.cursor = 'default';
    }
    return;
  }
  raycaster.setFromCamera(pointer, camera);
  const targets = nodeObjs.map((n) => n.core);
  const hits = raycaster.intersectObjects(targets, false);
  const newId =
    hits.length > 0
      ? nodeObjs.find((n) => n.core === hits[0].object)?.host.id || null
      : null;
  if (newId !== hoveredHostId) {
    hoveredHostId = newId;
    if (container.value) container.value.style.cursor = newId ? 'pointer' : 'default';
  }
}

function animate(): void {
  frameId = requestAnimationFrame(animate);
  if (document.hidden) return;

  const t = performance.now() * 0.001;
  const reduced = prefersReducedMotion();

  for (let i = 0; i < nodeObjs.length; i++) {
    const n = nodeObjs[i];
    if (!reduced) {
      const phase = t * 1.9 + i * 0.45;
      const haloScale = 1 + 0.55 * (0.5 + 0.5 * Math.sin(phase));
      n.halo.scale.setScalar(haloScale);
      const opacity = 0.16 + 0.26 * (0.5 + 0.5 * Math.cos(phase * 0.7));
      (n.halo.material as THREE.MeshBasicMaterial).opacity = opacity;
    }
    const coreScale = n.host.id === hoveredHostId ? 1.6 : 1;
    n.core.scale.setScalar(coreScale);
  }

  if (!reduced && !controls.autoRotate) {
    if (performance.now() - lastInteractTs > 2800) {
      controls.autoRotate = true;
    }
  }

  controls.update();
  updateHover();
  renderer.render(scene, camera);
}

function resize(): void {
  if (!renderer || !camera) return;
  const w = Math.max(1, props.width);
  const h = Math.max(1, props.height);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function rebuildForTheme(): void {
  scene.background = new THREE.Color(isDark ? 0x02060e : 0xeaf3ff);

  const globeMat = globe.globeMaterial() as THREE.MeshPhongMaterial;
  globeMat.color.set(isDark ? 0x0a1830 : 0xcbe4ff);
  globeMat.emissive.set(isDark ? 0x040810 : 0xaecde8);
  globeMat.needsUpdate = true;

  globe.atmosphereColor(isDark ? '#22d3ee' : '#38bdf8');

  if (stars) {
    const starMat = stars.material as THREE.PointsMaterial;
    starMat.color.set(isDark ? 0xaaccff : 0x88aacc);
    starMat.opacity = isDark ? 0.6 : 0.18;
    starMat.needsUpdate = true;
  }

  applyHosts();
}

watch(
  () => [props.width, props.height],
  () => resize(),
);
watch(
  () => props.hosts,
  () => applyHosts(),
  { deep: false },
);

onMounted(() => {
  if (!container.value) return;
  isDark = detectTheme();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(isDark ? 0x02060e : 0xeaf3ff);

  const w = Math.max(1, props.width);
  const h = Math.max(1, props.height);
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);
  camera.position.set(0, 30, 280);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  container.value.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x6688aa, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 1, 1);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x4488ff, 0.25);
  fill.position.set(-1, -0.5, -1);
  scene.add(fill);

  stars = makeStars();
  scene.add(stars);

  globe = new ThreeGlobe({ animateIn: true })
    .globeMaterial(
      new THREE.MeshPhongMaterial({
        color: isDark ? 0x0a1830 : 0xcbe4ff,
        emissive: isDark ? 0x040810 : 0xaecde8,
        shininess: 14,
        transparent: true,
        opacity: 0.94,
      }),
    )
    .showAtmosphere(true)
    .atmosphereColor(isDark ? '#22d3ee' : '#38bdf8')
    .atmosphereAltitude(0.22)
    .polygonsData(countriesFC.features)
    .polygonsTransitionDuration(900);

  scene.add(globe);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 150;
  controls.maxDistance = 380;
  controls.autoRotate = !prefersReducedMotion();
  controls.autoRotateSpeed = 0.4;

  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    lastInteractTs = performance.now();
  });
  controls.addEventListener('end', () => {
    lastInteractTs = performance.now();
  });

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2(-9999, -9999);

  container.value.addEventListener('pointermove', onPointerMove);
  container.value.addEventListener('pointerleave', onPointerLeave);
  container.value.addEventListener('click', onClick);

  visibilityHandler = (): void => {
    if (!document.hidden) lastInteractTs = performance.now();
  };
  document.addEventListener('visibilitychange', visibilityHandler);

  themeObserver = new MutationObserver(() => {
    const next = detectTheme();
    if (next !== isDark) {
      isDark = next;
      rebuildForTheme();
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });

  applyHosts();
  animate();
});

onBeforeUnmount(() => {
  if (frameId !== null) cancelAnimationFrame(frameId);
  themeObserver?.disconnect();
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);

  if (container.value) {
    container.value.removeEventListener('pointermove', onPointerMove);
    container.value.removeEventListener('pointerleave', onPointerLeave);
    container.value.removeEventListener('click', onClick);
  }

  controls?.dispose();

  for (const n of nodeObjs) disposeNode(n);
  nodeObjs.length = 0;

  scene?.traverse((obj: any) => {
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m: THREE.Material) => m.dispose());
      else obj.material.dispose();
    }
  });

  renderer?.dispose();
  if (renderer?.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
});
</script>

<template>
  <div
    ref="container"
    class="world-globe"
    :style="{ width: width + 'px', height: height + 'px' }"
    role="img"
    aria-label="3D 世界地球仪 — 1Shell 全球部署"
  />
</template>

<style scoped>
.world-globe {
  display: block;
  position: relative;
  overflow: hidden;
}
</style>

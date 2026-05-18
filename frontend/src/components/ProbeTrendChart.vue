<script setup lang="ts">
import { computed } from 'vue';
import {
  type ProbeSample,
  type MetricKey,
  buildTickIndexes,
  formatBandwidth,
  formatTrendTime,
  getSampleValue,
} from '@/utils/probe';

const props = defineProps<{
  samples: ProbeSample[];
  metric: MetricKey;
  loading?: boolean;
}>();

const CHART_W = 360;
const CHART_H = 180;
const M_TOP = 10;
const M_RIGHT = 14;
const M_BOTTOM = 28;
const M_LEFT = 52;
const PLOT_W = CHART_W - M_LEFT - M_RIGHT;
const PLOT_H = CHART_H - M_TOP - M_BOTTOM;

const isDual = computed(() => props.metric === 'bandwidth');

interface Point { time: number; primary: number; secondary?: number }

const points = computed<Point[]>(() => {
  const list: Point[] = [];
  for (const s of props.samples) {
    const t = new Date(s.reported_at).getTime();
    if (!Number.isFinite(t)) continue;
    if (isDual.value) {
      const rx = Number(s.rx_bps);
      const tx = Number(s.tx_bps);
      if (!Number.isFinite(rx) && !Number.isFinite(tx)) continue;
      list.push({ time: t, primary: Number.isFinite(rx) ? rx : 0, secondary: Number.isFinite(tx) ? tx : 0 });
    } else {
      const v = getSampleValue(s, props.metric);
      if (v === null) continue;
      list.push({ time: t, primary: v });
    }
  }
  list.sort((a, b) => a.time - b.time);
  return list;
});

const maxValue = computed<number>(() => {
  let m = 1;
  for (const p of points.value) {
    if (p.primary > m) m = p.primary;
    if (p.secondary !== undefined && p.secondary > m) m = p.secondary;
  }
  // 百分比类指标固定 100 上限
  if (props.metric === 'cpuUsage' || props.metric === 'memoryUsage' || props.metric === 'diskUsage') {
    return Math.max(m, 100);
  }
  return m;
});

const yTickValues = computed<number[]>(() => {
  const m = maxValue.value;
  return [m, m * (2 / 3), m * (1 / 3), 0];
});

const xTickIndexes = computed<number[]>(() => buildTickIndexes(points.value.length, 4));

function getX(index: number): number {
  const n = points.value.length;
  if (n <= 1) return M_LEFT + PLOT_W / 2;
  return M_LEFT + (index / (n - 1)) * PLOT_W;
}
function getY(value: number): number {
  return M_TOP + PLOT_H - (value / maxValue.value) * PLOT_H;
}

function buildPath(getValue: (p: Point) => number): string {
  return points.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(2)},${getY(getValue(p)).toFixed(2)}`).join(' ');
}

const primaryPath = computed(() => buildPath((p) => p.primary));
const secondaryPath = computed(() => isDual.value ? buildPath((p) => p.secondary ?? 0) : '');

function formatY(value: number): string {
  if (props.metric === 'bandwidth') return formatBandwidth(value);
  if (props.metric === 'cpuUsage' || props.metric === 'memoryUsage' || props.metric === 'diskUsage') {
    return `${Math.round(value)}%`;
  }
  if (props.metric === 'load') return value.toFixed(2);
  return String(Math.round(value));
}

const lastTime = computed(() => points.value[points.value.length - 1]?.time ?? null);
</script>

<template>
  <div class="probe-trend-chart-wrap">
    <div class="probe-trend-chart-header">
      <div class="probe-trend-chart-meta">
        <template v-if="loading && points.length === 0">加载历史采样中...</template>
        <template v-else-if="points.length === 0">暂无 Agent 历史采样</template>
        <template v-else>{{ points.length }} 个采样点 · 最新 {{ formatTrendTime(lastTime) }}</template>
      </div>
      <div class="probe-trend-legend">
        <template v-if="isDual">
          <span class="probe-trend-legend-item">
            <span class="probe-trend-legend-line probe-trend-line-rx"></span>
            <span>下行 Rx</span>
          </span>
          <span class="probe-trend-legend-item">
            <span class="probe-trend-legend-line probe-trend-line-tx"></span>
            <span>上行 Tx</span>
          </span>
        </template>
        <span v-else class="probe-trend-legend-item">
          <span class="probe-trend-legend-line probe-trend-line-single"></span>
          <span>{{ metric === 'cpuUsage' ? 'CPU' : metric === 'memoryUsage' ? '内存' : metric === 'diskUsage' ? '磁盘' : metric === 'load' ? 'Load 1m' : '指标' }}</span>
        </span>
      </div>
    </div>

    <div v-if="points.length === 0" class="probe-trend-empty">
      {{ loading ? '加载历史采样中...' : '暂无 Agent 历史采样' }}
    </div>
    <template v-else>
      <div v-if="points.length < 2" class="probe-trend-empty">已记录 1 次采样，等待更多采样后显示完整折线。</div>
      <svg class="probe-trend-svg" viewBox="0 0 360 180" role="img" aria-label="趋势图">
        <g v-for="(yt, i) in yTickValues" :key="`yg-${i}`">
          <line class="probe-trend-grid" :x1="M_LEFT" :y1="getY(yt).toFixed(2)" :x2="(M_LEFT + PLOT_W).toFixed(2)" :y2="getY(yt).toFixed(2)"></line>
          <text class="probe-trend-label" :x="M_LEFT - 8" :y="(getY(yt) + 3).toFixed(2)" text-anchor="end">{{ formatY(yt) }}</text>
        </g>
        <g v-for="(idx, i) in xTickIndexes" :key="`xg-${i}`">
          <line class="probe-trend-grid" :x1="getX(idx).toFixed(2)" :y1="M_TOP" :x2="getX(idx).toFixed(2)" :y2="(M_TOP + PLOT_H).toFixed(2)"></line>
          <text class="probe-trend-label" :x="getX(idx).toFixed(2)" :y="(M_TOP + PLOT_H + 18).toFixed(2)" text-anchor="middle">{{ formatTrendTime(points[idx]?.time) }}</text>
        </g>
        <line class="probe-trend-axis" :x1="M_LEFT" :y1="M_TOP" :x2="M_LEFT" :y2="(M_TOP + PLOT_H).toFixed(2)"></line>
        <line class="probe-trend-axis" :x1="M_LEFT" :y1="(M_TOP + PLOT_H).toFixed(2)" :x2="(M_LEFT + PLOT_W).toFixed(2)" :y2="(M_TOP + PLOT_H).toFixed(2)"></line>
        <template v-if="isDual">
          <path class="probe-trend-line-rx" :d="primaryPath"></path>
          <path class="probe-trend-line-tx" :d="secondaryPath"></path>
          <circle v-for="(p, i) in points" :key="`rx-${i}`" class="probe-trend-point-rx" :cx="getX(i).toFixed(2)" :cy="getY(p.primary).toFixed(2)" r="2.4"></circle>
          <circle v-for="(p, i) in points" :key="`tx-${i}`" class="probe-trend-point-tx" :cx="getX(i).toFixed(2)" :cy="getY(p.secondary ?? 0).toFixed(2)" r="2.4"></circle>
        </template>
        <template v-else>
          <path class="probe-trend-line-single" :d="primaryPath"></path>
          <circle v-for="(p, i) in points" :key="`s-${i}`" class="probe-trend-point-single" :cx="getX(i).toFixed(2)" :cy="getY(p.primary).toFixed(2)" r="2.4"></circle>
        </template>
      </svg>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { RenderCodePayload } from '@/utils/playbooks';

defineProps<{ payload: RenderCodePayload }>();
</script>

<template>
  <pre class="font-mono text-[11px] text-green-300 bg-slate-900/95 rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all"><code>{{ payload.content || '' }}</code></pre>
</template>

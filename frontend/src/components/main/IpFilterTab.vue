<script setup lang="ts">
// IP 访问控制 tab — 老 [public/app.js#L244-L333](public/app.js#L244-L333) + [public/index.html#L603-L652](public/index.html#L603-L652) 1:1
// 开关白/黑名单 + 加规则 + 列表 + 关闭失败回滚
import { ref, onMounted } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { useConfirm } from '@/composables/useConfirm';
import type { IpFilterRule, IpFilterConfig } from '@/utils/mainConsole';

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const { confirm } = useConfirm();

const rules = ref<IpFilterRule[]>([]);
const allowEnabled = ref(false);
const denyEnabled = ref(false);

const newType = ref<'allow' | 'deny'>('allow');
const newCidr = ref('');
const newNote = ref('');

async function load(): Promise<void> {
  try {
    const data = await requestJson<IpFilterConfig>('/api/ip-filter');
    rules.value = data.rules || [];
    allowEnabled.value = !!data.allowlistEnabled;
    denyEnabled.value = !!data.denylistEnabled;
  } catch (err) {
    notify.error((err as Error).message);
  }
}

async function saveToggle(key: 'allowlistEnabled' | 'denylistEnabled', value: boolean): Promise<void> {
  try {
    await requestJson('/api/ip-filter/config', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    });
    notify.success(value ? '已开启' : '已关闭');
  } catch (err) {
    notify.error((err as Error).message);
    // 失败时回滚开关状态
    await load();
  }
}

async function addRule(): Promise<void> {
  const cidr = newCidr.value.trim();
  if (!cidr) {
    notify.error('请输入 IP 或 CIDR');
    return;
  }
  try {
    await requestJson('/api/ip-filter/rules', {
      method: 'POST',
      body: JSON.stringify({ type: newType.value, cidr, note: newNote.value.trim() }),
    });
    newCidr.value = '';
    newNote.value = '';
    await load();
    notify.success('规则已添加');
  } catch (err) {
    notify.error((err as Error).message);
  }
}

async function deleteRule(rule: IpFilterRule): Promise<void> {
  const ok = await confirm({ title: '删除规则', message: `确认删除 ${rule.cidr} 吗？`, okText: '删除' });
  if (!ok) return;
  try {
    await requestJson(`/api/ip-filter/rules/${rule.id}`, { method: 'DELETE' });
    await load();
    notify.success('规则已删除');
  } catch (err) {
    notify.error((err as Error).message);
  }
}

onMounted(() => { void load(); });
</script>

<template>
  <div class="p-5 flex flex-col gap-4">
    <!-- 白名单开关 -->
    <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324]">
      <div>
        <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">IP 白名单</div>
        <div class="text-[11px] text-slate-400 mt-0.5">开启后仅允许名单内的 IP 访问</div>
      </div>
      <label class="relative inline-flex items-center cursor-pointer">
        <input
          v-model="allowEnabled"
          type="checkbox"
          class="sr-only peer"
          @change="saveToggle('allowlistEnabled', allowEnabled)"
        />
        <div class="w-10 h-5 bg-slate-300 peer-checked:bg-blue-500 rounded-full transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:transition-all peer-checked:after:translate-x-5"></div>
      </label>
    </div>

    <!-- 黑名单开关 -->
    <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324]">
      <div>
        <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">IP 黑名单</div>
        <div class="text-[11px] text-slate-400 mt-0.5">开启后拒绝名单内的 IP 访问</div>
      </div>
      <label class="relative inline-flex items-center cursor-pointer">
        <input
          v-model="denyEnabled"
          type="checkbox"
          class="sr-only peer"
          @change="saveToggle('denylistEnabled', denyEnabled)"
        />
        <div class="w-10 h-5 bg-slate-300 peer-checked:bg-red-500 rounded-full transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:transition-all peer-checked:after:translate-x-5"></div>
      </label>
    </div>

    <!-- 新增规则行 -->
    <div class="flex items-center gap-2">
      <select
        v-model="newType"
        class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400"
      >
        <option value="allow">白名单</option>
        <option value="deny">黑名单</option>
      </select>
      <input
        v-model="newCidr"
        type="text"
        placeholder="IP 或 CIDR，如 192.168.1.0/24"
        class="flex-1 h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
      />
      <input
        v-model="newNote"
        type="text"
        placeholder="备注（可选）"
        class="w-24 h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400"
      />
      <button
        type="button"
        class="h-8 px-3 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-600 transition-all shrink-0"
        @click="addRule"
      >添加</button>
    </div>

    <!-- 规则列表 -->
    <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] overflow-hidden">
      <div class="flex items-center px-3 py-2 bg-slate-50 dark:bg-[#0b1324] border-b border-slate-100 dark:border-[#1e293b] text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
        <span class="w-16 shrink-0">类型</span>
        <span class="flex-1">IP / CIDR</span>
        <span class="w-24 shrink-0">备注</span>
        <span class="w-12 shrink-0"></span>
      </div>
      <div class="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-[#1e293b]">
        <div v-if="!rules.length" class="px-3 py-4 text-xs text-slate-400 text-center">暂无规则</div>
        <div
          v-for="r in rules"
          :key="r.id"
          class="flex items-center px-3 py-2 text-xs gap-2 hover:bg-slate-50 dark:hover:bg-[#1a2332]"
        >
          <span class="w-16 shrink-0">
            <span
              class="px-1.5 py-0.5 rounded text-[10px] font-semibold"
              :class="r.type === 'allow' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300'"
            >{{ r.type === 'allow' ? '白名单' : '黑名单' }}</span>
          </span>
          <span class="flex-1 font-mono text-slate-700 dark:text-slate-200">{{ r.cidr }}</span>
          <span class="w-24 text-slate-400 truncate">{{ r.note || '' }}</span>
          <button
            type="button"
            class="w-12 text-red-400 hover:text-red-600 transition-colors"
            @click="deleteRule(r)"
          >删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

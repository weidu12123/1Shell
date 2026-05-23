<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { useAiChat } from '@/composables/useAiChat';
import IpFilterTab from '@/components/main/IpFilterTab.vue';
import {
  getDesktopSettings,
  isDesktopRuntime,
  setDesktopAutostartEnabled,
  setDesktopBackgroundEnabled,
  type DesktopSettings,
} from '@/utils/desktop';

interface Props {
  open: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const chat = useAiChat();

type Tab = 'account' | 'ipfilter' | 'aiconfig' | 'desktop';
const tab = ref<Tab>(isDesktopRuntime() ? 'desktop' : 'account');

const username = ref('');
const password = ref('');
const passwordConfirm = ref('');
const errorMsg = ref('');

const apiBase = ref('');
const apiKey = ref('');
const model = ref('');
const aiError = ref('');
const fetching = ref(false);
const modelsHints = ref<string[]>([]);

const desktopAvailable = ref(isDesktopRuntime());
const desktopSettings = ref<DesktopSettings>({
  isDesktop: false,
  backgroundEnabled: false,
  autostartEnabled: false,
  autostartAvailable: false,
});
const desktopLoading = ref(false);
const desktopError = ref('');
const desktopBackgroundAvailable = computed(() => desktopSettings.value.isDesktop);

watch(() => props.open, (v) => {
  if (v) {
    desktopAvailable.value = isDesktopRuntime();
    tab.value = desktopAvailable.value ? 'desktop' : 'account';
    username.value = '';
    password.value = '';
    passwordConfirm.value = '';
    errorMsg.value = '';
    if (desktopAvailable.value) void refreshDesktopSettings();
  }
});

watch(tab, (t) => {
  if (t === 'aiconfig') {
    apiBase.value = chat.config.value.apiBase;
    apiKey.value = chat.config.value.apiKey;
    model.value = chat.config.value.model;
    aiError.value = '';
    modelsHints.value = [];
  }
  if (t === 'desktop') void refreshDesktopSettings();
});

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = '';
  if (password.value && password.value !== passwordConfirm.value) {
    errorMsg.value = '两次输入的口令不一致';
    return;
  }
  if (!username.value && !password.value) {
    errorMsg.value = '请填写用户名或密码';
    return;
  }
  try {
    const body: Record<string, string> = {};
    if (username.value) body.username = username.value;
    if (password.value) body.password = password.value;
    await requestJson('/api/auth/credentials', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    emit('close');
    notify.success('凭据已更新，下次登录生效');
  } catch (err) {
    errorMsg.value = (err as Error).message || '保存失败';
  }
}

async function refreshDesktopSettings(): Promise<void> {
  if (!desktopAvailable.value) return;
  desktopLoading.value = true;
  desktopError.value = '';
  try {
    desktopSettings.value = await getDesktopSettings();
  } catch (err) {
    desktopError.value = (err as Error).message || '读取桌面设置失败';
  } finally {
    desktopLoading.value = false;
  }
}

async function onDesktopBackgroundChange(e: Event): Promise<void> {
  const enabled = (e.target as HTMLInputElement).checked;
  desktopError.value = '';
  desktopLoading.value = true;
  desktopSettings.value = { ...desktopSettings.value, backgroundEnabled: enabled };
  try {
    desktopSettings.value = await setDesktopBackgroundEnabled(enabled);
    notify.success(enabled ? '关闭窗口时将隐藏到后台' : '关闭窗口时将直接退出');
  } catch (err) {
    desktopError.value = (err as Error).message || '保存后台设置失败';
    await refreshDesktopSettings();
  } finally {
    desktopLoading.value = false;
  }
}

async function onDesktopAutostartChange(e: Event): Promise<void> {
  const enabled = (e.target as HTMLInputElement).checked;
  desktopError.value = '';
  desktopLoading.value = true;
  try {
    desktopSettings.value = await setDesktopAutostartEnabled(enabled);
    notify.success(enabled ? '已开启开机自启' : '已关闭开机自启');
  } catch (err) {
    desktopError.value = (err as Error).message || '保存开机自启失败';
    await refreshDesktopSettings();
  } finally {
    desktopLoading.value = false;
  }
}

async function onFetchModels(): Promise<void> {
  aiError.value = '';
  if (!apiBase.value.trim() || !apiKey.value.trim()) {
    aiError.value = '请先填写 API 地址和 Key';
    return;
  }
  fetching.value = true;
  try {
    const list = await chat.fetchModels(apiBase.value, apiKey.value);
    if (!list.length) {
      aiError.value = '未能获取到模型列表，请手动输入';
      return;
    }
    modelsHints.value = list;
  } catch (err) {
    aiError.value = '获取模型失败: ' + (err as Error).message;
  } finally {
    fetching.value = false;
  }
}

function onAiSubmit(e: Event): void {
  e.preventDefault();
  aiError.value = '';
  const cleanBase = apiBase.value.trim().replace(/\/$/, '');
  if (!cleanBase) {
    aiError.value = 'API 基础地址不能为空';
    return;
  }
  try { new URL(cleanBase); } catch {
    aiError.value = 'API 基础地址格式不正确';
    return;
  }
  chat.saveConfig({
    apiBase: cleanBase,
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
  });
  notify.success('AI 配置已保存');
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div class="modal-box w-full max-w-lg bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-[#1e293b]">
        <div class="modal-header flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="modal-title text-base font-bold text-slate-700 dark:text-slate-200">系统设置</div>
          <button
            class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 dark:text-slate-300 hover:text-red-500 hover:border-red-200 transition-all"
            type="button"
            @click="emit('close')"
          >关闭</button>
        </div>

        <!-- Tab 切换 -->
        <div class="flex gap-1 px-5 pt-4">
          <button
            v-if="desktopAvailable"
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'desktop' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'desktop'"
          >桌面端</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'account' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'account'"
          >账号设置</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'ipfilter' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'ipfilter'"
          >IP 访问控制</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'aiconfig' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'aiconfig'"
          >AI 配置</button>
        </div>

        <!-- 桌面端 -->
        <div v-if="tab === 'desktop'" class="p-5 flex flex-col gap-4">
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] p-4 flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">关闭窗口后保持后台运行</div>
              <div class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                开启后点击右上角 × 只隐藏窗口，托盘图标仍可重新打开；托盘菜单可彻底退出。
              </div>
            </div>
            <label class="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                class="sr-only peer"
                :checked="desktopSettings.backgroundEnabled"
                :disabled="desktopLoading || !desktopBackgroundAvailable"
                @change="onDesktopBackgroundChange"
              />
              <span class="h-6 w-11 rounded-full bg-slate-300 peer-checked:bg-blue-500 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-5"></span>
            </label>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] p-4 flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">开机自启</div>
              <div class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">登录系统后自动启动 1Shell。</div>
            </div>
            <label class="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                class="sr-only peer"
                :checked="desktopSettings.autostartEnabled"
                :disabled="desktopLoading || !desktopSettings.autostartAvailable"
                @change="onDesktopAutostartChange"
              />
              <span class="h-6 w-11 rounded-full bg-slate-300 peer-checked:bg-blue-500 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-5"></span>
            </label>
          </div>
          <div class="text-xs text-slate-400">{{ desktopLoading ? '读取桌面设置中…' : '设置会立即生效。' }}</div>
          <div v-if="desktopError" class="text-xs text-red-500">{{ desktopError }}</div>
        </div>

        <!-- 账号设置 -->
        <form v-else-if="tab === 'account'" class="p-5 flex flex-col gap-4" autocomplete="off" @submit="onSubmit">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">用户名</label>
            <input
              v-model="username"
              type="text"
              placeholder="admin"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">新访问口令</label>
            <input
              v-model="password"
              type="password"
              placeholder="留空表示不修改"
              autocomplete="new-password"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">确认新访问口令</label>
            <input
              v-model="passwordConfirm"
              type="password"
              placeholder="再次输入新口令"
              autocomplete="new-password"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
            <div class="text-red-500 text-xs">{{ errorMsg }}</div>
            <button
              type="submit"
              class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all"
            >保存设置</button>
          </div>
        </form>

        <!-- IP 访问控制 -->
        <IpFilterTab v-else-if="tab === 'ipfilter'" />

        <!-- AI 配置 -->
        <form v-else-if="tab === 'aiconfig'" class="p-5 flex flex-col gap-4" autocomplete="off" @submit="onAiSubmit">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">API 基础地址</label>
            <input
              v-model="apiBase"
              type="text"
              placeholder="https://api.openai.com/v1"
              required
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
            <div class="text-[11px] text-slate-400">不含 /chat/completions 的完整地址</div>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">API Key</label>
            <input
              v-model="apiKey"
              type="password"
              placeholder="sk-..."
              autocomplete="off"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">模型名称</label>
            <div class="flex gap-2">
              <input
                v-model="model"
                type="text"
                placeholder="gpt-4o"
                list="settings-ai-model-list"
                class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
              <button
                type="button"
                class="h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all whitespace-nowrap disabled:opacity-50"
                :disabled="fetching"
                @click="onFetchModels"
              >{{ fetching ? '获取中…' : '获取模型' }}</button>
            </div>
            <datalist id="settings-ai-model-list">
              <option v-for="m in modelsHints" :key="m" :value="m" />
            </datalist>
            <div class="text-[11px] text-slate-400">点击"获取模型"自动填充，也可手动输入</div>
          </div>
          <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
            <div class="text-red-500 text-xs">{{ aiError }}</div>
            <button
              type="submit"
              class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all"
            >保存配置</button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
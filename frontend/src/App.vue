<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { prefetchProbePageState } from '@/composables/useProbePrefetch';
import { useAuthStore } from '@/stores/auth';
import AppSidebar from './components/AppSidebar.vue';
import ToastHost from './components/ToastHost.vue';
import AppAiFab from './components/AppAiFab.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import AppBackground from './components/AppBackground.vue';
import LoginScreen from './components/main/LoginScreen.vue';

interface AuthStatusResp {
  enabled?: boolean;
  authenticated?: boolean;
}

const auth = useAuthStore();
const { requestJson } = useApiClient();

const bootstrapping = ref(true);
const bootstrapError = ref<string | null>(null);

function prefetchProbeSilently(force = false): void {
  void prefetchProbePageState(requestJson, force).catch(() => undefined);
}

// 全局登录闸门：auth 启用且未登录 → 必须先登录
const needLogin = computed(() => auth.enabled && !auth.authenticated);

async function bootstrapAuth(): Promise<void> {
  try {
    const data = await requestJson<AuthStatusResp>('/api/auth/status');
    auth.setEnabled(Boolean(data.enabled));
    auth.setAuthenticated(Boolean(data.authenticated));
    if (!data.enabled || data.authenticated) prefetchProbeSilently();
    bootstrapError.value = null;
  } catch (err) {
    // 后端不可达：保持未登录态，让 LoginScreen 自己显示报错
    auth.setEnabled(true);
    auth.setAuthenticated(false);
    bootstrapError.value = (err as ApiError | Error).message || '无法连接服务器';
  } finally {
    bootstrapping.value = false;
  }
}

function onLoggedIn(): void {
  prefetchProbeSilently(true);
}

onMounted(() => {
  void bootstrapAuth();
});
</script>

<template>
  <!-- 启动期 splash：等 /api/auth/status 返回，避免地图先闪一下 -->
  <div
    v-if="bootstrapping"
    class="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950 text-slate-400 text-sm select-none"
  >
    <div class="flex items-center gap-3">
      <span class="inline-block w-3 h-3 rounded-full bg-sky-400 animate-pulse"></span>
      <span>1Shell 启动中…</span>
    </div>
  </div>

  <!-- 全局登录 gate -->
  <LoginScreen v-else-if="needLogin" @logged-in="onLoggedIn" />

  <!-- 已登录或 auth 关闭 → 正常 app shell -->
  <div v-else class="min-h-screen flex text-slate-100 isolate">
    <AppBackground />
    <AppSidebar />
    <main class="flex-1 min-w-0 overflow-hidden">
      <RouterView v-slot="{ Component }">
        <KeepAlive>
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
    <ToastHost />
    <AppAiFab />
    <ConfirmModal />
  </div>
</template>

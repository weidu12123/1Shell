<script setup lang="ts">
// 登录页 — 老 [public/index.html#L149-L175](public/index.html#L149-L175) + [public/auth.js](public/auth.js) 1:1
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useAuthStore } from '@/stores/auth';
import LoginGlobe from '@/components/main/LoginGlobe.vue';

const emit = defineEmits<{
  'logged-in': [];
}>();

const { requestJson } = useApiClient();
const auth = useAuthStore();

const LAST_USER_KEY = '1shell.last-login-user';

const username = ref('');
const password = ref('');
const errorMsg = ref('');
const submitting = ref(false);
const usernameInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const capsLockOn = ref(false);
const passwordFocused = ref(false);

function detectCapsLock(e: KeyboardEvent): void {
  if (typeof e.getModifierState === 'function') {
    capsLockOn.value = e.getModifierState('CapsLock');
  }
}

onMounted(async () => {
  // 恢复上次登录用户名（不存密码）
  try {
    const last = localStorage.getItem(LAST_USER_KEY);
    if (last) username.value = last;
  } catch {
    /* localStorage 不可用就算了 */
  }

  await nextTick();
  // 已经填了用户名 → 直接焦点到密码框
  if (username.value) passwordInput.value?.focus();
  else usernameInput.value?.focus();

  window.addEventListener('keydown', detectCapsLock);
  window.addEventListener('keyup', detectCapsLock);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', detectCapsLock);
  window.removeEventListener('keyup', detectCapsLock);
});

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = '';
  submitting.value = true;

  try {
    await requestJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: username.value || '',
        password: password.value,
      }),
    });
    password.value = '';

    // 重新检查 auth 状态（与老版 checkAuthStatus 同套路）
    const data = await requestJson<{ enabled?: boolean; authenticated?: boolean }>('/api/auth/status');
    auth.setEnabled(Boolean(data.enabled));
    auth.setAuthenticated(Boolean(data.authenticated));
    auth.setUser({ username: username.value });

    if (auth.authenticated) {
      // 写入上次登录名以便下次自动填充
      try {
        localStorage.setItem(LAST_USER_KEY, username.value);
      } catch {
        /* noop */
      }
      username.value = '';
      emit('logged-in');
    } else {
      errorMsg.value = '登录成功，但会话同步失败，请刷新页面重试。';
    }
  } catch (err) {
    errorMsg.value = (err as ApiError | Error).message || '登录失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-screen fixed inset-0 z-[9000] flex items-center justify-center p-6 overflow-hidden">
    <!-- 地球背景层 -->
    <LoginGlobe class="globe-layer" :speed="3" />

    <!-- 登录卡片 -->
    <div
      class="card-layer relative w-full max-w-sm p-8 rounded-3xl shadow-2xl border
             bg-white/80 backdrop-blur-2xl border-white/60
             dark:bg-slate-900/70 dark:border-slate-700/60
             text-slate-800 dark:text-slate-100"
    >
      <div class="text-3xl font-extrabold bg-gradient-to-r from-sky-400 via-blue-500 to-purple-500 bg-clip-text text-transparent">
        1Shell
      </div>
      <div class="mt-0.5 text-[11px] text-slate-400 italic font-medium tracking-wide">
        One Shell to rule them all.
      </div>
      <div class="mt-1 text-slate-500 dark:text-slate-400 text-sm">
        请输入账号和密码后进入多 VPS 控制台
      </div>

      <form class="mt-6 flex flex-col gap-4" autocomplete="off" @submit="onSubmit">

        <div class="flex flex-col gap-1.5">
          <label for="login-username" class="text-xs font-semibold text-slate-500 dark:text-slate-400">用户名</label>
          <input
            id="login-username"
            ref="usernameInput"
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="admin"
            required
            class="w-full h-9 px-3 rounded-lg border text-sm outline-none transition
                   border-slate-300 bg-white text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-100
                   dark:border-slate-600 dark:bg-slate-800/70 dark:text-slate-100 dark:focus:border-sky-400 dark:focus:ring-sky-900/40"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="login-password" class="text-xs font-semibold text-slate-500 dark:text-slate-400">访问口令</label>
          <input
            id="login-password"
            ref="passwordInput"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="输入访问口令"
            required
            class="w-full h-9 px-3 rounded-lg border text-sm outline-none transition
                   border-slate-300 bg-white text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-100
                   dark:border-slate-600 dark:bg-slate-800/70 dark:text-slate-100 dark:focus:border-sky-400 dark:focus:ring-sky-900/40"
            @focus="passwordFocused = true"
            @blur="passwordFocused = false"
            @keydown="detectCapsLock"
          />
          <div
            v-if="passwordFocused && capsLockOn"
            class="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1"
          >
            <span>⇪</span><span>大写锁定已开启</span>
          </div>
        </div>

        <div v-if="errorMsg" class="text-red-500 dark:text-red-400 text-xs">{{ errorMsg }}</div>

        <button
          type="submit"
          :disabled="submitting"
          class="h-9 rounded-lg bg-gradient-to-r from-sky-500 to-blue-600 text-white font-semibold text-sm shadow-md hover:shadow-lg transition-all disabled:opacity-50"
        >{{ submitting ? '登录中...' : '登录' }}</button>
      </form>
    </div>

    <!-- 底部 slogan -->
    <div class="bottom-tag absolute bottom-4 left-0 right-0 text-center text-[10px] text-slate-500 dark:text-slate-500 pointer-events-none select-none">
      1Shell · One Shell to rule them all
    </div>
  </div>
</template>

<style scoped>
.login-screen {
  /* 没有 LoginGlobe 兜底时的 fallback 背景 */
  background: linear-gradient(180deg, #e8eef8 0%, #cfd9e8 100%);
}
:global(html.dark) .login-screen {
  background: linear-gradient(180deg, #050b1a 0%, #020611 100%);
}

.globe-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.card-layer {
  z-index: 1;
  animation: card-in 480ms ease-out both;
}
.bottom-tag {
  z-index: 1;
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .card-layer {
    animation: none;
  }
}
</style>

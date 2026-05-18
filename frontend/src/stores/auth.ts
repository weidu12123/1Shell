import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * 登录态 store — cookie-based（后端 session cookie；前端只跟踪 enabled/authenticated 状态）
 * 与老 [public/auth.js](public/auth.js) 1:1：state.authEnabled / state.authenticated
 *
 * 注意：useApiClient 在 401 时调 `auth.logout()` — 这里 logout() 只清前端 state，不发 API。
 */
export const useAuthStore = defineStore('auth', () => {
  const enabled = ref<boolean>(false);
  const authenticated = ref<boolean>(false);
  const username = ref<string | null>(null);

  /** 兼容旧字段 — useApiClient 还在引用 isLoggedIn */
  const isLoggedIn = computed(() => authenticated.value);
  const token = computed(() => (authenticated.value ? 'cookie' : null)); // 占位避免破坏旧引用

  function setEnabled(v: boolean): void {
    enabled.value = v;
  }

  function setAuthenticated(v: boolean): void {
    authenticated.value = v;
  }

  function setUser(u: { username?: string } | null): void {
    username.value = u?.username || null;
  }

  /** 401 时被 useApiClient 调用，仅清前端 state（cookie 由后端处理） */
  function logout(): void {
    authenticated.value = false;
    username.value = null;
  }

  function setToken(_: string | null): void { /* no-op，cookie-based */ }

  return {
    enabled, authenticated, username,
    isLoggedIn, token,
    setEnabled, setAuthenticated, setUser, setToken, logout,
  };
});

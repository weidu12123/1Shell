import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function useApiClient() {
  const router = useRouter();
  const auth = useAuthStore();

  async function requestJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    const needsCsrf = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    // CSRF 头必须在用户 headers 之后合并，否则会被用户传入的 headers 覆盖
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (needsCsrf) headers['x-csrf-token'] = getCsrfToken();

    const response = await fetch(url, { ...options, headers });
    let data: Record<string, unknown> = {};
    try { data = await response.json(); } catch { /* 非 JSON 响应（如 204），忽略 */ }

    if (!response.ok) {
      const message = (typeof data.error === 'string' && data.error)
        || response.statusText
        || '请求失败';
      if (response.status === 401) {
        auth.logout();
        router.push('/');
      }
      throw new ApiError(message, response.status, data);
    }
    return data as T;
  }

  return { requestJson };
}

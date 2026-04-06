(() => {
  'use strict';

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function createRequestJson({ onUnauthorized } = {}) {
    return async function requestJson(url, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      const csrfHeaders = (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS')
        ? { 'x-csrf-token': getCsrfToken() }
        : {};

      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...csrfHeaders,
          ...(options.headers || {}),
        },
        ...options,
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data.error || response.statusText || '请求失败';
        if (response.status === 401 && typeof onUnauthorized === 'function') {
          onUnauthorized(message, url, response);
        }
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    };
  }

  // ─── Toast 通知系统 ────────────────────────────────────────────────

  let toastContainer = null;

  function ensureToastContainer() {
    if (toastContainer) return toastContainer;
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:380px;';
    document.body.appendChild(toastContainer);
    return toastContainer;
  }

  /**
   * 显示 Toast 通知
   * @param {string} message - 消息内容
   * @param {'info'|'success'|'warn'|'error'} [type='info']
   * @param {number} [duration=3500] - 持续毫秒数
   */
  function showToast(message, type = 'info', duration = 3500) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');

    const colors = {
      info: { bg: 'rgba(79,140,255,0.15)', border: 'rgba(79,140,255,0.4)', text: '#bcd3ff', icon: 'i' },
      success: { bg: 'rgba(22,163,74,0.15)', border: 'rgba(22,163,74,0.4)', text: '#86efac', icon: '+' },
      warn: { bg: 'rgba(217,119,6,0.15)', border: 'rgba(217,119,6,0.4)', text: '#fcd34d', icon: '!' },
      error: { bg: 'rgba(220,38,38,0.15)', border: 'rgba(220,38,38,0.4)', text: '#fca5a5', icon: 'x' },
    };
    const c = colors[type] || colors.info;

    toast.style.cssText = `
      pointer-events:auto;padding:12px 16px;border-radius:12px;
      background:${c.bg};border:1px solid ${c.border};color:${c.text};
      backdrop-filter:blur(16px);box-shadow:0 8px 24px rgba(0,0,0,0.3);
      font-size:13px;line-height:1.5;display:flex;gap:10px;align-items:flex-start;
      animation:toast-in 0.3s ease;max-width:100%;word-break:break-word;
    `;
    toast.innerHTML = `<span style="font-weight:700;flex-shrink:0;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;background:${c.border}">${c.icon}</span><span>${escapeHtml(message)}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toast-out 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Toast 动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes toast-in { from { opacity:0; transform:translateX(40px); } to { opacity:1; transform:translateX(0); } }
    @keyframes toast-out { from { opacity:1; transform:translateX(0); } to { opacity:0; transform:translateX(40px); } }
  `;
  document.head.appendChild(style);

  function showErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || '操作失败');
    showToast(message, 'error', 5000);
  }

  window.appShared = Object.freeze({
    createRequestJson,
    escapeHtml,
    showErrorMessage,
    showToast,
  });
})();

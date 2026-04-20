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

      // ⚠️ headers 必须放在 `...options` 之后合并，
      // 否则调用方传入 options.headers 时会整块覆盖 csrfHeaders，导致 CSRF 失败。
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
          ...csrfHeaders,
        },
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

  // ─── render_result 共享渲染器 ────────────────────────────────────────
  // 把 AI 的 render_result payload 渲染成一个 HTMLElement，可插入任何容器。
  // 使用方：skill-studio.js、skills-page.js、programs-page.js

  function renderResultCard(payload, { onRowAction } = {}) {
    const p = payload || {};
    const level  = p.level  || 'info';
    const format = p.format || 'message';

    const el = document.createElement('div');
    el.className = `render-card level-${escapeHtml(level)}`;

    // ── 标题区 ──────────────────────────────────────────────────────
    let html = '';
    if (p.title) {
      html += `<div class="render-card-title">${escapeHtml(p.title)}</div>`;
    }
    if (p.subtitle) {
      html += `<div class="render-card-subtitle">${escapeHtml(p.subtitle)}</div>`;
    }

    // ── 内容区 ──────────────────────────────────────────────────────
    if (format === 'table') {
      html += _renderTable(p);
    } else if (format === 'keyvalue') {
      html += _renderKeyValue(p);
    } else if (format === 'list') {
      html += _renderList(p);
    } else if (format === 'code') {
      html += _renderCode(p);
    } else {
      // message（默认）
      html += _renderMessage(p);
    }

    el.innerHTML = html;

    // ── 行操作按钮事件 ────────────────────────────────────────────
    if (format === 'table' && typeof onRowAction === 'function') {
      el.querySelectorAll('[data-row-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const rowIndex = parseInt(btn.dataset.rowIndex, 10);
          onRowAction(rowIndex, btn.dataset.rowAction, p);
        });
      });
    }

    return el;
  }

  // ── 内部渲染函数 ─────────────────────────────────────────────────────

  function _renderTable(p) {
    const cols    = Array.isArray(p.columns)    ? p.columns    : [];
    const rows    = Array.isArray(p.rows)       ? p.rows       : [];
    const actions = Array.isArray(p.rowActions) ? p.rowActions : [];

    if (rows.length === 0) {
      return '<div class="render-empty">（空）</div>';
    }

    const thead = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') +
      (actions.length ? '<th class="text-right">操作</th>' : '');

    const tbody = rows.map((row, rowIndex) => {
      const cells = Array.isArray(row)
        ? row.map((c) => `<td class="align-middle">${escapeHtml(String(c == null ? '' : c))}</td>`).join('')
        : `<td colspan="${cols.length}" class="text-slate-400">${escapeHtml(String(row))}</td>`;

      const name = Array.isArray(row) ? String(row[0] || '') : '';
      const isProtected = /1shell/i.test(name);

      const actionCell = actions.length
        ? `<td class="text-right align-middle whitespace-nowrap">${
            isProtected
              ? '<span class="text-[10px] text-slate-400 italic">受保护</span>'
              : actions.map((a) =>
                  `<button class="row-action-btn text-[10px] px-2 py-1 rounded border border-slate-200 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 hover:border-blue-400 text-slate-600 dark:text-slate-300 mr-1 transition-all"
                     data-row-index="${rowIndex}" data-row-action="${escapeHtml(a.value || '')}">${escapeHtml(a.label || a.value || '执行')}</button>`
                ).join('')
          }</td>`
        : '';

      return `<tr>${cells}${actionCell}</tr>`;
    }).join('');

    return `
      <div class="overflow-x-auto mt-2">
        <table class="result-table w-full text-xs border-collapse">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;
  }

  function _renderKeyValue(p) {
    // 支持两种格式：items:[{key,value}] 或 data:{key:value}
    let items = [];
    if (Array.isArray(p.items) && p.items.length > 0) {
      items = p.items;
    } else if (p.data && typeof p.data === 'object') {
      items = Object.entries(p.data).map(([key, value]) => ({ key, value }));
    }
    if (items.length === 0) return '<div class="render-empty">（无内容）</div>';

    return `
      <div class="grid grid-cols-1 gap-1.5 mt-2">
        ${items.map((item) => `
          <div class="flex items-start gap-3 text-xs">
            <div class="w-28 shrink-0 text-slate-500 dark:text-slate-400 font-medium">${escapeHtml(item.key || '')}</div>
            <div class="flex-1 text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap break-all">${escapeHtml(String(item.value == null ? '' : item.value))}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function _renderList(p) {
    const items = Array.isArray(p.listItems) ? p.listItems : [];
    if (items.length === 0) return '<div class="render-empty">（空）</div>';
    return `
      <div class="flex flex-col gap-2 mt-2">
        ${items.map((item) => `
          <div class="border-l-2 border-blue-300 dark:border-blue-500/60 pl-3">
            <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escapeHtml(item.title || '')}</div>
            ${item.description ? `<div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(item.description)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  function _renderCode(p) {
    return `
      <pre class="render-code mt-2 text-xs bg-slate-900 text-green-300 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all"><code>${escapeHtml(p.content || '')}</code></pre>
    `;
  }

  function _renderMessage(p) {
    const icons = { success: '✓', error: '✗', warn: '⚠', info: 'ℹ' };
    const icon = icons[p.level] || '';
    return `
      <div class="flex items-start gap-2 mt-1 text-xs text-slate-600 dark:text-slate-300">
        ${icon ? `<span class="shrink-0 font-bold">${icon}</span>` : ''}
        <div class="whitespace-pre-wrap">${escapeHtml(p.content || '')}</div>
      </div>
    `;
  }

  window.appShared = Object.freeze({
    createRequestJson,
    escapeHtml,
    getCsrfToken,
    showErrorMessage,
    showToast,
    renderResultCard,
  });
})();

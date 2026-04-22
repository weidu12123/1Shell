/**
 * 前端事件总线
 *
 * 轻量级跨模块事件通信，替代手动的 syncActiveHost() 链式调用。
 *
 * 使用方式：
 *   window.appBus.on('host:changed', (host) => { ... });
 *   window.appBus.emit('host:changed', host);
 *
 * 事件类型：
 *   - host:changed     — 活跃主机切换
 *   - session:changed  — 活跃会话切换
 *   - auth:login       — 登录成功
 *   - auth:logout      — 退出登录
 */
(() => {
  'use strict';

  const listeners = new Map();

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    // 返回取消订阅函数
    return () => listeners.get(event)?.delete(fn);
  }

  function off(event, fn) {
    listeners.get(event)?.delete(fn);
  }

  function emit(event, ...args) {
    const fns = listeners.get(event);
    if (!fns) return;
    for (const fn of fns) {
      try { fn(...args); } catch (_) { /* 事件处理不应阻塞 */ }
    }
  }

  function once(event, fn) {
    const unsub = on(event, (...args) => {
      unsub();
      fn(...args);
    });
    return unsub;
  }

  window.appBus = Object.freeze({ on, off, emit, once });
})();

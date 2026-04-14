(() => {
  'use strict';

  const { createRequestJson, escapeHtml, showErrorMessage } = window.appShared;

  const requestJson = createRequestJson({
    onUnauthorized: () => {
      window.location.href = 'index.html';
    },
  });

  const socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });

  const probeModule = window.createProbeModule({
    escapeHtml,
    getSocket: () => socket,
    requestJson,
    showErrorMessage,
  });

  probeModule.initialize();

  const themeBtn = document.getElementById('theme-toggle-btn');
  const themeIcon = document.getElementById('theme-icon');
  const htmlEl = document.documentElement;
  if (localStorage.getItem('1shell-theme') === 'dark') {
    htmlEl.classList.add('dark');
    if (themeIcon) themeIcon.textContent = '☀';
  } else if (themeIcon) {
    themeIcon.textContent = '🌙';
  }

  themeBtn?.addEventListener('click', () => {
    const isDark = htmlEl.classList.toggle('dark');
    if (themeIcon) themeIcon.textContent = isDark ? '☀' : '🌙';
    localStorage.setItem('1shell-theme', isDark ? 'dark' : 'light');
  });
})();

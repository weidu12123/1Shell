'use strict';

const express = require('express');
const helmet = require('helmet');
const path = require('path');

function createApp(rootDir) {
  const app = express();

  // HTTP 安全头：禁用 X-Powered-By、添加 XSS / MIME / Frame 保护等
  app.use(helmet({
    // Socket.IO 和 xterm.js 的 CDN 资源需要放行 CSP
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
        fontSrc: ["'self'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
      },
    },
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(rootDir, 'public')));
  return app;
}

module.exports = {
  createApp,
};

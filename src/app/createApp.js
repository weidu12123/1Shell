'use strict';

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

function createApp(rootDir) {
  const app = express();

  // HTTP 安全头：禁用 X-Powered-By、添加 XSS / MIME / Frame 保护等
  app.use(helmet({
    strictTransportSecurity: false,
    // Socket.IO 和 xterm.js 的 CDN 资源需要放行 CSP
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
        fontSrc: ["'self'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: null,
      },
    },
  }));

  app.use(express.json({ limit: '50mb' }));

  // ─── 新前端 (Vue SPA) ────────────────────────────────────────────
  // `/` → `/app/` 重定向，让新前端成为默认入口（老前端仍可通过 /index.html 等直接访问）
  const frontendDist = path.join(rootDir, 'frontend', 'dist');
  const spaIndex = path.join(frontendDist, 'index.html');
  const spaBuilt = fs.existsSync(spaIndex);

  if (spaBuilt) {
    app.get('/', (req, res) => res.redirect(302, '/app/'));
    app.use('/app', express.static(frontendDist, {
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      },
    }));
    // SPA fallback：未匹配静态资源的 /app/* 路径交给 Vue Router
    app.get(/^\/app(?:\/.*)?$/, (req, res, next) => {
      res.sendFile(spaIndex, (err) => { if (err) next(err); });
    });
  }

  // ─── 静态资源（favicon 等） ───
  app.use(express.static(path.join(rootDir, 'public'), { maxAge: '1h' }));

  // ─── Probe / Relay Agent 二进制（公开下载或 SSH 注入） ───
  // 探针安装脚本取 probe-agent-linux-{amd64,arm64}；Relay 安装器优先通过 SFTP 注入 probe-relay-agent。
  // 公开是为了让 root 用户在还未持有 agent token 的状态下也能拉到二进制。
  const agentDir = path.join(rootDir, 'agent');
  const agentDist = path.join(agentDir, 'dist');
  const agentInstallScript = path.join(agentDir, 'install.sh');
  if (fs.existsSync(agentInstallScript)) {
    app.get('/install.sh', (_req, res) => {
      res.type('text/x-shellscript');
      res.sendFile(agentInstallScript);
    });
  }
  if (fs.existsSync(agentDist)) {
    app.use('/agent-dist', express.static(agentDist, {
      maxAge: '1h',
      fallthrough: false,
    }));
  }
  return app;
}

module.exports = {
  createApp,
};

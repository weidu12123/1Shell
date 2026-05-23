'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, ipcMain } = require('electron');

app.setName('1Shell');
Menu.setApplicationMenu(null);

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendRoot = null;
let backendPort = 3301;
let isQuitting = false;

function mainLog(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'desktop-main.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Ignore early logging failures.
  }
}

function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function resolveBackendRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'backend');
  return path.resolve(__dirname, '..');
}

function getLogPath() {
  return path.join(backendRoot, 'logs', 'desktop.log');
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(getLogPath()), { recursive: true });
    fs.appendFileSync(getLogPath(), line, 'utf8');
  } catch {
    // Logging must never prevent app startup.
  }
}

function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    function probe(port) {
      const server = net.createServer();
      server.once('error', () => probe(port + 1));
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    }
    probe(startPort);
  });
}

function readEnvValue(name) {
  const envPath = path.join(backendRoot, '.env');
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    const match = env.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

async function ensureEnv() {
  const envPath = path.join(backendRoot, '.env');
  if (fs.existsSync(envPath)) {
    const configuredPort = Number(readEnvValue('PORT'));
    backendPort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3301;
    return;
  }

  backendPort = await findAvailablePort(3301);
  const content = [
    'OPENAI_API_BASE=https://api.openai.com/v1',
    'OPENAI_API_KEY=',
    'OPENAI_MODEL=gpt-4o',
    'APP_LOGIN_USERNAME=',
    'APP_LOGIN_PASSWORD=',
    `APP_SECRET=${randomSecret(32)}`,
    'APP_SESSION_TTL_HOURS=12',
    `PORT=${backendPort}`,
    `BRIDGE_TOKEN=${randomSecret(32)}`,
    '',
  ].join('\n');

  fs.writeFileSync(envPath, content, 'utf8');
}

function backendCommand(serverPath) {
  const bundledNode = path.join(backendRoot, 'node', 'node.exe');
  if (process.platform === 'win32' && fs.existsSync(bundledNode)) {
    return { executable: bundledNode, args: [serverPath], env: {} };
  }
  return {
    executable: process.execPath,
    args: [serverPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function startBackend() {
  if (backendProcess && !backendProcess.killed) return;

  const serverPath = path.join(backendRoot, 'server.js');
  const command = backendCommand(serverPath);
  const env = {
    ...process.env,
    ...command.env,
    NODE_PATH: path.join(backendRoot, 'deps'),
    PORT: String(backendPort),
    ELECTRON_DESKTOP: '1',
    ONESHELL_DESKTOP: '1',
  };

  appendLog(`\n[desktop] starting backend: ${new Date().toISOString()}\n`);
  backendProcess = spawn(command.executable, command.args, {
    cwd: backendRoot,
    env,
    windowsHide: true,
  });

  backendProcess.stdout.on('data', chunk => appendLog(chunk.toString()));
  backendProcess.stderr.on('data', chunk => appendLog(chunk.toString()));
  backendProcess.on('exit', (code, signal) => {
    appendLog(`[desktop] backend exited code=${code} signal=${signal}\n`);
    backendProcess = null;
    if (!isQuitting && mainWindow) showErrorPage('本地服务已停止。', '请从托盘菜单选择“重启服务”，或退出后重新打开 1Shell。');
  });
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) return;
  const pid = backendProcess.pid;
  backendProcess.kill('SIGINT');
  if (process.platform === 'win32' && pid) {
    setTimeout(() => {
      if (backendProcess) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    }, 1500).unref();
  }
}

function waitForHealth(deadlineMs = 30000) {
  const startedAt = Date.now();
  const healthUrl = `http://127.0.0.1:${backendPort}/api/health`;

  return new Promise((resolve, reject) => {
    function retry() {
      if (Date.now() - startedAt > deadlineMs) {
        reject(new Error(`Backend did not become ready at ${healthUrl}`));
        return;
      }
      setTimeout(probe, 500);
    }

    function probe() {
      const req = http.get(healthUrl, res => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    }

    probe();
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadingHtml(message, detail = '') {
  const safeMessage = escapeHtml(message);
  const safeDetail = escapeHtml(detail);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>1Shell</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 35%,#102347 0,#08111f 42%,#050914 100%);color:#e5eefc;font-family:"Segoe UI",Arial,sans-serif}.card{width:min(520px,calc(100vw - 48px));padding:42px 40px;border:1px solid rgba(148,163,184,.2);border-radius:24px;background:rgba(8,15,29,.72);box-shadow:0 24px 80px rgba(0,0,0,.38);text-align:center;backdrop-filter:blur(18px)}.mark{width:54px;height:54px;margin:0 auto 22px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(135deg,#2563eb,#06b6d4);font-size:25px;font-weight:800;letter-spacing:-.04em}.title{font-size:28px;font-weight:700;letter-spacing:-.03em;margin-bottom:10px}.sub{font-size:15px;line-height:1.7;color:#a7b6cc}.detail{margin-top:18px;padding:12px 14px;border-radius:12px;background:rgba(15,23,42,.8);color:#7dd3fc;font-size:13px;line-height:1.6}.spinner{width:22px;height:22px;margin:24px auto 0;border:2px solid rgba(148,163,184,.25);border-top-color:#38bdf8;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><main class="card"><div class="mark">1_</div><div class="title">1Shell</div><div class="sub">${safeMessage}</div>${safeDetail ? `<div class="detail">${safeDetail}</div>` : '<div class="spinner"></div>'}</main></body></html>` )}`;
}

function showErrorPage(message, detail = '') {
  if (!mainWindow) return;
  mainWindow.loadURL(loadingHtml(message, detail));
}

function getDesktopSettingsPath() {
  return path.join(backendRoot, 'data', 'desktop-settings.json');
}

function readDesktopPreferences() {
  try {
    return JSON.parse(fs.readFileSync(getDesktopSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeDesktopPreferences(preferences) {
  const settingsPath = getDesktopSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(preferences, null, 2), 'utf8');
}

function getLoginItemOptions() {
  return process.platform === 'win32' ? { path: process.execPath } : {};
}

function desktopSettings() {
  const preferences = readDesktopPreferences();
  const loginItemSettings = app.getLoginItemSettings(getLoginItemOptions());
  return {
    isDesktop: true,
    runtime: 'electron',
    backgroundEnabled: preferences.backgroundEnabled === true,
    autostartEnabled: Boolean(loginItemSettings.openAtLogin),
    autostartAvailable: process.platform === 'win32' || process.platform === 'darwin',
  };
}

function setDesktopBackgroundEnabled(enabled) {
  writeDesktopPreferences({
    ...readDesktopPreferences(),
    backgroundEnabled: enabled,
  });
  return desktopSettings();
}

function setDesktopAutostartEnabled(enabled) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('当前系统不支持开机自启');
  }
  app.setLoginItemSettings({
    ...getLoginItemOptions(),
    openAtLogin: enabled,
    openAsHidden: false,
  });
  return desktopSettings();
}

function registerDesktopIpc() {
  ipcMain.handle('desktop:get-settings', () => desktopSettings());
  ipcMain.handle('desktop:set-background-enabled', (_event, enabled) => setDesktopBackgroundEnabled(Boolean(enabled)));
  ipcMain.handle('desktop:set-autostart-enabled', (_event, enabled) => setDesktopAutostartEnabled(Boolean(enabled)));
}

function iconPath() {
  const candidates = [
    path.join(backendRoot, 'frontend', 'dist', 'favicon.png'),
    path.join(backendRoot, 'public', 'favicon.ico'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function createWindow() {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '1Shell',
    autoHideMenuBar: true,
    icon: icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (desktopSettings().backgroundEnabled && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!isQuitting) quitApp();
  });

  mainWindow.loadURL(loadingHtml('正在启动本地服务，请稍候...'));
}

function createTray() {
  const icon = iconPath();
  if (!icon) return;

  const image = nativeImage.createFromPath(icon);
  if (image.isEmpty()) return;

  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('1Shell');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 1Shell', click: () => showMainWindow() },
    { label: '重启服务', click: () => restartBackend() },
    { label: '打开日志目录', click: () => shell.openPath(path.dirname(getLogPath())) },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]));
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

async function loadApp() {
  try {
    await waitForHealth();
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/app/?runtime=desktop`);
  } catch (error) {
    appendLog(`[desktop] ${error.stack || error.message}\n`);
    showErrorPage('本地服务启动失败。', '请打开托盘菜单中的日志目录，查看 desktop.log。');
  }
}

async function restartBackend() {
  stopBackend();
  await new Promise(resolve => setTimeout(resolve, 1200));
  startBackend();
  if (mainWindow) mainWindow.loadURL(loadingHtml('正在重启本地服务...'));
  await loadApp();
}

function quitApp() {
  isQuitting = true;
  stopBackend();
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  mainLog('single instance lock denied');
  app.quit();
} else {
  mainLog('single instance lock acquired');
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    mainLog('app ready');
    registerDesktopIpc();
    backendRoot = resolveBackendRoot();
    mainLog(`backendRoot=${backendRoot}`);
    await ensureEnv();
    mainLog(`backendPort=${backendPort}`);
    createWindow();
    createTray();
    startBackend();
    await loadApp();
  }).catch(error => {
    mainLog(`startup failed: ${error.stack || error.message}`);
    dialog.showErrorBox('1Shell failed to start', error.stack || error.message);
    app.quit();
  });

  app.on('activate', () => showMainWindow());
  app.on('before-quit', () => {
    isQuitting = true;
    stopBackend();
  });
  app.on('window-all-closed', () => {
    if (!isQuitting) quitApp();
  });
}

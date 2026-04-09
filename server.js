'use strict';

const path = require('path');

// BRIDGE_TOKEN 必须在 env.js 加载之前写入 process.env，
// 否则 env.js 缓存的 BRIDGE_TOKEN 常量会是空字符串。
const { ensureBridgeToken } = require('./lib/bridge-token');
ensureBridgeToken(path.join(__dirname, 'data'));

const { isUsingFallbackSecret } = require('./lib/crypto');
const log = require('./lib/logger');
const {
  HOSTS_FILE,
  PORT,
  ROOT_DIR,
  USING_DEFAULT_CREDENTIALS,
} = require('./src/config/env');
const { createApp } = require('./src/app/createApp');
const { createServer } = require('./src/app/createServer');
const { errorHandler } = require('./src/middleware/error.middleware');
const { createHostRepository } = require('./src/repositories/host.repository');
const { createScriptRepository } = require('./src/repositories/script.repository');
const { createAiRouter } = require('./src/routes/ai.routes');
const { createAuditRouter } = require('./src/routes/audit.routes');
const { createAuthRouter } = require('./src/routes/auth.routes');
const { createHealthRouter } = require('./src/routes/health.routes');
const { createHostRouter } = require('./src/routes/host.routes');
const { createProbeRouter } = require('./src/routes/probe.routes');
const { createScriptRouter } = require('./src/routes/script.routes');
const { createAgentProviders } = require('./src/agents/providers');
const { createAgentPtyService } = require('./src/agents/agent-pty.service');
const { registerAgentSocketHandlers } = require('./src/sockets/registerAgentSocketHandlers');
const { registerSessionSocketHandlers } = require('./src/sockets/registerSessionSocketHandlers');
const { createAIService } = require('./src/services/ai.service');
const { createAuditService } = require('./src/services/audit.service');
const { createBridgeService } = require('./src/services/bridge.service');
const { createScriptService } = require('./src/services/script.service');
const { createSshPool } = require('./src/services/ssh-pool.service');
const { createSshShellPool } = require('./src/services/ssh-shell-pool.service');
const { createDatabase } = require('./src/database/db');
const { createMcpService } = require('./src/mcp/mcp.service');
const { createBridgeRouter } = require('./src/routes/bridge.routes');
const { createMcpRouter } = require('./src/routes/mcp.routes');
const { createAgentSetupRouter } = require('./src/routes/agent-setup.routes');
const { createFileRouter } = require('./src/routes/file.routes');
const { createAuthService } = require('./src/services/auth.service');
const { createHostService } = require('./src/services/host.service');
const { createProbeService } = require('./src/services/probe.service');
const { createSessionService } = require('./src/services/session.service');
const { createFileService } = require('./src/services/file.service');
const { createIpFilterService } = require('./src/services/ip-filter.service');
const { createIpFilterRouter } = require('./src/routes/ip-filter.routes');

// ─── 初始化核心服务 ─────────────────────────────────────────────────────
const dataDir = path.join(ROOT_DIR, 'data');
const db = createDatabase(path.join(dataDir, '1shell.db'));
const app = createApp(ROOT_DIR);
const { io, server } = createServer(app);
const hostRepository = createHostRepository(HOSTS_FILE, db);
const scriptRepository = createScriptRepository(db);
const aiService = createAIService();
const authService = createAuthService();
const hostService = createHostService({ hostRepository });
const auditService = createAuditService({ db, dataDir });
const sessionService = createSessionService({ hostService });
const agentProviders = createAgentProviders();
const agentPtyService = createAgentPtyService({ hostService, providerRegistry: agentProviders });
const sshPool = createSshPool({ hostService });
const sshShellPool = createSshShellPool({ hostService });
const probeService = createProbeService({ hostRepository, hostService, sshShellPool });
const bridgeService = createBridgeService({ hostService, auditService, sshPool, sshShellPool });
const fileService = createFileService({ hostService });
const ipFilterService = createIpFilterService({ db });
const mcpService = createMcpService({ bridgeService, hostService, auditService });
const scriptService = createScriptService({ scriptRepository, hostService, bridgeService, auditService });

// ─── 路由挂载 ───────────────────────────────────────────────────────────
app.use('/api/auth', createAuthRouter(authService));

// 健康检查：公开端点，无需鉴权（供 CI / K8s / 负载均衡器使用）
app.use('/api', createHealthRouter({ isUsingFallbackSecret }));

// Bridge 内部 API 和 MCP 使用 BRIDGE_TOKEN 鉴权，不走 Web session
app.use('/api', createBridgeRouter({ bridgeService }));
app.use('/mcp', createMcpRouter({ mcpService }));

// IP 访问控制：在鉴权之前执行（未登录的请求也要过滤）
app.use(ipFilterService.ipFilterMiddleware);

// 以下路由需要 Web session 鉴权
app.use('/api', authService.requireAuth);
app.use('/api', createAiRouter(aiService));
app.use('/api', createAuditRouter({ auditService }));
app.use('/api', createHostRouter({
  hostRepository,
  hostService,
  auditService,
  isUsingFallbackSecret,
}));
app.use('/api', createProbeRouter({ probeService }));
app.use('/api', createAgentSetupRouter());
app.use('/api', createFileRouter({ fileService }));
app.use('/api', createIpFilterRouter({ ipFilterService }));
app.use('/api', createScriptRouter({ scriptService, aiService }));

// ─── Socket.IO ──────────────────────────────────────────────────────────
io.use(authService.authenticateSocket);
registerSessionSocketHandlers(io, { sessionService });
registerAgentSocketHandlers(io, { agentPtyService });

// ─── 定时任务 ───────────────────────────────────────────────────────────
probeService.startScheduler({
  onUpdate: (snapshot) => {
    io.emit('probe:update', snapshot);
  },
});

// ─── 启动 ───────────────────────────────────────────────────────────────
hostRepository.ensureHostsFile();
app.use(errorHandler);

server.listen(PORT, () => {
  log.info('1Shell 已启动', { port: PORT, url: `http://localhost:${PORT}`, db: db ? 'sqlite' : 'file' });
  if (isUsingFallbackSecret()) {
    log.warn('未设置 APP_SECRET，当前凭据加密使用默认开发密钥');
  }
  if (USING_DEFAULT_CREDENTIALS) {
    log.warn('⚠️  当前使用默认登录凭据 admin/admin，请在 .env 中设置 APP_LOGIN_USERNAME 和 APP_LOGIN_PASSWORD');
  }
});

// ─── 优雅退出 ───────────────────────────────────────────────────────────
function shutdown() {
  log.info('1Shell 正在关闭...');
  sshPool.closeAll();
  sshShellPool.closeAll();
  if (db) db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

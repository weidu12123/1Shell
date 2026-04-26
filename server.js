'use strict';

const path = require('path');

// BRIDGE_TOKEN 必须在 env.js 加载之前写入 process.env，
// 否则 env.js 缓存的 BRIDGE_TOKEN 常量会是空字符串。
const { ensureBridgeToken } = require('./lib/bridge-token');
ensureBridgeToken(path.join(__dirname, 'data'));

const { isUsingFallbackSecret } = require('./lib/crypto');
const log = require('./lib/logger');
const {
  BRIDGE_TOKEN,
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
const { createPlaybookRepository } = require('./src/repositories/playbook.repository');
const { createAiRouter } = require('./src/routes/ai.routes');
const { createAuditRouter } = require('./src/routes/audit.routes');
const { createAuthRouter } = require('./src/routes/auth.routes');
const { createHealthRouter } = require('./src/routes/health.routes');
const { createHostRouter } = require('./src/routes/host.routes');
const { createProbeRouter } = require('./src/routes/probe.routes');
const { createScriptRouter } = require('./src/routes/script.routes');
const { createWorkflowRouter } = require('./src/routes/playbook.routes');
const { createCliSandbox } = require('./src/agents/cli-sandbox');
const { createAgentProviders } = require('./src/agents/providers');
const { createAgentPtyService } = require('./src/agents/agent-pty.service');
const { registerAgentSocketHandlers } = require('./src/sockets/registerAgentSocketHandlers');
const { registerSessionSocketHandlers } = require('./src/sockets/registerSessionSocketHandlers');
const { createAIService } = require('./src/services/ai.service');
const { createAuditService } = require('./src/services/audit.service');
const { createBridgeService } = require('./src/services/bridge.service');
const { createScriptService } = require('./src/services/script.service');
const { createPlaybookService } = require('./src/services/playbook.service');
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
const { createSiteScanService } = require('./src/services/site-scan.service');
const { createSiteDeleteService } = require('./src/services/site-delete.service');
const { createIpFilterRouter } = require('./src/routes/ip-filter.routes');
const { createProxyRouter, createProxyConfigStore } = require('./src/routes/proxy.routes');
const { createSkillRegistry } = require('./src/skills/registry');
const { createLibraryService } = require('./src/skills/library.service');
const { createSkillRunner } = require('./src/skills/runner');
const { createSkillRouter } = require('./src/routes/skill.routes');
const { createSkillStudioRouter } = require('./src/routes/skill-studio.routes');
const { createMcpRegistry } = require('./src/services/mcp-registry.service');
const { createMcpRegistryRouter } = require('./src/routes/mcp-registry.routes');
const { createExecRouter } = require('./src/routes/exec.routes');
const { createDnsProviderRouter } = require('./src/routes/dns-provider.routes');
const { createSitesRouter } = require('./src/routes/sites.routes');
const { createProgramRegistry } = require('./src/programs/registry');
const { createProgramStateService } = require('./src/programs/state.service');
const { createProgramEngine } = require('./src/programs/engine');
const { createProgramRouter } = require('./src/routes/program.routes');
const { createGuardianService } = require('./src/guardian/guardian.service');
const { registerGuardianSocketHandlers } = require('./src/sockets/registerGuardianSocketHandlers');
const { registerSkillSocketHandlers } = require('./src/sockets/registerSkillSocketHandlers');
const { registerIdeSocketHandlers } = require('./src/sockets/registerIdeSocketHandlers');
const { createIdeTools } = require('./src/ide/ide.tools');
const { createIdeService } = require('./src/ide/ide.service');
const { createLocalMcpService } = require('./src/services/local-mcp.service');

// ─── 初始化核心服务 ─────────────────────────────────────────────────────
const dataDir = path.join(ROOT_DIR, 'data');
const db = createDatabase(path.join(dataDir, '1shell.db'));
const app = createApp(ROOT_DIR);
const { io, server } = createServer(app);
const hostRepository = createHostRepository(HOSTS_FILE, db);
const scriptRepository = createScriptRepository(db);
const playbookRepository = createPlaybookRepository(db);
const aiService = createAIService();
const authService = createAuthService();
const hostService = createHostService({ hostRepository });
const auditService = createAuditService({ db, dataDir });
const sessionService = createSessionService({ hostService });
const proxyConfigStore = createProxyConfigStore(dataDir);
const cliSandbox = createCliSandbox({ dataDir, bridgeToken: BRIDGE_TOKEN, port: PORT, proxyConfigStore });
const agentProviders = createAgentProviders({ cliSandbox });
const agentPtyService = createAgentPtyService({ hostService, providerRegistry: agentProviders });
const sshPool = createSshPool({ hostService });
const sshShellPool = createSshShellPool({ hostService });
const probeService = createProbeService({ hostRepository, hostService, sshShellPool });
const bridgeService = createBridgeService({ hostService, auditService, sshPool, sshShellPool });
const fileService = createFileService({ hostService });
const ipFilterService = createIpFilterService({ db });
const scriptService = createScriptService({ scriptRepository, hostService, bridgeService, auditService });
const playbookService = createPlaybookService({ playbookRepository, scriptService, auditService });
const skillRegistry = createSkillRegistry(path.join(dataDir, 'skills'), { kind: 'skill' });
const playbookRegistry = createSkillRegistry(path.join(dataDir, 'playbooks'), { kind: 'playbook' });
const libraryService = createLibraryService({ skillRegistry, playbookRegistry });
const mcpRegistry = createMcpRegistry({ dataDir });
const localMcpService = createLocalMcpService({ logger: log });
const skillRunner = createSkillRunner({
  bridgeService,
  hostService,
  skillRegistry: libraryService,  // runner 通过 library 统一查找 Skill/Playbook
  proxyConfigStore,
  port: PORT,
  auditService,
  logger: log,
  onFileWritten: () => {
    try { libraryService.reload(); } catch { /* ignore */ }
  },
});
const mcpService = createMcpService({ bridgeService, hostService, auditService, bridgeToken: BRIDGE_TOKEN, localMcpService, mcpRegistry });
const siteScanService = createSiteScanService({ bridgeService, hostService });
const siteDeleteService = createSiteDeleteService({ bridgeService });

// ─── Program Engine (长驻程序) + Guardian AI ───────────────────────────
const programRegistry = createProgramRegistry(path.join(dataDir, 'programs'));
const programStateService = createProgramStateService({ db });
const guardianService = createGuardianService({
  bridgeService,
  hostService,
  proxyConfigStore,
  port: PORT,
  auditService,
  logger: log,
  skillRegistry: libraryService,  // 用 libraryService 便于 getSkill 兼容 Skill/Playbook
  io,
});
const programEngine = createProgramEngine({
  registry: programRegistry,
  stateService: programStateService,
  bridgeService,
  hostService,
  auditService,
  logger: log,
  io,
  guardianService,
});

// ─── IDE Service (自由创作引擎) ─────────────────────────────────────────
const ideTools = createIdeTools({
  bridgeService,
  hostService,
  skillRegistry: libraryService,
  programEngine,
  skillRunner,
  auditService,
  mcpRegistry,
  localMcpService,
  scriptService,
  probeService,
  siteScanService,
  dataDir,
  onFileWritten: () => {
    try { libraryService.reload(); } catch { /* ignore */ }
    try { programRegistry.reload(); } catch { /* ignore */ }
  },
});
const ideService = createIdeService({
  ideTools,
  proxyConfigStore,
  port: PORT,
  hostService,
  auditService,
  logger: log,
  localMcpService,
  mcpRegistry,
});

// ─── 路由挂载 ───────────────────────────────────────────────────────────
app.use('/api/auth', createAuthRouter(authService));

// 健康检查：公开端点，无需鉴权（供 CI / K8s / 负载均衡器使用）
app.use('/api', createHealthRouter({ isUsingFallbackSecret }));

// Bridge 内部 API 和 MCP 使用 BRIDGE_TOKEN 鉴权，不走 Web session
app.use('/api', createBridgeRouter({ bridgeService }));
app.use('/mcp', createMcpRouter({ mcpService }));

// 协议转换代理：Claude Code 直接调用，不走 Web session 鉴权
// Claude Code 设置 ANTHROPIC_BASE_URL=http://localhost:PORT/api/proxy 即可
app.use('/api/proxy', createProxyRouter({ proxyConfigStore }));

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
app.use('/api', createAgentSetupRouter({ proxyConfigStore, cliSandbox }));
app.use('/api', createFileRouter({ fileService }));
app.use('/api', createIpFilterRouter({ ipFilterService }));
app.use('/api', createScriptRouter({ scriptService, aiService }));
app.use('/api', createWorkflowRouter({ playbookService }));
app.use('/api', createSkillRouter({ libraryService, skillRunner }));
app.use('/api', createSkillStudioRouter({ hostService, libraryService, mcpRegistry }));
app.use('/api', createMcpRegistryRouter({ mcpRegistry }));
app.use('/api', createExecRouter({ bridgeService, hostService }));
app.use('/api', createSitesRouter({ siteScanService, siteDeleteService, hostService }));
app.use('/api', createDnsProviderRouter({ dataDir }));
app.use('/api', createProgramRouter({ registry: programRegistry, stateService: programStateService, engine: programEngine, hostService }));

// ─── Socket.IO ──────────────────────────────────────────────────────────
io.use(authService.authenticateSocket);
registerSessionSocketHandlers(io, { sessionService });
registerAgentSocketHandlers(io, { agentPtyService, skillRegistry });
registerSkillSocketHandlers(io, { skillRunner });
registerGuardianSocketHandlers(io, { guardianService });
registerIdeSocketHandlers(io, { ideService, ideTools, localMcpService, mcpRegistry });

// ─── 定时任务 ───────────────────────────────────────────────────────────
probeService.startScheduler({
  onUpdate: (snapshot) => {
    io.emit('probe:update', snapshot);
  },
});

// ─── Program Engine 启动（所有服务就位后再启）─────────────────────────
programEngine.start();

// ─── 自动启动本地 MCP Server（不阻塞服务器启动）──────────────────────
(async () => {
  try {
    const servers = mcpRegistry.listServersWithSecrets();
    const locals = servers.filter(s => s.type === 'local' && s.command);
    if (locals.length === 0) return;
    log.info(`[mcp-auto-start] 正在启动 ${locals.length} 个本地 MCP...`);
    const results = await Promise.allSettled(
      locals.map(s => localMcpService.start(s.id, s.command, { cwd: s.installDir || undefined }))
    );
    for (let i = 0; i < locals.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.ok) {
        log.info(`[mcp-auto-start] ${locals[i].id}: ${r.value.tools.length} tools ready`);
      } else {
        const errMsg = r.status === 'rejected' ? r.reason?.message : r.value?.error;
        log.warn(`[mcp-auto-start] ${locals[i].id}: 启动失败 — ${errMsg}`);
      }
    }
  } catch (e) {
    log.error('[mcp-auto-start] 异常', e.message);
  }
})();

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
  programEngine.stop();
  localMcpService.stopAll();
  sshPool.closeAll();
  sshShellPool.closeAll();
  if (db) db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';

const fs = require('fs');
const path = require('path');
const { exec: childExec } = require('child_process');
const { ROOT_DIR } = require('../config/env');

const EXEC_SCHEMA = {
  type: 'object',
  properties: {
    hostId: { type: 'string', description: '目标主机 ID（可通过 list_hosts 获取）' },
    command: { type: 'string', description: '要执行的非交互式 shell 命令' },
    timeout: { type: 'number', description: '命令执行超时毫秒数，默认 30000' },
  },
  required: ['hostId', 'command'],
};

const TOOL_DEFS = [
  {
    name: 'host_exec',
    targets: ['mcp'],
    description: '在 1Shell 已配置的主机上执行非交互式命令并返回 stdout/stderr/exitCode。',
    schema: EXEC_SCHEMA,
  },
  {
    name: 'execute_command',
    targets: ['ide'],
    description: '在指定主机上执行非交互式 shell 命令。包管理器加 -y；长耗时命令把 timeout 设大；禁止在命令里用 ssh/scp。',
    schema: EXEC_SCHEMA,
  },
  {
    name: 'list_hosts',
    targets: ['mcp', 'ide'],
    description: '列出 1Shell 中所有已托管主机，返回 id / name / host / port / type。',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_scripts',
    targets: ['mcp', 'ide'],
    description: '列出 1Shell 脚本库中的脚本。返回 id / name / description / category / tags。',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '按分类过滤（可选）' },
        keyword: { type: 'string', description: '关键词搜索（可选）' },
      },
      required: [],
    },
  },
  {
    name: 'run_script',
    targets: ['mcp', 'ide'],
    description: '在指定主机上运行一个已有脚本。复用脚本服务的参数校验、风险确认、执行记录和审计。',
    schema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: '脚本 ID' },
        hostId: { type: 'string', description: '目标主机 ID' },
        params: { type: 'object', description: '脚本参数键值对（可选）' },
        timeout: { type: 'number', description: '超时毫秒，默认 60000' },
        confirmed: { type: 'boolean', description: '脚本需要确认或标记 danger 时必须为 true' },
      },
      required: ['scriptId', 'hostId'],
    },
  },
  {
    name: 'list_remote_dir',
    targets: ['mcp', 'ide'],
    description: '列出指定主机上的目录内容，返回路径、父目录、文件/目录名、大小和 mtime。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '目录路径，默认主目录或当前目录' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'read_remote_file',
    targets: ['mcp', 'ide'],
    description: '读取指定主机上的文本文件内容。默认最大 512KB，可用 maxBytes 调整。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '文件路径' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 524288' },
      },
      required: ['hostId', 'path'],
    },
  },
  {
    name: 'write_remote_file',
    targets: ['mcp', 'ide'],
    description: '写入指定主机上的文本文件。可设置 backup=true 在覆盖前写一份同目录 .1shell-backup 备份。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整文件内容（UTF-8）' },
        backup: { type: 'boolean', description: '覆盖前是否备份原文件，默认 false' },
      },
      required: ['hostId', 'path', 'content'],
    },
  },
  {
    name: 'upload_file',
    targets: ['mcp', 'ide'],
    description: '把 1Shell 本机文件或传入内容上传到指定主机目录。localPath 相对 1Shell 根目录或绝对路径；也可传 content/base64Content。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        dirPath: { type: 'string', description: '目标目录路径' },
        filename: { type: 'string', description: '目标文件名；localPath 模式默认取源文件名' },
        localPath: { type: 'string', description: '1Shell 本机源文件路径，相对项目根目录或绝对路径' },
        content: { type: 'string', description: '直接上传的 UTF-8 文本内容' },
        base64Content: { type: 'string', description: '直接上传的 base64 内容' },
      },
      required: ['hostId', 'dirPath'],
    },
  },
  {
    name: 'download_file',
    targets: ['mcp', 'ide'],
    description: '从指定主机下载文件。传 localPath 时保存到 1Shell 本机；否则小文件以 base64 返回。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '源主机 ID，local 表示本机' },
        path: { type: 'string', description: '源文件路径' },
        localPath: { type: 'string', description: '保存到 1Shell 本机的路径，相对项目根目录或绝对路径（可选）' },
        maxBytes: { type: 'number', description: '不传 localPath 时允许返回的最大字节数，默认 1048576' },
      },
      required: ['hostId', 'path'],
    },
  },
  {
    name: 'list_mcp_servers',
    targets: ['mcp', 'ide'],
    description: '列出 1Shell MCP Server 仓库中已登记的所有 MCP Server。返回 id / name / url / command / description。',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_mcp_server',
    targets: ['mcp', 'ide'],
    description: '向 1Shell MCP Server 仓库添加一个远程或本地 MCP Server。远程 url 必须为 http(s)://，本地必须提供 command。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'MCP 名称' },
        url: { type: 'string', description: '远程 MCP Server URL（http(s)://...）' },
        command: { type: 'string', description: '本地 MCP 启动命令（可选）' },
        installDir: { type: 'string', description: '本地 MCP 工作目录（可选）' },
        description: { type: 'string', description: '简要描述' },
        authToken: { type: 'string', description: '认证 token（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
        autoStart: { type: 'boolean', description: '服务启动时是否自动启动本地 MCP，默认 false' },
        exposeToIde: { type: 'boolean', description: '是否暴露给 1Shell IDE AI，默认 true' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_mcp_server',
    targets: ['mcp', 'ide'],
    description: '从 1Shell MCP Server 仓库中删除一个 MCP Server，并停止同名本地 MCP（如正在运行）。',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的 MCP Server ID' } },
      required: ['id'],
    },
  },
  {
    name: 'deploy_local_mcp',
    targets: ['mcp', 'ide'],
    description: '从 GitHub 仓库部署一个本地 MCP Server：git clone/pull → npm install → 注册到 1Shell 仓库。',
    schema: {
      type: 'object',
      properties: {
        repoUrl: { type: 'string', description: 'GitHub 仓库 URL' },
        name: { type: 'string', description: 'MCP 名称' },
        command: { type: 'string', description: '启动命令，如 node dist/index.js' },
        description: { type: 'string', description: '简要描述' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
        autoStart: { type: 'boolean', description: '服务启动时是否自动启动，默认 false' },
        exposeToIde: { type: 'boolean', description: '是否暴露给 1Shell AI，默认 true' },
      },
      required: ['repoUrl', 'name', 'command'],
    },
  },
  {
    name: 'query_audit',
    targets: ['mcp', 'ide'],
    description: '查询 1Shell 审计日志。可按 action / source / hostId / keyword 过滤。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 30，最多 200' },
        offset: { type: 'number', description: '偏移量，默认 0' },
        action: { type: 'string', description: '按 action 过滤（可选）' },
        source: { type: 'string', description: '按 source 过滤（可选）' },
        hostId: { type: 'string', description: '按主机 ID 过滤（可选）' },
        keyword: { type: 'string', description: '关键词搜索（可选）' },
      },
      required: [],
    },
  },
  {
    name: 'query_probe',
    targets: ['ide'],
    description: '获取所有主机的探针监控数据快照。兼容旧 IDE 工具；新调用建议使用 list_probes。',
    schema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '是否强制刷新（默认 false）' } },
      required: [],
    },
  },
  {
    name: 'list_probes',
    targets: ['mcp', 'ide'],
    description: '获取所有主机的探针监控快照，包含在线状态、CPU、内存、磁盘、网络、Agent 状态和流量摘要。',
    schema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '是否强制刷新（默认 false，优先使用缓存）' } },
      required: [],
    },
  },
  {
    name: 'get_probe',
    targets: ['mcp', 'ide'],
    description: '获取单台主机的探针监控快照。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 ID' },
        refresh: { type: 'boolean', description: '是否强制刷新（默认 false）' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'get_probe_samples',
    targets: ['mcp', 'ide'],
    description: '读取单台主机最近一段时间的原始探针样本（最多 24 小时）。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 ID' },
        minutes: { type: 'number', description: '回看分钟数，默认 60，最多 1440' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'get_probe_timeseries',
    targets: ['mcp', 'ide'],
    description: '读取单台主机聚合后的探针时序数据，支持 auto/1m/1h/1d 分辨率。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 ID' },
        fromMs: { type: 'number', description: '开始时间戳毫秒；默认 24 小时前' },
        toMs: { type: 'number', description: '结束时间戳毫秒；默认当前时间' },
        resolution: { type: 'string', enum: ['auto', '1m', '1h', '1d'], description: '分辨率，默认 auto' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'get_probe_traffic',
    targets: ['mcp', 'ide'],
    description: '获取单台主机的月度流量详情，包括 hs/ds/ms 滚动 buffer、配额、阈值和校准信息。',
    schema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '主机 ID' } },
      required: ['hostId'],
    },
  },
  {
    name: 'list_probe_alerts',
    targets: ['mcp', 'ide'],
    description: '列出探针告警事件，可查看 open/firing/all。',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'firing', 'all'], description: '事件状态，默认 open' },
        limit: { type: 'number', description: '返回条数，默认 50' },
        offset: { type: 'number', description: '偏移量，默认 0' },
      },
      required: [],
    },
  },
  {
    name: 'ack_probe_alert',
    targets: ['mcp', 'ide'],
    description: '忽略一个或全部当前打开的探针告警事件。',
    schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: '告警事件 ID；ackAll=false 时必填' },
        ackAll: { type: 'boolean', description: '是否忽略全部打开告警' },
      },
      required: [],
    },
  },
  {
    name: 'install_probe_agent',
    targets: ['mcp', 'ide'],
    description: '通过 1Shell SSH 通道在目标 VPS 安装或升级 probe-agent，并执行真实校验闭环。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        serverUrl: { type: 'string', description: 'Agent 回连 1Shell 或 Relay 的可达 URL' },
        intervalSec: { type: 'number', description: '上报间隔秒数（可选）' },
        relayUpstreamId: { type: 'string', description: 'Relay 上游 ID（可选）' },
      },
      required: ['hostId', 'serverUrl'],
    },
  },
  {
    name: 'restart_probe_agent',
    targets: ['mcp', 'ide'],
    description: '通过 1Shell SSH 通道重启目标主机上的 probe-agent，并重新拉取最新二进制后校验状态。',
    schema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '目标主机 ID' } },
      required: ['hostId'],
    },
  },
  {
    name: 'uninstall_probe_agent',
    targets: ['mcp', 'ide'],
    description: '通过 1Shell SSH 通道卸载目标主机上的 probe-agent，并确认服务、进程和文件残留已清理。',
    schema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '目标主机 ID' } },
      required: ['hostId'],
    },
  },
  {
    name: 'probe_diag_ping',
    targets: ['mcp', 'ide'],
    description: '在指定主机上执行 Ping 诊断。目标参数由 probe-diag 服务白名单校验并写审计。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        target: { type: 'string', description: '目标域名或 IP' },
        count: { type: 'number', description: 'ping 次数，默认 4' },
        timeoutSec: { type: 'number', description: '单次超时秒数，默认 3' },
      },
      required: ['hostId', 'target'],
    },
  },
  {
    name: 'probe_diag_http',
    targets: ['mcp', 'ide'],
    description: '在指定主机上执行 HTTP 诊断，返回状态码和 DNS/连接/首包/总耗时。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        url: { type: 'string', description: 'http(s) URL' },
        method: { type: 'string', enum: ['GET', 'HEAD'], description: '请求方法，默认 GET' },
        timeoutSec: { type: 'number', description: '超时秒数，默认 10' },
      },
      required: ['hostId', 'url'],
    },
  },
  {
    name: 'probe_diag_dns',
    targets: ['mcp', 'ide'],
    description: '在指定主机上执行 DNS 解析诊断。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        name: { type: 'string', description: '待解析域名' },
      },
      required: ['hostId', 'name'],
    },
  },
];

function createOneShellCoreTools(deps = {}) {
  const toolMap = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));

  function getToolSchemas(target) {
    return TOOL_DEFS
      .filter((tool) => tool.targets.includes(target))
      .map((tool) => target === 'mcp'
        ? { name: tool.name, description: tool.description, inputSchema: tool.schema }
        : { name: tool.name, description: tool.description, input_schema: tool.schema });
  }

  async function handle(name, input = {}, context = {}) {
    if (!toolMap.has(name)) return err(`未知工具: ${name}`);

    switch (name) {
      case 'host_exec':
      case 'execute_command':
        return handleExec(input, context);
      case 'list_hosts':
        return handleListHosts();
      case 'list_scripts':
        return handleListScripts(input);
      case 'run_script':
        return handleRunScript(input, context);
      case 'list_remote_dir':
        return handleListRemoteDir(input);
      case 'read_remote_file':
        return handleReadRemoteFile(input);
      case 'write_remote_file':
        return handleWriteRemoteFile(input, context);
      case 'upload_file':
        return handleUploadFile(input, context);
      case 'download_file':
        return handleDownloadFile(input, context);
      case 'list_mcp_servers':
        return handleListMcpServers();
      case 'add_mcp_server':
        return handleAddMcpServer(input);
      case 'remove_mcp_server':
        return handleRemoveMcpServer(input);
      case 'deploy_local_mcp':
        return handleDeployLocalMcp(input);
      case 'query_audit':
        return handleQueryAudit(input);
      case 'query_probe':
      case 'list_probes':
        return handleListProbes(input);
      case 'get_probe':
        return handleGetProbe(input);
      case 'get_probe_samples':
        return handleGetProbeSamples(input);
      case 'get_probe_timeseries':
        return handleGetProbeTimeseries(input);
      case 'get_probe_traffic':
        return handleGetProbeTraffic(input);
      case 'list_probe_alerts':
        return handleListProbeAlerts(input);
      case 'ack_probe_alert':
        return handleAckProbeAlert(input, context);
      case 'install_probe_agent':
        return handleInstallProbeAgent(input, context);
      case 'restart_probe_agent':
        return handleRestartProbeAgent(input, context);
      case 'uninstall_probe_agent':
        return handleUninstallProbeAgent(input, context);
      case 'probe_diag_ping':
        return handleProbeDiag('ping', input, context);
      case 'probe_diag_http':
        return handleProbeDiag('http', input, context);
      case 'probe_diag_dns':
        return handleProbeDiag('dns', input, context);
      default:
        return err(`未知工具: ${name}`);
    }
  }

  async function handleExec(input, context) {
    const hostId = String(input.hostId || '').trim();
    const command = String(input.command || '').trim();
    const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : 30000;
    if (!hostId || !command) return err('hostId 和 command 为必填');

    try {
      if (hostId !== 'local' && !deps.bridgeService) return err('bridgeService 未初始化');
      const result = hostId === 'local'
        ? await execLocal(command, timeout, { signal: context.signal })
        : await deps.bridgeService.execOnHost(hostId, command, timeout, { source: context.source || 'core_tools', signal: context.signal });
      emitTool(context, 'execute_command', { hostId, command }, result);
      const okRun = result.exitCode === 0;
      return structured(okRun, okRun ? '命令执行成功' : `命令执行失败，exitCode=${result.exitCode}`, {
        hostId,
        command,
        timeout,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs || 0,
      }, !okRun);
    } catch (e) {
      return err(e.message);
    }
  }

  function handleListHosts() {
    const hosts = (deps.hostService?.listHosts?.() || []).map((h) => {
      const addr = h.type === 'local' ? '127.0.0.1:-' : `${h.host || '127.0.0.1'}:${h.port || 22}`;
      return `id=${h.id}  name=${h.name}  ${addr}  type=${h.type || 'ssh'}`;
    });
    return ok(hosts.length > 0 ? hosts.join('\n') : '（无已托管主机）');
  }

  function handleListScripts(input) {
    if (!deps.scriptService) return err('scriptService 未初始化');
    try {
      const scripts = deps.scriptService.listScripts({ category: input.category, keyword: input.keyword });
      if (scripts.length === 0) return ok('（脚本库为空）');
      return ok(scripts.map((s) =>
        `id=${s.id}  name="${s.name}"  category=${s.category || '-'}  tags=[${(s.tags || []).join(',')}]  ${s.description ? '— ' + s.description.slice(0, 80) : ''}`
      ).join('\n'));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleRunScript(input, context) {
    if (!deps.scriptService) return err('scriptService 未初始化');
    const scriptId = String(input.scriptId || '').trim();
    const hostId = String(input.hostId || '').trim();
    if (!scriptId || !hostId) return err('scriptId 和 hostId 为必填');
    try {
      const result = await deps.scriptService.runScript(scriptId, {
        hostId,
        params: input.params || {},
        confirmed: input.confirmed === true,
        timeoutMs: input.timeout || 60000,
        signal: context.signal,
      }, { clientIp: context.clientIp });
      const okRun = result.exitCode === 0;
      return structured(okRun, okRun ? '脚本执行成功' : `脚本执行失败，exitCode=${result.exitCode}`, {
        scriptId,
        hostId,
        runId: result.runId,
        status: result.status,
        renderedCommand: result.renderedCommand,
        warnings: result.warnings || [],
        params: input.params || {},
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs || 0,
      }, !okRun);
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleListRemoteDir(input) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      const result = await deps.fileService.listDir(hostId, input.path || '');
      return structured(true, '目录读取成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleReadRemoteFile(input) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    if (!hostId || !filePath) return err('hostId 和 path 为必填');
    try {
      const result = await deps.fileService.readFile(hostId, filePath, input.maxBytes);
      return structured(true, '文件读取成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleWriteRemoteFile(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    if (!hostId || !filePath) return err('hostId 和 path 为必填');
    if (typeof input.content !== 'string') return err('content 必须是字符串');
    try {
      let backupPath = null;
      if (input.backup) {
        try {
          const old = await deps.fileService.readFile(hostId, filePath);
          backupPath = `${filePath}.1shell-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          await deps.fileService.writeFile(hostId, backupPath, old.content || '');
        } catch {
          backupPath = null;
        }
      }
      const result = await deps.fileService.writeFile(hostId, filePath, input.content);
      deps.auditService?.log?.({ action: 'mcp_file_write', source: context.source || 'core_tools', hostId, command: filePath, details: JSON.stringify({ size: result.size, backupPath }) });
      return structured(true, '文件写入成功', { hostId, backupPath, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleUploadFile(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const dirPath = String(input.dirPath || '').trim();
    if (!hostId || !dirPath) return err('hostId 和 dirPath 为必填');
    try {
      let filename = input.filename ? String(input.filename) : '';
      let buffer;
      if (typeof input.base64Content === 'string') {
        buffer = Buffer.from(input.base64Content, 'base64');
      } else if (typeof input.content === 'string') {
        buffer = Buffer.from(input.content, 'utf8');
      } else if (input.localPath) {
        const localPath = resolveLocalPath(input.localPath);
        buffer = await fs.promises.readFile(localPath);
        if (!filename) filename = path.basename(localPath);
      } else {
        return err('localPath / content / base64Content 必须提供一个');
      }
      if (!filename) return err('filename 为必填');
      const result = await deps.fileService.uploadFile(hostId, dirPath, filename, buffer);
      deps.auditService?.log?.({ action: 'mcp_file_upload', source: context.source || 'core_tools', hostId, command: `${dirPath}/${filename}`, details: JSON.stringify({ size: result.size }) });
      return structured(true, '文件上传成功', { hostId, filename, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleDownloadFile(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    if (!hostId || !filePath) return err('hostId 和 path 为必填');
    try {
      const result = await deps.fileService.downloadFile(hostId, filePath);
      const maxBytes = Number(input.maxBytes) > 0 ? Number(input.maxBytes) : 1024 * 1024;
      if (!input.localPath && result.size > maxBytes) {
        result.stream.destroy?.();
        return err(`文件过大 (${result.size} bytes)，请传 localPath 保存到 1Shell 本机，或调大 maxBytes`);
      }
      const buffer = await streamToBuffer(result.stream, context.signal);
      if (input.localPath) {
        const localPath = resolveLocalPath(input.localPath);
        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
        await fs.promises.writeFile(localPath, buffer);
        deps.auditService?.log?.({ action: 'mcp_file_download', source: context.source || 'core_tools', hostId, command: filePath, details: JSON.stringify({ localPath, size: buffer.length }) });
        return structured(true, '文件下载成功', { hostId, path: filePath, localPath, filename: result.filename, size: buffer.length });
      }
      return structured(true, '文件下载成功', { hostId, path: filePath, filename: result.filename, size: buffer.length, base64Content: buffer.toString('base64') });
    } catch (e) {
      return err(e.message);
    }
  }

  function handleListMcpServers() {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    const servers = deps.mcpRegistry.listServers();
    if (servers.length === 0) return ok('（仓库中暂无 MCP Server）');
    return ok(servers.map((s) => {
      const typeTag = (s.type === 'local' || s.command) ? '[本地]' : '[远程]';
      const loc = s.type === 'local' ? `cmd=${s.command || ''}` : `url=${s.url}`;
      const runtime = deps.localMcpService && (s.type === 'local' || s.command) ? deps.localMcpService.getStatus(s.id) : { status: 'remote' };
      const flags = `enabled=${s.enabled !== false} autoStart=${s.autoStart === true} ide=${s.exposeToIde !== false} status=${runtime.status}`;
      const runtimeError = runtime.error ? `  error=${String(runtime.error).replace(/\s+/g, ' ').slice(0, 240)}` : '';
      return `${typeTag} id=${s.id}  name="${s.name}"  ${loc}  ${flags}${runtimeError}  ${s.description ? '— ' + s.description : ''}`;
    }).join('\n'));
  }

  async function handleAddMcpServer(input) {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    try {
      const server = deps.mcpRegistry.createServer({
        name: input.name,
        url: input.url || '',
        command: input.command || '',
        installDir: input.installDir || '',
        description: input.description || '',
        authToken: input.authToken || '',
        tags: input.tags || [],
        enabled: input.enabled,
        autoStart: input.autoStart,
        exposeToIde: input.exposeToIde,
      });
      if (server.type === 'local' && server.command && server.enabled && (server.autoStart || server.exposeToIde) && deps.localMcpService) {
        await deps.localMcpService.start(server.id, server.command, { cwd: server.installDir || undefined });
      }
      const typeLabel = server.type === 'local' ? '本地' : '远程';
      return ok(`${typeLabel} MCP Server 已添加到 1Shell 仓库: id=${server.id} name="${server.name}"`);
    } catch (e) {
      return err(`添加失败: ${e.message}`);
    }
  }

  function handleRemoveMcpServer(input) {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    const id = String(input.id || '').trim();
    if (!id) return err('id 为空');
    if (deps.localMcpService) deps.localMcpService.stop(id);
    const removed = deps.mcpRegistry.deleteServer(id);
    return removed ? ok(`MCP Server "${id}" 已从仓库中删除。`) : err(`MCP Server 不存在: ${id}`);
  }

  async function handleDeployLocalMcp(input) {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    const repoUrl = String(input.repoUrl || '').trim();
    const mcpName = String(input.name || '').trim();
    const command = String(input.command || '').trim();
    if (!repoUrl || !mcpName || !command) return err('repoUrl、name、command 均为必填');

    try {
      if (deps.localMcpDeployer) {
        const inspected = await deps.localMcpDeployer.inspect({ repoUrl });
        const result = await deps.localMcpDeployer.register({
          ...input,
          repoUrl,
          installDir: inspected.installDir,
          name: mcpName,
          command,
        });
        const preloadText = result.preload ? `\n- 预加载: ${result.preload.ok ? `ready (${(result.preload.tools || []).length} tools)` : result.preload.error}` : '';
        return ok(`本地 MCP "${mcpName}" 部署成功！\n- 仓库: ${repoUrl}\n- 安装目录: ${result.server.installDir}\n- 启动命令: ${command}\n- 已注册 ID: ${result.server.id}${preloadText}`);
      }

      const mcpDir = path.join(ROOT_DIR, 'data', 'local-mcp');
      const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'mcp';
      const installDir = path.join(mcpDir, repoName);
      fs.mkdirSync(mcpDir, { recursive: true });
      const cloneCmd = fs.existsSync(installDir)
        ? `git pull`
        : `git clone "${repoUrl}" "${installDir}"`;
      const cloneResult = await execLocal(cloneCmd, 120000, fs.existsSync(installDir) ? installDir : ROOT_DIR);
      if (cloneResult.exitCode !== 0 && !fs.existsSync(installDir)) return err(`git clone 失败: ${cloneResult.stderr.slice(0, 300)}`);

      const pkgJson = path.join(installDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        const installResult = await execLocal('npm install --production', 180000, installDir);
        if (installResult.exitCode !== 0) return err(`npm install 失败: ${installResult.stderr.slice(0, 300)}`);
      }

      const server = deps.mcpRegistry.createServer({
        name: mcpName,
        command,
        installDir,
        description: input.description || `部署自 ${repoUrl}`,
        tags: input.tags || ['local', 'deployed'],
      });
      if (server.enabled && server.exposeToIde && deps.localMcpService) {
        await deps.localMcpService.start(server.id, server.command, { cwd: server.installDir || undefined });
      }
      return ok(`本地 MCP "${mcpName}" 部署成功！\n- 仓库: ${repoUrl}\n- 安装目录: ${installDir}\n- 启动命令: ${command}\n- 已注册 ID: ${server.id}`);
    } catch (e) {
      return err(`部署失败: ${e.message}`);
    }
  }

  function handleQueryAudit(input) {
    if (!deps.auditService) return err('auditService 未初始化');
    try {
      const result = deps.auditService.query({
        limit: input.limit || 30,
        offset: input.offset || 0,
        action: input.action,
        source: input.source,
        hostId: input.hostId,
        keyword: input.keyword,
      });
      const logs = result.logs || result || [];
      if (logs.length === 0) return ok('（无审计记录）');
      return ok(logs.map((l) => {
        const ts = l.created_at || l.createdAt || l.ts || '?';
        const action = l.action || '?';
        const hostId = l.host_id || l.hostId || '-';
        const cmd = l.command ? `cmd=${String(l.command).slice(0, 100)}` : '';
        const source = l.source ? `src=${l.source}` : '';
        return `[${ts}] action=${action}  host=${hostId}  ${cmd} ${source}`;
      }).join('\n'));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleListProbes(input) {
    if (!deps.probeService) return err('probeService 未初始化');
    try {
      const snapshot = input.refresh
        ? await deps.probeService.getSnapshot({ refresh: true })
        : (deps.probeService.getLatestSnapshot?.() || await deps.probeService.getSnapshot({ refresh: false }));
      return ok(formatJson({ generatedAt: snapshot.generatedAt, sampleIntervalMs: snapshot.sampleIntervalMs, probes: snapshot.probes || [] }));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleGetProbe(input) {
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    const result = await handleListProbes({ refresh: !!input.refresh });
    if (result.is_error) return result;
    const snapshot = JSON.parse(result.content);
    const probe = (snapshot.probes || []).find((p) => p.hostId === hostId || p.id === hostId);
    if (!probe) return err(`未找到主机探针: ${hostId}`);
    return ok(formatJson(probe));
  }

  function handleGetProbeSamples(input) {
    if (!deps.probeAgentService) return err('probeAgentService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    const minutes = Number(input.minutes);
    const sinceMs = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 60 * 24) * 60 * 1000 : 60 * 60 * 1000;
    try {
      const samples = deps.probeAgentService.getSampleHistory(hostId, { sinceMs });
      return ok(formatJson({ hostId, sinceMs, samples }));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleGetProbeTimeseries(input) {
    if (!deps.probeAggregatorService) return err('probeAggregatorService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    const now = Date.now();
    const toMs = Number.isFinite(Number(input.toMs)) ? Number(input.toMs) : now;
    const fromMs = Number.isFinite(Number(input.fromMs)) ? Number(input.fromMs) : toMs - 24 * 60 * 60 * 1000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return err('fromMs/toMs 参数非法');
    try {
      const result = deps.probeAggregatorService.listTimeseries(hostId, {
        fromMs,
        toMs,
        resolution: input.resolution || 'auto',
      });
      return ok(formatJson({ hostId, fromMs, toMs, resolution: result.resolution, points: result.points }));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleGetProbeTraffic(input) {
    if (!deps.probeTrafficService) return err('probeTrafficService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    if (hostId !== 'local' && deps.hostService?.findHost && !deps.hostService.findHost(hostId)) return err('主机不存在');
    try {
      return ok(formatJson(deps.probeTrafficService.getDetail(hostId)));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleListProbeAlerts(input) {
    if (!deps.probeAlertService) return err('probeAlertService 未初始化');
    try {
      const events = deps.probeAlertService.listEvents({
        status: input.status || 'open',
        limit: input.limit || 50,
        offset: input.offset || 0,
      });
      return ok(formatJson({ events, openCount: deps.probeAlertService.countOpenEvents() }));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleAckProbeAlert(input, context) {
    if (!deps.probeAlertService) return err('probeAlertService 未初始化');
    try {
      const result = input.ackAll
        ? deps.probeAlertService.ackOpenEvents()
        : deps.probeAlertService.ackEvent(String(input.eventId || '').trim());
      deps.auditService?.log?.({ action: input.ackAll ? 'mcp_probe_alert_ack_all' : 'mcp_probe_alert_ack', source: context.source || 'core_tools', details: JSON.stringify({ eventId: input.eventId || null }) });
      return ok(formatJson(result));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleInstallProbeAgent(input, context) {
    if (!deps.probeAgentInstallerService) return err('Agent 安装器未启用');
    const hostId = String(input.hostId || '').trim();
    const serverUrl = String(input.serverUrl || '').trim().replace(/\/+$/, '');
    if (!hostId || !serverUrl) return err('hostId 和 serverUrl 为必填');
    try {
      const result = await deps.probeAgentInstallerService.install(hostId, {
        serverUrl,
        intervalSec: typeof input.intervalSec === 'number' ? input.intervalSec : undefined,
        relayUpstreamId: typeof input.relayUpstreamId === 'string' ? input.relayUpstreamId : undefined,
        clientIp: context.clientIp,
      });
      return ok(formatJson(result));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleRestartProbeAgent(input, context) {
    if (!deps.probeAgentInstallerService) return err('Agent 安装器未启用');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      return ok(formatJson(await deps.probeAgentInstallerService.restart(hostId, { clientIp: context.clientIp })));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleUninstallProbeAgent(input, context) {
    if (!deps.probeAgentInstallerService) return err('Agent 安装器未启用');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      return ok(formatJson(await deps.probeAgentInstallerService.uninstall(hostId, { clientIp: context.clientIp })));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleProbeDiag(kind, input, context) {
    if (!deps.probeDiagService) return err('probeDiagService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      if (kind === 'ping') {
        return ok(formatJson(await deps.probeDiagService.ping(hostId, {
          target: input.target,
          count: input.count,
          timeoutSec: input.timeoutSec,
          clientIp: context.clientIp,
        })));
      }
      if (kind === 'http') {
        return ok(formatJson(await deps.probeDiagService.http(hostId, {
          url: input.url,
          method: input.method,
          timeoutSec: input.timeoutSec,
          clientIp: context.clientIp,
        })));
      }
      return ok(formatJson(await deps.probeDiagService.dns(hostId, { name: input.name, clientIp: context.clientIp })));
    } catch (e) {
      return err(e.message);
    }
  }

  return { getToolSchemas, handle };
}

function makeAbortError() {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  err.code = 'CANCELLED';
  return err;
}

function execLocal(command, timeout, { cwd = ROOT_DIR, signal } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());
    let settled = false;
    let child = null;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      try { child?.kill?.('SIGKILL'); } catch { /* ignore */ }
      settled = true;
      cleanup();
      reject(makeAbortError());
    };
    child = childExec(command, { timeout, maxBuffer: 8 * 1024 * 1024, cwd }, (e, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: stdout || '',
        stderr: (e && !stderr) ? e.message : (stderr || ''),
        exitCode: e ? (e.code || 1) : 0,
        durationMs: Date.now() - startedAt,
      });
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function emitTool(context, toolName, input, result) {
  if (!context.socket) return;
  context.socket.emit('ide:tool-call', {
    sessionId: context.sessionId,
    tool: toolName,
    input,
    result: {
      stdout: result.stdout?.substring(0, 4000),
      stderr: result.stderr?.substring(0, 2000),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    },
  });
}

function resolveLocalPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('localPath 为空');
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw);
}

function streamToBuffer(stream, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try { stream.destroy?.(); } catch { /* ignore */ }
      return reject(makeAbortError());
    }
    const chunks = [];
    let settled = false;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try { stream.destroy?.(); } catch { /* ignore */ }
      settle(reject, makeAbortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => settle(resolve, Buffer.concat(chunks)));
    stream.on('close', () => settle(resolve, Buffer.concat(chunks)));
    stream.on('error', (err) => settle(reject, err));
  });
}

function structured(okValue, summary, data, isError = false) {
  return { content: formatJson({ ok: okValue, summary, data }), is_error: isError };
}

function formatExec({ stdout, stderr, exitCode, durationMs }) {
  const parts = [];
  if (stdout) parts.push(`[stdout]\n${stdout.trimEnd()}`);
  if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  parts.push(`[exitCode] ${exitCode}`);
  parts.push(`[durationMs] ${durationMs || 0}`);
  return parts.join('\n\n');
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function ok(content) {
  return { content, is_error: false };
}

function err(content) {
  return { content: `[ERROR] ${content}`, is_error: true };
}

module.exports = { createOneShellCoreTools };

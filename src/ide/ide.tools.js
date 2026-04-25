'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ROOT_DIR } = require('../config/env');

const ALLOWED_DIRS = ['data/skills', 'data/playbooks', 'data/programs'];

function isPathAllowed(relPath) {
  const resolved = path.resolve(ROOT_DIR, relPath);
  return ALLOWED_DIRS.some(d => {
    const abs = path.join(ROOT_DIR, d);
    return resolved.startsWith(abs + path.sep) || resolved === abs;
  });
}

function createIdeTools({ bridgeService, hostService, skillRegistry, programEngine, skillRunner, auditService, mcpRegistry, localMcpService, onFileWritten }) {

  const TOOL_SCHEMAS = [
    {
      name: 'execute_command',
      description:
        '在指定主机上执行非交互式 shell 命令。' +
        '\n- 包管理器加 -y' +
        '\n- 长耗时命令把 timeout 设大（docker pull → 120000）' +
        '\n- 禁止在命令里用 ssh/scp',
      input_schema: {
        type: 'object',
        properties: {
          hostId:  { type: 'string', description: '目标主机 ID（用 list_hosts 获取）' },
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时毫秒，默认 30000' },
        },
        required: ['hostId', 'command'],
      },
    },
    {
      name: 'list_hosts',
      description: '列出 1Shell 中所有已托管主机（含本机），返回 id / name / host / port。',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_file',
      description:
        '读取 1Shell 产物文件（data/skills/ / data/playbooks/ / data/programs/ 内）。' +
        '\n返回文件内容（UTF-8）。路径是相对于 1Shell 根目录的相对路径。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，如 data/skills/my-skill/SKILL.md' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        '将内容写入 1Shell 产物文件（data/skills/ / data/playbooks/ / data/programs/）。' +
        '\n自动创建父目录。路径越界会被拒绝。',
      input_schema: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: '相对路径' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'list_artifacts',
      description:
        '列出已有的 Skill / Playbook / Program 产物。' +
        '\n返回每个产物的 id / name / kind / description。',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['skill', 'playbook', 'program', 'all'], description: '筛选类型，默认 all' },
        },
        required: [],
      },
    },
    {
      name: 'run_skill',
      description:
        '触发运行一个已有的 Skill（走完整 Skill Runner AI-Loop）。' +
        '\n同步等待执行完成，返回所有执行输出（命令结果、AI 思考、渲染结果等）。' +
        '\n适合"写完 → 跑 → 看结果 → 改"的闭环。注意：AI-Loop 型 Skill 可能需要较长时间。',
      input_schema: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Skill ID' },
          hostId:  { type: 'string', description: '目标主机 ID' },
          inputs:  { type: 'object', description: 'Skill inputs 键值对' },
        },
        required: ['skillId', 'hostId'],
      },
    },
    {
      name: 'run_playbook',
      description:
        '触发运行一个已有的 Playbook（走 L1 确定性执行器，失败自动唤醒 L2 Rescuer）。' +
        '\n同步等待执行完成，返回每一步的执行结果。比 run_skill 更快（零 token 确定性执行）。',
      input_schema: {
        type: 'object',
        properties: {
          playbookId: { type: 'string', description: 'Playbook ID' },
          hostId:     { type: 'string', description: '目标主机 ID' },
          inputs:     { type: 'object', description: 'Playbook inputs 键值对' },
        },
        required: ['playbookId', 'hostId'],
      },
    },
    {
      name: 'trigger_program',
      description:
        '手动触发一个 Program 的一次执行（走 L1 → L2 → L3 完整链路）。' +
        '\n返回 runId 列表。用于测试刚创建的 Program。',
      input_schema: {
        type: 'object',
        properties: {
          programId:  { type: 'string', description: 'Program ID' },
          hostId:     { type: 'string', description: '目标主机 ID（或 "all"）' },
          actionName: { type: 'string', description: '要触发的 action 名（可选，默认取第一个）' },
        },
        required: ['programId'],
      },
    },
    {
      name: 'query_format',
      description:
        '查询 1Shell 产物的文件格式规范。按需调用——只在你不确定格式时才查。' +
        '\n返回对应类型的完整 schema 文档。',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['skill', 'playbook', 'program', 'tool-api'], description: '要查询的产物类型' },
        },
        required: ['type'],
      },
    },
    {
      name: 'reload_registry',
      description: '重新加载 Skill / Playbook / Program 注册表，使刚写入的产物立即可被系统识别。写完产物文件后应调用。',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_mcp_servers',
      description: '列出 1Shell MCP Server 仓库中已登记的所有 MCP Server。返回 id / name / url / description。',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'add_mcp_server',
      description:
        '向 1Shell MCP Server 仓库添加一个新的 MCP Server。' +
        '\nurl 必须是 http(s):// 开头的远程 SSE/Streamable HTTP 端点。' +
        '\n注意：这是添加到 1Shell 平台仓库，不是修改本地配置文件。',
      input_schema: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'MCP 名称' },
          url:         { type: 'string', description: 'MCP Server URL（http(s)://...）' },
          description: { type: 'string', description: '简要描述' },
          authToken:   { type: 'string', description: '认证 token（可选）' },
          tags:        { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        },
        required: ['name', 'url'],
      },
    },
    {
      name: 'remove_mcp_server',
      description: '从 1Shell MCP Server 仓库中删除一个 MCP Server。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的 MCP Server ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'deploy_local_mcp',
      description:
        '从 GitHub 仓库部署一个本地 MCP Server。自动执行 git clone → npm install → 注册到仓库。' +
        '\n部署完成后 MCP 会注册为 local 类型，用户在工具面板选中时自动启动。' +
        '\n如果不确定启动命令，先 clone 后读 README 或 package.json 来确定。',
      input_schema: {
        type: 'object',
        properties: {
          repoUrl:     { type: 'string', description: 'GitHub 仓库 URL，如 https://github.com/user/repo' },
          name:        { type: 'string', description: 'MCP 名称' },
          command:     { type: 'string', description: '启动命令，如 "node dist/index.js" 或 "npx tsx src/index.ts"' },
          description: { type: 'string', description: '简要描述' },
          tags:        { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        },
        required: ['repoUrl', 'name', 'command'],
      },
    },
  ];

  // ─── Handler 实现 ────────────────────────────────────────────────────

  const WRITE_PATTERNS = /\b(rm|mv|cp|mkdir|touch|chmod|chown|dd|mkfs|tee|install|npm|npx|pip|apt|yum|dnf|brew|git\s+clone|git\s+pull|git\s+checkout|wget|curl\s+-[^\s]*[oO]|docker\s+(run|pull|build|exec)|>\s|>>)\b/i;

  // 安全模式：已批准的命令（sessionId → Set<commandHash>）
  const approvedCommands = new Map();

  function approveCommand(sessionId, command) {
    if (!approvedCommands.has(sessionId)) approvedCommands.set(sessionId, new Set());
    approvedCommands.get(sessionId).add(command.trim());
  }

  function isApproved(sessionId, command) {
    return approvedCommands.get(sessionId)?.has(command.trim()) || false;
  }

  async function handle(name, input, { socket, sessionId, safeMode }) {
    switch (name) {

      case 'execute_command': {
        const hostId = String(input.hostId || '').trim();
        let command = String(input.command || '').trim();
        const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : 30000;
        if (!hostId || !command) return err('hostId 和 command 为必填');

        try {
          if (hostId === 'local') {
            const { exec: childExec } = require('child_process');
            const result = await new Promise((resolve) => {
              childExec(command, { timeout, maxBuffer: 8 * 1024 * 1024, cwd: ROOT_DIR }, (e, stdout, stderr) => {
                resolve({ stdout: stdout || '', stderr: (e && !stderr) ? e.message : (stderr || ''), exitCode: e ? (e.code || 1) : 0, durationMs: 0 });
              });
            });
            emitTool(socket, sessionId, name, { command, hostId }, result);
            return ok(formatExec(result));
          }
          const result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'ide' });
          emitTool(socket, sessionId, name, { command, hostId }, result);
          auditService?.log?.({ action: 'ide_exec', hostId, command: command.substring(0, 2000), exitCode: result.exitCode });
          return ok(formatExec(result));
        } catch (e) {
          return err(e.message);
        }
      }

      case 'list_hosts': {
        const hosts = (hostService.listHosts?.() || []).map(h => `id=${h.id}  name=${h.name}  ${h.host || '127.0.0.1'}:${h.port || '-'}  type=${h.type || 'ssh'}`);
        return ok(hosts.length > 0 ? hosts.join('\n') : '（无已托管主机）');
      }

      case 'read_file': {
        const p = String(input.path || '').trim();
        if (!p) return err('path 为空');
        if (!isPathAllowed(p)) return err(`路径越界：只能读 ${ALLOWED_DIRS.join(' / ')} 内的文件`);
        const abs = path.resolve(ROOT_DIR, p);
        try {
          const content = fs.readFileSync(abs, 'utf8');
          return ok(content);
        } catch (e) {
          if (e.code === 'ENOENT') return err(`文件不存在: ${p}`);
          if (e.code === 'EISDIR') {
            const entries = fs.readdirSync(abs, { withFileTypes: true });
            const listing = entries.map(e => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`));
            return ok(`目录 ${p} 的内容:\n${listing.join('\n')}`);
          }
          return err(e.message);
        }
      }

      case 'write_file': {
        const p = String(input.path || '').trim();
        const content = input.content != null ? String(input.content) : '';
        if (!p) return err('path 为空');
        if (!isPathAllowed(p)) return err(`路径越界：只能写 ${ALLOWED_DIRS.join(' / ')} 内的文件`);
        const abs = path.resolve(ROOT_DIR, p);
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
          if (typeof onFileWritten === 'function') {
            try { onFileWritten(p); } catch { /* ignore */ }
          }
          return ok(`文件已写入: ${p} (${Buffer.byteLength(content, 'utf8')} bytes)`);
        } catch (e) {
          return err(`写入失败: ${e.message}`);
        }
      }

      case 'list_artifacts': {
        const filter = input.type || 'all';
        const items = [];
        if (filter === 'all' || filter === 'skill') {
          for (const s of (skillRegistry.listSkills?.() || [])) {
            items.push(`[skill] ${s.id}  name="${s.name || s.id}"  ${s.description ? '— ' + s.description.slice(0, 100) : ''}`);
          }
        }
        if (filter === 'all' || filter === 'playbook') {
          for (const p of (skillRegistry.listPlaybooks?.() || [])) {
            items.push(`[playbook] ${p.id}  name="${p.name || p.id}"  ${p.description ? '— ' + p.description.slice(0, 100) : ''}`);
          }
        }
        if (filter === 'all' || filter === 'program') {
          const progDir = path.join(ROOT_DIR, 'data', 'programs');
          if (fs.existsSync(progDir)) {
            for (const d of fs.readdirSync(progDir, { withFileTypes: true })) {
              if (!d.isDirectory()) continue;
              const yamlPath = path.join(progDir, d.name, 'program.yaml');
              if (!fs.existsSync(yamlPath)) continue;
              let pName = d.name;
              try {
                const raw = fs.readFileSync(yamlPath, 'utf8');
                const m = raw.match(/^name:\s*(.+)$/m);
                if (m) pName = m[1].trim();
              } catch { /* ignore */ }
              items.push(`[program] ${d.name}  name="${pName}"`);
            }
          }
        }
        return ok(items.length > 0 ? items.join('\n') : '（暂无产物）');
      }

      case 'run_skill': {
        const skillId = String(input.skillId || '').trim();
        const hostId = String(input.hostId || '').trim();
        if (!skillId) return err('skillId 为空');
        if (!hostId) return err('hostId 为空');
        const skill = skillRegistry.getSkill?.(skillId);
        if (!skill) return err(`Skill 不存在: ${skillId}。请先 reload_registry。`);
        if (!skillRunner) return err('Skill Runner 未初始化');

        const runId = 'ide-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const result = await runViaCollector(runId, (collector) =>
          skillRunner.run({ socket: collector, runId, skillId, hostId, inputs: input.inputs || {} })
        );
        auditService?.log?.({ action: 'ide_run_skill', skillId, hostId, runId });
        return ok(result);
      }

      case 'run_playbook': {
        const playbookId = String(input.playbookId || '').trim();
        const hostId = String(input.hostId || '').trim();
        if (!playbookId) return err('playbookId 为空');
        if (!hostId) return err('hostId 为空');
        const skill = skillRegistry.getSkill?.(playbookId);
        if (!skill) return err(`Playbook 不存在: ${playbookId}。请先 reload_registry。`);
        if (!skill.hasPlaybook) return err(`"${playbookId}" 没有 playbook.yaml，无法走确定性执行。请改用 run_skill。`);
        if (!skillRunner) return err('Skill Runner 未初始化');

        const runId = 'ide-pb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const result = await runViaCollector(runId, (collector) =>
          skillRunner.run({ socket: collector, runId, skillId: playbookId, hostId, inputs: input.inputs || {} })
        );
        auditService?.log?.({ action: 'ide_run_playbook', playbookId, hostId, runId });
        return ok(result);
      }

      case 'trigger_program': {
        const programId = String(input.programId || '').trim();
        const hostId = input.hostId ? String(input.hostId).trim() : undefined;
        const actionName = input.actionName ? String(input.actionName).trim() : undefined;
        if (!programId) return err('programId 为空');
        try {
          const runIds = await programEngine.triggerManual({ programId, hostId, actionName });
          return ok(`Program "${programId}" 已触发。runId: ${runIds.join(', ')}\n结果将在前端"程序"页面展示。`);
        } catch (e) {
          return err(`触发失败: ${e.message}`);
        }
      }

      case 'query_format': {
        const type = String(input.type || '').trim();
        const docMap = {
          'skill':       'skill-format.md',
          'playbook':    'playbook-schema.md',
          'program':     'program-schema.md',
          'tool-api':    'tool-api.md',
        };
        const fileName = docMap[type];
        if (!fileName) return err(`未知类型: ${type}。可选: ${Object.keys(docMap).join(', ')}`);
        const docPath = path.join(ROOT_DIR, 'data', 'skills', 'skill-authoring', 'references', fileName);
        try {
          return ok(fs.readFileSync(docPath, 'utf8'));
        } catch {
          return err(`格式文档不存在: ${docPath}`);
        }
      }

      case 'reload_registry': {
        try {
          if (typeof skillRegistry.reload === 'function') skillRegistry.reload();
          if (typeof programEngine.reload === 'function') programEngine.reload();
          return ok('Skill / Playbook / Program 注册表已重新加载。');
        } catch (e) {
          return err(`重载失败: ${e.message}`);
        }
      }

      case 'list_mcp_servers': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        const servers = mcpRegistry.listServers();
        if (servers.length === 0) return ok('（仓库中暂无 MCP Server）');
        const lines = servers.map(s => {
          const typeTag = (s.type === 'local' || s.command) ? '[本地]' : '[远程]';
          const loc = s.type === 'local' ? `cmd=${s.command || ''}` : `url=${s.url}`;
          return `${typeTag} id=${s.id}  name="${s.name}"  ${loc}  ${s.description ? '— ' + s.description : ''}`;
        });
        return ok(lines.join('\n'));
      }

      case 'add_mcp_server': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        try {
          const server = mcpRegistry.createServer({
            name: input.name,
            url: input.url || '',
            command: input.command || '',
            installDir: input.installDir || '',
            description: input.description || '',
            authToken: input.authToken || '',
            tags: input.tags || [],
          });
          const typeLabel = server.type === 'local' ? '本地' : '远程';
          return ok(`${typeLabel} MCP Server 已添加到 1Shell 仓库: id=${server.id} name="${server.name}"`);
        } catch (e) {
          return err(`添加失败: ${e.message}`);
        }
      }

      case 'remove_mcp_server': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        const id = String(input.id || '').trim();
        if (!id) return err('id 为空');
        if (localMcpService) localMcpService.stop(id);
        const removed = mcpRegistry.deleteServer(id);
        return removed ? ok(`MCP Server "${id}" 已从仓库中删除。`) : err(`MCP Server 不存在: ${id}`);
      }

      case 'deploy_local_mcp': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        const repoUrl = String(input.repoUrl || '').trim();
        const mcpName = String(input.name || '').trim();
        const command = String(input.command || '').trim();
        if (!repoUrl || !mcpName || !command) return err('repoUrl、name、command 均为必填');

        const mcpDir = path.join(ROOT_DIR, 'data', 'local-mcp');
        const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'mcp';
        const installDir = path.join(mcpDir, repoName);

        try {
          fs.mkdirSync(mcpDir, { recursive: true });

          // clone
          const { exec: childExec } = require('child_process');
          const cloneResult = await new Promise((resolve) => {
            const cloneCmd = fs.existsSync(installDir)
              ? `cd "${installDir}" && git pull`
              : `git clone "${repoUrl}" "${installDir}"`;
            childExec(cloneCmd, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
              resolve({ stdout: stdout || '', stderr: (e && !stderr) ? e.message : (stderr || ''), exitCode: e ? 1 : 0 });
            });
          });
          if (cloneResult.exitCode !== 0 && !fs.existsSync(installDir)) {
            return err(`git clone 失败: ${cloneResult.stderr.slice(0, 300)}`);
          }

          // install
          const pkgJson = path.join(installDir, 'package.json');
          if (fs.existsSync(pkgJson)) {
            const installResult = await new Promise((resolve) => {
              childExec('npm install --production', { timeout: 180000, maxBuffer: 8 * 1024 * 1024, cwd: installDir }, (e, stdout, stderr) => {
                resolve({ exitCode: e ? 1 : 0, stderr: (e && !stderr) ? e.message : (stderr || '') });
              });
            });
            if (installResult.exitCode !== 0) {
              return err(`npm install 失败: ${installResult.stderr.slice(0, 300)}`);
            }
          }

          // register
          const server = mcpRegistry.createServer({
            name: mcpName,
            command,
            installDir,
            description: input.description || `部署自 ${repoUrl}`,
            tags: input.tags || ['local', 'deployed'],
          });

          return ok(
            `本地 MCP "${mcpName}" 部署成功！\n` +
            `- 仓库: ${repoUrl}\n` +
            `- 安装目录: ${installDir}\n` +
            `- 启动命令: ${command}\n` +
            `- 已注册 ID: ${server.id}\n` +
            `用户可在工具面板中选中该 MCP 来启动它。`
          );
        } catch (e) {
          return err(`部署失败: ${e.message}`);
        }
      }

      default:
        return err(`未知工具: ${name}`);
    }
  }

  function ok(text)  { return { content: text, is_error: false }; }
  function err(text) { return { content: `[ERROR] ${text}`, is_error: true }; }

  function formatExec({ stdout, stderr, exitCode, durationMs }) {
    const parts = [];
    if (stdout) parts.push(`[stdout]\n${stdout.trimEnd()}`);
    if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
    parts.push(`[exitCode] ${exitCode}`);
    parts.push(`[durationMs] ${durationMs || 0}`);
    return parts.join('\n\n');
  }

  function emitTool(socket, sessionId, toolName, input, result) {
    if (!socket) return;
    socket.emit('ide:tool-call', { sessionId, tool: toolName, input, result: {
      stdout: result.stdout?.substring(0, 4000),
      stderr: result.stderr?.substring(0, 2000),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }});
  }

  // 创建 mock socket 收集 skill:* 事件，同步等待运行结束，返回拼合的文本结果
  function runViaCollector(runId, fn) {
    return new Promise((resolve) => {
      const collector = new EventEmitter();
      const lines = [];
      const MAX_OUTPUT = 30000;
      let totalLen = 0;

      const push = (text) => {
        if (totalLen > MAX_OUTPUT) return;
        const s = String(text);
        totalLen += s.length;
        lines.push(totalLen > MAX_OUTPUT ? s.slice(0, 500) + '\n...[output truncated]' : s);
      };

      let resolved = false;
      const safeResolve = (text) => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(text); } };

      collector.emit = function (event, data) {
        if (!event.startsWith('skill:')) return EventEmitter.prototype.emit.apply(this, arguments);

        switch (event) {
          case 'skill:run-started':
            push(`[started] mode=${data?.mode || 'ai-loop'} host=${data?.hostId || '?'}`);
            break;
          case 'skill:thinking':
            break;
          case 'skill:thought':
            if (data?.text) push(`[thought] ${data.text.slice(0, 500)}`);
            break;
          case 'skill:exec':
            push(`[exec] $ ${data?.command || ''}`);
            break;
          case 'skill:exec-result':
            if (data?.stdout) push(`[stdout] ${data.stdout.slice(0, 4000)}`);
            if (data?.stderr) push(`[stderr] ${data.stderr.slice(0, 2000)}`);
            push(`[exit] code=${data?.exitCode ?? '?'} ${data?.durationMs ?? 0}ms`);
            break;
          case 'skill:info':
            push(`[info] ${data?.message || ''}`);
            break;
          case 'skill:render':
            push(`[render] ${JSON.stringify(data?.payload || {}).slice(0, 2000)}`);
            break;
          case 'skill:done':
            push(`\n[done] 共 ${data?.turns ?? 0} 轮`);
            safeResolve(lines.join('\n'));
            break;
          case 'skill:error':
            push(`\n[error] ${data?.error || '未知错误'}`);
            safeResolve(lines.join('\n'));
            break;
          case 'skill:cancelled':
            push('\n[cancelled]');
            safeResolve(lines.join('\n'));
            break;
          case 'skill:ask':
            push(`[ask] ${data?.payload?.question || data?.payload?.title || '需要用户确认'}`);
            // IDE 模式自动确认，不阻塞 Skill 执行
            if (data?.toolUseId && skillRunner?.continueRun) {
              const answer = data.payload?.type === 'confirm' ? 'yes' : '(auto-confirmed by IDE)';
              push(`[auto-reply] ${answer}`);
              setTimeout(() => skillRunner.continueRun({ runId, toolUseId: data.toolUseId, answer }), 0);
            }
            break;
          case 'skill:mode':
            push(`[mode] ${data?.mode || ''} goal=${data?.goal || ''}`);
            break;
          default:
            break;
        }
        return true;
      };

      const timer = setTimeout(() => {
        push('\n[timeout] 执行超过 5 分钟，已中断');
        safeResolve(lines.join('\n'));
      }, 5 * 60 * 1000);

      fn(collector)
        .then(() => { safeResolve(lines.join('\n')); })
        .catch((e) => { push(`\n[exception] ${e.message}`); safeResolve(lines.join('\n')); });
    });
  }

  return { TOOL_SCHEMAS, handle, approveCommand };
}

module.exports = { createIdeTools };
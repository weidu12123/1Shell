'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function createLocalMcpDeployer({ dataDir, mcpRegistry, localMcpService, hostService, logger }) {
  const mcpRoot = path.join(dataDir, 'local-mcp');
  const SSH_MCP_CONFIG_REL = '.1shell/ssh-mcp-config.json';

  async function inspect({ repoUrl }) {
    const repo = normalizeGitHubRepoUrl(repoUrl);
    const installDir = path.join(mcpRoot, `${safeSegment(repo.owner)}-${safeSegment(repo.repo)}`);
    await ensureRepo(repo.cloneUrl, installDir);

    const packageJson = readPackageJson(installDir);
    const readme = readFirstText(installDir, ['README.md', 'readme.md', 'README.MD']);
    const detection = detectLaunch({ packageJson, readme, installDir, hostService, sshMcpConfigRel: SSH_MCP_CONFIG_REL });

    return {
      repoUrl: repo.webUrl,
      cloneUrl: repo.cloneUrl,
      installDir,
      name: detection.name || repo.repo,
      description: detection.description || `部署自 ${repo.webUrl}`,
      command: detection.command,
      detectedFrom: detection.detectedFrom,
      candidates: detection.candidates,
      installCommand: packageJson ? 'npm install' : '',
      buildCommand: packageJson?.scripts?.build ? 'npm run build' : '',
      tags: ['local', 'deployed'],
      enabled: true,
      autoStart: false,
      exposeToIde: true,
      package: packageJson ? {
        name: packageJson.name || '',
        version: packageJson.version || '',
        main: packageJson.main || '',
        scripts: Object.keys(packageJson.scripts || {}),
      } : null,
      readmeHints: extractReadmeHints(readme),
      warnings: detection.warnings,
    };
  }

  async function register(input = {}) {
    const repo = normalizeGitHubRepoUrl(input.repoUrl);
    const installDir = input.installDir
      ? assertInsideMcpRoot(input.installDir)
      : path.join(mcpRoot, `${safeSegment(repo.owner)}-${safeSegment(repo.repo)}`);

    if (!fs.existsSync(installDir)) {
      await ensureRepo(repo.cloneUrl, installDir);
    }

    const steps = [];
    const packageJson = readPackageJson(installDir);
    if (packageJson) {
      steps.push(await runStep('npm install', 'npm', ['install'], { cwd: installDir, timeout: 300000 }));
      if (packageJson.scripts?.build) {
        steps.push(await runStep('npm run build', 'npm', ['run', 'build'], { cwd: installDir, timeout: 300000 }));
      }
    }

    let command = String(input.command || '').trim();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('name 不能为空');
    if (!command) throw new Error('command 不能为空');
    if (/<[^>]+>/.test(command)) throw new Error('启动命令仍包含占位符，请先替换为真实参数');

    const readme = readFirstText(installDir, ['README.md', 'readme.md', 'README.MD']);
    if (needsExplicitSshTarget(readme, packageJson) || command.includes(SSH_MCP_CONFIG_REL)) {
      const generated = writeSshMcpConfig(installDir);
      command = `node build/index.js --config-file ${toPosix(SSH_MCP_CONFIG_REL)}`;
      steps.push({
        label: 'generate ssh-mcp config',
        exitCode: 0,
        stdout: `已从 1Shell 主机库生成 ${generated.count} 个 SSH 配置`,
        stderr: '',
      });
    }

    const serverInput = {
      name,
      command,
      installDir,
      description: typeof input.description === 'string' ? input.description : `部署自 ${repo.webUrl}`,
      tags: Array.isArray(input.tags) ? input.tags : ['local', 'deployed'],
      enabled: input.enabled !== false,
      autoStart: input.autoStart === true,
      exposeToIde: input.exposeToIde !== false,
    };
    const server = upsertLocalServer(serverInput);

    let preload = null;
    if (localMcpService) {
      localMcpService.stop(server.id);
      if (server.enabled && (server.autoStart || server.exposeToIde)) {
        preload = await localMcpService.start(server.id, server.command, { cwd: server.installDir || undefined });
      }
    }

    return { server, steps, preload };
  }

  function upsertLocalServer(input) {
    const id = registryIdFromName(input.name);
    const existing = mcpRegistry.getServer(id);
    if (!existing) return mcpRegistry.createServer(input);
    if (existing.type && existing.type !== 'local') throw new Error(`同名远程 MCP 已存在: ${id}`);
    return mcpRegistry.updateServer(id, input);
  }

  function writeSshMcpConfig(installDir) {
    if (!hostService?.listHosts || !hostService?.findStoredHost || !hostService?.buildConnectionConfig) {
      throw new Error('当前 1Shell 未提供主机配置服务，无法自动生成 ssh-mcp-server 配置');
    }

    const configs = [];
    const hosts = hostService.listHosts().filter((host) => host?.type === 'ssh');
    for (const publicHost of hosts) {
      const storedHost = hostService.findStoredHost(publicHost.id);
      if (!storedHost || storedHost.proxyHostId) continue;
      const conn = hostService.buildConnectionConfig(storedHost);
      const config = {
        name: safeConfigName(publicHost.name || publicHost.id),
        host: conn.host,
        port: conn.port || 22,
        username: conn.username,
        transportMode: 'exec',
      };
      if (conn.password) config.password = conn.password;
      if (conn.privateKey) config.privateKey = conn.privateKey;
      if (conn.passphrase) config.passphrase = conn.passphrase;
      configs.push(config);
    }

    if (configs.length === 0) {
      throw new Error('没有可直接复用的 1Shell SSH 主机配置；请先在主机管理中添加非跳板 SSH 主机');
    }

    const configPath = path.join(installDir, SSH_MCP_CONFIG_REL);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(configs, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(configPath, 0o600); } catch {}
    return { path: configPath, count: configs.length };
  }

  async function ensureRepo(cloneUrl, installDir) {
    fs.mkdirSync(mcpRoot, { recursive: true });
    if (fs.existsSync(installDir)) {
      if (!fs.existsSync(path.join(installDir, '.git'))) {
        throw new Error(`安装目录已存在但不是 git 仓库: ${installDir}`);
      }
      await runStep('git pull --ff-only', 'git', ['-C', installDir, 'pull', '--ff-only'], { cwd: installDir, timeout: 120000 });
      return;
    }
    await runStep('git clone', 'git', ['clone', cloneUrl, installDir], { cwd: mcpRoot, timeout: 120000 });
  }

  async function runStep(label, command, args, options = {}) {
    const result = await execFileResult(commandForPlatform(command), args, options);
    const step = {
      label,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000),
    };
    if (result.exitCode !== 0) {
      throw new Error(`${label} 失败: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
    }
    return step;
  }

  function execFileResult(command, args, { cwd, timeout }) {
    return new Promise((resolve) => {
      const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : command;
      const spawnArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', [command, ...args].map(quoteWinArg).join(' ')]
        : args;
      execFile(spawnCommand, spawnArgs, {
        cwd: cwd ? path.resolve(cwd) : undefined,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) logger?.warn?.(`[local-mcp-deploy] ${command} failed: ${error.message}`);
        resolve({
          exitCode: error ? (error.code || 1) : 0,
          stdout: stdout || '',
          stderr: stderr || (error ? error.message : ''),
        });
      });
    });
  }

  function assertInsideMcpRoot(inputPath) {
    const resolved = path.resolve(String(inputPath));
    const root = path.resolve(mcpRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('installDir 必须位于 data/local-mcp 内');
    }
    return resolved;
  }

  return { inspect, register };
}

function normalizeGitHubRepoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('请输入有效的 GitHub 仓库 URL');
  }
  if (!/^https?:$/.test(url.protocol) || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('目前只支持 https://github.com/<owner>/<repo> 仓库');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub 仓库 URL 缺少 owner/repo');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!isSafeRepoPart(owner) || !isSafeRepoPart(repo)) throw new Error('GitHub 仓库名称非法');
  return {
    owner,
    repo,
    webUrl: `https://github.com/${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function detectLaunch({ packageJson, readme, installDir, hostService, sshMcpConfigRel }) {
  const candidates = [];
  const warnings = [];
  const sshHostCount = countDirectSshHosts(hostService);
  const add = (command, source) => {
    const value = String(command || '').trim();
    if (!value || candidates.some((c) => c.command === value)) return;
    candidates.push({ command: value, source });
  };

  for (const hint of extractReadmeHints(readme)) add(hint, 'README');

  if (packageJson) {
    const bin = firstBinPath(packageJson.bin);
    if (bin) add(`node ${toPosix(bin)}`, 'package.json bin');
    if (packageJson.main) add(`node ${toPosix(packageJson.main)}`, 'package.json main');
    if (packageJson.scripts?.start) add('npm start', 'package.json scripts.start');
    if (packageJson.scripts?.mcp) add('npm run mcp', 'package.json scripts.mcp');
    if (packageJson.scripts?.dev) add('npm run dev', 'package.json scripts.dev');
  }

  for (const rel of ['dist/index.js', 'build/index.js', 'server.js', 'index.js', 'src/index.js']) {
    if (fs.existsSync(path.join(installDir, rel))) add(`node ${rel}`, rel);
  }
  if (fs.existsSync(path.join(installDir, 'src', 'index.ts'))) add('npx tsx src/index.ts', 'src/index.ts');

  if (needsExplicitSshTarget(readme, packageJson)) {
    const configCommand = `node build/index.js --config-file ${toPosix(sshMcpConfigRel)}`;
    candidates.unshift({ command: configCommand, source: '1Shell SSH hosts' });
    if (sshHostCount > 0) {
      warnings.push(`将自动复用 1Shell 已保存的 ${sshHostCount} 台 SSH 主机生成私有 config-file，密钥不会出现在启动命令或界面中。`);
    } else {
      warnings.push('未发现可直接复用的 1Shell SSH 主机；部署时会要求先在主机管理中添加 SSH 主机。');
    }
  }

  if (candidates.length === 0) warnings.push('未能自动识别启动命令，请查看 README 后手动填写。');
  const safeDefault = candidates[0]?.command || '';

  return {
    name: cleanPackageName(packageJson?.name),
    description: typeof packageJson?.description === 'string' ? packageJson.description : '',
    command: safeDefault,
    detectedFrom: safeDefault ? candidates[0]?.source || '' : '',
    candidates,
    warnings,
  };
}

function needsExplicitSshTarget(readme, packageJson) {
  const text = `${packageJson?.name || ''}\n${packageJson?.description || ''}\n${readme || ''}`.toLowerCase();
  return text.includes('ssh-mcp-server')
    && text.includes('--host')
    && text.includes('--username')
    && (text.includes('--password') || text.includes('--privatekey') || text.includes('--agent'));
}

function extractReadmeHints(readme) {
  if (!readme) return [];
  const hints = [];
  const lines = readme.split('\n').slice(0, 300);
  for (const raw of lines) {
    const line = raw.replace(/^\s*[`>$#]+\s*/, '').trim();
    if (!/(npx|node|npm\s+(run|start)|uvx|python3?)\b/i.test(line)) continue;
    if (!/(mcp|server|stdio|index|dist|build)/i.test(line)) continue;
    if (line.length > 160) continue;
    hints.push(line.replace(/[`;]/g, '').trim());
    if (hints.length >= 5) break;
  }
  return hints;
}

function readPackageJson(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readFirstText(dir, names) {
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      return fs.readFileSync(file, 'utf8').slice(0, 24000);
    } catch {
      return '';
    }
  }
  return '';
}

function firstBinPath(bin) {
  if (typeof bin === 'string') return bin;
  if (!bin || typeof bin !== 'object') return '';
  const first = Object.values(bin).find((value) => typeof value === 'string');
  return first || '';
}

function cleanPackageName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/^@/, '').replace(/\//g, '-');
}

function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
}

function isSafeRepoPart(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ''));
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function registryIdFromName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'mcp';
}

function safeConfigName(name) {
  return String(name || 'host').trim().replace(/[\r\n]+/g, ' ').slice(0, 80) || 'host';
}

function countDirectSshHosts(hostService) {
  try {
    if (!hostService?.listHosts || !hostService?.findStoredHost) return 0;
    return hostService.listHosts().filter((host) => {
      if (host?.type !== 'ssh') return false;
      const stored = hostService.findStoredHost(host.id);
      return stored && !stored.proxyHostId;
    }).length;
  } catch {
    return 0;
  }
}

function commandForPlatform(command) {
  if (process.platform !== 'win32') return command;
  if (command === 'npm') return 'npm.cmd';
  if (command === 'npx') return 'npx.cmd';
  return command;
}

function quoteWinArg(value) {
  const text = String(value || '');
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

module.exports = { createLocalMcpDeployer };

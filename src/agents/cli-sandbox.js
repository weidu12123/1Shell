'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getManifest, getAllManifests, UPSTREAM_LABELS } = require('./cli-manifest');

function createCliSandbox({ dataDir, bridgeToken, port, proxyConfigStore }) {
  const sandboxRoot = path.join(dataDir, 'cli-sandbox');
  const serverOrigin = `http://127.0.0.1:${port}`;
  const home = os.homedir();

  function getActiveProviderConfig(cliId) {
    try {
      return proxyConfigStore?.getActiveProvider?.(cliId) || null;
    } catch {
      return null;
    }
  }

  function buildMcpEntry(cliId = null) {
    if (cliId === 'opencode') {
      return {
        type: 'remote',
        url: `${serverOrigin}/mcp/sse?token=${bridgeToken}`,
        headers: { 'X-Bridge-Token': bridgeToken },
      };
    }
    return {
      type: 'sse',
      url: `${serverOrigin}/mcp/sse?token=${bridgeToken}`,
      headers: { 'X-Bridge-Token': bridgeToken },
    };
  }

  function safeReadJSON(filePath) {
    if (!filePath) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  }

  function safeWriteJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function deepSet(obj, pointer, value) {
    const keys = pointer.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }

  function getSandboxDir(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return null;
    const baseDir = path.join(sandboxRoot, manifest.sandbox.dirName);
    if (manifest.sandbox.configSubDir) {
      return path.join(baseDir, manifest.sandbox.configSubDir);
    }
    return baseDir;
  }

  function getWorkspaceConfigPath(manifest, configFile, cwd) {
    if (!configFile?.scope || configFile.scope !== 'workspace' || !cwd) return null;
    return path.join(cwd, manifest.sandbox.workspaceConfigDir || manifest.sandbox.defaultConfigDir, configFile.name);
  }

  function hasWorkspaceConfig(cliId, { cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;
    const workspaceFiles = (manifest.sandbox.configFiles || []).filter(file => file.scope === 'workspace');
    if (workspaceFiles.length === 0) return true;
    if (!cwd) return false;

    return workspaceFiles.every((configFile) => {
      const targetPath = getWorkspaceConfigPath(manifest, configFile, cwd);
      if (!targetPath || !fs.existsSync(targetPath)) return false;
      if (configFile.mergeStrategy !== 'deep-merge') return true;
      const data = safeReadJSON(targetPath);
      if (!data) return false;
      const keys = String(configFile.mergePointer || '').split('.').filter(Boolean);
      let cur = data;
      for (const key of keys) {
        if (cur == null || typeof cur !== 'object' || !(key in cur)) return false;
        cur = cur[key];
      }
      return cur != null;
    });
  }

  function ensureSandbox(cliId, { cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);

    const dir = getSandboxDir(cliId);
    fs.mkdirSync(dir, { recursive: true });

    for (const configFile of manifest.sandbox.configFiles) {
      if (configFile.scope === 'workspace') {
        if (!cwd) continue;
        const workspaceDir = path.join(cwd, manifest.sandbox.workspaceConfigDir || manifest.sandbox.defaultConfigDir);
        const targetPath = path.join(workspaceDir, configFile.name);
        if (configFile.mergeStrategy === 'deep-merge') {
          let userConfig = safeReadJSON(targetPath) || {};
          userConfig = cleanSandboxEnv(userConfig, configFile);
          deepSet(userConfig, configFile.mergePointer, configFile.mergeValue || buildMcpEntry(cliId));
          safeWriteJSON(targetPath, userConfig);
        }
        continue;
      }

      const targetPath = path.join(dir, configFile.name);

      if (configFile.mergeStrategy === 'deep-merge') {
        const userConfigPath = path.join(home, manifest.sandbox.defaultConfigDir, configFile.name);
        let userConfig = safeReadJSON(userConfigPath) || {};
        userConfig = cleanSandboxEnv(userConfig, configFile);
        deepSet(userConfig, configFile.mergePointer, configFile.mergeValue || buildMcpEntry(cliId));
        safeWriteJSON(targetPath, userConfig);

      } else if (configFile.mergeStrategy === 'template') {
        const content = renderTemplate(cliId, configFile.name, { cwd });
        if (content) fs.writeFileSync(targetPath, content, 'utf8');

      } else if (configFile.mergeStrategy === 'overwrite') {
        const content = generateOverwriteContent(cliId, configFile.name, configFile);
        safeWriteJSON(targetPath, content);
      }
    }

    writeManifestMeta(cliId, { updatedAt: new Date().toISOString() });
    return dir;
  }

  function resolveOverrideEnv(configFile) {
    const env = {};
    for (const [key, value] of Object.entries(configFile?.overrideEnvKeys || {})) {
      env[key] = typeof value === 'string' ? value.replace('{serverUrl}', serverOrigin) : value;
    }
    return env;
  }

  function cleanSandboxEnv(config, configFile) {
    if (!configFile.overrideEnvKeys) return config;
    const cleaned = { ...config };
    if (cleaned.env && typeof cleaned.env === 'object') {
      cleaned.env = {
        ...cleaned.env,
        ...resolveOverrideEnv(configFile),
      };
    }
    return cleaned;
  }

  function quoteShellArg(value) {
    const str = String(value ?? '');
    if (!str) return '""';
    return `"${str.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  function quotePowerShellArg(value) {
    const str = String(value ?? '');
    return `'${str.replace(/'/g, "''")}'`;
  }

  function appendShellArgs(command, args, shell) {
    if (!args?.length) return command;
    const quoted = args.map((arg) => shell === 'powershell' ? quotePowerShellArg(arg) : quoteShellArg(arg));
    return `${command} ${quoted.join(' ')}`;
  }

  function getClaudeMcpConfigPath() {
    return path.join(getSandboxDir('claude-code'), 'mcp-config.json');
  }

  function buildLaunchArgs(cliId, { useLocalEnv = false, cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return [];

    const args = [...(manifest.launchArgs || [])];
    if (useLocalEnv) return args;

    ensureSandbox(cliId, { cwd });

    if (cliId === 'claude-code') {
      args.push('--strict-mcp-config', '--mcp-config', getClaudeMcpConfigPath());
    }

    return args;
  }

  function hasRequiredConfigFiles(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;

    return (manifest.sandbox.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .every((configFile) => fs.existsSync(path.join(getSandboxDir(cliId), configFile.name)));
  }

  function getSandboxReady(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;
    if (!hasRequiredConfigFiles(cliId)) return false;
    if ((manifest.sandbox.configFiles || []).some(file => file.scope === 'workspace')) {
      return hasWorkspaceConfig(cliId, { cwd: process.cwd() });
    }
    return true;
  }

  function buildShellCommandString(binary, args, shell) {
    const base = shell === 'powershell' ? binary : binary;
    return appendShellArgs(base, args, shell);
  }

  function buildClaudeSettingsContent(configFile) {
    return {
      env: resolveOverrideEnv(configFile),
    };
  }

  function buildClaudeMcpConfig() {
    return {
      mcpServers: {
        '1shell': buildMcpEntry(),
      },
    };
  }

  function buildClaudeConfigContent(fileName, configFile) {
    if (fileName === 'settings.json') {
      return buildClaudeSettingsContent(configFile);
    }
    if (fileName === 'config.json') {
      return { primaryApiKey: 'sk-1shell-proxy' };
    }
    if (fileName === 'mcp-config.json') {
      return buildClaudeMcpConfig();
    }
    return {};
  }

  function generateOverwriteContent(cliId, fileName, configFile) {
    if (cliId === 'claude-code') {
      return buildClaudeConfigContent(fileName, configFile);
    }
    if (cliId === 'codex' && fileName === 'auth.json') {
      return { OPENAI_API_KEY: 'sk-1shell-proxy' };
    }
    return {};
  }

  function renderTemplate(cliId, fileName, { cwd }) {
    if (cliId === 'codex' && fileName === 'config.toml') {
      const active = getActiveProviderConfig('codex');
      const model = active?.model || 'gpt-4o';
      const projectsCwd = cwd || process.cwd();
      return [
        `model_provider = "1shell-proxy"`,
        `model = "${model}"`,
        `disable_response_storage = true`,
        ``,
        `[model_providers.1shell-proxy]`,
        `name = "1shell-proxy"`,
        `wire_api = "responses"`,
        `base_url = "${serverOrigin}/api/proxy/codex"`,
        `requires_openai_auth = true`,
        ``,
        `[mcp_servers]`,
        ``,
        `[mcp_servers.1shell]`,
        `url = "${serverOrigin}/mcp/sse"`,
        `bearer_token_env_var = "1SHELL_MCP_TOKEN"`,
        ``,
        `[projects.'${projectsCwd}']`,
        `trust_level = "trusted"`,
        ``,
        `[windows]`,
        `sandbox = "elevated"`,
      ].join('\n');
    }
    return '';
  }

  function writeManifestMeta(cliId, meta) {
    const dir = getSandboxDir(cliId);
    if (!dir) return;
    safeWriteJSON(path.join(dir, '.1shell-meta.json'), { cliId, ...meta });
  }

  function buildLaunchEnv(cliId, { useLocalEnv = false, cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return {};

    const env = {};

    if (!useLocalEnv) {
      for (const [key, tpl] of Object.entries(manifest.proxyEnv)) {
        env[key] = tpl.replace('{serverUrl}', serverOrigin);
      }

      ensureSandbox(cliId, { cwd });
      const sandboxDir = getSandboxDir(cliId);

      if (manifest.sandbox.configDirEnv) {
        if (manifest.sandbox.configSubDir) {
          const baseDir = path.join(sandboxRoot, manifest.sandbox.dirName);
          env[manifest.sandbox.configDirEnv] = baseDir;
        } else {
          env[manifest.sandbox.configDirEnv] = sandboxDir;
        }
      }

      env['1SHELL_MCP_TOKEN'] = bridgeToken;
    }

    Object.assign(env, manifest.extraEnv);
    return env;
  }

  function buildShellCommand(cliId, { shell = 'bash' } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return '';

    const dir = getSandboxDir(cliId);
    const hasMeta = fs.existsSync(path.join(dir, '.1shell-meta.json'));
    if (!hasMeta) ensureSandbox(cliId);

    const env = buildLaunchEnv(cliId, { cwd: process.cwd() });
    const args = buildLaunchArgs(cliId, { cwd: process.cwd() });

    if (shell === 'powershell') {
      const psExports = Object.entries(env)
        .map(([k, v]) => `$env:${k}=${quotePowerShellArg(v)}`)
        .join('; ');
      const command = buildShellCommandString(manifest.binary, args, 'powershell');
      return psExports ? `${psExports}; ${command}` : command;
    }

    const exports = Object.entries(env)
      .map(([k, v]) => `${k}=${quoteShellArg(v)}`)
      .join(' ');
    const command = buildShellCommandString(manifest.binary, args, 'bash');
    return exports ? `${exports} ${command}` : command;
  }

  function resetSandbox(cliId) {
    const dir = getSandboxDir(cliId);
    if (!dir) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  function getSandboxStatus(cliId) {
    const dir = getSandboxDir(cliId);
    if (!dir) return { sandboxed: false, sandboxDir: null, meta: null };
    const metaPath = path.join(dir, '.1shell-meta.json');
    const exists = fs.existsSync(metaPath);
    return {
      sandboxed: exists && getSandboxReady(cliId),
      sandboxDir: dir,
      meta: exists ? safeReadJSON(metaPath) : null,
    };
  }

  function getScanInfo() {
    const isWindows = os.platform() === 'win32';
    return getAllManifests().map(manifest => {
      const binary = detectBinary(manifest.binary, isWindows);
      const sandbox = getSandboxStatus(manifest.id);
      const active = getActiveProviderConfig(manifest.id);
      const isGatewayReady = Boolean(bridgeToken);

      let status;
      if (sandbox.sandboxed && isGatewayReady) status = 'sandboxed';
      else if (binary.installed) status = 'detected';
      else status = 'missing';

      return {
        id: manifest.id,
        name: manifest.name,
        icon: manifest.icon,
        gradient: manifest.gradient,
        repo: manifest.repo,
        description: manifest.description,
        protocol: 'mcp',
        clientProtocol: manifest.clientProtocol,
        supportedUpstream: manifest.supportedUpstream,
        proxyPath: manifest.proxyPath,
        status,
        binary: { name: manifest.binary, ...binary },
        sandbox,
        proxy: {
          providerCount: active ? 1 : 0,
          activeProvider: active ? {
            name: active.name,
            model: active.model,
            upstreamProtocol: active.upstreamProtocol,
            apiKeySet: Boolean(active.apiKey),
          } : null,
        },
      };
    });
  }

  return {
    buildLaunchArgs,
    buildLaunchEnv,
    buildShellCommand,
    ensureSandbox,
    getSandboxDir,
    getSandboxStatus,
    getScanInfo,
    resetSandbox,
    UPSTREAM_LABELS,
  };
}

function detectBinary(name, isWindows) {
  if (!name) return { installed: false };
  const { execSync } = require('child_process');
  if (!isWindows && path.isAbsolute(name)) {
    return fs.existsSync(name)
      ? { installed: true, path: name }
      : { installed: false };
  }
  try {
    const cmd = isWindows ? `where ${name} 2>NUL` : `which ${name} 2>/dev/null`;
    const result = execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim();
    if (result) return { installed: true, path: result.split('\n')[0].trim() };
  } catch { /* not found */ }
  return { installed: false };
}

module.exports = { createCliSandbox };
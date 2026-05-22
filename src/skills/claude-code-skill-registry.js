'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseFrontmatter } = require('./registry');

const BUILTIN_CLAUDE_CODE_SKILL_IDS = new Set([
  'program-authoring',
  'oneshell-skill-authoring',
]);

function createClaudeCodeSkillRegistry({ dataDir, logger } = {}) {
  const rootDir = path.join(dataDir, 'claude-code-skills');

  function listSkills() {
    ensureRoot();
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readPackage(rootDir, entry.name))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || b.importedAt || '').localeCompare(String(a.updatedAt || a.importedAt || '')));
  }

  function getSkill(id) {
    return readPackage(rootDir, assertSafeId(id));
  }

  async function inspect(input = {}) {
    const repo = normalizeGitHubRepoUrl(input.repoUrl);
    const id = assertMutableId(input.id || `${repo.owner}-${repo.repo}`);
    const packageDir = path.join(rootDir, id);
    const sourceDir = path.join(packageDir, 'source');
    await ensureRepo(repo.cloneUrl, sourceDir);
    const discovered = discoverSkills(sourceDir);
    const readme = readFirstText(sourceDir, ['README.md', 'readme.md', 'README.MD']);
    return {
      id,
      repoUrl: repo.webUrl,
      installDir: packageDir,
      sourceDir,
      name: packageName(repo, discovered),
      description: packageDescription(repo, discovered, readme),
      tags: ['claude-code-skill'],
      enabled: true,
      skills: discovered,
      warnings: discovered.length ? [] : ['未在仓库中发现 SKILL.md；仍可托管，但不会显示可用 Skill 入口。'],
    };
  }

  async function register(input = {}) {
    const repo = normalizeGitHubRepoUrl(input.repoUrl);
    const id = assertMutableId(input.id || `${repo.owner}-${repo.repo}`);
    const packageDir = path.join(rootDir, id);
    const sourceDir = path.join(packageDir, 'source');
    await ensureRepo(repo.cloneUrl, sourceDir);

    const discovered = discoverSkills(sourceDir);
    const now = new Date().toISOString();
    const previous = readJson(path.join(packageDir, 'manifest.json'));
    const manifest = {
      id,
      kind: 'claude-code-skill',
      name: String(input.name || packageName(repo, discovered)).trim(),
      description: String(input.description || packageDescription(repo, discovered, readFirstText(sourceDir, ['README.md', 'readme.md', 'README.MD']))).trim(),
      tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean) : ['claude-code-skill'],
      enabled: input.enabled != null ? input.enabled !== false : previous?.enabled !== false,
      repoUrl: repo.webUrl,
      installDir: packageDir,
      sourceDir,
      importedAt: previous?.importedAt || now,
      updatedAt: now,
      skills: discovered,
    };

    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  function reload() {
    return listSkills().length;
  }

  function updateSkill(id, patch = {}) {
    const safeId = assertSafeId(id);
    const current = readPackage(rootDir, safeId);
    if (!current) return null;
    const packageDir = path.join(rootDir, safeId);
    const next = {
      ...current,
      enabled: patch.enabled != null ? patch.enabled !== false : current.enabled !== false,
      updatedAt: new Date().toISOString(),
    };
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
    if (typeof patch.description === 'string') next.description = patch.description.trim();
    if (Array.isArray(patch.tags)) next.tags = patch.tags.map(String).filter(Boolean);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  function deleteSkill(id) {
    const safeId = assertMutableId(id);
    const dir = path.join(rootDir, safeId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async function ensureRepo(cloneUrl, sourceDir) {
    ensureRoot();
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    if (fs.existsSync(sourceDir)) {
      if (!fs.existsSync(path.join(sourceDir, '.git'))) {
        throw new Error(`导入目录已存在但不是 git 仓库: ${sourceDir}`);
      }
      await runGit('git pull --ff-only', ['-C', sourceDir, 'pull', '--ff-only'], { cwd: sourceDir });
      return;
    }
    await runGit('git clone', ['clone', cloneUrl, sourceDir], { cwd: path.dirname(sourceDir) });
  }

  async function runGit(label, args, options = {}) {
    const result = await execFileResult(commandForPlatform('git'), args, { ...options, timeout: 120000 });
    if (result.exitCode !== 0) {
      throw new Error(`${label} 失败: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
    }
    return result;
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
        if (error) logger?.warn?.(`[claude-skill-import] ${command} failed: ${error.message}`);
        resolve({
          exitCode: error ? (error.code || 1) : 0,
          stdout: stdout || '',
          stderr: stderr || (error ? error.message : ''),
        });
      });
    });
  }

  function ensureRoot() {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  return { listSkills, getSkill, inspect, register, reload, updateSkill, deleteSkill };
}

function discoverSkills(sourceDir) {
  const candidates = [
    path.join(sourceDir, 'SKILL.md'),
    ...skillFilesUnder(path.join(sourceDir, '.claude', 'skills')),
    ...skillFilesUnder(path.join(sourceDir, 'skills')),
  ];

  const seen = new Set();
  const skills = [];
  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const { meta } = parseFrontmatter(raw);
      const rel = path.relative(sourceDir, resolved).replace(/\\/g, '/');
      const id = rel === 'SKILL.md' ? path.basename(path.dirname(sourceDir)) : path.basename(path.dirname(resolved));
      skills.push({
        id: safeSegment(meta.name || id) || safeSegment(id),
        name: meta.name || id,
        description: meta.description || '',
        path: rel,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        userInvocable: meta.userInvocable === true || meta['user-invocable'] === true,
      });
    } catch {
      // skip unreadable skill
    }
  }
  return skills;
}

function skillFilesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'SKILL.md'));
}

function readPackage(rootDir, id) {
  const safeId = assertSafeId(id);
  const packageDir = path.join(rootDir, safeId);
  const manifestPath = path.join(packageDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (manifest) return withBuiltinFlags(manifest, safeId);
  if (!fs.existsSync(packageDir)) return null;
  const sourceDir = path.join(packageDir, 'source');
  return {
    id: safeId,
    kind: 'claude-code-skill',
    name: safeId,
    description: '',
    tags: ['claude-code-skill'],
    enabled: true,
    installDir: packageDir,
    sourceDir,
    skills: fs.existsSync(sourceDir) ? discoverSkills(sourceDir) : [],
    builtin: BUILTIN_CLAUDE_CODE_SKILL_IDS.has(safeId),
    deletable: !BUILTIN_CLAUDE_CODE_SKILL_IDS.has(safeId),
  };
}

function withBuiltinFlags(skill, id) {
  if (!skill) return skill;
  const builtin = BUILTIN_CLAUDE_CODE_SKILL_IDS.has(id);
  if (!builtin) return skill;
  return { ...skill, builtin: true, system: true, deletable: false };
}

function assertMutableId(value) {
  const id = assertSafeId(value);
  if (!BUILTIN_CLAUDE_CODE_SKILL_IDS.has(id)) return id;
  const error = new Error('系统默认 Claude Code Skill 不允许删除或覆盖');
  error.statusCode = 403;
  throw error;
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

function packageName(repo, discovered) {
  return discovered.length === 1 ? discovered[0].name : repo.repo;
}

function packageDescription(repo, discovered, readme) {
  if (discovered.length === 1 && discovered[0].description) return discovered[0].description;
  return firstParagraph(readme) || `Claude Code Skill imported from ${repo.webUrl}`;
}

function readFirstText(dir, names) {
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try { return fs.readFileSync(file, 'utf8').slice(0, 12000); } catch { return ''; }
  }
  return '';
}

function firstParagraph(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, '').trim())
    .find((part) => part && part.length < 500) || '';
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function assertSafeId(value) {
  const id = safeSegment(value);
  if (!id) throw new Error('Skill ID 不能为空');
  return id.slice(0, 96);
}

function safeSegment(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function isSafeRepoPart(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ''));
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

module.exports = { createClaudeCodeSkillRegistry };

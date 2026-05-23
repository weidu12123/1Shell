'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || 'dev';
const releaseRoot = path.join(ROOT, 'release');
const packageDir = path.join(releaseRoot, `1Shell-v${version}-windows-portable`);
const zipPath = `${packageDir}.zip`;
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function optionValue(name) {
  const prefix = `${name}=`;
  const match = args.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function run(command, commandArgs, options = {}) {
  const cwd = options.cwd || ROOT;
  const useWindowsShell = process.platform === 'win32' && command === 'npm';
  const result = useWindowsShell
    ? spawnSync([command, ...commandArgs].join(' '), { cwd, stdio: 'inherit', shell: true, env: process.env })
    : spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(relativePath, targetRelativePath = relativePath) {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) return;

  const target = path.join(packageDir, targetRelativePath);
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function copyDir(relativePath, targetRelativePath = relativePath) {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) return;

  const target = path.join(packageDir, targetRelativePath);
  fs.cpSync(source, target, { recursive: true });
}

function writeText(relativePath, lines) {
  const target = path.join(packageDir, relativePath);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${lines.join('\r\n')}\r\n`, 'utf8');
}

function buildFrontend() {
  if (hasFlag('--skip-build')) return;
  run('npm', ['ci'], { cwd: path.join(ROOT, 'frontend') });
  run('npm', ['run', 'build'], { cwd: path.join(ROOT, 'frontend') });
}

function assertFrontendBuilt() {
  const indexPath = path.join(ROOT, 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error('frontend/dist/index.html not found. Run without --skip-build or build the frontend first.');
  }
}

function copyRuntimeNode() {
  if (hasFlag('--no-node-runtime')) return false;

  const defaultNode = process.platform === 'win32' && path.basename(process.execPath).toLowerCase() === 'node.exe'
    ? process.execPath
    : '';
  const nodeRuntime = optionValue('--node-runtime') || process.env.NODE_RUNTIME_DIR || defaultNode;
  if (!nodeRuntime) return false;

  const resolved = path.resolve(nodeRuntime);
  const stat = fs.statSync(resolved);
  const nodeExe = stat.isDirectory() ? path.join(resolved, 'node.exe') : resolved;
  if (!fs.existsSync(nodeExe) || path.basename(nodeExe).toLowerCase() !== 'node.exe') {
    throw new Error(`node.exe not found at ${resolved}`);
  }

  ensureDir(path.join(packageDir, 'node'));
  fs.copyFileSync(nodeExe, path.join(packageDir, 'node', 'node.exe'));
  return true;
}

function installProductionDependencies() {
  if (hasFlag('--skip-install')) return;
  run('npm', ['ci', '--omit=dev'], { cwd: packageDir });
}

function writeLauncher() {
  writeText('1Shell.cmd', [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    'setlocal',
    'cd /d "%~dp0"',
    'title 1Shell',
    '',
    'if exist "%~dp0node\\node.exe" (',
    '  set "NODE_EXE=%~dp0node\\node.exe"',
    ') else (',
    '  set "NODE_EXE=node"',
    ')',
    '',
    '"%NODE_EXE%" --version >nul 2>&1',
    'if errorlevel 1 (',
    '  echo [1Shell] Node.js not found.',
    '  echo [1Shell] Please install Node.js 18+, or rebuild the portable package with --node-runtime=PATH_TO_NODE.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    '"%NODE_EXE%" "%~dp0launcher.js"',
    'if errorlevel 1 pause',
  ]);

  copyFile(path.join('scripts', 'windows-portable-launcher.js'), 'launcher.js');

  writeText('README-START.txt', [
    '1Shell Windows Portable',
    '',
    'Start:',
    '  Double-click 1Shell.cmd',
    '',
    'Default URL:',
    '  http://127.0.0.1:3301/app/',
    '',
    'First run:',
    '  The launcher creates .env automatically and generates a random admin password.',
    '  The password is printed in the console and saved to FIRST-RUN-CREDENTIALS.txt.',
    '',
    'Bundled Node.js:',
    '  If the package contains node\\node.exe, 1Shell.cmd uses it automatically.',
    '  Otherwise it uses the system Node.js. Node.js 18+ is required.',
    '',
    'Data:',
    '  Runtime data is stored in the data folder next to 1Shell.cmd.',
    '  Back up data and .env before replacing this folder during upgrades.',
  ]);
}

function createZip() {
  if (hasFlag('--no-zip')) return;
  const psCommand = `Compress-Archive -Path '${packageDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
  const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', psCommand], {
    cwd: releaseRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.warn('[release] Zip creation skipped: PowerShell Compress-Archive failed.');
  }
}

function main() {
  buildFrontend();
  assertFrontendBuilt();

  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  ensureDir(packageDir);

  copyFile('server.js');
  copyFile('package.json');
  copyFile('package-lock.json');
  copyFile('LICENSE');
  copyFile('.env.example');
  copyDir('src');
  copyDir('lib');
  copyDir('bin');
  copyDir('public');
  copyDir(path.join('frontend', 'dist'));
  copyDir(path.join('data', 'skills'));
  copyFile(path.join('data', '.gitkeep'));
  copyFile(path.join('agent', 'install.sh'));
  copyDir(path.join('agent', 'dist'));
  ensureDir(path.join(packageDir, 'data'));
  ensureDir(path.join(packageDir, 'logs'));

  const bundledNode = copyRuntimeNode();
  installProductionDependencies();
  writeLauncher();
  createZip();

  console.log(`[release] Created ${path.relative(ROOT, packageDir)}`);
  if (fs.existsSync(zipPath)) console.log(`[release] Created ${path.relative(ROOT, zipPath)}`);
  if (!bundledNode) {
    console.log('[release] Node.js runtime was not bundled. Use --node-runtime=PATH or NODE_RUNTIME_DIR for a true portable package.');
  }
}

main();

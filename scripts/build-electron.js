'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || 'dev';
const electronVersion = String(pkg.devDependencies?.electron || '').replace(/^[^0-9]*/, '') || '42.1.0';
const args = process.argv.slice(2);
const releaseRoot = path.join(ROOT, 'release');
const portableDir = path.join(releaseRoot, `1Shell-v${version}-windows-portable`);
const stagingDir = path.join(releaseRoot, 'electron-app');
const desktopBackendDir = path.join(releaseRoot, 'electron-backend');
const outputDir = path.join(releaseRoot, 'desktop');
const desktopPortableDir = path.join(releaseRoot, `1Shell-v${version}-windows-desktop-portable`);
const desktopZipPath = `${desktopPortableDir}.zip`;
const generatedConfig = path.join(releaseRoot, 'electron-builder.generated.json');
const buildInstaller = hasFlag('--installer') || hasFlag('--nsis');

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
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  const useWindowsShell = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const result = useWindowsShell
    ? spawnSync([command, ...commandArgs].join(' '), { cwd, stdio: 'inherit', shell: true, env })
    : spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed`);
}

function buildPortablePackage() {
  if (hasFlag('--skip-portable')) return;

  const packageArgs = ['run', 'release:win-portable', '--'];
  if (hasFlag('--skip-build')) packageArgs.push('--skip-build');

  const nodeRuntime = optionValue('--node-runtime') || process.env.NODE_RUNTIME_DIR || '';
  if (nodeRuntime) packageArgs.push(`--node-runtime=${nodeRuntime}`);
  if (hasFlag('--no-node-runtime')) packageArgs.push('--no-node-runtime');

  run('npm', packageArgs);
}

function prepareDesktopBackend() {
  fs.rmSync(desktopBackendDir, { recursive: true, force: true });
  fs.cpSync(portableDir, desktopBackendDir, { recursive: true });

  const nodeModulesDir = path.join(desktopBackendDir, 'node_modules');
  const depsDir = path.join(desktopBackendDir, 'deps');
  fs.rmSync(depsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  fs.cpSync(nodeModulesDir, depsDir, { recursive: true });
  fs.rmSync(nodeModulesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}

function prepareStagingApp() {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'electron'), path.join(stagingDir, 'electron'), { recursive: true });

  const desktopPackage = {
    name: '1shell-desktop',
    version,
    description: pkg.description,
    main: 'electron/main.js',
    author: pkg.author,
    license: pkg.license,
  };
  fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(desktopPackage, null, 2), 'utf8');
}

function writeBuilderConfig() {
  fs.mkdirSync(releaseRoot, { recursive: true });
  const config = {
    appId: 'com.weidu12123.1shell',
    productName: '1Shell',
    copyright: `Copyright © ${new Date().getFullYear()} weidu12123`,
    electronVersion,
    asar: true,
    compression: 'maximum',
    npmRebuild: false,
    disableDefaultIgnoredFiles: true,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    directories: {
      output: outputDir,
      buildResources: path.join(ROOT, 'electron'),
    },
    files: [
      '**/*',
    ],
    extraResources: [
      {
        from: desktopBackendDir,
        to: 'backend',
        filter: ['**/*'],
      },
    ],
    win: {
      icon: path.join(ROOT, 'electron', 'icon.ico'),
      ...(buildInstaller ? {
        target: [
          {
            target: 'nsis',
            arch: ['x64'],
          },
        ],
      } : {}),
      requestedExecutionLevel: 'asInvoker',
      signAndEditExecutable: false,
      verifyUpdateCodeSignature: false,
    },
    ...(buildInstaller ? {
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: '1Shell',
        uninstallDisplayName: '1Shell',
        deleteAppDataOnUninstall: false,
        installerIcon: path.join(ROOT, 'electron', 'icon.ico'),
        uninstallerIcon: path.join(ROOT, 'electron', 'icon.ico'),
      },
    } : {}),
  };

  fs.writeFileSync(generatedConfig, JSON.stringify(config, null, 2), 'utf8');
}

function assertPortableBackendReady() {
  const requiredFiles = [
    '1Shell.cmd',
    'server.js',
    path.join('node', 'node.exe'),
    path.join('node_modules', 'dotenv', 'package.json'),
    path.join('node_modules', 'better-sqlite3', 'package.json'),
    path.join('frontend', 'dist', 'index.html'),
  ];

  for (const file of requiredFiles) {
    const fullPath = path.join(portableDir, file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Portable backend is incomplete, missing: ${path.relative(ROOT, fullPath)}`);
    }
  }
}

function assertElectronOutputReady(includeInstaller = buildInstaller) {
  const requiredFiles = [
    path.join(outputDir, 'win-unpacked', '1Shell.exe'),
    path.join(outputDir, 'win-unpacked', 'resources', 'backend', 'server.js'),
    path.join(outputDir, 'win-unpacked', 'resources', 'backend', 'deps', 'dotenv', 'package.json'),
    path.join(outputDir, 'win-unpacked', 'resources', 'backend', 'deps', 'better-sqlite3', 'package.json'),
  ];

  if (includeInstaller) requiredFiles.push(path.join(outputDir, `1Shell Setup ${version}.exe`));

  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Electron desktop package is incomplete, missing: ${path.relative(ROOT, file)}`);
    }
  }
}

function patchExecutableIcon() {
  const executablePath = path.join(outputDir, 'win-unpacked', '1Shell.exe');
  const iconPath = path.join(ROOT, 'electron', 'icon.ico');
  const rceditPath = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

  if (process.platform !== 'win32') return;
  if (!fs.existsSync(rceditPath)) throw new Error(`rcedit.exe not found: ${path.relative(ROOT, rceditPath)}`);

  const result = spawnSync(rceditPath, [
    executablePath,
    '--set-icon', iconPath,
    '--set-version-string', 'ProductName', '1Shell',
    '--set-version-string', 'FileDescription', '1Shell',
  ], { cwd: ROOT, stdio: 'inherit' });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Failed to patch 1Shell.exe icon');
}

function createDesktopPortableZip() {
  if (hasFlag('--no-zip')) return;

  fs.rmSync(desktopPortableDir, { recursive: true, force: true });
  fs.rmSync(desktopZipPath, { force: true });
  fs.cpSync(path.join(outputDir, 'win-unpacked'), desktopPortableDir, { recursive: true });

  const psCommand = `Compress-Archive -Path '${desktopPortableDir.replace(/'/g, "''")}\\*' -DestinationPath '${desktopZipPath.replace(/'/g, "''")}' -Force`;
  const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', psCommand], {
    cwd: releaseRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error('Desktop portable zip creation failed');
  }

  console.log(`[release] Created ${path.relative(ROOT, desktopZipPath)}`);
}

function main() {
  buildPortablePackage();
  assertPortableBackendReady();
  prepareDesktopBackend();
  prepareStagingApp();
  writeBuilderConfig();
  run('npx', ['electron-builder', '--projectDir', stagingDir, '--config', generatedConfig, '--win', '--dir']);
  assertElectronOutputReady(false);
  patchExecutableIcon();
  createDesktopPortableZip();

  if (buildInstaller) {
    run('npx', [
      'electron-builder',
      '--projectDir', stagingDir,
      '--config', generatedConfig,
      '--win', 'nsis',
      '--prepackaged', path.join(outputDir, 'win-unpacked'),
    ]);
    assertElectronOutputReady();
  }
}

main();

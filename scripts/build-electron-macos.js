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
const stagingDir = path.join(releaseRoot, 'electron-mac-app');
const desktopBackendDir = path.join(releaseRoot, 'electron-mac-backend');
const outputDir = path.join(releaseRoot, 'desktop-mac');
const generatedConfig = path.join(releaseRoot, 'electron-builder.macos.generated.json');
const macArch = optionValue('--arch') || process.env.MAC_ARCH || process.arch;

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
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...options.env };
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(relativePath, targetRelativePath = relativePath) {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) return;
  const target = path.join(desktopBackendDir, targetRelativePath);
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function copyDir(relativePath, targetRelativePath = relativePath) {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) return;
  const target = path.join(desktopBackendDir, targetRelativePath);
  fs.cpSync(source, target, { recursive: true });
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

function prepareDesktopBackend() {
  fs.rmSync(desktopBackendDir, { recursive: true, force: true });
  ensureDir(desktopBackendDir);

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
  ensureDir(path.join(desktopBackendDir, 'data'));
  ensureDir(path.join(desktopBackendDir, 'logs'));

  run('npm', ['ci', '--omit=dev'], { cwd: desktopBackendDir });
  fs.renameSync(path.join(desktopBackendDir, 'node_modules'), path.join(desktopBackendDir, 'deps'));
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

function prepareMacIcon() {
  if (process.platform !== 'darwin') return '';
  const source = path.join(ROOT, 'frontend', 'public', 'logo.png');
  const iconset = path.join(releaseRoot, '1Shell.iconset');
  const iconPath = path.join(ROOT, 'electron', 'icon.icns');
  if (!fs.existsSync(source)) return '';

  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const icons = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of icons) {
    run('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, name)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', iconPath]);
  return iconPath;
}

function writeBuilderConfig() {
  fs.mkdirSync(releaseRoot, { recursive: true });
  const macIcon = prepareMacIcon();
  const config = {
    appId: 'com.weidu12123.1shell',
    productName: '1Shell',
    artifactName: `1Shell-v${version}-mac-${macArch}.${'${ext}'}`,
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
    files: ['**/*'],
    extraResources: [
      {
        from: desktopBackendDir,
        to: 'backend',
        filter: ['**/*'],
      },
    ],
    mac: {
      target: [
        {
          target: 'dmg',
          arch: [macArch],
        },
      ],
      category: 'public.app-category.developer-tools',
      identity: null,
      hardenedRuntime: false,
      gatekeeperAssess: false,
      ...(macIcon ? { icon: macIcon } : {}),
    },
    dmg: {
      sign: false,
    },
  };

  fs.writeFileSync(generatedConfig, JSON.stringify(config, null, 2), 'utf8');
}

function assertMacOutputReady() {
  const dmgPath = path.join(outputDir, `1Shell-v${version}-mac-${macArch}.dmg`);
  if (!fs.existsSync(dmgPath)) {
    throw new Error(`macOS desktop package is incomplete, missing: ${path.relative(ROOT, dmgPath)}`);
  }
}

function main() {
  if (!['x64', 'arm64'].includes(macArch)) throw new Error(`Unsupported macOS arch: ${macArch}`);
  buildFrontend();
  assertFrontendBuilt();
  prepareDesktopBackend();
  prepareStagingApp();
  writeBuilderConfig();
  run('npx', ['electron-builder', '--projectDir', stagingDir, '--config', generatedConfig, '--mac']);
  assertMacOutputReady();
}

main();

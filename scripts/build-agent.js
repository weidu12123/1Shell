'use strict';

/**
 * Cross-compile the Go probe and relay agents for the supported targets.
 *
 * Output: agent/dist/{probe-agent,probe-relay-agent}-linux-{amd64,arm64}
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'agent');
const DIST_DIR = path.join(AGENT_DIR, 'dist');

const VERSION = process.env.AGENT_VERSION || readVersionFromPackage() || '0.1.0';

const TARGETS = [
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'linux', goarch: 'arm64' },
];

function readVersionFromPackage() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildBinary({ goos, goarch }, { name, pkg }) {
  const outName = `${name}-${goos}-${goarch}`;
  const outPath = path.join(DIST_DIR, outName);
  const ldflags = `-s -w -X main.Version=${VERSION}`;
  const args = ['build', '-trimpath', `-ldflags=${ldflags}`, '-o', outPath, pkg];

  console.log(`[build:agent] ${name} ${goos}/${goarch} -> ${path.relative(ROOT, outPath)}`);
  execFileSync('go', args, {
    cwd: AGENT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      GOOS: goos,
      GOARCH: goarch,
      CGO_ENABLED: '0',
      GOTOOLCHAIN: 'local',
    },
  });

  const size = fs.statSync(outPath).size;
  console.log(`[build:agent]   ok (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

function build(target) {
  buildBinary(target, { name: 'probe-agent', pkg: './cmd/agent' });
  buildBinary(target, { name: 'probe-relay-agent', pkg: './cmd/relay-agent' });
}

function main() {
  ensureDir(DIST_DIR);
  for (const target of TARGETS) {
    build(target);
  }
  console.log(`[build:agent] all builds done, version=${VERSION}`);
}

main();

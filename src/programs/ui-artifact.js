'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_RUNTIMES = new Set(['react-jsx']);
const SAFE_FILE_RE = /^[a-zA-Z0-9._\-/]+$/;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_SRCDOC_BYTES = 2 * 1024 * 1024;

let babelStandalone = null;

function getBabelStandalone() {
  if (babelStandalone) return babelStandalone;
  const babelPath = path.resolve(__dirname, '..', '..', 'frontend', 'node_modules', '@babel', 'standalone');
  babelStandalone = require(babelPath);
  return babelStandalone;
}

function uiRootForProgram(program) {
  if (!program?.dir) throw new Error('Program 缺少目录信息');
  return path.join(program.dir, 'ui');
}

function safeResolveUiPath(program, requestedPath) {
  const uiRoot = uiRootForProgram(program);
  const raw = String(requestedPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('\0') || raw.includes('..') || path.isAbsolute(raw) || !SAFE_FILE_RE.test(raw)) {
    throw new Error('UI artifact 路径不合法');
  }
  const target = path.resolve(uiRoot, raw);
  const root = path.resolve(uiRoot);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('UI artifact 路径越界');
  return target;
}

function readTextFile(filePath, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} 不是文件`);
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error(`${label} 超过大小限制`);
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonFile(filePath, label) {
  const text = readTextFile(filePath, label);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} JSON 解析失败: ${err.message}`);
  }
}

function loadManifest(program) {
  const filePath = safeResolveUiPath(program, 'manifest.json');
  if (!fs.existsSync(filePath)) throw new Error('ui/manifest.json 不存在');
  return readJsonFile(filePath, 'ui/manifest.json');
}

function validateManifestShape(manifest, program, issues) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    issues.push('manifest 根节点必须是对象');
    return;
  }
  if (manifest.schemaVersion !== 1) issues.push('manifest.schemaVersion 必须是 1');
  if (!SUPPORTED_RUNTIMES.has(String(manifest.runtime || ''))) issues.push(`manifest.runtime 不受支持: ${manifest.runtime || '(empty)'}`);
  if (!manifest.entry || typeof manifest.entry !== 'string') issues.push('manifest.entry 必须是字符串');
  if (manifest.styles != null && !Array.isArray(manifest.styles)) issues.push('manifest.styles 必须是数组');
  if (!manifest.design || typeof manifest.design !== 'string') issues.push('manifest.design 必须是字符串');

  const permissions = manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions : {};
  const actions = Array.isArray(permissions.actions) ? permissions.actions : [];
  for (const action of actions) {
    if (!program.actions?.[action]) issues.push(`manifest.permissions.actions 引用了不存在的 action: ${action}`);
  }
}

function validateAppSource(source, issues, warnings) {
  if (!/ReactDOM\.createRoot\s*\(/.test(source)) issues.push('App.jsx 必须调用 ReactDOM.createRoot(...) 渲染 root');
  if (!/\$oneShell\.(useProgram|runAction|getRuns|getResults|getEvents|requestL2Help|requestL3Escalation|subscribe)\b/.test(source)) {
    warnings.push('App.jsx 未发现 $oneShell bridge 调用');
  }
  const forbidden = [
    { re: /window\.parent\.document/, message: '禁止访问 window.parent.document' },
    { re: /fetch\s*\(\s*['"]\/api\//, message: '禁止直接 fetch 1Shell 私有 API' },
    { re: /\beval\s*\(/, message: '禁止使用 eval' },
    { re: /new\s+Function\b/, message: '禁止使用 new Function' },
    { re: /localStorage/, message: '禁止在 artifact 中使用 localStorage' },
  ];
  for (const item of forbidden) {
    if (item.re.test(source)) issues.push(item.message);
  }
}

function validateUiArtifact(program) {
  const issues = [];
  const warnings = [];
  let manifest = null;

  try {
    manifest = loadManifest(program);
    validateManifestShape(manifest, program, issues);
  } catch (err) {
    issues.push(err.message);
    return { ok: false, status: 'invalid', issues, warnings, manifest: null };
  }

  if (manifest.entry) {
    try {
      const entryPath = safeResolveUiPath(program, manifest.entry);
      if (!fs.existsSync(entryPath)) issues.push(`entry 文件不存在: ${manifest.entry}`);
      else validateAppSource(readTextFile(entryPath, manifest.entry), issues, warnings);
    } catch (err) {
      issues.push(err.message);
    }
  }

  for (const stylePath of manifest.styles || []) {
    try {
      const filePath = safeResolveUiPath(program, stylePath);
      if (!fs.existsSync(filePath)) issues.push(`style 文件不存在: ${stylePath}`);
    } catch (err) {
      issues.push(err.message);
    }
  }

  if (manifest.design) {
    try {
      const designPath = safeResolveUiPath(program, manifest.design);
      if (!fs.existsSync(designPath)) issues.push(`design 文件不存在: ${manifest.design}`);
    } catch (err) {
      issues.push(err.message);
    }
  }

  return { ok: issues.length === 0, status: issues.length === 0 ? 'valid' : 'invalid', issues, warnings, manifest };
}

function loadUiArtifact(program) {
  const validation = validateUiArtifact(program);
  if (!validation.manifest) return { validation, manifest: null, entry: null, styles: [], design: '' };

  const manifest = validation.manifest;
  let entry = null;
  const styles = [];
  let design = '';

  if (manifest.entry) {
    const entryPath = safeResolveUiPath(program, manifest.entry);
    if (fs.existsSync(entryPath)) entry = readTextFile(entryPath, manifest.entry);
  }
  for (const stylePath of manifest.styles || []) {
    const filePath = safeResolveUiPath(program, stylePath);
    if (fs.existsSync(filePath)) styles.push({ path: stylePath, content: readTextFile(filePath, stylePath) });
  }
  if (manifest.design) {
    const designPath = safeResolveUiPath(program, manifest.design);
    if (fs.existsSync(designPath)) design = readTextFile(designPath, manifest.design).slice(0, 12000);
  }

  return { validation, manifest, entry, styles, design };
}

function bridgeCapabilitiesFor(manifest) {
  const permissions = manifest?.permissions && typeof manifest.permissions === 'object' ? manifest.permissions : {};
  return {
    actions: Array.isArray(permissions.actions) ? permissions.actions : [],
    readRuns: permissions.readRuns === true,
    readResults: permissions.readResults === true,
    readEvents: permissions.readEvents === true,
    requestL2: permissions.requestL2 === true,
    requestL3: permissions.requestL3 === true,
  };
}

function makeCheck(name, ok, message, details = {}) {
  return { name, ok, message, details };
}

function usedBridgeMethods(source) {
  const methods = new Set();
  for (const match of String(source || '').matchAll(/\$oneShell\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g)) {
    methods.add(match[1]);
  }
  return [...methods];
}

function declaredRunActions(source) {
  const actions = new Set();
  for (const match of String(source || '').matchAll(/\$oneShell\.runAction\s*\(\s*['"]([^'"]+)['"]/g)) {
    actions.add(match[1]);
  }
  return [...actions];
}

function previewCheckUiArtifact(program) {
  const checks = [];
  const issues = [];
  const warnings = [];
  const validation = validateUiArtifact(program);

  checks.push(makeCheck('ui_artifact_check', validation.ok, validation.ok ? 'UI artifact 静态校验通过' : 'UI artifact 静态校验失败', {
    issues: validation.issues,
    warnings: validation.warnings,
  }));
  issues.push(...(validation.issues || []));
  warnings.push(...(validation.warnings || []));

  if (!validation.manifest || !validation.ok) {
    return { ok: false, status: 'failed', mode: 'sandbox-preflight', checks, issues, warnings };
  }

  const artifact = loadUiArtifact(program);
  const entry = artifact.entry || '';
  const manifest = artifact.manifest || validation.manifest;
  const capabilities = bridgeCapabilitiesFor(manifest);

  if (/^\s*(import|export)\s+/m.test(entry)) {
    issues.push('App.jsx 第一阶段不支持 ESM import/export，请使用 iframe 注入的 React/ReactDOM/window.$oneShell');
    checks.push(makeCheck('module_syntax_check', false, 'App.jsx 包含 import/export'));
  } else {
    checks.push(makeCheck('module_syntax_check', true, 'App.jsx 未使用 import/export'));
  }

  try {
    const result = getBabelStandalone().transform(entry, {
      presets: ['env', 'react'],
      filename: manifest.entry || 'App.jsx',
      sourceType: 'script',
    });
    checks.push(makeCheck('jsx_transform_check', true, 'App.jsx 可被 Babel standalone 转译', {
      outputBytes: Buffer.byteLength(result.code || '', 'utf8'),
    }));
  } catch (err) {
    const message = `App.jsx Babel 转译失败: ${err.message}`;
    issues.push(message);
    checks.push(makeCheck('jsx_transform_check', false, message));
  }

  const methods = usedBridgeMethods(entry);
  const unsupported = methods.filter((method) => !['useProgram', 'runAction', 'getRuns', 'getResults', 'getEvents', 'requestL2Help', 'requestL3Escalation', 'subscribe'].includes(method));
  if (unsupported.length) {
    const message = `App.jsx 调用了未知 bridge 方法: ${unsupported.join(', ')}`;
    issues.push(message);
    checks.push(makeCheck('bridge_method_check', false, message, { methods }));
  } else {
    checks.push(makeCheck('bridge_method_check', true, 'Bridge 方法均在宿主白名单内', { methods }));
  }

  const runActions = declaredRunActions(entry);
  const undeclaredActions = runActions.filter((action) => !capabilities.actions.includes(action) || !program.actions?.[action]);
  if (undeclaredActions.length) {
    const message = `App.jsx runAction 引用了未授权或不存在的 action: ${undeclaredActions.join(', ')}`;
    issues.push(message);
    checks.push(makeCheck('bridge_action_permission_check', false, message, { runActions, allowedActions: capabilities.actions }));
  } else {
    checks.push(makeCheck('bridge_action_permission_check', true, 'runAction 调用符合 manifest/program action 权限', { runActions, allowedActions: capabilities.actions }));
  }

  const sourceBytes = Buffer.byteLength(entry, 'utf8') + (artifact.styles || []).reduce((sum, item) => sum + Buffer.byteLength(item.content || '', 'utf8'), 0);
  if (sourceBytes > MAX_SRCDOC_BYTES) {
    const message = `sandbox srcdoc 体积超过限制: ${sourceBytes} bytes`;
    issues.push(message);
    checks.push(makeCheck('sandbox_srcdoc_size_check', false, message, { sourceBytes, maxBytes: MAX_SRCDOC_BYTES }));
  } else {
    checks.push(makeCheck('sandbox_srcdoc_size_check', true, 'sandbox srcdoc 体积在限制内', { sourceBytes, maxBytes: MAX_SRCDOC_BYTES }));
  }

  const ok = issues.length === 0;
  return { ok, status: ok ? 'passed' : 'failed', mode: 'sandbox-preflight', checks, issues, warnings };
}

function assertArtifactActionAllowed(program, actionName) {
  if (!program.actions?.[actionName]) throw new Error(`Action 不存在: ${actionName}`);
  const manifest = loadManifest(program);
  const allowed = bridgeCapabilitiesFor(manifest).actions;
  if (!allowed.includes(actionName)) throw new Error(`UI artifact 未声明 action 权限: ${actionName}`);
}

module.exports = {
  loadManifest,
  loadUiArtifact,
  validateUiArtifact,
  previewCheckUiArtifact,
  safeResolveUiPath,
  readTextFile,
  bridgeCapabilitiesFor,
  assertArtifactActionAllowed,
};

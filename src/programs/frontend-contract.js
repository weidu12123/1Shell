'use strict';

const SUPPORTED_INPUT_TYPES = new Set(['string', 'number', 'boolean', 'select', 'password', 'text']);

function validateFrontendContract(program) {
  const issues = [];
  const warnings = [];
  const actions = {};

  if (!program || typeof program !== 'object') {
    return { status: 'invalid', renderable: false, issues: ['Program 为空，无法生成 App Shell'], warnings: [], actions: {} };
  }

  const actionEntries = Object.entries(program.actions || {});
  if (!program.name) issues.push('缺少 Program 名称，Header 无法展示可读标题');
  if (actionEntries.length === 0) issues.push('缺少 actions，无法生成 Action Launcher');
  if (!program.hosts || (Array.isArray(program.hosts) && program.hosts.length === 0)) issues.push('缺少 hosts 范围，无法生成 Host Picker');

  const launchers = buildLaunchers(program, actionEntries, issues, warnings);
  const launchersByAction = new Map();
  for (const launcher of launchers) {
    if (!launchersByAction.has(launcher.action)) launchersByAction.set(launcher.action, []);
    launchersByAction.get(launcher.action).push(launcher);
  }

  const rootInputs = Array.isArray(program.inputs) ? program.inputs : [];
  const rootSecretNames = rootInputs.filter((input) => input.secret || input.type === 'password').map((input) => input.name);
  validateInputs(rootInputs, '全局 inputs', issues);

  for (const [name, action] of actionEntries) {
    const actionIssues = [];
    const actionWarnings = [];
    const inputDefs = [...rootInputs, ...(Array.isArray(action.inputs) ? action.inputs : [])];
    const secretNames = [
      ...rootSecretNames,
      ...(Array.isArray(action.inputs) ? action.inputs : [])
        .filter((input) => input.secret || input.type === 'password')
        .map((input) => input.name),
    ];

    if (!displayNameForAction(name, action, launchersByAction.get(name))) {
      actionIssues.push(`action "${name}" 缺少可展示名称`);
    }
    validateInputs(action.inputs || [], `action "${name}" inputs`, actionIssues);
    if (!launchersByAction.has(name)) actionIssues.push(`action "${name}" 没有前端入口`);
    validateDangerConfirm(name, action, launchersByAction.get(name) || [], actionIssues, actionWarnings);
    validateRenderSteps(name, action, secretNames, actionIssues);

    for (const issue of actionIssues) issues.push(issue);
    for (const warning of actionWarnings) warnings.push(warning);
    actions[name] = {
      renderable: actionIssues.length === 0,
      issues: actionIssues,
      warnings: actionWarnings,
      inputCount: inputDefs.length,
      hasRender: hasRenderStep(action),
      hasConfirm: (launchersByAction.get(name) || []).some((launcher) => !!launcher.confirm),
    };
  }

  const renderable = issues.length === 0;
  return {
    status: renderable ? 'renderable' : 'invalid',
    renderable,
    issues,
    warnings,
    actions,
  };
}

function buildLaunchers(program, actionEntries, issues, warnings) {
  const uiActions = Array.isArray(program.ui?.instance_actions) ? program.ui.instance_actions : [];
  if (uiActions.length > 0) {
    return uiActions.map((item) => ({
      id: item.id || item.action,
      label: item.label || item.action,
      action: item.action,
      style: item.style || 'default',
      confirm: item.confirm || null,
    }));
  }

  if (actionEntries.length === 1) {
    const [name, action] = actionEntries[0];
    warnings.push(`单 action Program 未声明 ui.instance_actions，已使用 action "${name}" 生成默认入口`);
    return [{ id: name, label: action.label || action.name || name, action: name, style: 'primary', confirm: null }];
  }

  if (actionEntries.length > 1) issues.push('多 action Program 必须声明 ui.instance_actions，不能依赖运行时高级选择');
  return [];
}

function validateInputs(inputs, scope, issues) {
  if (!Array.isArray(inputs)) return;
  const seen = new Set();
  for (const input of inputs) {
    const name = input?.name || '(unnamed)';
    if (seen.has(name)) issues.push(`${scope}: input "${name}" 重复`);
    seen.add(name);
    if (!input?.name) issues.push(`${scope}: 存在缺少 name 的 input`);
    if (!input?.label) issues.push(`${scope}: input "${name}" 缺少 label`);
    if (!SUPPORTED_INPUT_TYPES.has(input?.type)) issues.push(`${scope}: input "${name}" type "${input?.type || ''}" 不可渲染`);
    if (input?.type === 'select' && (!Array.isArray(input.options) || input.options.length === 0)) issues.push(`${scope}: select input "${name}" 缺少 options`);
    if (input?.type === 'number' && (input.min == null || input.max == null)) issues.push(`${scope}: number input "${name}" 必须声明 min/max`);
    if (isSecretLikeInput(input) && input.type !== 'password' && input.secret !== true) {
      issues.push(`${scope}: secret input "${name}" 必须使用 password 类型或 secret: true`);
    }
  }
}

function isSecretLikeInput(input) {
  const name = String(input?.name || '').toLowerCase();
  const label = String(input?.label || '').replace(/[（(][^）)]*[）)]/g, '').toLowerCase();
  const text = `${name} ${label}`;
  return /(^|[_\s-])(api[_\s-]?key|private[_\s-]?key|access[_\s-]?key|secret[_\s-]?key|token|secret|password|passwd|pwd)([_\s-]|$)/.test(text);
}

function validateDangerConfirm(name, action, launchers, issues, warnings) {
  const dangerousByStyle = launchers.some((launcher) => launcher.style === 'danger');
  const dangerousByName = /delete|remove|drop|destroy|kill|shutdown|reboot|restart|stop|disable|uninstall|删除|清空|销毁|停止|重启|停用|卸载/.test(`${name} ${action.label || ''} ${action.name || ''}`.toLowerCase());
  const hasConfirm = launchers.some((launcher) => !!launcher.confirm);
  if (dangerousByStyle && !hasConfirm) issues.push(`action "${name}" 是危险入口，必须声明 confirm`);
  if (!dangerousByStyle && dangerousByName && !hasConfirm) warnings.push(`action "${name}" 看起来可能是危险操作，建议声明 confirm`);
}

function validateRenderSteps(name, action, secretNames, issues) {
  const steps = Array.isArray(action.steps) ? action.steps : [];
  const renderSteps = steps.filter((step) => step.type === 'render');
  if (renderSteps.length === 0) issues.push(`action "${name}" 缺少 render step，运行成功后没有结果展示`);
  for (const step of renderSteps) {
    const leaked = findSecretReferences(step, secretNames);
    if (leaked.length > 0) issues.push(`action "${name}" render step "${step.id}" 引用了 secret input: ${[...new Set(leaked)].join(', ')}`);
  }
}

function findSecretReferences(value, secretNames) {
  const found = [];
  if (secretNames.length === 0) return found;
  const visit = (node) => {
    if (node == null) return;
    if (typeof node === 'string') {
      for (const name of secretNames) {
        const re = new RegExp(`\\{\\{\\s*inputs\\.${escapeRegExp(name)}\\s*\\}\\}`);
        if (re.test(node)) found.push(name);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'object') {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return found;
}

function displayNameForAction(name, action, launchers) {
  return action.label || action.name || (launchers || []).find((launcher) => launcher.action === name)?.label || '';
}

function hasRenderStep(action) {
  return Array.isArray(action.steps) && action.steps.some((step) => step.type === 'render');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { validateFrontendContract };

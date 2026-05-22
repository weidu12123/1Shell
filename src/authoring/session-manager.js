'use strict';

const AUTHORING_STAGES = [
  'discovery',
  'options',
  'spec',
  'plan',
  'draft',
  'review',
  'commit',
  'verify',
  'done',
  'blocked',
];

const PRE_COMMIT_BLOCKED_TOOLS = new Set([
  'write_file',
  'reload_registry',
  'trigger_program',
]);

const CREATE_WORDS = ['创建', '创作', '新建', '生成', '编写', '写一个', '做一个', '设计一个', 'create', 'generate', 'build', 'write'];
const EDIT_WORDS = ['修改', '更新', '改造', '重构', '编辑', '调整', 'edit', 'update', 'modify', 'refactor'];
const PROGRAM_WORDS = ['program', '程序', 'data/programs', 'program.yaml'];
const SKILL_WORDS = ['skill', '技能', 'data/skills', 'skill.md'];
const BUNDLE_WORDS = ['bundle', '套件', '程序和skill', 'program + skill', 'program/skill'];

const COMPLEX_SIGNALS = [
  '多步', '完整链路', '自动化', '远程主机', 'vps', 'ssh', '输入字段', '前端需要',
  '凭据', '密钥', 'token', 'api key', 'apikey', 'secret', '证书', 'ssl', 'https', 'acme', 'certbot',
  'cloudflare', 'dns', '反向代理', '反代', 'nginx', 'caddy', 'traefik', '/etc', '/var',
  'reload', 'restart', '重载', '重启', 'service', 'systemctl', '防火墙', 'firewall', '数据库', 'database',
  '安装包', 'apt', 'yum', 'dnf', 'docker', 'l2', 'l3', 'guardian',
];

const HIGH_RISK_SIGNALS = [
  '证书', 'ssl', 'https', 'cloudflare', 'dns', '反向代理', '反代', 'nginx', 'caddy', 'traefik',
  '凭据', '密钥', 'token', 'api key', 'apikey', 'secret', '/etc', 'reload', 'restart', '重载',
  '重启', 'service', 'systemctl', '防火墙', 'firewall', '删除', 'rm ', '数据库', 'database',
];

const STAGE_SUGGESTIONS = {
  discovery: ['query_format', 'list_artifacts', 'read_file', 'list_hosts', 'ask_authoring_question', 'propose_options'],
  options: ['propose_options', 'ask_authoring_question'],
  spec: ['create_program_spec', 'create_skill_spec', 'query_format', 'list_artifacts', 'read_file'],
  plan: ['create_authoring_plan', 'query_format', 'list_artifacts', 'read_file'],
  draft: ['create_program_draft', 'create_skill_draft', 'validate_program_draft', 'validate_skill_draft', 'query_format', 'list_artifacts', 'read_file'],
  review: ['request_commit_approval'],
  commit: ['commit_authoring_artifact'],
  verify: ['verify_authoring_artifact'],
  blocked: ['解释阻塞原因并请求用户选择下一步'],
};

function now() {
  return Date.now();
}

function makeId(prefix = 'auth') {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word.toLowerCase()));
}

function collectSignals(text, words) {
  return words.filter((word) => text.includes(word.toLowerCase()));
}

function isBriefConfirmation(message) {
  const text = normalizeText(message).trim();
  if (!text) return false;
  return /按你的来|按推荐方案|按推荐|推荐方案创建|确认|可以|继续|好的|没问题|就这样|同意|approve|approved|go ahead|proceed|continue|ok\b|yes\b/i.test(text);
}

function resolveSource(entry) {
  const value = normalizeText(entry);
  if (value === 'studio' || value === 'authoring' || value === 'skill-studio') return 'studio';
  if (value === 'global-ai' || value === 'global') return 'global-ai';
  return 'oneshell-ai';
}

function detectAuthoringIntent(message, context = {}, entry) {
  const text = normalizeText(message);
  const source = resolveSource(entry);
  const hasCreate = hasAny(text, CREATE_WORDS);
  const hasEdit = hasAny(text, EDIT_WORDS);
  const hasProgram = hasAny(text, PROGRAM_WORDS);
  const hasSkill = hasAny(text, SKILL_WORDS);
  const hasBundle = hasAny(text, BUNDLE_WORDS);
  const complexSignals = collectSignals(text, COMPLEX_SIGNALS);
  const highRiskSignals = collectSignals(text, HIGH_RISK_SIGNALS);
  const selectedSkills = Array.isArray(context?.skills) && context.skills.length > 0;

  let intent = 'unknown';
  const skillCreateRequest = hasCreate && /(?:创建|创作|新建|生成|编写|写一个|做一个|create|generate|build|write)[\s\S]{0,24}(?:skill|技能)/i.test(text);
  const programCreateRequest = hasCreate && /(?:创建|创作|新建|生成|编写|写一个|做一个|create|generate|build|write)[\s\S]{0,24}(?:program|程序)/i.test(text);
  if (hasBundle) intent = hasCreate ? 'create_bundle' : 'unknown';
  else if (skillCreateRequest) intent = 'create_skill';
  else if (programCreateRequest || (hasProgram && hasCreate)) intent = 'create_program';
  else if (hasSkill && hasCreate) intent = 'create_skill';
  else if (hasProgram && hasEdit) intent = 'edit_program';
  else if (hasSkill && hasEdit) intent = 'edit_skill';
  else if (source === 'studio' && hasCreate && hasAny(text, ['自动化', '产物', 'workflow', '流程'])) intent = 'create_program';

  const studioProductRequest = source === 'studio'
    && intent === 'unknown'
    && complexSignals.length >= 2
    && hasAny(text, ['我需要', '需要', '想要', '类似', '功能', '面板', '管理', '工作台', '选择', '保存', '启用', '一键']);
  if (studioProductRequest) intent = 'create_program';

  const createsArtifact = ['create_program', 'create_skill', 'create_bundle'].includes(intent);
  const editsArtifact = ['edit_program', 'edit_skill'].includes(intent);
  const complexAutomationRequest = hasCreate && complexSignals.length > 0 && hasAny(text, ['自动化', '链路', '流程', 'program', '程序', 'skill', '技能']);
  const shouldStart = createsArtifact || editsArtifact || complexAutomationRequest;

  let complexity = 'simple';
  if (createsArtifact || complexSignals.length > 0 || selectedSkills) complexity = 'complex';
  else if (editsArtifact) complexity = 'moderate';

  let risk = 'low';
  if (highRiskSignals.length > 0) risk = 'high';
  else if (complexity === 'complex' || editsArtifact) risk = 'medium';

  return {
    shouldStart,
    intent: complexAutomationRequest && intent === 'unknown' ? 'create_program' : intent,
    complexity,
    risk,
    source,
    signals: [...new Set(complexSignals.concat(highRiskSignals))],
  };
}

function serializeAuthoringSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    intent: session.intent,
    stage: session.stage,
    complexity: session.complexity,
    risk: session.risk,
    source: session.source,
    refinedMode: session.refinedMode === true,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    userGoal: session.userGoal,
    facts: session.facts,
    choices: session.choices,
    artifacts: session.artifacts,
    interactions: session.interactions,
    approvals: session.approvals,
    blockedTools: session.blockedTools,
  };
}

function createAuthoringSession({ ideSessionId, message, context, entry, detected, refinedMode }) {
  const timestamp = now();
  return {
    id: makeId(),
    ideSessionId,
    intent: detected.intent,
    stage: 'discovery',
    complexity: detected.complexity,
    risk: detected.risk,
    source: detected.source,
    refinedMode: refinedMode === true,
    createdAt: timestamp,
    updatedAt: timestamp,
    userGoal: String(message || '').trim(),
    facts: {
      initialContext: {
        hostCount: Array.isArray(context?.hosts) ? context.hosts.length : 0,
        fileCount: Array.isArray(context?.files) ? context.files.length : 0,
        selectedSkillCount: Array.isArray(context?.skills) ? context.skills.length : 0,
      },
      triggerSignals: detected.signals,
      requirementBrief: refinedMode === true ? { status: 'pending' } : null,
    },
    choices: [],
    artifacts: [],
    interactions: [],
    approvals: {},
    blockedTools: [],
  };
}

class AuthoringSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  ensureForMessage({ ideSessionId, message, context, entry, refinedMode }) {
    const existing = this.sessions.get(ideSessionId);
    if (existing && !['done', 'blocked'].includes(existing.stage)) {
      const enabled = refinedMode === true;
      existing.refinedMode = enabled;
      if (enabled && !existing.facts.requirementBrief) {
        existing.facts.requirementBrief = { status: 'pending' };
      }
      if (enabled && existing.facts.requirementBrief?.status === 'pending' && isBriefConfirmation(message)) {
        existing.facts.requirementBrief.status = 'confirmed';
        existing.facts.requirementBrief.confirmedAt = now();
      }
      existing.updatedAt = now();
      return existing;
    }

    const detected = detectAuthoringIntent(message, context, entry);
    if (!detected.shouldStart) return null;

    const session = createAuthoringSession({ ideSessionId, message, context, entry, detected, refinedMode });
    this.sessions.set(ideSessionId, session);
    return session;
  }

  getByIdeSessionId(ideSessionId) {
    return this.sessions.get(ideSessionId) || null;
  }

  deleteByIdeSessionId(ideSessionId) {
    this.sessions.delete(ideSessionId);
  }
}

function isAuthoringActive(session) {
  return !!session && !['done', 'blocked'].includes(session.stage);
}

function needsRequirementBrief(session) {
  return isAuthoringActive(session)
    && session.refinedMode === true
    && session.facts?.requirementBrief?.status !== 'confirmed';
}

function getAllowedToolsForStage(stage) {
  switch (stage) {
    case 'discovery':
      return new Set(['query_format', 'list_artifacts', 'read_file', 'list_hosts', 'ask_authoring_question', 'propose_options', 'read_skill_file']);
    case 'options':
      return new Set(['propose_options', 'ask_authoring_question', 'create_authoring_note', 'query_format', 'list_artifacts', 'read_file']);
    case 'spec':
      return new Set(['create_program_spec', 'create_skill_spec', 'update_program_spec', 'request_spec_approval', 'query_format', 'list_artifacts', 'read_file']);
    case 'plan':
      return new Set(['create_authoring_plan', 'update_authoring_plan', 'request_plan_approval', 'query_format', 'list_artifacts', 'read_file']);
    case 'draft':
      return new Set(['create_program_draft', 'create_skill_draft', 'validate_program_draft', 'validate_skill_draft', 'update_authoring_draft', 'query_format', 'list_artifacts', 'read_file']);
    case 'review':
      return new Set(['request_commit_approval', 'update_authoring_draft', 'validate_program_draft', 'validate_skill_draft', 'query_format', 'list_artifacts', 'read_file']);
    case 'commit':
      return new Set(['commit_authoring_artifact', 'query_format', 'list_artifacts', 'read_file']);
    case 'verify':
      return new Set(['verify_authoring_artifact', 'reload_registry', 'list_artifacts', 'trigger_program', 'query_format', 'read_file']);
    case 'done':
      return new Set(['list_artifacts', 'read_file', 'query_format']);
    default:
      return new Set(['query_format', 'list_artifacts', 'read_file', 'list_hosts']);
  }
}

function normalizeOptions(options) {
  return Array.isArray(options) ? options.map((option, index) => ({
    id: String(option?.id || `option-${index + 1}`).trim(),
    label: String(option?.label || option?.summary || `选项 ${index + 1}`).trim(),
    description: option?.description ? String(option.description) : '',
    summary: option?.summary ? String(option.summary) : '',
    pros: Array.isArray(option?.pros) ? option.pros.map(String) : [],
    cons: Array.isArray(option?.cons) ? option.cons.map(String) : [],
    risk: ['low', 'medium', 'high'].includes(String(option?.risk || '')) ? String(option.risk) : 'medium',
    recommended: option?.recommended === true,
  })).filter((option) => option.id && option.label) : [];
}

function recordAuthoringQuestion(session, input = {}) {
  if (!isAuthoringActive(session)) return null;
  const question = String(input.question || '').trim();
  if (!question) return null;
  const kind = ['single_choice', 'multi_choice', 'text', 'confirm'].includes(String(input.kind || '')) ? String(input.kind) : 'text';
  const interaction = {
    id: makeId('q'),
    sessionId: session.id,
    kind: 'question',
    question,
    questionKind: kind,
    options: normalizeOptions(input.options),
    required: input.required !== false,
    createdAt: now(),
    answered: false,
  };
  session.interactions.push(interaction);
  session.updatedAt = interaction.createdAt;
  return interaction;
}

function recordAuthoringOptions(session, input = {}) {
  if (!isAuthoringActive(session)) return null;
  const options = normalizeOptions(input.options);
  if (options.length < 2) return null;
  const interaction = {
    id: makeId('opt'),
    sessionId: session.id,
    kind: 'options',
    title: String(input.title || '请选择创作方案').trim(),
    description: String(input.description || '').trim(),
    options,
    required: true,
    createdAt: now(),
    answered: false,
  };
  session.interactions.push(interaction);
  session.stage = 'options';
  session.updatedAt = interaction.createdAt;
  return interaction;
}

function recordCommitApprovalRequest(session, input = {}) {
  if (!isAuthoringActive(session)) return null;
  const artifactId = String(input.artifactId || '').trim();
  if (!artifactId) return null;
  const files = Array.isArray(input.files) ? input.files.map((file) => ({
    path: String(file?.path || '').trim(),
    bytes: Number(file?.bytes || 0),
  })).filter((file) => file.path) : [];
  if (files.length === 0) return null;
  const dangerousActions = Array.isArray(input.dangerousActions) ? input.dangerousActions.map(String).filter(Boolean) : [];
  const irreversibleActions = Array.isArray(input.irreversibleActions) ? input.irreversibleActions.map(String).filter(Boolean) : [];
  const approveLabel = String(input.approveLabel || '确认写入创作产物文件').trim();
  const approveSummary = String(input.approveSummary || '只写入当前 Draft artifact 声明的文件').trim();
  const interaction = {
    id: makeId('commit'),
    sessionId: session.id,
    kind: 'commit_approval',
    title: String(input.title || '确认写入创作产物').trim(),
    description: String(input.description || '批准后只会写入本卡片列出的 draft 文件。').trim(),
    summary: String(input.summary || '').trim(),
    artifactId,
    files,
    dangerousActions,
    irreversibleActions,
    validation: input.validation || null,
    options: [
      { id: 'approve', label: approveLabel, summary: approveSummary },
      { id: 'reject', label: '暂不写入', summary: '保留草案，回到 review 继续修改' },
    ],
    required: true,
    createdAt: now(),
    answered: false,
  };
  session.interactions.push(interaction);
  session.stage = 'review';
  session.approvals.commit = false;
  delete session.approvals.commitArtifactId;
  session.updatedAt = interaction.createdAt;
  return interaction;
}

function recordAuthoringReply(session, input = {}) {
  if (!isAuthoringActive(session)) return null;
  const interactionId = String(input.interactionId || '').trim();
  const value = Array.isArray(input.value) ? input.value.map(String) : String(input.value || '').trim();
  const text = String(input.text || '').trim();
  const interaction = session.interactions.find((item) => item.id === interactionId);
  if (!interaction || interaction.answered) return null;

  interaction.answered = true;
  interaction.answer = { value, text, at: now() };
  session.choices.push({ interactionId, kind: interaction.kind, value, text, at: interaction.answer.at });
  if (interaction.kind === 'options') {
    session.approvals.options = true;
    session.stage = 'spec';
  } else if (interaction.kind === 'commit_approval') {
    const approved = Array.isArray(value) ? value.includes('approve') : value === 'approve';
    session.approvals.commit = approved;
    if (approved) {
      session.approvals.commitArtifactId = interaction.artifactId;
      session.stage = 'commit';
    } else {
      delete session.approvals.commitArtifactId;
      session.stage = 'review';
    }
  } else if (session.stage === 'discovery') {
    session.stage = 'options';
  }
  session.updatedAt = interaction.answer.at;
  return interaction;
}

function latestArtifact(session, type) {
  const artifacts = session?.artifacts || [];
  for (let i = artifacts.length - 1; i >= 0; i--) {
    if (!type || artifacts[i].type === type) return artifacts[i];
  }
  return null;
}

function recordAuthoringArtifact(session, artifact) {
  if (!isAuthoringActive(session)) return null;
  const type = String(artifact?.type || '').trim();
  if (!type) return null;
  const item = {
    id: makeId(type),
    type,
    title: String(artifact.title || type).trim(),
    createdAt: now(),
    updatedAt: now(),
    status: artifact.status || 'draft',
    data: artifact.data || {},
    warnings: Array.isArray(artifact.warnings) ? artifact.warnings.map(String) : [],
    dangerousActions: Array.isArray(artifact.dangerousActions) ? artifact.dangerousActions.map(String) : [],
    validation: artifact.validation || null,
  };
  session.artifacts.push(item);
  session.updatedAt = item.updatedAt;
  if (type === 'program_spec' || type === 'skill_spec') session.stage = 'plan';
  if (type === 'authoring_plan') session.stage = 'draft';
  if (type === 'program_draft' || type === 'skill_draft') session.stage = item.validation?.ok === false ? 'draft' : 'review';
  if (type === 'authoring_verification') session.stage = item.status === 'passed' ? 'done' : 'draft';
  return item;
}

function updateAuthoringArtifact(session, artifactId, patch = {}) {
  if (!isAuthoringActive(session)) return null;
  const artifact = (session.artifacts || []).find((item) => item.id === artifactId);
  if (!artifact) return null;
  artifact.updatedAt = now();
  if (patch.status) artifact.status = patch.status;
  if (patch.data) artifact.data = { ...artifact.data, ...patch.data };
  if (patch.warnings) artifact.warnings = patch.warnings.map(String);
  if (patch.dangerousActions) artifact.dangerousActions = patch.dangerousActions.map(String);
  if (patch.validation) artifact.validation = patch.validation;
  session.updatedAt = artifact.updatedAt;
  return artifact;
}

function formatBlockedToolMessage(session, toolName) {
  const stage = session?.stage || 'unknown';
  const suggestions = STAGE_SUGGESTIONS[stage] || STAGE_SUGGESTIONS.discovery;
  return `[BLOCKED] 当前 Authoring Session 处于 ${stage} 阶段，不能调用 ${toolName}。请继续使用 ${suggestions.join('、')}。commit approval 前禁止写文件、reload registry 或触发 Program。`;
}

function requiredAuthoringToolsForStage(session) {
  if (!isAuthoringActive(session)) return [];
  switch (session.stage) {
    case 'spec':
      if (session.intent === 'create_skill' || session.intent === 'edit_skill') return ['create_skill_spec'];
      if (session.intent === 'create_bundle') return ['create_program_spec'];
      return ['create_program_spec'];
    case 'plan':
      return ['create_authoring_plan'];
    case 'draft':
      if (session.intent === 'create_skill' || session.intent === 'edit_skill') return ['create_skill_draft'];
      if (session.intent === 'create_bundle') return ['create_program_draft'];
      return ['create_program_draft'];
    case 'commit':
      return ['commit_authoring_artifact'];
    case 'verify':
      return ['verify_authoring_artifact'];
    default:
      return [];
  }
}

function requiredAuthoringToolMessage(session) {
  const required = requiredAuthoringToolsForStage(session);
  if (required.length === 0) return '';
  const stage = session.stage;
  const toolList = required.join(' 或 ');
  const intentHint = session.intent === 'create_bundle'
    ? 'Bundle 当前先创建 Program artifact；companion Skill 后续按 Skill artifact 继续补齐。'
    : '';
  return `[AUTHORING_STAGE_VIOLATION] 当前处于 ${stage} 阶段，不能只输出普通文本。必须立即调用 ${toolList} 创建结构化 artifact/interaction；不要用 Markdown 草案冒充 artifact。${intentHint}`;
}

function gateAuthoringTool(authoringSession, toolName) {
  if (!isAuthoringActive(authoringSession)) return null;

  if (needsRequirementBrief(authoringSession) && !['query_format', 'list_artifacts', 'read_file', 'list_hosts'].includes(toolName)) {
    const blocked = {
      toolName,
      stage: authoringSession.stage,
      at: now(),
      reason: 'requirement_brief_required',
    };
    authoringSession.updatedAt = blocked.at;
    authoringSession.blockedTools.push(blocked);
    return {
      content: '[BLOCKED] 精修模式已开启，当前必须先输出结构化 Brief，并等待用户确认或回复“按你的来”。确认前不能调用创作 artifact、方案、提交或执行类工具。',
      is_error: true,
    };
  }

  const allowedTools = getAllowedToolsForStage(authoringSession.stage);
  const blockedBeforeCommit = PRE_COMMIT_BLOCKED_TOOLS.has(toolName) && !authoringSession.approvals?.commit;
  const blockedByStage = allowedTools && !allowedTools.has(toolName);

  if (!blockedBeforeCommit && !blockedByStage) return null;

  const blocked = {
    toolName,
    stage: authoringSession.stage,
    at: now(),
  };
  authoringSession.updatedAt = blocked.at;
  authoringSession.blockedTools.push(blocked);

  return {
    content: formatBlockedToolMessage(authoringSession, toolName),
    is_error: true,
  };
}

function createAuthoringPromptBlock(authoringSession) {
  if (!isAuthoringActive(authoringSession)) return '';
  const suggestions = STAGE_SUGGESTIONS[authoringSession.stage] || STAGE_SUGGESTIONS.discovery;
  const briefPending = needsRequirementBrief(authoringSession);
  return [
    '<authoring-session>',
    `id: ${authoringSession.id}`,
    `intent: ${authoringSession.intent}`,
    `stage: ${authoringSession.stage}`,
    `complexity: ${authoringSession.complexity}`,
    `risk: ${authoringSession.risk}`,
    `source: ${authoringSession.source}`,
    `refinedMode: ${authoringSession.refinedMode === true ? 'on' : 'off'}`,
    `requirementBrief: ${authoringSession.facts?.requirementBrief?.status || 'off'}`,
    ...(briefPending ? [
      'refined_mode_required_first_step:',
      '- 精修模式已开启，本轮首要任务是把用户原始需求扩写成结构化 Brief；不要调用 create_program_draft、create_skill_draft、create_program_spec、create_skill_spec、create_authoring_plan、propose_options、request_commit_approval 或 commit_authoring_artifact。',
      '- Brief 必须直接输出给用户，并以“如果认可，请回复：按你的来；我再进入 spec / plan / draft / review / commit / verify。”结尾。',
      '- Brief 至少包含：原始需求、Program/Skill 定位、用户操作流程、主机选择方式、输入字段与类型、secret 处理、安全边界、UI 质量目标、成功结果展示、失败/L2/L3 路径、artifact gate 校验清单。',
      '- Program UI 质量目标必须写明：禁止让用户手填 raw hostId；使用 1Shell 主机上下文/选择器，展示可读主机名、地址、用户或标签；不能生成薄表单，要有空状态、运行中、成功、失败、结果区和 AI 修复入口。',
    ] : [
      '- 如果 refinedMode=on 且 requirementBrief=confirmed，后续 spec / plan / draft 必须基于上文已确认 Brief 推进。',
    ]),
    'hard_rules:',
    '- 当前已进入 1Shell Authoring Session，必须按 discovery -> options -> spec -> plan -> draft -> review -> commit -> verify 分阶段推进。',
    '- commit approval 前禁止调用 write_file、reload_registry、trigger_program。',
    '- commit approval 后只能用 commit_authoring_artifact 写入草案声明的文件；不要改用 write_file 绕过。',
    '- commit 后必须用 verify_authoring_artifact 生成验证结果；验证失败会回到 draft/review 修复链路。',
    '- 使用 ask_authoring_question 提出单个关键问题，使用 propose_options 给出 2-3 个方案卡片。',
    '- 用户选择方案后才能进入 spec；不要用文本绕过结构化交互。',
    '- spec 阶段必须调用 create_program_spec 或 create_skill_spec；plan 阶段必须调用 create_authoring_plan；draft 阶段必须调用 create_program_draft 或 create_skill_draft。',
    '- 普通 Markdown 的“Spec 草案 / Plan / Draft”不算 artifact；如果需要展示草案，先调用对应 artifact tool。',
    ...(authoringSession.stage === 'draft' && (authoringSession.intent === 'create_program' || authoringSession.intent === 'edit_program' || authoringSession.intent === 'create_bundle') ? [
      'program_draft_gate_must_pass:',
      '- App.jsx 末尾必须使用 ReactDOM.createRoot(document.getElementById(\'root\')).render(...)，禁止使用 ReactDOM.render。',
      '- App.jsx 必须直接出现 window.$oneShell.useProgram() 或 window.$oneShell.runAction(...)；不要只赋值 const bridge = window.$oneShell 后用 bridge.runAction，因为 gate 按源码扫描 $oneShell。',
      '- 执行动作必须写成 window.$oneShell.runAction(\'<action_name>\', { hostId, inputs })；action_name 必须是字符串字面量，并同时存在于 program.yaml 和 manifest.permissions.actions。',
      '- create_program_draft 前自检 validation 目标必须为 ok；如果上一版草案 validation 失败，只重发修复后的完整 draft artifact，不要进入 review/commit。',
    ] : []),
    `next_allowed_actions: ${suggestions.join('、')}`,
    `required_tool_now: ${requiredAuthoringToolsForStage(authoringSession).join(' 或 ') || '(none)'}`,
    '</authoring-session>',
    '',
  ].join('\n');
}

module.exports = {
  AUTHORING_STAGES,
  PRE_COMMIT_BLOCKED_TOOLS,
  AuthoringSessionManager,
  createAuthoringPromptBlock,
  detectAuthoringIntent,
  gateAuthoringTool,
  latestArtifact,
  requiredAuthoringToolMessage,
  requiredAuthoringToolsForStage,
  recordAuthoringArtifact,
  recordAuthoringOptions,
  recordAuthoringQuestion,
  recordAuthoringReply,
  recordCommitApprovalRequest,
  serializeAuthoringSession,
  updateAuthoringArtifact,
};

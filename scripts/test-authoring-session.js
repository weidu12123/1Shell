'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../src/config/env');
const { createIdeTools } = require('../src/ide/ide.tools');
const {
  AuthoringSessionManager,
  detectAuthoringIntent,
  gateAuthoringTool,
  recordAuthoringArtifact,
  recordAuthoringOptions,
  recordAuthoringQuestion,
  recordAuthoringReply,
  recordCommitApprovalRequest,
  requiredAuthoringToolMessage,
  requiredAuthoringToolsForStage,
} = require('../src/authoring/session-manager');

async function main() {
  const certRequest = '创建一个程序，其功能是申请证书，完整链路是先扫描已反向代理后的端口，然后给它们安装证书。前端需要端口、域名、Cloudflare API key、是否开启 https。';

  const detected = detectAuthoringIntent(certRequest, {}, 'studio');
  assert.strictEqual(detected.shouldStart, true, '证书 Program 请求必须触发 Authoring Flow');
  assert.strictEqual(detected.intent, 'create_program', '证书 Program 请求必须识别为 create_program');
  assert.strictEqual(detected.complexity, 'complex', '证书 Program 请求必须识别为 complex');
  assert.strictEqual(detected.risk, 'high', '证书 Program 请求必须识别为 high risk');

  const studioWordingRequest = '创作一个程序，功能是证书申请，在前端中填入cloudflare里面的域名，cloudflare apikey，填入对应的端口，选择对应的主机，然后开始申请证书，申请失败时唤起ai来进行处理';
  const studioWordingDetected = detectAuthoringIntent(studioWordingRequest, {}, 'studio');
  assert.strictEqual(studioWordingDetected.shouldStart, true, '创作一个程序必须触发 Authoring Flow');
  assert.strictEqual(studioWordingDetected.intent, 'create_program', '创作一个程序必须识别为 create_program');
  const studioWordingSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-studio-wording', message: studioWordingRequest, context: {}, entry: 'studio' });
  assert(studioWordingSession, '创作台自然用语必须创建 Authoring Session');

  const manager = new AuthoringSessionManager();
  const session = manager.ensureForMessage({ ideSessionId: 'sess-test', message: certRequest, context: {}, entry: 'studio' });
  assert(session, '必须创建 Authoring Session');
  assert.strictEqual(session.stage, 'discovery', '新 Authoring Session 必须从 discovery 开始');

  const readAllowed = gateAuthoringTool(session, 'list_hosts');
  assert.strictEqual(readAllowed, null, 'discovery 阶段必须允许 list_hosts');

  for (const toolName of ['write_file', 'reload_registry', 'trigger_program', 'execute_command']) {
    const blocked = gateAuthoringTool(session, toolName);
    assert(blocked?.is_error, `${toolName} 必须在 discovery 阶段被阻断`);
    assert(blocked.content.includes(`[BLOCKED] 当前 Authoring Session 处于 discovery 阶段，不能调用 ${toolName}。`), `${toolName} 阻断文案必须清晰`);
  }

  const questionAllowed = gateAuthoringTool(session, 'ask_authoring_question');
  assert.strictEqual(questionAllowed, null, 'discovery 阶段必须允许 ask_authoring_question');
  const question = recordAuthoringQuestion(session, {
    question: '目标反代服务是什么？',
    kind: 'single_choice',
    options: [
      { id: 'nginx', label: 'nginx' },
      { id: 'caddy', label: 'caddy' },
    ],
  });
  assert(question, '必须能创建 question interaction');
  assert.strictEqual(session.interactions.length, 1, 'question 必须写入 session interactions');
  const options = recordAuthoringOptions(session, {
    title: '请选择自动化边界',
    description: '证书申请涉及凭据和服务 reload。',
    options: [
      { id: 'safe', label: '只申请证书', summary: '不改反代配置', risk: 'low' },
      { id: 'auto', label: '全自动', summary: '写配置并 reload', risk: 'high' },
    ],
  });
  assert(options, '必须能创建 options interaction');
  assert.strictEqual(session.stage, 'options', 'propose_options 后必须进入 options 阶段');
  const reply = recordAuthoringReply(session, { interactionId: options.id, value: 'safe', text: '我选择保守方案' });
  assert(reply, '必须能记录用户选择');
  assert.strictEqual(session.approvals.options, true, '选择方案后 options 必须批准');
  assert.strictEqual(session.stage, 'spec', '选择方案后必须推进到 spec 阶段');
  assert.deepStrictEqual(requiredAuthoringToolsForStage(session), ['create_program_spec'], 'Program spec 阶段必须要求 create_program_spec');
  assert(requiredAuthoringToolMessage(session).includes('不能只输出普通文本'), 'spec 阶段违规提示必须禁止 Markdown 冒充 artifact');

  const specAllowed = gateAuthoringTool(session, 'create_program_spec');
  assert.strictEqual(specAllowed, null, 'spec 阶段必须允许 create_program_spec');
  const spec = recordAuthoringArtifact(session, {
    type: 'program_spec',
    title: '反代端口证书申请',
    data: { programId: 'reverse-proxy-cert', goal: '申请证书' },
  });
  assert(spec, '必须能创建 Program Spec artifact');
  assert.strictEqual(session.stage, 'plan', '创建 spec 后必须推进到 plan 阶段');

  const planAllowed = gateAuthoringTool(session, 'create_authoring_plan');
  assert.strictEqual(planAllowed, null, 'plan 阶段必须允许 create_authoring_plan');
  const plan = recordAuthoringArtifact(session, {
    type: 'authoring_plan',
    title: '证书 Program 实施计划',
    data: { tasks: [{ id: 'draft', title: '生成草案' }] },
  });
  assert(plan, '必须能创建 Authoring Plan artifact');
  assert.strictEqual(session.stage, 'draft', '创建 plan 后必须推进到 draft 阶段');
  assert.deepStrictEqual(requiredAuthoringToolsForStage(session), ['create_program_draft'], 'Program draft 阶段必须要求 create_program_draft');

  const draftAllowed = gateAuthoringTool(session, 'create_program_draft');
  assert.strictEqual(draftAllowed, null, 'draft 阶段必须允许 create_program_draft');
  const validProgramYaml = `name: 反代端口证书申请
description: 测试 Program 草案
enabled: false
hosts: all
l2:
  skill: program-maintenance
triggers:
  - id: manual_run
    type: manual
    action: issue_certificate
actions:
  issue_certificate:
    on_fail: repair
    steps:
      - id: check_target
        label: 检查目标
        run: echo ok
        verify:
          exit_code: 0
          stdout_contains: ok
      - id: render_result
        type: render
        format: message
        title: 结果
        content_from: check_target
`;
  function createApprovedProgramCommitSession(programId, filePath, content = validProgramYaml) {
    const commitSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: `sess-${programId}`, message: `创建 Program ${programId}`, context: {}, entry: 'studio' });
    commitSession.stage = 'draft';
    const commitDraft = recordAuthoringArtifact(commitSession, {
      type: 'program_draft',
      title: programId,
      data: {
        programId,
        files: [{ path: filePath, content }],
      },
      validation: { ok: true, errors: [], warnings: [] },
    });
    const approval = recordCommitApprovalRequest(commitSession, {
      artifactId: commitDraft.id,
      summary: 'test commit',
      files: [{ path: filePath, bytes: Buffer.byteLength(content, 'utf8') }],
      validation: { ok: true, errors: [], warnings: [] },
    });
    recordAuthoringReply(commitSession, { interactionId: approval.id, value: 'approve', text: '确认创建 Program 并写入文件' });
    return { commitSession, commitDraft };
  }

  const draft = recordAuthoringArtifact(session, {
    type: 'program_draft',
    title: 'reverse-proxy-cert',
    data: { files: [{ path: 'data/programs/reverse-proxy-cert/program.yaml', content: validProgramYaml }] },
  });
  assert(draft, '必须能创建 Program Draft artifact');
  assert.strictEqual(session.stage, 'review', '创建 draft 后必须推进到 review 阶段');
  const stillBlocked = gateAuthoringTool(session, 'write_file');
  assert(stillBlocked?.is_error, 'review 阶段未批准 commit 仍不能 write_file');

  const skillDetected = detectAuthoringIntent('创建一个 Skill，用来生成 Program。', {}, 'studio');
  assert.strictEqual(skillDetected.shouldStart, true, 'Skill 创建请求必须触发 Authoring Flow');
  assert.strictEqual(skillDetected.intent, 'create_skill', 'Skill 创建请求必须识别为 create_skill');

  const bundleSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-bundle-artifact', message: '创建 Bundle smoke-bundle-e2e', context: {}, entry: 'studio' });
  bundleSession.stage = 'spec';
  assert.deepStrictEqual(requiredAuthoringToolsForStage(bundleSession), ['create_program_spec'], 'Bundle spec 阶段必须先要求 Program spec artifact');
  assert(requiredAuthoringToolMessage(bundleSession).includes('Bundle 当前先创建 Program artifact'), 'Bundle 阶段违规提示必须说明当前先创建 Program artifact');

  const testSkillId = `__authoring-skill-test-${Date.now()}`;
  const testSkillDir = path.join(ROOT_DIR, 'data', 'skills', testSkillId);
  try {
    let skillReloadedForSkill = false;
    let skillLoadedForSkill = false;
    const skillSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-skill-artifact', message: `创建 Skill ${testSkillId}`, context: {}, entry: 'studio' });
    skillSession.stage = 'spec';
    assert.deepStrictEqual(requiredAuthoringToolsForStage(skillSession), ['create_skill_spec'], 'Skill spec 阶段必须要求 create_skill_spec');
    assert.strictEqual(gateAuthoringTool(skillSession, 'create_skill_spec'), null, 'spec 阶段必须允许 create_skill_spec');
    const skillTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: {
        reload: () => { skillReloadedForSkill = true; skillLoadedForSkill = true; return 1; },
        getSkill: (id) => (skillLoadedForSkill && id === testSkillId ? { id, name: 'Authoring Skill Test' } : null),
        listSkills: () => [],
        listPlaybooks: () => [],
      },
      programEngine: { reload: () => ({ errors: [] }) },
      auditService: { log: () => {} },
    });
    const skillSocket = { emit: () => {} };
    const invalidProgramSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-invalid-draft', message: '创作一个程序 bad-program', context: {}, entry: 'studio' });
    invalidProgramSession.stage = 'draft';
    const invalidProgramDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: invalidProgramSession.id,
      programId: 'bad-program',
      files: [{
        path: 'data/programs/bad-program/program.yaml',
        content: `name: Bad Program
enabled: false
hosts: all
l2:
  skill: program-maintenance
actions:
  run_it:
    steps:
      - id: do_it
        type: exec
        command: echo bad
      - id: render_result
        type: render
        format: keyvalue
        title: 结果
        from: do_it
`,
      }],
    }, { socket: skillSocket, sessionId: 'sess-program-invalid-draft', safeMode: false, session: { authoringSession: invalidProgramSession } });
    assert.strictEqual(invalidProgramDraftResult.is_error, false, invalidProgramDraftResult.content);
    const invalidProgramDraft = invalidProgramSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(invalidProgramDraft.validation.ok, false, 'Program Draft 预校验必须拦截真实 schema 错误');
    assert.strictEqual(invalidProgramSession.stage, 'draft', '无效 Program Draft 必须停留在 draft 阶段以便 AI 直接重写');
    assert(invalidProgramDraft.validation.errors.some((item) => item.includes('triggers 数组不能为空')), 'Program Draft 必须提前发现 triggers 缺失');
    assert(invalidProgramDraft.validation.errors.some((item) => item.includes('必须有 run 字段')), 'Program Draft 必须提前发现 exec step 使用 command 而不是 run');
    invalidProgramSession.stage = 'review';
    const invalidApprovalResult = await skillTools.handle('request_commit_approval', { sessionId: invalidProgramSession.id, artifactId: invalidProgramDraft.id, summary: '不应批准无效 Program' }, { socket: skillSocket, sessionId: 'sess-program-invalid-draft', safeMode: false, session: { authoringSession: invalidProgramSession } });
    assert.strictEqual(invalidApprovalResult.is_error, true, '无效 Program Draft 不能进入 commit approval');
    assert.strictEqual(invalidProgramSession.stage, 'draft', '审批前复检失败必须自动回到 draft 阶段');

    const toolNames = skillTools.TOOL_SCHEMAS.map((tool) => tool.name);
    assert(!toolNames.includes('run_playbook'), 'Authoring 工具 schema 不应暴露 run_playbook');
    const queryFormatSchema = skillTools.TOOL_SCHEMAS.find((tool) => tool.name === 'query_format');
    assert(queryFormatSchema, '必须存在 query_format 工具');
    assert(!queryFormatSchema.input_schema.properties.type.enum.includes('playbook'), 'query_format 不应接受 playbook 类型');
    const listArtifactsSchema = skillTools.TOOL_SCHEMAS.find((tool) => tool.name === 'list_artifacts');
    assert(listArtifactsSchema, '必须存在 list_artifacts 工具');
    assert(!listArtifactsSchema.input_schema.properties.type.enum.includes('playbook'), 'list_artifacts 不应接受 playbook 类型');

    const playbookFormatResult = await skillTools.handle('query_format', { type: 'playbook' }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(playbookFormatResult.is_error, true, 'query_format(playbook) 必须被拒绝');
    const playbookListResult = await skillTools.handle('list_artifacts', { type: 'playbook' }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(playbookListResult.is_error, true, 'list_artifacts(playbook) 必须被拒绝');
    const playbookWriteResult = await skillTools.handle('write_file', { path: 'data/playbooks/bad/SKILL.md', content: 'bad' }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: {} });
    assert.strictEqual(playbookWriteResult.is_error, true, 'write_file 不应允许写入 data/playbooks');

    const skillSpecResult = await skillTools.handle('create_skill_spec', {
      sessionId: skillSession.id,
      skillId: testSkillId,
      name: 'Authoring Skill Test',
      goal: '测试 Skill 创作链路',
      triggerScenarios: ['用户要求生成 Program 草案'],
      inputs: [{ id: 'goal', label: '目标' }],
      rules: ['必须先生成可审查草案'],
      workflows: ['生成 Skill 文件夹草案'],
      references: ['program-schema.md'],
      risks: ['Skill/Playbook 边界混用'],
    }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillSpecResult.is_error, false, skillSpecResult.content);
    assert.strictEqual(skillSession.stage, 'plan', 'create_skill_spec 后必须进入 plan 阶段');
    skillSession.stage = 'draft';
    assert.deepStrictEqual(requiredAuthoringToolsForStage(skillSession), ['create_skill_draft'], 'Skill draft 阶段必须要求 create_skill_draft');
    const skillFiles = [
      { path: `data/skills/${testSkillId}/SKILL.md`, content: `---\nname: Authoring Skill Test\ndescription: Test skill authoring path\n---\n\n# Authoring Skill Test\n` },
      { path: `data/skills/${testSkillId}/rules/constraints.md`, content: '# Constraints\n\n- Keep artifacts staged.\n' },
      { path: `data/skills/${testSkillId}/workflows/generate.md`, content: '# Generate\n\nCreate a draft first.\n' },
    ];
    const skillDraftResult = await skillTools.handle('create_skill_draft', {
      sessionId: skillSession.id,
      skillId: testSkillId,
      files: skillFiles,
    }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillDraftResult.is_error, false, skillDraftResult.content);
    const skillDraft = skillSession.artifacts.find((item) => item.type === 'skill_draft');
    assert(skillDraft, '必须能创建 Skill Draft artifact');
    assert.strictEqual(skillDraft.validation.ok, true, skillDraft.validation.errors.join('\n'));
    const skillValidationResult = await skillTools.handle('validate_skill_draft', { sessionId: skillSession.id, artifactId: skillDraft.id }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillValidationResult.is_error, false, skillValidationResult.content);
    const skillApprovalResult = await skillTools.handle('request_commit_approval', { sessionId: skillSession.id, artifactId: skillDraft.id, summary: '写入 Skill 文件夹草案' }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillApprovalResult.is_error, false, skillApprovalResult.content);
    const skillApproval = skillSession.interactions.find((item) => item.kind === 'commit_approval');
    assert(skillApproval, 'Skill draft 必须能请求 commit approval');
    assert.strictEqual(skillApproval.options[0].label, '确认创建 Skill 并写入文件', 'Skill commit approval 必须使用明确 Skill 文案');
    assert.strictEqual(skillApproval.options[0].risk, undefined, 'Skill commit approval 的确认按钮不应显示风险标签');
    assert.strictEqual(skillApproval.options[1].recommended, undefined, 'Skill commit approval 不应默认推荐暂不写入');
    recordAuthoringReply(skillSession, { interactionId: skillApproval.id, value: 'approve', text: '确认创建 Skill 并写入文件' });
    const skillCommitResult = await skillTools.handle('commit_authoring_artifact', { sessionId: skillSession.id, artifactId: skillDraft.id }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillCommitResult.is_error, false, skillCommitResult.content);
    assert(fs.existsSync(path.join(ROOT_DIR, `data/skills/${testSkillId}/SKILL.md`)), 'Skill commit 必须写入 SKILL.md');
    assert(skillReloadedForSkill, 'Skill commit 后必须 reload registry');
    const skillVerifyResult = await skillTools.handle('verify_authoring_artifact', { sessionId: skillSession.id, artifactId: skillDraft.id }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillVerifyResult.is_error, false, skillVerifyResult.content);
    assert.strictEqual(skillSession.stage, 'done', 'Skill 验证通过后必须进入 done 阶段');

    const badSkillSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-skill-bad', message: `创建 Skill ${testSkillId}-bad`, context: {}, entry: 'studio' });
    badSkillSession.stage = 'draft';
    const badDraftResult = await skillTools.handle('create_skill_draft', {
      sessionId: badSkillSession.id,
      skillId: `${testSkillId}-bad`,
      files: [
        { path: `data/skills/${testSkillId}-bad/SKILL.md`, content: `---\nname: Bad Skill\ndescription: Bad skill\n---\n` },
        { path: `data/skills/${testSkillId}-bad/playbook.yaml`, content: 'id: bad\n' },
      ],
    }, { socket: skillSocket, sessionId: 'sess-skill-bad', safeMode: false, session: { authoringSession: badSkillSession } });
    assert.strictEqual(badDraftResult.is_error, false, badDraftResult.content);
    const badDraft = badSkillSession.artifacts.find((item) => item.type === 'skill_draft');
    assert.strictEqual(badDraft.validation.ok, false, 'data/skills 下的 playbook.yaml 必须被 Skill draft validation 拒绝');
    assert(badDraft.validation.errors.some((item) => item.includes('playbook.yaml') && item.includes('Program L1/action')), 'validation error 必须说明 playbook.yaml 边界和 Program L1/action 去向');
  } finally {
    fs.rmSync(testSkillDir, { recursive: true, force: true });
    fs.rmSync(`${testSkillDir}-bad`, { recursive: true, force: true });
  }

  let commitBlocked = gateAuthoringTool(session, 'commit_authoring_artifact');
  assert(commitBlocked?.is_error, 'review 阶段不能直接 commit artifact');
  const commitRequest = recordCommitApprovalRequest(session, {
    artifactId: draft.id,
    summary: '写入反代端口证书申请 Program 草案',
    files: [{ path: 'data/programs/reverse-proxy-cert/program.yaml', bytes: 80 }],
    dangerousActions: ['证书申请', 'Cloudflare API key'],
    irreversibleActions: ['写入 data/programs 下的新 Program 文件'],
    validation: { ok: true, errors: [], warnings: [] },
  });
  assert(commitRequest, '必须能创建 commit approval interaction');
  assert.strictEqual(commitRequest.options[0].risk, undefined, 'commit approval 的确认按钮不应显示高危选项标签');
  assert.strictEqual(commitRequest.options[1].risk, undefined, 'commit approval 的暂不写入按钮不应显示低危选项标签');
  assert.strictEqual(commitRequest.options[1].recommended, undefined, 'commit approval 不应默认推荐暂不写入');
  assert.strictEqual(session.stage, 'review', '请求 commit approval 时仍停留在 review');
  commitBlocked = gateAuthoringTool(session, 'commit_authoring_artifact');
  assert(commitBlocked?.is_error, '用户批准前 commit_authoring_artifact 必须被阻断');
  const commitReply = recordAuthoringReply(session, { interactionId: commitRequest.id, value: 'approve', text: '确认创建 Program 并写入文件' });
  assert(commitReply, '必须能记录 commit approval');
  assert.strictEqual(session.approvals.commit, true, '批准后 commit approval 必须为 true');
  assert.strictEqual(session.approvals.commitArtifactId, draft.id, '批准必须绑定具体 draft artifact');
  assert.strictEqual(session.stage, 'commit', '批准后必须进入 commit 阶段');
  assert.strictEqual(gateAuthoringTool(session, 'commit_authoring_artifact'), null, '批准后只能放行 commit_authoring_artifact');
  assert(gateAuthoringTool(session, 'write_file')?.is_error, '批准后仍不能用 write_file 绕过 artifact commit');

  const testProgramId = `authoring-session-test-${Date.now()}`;
  const testDir = path.join(ROOT_DIR, 'data', 'programs', testProgramId);
  const testFile = `data/programs/${testProgramId}/program.yaml`;
  try {
    const { commitSession, commitDraft } = createApprovedProgramCommitSession(testProgramId, testFile, validProgramYaml.replace('反代端口证书申请', 'Authoring Session Test'));
    let skillReloaded = false;
    let programReloaded = false;
    const ideTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => { skillReloaded = true; }, listSkills: () => [], listPlaybooks: () => [] },
      programEngine: { reload: () => { programReloaded = true; return { errors: [] }; } },
      auditService: { log: () => {} },
    });
    const socket = { emit: () => {} };
    const commitResult = await ideTools.handle('commit_authoring_artifact', { sessionId: commitSession.id, artifactId: commitDraft.id }, { socket, sessionId: 'sess-commit-test', safeMode: false, session: { authoringSession: commitSession } });
    assert.strictEqual(commitResult.is_error, false, commitResult.content);
    assert(fs.existsSync(path.join(ROOT_DIR, testFile)), 'commit_authoring_artifact 必须写入 artifact 声明的文件');
    assert(skillReloaded, 'commit 后必须 reload skill registry');
    assert(programReloaded, 'commit 后必须 reload program registry');
    assert.strictEqual(commitSession.stage, 'verify', 'commit 后必须进入 verify 阶段');
    assert(gateAuthoringTool(commitSession, 'write_file')?.is_error, 'verify 阶段仍不能任意 write_file');
    const verifyResult = await ideTools.handle('verify_authoring_artifact', { sessionId: commitSession.id, artifactId: commitDraft.id }, { socket, sessionId: 'sess-commit-test', safeMode: false, session: { authoringSession: commitSession } });
    assert.strictEqual(verifyResult.is_error, false, verifyResult.content);
    assert.strictEqual(commitSession.stage, 'done', '验证通过后必须进入 done 阶段');
    const verification = commitSession.artifacts.find((item) => item.type === 'authoring_verification');
    assert(verification, '验证必须生成 authoring_verification artifact');
    assert.strictEqual(verification.status, 'passed', '验证成功 artifact 状态必须是 passed');
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const commitRollbackProgramId = `authoring-session-commit-rollback-${Date.now()}`;
  const commitRollbackDir = path.join(ROOT_DIR, 'data', 'programs', commitRollbackProgramId);
  const commitRollbackFile = `data/programs/${commitRollbackProgramId}/program.yaml`;
  try {
    const { commitSession, commitDraft } = createApprovedProgramCommitSession(commitRollbackProgramId, commitRollbackFile, validProgramYaml.replace('反代端口证书申请', 'Commit Rollback Test'));
    const rollbackTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => {}, listSkills: () => [], listPlaybooks: () => [] },
      programEngine: { reload: () => ({ errors: [`${commitRollbackProgramId}: YAML schema mismatch`] }) },
      auditService: { log: () => {} },
    });
    const rollbackResult = await rollbackTools.handle('commit_authoring_artifact', { sessionId: commitSession.id, artifactId: commitDraft.id }, { socket: { emit: () => {} }, sessionId: 'sess-commit-rollback', safeMode: false, session: { authoringSession: commitSession } });
    assert.strictEqual(rollbackResult.is_error, true, 'commit 后 registry 加载当前 Program 失败必须返回错误');
    assert(!fs.existsSync(path.join(ROOT_DIR, commitRollbackFile)), 'commit registry 失败必须删除新写入的 Program 文件');
    assert(!fs.existsSync(commitRollbackDir), 'commit registry 失败必须清理新建空目录');
    assert.strictEqual(commitSession.stage, 'draft', 'commit registry 失败后必须回到 draft 阶段');
    assert.strictEqual(commitSession.approvals.commit, false, 'commit registry 失败后必须撤销 commit approval');
    assert.strictEqual(commitDraft.status, 'needs_fix', 'commit registry 失败后源 draft 必须标记 needs_fix');
  } finally {
    fs.rmSync(commitRollbackDir, { recursive: true, force: true });
  }

  const failedProgramId = `authoring-session-fail-${Date.now()}`;
  const failedDir = path.join(ROOT_DIR, 'data', 'programs', failedProgramId);
  const failedFile = `data/programs/${failedProgramId}/program.yaml`;
  try {
    const { commitSession: failedSession, commitDraft: failedDraft } = createApprovedProgramCommitSession(failedProgramId, failedFile, validProgramYaml.replace('反代端口证书申请', 'Failed Verification Test'));
    let reloadCount = 0;
    const failedTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => {}, listSkills: () => [], listPlaybooks: () => [] },
      programEngine: { reload: () => {
        reloadCount += 1;
        return reloadCount === 1 ? { errors: [] } : { errors: [`${failedProgramId}: YAML schema mismatch`] };
      } },
      auditService: { log: () => {} },
    });
    const failedSocket = { emit: () => {} };
    const failedCommit = await failedTools.handle('commit_authoring_artifact', { sessionId: failedSession.id, artifactId: failedDraft.id }, { socket: failedSocket, sessionId: 'sess-verify-fail', safeMode: false, session: { authoringSession: failedSession } });
    assert.strictEqual(failedCommit.is_error, false, failedCommit.content);
    assert(fs.existsSync(path.join(ROOT_DIR, failedFile)), 'verify 前必须已经写入 Program 文件');
    const failedResult = await failedTools.handle('verify_authoring_artifact', { sessionId: failedSession.id, artifactId: failedDraft.id }, { socket: failedSocket, sessionId: 'sess-verify-fail', safeMode: false, session: { authoringSession: failedSession } });
    assert.strictEqual(failedResult.is_error, true, '加载错误时 verify 必须失败');
    assert(!fs.existsSync(path.join(ROOT_DIR, failedFile)), 'verify 失败必须删除本次新建的 Program 文件');
    assert(!fs.existsSync(failedDir), 'verify 失败必须清理本次新建空目录');
    assert.strictEqual(failedSession.stage, 'draft', '验证失败后必须回到 draft 阶段');
    assert.strictEqual(failedSession.approvals.commit, false, '验证失败后必须撤销 commit approval');
    assert.strictEqual(failedDraft.status, 'needs_fix', '验证失败后源 draft 必须标记 needs_fix');
  } finally {
    fs.rmSync(failedDir, { recursive: true, force: true });
  }

  const restoreProgramId = `authoring-session-restore-${Date.now()}`;
  const restoreDir = path.join(ROOT_DIR, 'data', 'programs', restoreProgramId);
  const restoreFile = `data/programs/${restoreProgramId}/program.yaml`;
  const restoreAbs = path.join(ROOT_DIR, restoreFile);
  const originalContent = validProgramYaml.replace('反代端口证书申请', 'Original Restore Test');
  try {
    fs.mkdirSync(restoreDir, { recursive: true });
    fs.writeFileSync(restoreAbs, originalContent, 'utf8');
    const { commitSession: restoreSession, commitDraft: restoreDraft } = createApprovedProgramCommitSession(restoreProgramId, restoreFile, validProgramYaml.replace('反代端口证书申请', 'Changed Restore Test'));
    let reloadCount = 0;
    const restoreTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => {}, listSkills: () => [], listPlaybooks: () => [] },
      programEngine: { reload: () => {
        reloadCount += 1;
        return reloadCount === 1 ? { errors: [] } : { errors: [`${restoreProgramId}: YAML schema mismatch`] };
      } },
      auditService: { log: () => {} },
    });
    const restoreSocket = { emit: () => {} };
    const restoreCommit = await restoreTools.handle('commit_authoring_artifact', { sessionId: restoreSession.id, artifactId: restoreDraft.id }, { socket: restoreSocket, sessionId: 'sess-verify-restore', safeMode: false, session: { authoringSession: restoreSession } });
    assert.strictEqual(restoreCommit.is_error, false, restoreCommit.content);
    assert.strictEqual(fs.readFileSync(restoreAbs, 'utf8'), restoreDraft.data.files[0].content, 'commit 必须先覆盖既有文件');
    const restoreResult = await restoreTools.handle('verify_authoring_artifact', { sessionId: restoreSession.id, artifactId: restoreDraft.id }, { socket: restoreSocket, sessionId: 'sess-verify-restore', safeMode: false, session: { authoringSession: restoreSession } });
    assert.strictEqual(restoreResult.is_error, true, '既有文件 verify 失败必须返回错误');
    assert.strictEqual(fs.readFileSync(restoreAbs, 'utf8'), originalContent, 'verify 失败必须恢复既有 Program 文件内容');
    assert.strictEqual(restoreSession.stage, 'draft', '既有文件恢复后必须回到 draft 阶段');
  } finally {
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }

  console.log('authoring session tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

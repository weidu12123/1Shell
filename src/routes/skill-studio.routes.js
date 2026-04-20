'use strict';

const { Router } = require('express');

/**
 * Skill Studio Routes
 *
 * 创作台的后端仅做一件事：把表单字段（主机、容器、文件、MCP、自然语言）
 * 拼成一段结构化 Markdown，作为 skill-authoring Skill 的 task 输入。
 * 真正的创作由 skill-authoring 本身完成（走 runner.js AI-loop + write_local_file）。
 *
 * 不引入新的 AI 调用路径，保持单一执行模型。
 */
function createSkillStudioRouter({ hostService, libraryService, mcpRegistry }) {
  const router = Router();

  // GET /api/skill-studio/context — 返回创作台需要的上下文（主机列表等）
  router.get('/skill-studio/context', (_req, res) => {
    const hosts = (hostService.listHosts?.() || []).map((h) => ({
      id: h.id,
      name: h.name,
      host: h.host,
      username: h.username,
      port: h.port,
    }));
    res.json({ ok: true, hosts });
  });

  // POST /api/skill-studio/compose
  //   { mode: 'classify'|'create-skill'|'create-program'|'create-bundle'|
  //           'create-playbook'|'create-rescue-skill'|'refine',
  //     targetSkillId?, targetPlaybookId?, task,
  //     hosts?, containers?, files?, mcpServers?,
  //     cronSchedule?, guardianSkills? }
  //   → { ok, composedTask, targetSkillId, mode }
  router.post('/skill-studio/compose', (req, res) => {
    const body = req.body || {};
    const ALLOWED_MODES = [
      'classify', 'create-skill', 'create-program', 'create-bundle',
      'create-playbook',
      'create-rescue-skill', // 保留后端兼容，仅供 generate-bundle 内部使用，不在 UI 暴露
      'refine',
      'generate', // legacy alias
    ];
    const rawMode = ALLOWED_MODES.includes(body.mode) ? body.mode : 'classify';
    // normalize legacy alias
    const mode = rawMode === 'generate' ? 'create-playbook' : rawMode;
    const task = String(body.task || '').trim();
    if (!task) {
      return res.status(400).json({ ok: false, error: 'task 不能为空' });
    }

    const lines = [];
    lines.push(`**用户意图**：${task}`);
    lines.push('');

    const hosts = Array.isArray(body.hosts) ? body.hosts : [];
    if (hosts.length > 0) {
      lines.push('**目标主机**：');
      for (const h of hosts) {
        const hostInfo = hostService.findHost?.(h.id);
        const desc = hostInfo
          ? `${hostInfo.name} (${hostInfo.username || 'root'}@${hostInfo.host}:${hostInfo.port || 22})`
          : String(h.name || h.id);
        lines.push(`  - \`${h.id}\` · ${desc}${h.note ? ` — ${h.note}` : ''}`);
      }
      lines.push('');
    }

    const containers = Array.isArray(body.containers) ? body.containers : [];
    if (containers.length > 0) {
      lines.push('**相关容器**：');
      for (const c of containers) {
        lines.push(`  - hostId=\`${c.hostId}\` container=\`${c.name || c.id}\`${c.image ? ` image=${c.image}` : ''}`);
      }
      lines.push('');
    }

    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > 0) {
      lines.push('**相关文件路径**（生成的脚本应通过 execute_command 读取，不要假设内容）：');
      for (const f of files) {
        lines.push(`  - hostId=\`${f.hostId}\` path=\`${f.path}\`${f.purpose ? ` — ${f.purpose}` : ''}`);
      }
      lines.push('');
    }

    const mcpServers = Array.isArray(body.mcpServers) ? body.mcpServers : [];
    // 支持两种输入：
    //  1) { id }                     ← 创作台从仓库选的工具，按 id 从 registry 展开（含 token）
    //  2) { name, url, authToken }   ← 兼容旧调用
    const cleanMcp = mcpServers
      .map((s) => {
        if (s && s.id && mcpRegistry) {
          const hit = mcpRegistry.listServersWithSecrets().find(x => x.id === s.id);
          if (hit) {
            return {
              name: hit.name,
              url: hit.url,
              authToken: hit.authToken || '',
              id: hit.id,
            };
          }
        }
        return {
          name: String((s && s.name) || '').trim(),
          url: String((s && s.url) || '').trim(),
          authToken: (s && s.authToken) ? String(s.authToken) : '',
        };
      })
      .filter((s) => s.name && s.url);
    if (cleanMcp.length > 0) {
      lines.push('**MCP Server（远程 URL 类，将自动挂载到运行时）**：');
      for (const s of cleanMcp) {
        lines.push(`  - \`${s.name}\` → ${s.url}${s.authToken ? ' (带鉴权)' : ''}`);
      }
      lines.push('');
      lines.push('生成的 SKILL.md frontmatter 必须包含 `mcpServers` 数组，原样保留上面的 name/url/authToken 字段。');
      lines.push('');
    }

    // 引用已有 Skill（能力组合）
    const referencedSkillIds = Array.isArray(body.referencedSkills) ? body.referencedSkills : [];
    const refs = referencedSkillIds
      .map((id) => {
        const item = libraryService.getItem(String(id));
        return item && item.kind === 'skill' ? item : null;
      })
      .filter(Boolean);
    if (refs.length > 0) {
      lines.push('**引用 Skill（可复用能力，生成时可调用其命令风格或直接引用）**：');
      for (const r of refs) {
        const desc = String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        lines.push(`  - \`${r.id}\` · ${r.name}${desc ? ` — ${desc}` : ''}`);
      }
      lines.push('');
      lines.push('生成的 SKILL.md frontmatter 应包含 `referencedSkills: [...]` 数组。');
      lines.push('');
    }

    // 改进模式：上一次执行的错误上下文（供 refine 使用）
    const errorContext = typeof body.errorContext === 'string' ? body.errorContext.trim() : '';
    if (errorContext) {
      lines.push('**上一次执行的错误摘要（请分析并在修改时规避）**：');
      lines.push('```');
      lines.push(errorContext.slice(0, 4000));
      lines.push('```');
      lines.push('');
    }

    if (mode === 'classify') {
      lines.push('**模式**：AI 推荐产物类型');
      lines.push('');
      lines.push('请读取 `data/skills/skill-authoring/workflows/classify.md`，按其决策树分析用户意图，');
      lines.push('用 `render_result format=keyvalue` 展示推荐方案，再用 `ask_user type=select` 让用户确认后路由到对应 generate workflow。');

    } else if (mode === 'create-skill') {
      lines.push('**模式**：创建 AI Skill（能力包）');
      lines.push('**产物位置**：`data/skills/<skill-id>/`');
      lines.push('**约束**：严格按 `data/skills/skill-authoring/workflows/generate-skill.md` 执行。');
      lines.push('**禁止**：`data/skills/` 下绝对不能有 `playbook.yaml`。');

    } else if (mode === 'create-program') {
      lines.push('**模式**：创建长驻 Program（后台守护进程）');
      lines.push('**产物位置**：`data/programs/<program-id>/program.yaml`');
      lines.push('**约束**：严格按 `data/skills/skill-authoring/workflows/generate-program.md` 执行。');
      lines.push('');
      // Program-specific extras
      const cronSchedule = String(body.cronSchedule || '').trim();
      if (cronSchedule) {
        lines.push(`**Cron 表达式（用户指定）**：\`${cronSchedule}\``);
        lines.push('');
      }
      const guardianSkills = Array.isArray(body.guardianSkills) ? body.guardianSkills : [];
      if (guardianSkills.length > 0) {
        lines.push('**Guardian 允许调用的 Rescue Skill**：');
        for (const sid of guardianSkills) {
          const s = libraryService.getItem(String(sid));
          lines.push(`  - \`${sid}\`${s ? ` · ${s.name}` : ''}`);
        }
        lines.push('');
        lines.push(`程序的 program.yaml 中 \`guardian.skills\` 必须包含以上 id 列表。`);
        lines.push('');
      }

    } else if (mode === 'create-bundle') {
      lines.push('**模式**：Bundle 组合创作（Program + Rescue Skill）');
      lines.push('**产物位置**：`data/skills/<skill-id>/`（Rescue Skill）和 `data/programs/<program-id>/program.yaml`（Program）');
      lines.push('**约束**：严格按 `data/skills/skill-authoring/workflows/generate-bundle.md` 执行。');
      lines.push('**顺序**：必须先写 Rescue Skill，再写 Program（保证 guardian.skills 引用存在）。');

    } else if (mode === 'create-playbook') {
      lines.push('**模式**：创建一次性 Playbook（确定性剧本）');
      lines.push('**产物位置**：`data/playbooks/<playbook-id>/`');
      lines.push('**约束**：严格按 `data/skills/skill-authoring/workflows/generate-playbook.md` 执行。');

    } else if (mode === 'refine') {
      const rawIds = String(body.targetSkillId || '').trim();
      if (!rawIds) {
        return res.status(400).json({ ok: false, error: 'refine 模式必须提供 targetSkillId' });
      }
      // 支持逗号分隔的多目标
      const targetIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
      const items = targetIds.map(id => ({ id, item: libraryService.getItem(id) }));
      const missing = items.filter(({ item }) => !item).map(({ id }) => id);
      if (missing.length > 0) {
        return res.status(404).json({ ok: false, error: `待改进的项目不存在: ${missing.join(', ')}` });
      }
      lines.push(`**模式**：改进以下 ${items.length} 个项目`);
      for (const { id, item } of items) {
        const subdir = item.kind === 'playbook' ? 'playbooks'
          : item.kind === 'program' ? 'programs'
          : 'skills';
        const typeLabel = item.kind === 'playbook' ? 'Playbook'
          : item.kind === 'program' ? 'Program'
          : 'Skill';
        lines.push(`- \`${id}\`（${typeLabel}）→ \`data/${subdir}/${id}/\``);
        lines.push(`  先用 execute_command 读取 data/${subdir}/${id}/ 下所有文件，再按用户意图做最小必要修改。`);
      }

    } else if (mode === 'create-rescue-skill') {
      const targetPlaybookId = String(body.targetPlaybookId || '').trim();
      if (!targetPlaybookId) {
        return res.status(400).json({
          ok: false,
          error: 'create-rescue-skill 模式必须提供 targetPlaybookId（要为哪个 Playbook 创作救援策略）',
        });
      }
      const target = libraryService.getItem(targetPlaybookId);
      if (!target || target.kind !== 'playbook') {
        return res.status(404).json({
          ok: false,
          error: `目标 Playbook 不存在: ${targetPlaybookId}`,
        });
      }
      const suggestedSkillId = String(body.targetSkillId || '').trim();
      if (suggestedSkillId && !/^[a-z0-9][a-z0-9-]*$/.test(suggestedSkillId)) {
        return res.status(400).json({
          ok: false,
          error: `建议的 Rescue Skill id 不合法（须 kebab-case）: ${suggestedSkillId}`,
        });
      }

      lines.push(`**模式**：为 Playbook \`${targetPlaybookId}\` 创建 Rescue Skill`);
      lines.push('');
      lines.push('**产物位置**：`data/skills/<skill-id>/`（**绝不**写到 `data/playbooks/`）');
      lines.push('**约束**：严格按 skill-authoring 的 `workflows/generate-rescue-skill.md` 执行。');
      lines.push('');
      if (suggestedSkillId) {
        lines.push(`**建议 Skill id**：\`${suggestedSkillId}\`（可采用，或按目标 Playbook 的语义微调）`);
        lines.push('');
      }
      lines.push(`## 目标 Playbook 摘要`);
      lines.push(`- id: \`${target.id}\``);
      lines.push(`- name: ${target.name || target.id}`);
      if (target.description) {
        const desc = String(target.description).replace(/\s+/g, ' ').trim().slice(0, 400);
        lines.push(`- description: ${desc}`);
      }
      lines.push('');
      lines.push(
        '**必做**：用 `execute_command` 读 `data/playbooks/' + target.id +
        '/SKILL.md`、`playbook.yaml`（若有）、以及 `workflows/*.md`，理解每个步骤的 run/verify/on_error_hint 后再设计 Rescue Skill。',
      );
      lines.push('');
      lines.push('**完成后必做**：用 `render_result`（format: message）输出绑定提示，告诉用户在目标 Playbook 的 `playbook.yaml` 顶部加 `rescuer_skill: <skill-id>`。');
    }

    const composedTask = lines.join('\n');

    return res.json({
      ok: true,
      mode,
      targetSkillId: body.targetSkillId || null,
      targetPlaybookId: body.targetPlaybookId || null,
      cronSchedule: body.cronSchedule || null,
      composedTask,
    });
  });

  return router;
}

module.exports = { createSkillStudioRouter };
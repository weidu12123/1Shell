'use strict';

/**
 * Skill Registry — 文件系统驱动
 *
 * 扫描 data/skills/ 目录，每个子目录是一个 Skill。
 * 通过解析 SKILL.md 的 YAML frontmatter 获取元数据（name, icon, inputs 等）。
 * Skill 内容不硬编码在 JS 中，而是纯 Markdown 文件组成的"微型项目"。
 */

const fs = require('fs');
const path = require('path');

/**
 * 解析 Markdown 文件开头的 YAML frontmatter。
 * 不引入 yaml 库，手写一个基于缩进层级的解析器。
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { meta: {}, body: content };

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return { meta: {}, body: content };

  const yamlBlock = content.substring(4, endIdx).trim();
  const body = content.substring(endIdx + 4).trim();
  const meta = parseYaml(yamlBlock);

  return { meta, body };
}

/**
 * 缩进感知的 YAML 解析器。
 * 支持：标量、数组（-）、嵌套对象、数组内嵌套对象。
 * 足够处理 SKILL.md frontmatter。
 */
function parseYaml(yaml) {
  const lines = yaml.split('\n');
  return parseBlock(lines, 0, 0).value;
}

function parseBlock(lines, start, minIndent) {
  const result = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < minIndent) break;

    // 数组项
    const arrayMatch = line.match(/^(\s*)- (.*)$/);
    if (arrayMatch) break; // 由调用方处理

    // key: value
    const kvMatch = line.match(/^(\s*)(\w[\w\s]*\w|\w+)\s*:\s*(.*)$/);
    if (!kvMatch) { i++; continue; }

    const keyIndent = kvMatch[1].length;
    if (keyIndent < minIndent) break;

    const key = kvMatch[2].trim();
    const rawVal = kvMatch[3].trim();

    if (rawVal) {
      // 直接值
      result[key] = cleanValue(rawVal);
      i++;
    } else {
      // 值为空 → 检查下一行是数组还是嵌套对象
      i++;
      if (i < lines.length) {
        const nextLine = lines[i];
        const nextIndent = nextLine.search(/\S/);
        if (nextIndent > keyIndent && nextLine.trim().startsWith('- ')) {
          // 数组
          const arr = parseArray(lines, i, nextIndent);
          result[key] = arr.value;
          i = arr.nextIndex;
        } else if (nextIndent > keyIndent) {
          // 嵌套对象
          const sub = parseBlock(lines, i, nextIndent);
          result[key] = sub.value;
          i = sub.nextIndex;
        } else {
          result[key] = '';
        }
      }
    }
  }

  return { value: result, nextIndex: i };
}

function parseArray(lines, start, minIndent) {
  const arr = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < minIndent) break;

    const itemMatch = line.match(/^(\s*)- (.*)$/);
    if (!itemMatch || itemMatch[1].length < minIndent) break;

    const itemContent = itemMatch[2].trim();
    const itemBaseIndent = itemMatch[1].length;

    if (itemContent.includes(': ')) {
      // 可能是对象的第一个 key: value
      const obj = {};
      const firstKv = itemContent.match(/^(\w[\w\s]*\w|\w+)\s*:\s*(.*)$/);
      if (firstKv) {
        const val = firstKv[2].trim();
        if (val) {
          obj[firstKv[1].trim()] = cleanValue(val);
        } else {
          // 值为空 → 嵌套数组或对象
          i++;
          if (i < lines.length) {
            const nextLine = lines[i];
            const nextIndent = nextLine.search(/\S/);
            if (nextIndent > itemBaseIndent && nextLine.trim().startsWith('- ')) {
              const sub = parseArray(lines, i, nextIndent);
              obj[firstKv[1].trim()] = sub.value;
              i = sub.nextIndex;
            }
          }
          arr.push(obj);
          continue;
        }
      }
      i++;
      // 读取同一对象的后续字段（缩进更深）
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine.trim()) { i++; continue; }
        const nextIndent = nextLine.search(/\S/);
        if (nextIndent <= itemBaseIndent) break;
        const nextKv = nextLine.trim().match(/^(\w[\w\s]*\w|\w+)\s*:\s*(.*)$/);
        if (nextKv) {
          const subVal = nextKv[2].trim();
          if (subVal) {
            obj[nextKv[1].trim()] = cleanValue(subVal);
            i++;
          } else {
            // 嵌套值（数组或对象）
            i++;
            if (i < lines.length) {
              const deepLine = lines[i];
              const deepIndent = deepLine.search(/\S/);
              if (deepIndent > nextIndent && deepLine.trim().startsWith('- ')) {
                const sub = parseArray(lines, i, deepIndent);
                obj[nextKv[1].trim()] = sub.value;
                i = sub.nextIndex;
              } else if (deepIndent > nextIndent) {
                const sub = parseBlock(lines, i, deepIndent);
                obj[nextKv[1].trim()] = sub.value;
                i = sub.nextIndex;
              } else {
                obj[nextKv[1].trim()] = '';
              }
            }
          }
        } else {
          i++;
        }
      }
      arr.push(obj);
    } else {
      // 简单值
      arr.push(cleanValue(itemContent));
      i++;
    }
  }

  return { value: arr, nextIndex: i };
}

function cleanValue(val) {
  if (val == null) return '';
  let s = String(val).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

// ─── Registry ─────────────────────────────────────────────────────────

/**
 * @param {string} skillsDir — 扫描根目录
 * @param {object} [options]
 * @param {'skill'|'playbook'} [options.kind='skill']
 *   'skill'    → AI 能力包。目录下有 playbook.yaml 会被**拒绝加载**并告警，
 *                因为 Skill 的语义是"被 AI 读"，不应该绕开 AI 直接跑脚本。
 *   'playbook' → 确定性程序。允许 playbook.yaml（L1 执行器消费）。
 */
function createSkillRegistry(skillsDir, { kind = 'skill' } = {}) {
  let skills = scanSkills(skillsDir, kind);
  let skillMap = new Map(skills.map(s => [s.id, s]));

  function listSkills() {
    return skills.filter(s => !s.hidden).map(({ dir, ...rest }) => rest);
  }

  function getSkill(id) {
    return skillMap.get(id) || null;
  }

  function reload() {
    skills = scanSkills(skillsDir, kind);
    skillMap = new Map(skills.map(s => [s.id, s]));
    return skills.length;
  }

  /**
   * 将用户输入渲染到 SKILL.md frontmatter 的 inputs 上，
   * 生成参数摘要文本（给 CLAUDE.md 薄壳用）。
   */
  function renderInputsSummary(skill, userInputs) {
    const lines = ['## 任务参数'];
    for (const inp of skill.inputs || []) {
      const val = userInputs[inp.name] ?? inp.default ?? '';
      if (!val && !inp.required) continue;

      // visibleWhen 检查
      if (inp.visibleWhen) {
        const depVal = userInputs[inp.visibleWhen.field] ?? '';
        const allowed = Array.isArray(inp.visibleWhen.value) ? inp.visibleWhen.value : [inp.visibleWhen.value];
        if (!allowed.includes(depVal)) continue;
      }

      lines.push(`- ${inp.label}: ${val}`);
    }
    return lines.join('\n');
  }

  return { listSkills, getSkill, renderInputsSummary, reload };
}

/**
 * 扫描 skillsDir 下所有子目录，解析 SKILL.md 获取元数据。
 *
 * kind='skill' 时：目录含 playbook.yaml 会被**拒绝**（告警 + 跳过），
 * 因为 Skill 是"给 AI 读的能力包"，不能绕开 AI-Loop 直接当脚本跑。
 * Playbook 的确定性执行能力只在 data/playbooks/ 下的 registry 里启用。
 */
function scanSkills(skillsDir, kind = 'skill') {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    const hasPlaybook = fs.existsSync(path.join(skillDir, 'playbook.yaml'));

    // 边界保护：Skill 目录下出现 playbook.yaml 是语义污染
    // 会让 runner 误判并绕开 AI。直接拒载并告警，让作者修正。
    if (kind === 'skill' && hasPlaybook) {
      console.warn(
        `[skill-registry] 忽略 ${entry.name}：data/skills/ 下禁止 playbook.yaml。` +
        `Skill 是 AI 能力包，应通过 workflows/ 给 AI 读；要确定性执行请放到 data/playbooks/。`,
      );
      continue;
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const { meta, body } = parseFrontmatter(content);

      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        icon: meta.icon || '\u2699',
        description: meta.description || '',
        category: meta.category || 'other',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        hidden: meta.hidden === true || meta.hidden === 'true',
        forceLocal: meta.forceLocal === true || meta.forceLocal === 'true',
        inputs: normalizeInputs(meta.inputs),
        mcpServers: normalizeMcpServers(meta.mcpServers),
        referencedSkills: Array.isArray(meta.referencedSkills) ? meta.referencedSkills : [],
        hasPlaybook,
        executionMode: hasPlaybook ? 'playbook' : 'ai-loop',
        dir: skillDir,
      });
    } catch {
      // 跳过解析失败的 Skill
    }
  }

  return skills;
}

/**
 * 归一化 inputs 数组（从 YAML 解析出的可能结构不整齐）。
 */
function normalizeInputs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((inp) => {
    const result = {
      name: inp.name || '',
      label: inp.label || inp.name || '',
      type: inp.type || 'string',
      required: inp.required === true || inp.required === 'true',
      default: inp.default != null ? String(inp.default) : '',
      placeholder: inp.placeholder || '',
    };
    if (inp.options && Array.isArray(inp.options)) {
      result.options = inp.options.map(o => ({
        value: o.value != null ? String(o.value) : '',
        label: o.label != null ? String(o.label) : String(o.value || ''),
      }));
    }
    if (inp.visibleWhen) {
      result.visibleWhen = {
        field: inp.visibleWhen.field || '',
        value: inp.visibleWhen.value || '',
      };
    }
    return result;
  }).filter(inp => inp.name);
}

/**
 * 归一化 mcpServers 数组。
 * 每项: { name, url, authToken?, type? }
 * type 默认 'url'（远程 HTTP/SSE MCP，可直接透传给 Anthropic Messages API 的 mcp_servers 字段）。
 * 不支持 stdio 类 MCP——那类需要本地 spawn，安全与依赖成本过高。
 */
function normalizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    if (!s || typeof s !== 'object') return null;
    const url = String(s.url || '').trim();
    const name = String(s.name || '').trim();
    if (!url || !name) return null;
    const out = { type: 'url', name, url };
    if (s.authToken) out.authToken = String(s.authToken);
    if (s.tool_configuration && typeof s.tool_configuration === 'object') {
      out.tool_configuration = s.tool_configuration;
    }
    return out;
  }).filter(Boolean);
}

module.exports = { createSkillRegistry, parseFrontmatter };
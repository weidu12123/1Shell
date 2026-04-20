'use strict';

/**
 * Library Service — 统一 Skill 与 Playbook 仓库的读取层。
 *
 * 两者底层格式完全一致（SKILL.md + frontmatter + optional steps.yaml/playbook.yaml），
 * 差别只在语义：
 *   - Skill    → 可复用的能力单元（如 skill-authoring）
 *   - Playbook → 创作台产物，跨主机跨项目的智能剧本
 *
 * runner 不关心被跑的是哪种——此处提供 getItem(id) 统一查找。
 */
function createLibraryService({ skillRegistry, playbookRegistry }) {
  function getItem(id) {
    const s = skillRegistry.getSkill(id);
    if (s) return { ...s, kind: 'skill' };
    const p = playbookRegistry.getSkill(id);
    if (p) return { ...p, kind: 'playbook' };
    return null;
  }

  function listSkills() {
    return (skillRegistry.listSkills() || []).map(s => ({ ...s, kind: 'skill' }));
  }

  function listPlaybooks() {
    return (playbookRegistry.listSkills() || []).map(p => ({ ...p, kind: 'playbook' }));
  }

  function reload() {
    const a = skillRegistry.reload();
    const b = playbookRegistry.reload();
    return { skills: a, playbooks: b };
  }

  // runner 需要 .getSkill 与 .renderInputsSummary 接口——代理到两个底层 registry
  function getSkill(id) {
    return getItem(id);
  }

  function renderInputsSummary(item, userInputs) {
    // 两个 registry 的 renderInputsSummary 实现一致
    return skillRegistry.renderInputsSummary(item, userInputs);
  }

  return {
    getItem,
    getSkill,
    listSkills,
    listPlaybooks,
    reload,
    renderInputsSummary,
  };
}

module.exports = { createLibraryService };
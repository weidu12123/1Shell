#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node validate-skill.js <data/skills/skill-id>');
  process.exit(2);
}

const errors = [];
function exists(rel) {
  return fs.existsSync(path.join(dir, rel));
}
function read(rel) {
  return exists(rel) ? fs.readFileSync(path.join(dir, rel), 'utf8') : '';
}

for (const required of ['SKILL.md', 'rules/constraints.md']) {
  if (!exists(required)) errors.push(`${required} is required`);
}
if (!exists('workflows/repair.md') && !exists('workflows/escalate.md')) {
  errors.push('at least one workflow is required, usually workflows/repair.md or workflows/escalate.md');
}
if (exists('playbook.yaml')) errors.push('playbook.yaml must not be placed in data/skills/<id>/');

const skill = read('SKILL.md');
if (skill.length > 12000) errors.push('SKILL.md is too large; keep it as a router and move detail to rules/workflows/references');
if (!/Always Read/i.test(skill)) errors.push('SKILL.md should include Always Read routing');
if (!/Common Tasks/i.test(skill)) errors.push('SKILL.md should include Common Tasks routing');

const combined = ['SKILL.md', 'rules/constraints.md', 'workflows/repair.md', 'workflows/escalate.md']
  .map(read)
  .join('\n');
if (/risk_too_high|needs_human_decision|suspected_incident/.test(combined) && !/request_l3_escalation/.test(combined)) {
  errors.push('L3-worthy dispositions should describe request_l3_escalation');
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('1Shell Skill Extension checks passed.');

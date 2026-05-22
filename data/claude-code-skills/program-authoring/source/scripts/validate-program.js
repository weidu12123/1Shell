#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT_DIR = path.resolve(__dirname, '../../../../..');
const { normalizeProgram } = require(path.join(ROOT_DIR, 'src/programs/program-schema'));
const { validateUiArtifact, previewCheckUiArtifact } = require(path.join(ROOT_DIR, 'src/programs/ui-artifact'));

const file = process.argv[2];
if (!file) {
  console.error('Usage: node validate-program.js <program.yaml>');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const errors = [];

function has(pattern) {
  return pattern.test(text);
}
function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

if (!has(/^enabled:\s*false\s*$/m)) errors.push('enabled must be false for generated Programs');
if (has(/^guardian:\s*$/m) || has(/guardian\.enabled/)) errors.push('legacy guardian config is forbidden; use l2.* and l3.*');
if (!has(/^l2:\s*$/m) || !has(/^\s{2}skill:\s*\S+/m)) errors.push('l2.skill is required');
if (!has(/^l3:\s*$/m) || !has(/^\s{2}skills:\s*$/m)) errors.push('l3.skills is required');
if (has(/on_fail:\s*(stop|escalate)\b/)) errors.push('actions should default to on_fail: repair');
if (!has(/type:\s*render\b/)) errors.push('each generated Program must include a render step');

for (let i = 0; i < lines.length; i += 1) {
  if (!/^\s*verify:\s*$/.test(lines[i])) continue;
  const base = indentOf(lines[i]);
  const keys = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= base) break;
    const match = line.trim().match(/^([a-zA-Z_][\w-]*):/);
    if (match) keys.push(match[1]);
  }
  if (keys.length === 1 && keys[0] === 'exit_code') errors.push('verify must not rely only on exit_code: 0');
}

const nestedIdMatches = [...text.matchAll(/^\s{4,}-?\s*id:\s*([^\s#]+)/gm)];
for (const match of nestedIdMatches) {
  const id = match[1].replace(/^['"]|['"]$/g, '');
  if (!/^[a-z][a-z0-9_]*$/.test(id)) errors.push(`nested id should be snake_case: ${id}`);
}

const dangerBlocks = text.split(/\n\s*-\s+id:\s+/).filter((block) => /style:\s*danger\b/.test(block));
for (const block of dangerBlocks) {
  if (!/confirm:\s*\S+/.test(block)) errors.push('danger instance actions need confirm');
}

try {
  const doc = yaml.load(text);
  const id = path.basename(path.dirname(path.resolve(file)));
  const program = normalizeProgram(doc, id, file);
  const contract = program.frontendContract;
  if (!contract?.renderable) {
    for (const issue of contract?.issues || ['frontend contract check failed']) {
      errors.push(`frontend_contract_check: ${issue}`);
    }
  }
  const programWithDir = { ...program, dir: path.dirname(path.resolve(file)) };
  const uiCheck = validateUiArtifact(programWithDir);
  if (!uiCheck.ok) {
    for (const issue of uiCheck.issues || ['ui artifact check failed']) {
      errors.push(`ui_artifact_check: ${issue}`);
    }
  }
  const previewCheck = previewCheckUiArtifact(programWithDir);
  if (!previewCheck.ok) {
    for (const issue of previewCheck.issues || ['sandbox preview check failed']) {
      errors.push(`sandbox_preview_check: ${issue}`);
    }
  }
} catch (err) {
  errors.push(`schema validation failed: ${err.message}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('Program authoring checks passed.');

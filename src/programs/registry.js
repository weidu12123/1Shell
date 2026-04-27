'use strict';

/**
 * Program Registry — 扫描 data/programs/ 下所有子目录，加载 program.yaml。
 *
 * 解析失败的 Program 会 warn 但不阻止其他程序加载。
 */

const fs = require('fs');
const path = require('path');
const { loadProgram } = require('./program-schema');

function createProgramRegistry(programsDir) {
  let programs = [];
  let programMap = new Map();
  let lastErrors = [];

  function doScan() {
    const result = scan(programsDir);
    programs = result.programs;
    programMap = new Map(programs.map((p) => [p.id, p]));
    lastErrors = result.errors;
  }

  doScan();

  function list() {
    return programs.map((p) => ({ ...p, dir: undefined }));
  }

  function get(id) {
    return programMap.get(id) || null;
  }

  function reload() {
    doScan();
    return { count: programs.length, errors: lastErrors };
  }

  function getLastErrors() {
    return lastErrors;
  }

  return { list, get, reload, getLastErrors };
}

function scan(programsDir) {
  if (!fs.existsSync(programsDir)) {
    fs.mkdirSync(programsDir, { recursive: true });
    return { programs: [], errors: [] };
  }

  const entries = fs.readdirSync(programsDir, { withFileTypes: true });
  const programs = [];
  const errors = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const programDir = path.join(programsDir, entry.name);
    const programYamlPath = path.join(programDir, 'program.yaml');
    if (!fs.existsSync(programYamlPath)) continue;

    try {
      const program = loadProgram(programDir);
      if (program) {
        program.dir = programDir;
        programs.push(program);
      }
    } catch (err) {
      const msg = `${entry.name}: ${err.message}`;
      console.warn(`[program-registry] 跳过 ${msg}`);
      errors.push(msg);
    }
  }

  return { programs, errors };
}

module.exports = { createProgramRegistry };
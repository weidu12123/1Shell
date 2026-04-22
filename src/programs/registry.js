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
  let programs = scan(programsDir);
  let programMap = new Map(programs.map((p) => [p.id, p]));

  function list() {
    // 脱敏：不输出内部运行态，只输出 yaml 定义
    return programs.map((p) => ({ ...p, dir: undefined }));
  }

  function get(id) {
    return programMap.get(id) || null;
  }

  function reload() {
    programs = scan(programsDir);
    programMap = new Map(programs.map((p) => [p.id, p]));
    return programs.length;
  }

  return { list, get, reload };
}

function scan(programsDir) {
  if (!fs.existsSync(programsDir)) {
    fs.mkdirSync(programsDir, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(programsDir, { withFileTypes: true });
  const programs = [];

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
      console.warn(`[program-registry] 跳过 ${entry.name}：${err.message}`);
    }
  }

  return programs;
}

module.exports = { createProgramRegistry };
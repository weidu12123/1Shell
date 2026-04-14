'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Windows 兼容层
 *
 * 在 Windows 上，npm 全局安装的 CLI（如 claude、codex、opencode）通常是 .ps1 脚本，
 * node-pty 无法直接执行。此模块通过查找对应的 .ps1 文件，
 * 返回通过 powershell.exe 执行的命令格式。
 */

function findExecutableCommand(commandName) {
  if (os.platform() !== 'win32') return null;

  const npmGlobalDirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  ];

  // 检查 PATH 中的目录
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const allDirs = [...npmGlobalDirs, ...pathDirs];

  for (const dir of allDirs) {
    // 尝试 .ps1
    const ps1Path = path.join(dir, commandName + '.ps1');
    if (fs.existsSync(ps1Path)) {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      };
    }

    // 尝试 .cmd
    const cmdPath = path.join(dir, commandName + '.cmd');
    if (fs.existsSync(cmdPath)) {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', cmdPath],
      };
    }

    // 尝试 .bat
    const batPath = path.join(dir, commandName + '.bat');
    if (fs.existsSync(batPath)) {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', batPath],
      };
    }
  }

  return null;
}

module.exports = { findExecutableCommand };
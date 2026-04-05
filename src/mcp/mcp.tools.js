'use strict';

/**
 * MCP Tools 定义
 *
 * 向 claude-code 等 MCP 客户端暴露的工具列表。
 * 每个工具包含 name、description、inputSchema（JSON Schema）。
 *
 * 工具调用由 mcp.service.js 路由到对应的 handler。
 */

const TOOLS = [
  {
    name: 'execute_ssh_command',
    description: [
      '在指定的远程 SSH 主机上执行一条 Shell 命令。',
      '命令通过 1Shell 的 SSH 连接池安全执行，凭据由 1Shell 主控端管理，不会暴露给 AI。',
      '返回命令的 stdout、stderr 和退出码。',
      '适用于：查看日志、检查服务状态、安装软件、运行诊断命令等。',
      '注意：避免执行需要交互式输入的命令（如 apt install 时需加 -y 参数）。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        hostId: {
          type: 'string',
          description: '目标主机的 ID（可通过 list_hosts 工具获取）',
        },
        command: {
          type: 'string',
          description: '要执行的 Shell 命令，避免使用需要交互式输入的命令',
        },
        timeout: {
          type: 'number',
          description: '命令执行超时毫秒数（可选，默认 30000ms）',
        },
      },
      required: ['hostId', 'command'],
    },
  },
  {
    name: 'list_hosts',
    description: [
      '列出 1Shell 中配置的所有远程 SSH 主机。',
      '返回每台主机的 ID、名称、地址和端口。',
      '在执行 execute_ssh_command 前，先用此工具确认目标主机的 ID。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

/**
 * 将工具执行结果格式化为 MCP content 数组。
 *
 * @param {string} text - 工具输出文本
 * @param {boolean} [isError] - 是否为错误输出
 * @returns {Array<{type: string, text: string}>}
 */
function makeTextContent(text, isError = false) {
  return [{ type: 'text', text: isError ? `[ERROR] ${text}` : text }];
}

/**
 * 格式化 execute_ssh_command 的执行结果。
 */
function formatExecResult({ stdout, stderr, exitCode, durationMs }) {
  const parts = [];

  if (stdout) parts.push(`[stdout]\n${stdout.trimEnd()}`);
  if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  parts.push(`[exitCode] ${exitCode}`);
  parts.push(`[durationMs] ${durationMs}`);

  return parts.join('\n\n');
}

module.exports = { TOOLS, makeTextContent, formatExecResult };

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
    description: '在远程 SSH 主机上执行 Shell 命令，返回 stdout/stderr/exitCode。非交互式命令请加 -y 等参数。耗时操作（docker pull/build 等）请将 timeout 设为 120000 或更大。',
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
          description: '命令执行超时毫秒数（可选，默认 30000ms，docker pull 等耗时操作建议 120000ms）',
        },
      },
      required: ['hostId', 'command'],
    },
  },
  {
    name: 'list_hosts',
    description: '列出 1Shell 中配置的所有远程 SSH 主机，返回每台主机的 ID、名称、地址和端口。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_mcp_tools',
    description: '列出 1Shell 平台上所有已注册的本地 MCP Server 及其提供的工具。仅在你需要调用第三方 MCP 能力时才使用此工具进行发现。返回每个 MCP 的 id、名称、状态、以及工具列表。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'call_mcp_tool',
    description: '调用 1Shell 平台上某个本地 MCP Server 的指定工具。先用 list_mcp_tools 发现可用工具，再用本工具调用。1Shell 会自动启动目标 MCP（如未运行）、路由调用、返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        mcpId: {
          type: 'string',
          description: '目标 MCP Server 的 ID（通过 list_mcp_tools 获取）',
        },
        toolName: {
          type: 'string',
          description: '要调用的工具名称',
        },
        args: {
          type: 'object',
          description: '工具参数（JSON 对象）',
        },
      },
      required: ['mcpId', 'toolName'],
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

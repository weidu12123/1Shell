'use strict';

const { createOneShellCoreTools } = require('../tools/oneshell-core.tools');

function createMcpTools(deps = {}) {
  return createOneShellCoreTools(deps).getToolSchemas('mcp');
}

function makeTextContent(text, isError = false) {
  return [{ type: 'text', text: isError ? `[ERROR] ${text}` : String(text ?? '') }];
}

function toMcpToolResult(result) {
  const content = result?.content ?? '';
  const isError = !!result?.is_error;
  return { content: makeTextContent(content, false), isError };
}

module.exports = { createMcpTools, makeTextContent, toMcpToolResult };

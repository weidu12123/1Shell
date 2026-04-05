'use strict';

require('dotenv').config();

const path = require('path');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PORT = Math.max(1, parseInt(process.env.PORT || '3301', 10)) || 3301;
const ENV_API_BASE = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const ENV_API_KEY = process.env.OPENAI_API_KEY || '';
const ENV_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const HOSTS_FILE = path.join(ROOT_DIR, 'data', 'hosts.json');
const LOCAL_HOST_ID = 'local';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const SESSION_COOKIE_NAME = 'mvps_console_session';
const SESSION_TTL_MS = Math.max(1, parseInt(process.env.APP_SESSION_TTL_HOURS || '12', 10)) * 60 * 60 * 1000;
const AUTH_PASSWORD = process.env.APP_LOGIN_PASSWORD || '';
const PROBE_TIMEOUT_MS = parsePositiveInt(process.env.PROBE_TIMEOUT_MS, 12000);
const PROBE_INTERVAL_MS = parsePositiveInt(process.env.PROBE_INTERVAL_MS, 15000);
const PROBE_REMOTE_CONCURRENCY = parsePositiveInt(process.env.PROBE_REMOTE_CONCURRENCY, 3);
const AGENT_DEFAULT_PROVIDER = (process.env.AGENT_DEFAULT_PROVIDER || 'claude-code').trim() || 'claude-code';
const AGENT_DEFAULT_COLS = parsePositiveInt(process.env.AGENT_DEFAULT_COLS, 100);
const AGENT_DEFAULT_ROWS = parsePositiveInt(process.env.AGENT_DEFAULT_ROWS, 28);
const AGENT_MAX_SESSIONS_PER_SOCKET = parsePositiveInt(process.env.AGENT_MAX_SESSIONS_PER_SOCKET, 1);

// V6 Bridge & MCP
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();
const BRIDGE_EXEC_TIMEOUT_MS = parsePositiveInt(process.env.BRIDGE_EXEC_TIMEOUT_MS, 30000);

module.exports = {
  AUTH_PASSWORD,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  ENV_API_BASE,
  ENV_API_KEY,
  ENV_MODEL,
  HOSTS_FILE,
  LOCAL_HOST_ID,
  PORT,
  PROBE_INTERVAL_MS,
  PROBE_REMOTE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  ROOT_DIR,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  AGENT_DEFAULT_PROVIDER,
  AGENT_DEFAULT_COLS,
  AGENT_DEFAULT_ROWS,
  AGENT_MAX_SESSIONS_PER_SOCKET,
  BRIDGE_TOKEN,
  BRIDGE_EXEC_TIMEOUT_MS,
};

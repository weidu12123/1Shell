'use strict';

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function parseCookies(cookieHeader = '') {
  return String(cookieHeader || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const index = pair.indexOf('=');
      if (index === -1) return acc;
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizePort(value, fallback = 22) {
  const port = parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

function splitLoad(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  return {
    load1: parseNumber(parts[0]),
    load5: parseNumber(parts[1]),
    load15: parseNumber(parts[2]),
  };
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';

  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

module.exports = {
  createId,
  hasOwn,
  normalizeHttpUrl,
  normalizePort,
  nowIso,
  parseCookies,
  parseNumber,
  splitLoad,
};

'use strict';

const { KEY_PROCESS_NAMES } = require('./commands');

function parseInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function parseProbeOutput(text) {
  const result = {};

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    result[key] = value;
  }

  return result;
}

function parseNetworkBytesText(text, rxKey, txKey) {
  const parsed = parseProbeOutput(text);
  return {
    rxBytes: parseInteger(parsed[rxKey]),
    txBytes: parseInteger(parsed[txKey]),
  };
}

function parseDiskBytesText(text, readKey, writeKey) {
  const parsed = parseProbeOutput(text);
  return {
    diskReadBytes: parseInteger(parsed[readKey]),
    diskWriteBytes: parseInteger(parsed[writeKey]),
  };
}

function parseKeyProcesses(value) {
  if (!KEY_PROCESS_NAMES.length) return [];

  const countMap = new Map();
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const index = item.lastIndexOf(':');
      if (index === -1) return;
      const name = item.slice(0, index).trim();
      const count = parseInteger(item.slice(index + 1));
      countMap.set(name, count || 0);
    });

  return KEY_PROCESS_NAMES.map((name) => {
    const count = countMap.get(name) || 0;
    return {
      name,
      count,
      running: count > 0,
    };
  });
}

module.exports = {
  parseDiskBytesText,
  parseInteger,
  parseKeyProcesses,
  parseNetworkBytesText,
  parseProbeOutput,
};

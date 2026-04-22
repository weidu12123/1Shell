'use strict';

const express = require('express');
const os = require('os');
const { execSync } = require('child_process');
const { ENV_MODEL } = require('../config/env');
const { nowIso } = require('../utils/common');

function getDiskUsage() {
  try {
    if (process.platform === 'win32') {
      // wmic CSV 格式: Node,FreeSpace,Size
      const out = execSync('wmic logicaldisk where "DriveType=3" get Size,FreeSpace /format:csv', { timeout: 3000, encoding: 'utf8' });
      let totalSize = 0, totalFree = 0;
      for (const line of out.trim().split('\n').slice(1)) {
        const parts = line.trim().split(',').filter(Boolean);
        // parts: [Node, FreeSpace, Size]
        if (parts.length >= 3) {
          const free = Number(parts[parts.length - 2]);
          const size = Number(parts[parts.length - 1]);
          if (size > 0) { totalSize += size; totalFree += free; }
        }
      }
      return totalSize > 0 ? +((1 - totalFree / totalSize) * 100).toFixed(1) : null;
    }
    // Linux/macOS: df 根分区
    const out = execSync("df -P / | tail -1 | awk '{print $5}'", { timeout: 3000, encoding: 'utf8' });
    const pct = parseFloat(out);
    return isNaN(pct) ? null : pct;
  } catch {
    return null;
  }
}

function createHealthRouter({ isUsingFallbackSecret }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      model: ENV_MODEL,
      localHost: os.hostname(),
      usingFallbackSecret: isUsingFallbackSecret(),
      time: nowIso(),
    });
  });

  /* 本机简略探针：CPU / 内存 / 负载 */
  router.get('/health/stats', (_req, res) => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadavg = os.loadavg();
    let idle = 0, total = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) total += cpu.times[type];
      idle += cpu.times.idle;
    });
    res.json({
      cpu: total > 0 ? +((1 - idle / total) * 100).toFixed(1) : 0,
      memory: +((1 - freeMem / totalMem) * 100).toFixed(1),
      disk: getDiskUsage(),
      load: cpus.length > 0 ? +(loadavg[0] / cpus.length * 100).toFixed(1) : 0,
    });
  });

  return router;
}

module.exports = {
  createHealthRouter,
};

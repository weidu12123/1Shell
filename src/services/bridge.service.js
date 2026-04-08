'use strict';

const { BRIDGE_EXEC_TIMEOUT_MS } = require('../config/env');

/**
 * Bridge Service
 *
 * 在远端主机执行命令，支持两种模式：
 *   1. 持久 shell（sshShellPool）— MCP 调用优先使用，复用长驻 shell channel
 *   2. exec 模式（sshPool）— 每次 exec 一条命令，作为后备
 *
 * 级联（ProxyJump）逻辑由 hostService.connectToHost 统一处理，本层无感知。
 */
function createBridgeService({ hostService, auditService, sshPool, sshShellPool }) {
  const MIN_TIMEOUT_MS = 30000;

  /**
   * 在指定主机上执行单条命令。
   *
   * @param {string} hostId - 主机 ID
   * @param {string} command - Shell 命令
   * @param {number} [timeoutMs] - 超时毫秒数
   * @param {object} [options]
   * @param {string} [options.source] - 调用来源 ('mcp' | 'bridge_api')
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, durationMs: number}>}
   */
  async function execOnHost(hostId, command, timeoutMs, { source = 'bridge_api', clientIp } = {}) {
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.max(timeoutMs, MIN_TIMEOUT_MS)
      : BRIDGE_EXEC_TIMEOUT_MS;

    const host = hostService.findHost(hostId);
    const hostName = host?.name || hostId;

    // MCP 调用且有持久 shell 池 → 走持久 shell 模式
    if (sshShellPool && source === 'mcp') {
      return execViaShellPool(hostId, command, timeout, { source, hostName, clientIp });
    }

    // 其他调用 → 走 exec 模式（兼容原有逻辑）
    return execViaExec(hostId, command, timeout, { source, hostName, clientIp });
  }

  // ─── 持久 shell 模式 ─────────────────────────────────────────────────────

  async function execViaShellPool(hostId, command, timeout, { source, hostName, clientIp }) {
    const startAt = Date.now();
    try {
      const result = await sshShellPool.exec(hostId, command, timeout);
      auditService?.log({
        action: 'bridge_exec',
        source,
        hostId,
        hostName,
        command: command.substring(0, 2000),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        clientIp,
      });
      return result;
    } catch (err) {
      auditService?.log({
        action: 'bridge_exec',
        source,
        hostId,
        hostName,
        command: command.substring(0, 2000),
        error: err.message,
        durationMs: Date.now() - startAt,
        clientIp,
      });
      throw err;
    }
  }

  // ─── exec 模式（原有逻辑）────────────────────────────────────────────────

  function execViaExec(hostId, command, timeout, { source, hostName, clientIp }) {
    return new Promise((resolve, reject) => {
      const startAt = Date.now();
      let settled = false;
      let timer = null;
      let targetClient = null;
      let proxyClientRef = null;

      const usePool = Boolean(sshPool);

      function cleanup(healthy) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (usePool) {
          if (healthy) sshPool.returnToPool(hostId);
          else sshPool.release(hostId);
        } else {
          try { targetClient?.end(); } catch { /* ignore */ }
          try { proxyClientRef?.end(); } catch { /* ignore */ }
        }
      }

      function settle(result) {
        if (settled) return;
        settled = true;
        cleanup(true);
        auditService?.log({
          action: 'bridge_exec',
          source,
          hostId,
          hostName,
          command: command.substring(0, 2000),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          clientIp,
        });
        resolve(result);
      }

      function fail(err) {
        if (settled) return;
        settled = true;
        cleanup(false);
        auditService?.log({
          action: 'bridge_exec',
          source,
          hostId,
          hostName,
          command: command.substring(0, 2000),
          error: err.message,
          durationMs: Date.now() - startAt,
          clientIp,
        });
        reject(err);
      }

      timer = setTimeout(() => {
        const err = new Error(`命令执行超时 (${timeout}ms): ${command}`);
        err.code = 'EXEC_TIMEOUT';
        fail(err);
      }, timeout);

      const connectFn = usePool
        ? () => sshPool.acquire(hostId, { readyTimeout: timeout })
        : () => hostService.connectToHost(hostId, { readyTimeout: timeout });

      connectFn()
        .then(({ client, proxyClient }) => {
          if (settled) {
            if (usePool) sshPool.returnToPool(hostId);
            else { client.end(); proxyClient?.end(); }
            return;
          }

          targetClient = client;
          proxyClientRef = usePool ? null : proxyClient;

          client.exec(command, (err, stream) => {
            if (err) {
              const execErr = new Error(`SSH exec 失败: ${err.message}`);
              execErr.code = 'SSH_EXEC_ERROR';
              return fail(execErr);
            }

            const stdoutChunks = [];
            const stderrChunks = [];

            stream.on('data', (chunk) => stdoutChunks.push(chunk));
            stream.stderr.on('data', (chunk) => stderrChunks.push(chunk));

            stream.on('close', (code) => {
              settle({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                exitCode: typeof code === 'number' ? code : -1,
                durationMs: Date.now() - startAt,
              });
            });

            stream.on('error', (streamErr) => {
              const e = new Error(`SSH stream 错误: ${streamErr.message}`);
              e.code = 'SSH_STREAM_ERROR';
              fail(e);
            });
          });
        })
        .catch((connectErr) => {
          connectErr.code = connectErr.code || 'SSH_CONNECT_ERROR';
          fail(connectErr);
        });
    });
  }

  return { execOnHost };
}

module.exports = { createBridgeService };
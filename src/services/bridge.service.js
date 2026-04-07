'use strict';

const { BRIDGE_EXEC_TIMEOUT_MS } = require('../config/env');

/**
 * Bridge Service
 *
 * 通过 ssh2 的 exec 模式（非 shell）在远端主机执行命令。
 * 级联（ProxyJump）逻辑由 hostService.connectToHost 统一处理，本层无感知。
 */
function createBridgeService({ hostService, auditService, sshPool }) {
  /**
   * 在指定主机上执行单条命令。
   *
   * @param {string} hostId - 主机 ID
   * @param {string} command - Shell 命令
   * @param {number} [timeoutMs] - 超时毫秒数
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, durationMs: number}>}
   */
  function execOnHost(hostId, command, timeoutMs, { source = 'bridge_api', clientIp } = {}) {
    const MIN_TIMEOUT_MS = 30000;
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.max(timeoutMs, MIN_TIMEOUT_MS)
      : BRIDGE_EXEC_TIMEOUT_MS;

    // 查找主机名用于审计
    const host = hostService.findHost(hostId);
    const hostName = host?.name || hostId;

    return new Promise((resolve, reject) => {
      const startAt = Date.now();
      let settled = false;
      let timer = null;
      let targetClient = null;
      let proxyClientRef = null;

      const usePool = Boolean(sshPool);

      // 每次命令结束后始终关闭连接，避免 SSH 连接复用导致的 half-open 挂起问题
      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (usePool) {
          sshPool.release(hostId);
        } else {
          try { targetClient?.end(); } catch { /* ignore */ }
          try { proxyClientRef?.end(); } catch { /* ignore */ }
        }
      }

      function settle(result) {
        if (settled) return;
        settled = true;
        cleanup();
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
        cleanup();
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
          proxyClientRef = usePool ? null : proxyClient; // 池管理的连接不在这里 end

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

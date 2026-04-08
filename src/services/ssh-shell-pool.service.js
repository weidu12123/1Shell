'use strict';

/**
 * SSH 持久 Shell 池
 *
 * 为每个 hostId 维护一个长驻 SSH 连接 + 交互式 shell channel。
 * 命令通过写入 shell stdin 执行，用唯一边界标记分隔每条命令的输出。
 *
 * 优势（相比 exec 模式）：
 *   - 消除每次命令的 SSH 握手开销
 *   - shell channel 保持环境变量、工作目录等状态
 *   - keepalive 保证连接活跃，不会 half-open
 *
 * 局限：
 *   - stdout/stderr 混合在一起（交互式 shell 不区分）
 *   - 需要通过边界标记解析每条命令的输出范围
 */

const crypto = require('crypto');

const IDLE_TIMEOUT_MS = 120000;  // 空闲 2 分钟后断开
const CONNECT_TIMEOUT_MS = 15000;

function createSshShellPool({ hostService }) {
  // Map<hostId, ShellEntry>
  // ShellEntry: { client, proxyClient, shell, idleTimer, busy, buffer, pendingCmd }
  const pool = new Map();

  // ─── 内部工具 ────────────────────────────────────────────────────────────

  function makeMarker() {
    return `__1SHELL_MARKER_${crypto.randomBytes(6).toString('hex')}__`;
  }

  function destroyEntry(hostId) {
    const entry = pool.get(hostId);
    if (!entry) return;
    pool.delete(hostId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.pendingCmd) {
      entry.pendingCmd.reject(new Error('shell connection closed'));
      entry.pendingCmd = null;
    }
    try { entry.shell?.close(); } catch { /* ignore */ }
    try { entry.client?.end(); } catch { /* ignore */ }
    try { entry.proxyClient?.end(); } catch { /* ignore */ }
  }

  function resetIdleTimer(hostId) {
    const entry = pool.get(hostId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => destroyEntry(hostId), IDLE_TIMEOUT_MS);
  }

  // ─── Shell 数据处理 ──────────────────────────────────────────────────────

  function onShellData(hostId, chunk) {
    const entry = pool.get(hostId);
    if (!entry || !entry.pendingCmd) return;

    entry.buffer += chunk.toString('utf8');

    const { endMarker } = entry.pendingCmd;
    const endPattern = `${endMarker} `;
    const endIdx = entry.buffer.indexOf(endPattern);

    if (endIdx === -1) return;

    // 找到结束标记，提取输出和退出码
    const rawOutput = entry.buffer.substring(0, endIdx);
    const afterMarker = entry.buffer.substring(endIdx + endMarker.length + 1);

    // 退出码在结束标记同一行: __MARKER__ <exitCode>
    const exitCodeMatch = afterMarker.match(/^(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : -1;

    // 清除 buffer 中已处理的部分（包括结束标记行和换行）
    const newlineAfter = afterMarker.indexOf('\n');
    entry.buffer = newlineAfter >= 0 ? afterMarker.substring(newlineAfter + 1) : '';

    // 清理输出：去掉开始标记行
    const { startMarker, resolve: resolveFn, timer } = entry.pendingCmd;
    if (timer) clearTimeout(timer);

    let output = rawOutput;
    const startIdx = output.indexOf(startMarker);
    if (startIdx >= 0) {
      // 跳过开始标记所在行（包括换行符）
      const lineEnd = output.indexOf('\n', startIdx);
      output = lineEnd >= 0 ? output.substring(lineEnd + 1) : '';
    }

    entry.pendingCmd = null;
    entry.busy = false;
    resetIdleTimer(hostId);

    resolveFn({ stdout: output, stderr: '', exitCode });
  }

  // ─── 建立持久 shell ─────────────────────────────────────────────────────

  async function createShellEntry(hostId) {
    const { client, proxyClient } = await hostService.connectToHost(hostId, {
      readyTimeout: CONNECT_TIMEOUT_MS,
    });

    const shell = await new Promise((resolve, reject) => {
      const shellTimer = setTimeout(
        () => reject(new Error('shell channel open timeout')),
        10000,
      );
      client.shell({ term: 'dumb', rows: 200, cols: 200 }, (err, stream) => {
        clearTimeout(shellTimer);
        if (err) return reject(err);
        resolve(stream);
      });
    });

    const entry = {
      client,
      proxyClient,
      shell,
      idleTimer: null,
      busy: false,
      buffer: '',
      pendingCmd: null,
    };

    pool.set(hostId, entry);

    // 监听 shell 数据
    shell.on('data', (chunk) => onShellData(hostId, chunk));

    shell.on('close', () => destroyEntry(hostId));
    shell.on('error', () => destroyEntry(hostId));
    client.on('error', () => destroyEntry(hostId));
    client.on('close', () => destroyEntry(hostId));

    // 等待初始 shell prompt 输出（给 shell 一点初始化时间）
    await new Promise((r) => setTimeout(r, 500));
    // 清空初始 banner/prompt
    entry.buffer = '';

    // 设置 shell 环境：关闭 prompt、echo，让输出更干净
    shell.write('export PS1="" PS2="" PROMPT_COMMAND=""\n');
    shell.write('stty -echo 2>/dev/null\n');
    await new Promise((r) => setTimeout(r, 300));
    entry.buffer = '';

    resetIdleTimer(hostId);
    return entry;
  }

  // ─── 公开 API ────────────────────────────────────────────────────────────

  /**
   * 在指定主机的持久 shell 中执行命令。
   *
   * @param {string} hostId
   * @param {string} command
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, durationMs: number}>}
   */
  async function exec(hostId, command, timeoutMs = 30000) {
    const startAt = Date.now();

    let entry = pool.get(hostId);

    // 如果已有 shell 但正忙，等它完成或超时后销毁重建
    if (entry && entry.busy) {
      destroyEntry(hostId);
      entry = null;
    }

    // 没有可用 shell，新建
    if (!entry) {
      entry = await createShellEntry(hostId);
    }

    const startMarker = makeMarker();
    const endMarker = makeMarker();

    return new Promise((resolve, reject) => {
      entry.busy = true;
      entry.buffer = '';

      const timer = setTimeout(() => {
        if (entry.pendingCmd) {
          entry.pendingCmd = null;
        }
        entry.busy = false;
        // 超时后销毁此 shell（可能 half-open），下次重建
        destroyEntry(hostId);
        const err = new Error(`命令执行超时 (${timeoutMs}ms): ${command}`);
        err.code = 'EXEC_TIMEOUT';
        reject(err);
      }, timeoutMs);

      entry.pendingCmd = {
        startMarker,
        endMarker,
        resolve: (result) => resolve({ ...result, durationMs: Date.now() - startAt }),
        reject: (err) => { clearTimeout(timer); reject(err); },
        timer,
      };

      // 发送命令到 shell:
      // 1. echo 开始标记
      // 2. 执行实际命令
      // 3. echo 结束标记 + 退出码
      const wrappedCommand = [
        `echo '${startMarker}'`,
        command,
        `echo "${endMarker} $?"`,
      ].join('\n');

      entry.shell.write(wrappedCommand + '\n');
    });
  }

  /**
   * 关闭指定主机的持久 shell。
   */
  function release(hostId) {
    destroyEntry(hostId);
  }

  /**
   * 关闭所有持久 shell。
   */
  function closeAll() {
    for (const hostId of [...pool.keys()]) {
      destroyEntry(hostId);
    }
  }

  /**
   * 检查指定主机是否有活跃的持久 shell。
   */
  function has(hostId) {
    return pool.has(hostId);
  }

  return { exec, release, closeAll, has };
}

module.exports = { createSshShellPool };
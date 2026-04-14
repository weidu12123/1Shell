'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 文件浏览服务
 *
 * 支持两种模式：
 * - local：通过 Node.js fs 模块读取本机文件系统
 * - ssh：通过 ssh2 SFTP 读取远程主机文件系统
 *
 * 注意：SFTP 操作使用独立 SSH 连接，不复用 sshPool。
 * sshPool 为 exec 模式设计，SFTP 需要长连接且操作模式不同。
 */
function createFileService({ hostService }) {
  // 应用敏感路径：阻止文件浏览 API 访问自身凭据和配置
  const APP_ROOT = path.resolve(__dirname, '..', '..');
  const SENSITIVE_PATHS = [
    path.join(APP_ROOT, 'data'),
    path.join(APP_ROOT, '.env'),
  ];

  /**
   * 检查路径是否指向应用自身的敏感目录/文件
   */
  function isSensitivePath(targetPath) {
    const resolved = path.resolve(targetPath);
    return SENSITIVE_PATHS.some((sensitive) =>
      resolved === sensitive || resolved.startsWith(sensitive + path.sep),
    );
  }
  /**
   * 获取 Windows 所有可用盘符
   */
  function getWindowsDrives() {
    const drives = [];
    const possibleDrives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const letter of possibleDrives) {
      const drivePath = `${letter}:\\`;
      try {
        fs.accessSync(drivePath);
        drives.push({
          name: `${letter}:\\`,
          path: drivePath,
          isDir: true,
          size: 0,
          mtime: 0,
          isDrive: true,
        });
      } catch {
        // 盘符不存在或不可访问
      }
    }
    return drives;
  }

  /**
   * 列出本机目录内容
   */
  async function listLocal(dirPath) {
    // Windows 下如果 dirPath 为空，返回所有盘符列表
    if (os.platform() === 'win32' && (!dirPath || dirPath.trim() === '')) {
      return {
        path: '此电脑',
        parent: null,
        items: getWindowsDrives(),
        isRoot: true,
      };
    }

    const resolvedPath = dirPath ? path.resolve(dirPath) : os.homedir();

    if (isSensitivePath(resolvedPath)) {
      throw new Error('访问被拒绝：该路径为应用敏感目录');
    }

    const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });

    // 并发 stat 所有文件，避免串行阻塞
    const statResults = await Promise.all(
      entries.map(async (entry) => {
        try {
          const fullPath = path.join(resolvedPath, entry.name);
          if (isSensitivePath(fullPath)) return null;
          const isDir = entry.isDirectory();
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          return {
            name: entry.name,
            path: fullPath,
            isDir,
            size: stat ? stat.size : 0,
            mtime: stat ? stat.mtimeMs : 0,
          };
        } catch {
          return null;
        }
      }),
    );
    const items = statResults.filter(Boolean);

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parentDir = path.dirname(resolvedPath);
    // Windows 盘符根目录的 parent 是自身（如 C:\ 的 dirname 还是 C:\）
    const isDriveRoot = /^[A-Z]:\\$/i.test(resolvedPath);

    return {
      path: resolvedPath,
      parent: isDriveRoot ? null : parentDir,
      items,
      isRoot: isDriveRoot,
    };
  }

  // ─── SFTP 连接池：复用 SSH 连接，避免每次操作都握手 ──────────────────────

  const SFTP_IDLE_TIMEOUT_MS = 120000; // 空闲 2 分钟后断开
  const SFTP_LIVENESS_SKIP_MS = 10000; // 10 秒内用过的连接跳过健康检测
  // Map<hostId, { client, proxyClient, sftp, timer, busy, lastUsed }>
  const sftpPool = new Map();

  function releaseSftp(hostId) {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    sftpPool.delete(hostId);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.sftp?.end(); } catch { /* ignore */ }
    try { entry.client?.end(); } catch { /* ignore */ }
    try { entry.proxyClient?.end(); } catch { /* ignore */ }
  }

  function resetSftpTimer(hostId) {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => releaseSftp(hostId), SFTP_IDLE_TIMEOUT_MS);
  }

  /**
   * 获取可复用的 SFTP 会话
   */
  async function acquireSftp(hostId) {
    const entry = sftpPool.get(hostId);
    if (entry && !entry.busy) {
      // 最近用过的连接直接复用，跳过健康检测
      const recentlyUsed = entry.lastUsed && (Date.now() - entry.lastUsed < SFTP_LIVENESS_SKIP_MS);
      if (recentlyUsed) {
        entry.busy = true;
        entry.lastUsed = Date.now();
        resetSftpTimer(hostId);
        return entry;
      }
      // 空闲较久，快速健康检测
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('sftp liveness timeout')), 3000);
          entry.sftp.realpath('.', (err) => {
            clearTimeout(t);
            if (err) reject(err); else resolve();
          });
        });
        entry.busy = true;
        entry.lastUsed = Date.now();
        resetSftpTimer(hostId);
        return entry;
      } catch {
        releaseSftp(hostId);
      }
    }

    // 新建连接
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 15000 });

    const sftp = await new Promise((resolve, reject) => {
      client.sftp((err, s) => {
        if (err) {
          client.end(); proxyClient?.end();
          return reject(new Error(`SFTP 会话创建失败: ${err.message}`));
        }
        resolve(s);
      });
    });

    client.on('error', () => releaseSftp(hostId));
    client.on('close', () => { sftpPool.delete(hostId); });

    const newEntry = { client, proxyClient, sftp, timer: null, busy: true, lastUsed: Date.now() };
    sftpPool.set(hostId, newEntry);
    resetSftpTimer(hostId);
    return newEntry;
  }

  function returnSftp(hostId) {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    entry.busy = false;
    entry.lastUsed = Date.now();
    resetSftpTimer(hostId);
  }

  /**
   * 通过 SFTP 列出远程目录内容
   */
  async function listRemote(hostId, dirPath) {
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        const targetPath = dirPath || '.';
        const isAbsolute = targetPath.startsWith('/');

        function doReaddir(resolvedPath) {
          sftp.readdir(resolvedPath, (rdErr, list) => {
            if (rdErr) return reject(new Error(`读取目录失败: ${rdErr.message}`));

            const items = list.map((e) => {
              const isDir = e.attrs.isDirectory();
              return {
                name: e.filename,
                path: resolvedPath + '/' + e.filename,
                isDir,
                size: e.attrs.size || 0,
                mtime: (e.attrs.mtime || 0) * 1000,
              };
            });

            items.sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

            const parent = resolvedPath === '/' ? '/' : resolvedPath.replace(/\/[^/]+\/?$/, '') || '/';
            resolve({ path: resolvedPath, parent, items });
          });
        }

        // 绝对路径跳过 realpath，省一次 RTT
        if (isAbsolute) {
          doReaddir(targetPath.replace(/\/+$/, '') || '/');
        } else {
          sftp.realpath(targetPath, (rpErr, absPath) => {
            doReaddir(rpErr ? targetPath : absPath);
          });
        }
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 读取远程文件内容（文本预览，限制大小）
   */
  async function readRemoteFile(hostId, filePath, maxBytes = 512 * 1024) {
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        sftp.stat(filePath, (statErr, stats) => {
          if (statErr) return reject(new Error(`文件不存在: ${statErr.message}`));

          if (stats.size > maxBytes) {
            return reject(new Error(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，最大支持 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 预览`));
          }

          const chunks = [];
          const stream = sftp.createReadStream(filePath, { end: maxBytes });

          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            resolve({
              content: Buffer.concat(chunks).toString('utf8'),
              size: stats.size,
              path: filePath,
            });
          });
          stream.on('error', (readErr) => {
            reject(new Error(`读取文件失败: ${readErr.message}`));
          });
        });
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 读取本机文件内容
   */
  async function readLocalFile(filePath, maxBytes = 512 * 1024) {
    const resolved = path.resolve(filePath);

    if (isSensitivePath(resolved)) {
      throw new Error('访问被拒绝：该文件为应用敏感文件');
    }

    const stat = await fs.promises.stat(resolved);

    if (stat.size > maxBytes) {
      throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 预览`);
    }

    const content = await fs.promises.readFile(resolved, 'utf8');
    return {
      content,
      size: stat.size,
      path: resolved.replace(/\\/g, '/'),
    };
  }

  /**
   * 统一入口：列出目录
   */
  async function listDir(hostId, dirPath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');

    if (host.type === 'local' || host.id === 'local') {
      return listLocal(dirPath);
    }

    return listRemote(hostId, dirPath);
  }

  /**
   * 统一入口：读取文件
   */
  async function readFile(hostId, filePath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');

    if (host.type === 'local' || host.id === 'local') {
      return readLocalFile(filePath);
    }

    return readRemoteFile(hostId, filePath);
  }

  // ─── 文件下载（流式） ────────────────────────────────────────────────────

  /**
   * 下载本机文件，返回可读流和元信息
   */
  async function downloadLocal(filePath) {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) throw new Error('访问被拒绝');
    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) throw new Error('不能下载目录');
    return {
      stream: fs.createReadStream(resolved),
      size: stat.size,
      filename: path.basename(resolved),
    };
  }

  /**
   * 下载远程文件，返回可读流和元信息
   * 注意：下载使用独立连接，因为流生命周期不可控
   */
  async function downloadRemote(hostId, filePath) {
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 15000 });

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end(); proxyClient?.end();
          return reject(new Error(`SFTP 会话创建失败: ${err.message}`));
        }

        sftp.stat(filePath, (statErr, stats) => {
          if (statErr) {
            sftp.end(); client.end(); proxyClient?.end();
            return reject(new Error(`文件不存在: ${statErr.message}`));
          }
          if (stats.isDirectory()) {
            sftp.end(); client.end(); proxyClient?.end();
            return reject(new Error('不能下载目录'));
          }

          const stream = sftp.createReadStream(filePath);
          const filename = filePath.split('/').pop() || 'download';

          stream.on('close', () => {
            sftp.end(); client.end(); proxyClient?.end();
          });
          stream.on('error', () => {
            sftp.end(); client.end(); proxyClient?.end();
          });

          resolve({ stream, size: stats.size, filename });
        });
      });
    });
  }

  /**
   * 统一入口：下载文件
   */
  async function downloadFile(hostId, filePath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return downloadLocal(filePath);
    }
    return downloadRemote(hostId, filePath);
  }

  // ─── 文件上传 ─────────────────────────────────────────────────────────────

  /**
   * 上传文件到本机
   */
  async function uploadLocal(dirPath, filename, buffer) {
    const resolved = path.resolve(dirPath, filename);
    if (isSensitivePath(resolved)) throw new Error('访问被拒绝');
    await fs.promises.writeFile(resolved, buffer);
    return { path: resolved, size: buffer.length };
  }

  /**
   * 上传文件到远程主机
   */
  async function uploadRemote(hostId, dirPath, filename, buffer) {
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        const remotePath = dirPath.endsWith('/') ? dirPath + filename : dirPath + '/' + filename;
        const writeStream = sftp.createWriteStream(remotePath);

        writeStream.on('close', () => {
          resolve({ path: remotePath, size: buffer.length });
        });
        writeStream.on('error', (writeErr) => {
          reject(new Error(`写入文件失败: ${writeErr.message}`));
        });

        writeStream.end(buffer);
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 统一入口：上传文件
   */
  async function uploadFile(hostId, dirPath, filename, buffer) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return uploadLocal(dirPath, filename, buffer);
    }
    return uploadRemote(hostId, dirPath, filename, buffer);
  }

  // ─── 文件写入（编辑保存） ──────────────────────────────────────────────

  /**
   * 写入本机文件
   */
  async function writeLocal(filePath, content) {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) throw new Error('访问被拒绝');
    await fs.promises.writeFile(resolved, content, 'utf8');
    const stat = await fs.promises.stat(resolved);
    return { path: resolved, size: stat.size };
  }

  /**
   * 写入远程文件
   */
  async function writeRemote(hostId, filePath, content) {
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        const writeStream = sftp.createWriteStream(filePath);
        writeStream.on('close', () => {
          sftp.stat(filePath, (statErr, stats) => {
            resolve({ path: filePath, size: statErr ? content.length : stats.size });
          });
        });
        writeStream.on('error', (writeErr) => {
          reject(new Error(`写入文件失败: ${writeErr.message}`));
        });
        writeStream.end(Buffer.from(content, 'utf8'));
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 统一入口：写入文件
   */
  async function writeFile(hostId, filePath, content) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return writeLocal(filePath, content);
    }
    return writeRemote(hostId, filePath, content);
  }

  return {
    listDir,
    readFile,
    downloadFile,
    uploadFile,
    writeFile,
  };
}

module.exports = {
  createFileService,
};

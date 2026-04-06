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

    const items = [];
    for (const entry of entries) {
      const name = entry.name;
      try {
        const fullPath = path.join(resolvedPath, name);
        // 从列表中隐藏应用敏感路径
        if (isSensitivePath(fullPath)) continue;
        const isDir = entry.isDirectory();
        const stat = await fs.promises.stat(fullPath).catch(() => null);

        items.push({
          name,
          path: fullPath,
          isDir,
          size: stat ? stat.size : 0,
          mtime: stat ? stat.mtimeMs : 0,
        });
      } catch {
        // 跳过无权限的文件
      }
    }

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

  /**
   * 建立独立 SSH 连接用于 SFTP 操作
   */
  function connectForSftp(hostId) {
    return hostService.connectToHost(hostId, { readyTimeout: 15000 });
  }

  /**
   * 通过 SFTP 列出远程目录内容
   */
  async function listRemote(hostId, dirPath) {
    const { client, proxyClient } = await connectForSftp(hostId);

    try {
      return await new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(new Error(`SFTP 会话创建失败: ${err.message}`));

          const targetPath = dirPath || '.';

          sftp.realpath(targetPath, (rpErr, absPath) => {
            const resolvedPath = rpErr ? targetPath : absPath;

            sftp.readdir(resolvedPath, (rdErr, list) => {
              if (rdErr) {
                sftp.end();
                return reject(new Error(`读取目录失败: ${rdErr.message}`));
              }

              const items = list.map((entry) => {
                const isDir = entry.attrs.isDirectory();
                return {
                  name: entry.filename,
                  path: resolvedPath + '/' + entry.filename,
                  isDir,
                  size: entry.attrs.size || 0,
                  mtime: (entry.attrs.mtime || 0) * 1000,
                };
              });

              items.sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
              });

              const parent = resolvedPath === '/' ? '/' : resolvedPath.replace(/\/[^/]+\/?$/, '') || '/';

              sftp.end();
              resolve({ path: resolvedPath, parent, items });
            });
          });
        });
      });
    } finally {
      try { client.end(); } catch { /* ignore */ }
      try { proxyClient?.end(); } catch { /* ignore */ }
    }
  }

  /**
   * 读取远程文件内容（文本预览，限制大小）
   */
  async function readRemoteFile(hostId, filePath, maxBytes = 512 * 1024) {
    const { client, proxyClient } = await connectForSftp(hostId);

    try {
      return await new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(new Error(`SFTP 会话创建失败: ${err.message}`));

          sftp.stat(filePath, (statErr, stats) => {
            if (statErr) {
              sftp.end();
              return reject(new Error(`文件不存在: ${statErr.message}`));
            }

            if (stats.size > maxBytes) {
              sftp.end();
              return reject(new Error(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，最大支持 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 预览`));
            }

            const chunks = [];
            const stream = sftp.createReadStream(filePath, { end: maxBytes });

            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              sftp.end();
              resolve({
                content: Buffer.concat(chunks).toString('utf8'),
                size: stats.size,
                path: filePath,
              });
            });
            stream.on('error', (readErr) => {
              sftp.end();
              reject(new Error(`读取文件失败: ${readErr.message}`));
            });
          });
        });
      });
    } finally {
      try { client.end(); } catch { /* ignore */ }
      try { proxyClient?.end(); } catch { /* ignore */ }
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

  return {
    listDir,
    readFile,
  };
}

module.exports = {
  createFileService,
};

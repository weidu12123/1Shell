'use strict';

const express = require('express');

function createFileRouter({ fileService }) {
  const router = express.Router();

  /**
   * GET /api/files/list?hostId=xxx&path=/some/dir
   * 列出指定主机的目录内容
   */
  router.get('/files/list', async (req, res, next) => {
    try {
      const hostId = req.query.hostId || 'local';
      const dirPath = req.query.path || '';
      const result = await fileService.listDir(hostId, dirPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/files/read?hostId=xxx&path=/some/file.txt
   * 读取指定主机的文件内容（文本预览）
   */
  router.get('/files/read', async (req, res, next) => {
    try {
      const hostId = req.query.hostId || 'local';
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.readFile(hostId, filePath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  createFileRouter,
};

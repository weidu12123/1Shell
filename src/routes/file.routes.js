'use strict';

const express = require('express');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function createFileRouter({ fileService }) {
  const router = express.Router();

  /**
   * GET /api/files/list?hostId=xxx&path=/some/dir
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

  /**
   * GET /api/files/download?hostId=xxx&path=/some/file
   */
  router.get('/files/download', async (req, res, next) => {
    try {
      const hostId = req.query.hostId || 'local';
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const { stream, size, filename } = await fileService.downloadFile(hostId, filePath);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Type', 'application/octet-stream');
      if (size) res.setHeader('Content-Length', size);
      stream.pipe(res);
      stream.on('error', (err) => {
        if (!res.headersSent) next(err);
        else res.end();
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/upload
   * Body: multipart/form-data { hostId, dirPath, file }
   */
  router.post('/files/upload', upload.single('file'), async (req, res, next) => {
    try {
      const hostId = req.body.hostId || 'local';
      const dirPath = req.body.dirPath;
      if (!dirPath) {
        return res.status(400).json({ error: '缺少 dirPath 参数' });
      }
      if (!req.file) {
        return res.status(400).json({ error: '缺少上传文件' });
      }
      const result = await fileService.uploadFile(hostId, dirPath, req.file.originalname, req.file.buffer);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/write
   * Body: { hostId, path, content }
   */
  router.post('/files/write', express.json({ limit: '10mb' }), async (req, res, next) => {
    try {
      const { hostId = 'local', path: filePath, content } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      if (typeof content !== 'string') {
        return res.status(400).json({ error: '缺少 content 参数' });
      }
      const result = await fileService.writeFile(hostId, filePath, content);
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

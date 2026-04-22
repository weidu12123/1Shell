'use strict';

const express = require('express');
const log = require('../../lib/logger');
const {
  validateChatRequestBody,
  validateCompletionRequestBody,
  validateTerminalInlineCompletionBody,
  validateAnalyzeSelectionBody,
} = require('../utils/validators');
const { createRateLimiter } = require('../middleware/rate-limiter.middleware');

function createAiRouter(aiService) {
  const router = express.Router();

  // AI 接口限流：每 IP 每分钟最多 30 次请求
  const aiLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 30 });
  // 内联补全更频繁，单独放宽
  const inlineLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 60 });

  function done(res) {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  router.post('/chat', aiLimiter, async (req, res) => {
    let upstream;

    try {
      const body = validateChatRequestBody(req.body);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      upstream = await aiService.createChatUpstream(body);

      if (!upstream.ok) {
        const text = await upstream.text();
        res.write(`data: ${JSON.stringify({ error: `API ${upstream.status}: ${text}` })}\n\n`);
        return res.end();
      }

      let buffer = '';
      upstream.body.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (raw === '[DONE]') {
            done(res);
            return;
          }

          res.write(`data: ${raw}\n\n`);
        }
      });

      upstream.body.on('end', () => {
        done(res);
      });

      upstream.body.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    } catch (error) {
      if (!res.headersSent) {
        return res.status(error.status || 502).json({ error: error.message });
      }

      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }

    req.on('close', () => {
      try { upstream?.body?.destroy(); } catch { /* ignore */ }
    });
  });

  router.post('/complete', aiLimiter, async (req, res, next) => {
    try {
      const completion = await aiService.requestCompletion(validateCompletionRequestBody(req.body));
      res.json({ completion });
    } catch (error) {
      next(error);
    }
  });

  router.post('/ai/terminal/complete-inline', inlineLimiter, async (req, res, next) => {
    try {
      const body = validateTerminalInlineCompletionBody(req.body);
      log.info('终端补全请求', {
        method: req.method,
        url: req.originalUrl,
        hostId: body.hostId,
        currentInputLength: String(body.currentInput || '').length,
        recentCommandsCount: Array.isArray(body.recentCommands) ? body.recentCommands.length : 0,
      });
      const result = await aiService.requestTerminalInlineCompletion(body);
      log.info('终端补全响应', {
        hostId: body.hostId,
        currentInputLength: String(body.currentInput || '').length,
        completionLength: String(result.completion || '').length,
        confidence: result.confidence,
        hasRequestId: Boolean(result.requestId),
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/ai/models', aiLimiter, async (req, res, next) => {
    try {
      const models = await aiService.fetchModelList(req.body || {});
      res.json({ ok: true, models });
    } catch (error) {
      next(error);
    }
  });

  router.post('/ai/terminal/analyze-selection', aiLimiter, async (req, res, next) => {
    try {
      const result = await aiService.analyzeSelection(validateAnalyzeSelectionBody(req.body));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createAiRouter,
};

'use strict';

const { Router } = require('express');
const { validateScriptPayload, validateScriptRunPayload } = require('../utils/validators');

/**
 * Script Routes
 *
 * 所有路由都经过 authService.requireAuth（在 server.js 挂载时已生效）。
 *
 * GET    /api/scripts                    列表，支持 ?category=&keyword=
 * GET    /api/scripts/:id                详情
 * POST   /api/scripts                    新建
 * PUT    /api/scripts/:id                更新
 * DELETE /api/scripts/:id                删除
 * POST   /api/scripts/:id/preview        参数渲染预览（不执行）
 * POST   /api/scripts/:id/run            执行
 * GET    /api/scripts/:id/runs           某脚本的执行历史
 * GET    /api/script-runs                全局执行历史
 * GET    /api/script-runs/:runId         单次执行详情
 */
function createScriptRouter({ scriptService, aiService }) {
  const router = Router();

  // ─── AI 生成脚本（放在 :id 路由前面，避免被 params 匹配） ─────────
  router.post('/scripts/ai-generate', async (req, res, next) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) {
        return res.status(400).json({ error: '请描述你想要的脚本' });
      }
      const result = await aiService.generateScript({ prompt, ...req.body });
      if (result.error) {
        return res.status(422).json({ ok: false, error: result.error });
      }
      return res.json({ ok: true, script: result.script });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 列表 ─────────────────────────────────────────────────────────
  router.get('/scripts', (req, res, next) => {
    try {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
      const scripts = scriptService.listScripts({ category, keyword });
      res.json({ ok: true, scripts });
    } catch (err) {
      next(err);
    }
  });

  // ─── 详情 ─────────────────────────────────────────────────────────
  router.get('/scripts/:id', (req, res, next) => {
    try {
      const script = scriptService.getScript(req.params.id);
      if (!script) return res.status(404).json({ error: '脚本不存在' });
      return res.json({ ok: true, script });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 新建 ─────────────────────────────────────────────────────────
  router.post('/scripts', (req, res, next) => {
    try {
      const payload = validateScriptPayload(req.body);
      const script = scriptService.createScript(payload);
      res.status(201).json({ ok: true, script });
    } catch (err) {
      next(err);
    }
  });

  // ─── 更新 ─────────────────────────────────────────────────────────
  router.put('/scripts/:id', (req, res, next) => {
    try {
      const payload = validateScriptPayload(req.body, { isEditing: true });
      const script = scriptService.updateScript(req.params.id, payload);
      if (!script) return res.status(404).json({ error: '脚本不存在' });
      return res.json({ ok: true, script });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 删除 ─────────────────────────────────────────────────────────
  router.delete('/scripts/:id', (req, res, next) => {
    try {
      const deleted = scriptService.deleteScript(req.params.id);
      if (!deleted) return res.status(404).json({ error: '脚本不存在' });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 预览（渲染命令但不执行） ─────────────────────────────────────
  router.post('/scripts/:id/preview', (req, res, next) => {
    try {
      const script = scriptService.getScript(req.params.id);
      if (!script) return res.status(404).json({ error: '脚本不存在' });

      const params = (req.body && typeof req.body.params === 'object' && !Array.isArray(req.body.params))
        ? req.body.params
        : {};
      const hostId = typeof req.body?.hostId === 'string' ? req.body.hostId : undefined;

      const { rendered, normalizedParams } = scriptService.renderContent(script, params, { hostId });
      const risk = scriptService.checkRisk(script, rendered, { confirmed: true });
      return res.json({
        ok: true,
        renderedCommand: rendered,
        params: normalizedParams,
        riskLevel: script.riskLevel,
        warnings: risk.warnings || [],
      });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 执行 ─────────────────────────────────────────────────────────
  router.post('/scripts/:id/run', async (req, res, next) => {
    try {
      const payload = validateScriptRunPayload(req.body);
      const result = await scriptService.runScript(req.params.id, payload, { clientIp: req.ip });
      res.json({ ok: true, ...result });
    } catch (err) {
      // 需要确认类的错误返回结构化信息，前端据此弹出确认对话框
      if (err.code === 'NEED_CONFIRM') {
        return res.status(409).json({
          ok: false,
          error: err.message,
          needConfirm: true,
          riskLevel: err.riskLevel,
        });
      }
      return next(err);
    }
  });

  // ─── 批量执行 ─────────────────────────────────────────────────────
  router.post('/scripts/:id/run-batch', async (req, res, next) => {
    try {
      const body = req.body || {};
      const hostIds = Array.isArray(body.hostIds) ? body.hostIds.filter((h) => typeof h === 'string' && h) : [];
      if (hostIds.length === 0) {
        return res.status(400).json({ error: 'hostIds 不能为空' });
      }
      const params = (body.params && typeof body.params === 'object' && !Array.isArray(body.params)) ? body.params : {};
      const confirmed = body.confirmed === true;
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
      const concurrency = typeof body.concurrency === 'number' ? body.concurrency : 5;

      const result = await scriptService.runScriptBatch(
        req.params.id,
        { hostIds, params, confirmed, timeoutMs, concurrency },
        { clientIp: req.ip },
      );
      return res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === 'NEED_CONFIRM') {
        return res.status(409).json({ ok: false, error: err.message, needConfirm: true, riskLevel: err.riskLevel });
      }
      return next(err);
    }
  });

  // ─── 某脚本的执行历史 ─────────────────────────────────────────────
  router.get('/scripts/:id/runs', (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const result = scriptService.listRunsByScript(req.params.id, { limit, offset });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ─── 全局执行历史 ─────────────────────────────────────────────────
  router.get('/script-runs', (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const result = scriptService.listAllRuns({ limit, offset });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ─── 单次执行详情 ─────────────────────────────────────────────────
  router.get('/script-runs/:runId', (req, res, next) => {
    try {
      const runId = parseInt(req.params.runId, 10);
      if (!Number.isInteger(runId)) {
        return res.status(400).json({ error: 'runId 必须是整数' });
      }
      const run = scriptService.getRun(runId);
      if (!run) return res.status(404).json({ error: '执行记录不存在' });
      return res.json({ ok: true, run });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createScriptRouter };

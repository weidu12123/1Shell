'use strict';

const { Router } = require('express');

/**
 * Workflow Routes (原 Playbook)
 *
 * 2026-04 重命名：原 `/api/playbooks` → `/api/workflows`。
 * 作为"脚本页多步骤编排"的外部入口。
 * 服务层 playbookService 先保留旧名，后续 Batch B 再连同 DB 表一起改名。
 *
 * GET    /api/workflows              列表
 * GET    /api/workflows/:id          详情
 * POST   /api/workflows              新建
 * PUT    /api/workflows/:id          更新
 * DELETE /api/workflows/:id          删除
 * POST   /api/workflows/:id/run      执行
 * GET    /api/workflow-runs          执行历史
 * GET    /api/workflow-runs/:runId   单次执行详情
 */
function createWorkflowRouter({ playbookService }) {
  const router = Router();

  router.get('/workflows', (req, res, next) => {
    try {
      const workflows = playbookService.listPlaybooks();
      res.json({ ok: true, workflows });
    } catch (err) { next(err); }
  });

  router.get('/workflows/:id', (req, res, next) => {
    try {
      const workflow = playbookService.getPlaybook(req.params.id);
      if (!workflow) return res.status(404).json({ error: 'Workflow 不存在' });
      res.json({ ok: true, workflow });
    } catch (err) { next(err); }
  });

  router.post('/workflows', (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json({ error: 'name 不能为空' });
      }
      if (!Array.isArray(body.steps)) {
        return res.status(400).json({ error: 'steps 必须是数组' });
      }
      for (const step of body.steps) {
        if (!step.scriptId) {
          return res.status(400).json({ error: '每个步骤必须指定 scriptId' });
        }
      }
      const workflow = playbookService.createPlaybook({
        name: body.name.trim(),
        icon: body.icon || '',
        description: body.description || '',
        steps: body.steps,
      });
      res.status(201).json({ ok: true, workflow });
    } catch (err) { next(err); }
  });

  router.put('/workflows/:id', (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json({ error: 'name 不能为空' });
      }
      if (!Array.isArray(body.steps)) {
        return res.status(400).json({ error: 'steps 必须是数组' });
      }
      const workflow = playbookService.updatePlaybook(req.params.id, {
        name: body.name.trim(),
        icon: body.icon || '',
        description: body.description || '',
        steps: body.steps,
      });
      if (!workflow) return res.status(404).json({ error: 'Workflow 不存在' });
      res.json({ ok: true, workflow });
    } catch (err) { next(err); }
  });

  router.delete('/workflows/:id', (req, res, next) => {
    try {
      const deleted = playbookService.deletePlaybook(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Workflow 不存在' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/run', async (req, res, next) => {
    try {
      const run = await playbookService.runPlaybook(req.params.id, { clientIp: req.ip });
      res.json({ ok: true, run });
    } catch (err) { next(err); }
  });

  router.get('/workflow-runs', (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const workflowId = req.query.workflowId || req.query.playbookId || undefined;
      const result = playbookService.listRuns({ playbookId: workflowId, limit, offset });
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

  router.get('/workflow-runs/:runId', (req, res, next) => {
    try {
      const run = playbookService.getRun(Number(req.params.runId));
      if (!run) return res.status(404).json({ error: '执行记录不存在' });
      res.json({ ok: true, run });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createWorkflowRouter, createPlaybookRouter: createWorkflowRouter };
'use strict';

const { Router } = require('express');

/**
 * Playbook Routes
 *
 * GET    /api/playbooks              列表
 * GET    /api/playbooks/:id          详情
 * POST   /api/playbooks              新建
 * PUT    /api/playbooks/:id          更新
 * DELETE /api/playbooks/:id          删除
 * POST   /api/playbooks/:id/run      执行
 * GET    /api/playbook-runs          执行历史
 * GET    /api/playbook-runs/:runId   单次执行详情
 */
function createPlaybookRouter({ playbookService }) {
  const router = Router();

  router.get('/playbooks', (req, res, next) => {
    try {
      const playbooks = playbookService.listPlaybooks();
      res.json({ ok: true, playbooks });
    } catch (err) { next(err); }
  });

  router.get('/playbooks/:id', (req, res, next) => {
    try {
      const playbook = playbookService.getPlaybook(req.params.id);
      if (!playbook) return res.status(404).json({ error: 'Playbook 不存在' });
      res.json({ ok: true, playbook });
    } catch (err) { next(err); }
  });

  router.post('/playbooks', (req, res, next) => {
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
      const playbook = playbookService.createPlaybook({
        name: body.name.trim(),
        icon: body.icon || '',
        description: body.description || '',
        steps: body.steps,
      });
      res.status(201).json({ ok: true, playbook });
    } catch (err) { next(err); }
  });

  router.put('/playbooks/:id', (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json({ error: 'name 不能为空' });
      }
      if (!Array.isArray(body.steps)) {
        return res.status(400).json({ error: 'steps 必须是数组' });
      }
      const playbook = playbookService.updatePlaybook(req.params.id, {
        name: body.name.trim(),
        icon: body.icon || '',
        description: body.description || '',
        steps: body.steps,
      });
      if (!playbook) return res.status(404).json({ error: 'Playbook 不存在' });
      res.json({ ok: true, playbook });
    } catch (err) { next(err); }
  });

  router.delete('/playbooks/:id', (req, res, next) => {
    try {
      const deleted = playbookService.deletePlaybook(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Playbook 不存在' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  router.post('/playbooks/:id/run', async (req, res, next) => {
    try {
      const run = await playbookService.runPlaybook(req.params.id, { clientIp: req.ip });
      res.json({ ok: true, run });
    } catch (err) { next(err); }
  });

  router.get('/playbook-runs', (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const playbookId = req.query.playbookId || undefined;
      const result = playbookService.listRuns({ playbookId, limit, offset });
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

  router.get('/playbook-runs/:runId', (req, res, next) => {
    try {
      const run = playbookService.getRun(Number(req.params.runId));
      if (!run) return res.status(404).json({ error: '执行记录不存在' });
      res.json({ ok: true, run });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createPlaybookRouter };
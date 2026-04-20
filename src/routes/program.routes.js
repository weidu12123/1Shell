'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const { ROOT_DIR } = require('../config/env');

/**
 * Program Routes
 *
 *   GET    /api/programs                        列表（含每个实例最新状态）
 *   POST   /api/programs/reload                 重扫 data/programs/
 *   GET    /api/programs/:id                    详情
 *   GET    /api/programs/:id/instances          该 Program 的所有实例状态
 *   POST   /api/programs/:id/trigger            手动触发
 *     Body: { hostId?: string|'all', triggerId?: string, actionName?: string }
 *   POST   /api/programs/:id/instances/:hostId/enable   启用实例
 *   POST   /api/programs/:id/instances/:hostId/disable  停用实例
 *   GET    /api/program-runs                    运行历史
 *     Query: programId?, hostId?, limit?
 *   GET    /api/program-runs/:runId             单次运行详情
 *   POST   /api/program-runs/:runId/cancel      取消运行
 *   GET    /api/program-runs/active             当前活跃 run 列表
 */
function createProgramRouter({ registry, stateService, engine, hostService }) {
  const router = Router();

  const stripDir = ({ dir, ...rest }) => rest;

  // 把 DB 里没有记录的主机补全为默认实例（enabled=1，无运行历史）
  function mergeInstances(program, dbInstances, allHosts) {
    const hostIds = program.hosts === 'all'
      ? (allHosts || []).map((h) => h.id)
      : (program.hosts || []);
    const byHost = new Map(dbInstances.map((i) => [i.host_id, i]));
    return hostIds.map((hid) => byHost.get(hid) || {
      program_id: program.id,
      host_id: hid,
      enabled: 1,
      last_run_id: null,
      last_status: null,
      last_run_at: null,
      last_trigger_id: null,
    });
  }

  router.get('/programs', (_req, res) => {
    const allHosts = hostService?.listHosts?.() || [];
    const programs = registry.list().map(stripDir);
    for (const p of programs) {
      const db = stateService.listInstances(p.id);
      p.instances = mergeInstances(p, db, allHosts);
      p.enabled = p.instances.some((i) => i.enabled === 1);
    }
    res.json({ ok: true, programs });
  });

  router.post('/programs/reload', (_req, res) => {
    try {
      engine.reload();
      res.json({ ok: true, count: registry.list().length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/programs/:id', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const allHosts = hostService?.listHosts?.() || [];
    const db = stateService.listInstances(program.id);
    const instances = mergeInstances(program, db, allHosts);
    res.json({ ok: true, program: stripDir(program), instances });
  });

  router.get('/programs/:id/instances', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const allHosts = hostService?.listHosts?.() || [];
    const db = stateService.listInstances(program.id);
    res.json({ ok: true, instances: mergeInstances(program, db, allHosts) });
  });

  // GET /api/programs/:id/instances/:hostId/renders — 最近一次 run 的 render 输出
  router.get('/programs/:id/instances/:hostId/renders', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const renders = stateService.getLastRenders(program.id, req.params.hostId);
    res.json({ ok: true, renders });
  });

  router.post('/programs/:id/trigger', async (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });

    const body = req.body || {};
    try {
      const runIds = await engine.triggerManual({
        programId: program.id,
        hostId: body.hostId,
        triggerId: body.triggerId,
        actionName: body.actionName,
      });
      res.json({ ok: true, runIds });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/programs/:id — 删除 Program（停止调度 + 删除文件）
  router.delete('/programs/:id', async (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });

    try {
      const programDir = path.join(ROOT_DIR, 'data', 'programs', program.id);
      if (fs.existsSync(programDir)) {
        fs.rmSync(programDir, { recursive: true, force: true });
      }
      // 删除后重新扫描 registry，停止该 program 的 cron 调度
      engine.reload();
      res.json({ ok: true, deleted: program.id });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/programs/:id/instances/:hostId/enable', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    engine.setInstanceEnabled(program.id, req.params.hostId, true);
    res.json({ ok: true });
  });

  router.post('/programs/:id/instances/:hostId/disable', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    engine.setInstanceEnabled(program.id, req.params.hostId, false);
    res.json({ ok: true });
  });

  router.get('/program-runs/active', (_req, res) => {
    res.json({ ok: true, runs: engine.listActive() });
  });

  router.get('/program-runs', (req, res) => {
    const { programId, hostId, limit } = req.query || {};
    const runs = stateService.listRuns({
      programId: programId || null,
      hostId: hostId || null,
      limit: Number(limit) || 50,
    });
    res.json({ ok: true, runs });
  });

  router.get('/program-runs/:runId', (req, res) => {
    const run = stateService.getRun(Number(req.params.runId));
    if (!run) return res.status(404).json({ ok: false, error: '运行记录不存在' });
    res.json({ ok: true, run });
  });

  router.post('/program-runs/:runId/cancel', (req, res) => {
    engine.cancelRun(Number(req.params.runId));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createProgramRouter };
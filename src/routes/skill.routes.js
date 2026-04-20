'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/env');

/**
 * Skill & Playbook Library Routes
 *
 * 原 skill 路由扩展为"素材库 + 剧本库"双入口，底层共享 library.service。
 *
 * Skill 仓库（可复用能力）：
 *   GET  /api/skills          列表
 *   GET  /api/skills/:id      详情
 *   POST /api/skills/reload   重扫
 *
 * Playbook 仓库（创作台产物）：
 *   GET  /api/playbooks       列表
 *   GET  /api/playbooks/:id   详情
 *   POST /api/playbooks/reload 重扫
 *
 * 注意：Playbook 这里指"智能剧本"，与 scripts 页已改名为 /api/workflows 的
 * 多步骤脚本编排是两回事。
 */
function createSkillRouter({ libraryService, skillRunner }) {
  const router = express.Router();

  const stripDir = (obj) => { if (!obj) return obj; const { dir, ...rest } = obj; return rest; };

  // ── 运行状态（Skill + Playbook 共用） ──────────────────
  router.get('/runs/active', (_req, res) => {
    try {
      const runs = skillRunner?.listActiveRuns?.() || [];
      res.json({ ok: true, runs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/runs/:runId/cancel', (req, res) => {
    try {
      skillRunner?.cancelRun?.(req.params.runId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Skill 仓库 ─────────────────────────────────────
  router.get('/skills', (_req, res) => {
    res.json({ ok: true, skills: libraryService.listSkills() });
  });

  router.get('/skills/:id', (req, res) => {
    const item = libraryService.getItem(req.params.id);
    if (!item || item.kind !== 'skill') {
      return res.status(404).json({ ok: false, error: 'Skill 不存在' });
    }
    res.json({ ok: true, skill: stripDir(item) });
  });

  router.post('/skills/reload', (_req, res) => {
    try {
      const counts = libraryService.reload();
      res.json({ ok: true, ...counts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Playbook 仓库 ──────────────────────────────────
  router.get('/playbooks', (_req, res) => {
    res.json({ ok: true, playbooks: libraryService.listPlaybooks() });
  });

  router.get('/playbooks/:id', (req, res) => {
    const item = libraryService.getItem(req.params.id);
    if (!item || item.kind !== 'playbook') {
      return res.status(404).json({ ok: false, error: 'Playbook 不存在' });
    }
    res.json({ ok: true, playbook: stripDir(item) });
  });

  router.post('/playbooks/reload', (_req, res) => {
    try {
      const counts = libraryService.reload();
      res.json({ ok: true, ...counts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/playbooks/:id — 删除 Playbook 目录
  router.delete('/playbooks/:id', (req, res) => {
    const id = req.params.id;
    const item = libraryService.getItem(id);
    if (!item || item.kind !== 'playbook') {
      return res.status(404).json({ ok: false, error: `Playbook 不存在: ${id}` });
    }
    const dir = path.join(ROOT_DIR, 'data', 'playbooks', id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      libraryService.reload();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/skills/:id — 删除 Skill 目录（禁止删系统 Skill）
  router.delete('/skills/:id', (req, res) => {
    const id = req.params.id;
    const item = libraryService.getItem(id);
    if (!item || item.kind !== 'skill') {
      return res.status(404).json({ ok: false, error: `Skill 不存在: ${id}` });
    }
    if (item.category === 'system') {
      return res.status(403).json({ ok: false, error: '系统 Skill 不允许删除' });
    }
    const dir = path.join(ROOT_DIR, 'data', 'skills', id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      libraryService.reload();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSkillRouter };
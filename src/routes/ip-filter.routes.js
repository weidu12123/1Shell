'use strict';

const express = require('express');

function createIpFilterRouter({ ipFilterService }) {
  const router = express.Router();

  // 查询全部规则 + 当前开关状态
  router.get('/ip-filter', (req, res) => {
    res.json(ipFilterService.getRules());
  });

  // 新增规则
  router.post('/ip-filter/rules', (req, res, next) => {
    try {
      const { type, cidr, note } = req.body || {};
      const rule = ipFilterService.addRule({ type, cidr, note });
      res.status(201).json(rule);
    } catch (e) { next(e); }
  });

  // 删除规则
  router.delete('/ip-filter/rules/:id', (req, res, next) => {
    try {
      ipFilterService.deleteRule(req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // 更新开关状态
  router.patch('/ip-filter/config', (req, res, next) => {
    try {
      const { allowlistEnabled, denylistEnabled } = req.body || {};
      ipFilterService.setConfig({ allowlistEnabled, denylistEnabled });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createIpFilterRouter };
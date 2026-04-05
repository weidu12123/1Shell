'use strict';

const express = require('express');
const path = require('path');

function createApp(rootDir) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(rootDir, 'public')));
  return app;
}

module.exports = {
  createApp,
};

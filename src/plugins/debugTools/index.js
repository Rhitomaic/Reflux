'use strict';

const path = require('node:path');

module.exports = {
  name: 'debugTools',
  displayName: 'Gateway Debug Tools',
  description: 'Captures redacted gateway event summaries in a copyable in-app log.',
  icon: 'DBG',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),
  start() {},
  stop() {},
};
'use strict';

const path = require('node:path');
const {definePlugin, OptionType} = require('../../core/pluginApi');

function start() {
  console.log('[Reflux:MessageLogger] Started (renderer script will be injected).');
}

function stop() {
  console.log('[Reflux:MessageLogger] Stopped.');
}

module.exports = definePlugin({
  name:        'messageLogger',
  displayName: 'Message Logger',
  description: 'Shows deleted and edited messages inline, with optional history persistence.',
  tags:        ['Chat', 'Utility'],
  settings: {
    persistHistory: {
      label:       'Keep history across restarts',
      description: 'Save deleted/edited message history to disk and restore it next launch.',
      type:        OptionType.BOOLEAN,
      default:     false,
    },
  },
  icon:        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49c7.15-8.42,14.27-16.35,22.39-24.57a80,80,0,1,1,1.66,114.75,8,8,0,1,0-11,11.64A96,96,0,1,0,128,32Z"/></svg>',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),
  start,
  stop,
});

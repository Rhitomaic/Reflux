/**
 * src/core/pluginData.js
 *
 * Small JSON storage area for plugin-owned data that is not configuration.
 * Settings live in settings.json; larger, frequently-written plugin state
 * (message history, caches, etc.) lives here instead.
 *
 * Files are stored under `<settings dir>/plugin-data/<plugin-name>.json`.
 * The plugin name is sanitised so a plugin cannot escape the directory with
 * path separators.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {SETTINGS_FILE} = require('./settings.js');

const DATA_DIR = path.join(path.dirname(SETTINGS_FILE), 'plugin-data');

/** @param {string} name */
function _safeName(name) {
  return String(name || 'plugin')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^\.+/, '') || 'plugin';
}

/** @param {string} name */
function _fileFor(name) {
  return path.join(DATA_DIR, `${_safeName(name)}.json`);
}

/**
 * Read a plugin's JSON data.
 * @param {string} name
 * @param {any}    [defaultValue]
 * @returns {any}
 */
function read(name, defaultValue = null) {
  const file = _fileFor(name);
  try {
    if (!fs.existsSync(file)) return defaultValue;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[Reflux:PluginData] Read failed for "${name}":`, err.message);
    return defaultValue;
  }
}

/**
 * Write a plugin's JSON data atomically.
 * @param {string} name
 * @param {any}    value
 */
function write(name, value) {
  const file = _fileFor(name);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, {recursive: true});
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    try {
      fs.renameSync(temp, file);
    } catch (renameErr) {
      // Windows can refuse to replace an existing file. Fall back to a direct
      // write, which is still safe enough for plugin-owned state.
      try { fs.rmSync(file, {force: true}); } catch { /* ignore */ }
      fs.renameSync(temp, file);
      if (renameErr.code !== 'EEXIST' && renameErr.code !== 'EPERM') {
        console.warn(`[Reflux:PluginData] Rename fallback for "${name}":`, renameErr.message);
      }
    }
  } catch (err) {
    try { fs.rmSync(temp, {force: true}); } catch { /* ignore */ }
    console.error(`[Reflux:PluginData] Write failed for "${name}":`, err.message);
  }
}

/** @param {string} name */
function clear(name) {
  try { fs.rmSync(_fileFor(name), {force: true}); }
  catch (err) { console.error(`[Reflux:PluginData] Clear failed for "${name}":`, err.message); }
}

const CH = {
  READ:  'reflux:plugin-data-read',
  WRITE: 'reflux:plugin-data-write',
  CLEAR: 'reflux:plugin-data-clear',
};

/**
 * Register ipcMain handlers for the preload bridge.
 * @param {Electron.IpcMain} ipcMain
 */
function registerIpc(ipcMain) {
  ipcMain.handle(CH.READ,  (_event, name, defaultValue) => read(name, defaultValue));
  ipcMain.handle(CH.WRITE, (_event, name, value)        => { write(name, value); });
  ipcMain.handle(CH.CLEAR, (_event, name)               => { clear(name); });
}

module.exports = {read, write, clear, registerIpc, DATA_DIR};

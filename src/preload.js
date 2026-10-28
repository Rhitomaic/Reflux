/**
 * src/preload.js
 *
 * Reflux preload bootstrap.  Registered at runtime by src/main-inject.mjs via
 * session.setPreloads(); Fluxer's own preload is not modified.
 *
 * Fluxer's preload runs with:
 *   contextIsolation: true
 *   sandbox: true
 *   nodeIntegration: false
 *
 * In this environment we do NOT have access to Node.js core modules.
 * What we CAN do:
 *   • Use Electron's `ipcRenderer` and `contextBridge`.
 *   • Manipulate the isolated-world DOM before Fluxer's preload runs.
 *   • Read/write window properties in the isolated world.
 *
 * The heavy lifting (webpack patching, plugin loading) is done in
 * src/renderer.js which is injected into the MAIN world by src/main-inject.mjs
 * via webContents.executeJavaScript().
 *
 * This preload's job is lighter:
 *   1. Register IPC handlers that relay Reflux settings/plugin commands from
 *      the renderer <-> main process.
 *   2. Expose a `window.refluxBridge` in the main world via contextBridge so
 *      renderer.js plugins can call Electron APIs they wouldn't otherwise have.
 */

'use strict';

const {contextBridge, ipcRenderer} = require('electron');

// ---------------------------------------------------------------------------
// IPC channel constants (must match src/main-inject.mjs)
// ---------------------------------------------------------------------------

const CH = {
  GET_SETTING:    'reflux:get-setting',
  SET_SETTING:    'reflux:set-setting',
  GET_ALL:        'reflux:get-all-settings',
  PLUGIN_LIST:    'reflux:plugin-list',
  PLUGIN_ENABLE:  'reflux:plugin-enable',
  PLUGIN_DISABLE: 'reflux:plugin-disable',
  PLUGIN_RELOAD:  'reflux:plugin-reload',
  PLUGIN_DATA_READ:  'reflux:plugin-data-read',
  PLUGIN_DATA_WRITE: 'reflux:plugin-data-write',
  PLUGIN_DATA_CLEAR: 'reflux:plugin-data-clear',
  PLUGIN_IPC_INVOKE: 'reflux:plugin-ipc-invoke',
  PLUGIN_IPC_EVENT:  'reflux:plugin-ipc-event',
  PLUGIN_IPC_REQUEST: 'reflux:plugin-ipc-request',
  PLUGIN_IPC_RESPONSE: 'reflux:plugin-ipc-response',
};

const _pluginIpcEventListeners = new Set();
const _pluginIpcRequestListeners = new Set();

ipcRenderer.on(CH.PLUGIN_IPC_EVENT, (_event, pluginName, channel, data) => {
  for (const listener of Array.from(_pluginIpcEventListeners)) {
    try { listener(pluginName, channel, data); }
    catch (err) { console.error('[Reflux:Preload] Plugin IPC event listener threw:', err); }
  }
});

ipcRenderer.on(CH.PLUGIN_IPC_REQUEST, async (_event, id, pluginName, channel, args) => {
  let handled = false;
  let value;
  let error = null;
  for (const listener of Array.from(_pluginIpcRequestListeners)) {
    try {
      const result = await listener(pluginName, channel, Array.isArray(args) ? args : []);
      if (result?.handled) {
        handled = true;
        value = result.value;
        break;
      }
    } catch (err) {
      handled = true;
      error = err?.message ?? String(err);
      break;
    }
  }
  if (!handled) error = `No renderer plugin IPC handler for "${pluginName}:${channel}".`;
  ipcRenderer.send(CH.PLUGIN_IPC_RESPONSE, id, !error, value, error);
});

// ---------------------------------------------------------------------------
// Expose bridge to the main world (renderer.js / plugins)
// ---------------------------------------------------------------------------

try {
  contextBridge.exposeInMainWorld('refluxBridge', {
    /** Get a persisted setting (returns a Promise). */
    getSetting: (key, defaultValue) => ipcRenderer.invoke(CH.GET_SETTING, key, defaultValue),

    /** Persist a setting. */
    setSetting: (key, value) => ipcRenderer.invoke(CH.SET_SETTING, key, value),

    /** Get all settings as a plain object. */
    getAllSettings: () => ipcRenderer.invoke(CH.GET_ALL),

    /** List all discovered plugins and their enabled state. */
    listPlugins: () => ipcRenderer.invoke(CH.PLUGIN_LIST),

    /** Enable a named plugin. */
    enablePlugin: (name) => ipcRenderer.invoke(CH.PLUGIN_ENABLE, name),

    /** Disable a named plugin. */
    disablePlugin: (name) => ipcRenderer.invoke(CH.PLUGIN_DISABLE, name),

    /** Reload a named plugin from disk and re-inject its renderer script. */
    reloadPlugin: (name) => ipcRenderer.invoke(CH.PLUGIN_RELOAD, name),

    /** Read plugin-owned JSON data (not settings). */
    readPluginData: (name, defaultValue = null) =>
      ipcRenderer.invoke(CH.PLUGIN_DATA_READ, name, defaultValue),

    /** Write plugin-owned JSON data (not settings). */
    writePluginData: (name, value) =>
      ipcRenderer.invoke(CH.PLUGIN_DATA_WRITE, name, value),

    /** Delete plugin-owned data. */
    clearPluginData: (name) =>
      ipcRenderer.invoke(CH.PLUGIN_DATA_CLEAR, name),

    /** Invoke a native main-process handler registered for a plugin. */
    invokePluginIpc: (pluginName, channel, args = []) =>
      ipcRenderer.invoke(CH.PLUGIN_IPC_INVOKE, pluginName, channel, Array.isArray(args) ? args : [args]),

    /** Subscribe to main -> renderer plugin events. Returns an unsubscribe function. */
    onPluginIpcEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      _pluginIpcEventListeners.add(callback);
      return () => _pluginIpcEventListeners.delete(callback);
    },

    /**
     * Register a renderer-side handler for main -> renderer requests.
     * Return `{handled: true, value}` to claim a request.
     * Returns an unsubscribe function.
     */
    onPluginIpcRequest: (callback) => {
      if (typeof callback !== 'function') return () => {};
      _pluginIpcRequestListeners.add(callback);
      return () => _pluginIpcRequestListeners.delete(callback);
    },

    /** Reflux version string. */
    version: '1.0.0',
  });

  console.log('[Reflux:Preload] refluxBridge exposed.');
} catch (err) {
  console.error('[Reflux:Preload] Failed to expose refluxBridge:', err);
}

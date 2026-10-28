/**
 * src/core/pluginIpc.js
 *
 * Per-plugin native IPC bridge.
 *
 * Main-process plugins register named handlers with `forPlugin(name).handle()`
 * or by exporting `ipcHandlers`. Renderer plugins call them through the
 * preload bridge (`window.__reflux.pluginIpc`), and main-process plugins can
 * push events or requests back into the renderer.
 *
 * Every channel is scoped to a plugin name. A plugin cannot call another
 * plugin's handler by accident because both the main registry and renderer
 * helper include the plugin name in the lookup key.
 */

'use strict';

const CH = {
  INVOKE: 'reflux:plugin-ipc-invoke',
  EVENT: 'reflux:plugin-ipc-event',
  REQUEST: 'reflux:plugin-ipc-request',
  RESPONSE: 'reflux:plugin-ipc-response',
};

/** @type {Map<string, Map<string, Function>>} */
const _handlers = new Map();
/** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
const _pendingRendererRequests = new Map();
let _requestSeq = 0;

function _pluginName(value) {
  return String(value ?? '').trim();
}

function _channelName(value) {
  return String(value ?? '').trim();
}

function _key(pluginName, channel) {
  return `${pluginName}\u0000${channel}`;
}

function _getFluxerWebContents() {
  try {
    const {webContents} = require('electron');
    return webContents.getAllWebContents().filter((wc) => {
      try {
        if (wc.isDestroyed()) return false;
        const url = wc.getURL();
        return url.startsWith('fluxer-app://app') || url.includes('web.fluxer.app');
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function registerHandler(pluginName, channel, handler) {
  const name = _pluginName(pluginName);
  const ch = _channelName(channel);
  if (!name) throw new Error('Plugin IPC handlers require a plugin name.');
  if (!ch) throw new Error('Plugin IPC handlers require a channel.');
  if (typeof handler !== 'function') throw new Error('Plugin IPC handler must be a function.');

  let handlers = _handlers.get(name);
  if (!handlers) {
    handlers = new Map();
    _handlers.set(name, handlers);
  }
  handlers.set(ch, handler);

  return () => {
    const current = _handlers.get(name);
    if (current?.get(ch) === handler) {
      current.delete(ch);
      if (!current.size) _handlers.delete(name);
    }
  };
}

function removeHandler(pluginName, channel) {
  const name = _pluginName(pluginName);
  const ch = _channelName(channel);
  const handlers = _handlers.get(name);
  if (!handlers) return false;
  if (ch) {
    handlers.delete(ch);
    if (!handlers.size) _handlers.delete(name);
    return true;
  }
  _handlers.delete(name);
  return true;
}

function removePlugin(pluginName) {
  return _handlers.delete(_pluginName(pluginName));
}

function hasHandler(pluginName, channel) {
  return Boolean(_handlers.get(_pluginName(pluginName))?.has(_channelName(channel)));
}

function listHandlers(pluginName) {
  return Array.from(_handlers.get(_pluginName(pluginName))?.keys() ?? []);
}

function _sendToRenderer(wc, pluginName, channel, data) {
  if (!wc || wc.isDestroyed?.()) return false;
  try {
    wc.send(CH.EVENT, _pluginName(pluginName), _channelName(channel), data);
    return true;
  } catch (err) {
    console.warn(`[Reflux:PluginIpc] Could not send "${channel}" to renderer:`, err.message);
    return false;
  }
}

function sendToRenderer(webContents, pluginName, channel, data) {
  if (Array.isArray(webContents)) return webContents.map((wc) => _sendToRenderer(wc, pluginName, channel, data));
  return _sendToRenderer(webContents, pluginName, channel, data);
}

function broadcast(pluginName, channel, data) {
  return _getFluxerWebContents().map((wc) => _sendToRenderer(wc, pluginName, channel, data));
}

function requestRenderer(pluginName, channel, args = [], {webContents, timeout = 10000} = {}) {
  const targets = webContents ? [webContents] : _getFluxerWebContents();
  const target = targets[0];
  if (!target) {
    return Promise.reject(new Error('No Fluxer renderer is available for plugin IPC.'));
  }

  const id = `reflux-ipc-${++_requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = timeout > 0
      ? setTimeout(() => {
        _pendingRendererRequests.delete(id);
        reject(new Error(`Plugin IPC request "${channel}" timed out.`));
      }, timeout)
      : null;
    _pendingRendererRequests.set(id, {resolve, reject, timer});
    try {
      target.send(
        CH.REQUEST,
        id,
        _pluginName(pluginName),
        _channelName(channel),
        Array.isArray(args) ? args : [args],
      );
    } catch (err) {
      if (timer) clearTimeout(timer);
      _pendingRendererRequests.delete(id);
      reject(err);
    }
  });
}

function forPlugin(pluginName) {
  const name = _pluginName(pluginName);
  if (!name) throw new Error('forPlugin() requires a plugin name.');
  return {
    pluginName: name,
    handle(channel, handler) { return registerHandler(name, channel, handler); },
    remove(channel) { return removeHandler(name, channel); },
    removeAll() { return removePlugin(name); },
    has(channel) { return hasHandler(name, channel); },
    channels() { return listHandlers(name); },
    send(webContents, channel, data) { return sendToRenderer(webContents, name, channel, data); },
    broadcast(channel, data) { return broadcast(name, channel, data); },
    request(channel, args, options) { return requestRenderer(name, channel, args, options); },
  };
}

function registerIpc(ipcMain) {
  ipcMain.handle(CH.INVOKE, async (_event, pluginName, channel, args) => {
    const name = _pluginName(pluginName);
    const ch = _channelName(channel);
    const handler = _handlers.get(name)?.get(ch);
    if (!handler) {
      throw new Error(`No native IPC handler for "${name}:${ch}".`);
    }
    const list = Array.isArray(args) ? args : (args === undefined ? [] : [args]);
    return await handler(...list);
  });

  ipcMain.on(CH.RESPONSE, (_event, id, ok, value, error) => {
    const pending = _pendingRendererRequests.get(id);
    if (!pending) return;
    _pendingRendererRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(String(error ?? 'Renderer plugin IPC request failed.')));
  });
}

module.exports = {
  CH,
  registerHandler,
  removeHandler,
  removePlugin,
  hasHandler,
  listHandlers,
  sendToRenderer,
  broadcast,
  requestRenderer,
  forPlugin,
  registerIpc,
  _handlers,
};

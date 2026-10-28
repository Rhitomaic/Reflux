/**
 * src/core/pluginManager.js
 *
 * Plugin manager for the main process (src/main-inject.mjs).
 *
 * Discovers all plugins under src/plugins/, checks their enabled state from
 * settings, and exposes IPC handlers so the renderer (and settings UI) can
 * list, enable, and disable plugins at runtime.
 *
 * Note: renderer-side plugins register themselves via
 * `window.__reflux.pluginManager.register()` inside renderer.js / renderer
 * plugin bundles.  This manager handles the *main-process* side only:
 * persisting enabled state and telling the renderer which plugins to activate.
 *
 * A valid plugin module must export:
 *   {
 *     name:        string          — unique id, used as the settings key
 *     description: string
 *     rendererSrc: string|null     — path to the renderer-side plugin JS to inject (or null)
 *     start():     void|Promise<void> — called when plugin enabled (main-process side)
 *     stop():      void|Promise<void> — called when plugin disabled / Reflux unloads
 *   }
 *
 * Per-plugin enabled state: `plugins.<name>.enabled` (default: true).
 */

'use strict';

const fs      = require('node:fs');
const path    = require('node:path');
const settings = require('./settings');
const pluginSchema = require('./pluginSchema');
const pluginSettings = require('./pluginSettings');
const pluginIpc = require('./pluginIpc');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, { module: object, started: boolean }>} */
const _registry = new Map();

const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');

const IPC_CH = {
  LIST:    'reflux:plugin-list',
  ENABLE:  'reflux:plugin-enable',
  DISABLE: 'reflux:plugin-disable',
  RELOAD:  'reflux:plugin-reload',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isEnabled(name) {
  const module = _registry.get(name)?.module;
  if (module?.required) return true;
  return settings.get(`plugins.${name}.enabled`, module?.enabledByDefault ?? true);
}

/**
 * @param {string} pluginDir
 * @returns {object|null}
 */
function _loadPlugin(pluginDir) {
  const indexPath = path.join(pluginDir, 'index.js');
  if (!fs.existsSync(indexPath)) return null;

  let plugin;
  try { plugin = require(indexPath); }
  catch (err) { console.error(`[Reflux:PluginManager] require("${indexPath}") failed:`, err); return null; }

  try { plugin = pluginSchema.normalizePlugin(plugin); }
  catch (err) { console.error(`[Reflux:PluginManager] Invalid plugin at "${pluginDir}":`, err); return null; }

  if (typeof plugin.name !== 'string' || !plugin.name) {
    console.error(`[Reflux:PluginManager] Plugin at "${pluginDir}" missing valid "name".`);
    return null;
  }
  if (typeof plugin.start !== 'function' || typeof plugin.stop !== 'function') {
    console.error(`[Reflux:PluginManager] "${plugin.name}" must export start() and stop().`);
    return null;
  }

  if (plugin.settings.length && !plugin.settingsStore) {
    plugin.settingsStore = pluginSettings.createStore(plugin.name, plugin.settings);
  }

  plugin.nativeIpc = pluginIpc.forPlugin(plugin.name);
  if (!plugin.ipc || typeof plugin.ipc !== 'object') plugin.ipc = plugin.nativeIpc;
  try {
    Object.defineProperty(plugin, '_dir', {
      value: pluginDir,
      configurable: true,
      enumerable: false,
    });
  } catch { /* plugin objects are normally extensible */ }
  return plugin;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and start all enabled plugins.
 */
async function loadAll() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.warn('[Reflux:PluginManager] plugins dir not found:', PLUGINS_DIR);
    return;
  }

  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(PLUGINS_DIR, entry.name);
    const plugin = _loadPlugin(pluginDir);
    if (!plugin) continue;

    const { name } = plugin;
    if (_registry.has(name)) {
      console.warn(`[Reflux:PluginManager] Duplicate plugin name "${name}" — skipping.`);
      continue;
    }

    _registry.set(name, { module: plugin, started: false });

    if (_isEnabled(name)) {
      await startPlugin(name);
    } else {
      console.log(`[Reflux:PluginManager] "${name}" disabled — skipping.`);
    }
  }
}

function _registerPluginIpc(plugin) {
  if (!plugin?.name) return;
  pluginIpc.removePlugin(plugin.name);
  const handlers = plugin.ipcHandlers;
  if (!handlers || typeof handlers !== 'object') return;
  for (const [channel, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue;
    try { pluginIpc.registerHandler(plugin.name, channel, handler); }
    catch (err) { console.error(`[Reflux:PluginManager] Invalid IPC handler "${channel}" for "${plugin.name}":`, err); }
  }
}

async function startPlugin(name) {
  const entry = _registry.get(name);
  if (!entry || entry.started) return;
  if (entry.stopping) await entry.stopping;
  if (entry.started) return;
  if (entry.starting) return entry.starting;
  const promise = (async () => {
    try {
      _registerPluginIpc(entry.module);
      await entry.module.start();
      entry.started = true;
      console.log(`[Reflux:PluginManager] Started "${name}".`);
    } catch (err) {
      pluginIpc.removePlugin(name);
      entry.started = false;
      console.error(`[Reflux:PluginManager] "${name}".start() threw:`, err);
    }
  })();
  entry.starting = promise;
  try { await promise; }
  finally { entry.starting = null; }
}

async function stopPlugin(name) {
  const entry = _registry.get(name);
  if (!entry) {
    pluginIpc.removePlugin(name);
    return;
  }
  if (entry.starting) await entry.starting;
  if (entry.stopping) return entry.stopping;
  if (!entry.started) {
    pluginIpc.removePlugin(name);
    return;
  }
  const promise = (async () => {
    try {
      // stop() may be synchronous or return a Promise. Awaiting both shapes
      // lets plugins flush persistence before hot reload replaces them.
      await entry.module.stop();
      console.log(`[Reflux:PluginManager] Stopped "${name}".`);
    } catch (err) {
      console.error(`[Reflux:PluginManager] "${name}".stop() threw:`, err);
    } finally {
      entry.started = false;
      pluginIpc.removePlugin(name);
    }
  })();
  entry.stopping = promise;
  try { await promise; }
  finally { entry.stopping = null; }
}

async function stopAll() {
  await Promise.allSettled(Array.from(_registry.keys(), (name) => stopPlugin(name)));
}

/**
 * Load a plugin directory that was added after startup.
 * @param {string} pluginDir
 * @returns {Promise<object|null>}
 */
async function loadDirectory(pluginDir) {
  const known = nameForDirectory(pluginDir);
  if (known) return _registry.get(known)?.module ?? null;
  const plugin = _loadPlugin(pluginDir);
  if (!plugin) return null;
  if (_registry.has(plugin.name)) return _registry.get(plugin.name)?.module ?? null;
  _registry.set(plugin.name, {module: plugin, started: false, dir: pluginDir});
  if (_isEnabled(plugin.name)) await startPlugin(plugin.name);
  return plugin;
}

/**
 * Re-read a plugin's index.js, restart it, and return the new module.
 * Renderer re-injection is handled by the caller.
 *
 * @param {string} name
 * @returns {Promise<{name: string, plugin: object|null, enabled: boolean, started: boolean, error?: string}|null>}
 */
async function reload(name) {
  const entry = _registry.get(name);
  if (!entry) return null;

  const pluginDir = entry.dir || entry.module?._dir;
  if (!pluginDir) return {name, plugin: entry.module, enabled: _isEnabled(name), started: entry.started, error: 'Unknown plugin directory.'};

  const wasEnabled = _isEnabled(name);
  const wasStarted = entry.started;
  const indexPath = path.join(pluginDir, 'index.js');
  await stopPlugin(name);
  try { delete require.cache[require.resolve(indexPath)]; }
  catch { /* not cached */ }

  const next = _loadPlugin(pluginDir);
  if (!next || next.name !== name) {
    // Keep the previous module available if the edited file is invalid.
    _registry.set(name, entry);
    if (wasEnabled && wasStarted) await startPlugin(name);
    return {
      name,
      plugin: entry.module,
      enabled: wasEnabled,
      started: Boolean(_registry.get(name)?.started),
      error: 'Reload failed; previous plugin restored.',
    };
  }

  _registry.set(name, {module: next, started: false, dir: pluginDir});
  if (wasEnabled) await startPlugin(name);
  console.log(`[Reflux:PluginManager] Reloaded "${name}".`);
  return {
    name,
    plugin: next,
    enabled: wasEnabled,
    started: Boolean(_registry.get(name)?.started),
  };
}

function directories() {
  return Array.from(_registry.entries())
    .map(([name, entry]) => ({name, dir: entry.dir || entry.module?._dir || null}))
    .filter((entry) => Boolean(entry.dir));
}

function nameForDirectory(pluginDir) {
  const resolved = path.resolve(pluginDir);
  for (const [name, entry] of _registry) {
    const dir = entry.dir || entry.module?._dir;
    if (dir && path.resolve(dir) === resolved) return name;
  }
  return null;
}

async function enablePlugin(name) {
  settings.set(`plugins.${name}.enabled`, true);
  await startPlugin(name);
}

async function disablePlugin(name) {
  settings.set(`plugins.${name}.enabled`, false);
  await stopPlugin(name);
}

function list() {
  return Array.from(_registry.entries()).map(([name, entry]) => ({
    name,
    displayName:      entry.module.displayName || name,
    description:      entry.module.description || '',
    icon:             entry.module.icon || null,
    rendererSrc:      entry.module.rendererSrc || null,
    settings:         Array.isArray(entry.module.settings) ? entry.module.settings : [],
    authors:          entry.module.authors || [],
    tags:             entry.module.tags || [],
    dependencies:     entry.module.dependencies || [],
    required:         Boolean(entry.module.required),
    hidden:           Boolean(entry.module.hidden),
    enabledByDefault: entry.module.enabledByDefault !== false,
    requiresRestart:  Boolean(entry.module.requiresRestart),
    started:          entry.started,
    enabled:          _isEnabled(name),
  }));
}

/**
 * Register ipcMain handlers so the renderer settings UI can manage plugins.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {{ onRendererEnable?: (plugin: object) => Promise<void>,
 *            onRendererDisable?: (name: string) => Promise<void>,
 *            onRendererReload?: (plugin: object) => Promise<void> }} [callbacks]
 *   Optional hooks called after the main-process change so the caller can push
 *   the change into live Fluxer web contents without a restart.
 */
function registerIpc(ipcMain, { onRendererEnable, onRendererDisable, onRendererReload } = {}) {
  ipcMain.handle(IPC_CH.LIST, () => list());

  ipcMain.handle(IPC_CH.ENABLE, async (_e, name) => {
    await enablePlugin(name);
    const entry = _registry.get(name);
    if (onRendererEnable && entry?.module.rendererSrc) {
      await onRendererEnable(entry.module).catch(err =>
        console.error(`[Reflux:PluginManager] onRendererEnable("${name}") threw:`, err));
    }
  });

  ipcMain.handle(IPC_CH.DISABLE, async (_e, name) => {
    await disablePlugin(name);
    if (onRendererDisable) {
      await onRendererDisable(name).catch(err =>
        console.error(`[Reflux:PluginManager] onRendererDisable("${name}") threw:`, err));
    }
  });

  ipcMain.handle(IPC_CH.RELOAD, async (_e, name) => {
    const result = await reload(name);
    if (result?.enabled && !result.error && onRendererReload) {
      await onRendererReload(result.plugin).catch(err =>
        console.error(`[Reflux:PluginManager] onRendererReload("${name}") threw:`, err));
    }
    return result;
  });
}

module.exports = {
  loadAll,
  stopAll,
  startPlugin,
  stopPlugin,
  enablePlugin,
  disablePlugin,
  loadDirectory,
  reload,
  directories,
  nameForDirectory,
  list,
  registerIpc,
};

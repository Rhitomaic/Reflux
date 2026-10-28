/**
 * src/main-inject.mjs
 *
 * Reflux main-process bootstrap.  Injected via a prepended
 * `await import(...)` line into Fluxer's dist/main/index.js.
 *
 * Responsibilities:
 *   1. Wire IPC handlers for settings + plugin management.
 *   2. Strip Content-Security-Policy headers so renderer.js can run.
 *   3. On every new Fluxer renderer dom-ready, inject renderer.js into the
 *      web context (fluxer-app://app/ or https://web.fluxer.app) AND any
 *      enabled plugin renderer scripts.
 *   4. Start main-process-side plugin logic.
 *
 * This file is ESM because Fluxer's main process uses `"type":"module"`.
 */

import {createRequire}  from 'node:module';
import {fileURLToPath}  from 'node:url';
import * as nodePath    from 'node:path';
import * as nodeFs      from 'node:fs';
import {app, ipcMain, session, webContents} from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = nodePath.dirname(__filename);

// CJS require for our own CommonJS modules.
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REFLUX_ROOT    = nodePath.resolve(__dirname, '..');
const RENDERER_PATH  = nodePath.join(REFLUX_ROOT, 'src', 'renderer.js');
const PRELOAD_PATH   = nodePath.join(REFLUX_ROOT, 'src', 'preload.js');
const PLUGIN_SCHEMA_PATH = nodePath.join(REFLUX_ROOT, 'src', 'core', 'pluginSchema.js');

// ---------------------------------------------------------------------------
// Bootstrap core modules
// ---------------------------------------------------------------------------

const settings      = require('./core/settings.js');
const pluginData    = require('./core/pluginData.js');
const pluginManager = require('./core/pluginManager.js');

// Register IPC handlers immediately (before app.whenReady so handlers are in
// place by the time any renderer tries to call them).
settings.registerIpc(ipcMain);
pluginData.registerIpc(ipcMain);
pluginManager.registerIpc(ipcMain, {
  // Inject (or re-inject) a plugin's renderer script into all live Fluxer tabs.
  // The plugin's renderer-side IIFE must reset its own guard flag in stop() for
  // re-injection to take effect after a disable → re-enable cycle.
  async onRendererEnable(plugin) {
    let src;
    try { src = nodeFs.readFileSync(plugin.rendererSrc, 'utf8'); }
    catch (err) {
      console.error(`[Reflux:Main] Cannot read renderer src for "${plugin.name}":`, err.message);
      return;
    }
    for (const wc of getFluxerWebContents()) {
      await wc.executeJavaScript(src).catch(e =>
        console.error(`[Reflux:Main] Live-enable "${plugin.name}" failed:`, e.message));
    }
  },

  // Unregister a plugin from all live Fluxer tabs, calling its stop() in the renderer.
  async onRendererDisable(name) {
    const script = `void window.__reflux?.pluginManager.unregister(${JSON.stringify(name)})`;
    for (const wc of getFluxerWebContents()) {
      await wc.executeJavaScript(script).catch(e =>
        console.error(`[Reflux:Main] Live-disable "${name}" failed:`, e.message));
    }
  },
});

// Plugins are started after app.whenReady() — some (notably invisibleTyping)
// need Electron's session APIs, which cannot be used before the app is ready.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Is this WebContents one of Fluxer's app renderers?
 *
 * Fluxer's packaged desktop app serves the renderer from `fluxer-app://app/`;
 * the browser build uses `https://web.fluxer.app`.  The updater/splash window
 * uses `file://` and must not receive the renderer bootstrap or plugins.
 *
 * @param {Electron.WebContents} wc
 * @returns {boolean}
 */
function isFluxerRenderer(wc) {
  try {
    const url = wc.getURL();
    return url.startsWith('fluxer-app://app') || url.includes('web.fluxer.app');
  } catch {
    return false;
  }
}

/**
 * Return all live Fluxer renderer web contents.
 * Used to push live enable/disable changes without requiring a restart.
 * @returns {Electron.WebContents[]}
 */
function getFluxerWebContents() {
  return webContents.getAllWebContents().filter(wc => {
    try { return !wc.isDestroyed() && isFluxerRenderer(wc); }
    catch { return false; }
  });
}

/** Cache renderer bootstrap contents to avoid re-reading on every new window. */
let _rendererScript = null;
function getRendererScript() {
  if (_rendererScript !== null) return _rendererScript;
  try {
    // pluginSchema.js installs window.__refluxPluginSchema, which renderer.js
    // uses for definePlugin()/OptionType in the web context.
    const schemaScript = nodeFs.readFileSync(PLUGIN_SCHEMA_PATH, 'utf8');
    const rendererScript = nodeFs.readFileSync(RENDERER_PATH, 'utf8');
    _rendererScript = `${schemaScript}\n${rendererScript}`;
    return _rendererScript;
  } catch (err) {
    console.error('[Reflux:Main] Cannot read renderer.js:', err.message);
    return null;
  }
}

/**
 * Inject renderer.js plus all enabled plugin renderer scripts into a WebContents.
 * @param {Electron.WebContents} wc
 */
async function injectAll(wc) {
  if (wc.isDestroyed() || !isFluxerRenderer(wc)) return;

  // 1. Core renderer bootstrap (webpack patcher + plugin manager).
  const core = getRendererScript();
  if (core) {
    await wc.executeJavaScript(core).catch(e =>
      console.error('[Reflux:Main] renderer.js injection failed:', e.message));
  }

  // 2. Per-plugin renderer scripts (if the plugin provides one).
  for (const plugin of pluginManager.list()) {
    if (!plugin.enabled || !plugin.rendererSrc) continue;
    try {
      const src = nodeFs.readFileSync(plugin.rendererSrc, 'utf8');
      await wc.executeJavaScript(src).catch(e =>
        console.error(`[Reflux:Main] Plugin "${plugin.name}" renderer injection failed:`, e.message));
    } catch (err) {
      console.error(`[Reflux:Main] Cannot read renderer src for "${plugin.name}":`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// CSP stripping
// ---------------------------------------------------------------------------

/**
 * Remove Content-Security-Policy and X-Frame-Options headers from all
 * responses in the given session.  Required for executeJavaScript to work
 * against Fluxer's production web app without CSP violations.
 *
 * @param {Electron.Session} targetSession
 */
function stripCsp(targetSession) {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = {...details.responseHeaders};
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'content-security-policy' ||
          lower === 'content-security-policy-report-only' ||
          lower === 'x-frame-options') {
        delete headers[key];
      }
    }
    callback({responseHeaders: headers});
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.on('web-contents-created', (_event, wc) => {
  wc.on('dom-ready', () => {
    if (!settings.get('reflux.enabled', true)) return;
    injectAll(wc);
  });
});

app.whenReady().then(() => {
  // Register our preload via setPreloads() so it runs in the sandboxed preload
  // context without touching Fluxer's preload file.  This is the correct way
  // to inject into a sandboxed Electron preload — require() of arbitrary paths
  // is blocked by the sandbox bundle's restricted module loader.
  session.defaultSession.setPreloads([PRELOAD_PATH]);

  stripCsp(session.defaultSession);

  // Load and start all enabled plugins (main-process side).  This must happen
  // after app ready because plugins may touch Electron session APIs.
  pluginManager.loadAll();

  console.log(
    `[Reflux:Main] Ready. Settings: ${settings.SETTINGS_FILE}\n` +
    `[Reflux:Main] Active plugins: ${pluginManager.list().filter(p => p.started).map(p => p.name).join(', ') || '(none)'}`
  );
}).catch(err => {
  console.error('[Reflux:Main] app.whenReady() error:', err);
});

console.log('[Reflux:Main] Bootstrap loaded.');

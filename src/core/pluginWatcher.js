/**
 * src/core/pluginWatcher.js
 *
 * Small development watcher for plugin source directories.
 *
 * It watches every registered plugin directory and calls `onChange(dir)` after
 * a debounce. A periodic rescan picks up plugin directories that were added
 * after startup. The caller decides whether to reload the main-side plugin and
 * re-inject the renderer bundle.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function start({
  getDirectories,
  onChange,
  debounce = 350,
  rescanInterval = 5000,
} = {}) {
  if (typeof getDirectories !== 'function' || typeof onChange !== 'function') {
    throw new Error('pluginWatcher.start() requires getDirectories and onChange.');
  }

  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map();
  /** @type {Map<string, any>} */
  const timers = new Map();
  let stopped = false;
  let rescanTimer = null;

  const schedule = (dir) => {
    if (stopped) return;
    const key = path.resolve(dir);
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (stopped) return;
      Promise.resolve(onChange(key)).catch((err) =>
        console.error(`[Reflux:Watcher] Reload for "${key}" failed:`, err));
    }, Math.max(50, debounce)));
  };

  const sync = () => {
    if (stopped) return;
    const wanted = new Set();
    for (const entry of getDirectories()) {
      if (!entry?.dir) continue;
      const dir = path.resolve(entry.dir);
      wanted.add(dir);
      if (watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, {persistent: false}, (_event, filename) => {
          if (!filename || /(?:^|[\\/])(?:index|renderer-side)\.js$/i.test(String(filename))) {
            schedule(dir);
          }
        });
        watcher.on?.('error', (err) => {
          console.warn(`[Reflux:Watcher] Watch error for "${dir}":`, err.message);
        });
        watcher.unref?.();
        watchers.set(dir, watcher);
        console.log(`[Reflux:Watcher] Watching ${dir}`);
      } catch (err) {
        console.warn(`[Reflux:Watcher] Could not watch "${dir}":`, err.message);
      }
    }

    for (const [dir, watcher] of Array.from(watchers)) {
      if (wanted.has(dir)) continue;
      try { watcher.close(); } catch { /* ignore */ }
      watchers.delete(dir);
    }
  };

  sync();
  if (rescanInterval > 0) {
    rescanTimer = setInterval(sync, Math.max(1000, rescanInterval));
    rescanTimer.unref?.();
  }

  return {
    refresh: sync,
    stop() {
      if (stopped) return;
      stopped = true;
      if (rescanTimer) clearInterval(rescanTimer);
      rescanTimer = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers.values()) {
        try { watcher.close(); } catch { /* ignore */ }
      }
      watchers.clear();
    },
  };
}

module.exports = {start};

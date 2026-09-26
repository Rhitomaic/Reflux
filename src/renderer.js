/**
 * src/renderer.js
 *
 * Reflux renderer bootstrap.  Injected into Fluxer's web context
 * (https://web.fluxer.app) via webContents.executeJavaScript() from
 * src/main-inject.mjs after CSP headers have been stripped.
 *
 * Responsibilities:
 *   1. Hook into Fluxer's webpack module system (rspack / webpack 5 chunk API)
 *      so plugins can intercept any module by its module ID or by searching
 *      its exports.
 *   2. Expose a global `window.__reflux` API that plugins (and the settings UI)
 *      can use.
 *   3. Load and start all registered renderer-side plugins.
 *
 * ─── Module Patching ──────────────────────────────────────────────────────
 *
 * Fluxer's web bundle uses the Webpack 5 / Rspack chunk push API:
 *   webpackChunkfluxer.push([[chunkId], moduleMap, runtimeCallback])
 *
 * By wrapping the `.push()` method on `webpackChunkfluxer` (the chunk array),
 * we intercept every module factory before it is registered.  We also wrap
 * the `__webpack_require__` function on the runtime to intercept every
 * `require(moduleId)` call in the running app.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

(function refluxRendererBootstrap() {
  'use strict';

  // Guard against double injection.
  if (window.__reflux) return;

  // ---------------------------------------------------------------------------
  // Mini event emitter
  // ---------------------------------------------------------------------------

  /** @type {Map<string, Set<Function>>} */
  const _listeners = new Map();

  const events = {
    on(event, fn) {
      if (!_listeners.has(event)) _listeners.set(event, new Set());
      _listeners.get(event).add(fn);
      return () => _listeners.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      _listeners.get(event)?.forEach(fn => {
        try { fn(...args); } catch (e) { console.error('[Reflux] Event handler threw:', e); }
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Webpack patcher
  // ---------------------------------------------------------------------------

  /**
   * A patch descriptor registered by a plugin.
   * @typedef {{ filter: (exports: any, id: string|number) => boolean, callback: (exports: any, id: string|number) => any }} ModulePatch
   */

  /** @type {ModulePatch[]} */
  const _modulePatches = [];
  const REACT_COMPONENT_PATCH = Symbol('refluxReactComponentPatch');

  /** @type {Function|null}  Webpack's internal require function. */
  let _webpackRequire = null;

  /**
   * Apply all registered patches whose filter matches `exports`.
   * @param {any}           exports
   * @param {string|number} id
   * @returns {any}
   */
  function _applyModulePatches(exports, id) {
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return exports;

    let result = exports;
    for (const { filter, callback } of _modulePatches) {
      try {
        if (filter(result, id)) {
          const next = callback(result, id);
          if (next !== undefined) result = next;
          events.emit('module-patched', id);
        }
      } catch (err) {
        console.error(`[Reflux:Patcher] Patch callback for module "${id}" threw:`, err);
      }
    }
    return result;
  }

  /**
   * Wrap a function component and transform its rendered element.
   * Returning undefined from the callback preserves the original result.
   * @param {Function} component
   * @param {string} displayName
   * @param {Function} callback
   * @returns {Function}
   */
  function _wrapReactComponent(component, displayName, callback) {
    if (typeof component !== 'function' || component[REACT_COMPONENT_PATCH]) return component;

    const wrapped = function refluxPatchedComponent(props) {
      const result = component(props);
      const next = callback(result, props, component);
      return next === undefined ? result : next;
    };

    try {
      Object.defineProperty(wrapped, 'displayName', {
        value: displayName || component.displayName || component.name,
        configurable: true,
      });
      Object.defineProperty(wrapped, REACT_COMPONENT_PATCH, {value: true});
    } catch { /* function metadata is non-essential */ }

    // Preserve common React component statics such as defaultProps and $$typeof.
    for (const key of [...Object.getOwnPropertyNames(component), ...Object.getOwnPropertySymbols(component)]) {
      if (key === 'name' || key === 'length' || key === 'prototype' || key === 'displayName') continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(component, key));
      } catch { /* some function properties are read-only */ }
    }
    return wrapped;
  }

  function _patchReactExports(exports, displayName, callback, changes) {
    const matches = [];
    const isMatch = (value) => value && (value.displayName === displayName || value.name === displayName);

    if (isMatch(exports)) matches.push({owner: null, key: null, component: exports});
    if (exports && typeof exports === 'object') {
      for (const key of Object.keys(exports)) {
        if (isMatch(exports[key])) matches.push({owner: exports, key, component: exports[key]});
      }
    }

    for (const match of matches) {
      const wrapped = _wrapReactComponent(match.component, displayName, callback);
      if (wrapped === match.component) continue;
      if (match.owner) match.owner[match.key] = wrapped;
      else exports = wrapped;
      changes.push({...match, wrapped});
    }
    return exports;
  }

  /**
   * Wrap webpack's `__webpack_require__` so every module load goes through our
   * patch pipeline.
   * @param {Function} wpRequire
   */
  function _wrapWebpackRequire(wpRequire) {
    _webpackRequire = wpRequire;

    const originalRequire = wpRequire.bind({});

    // Copy all static properties (m, c, d, n, o, p, …).
    Object.assign(originalRequire, wpRequire);

    // Replace the function on the runtime object — but we can't replace the
    // reference inside closures.  Instead we wrap the module cache getter so
    // every cached access is also patched.
    if (wpRequire.c) {
      // webpack 5 module cache.
      const cache = wpRequire.c;
      const handler = {
        get(target, id) {
          const mod = target[id];
          if (mod && mod.exports !== undefined) {
            mod.exports = _applyModulePatches(mod.exports, id);
          }
          return mod;
        },
      };
      try {
        Object.defineProperty(wpRequire, 'c', {
          get: () => new Proxy(cache, handler),
          configurable: true,
        });
      } catch {
        // Some environments don't allow redefining; silently continue.
      }
    }
  }

  /**
   * Hook into the webpack chunk push API.
   *
   * The chunk array is named `webpackChunkfluxer` (derived from the `output.
   * chunkLoadingGlobal` rspack config, which defaults to `webpackChunk` +
   * camelCase package name).  We try multiple possible names.
   *
   * Each push call has the shape:
   *   [chunkIds, moduleMap, runtimeFn]
   * where moduleMap is `{ [moduleId]: (module, exports, require) => void }`.
   */
  function _hookChunkPush() {
    const CHUNK_ARRAY_NAMES = ['webpackChunkfluxer', 'webpackChunk', 'webpackChunkapp'];

    for (const name of CHUNK_ARRAY_NAMES) {
      _tryHookChunkArray(name);
    }

    // Also watch for the chunk array to be created later (lazy loading).
    const _definedArrays = new Set(CHUNK_ARRAY_NAMES);
    const _origDefineProperty = Object.defineProperty.bind(Object);

    // Proxy `Object.defineProperty` on window to catch new chunk arrays.
    // Only active until the first chunk array is found.
    const _cleanup = () => { Object.defineProperty = _origDefineProperty; };
    Object.defineProperty = function(obj, prop, descriptor) {
      const result = _origDefineProperty(obj, prop, descriptor);
      if (obj === window && !_definedArrays.has(prop) && prop.startsWith('webpackChunk')) {
        _definedArrays.add(prop);
        _tryHookChunkArray(prop);
      }
      return result;
    };

    // Clean up the Object.defineProperty hook after a short delay.
    setTimeout(_cleanup, 5000);
  }

  /**
   * @param {string} arrayName
   */
  function _tryHookChunkArray(arrayName) {
    const _chunkArray = window[arrayName];

    // Process any chunks already loaded.
    if (Array.isArray(_chunkArray)) {
      for (const chunk of _chunkArray) {
        _processChunk(chunk);
      }
    }

    // Create (or re-create) the array with a wrapped push.
    const proxy = new Proxy(_chunkArray ?? [], {
      get(target, prop) {
        if (prop === 'push') {
          return function reflux_chunkPush(chunk) {
            _processChunk(chunk);
            return Array.prototype.push.call(target, chunk);
          };
        }
        return target[prop];
      },
    });

    window[arrayName] = proxy;
  }

  /**
   * Process a single webpack chunk, wrapping all module factories in it.
   * @param {any[]} chunk  [chunkIds, moduleMap, runtimeFn?]
   */
  function _processChunk(chunk) {
    if (!Array.isArray(chunk) || chunk.length < 2) return;
    const moduleMap = chunk[1];
    if (!moduleMap || typeof moduleMap !== 'object') return;

    for (const id of Object.keys(moduleMap)) {
      const originalFactory = moduleMap[id];
      if (typeof originalFactory !== 'function') continue;

      moduleMap[id] = function reflux_moduleFactory(module, exports, require) {
        // Capture the webpack require if we don't have it yet.
        if (!_webpackRequire && typeof require === 'function') {
          _wrapWebpackRequire(require);
        }

        originalFactory(module, exports, require);

        // Apply patches after the factory ran and populated module.exports.
        module.exports = _applyModulePatches(module.exports, id);
      };

      // Preserve the original factory's properties (e.g. webpack flags).
      Object.assign(moduleMap[id], originalFactory);
    }

    // Also intercept the runtime callback (3rd element) to grab __webpack_require__.
    if (typeof chunk[2] === 'function') {
      const originalRuntime = chunk[2];
      chunk[2] = function reflux_runtime(require) {
        if (!_webpackRequire && typeof require === 'function') {
          _wrapWebpackRequire(require);
        }
        return originalRuntime(require);
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Public patcher API
  // ---------------------------------------------------------------------------

  const patcher = {
    /**
     * Register a module patch.  `filter` is called for every loaded module;
     * if it returns true, `callback` receives the exports and may return a
     * modified version.
     *
     * @param {(exports: any, id: string|number) => boolean} filter
     * @param {(exports: any, id: string|number) => any}     callback
     * @returns {() => void}  Unregister function.
     */
    patch(filter, callback) {
      const descriptor = { filter, callback };
      _modulePatches.push(descriptor);
      return () => {
        const idx = _modulePatches.indexOf(descriptor);
        if (idx !== -1) _modulePatches.splice(idx, 1);
      };
    },

    /**
     * Convenience: patch a module that has a specific export key.
     * @param {string}                           exportKey
     * @param {(exports: any, id: any) => any}   callback
     * @returns {() => void}
     */
    patchByExportKey(exportKey, callback) {
      return this.patch(
        (exports) => exports && typeof exports === 'object' && exportKey in exports,
        callback
      );
    },

    /**
     * Find the first already-loaded module whose exports contain all keys.
     * @param {...string} props
     * @returns {any|null}
     */
    findByProps(...props) {
      return this.findModules((exports) => {
        if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return false;
        return props.every((prop) => prop in exports);
      })[0]?.exports ?? null;
    },

    /**
     * Find the first already-loaded function export by name or displayName.
     * @param {string} name
     * @returns {Function|null}
     */
    findByName(name) {
      const matches = this.findModules((exports) => {
        const isMatch = (value) => value && (value.displayName === name || value.name === name);
        return isMatch(exports) || (exports && typeof exports === 'object' && Object.values(exports).some(isMatch));
      });
      const exports = matches[0]?.exports;
      if (!exports) return null;
      if (exports.displayName === name || exports.name === name) return exports;
      return Object.values(exports).find((value) => value && (value.displayName === name || value.name === name)) ?? null;
    },

    /**
     * Find the first loaded module whose webpack factory source contains all snippets.
     * @param {...string} snippets
     * @returns {any|null}
     */
    findByCode(...snippets) {
      if (!_webpackRequire?.c || !_webpackRequire?.m) return null;
      for (const [id, module] of Object.entries(_webpackRequire.c)) {
        const factory = _webpackRequire.m[id];
        if (!module?.exports || typeof factory !== 'function') continue;
        let source;
        try { source = Function.prototype.toString.call(factory); }
        catch { continue; }
        if (snippets.every((snippet) => source.includes(snippet))) return module.exports;
      }
      return null;
    },

    /** Run a callback before an object's method. Callback receives the mutable args array. */
    before(target, method, callback) {
      return _patchMethod(target, method, (args, original, context) => {
        callback.apply(context, [args]);
        return original.apply(context, args);
      });
    },

    /** Run a callback after an object's method. A returned value replaces the result. */
    after(target, method, callback) {
      return _patchMethod(target, method, (args, original, context) => {
        const result = original.apply(context, args);
        const next = callback.apply(context, [args, result]);
        return next === undefined ? result : next;
      });
    },

    /** Replace an object's method. Callback receives the args array and bound original. */
    instead(target, method, callback) {
      return _patchMethod(target, method, (args, original, context) =>
        callback.apply(context, [args, original.bind(context)])
      );
    },

    /**
     * Convenience: patch a module that has a specific display name (React components).
     * @param {string}                           displayName
     * @param {(exports: any, id: any) => any}   callback
     * @returns {() => void}
     */
    patchByDisplayName(displayName, callback) {
      return this.patch(
        (exports) => {
          if (!exports) return false;
          const check = (v) => v && (v.displayName === displayName || v.name === displayName);
          return check(exports) || (typeof exports === 'object' && Object.values(exports).some(check));
        },
        callback
      );
    },

    /**
     * Wrap function React components matching `displayName` and transform
     * their rendered element. Callback receives `(result, props, original)`.
     * Returning undefined keeps the original rendered element.
     *
     * @param {string} displayName
     * @param {(result: any, props: any, original: Function) => any} callback
     * @returns {() => void} Unregister function.
     */
    patchReactComponent(displayName, callback) {
      const moduleChanges = new Map();
      const matchesReactComponent = (exports) => {
        const isMatch = (value) => value && (value.displayName === displayName || value.name === displayName);
        return isMatch(exports) || (exports && typeof exports === 'object' && Object.values(exports).some(isMatch));
      };
      const unpatchModule = this.patch(
        matchesReactComponent,
        (exports, id) => {
          const changes = [];
          const patched = _patchReactExports(exports, displayName, callback, changes);
          if (changes.length) moduleChanges.set(id, changes);
          return patched;
        },
      );

      // Renderer plugins usually load after Fluxer has already initialized.
      if (_webpackRequire?.c) {
        for (const [id, module] of Object.entries(_webpackRequire.c)) {
          if (module?.exports && matchesReactComponent(module.exports)) {
            const changes = [];
            _patchReactExports(module.exports, displayName, callback, changes);
            if (changes.length) moduleChanges.set(id, changes);
          }
        }
      }

      return () => {
        unpatchModule();
        for (const [id, changes] of moduleChanges) {
          for (const change of changes) {
            if (change.owner) {
              if (change.owner[change.key] === change.wrapped) change.owner[change.key] = change.component;
            } else {
              const module = _webpackRequire?.c?.[id];
              if (module?.exports === change.wrapped) module.exports = change.component;
            }
          }
        }
        moduleChanges.clear();
      };
    },

    /**
     * Find already-loaded modules matching `filter`.  Useful for plugins that
     * start after the target module was already registered.
     * @param {(exports: any, id: any) => boolean} filter
     * @returns {Array<{ id: string|number, exports: any }>}
     */
    findModules(filter) {
      if (!_webpackRequire?.c) return [];
      const result = [];
      for (const [id, mod] of Object.entries(_webpackRequire.c)) {
        try {
          if (mod?.exports && filter(mod.exports, id)) result.push({ id, exports: mod.exports });
        } catch { /* ignore */ }
      }
      return result;
    },

    events,
  };

  function _patchMethod(target, method, invoke) {
    if (!target || typeof target[method] !== 'function') return () => {};
    const original = target[method];
    const patched = function refluxPatchedMethod(...args) {
      return invoke(args, original, this);
    };
    target[method] = patched;
    return () => {
      if (target[method] === patched) target[method] = original;
    };
  }

  let _uiNavigationInProgress = false;

  const ui = {
    find(selector, root = document) {
      return root?.querySelector?.(selector) ?? null;
    },

    findAll(selector, root = document) {
      return root?.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
    },

    findByText(text, root = document, exact = false) {
      const needle = String(text).trim();
      return this.findAll('*', root).find((element) => {
        const value = element.textContent?.trim() ?? '';
        return value && (exact ? value === needle : value.includes(needle)) &&
          !Array.from(element.children).some((child) => child.textContent?.trim() === value);
      }) ?? null;
    },

    findByRole(role, name, root = document) {
      const selector = `[role="${CSS.escape(String(role))}"]`;
      const elements = this.findAll(selector, root);
      if (name === undefined) return elements[0] ?? null;
      const needle = String(name).trim().toLowerCase();
      return elements.find((element) =>
        (element.getAttribute('aria-label') || element.textContent || '').trim().toLowerCase().includes(needle)
      ) ?? null;
    },

    waitFor(selector, {root = document, timeout = 10000} = {}) {
      const existing = this.find(selector, root);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        let settled = false;
        const observer = new MutationObserver(() => {
          const element = this.find(selector, root);
          if (!element || settled) return;
          settled = true;
          observer.disconnect();
          if (timer) clearTimeout(timer);
          resolve(element);
        });
        observer.observe(root === document ? document.documentElement : root, {childList: true, subtree: true});
        const timer = timeout > 0 ? setTimeout(() => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          resolve(null);
        }, timeout) : null;
      });
    },

    click(target, root = document) {
      const element = typeof target === 'string' ? this.find(target, root) : target;
      if (!element || typeof element.click !== 'function') return false;
      element.click();
      return true;
    },

    injectCSS(id, cssText) {
      const styleId = `reflux-style-${id}`;
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement('style');
        style.id = styleId;
        document.head.appendChild(style);
      }
      style.textContent = String(cssText);
      return () => {
        if (style?.parentNode) style.remove();
      };
    },

    navigate(to, {replace = false, state = null} = {}) {
      const url = new URL(to, window.location.href);
      _uiNavigationInProgress = true;
      try { window.history[replace ? 'replaceState' : 'pushState'](state, '', url.href); }
      finally { _uiNavigationInProgress = false; }
      window.dispatchEvent(new PopStateEvent('popstate', {state}));
      return url;
    },

    onNavigate(callback) {
      const notify = (event) => callback(new URL(window.location.href), event);
      const unpatchPush = _patchMethod(window.history, 'pushState', (args, original, context) => {
        const result = original.apply(context, args);
        if (!_uiNavigationInProgress) notify(new Event('reflux:navigate'));
        return result;
      });
      const unpatchReplace = _patchMethod(window.history, 'replaceState', (args, original, context) => {
        const result = original.apply(context, args);
        if (!_uiNavigationInProgress) notify(new Event('reflux:navigate'));
        return result;
      });
      window.addEventListener('popstate', notify);
      window.addEventListener('hashchange', notify);
      return () => {
        unpatchPush();
        unpatchReplace();
        window.removeEventListener('popstate', notify);
        window.removeEventListener('hashchange', notify);
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Plugin registry (renderer-side)
  // ---------------------------------------------------------------------------

  /** @type {Map<string, { plugin: object, stop: Function|null }>} */
  const _plugins = new Map();

  const pluginManager = {
    /**
     * Register and start a renderer-side plugin.
     * @param {{ name: string, start: (patcher, api) => (Function|void) }} plugin
     */
    register(plugin) {
      if (_plugins.has(plugin.name)) {
        console.warn(`[Reflux] Plugin "${plugin.name}" already registered.`);
        return;
      }
      let stop = null;
      try {
        stop = plugin.start(patcher, __reflux) ?? null;
        _plugins.set(plugin.name, { plugin, stop });
        console.log(`[Reflux] Plugin "${plugin.name}" started.`);
      } catch (err) {
        console.error(`[Reflux] Plugin "${plugin.name}" failed to start:`, err);
      }
    },

    unregister(name) {
      const entry = _plugins.get(name);
      if (!entry) return;
      try { entry.stop?.(); } catch (err) { console.error(`[Reflux] "${name}" stop() threw:`, err); }
      _plugins.delete(name);
    },

    list: () => Array.from(_plugins.keys()),
  };

  // ---------------------------------------------------------------------------
  // Global API
  // ---------------------------------------------------------------------------

  const __reflux = {
    version:       '1.0.0',
    patcher,
    ui,
    pluginManager,
    events,
  };

  Object.defineProperty(window, '__reflux', {
    value:        __reflux,
    writable:     false,
    configurable: false,
    enumerable:   false,
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  _hookChunkPush();

  console.log('[Reflux:Renderer] Bootstrapped. Webpack hook active.');
})();

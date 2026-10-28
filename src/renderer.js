/**
 * src/renderer.js
 *
 * Reflux renderer bootstrap.  Injected into Fluxer's web context
 * (fluxer-app://app/ in the desktop app, https://web.fluxer.app in the browser)
 * via webContents.executeJavaScript() from src/main-inject.mjs after CSP
 * headers have been stripped.
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

  // Shared plugin schema, injected immediately before this script by
  // src/main-inject.mjs. The fallback keeps the renderer bootable if someone
  // injects renderer.js on its own.
  const pluginSchema = window.__refluxPluginSchema;
  const OptionType = pluginSchema?.OptionType ?? Object.freeze({
    STRING:    'string',
    NUMBER:    'number',
    BOOLEAN:   'boolean',
    SELECT:    'select',
    SLIDER:    'slider',
    COMPONENT: 'component',
    CUSTOM:    'custom',
  });
  const normalizeSettings = pluginSchema?.normalizeSettings ?? ((settings) => Array.isArray(settings)
    ? settings
    : Object.entries(settings ?? {}).map(([key, setting]) => ({key, label: key, type: 'string', ...setting})));
  const settingsToDef = pluginSchema?.settingsToDef ?? ((settings) => Object.fromEntries(
    normalizeSettings(settings).map((setting) => [setting.key, setting]),
  ));
  const coerceSettingValue = pluginSchema?.coerceSettingValue ?? ((_setting, value) => value);
  const normalizePluginDefinition = pluginSchema?.normalizePlugin ?? ((plugin) => plugin);
  const mergeSettings = pluginSchema?.mergeSettings ?? ((base, override) =>
    [...normalizeSettings(base), ...normalizeSettings(override)]);

  if (!pluginSchema) {
    console.error('[Reflux] pluginSchema.js was not injected before renderer.js; using fallback schema helpers.');
  }

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
  // Plugin settings API
  // ---------------------------------------------------------------------------

  /** @type {Map<string, Array<object>>} */
  const _settingsSchemas = new Map();
  /** @type {Map<string, object>} */
  const _settingsStores = new Map();
  /** Populated by the React kit once it is available. */
  let _reactRuntime = null;

  function fullSettingKey(pluginName, key) {
    return `plugins.${pluginName}.${key}`;
  }

  function emitSettingChanged(pluginName, key, value) {
    const fullKey = fullSettingKey(pluginName, key);
    events.emit('setting-changed', fullKey, value);
    try {
      window.dispatchEvent(new CustomEvent('reflux:setting-changed', {detail: {key: fullKey, value}}));
    } catch { /* CustomEvent is not essential */ }
  }

  function registerSettingsSchema(pluginName, settingsSchema) {
    if (!pluginName) return [];
    const previous = _settingsSchemas.get(pluginName) ?? [];
    const next = settingsSchema === undefined
      ? previous
      : mergeSettings(previous, settingsSchema);
    _settingsSchemas.set(pluginName, next);
    return next;
  }

  /**
   * Create (or reuse) a reactive per-plugin settings store.
   *
   * @param {string} pluginName
   * @param {Array<object>|Record<string, object>} [settingsSchema]
   * @returns {object}
   */
  function createSettingsStore(pluginName, settingsSchema) {
    if (!pluginName) throw new Error('createSettingsStore() requires a plugin name.');

    const existing = _settingsStores.get(pluginName);
    if (existing) {
      if (settingsSchema !== undefined) existing.updateSchema(settingsSchema);
      return existing;
    }

    const definitions = registerSettingsSchema(pluginName, settingsSchema);
    const def = settingsToDef(definitions);
    const plain = {};
    for (const setting of Object.values(def)) {
      plain[setting.key] = coerceSettingValue(setting, setting.default);
    }

    const listeners = new Set();

    function notify(key, value) {
      for (const listener of listeners) {
        try { listener(key, value, plain); }
        catch (err) { console.error(`[Reflux:Settings] "${pluginName}" listener threw:`, err); }
      }
    }

    function runOnChange(key, value) {
      const setting = def[key];
      if (typeof setting?.onChange !== 'function') return;
      try { setting.onChange.call(store, value); }
      catch (err) { console.error(`[Reflux:Settings] "${pluginName}.${key}" onChange threw:`, err); }
    }

    async function setValue(key, value) {
      if (!(key in def)) throw new Error(`Unknown setting "${pluginName}.${key}".`);
      const next = coerceSettingValue(def[key], value);
      const previous = plain[key];

      plain[key] = next;
      notify(key, next);
      emitSettingChanged(pluginName, key, next);
      runOnChange(key, next);

      const bridge = window.refluxBridge;
      if (bridge?.setSetting) {
        try { await bridge.setSetting(fullSettingKey(pluginName, key), next); }
        catch (err) {
          plain[key] = previous;
          notify(key, previous);
          emitSettingChanged(pluginName, key, previous);
          throw err;
        }
      }
      return next;
    }

    const store = new Proxy(plain, {
      get(target, property, receiver) {
        if (property === 'plain') return plain;
        if (property === 'def') return def;
        if (property === 'store') return store;
        if (property === 'toJSON') return () => ({...plain});
        return Reflect.get(target, property, receiver);
      },
      set(target, property, value) {
        if (typeof property === 'string' && property in def) {
          setValue(property, value).catch(err =>
            console.error(`[Reflux:Settings] "${pluginName}.${property}" save failed:`, err));
          return true;
        }
        target[property] = value;
        return true;
      },
      has(target, property) {
        return property in target || property in def ||
          property === 'plain' || property === 'def' || property === 'store';
      },
    });

    function updateSchema(nextSchema) {
      if (nextSchema === undefined) return api;
      const merged = registerSettingsSchema(pluginName, nextSchema);
      const nextDef = settingsToDef(merged);
      Object.assign(def, nextDef);
      for (const [key, setting] of Object.entries(nextDef)) {
        if (!(key in plain)) plain[key] = coerceSettingValue(setting, setting.default);
      }
      return api;
    }

    const ready = (async () => {
      try {
        const all = await window.refluxBridge?.getAllSettings?.() ?? {};
        const values = all?.plugins?.[pluginName];
        if (values && typeof values === 'object') {
          for (const setting of Object.values(def)) {
            if (Object.prototype.hasOwnProperty.call(values, setting.key)) {
              plain[setting.key] = coerceSettingValue(setting, values[setting.key]);
            }
          }
        }
      } catch (err) {
        console.warn(`[Reflux:Settings] Could not hydrate "${pluginName}" settings:`, err);
      }
      notify(null, plain);
      return plain;
    })();

    const api = {
      def,
      plain,
      store,
      ready,
      get(key) { return key in def ? plain[key] : undefined; },
      set(key, value) { return setValue(key, value); },
      getAll() { return {...plain}; },
      updateSchema,
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      toJSON() { return {...plain}; },
      use(filter) {
        const React = _reactRuntime;
        if (!React?.useReducer || !React?.useEffect) {
          throw new Error('settingsStore.use() requires __reflux.react.ready to resolve first.');
        }

        const keys = Array.isArray(filter) ? filter : null;
        const [, forceUpdate] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => api.subscribe((key) => {
          if (!keys || key === null || keys.includes(key)) forceUpdate();
        }), []);
        return keys
          ? Object.fromEntries(keys.map((key) => [key, plain[key]]))
          : {...plain};
      },
    };

    _settingsStores.set(pluginName, api);
    return api;
  }

  const settings = {
    createStore: createSettingsStore,
    getStore(pluginName) { return _settingsStores.get(pluginName) ?? null; },
    getSchema(pluginName) { return _settingsSchemas.get(pluginName) ?? []; },
    registerSchema: registerSettingsSchema,
    get(pluginName, key, defaultValue) {
      const store = _settingsStores.get(pluginName);
      if (store) {
        const value = store.get(key);
        return value === undefined ? defaultValue : value;
      }
      return window.refluxBridge?.getSetting(fullSettingKey(pluginName, key), defaultValue)
        ?? defaultValue;
    },
    set(pluginName, key, value) {
      const store = _settingsStores.get(pluginName);
      if (store) return store.set(key, value);
      return window.refluxBridge?.setSetting(fullSettingKey(pluginName, key), value);
    },
  };

  /**
   * Normalize a plugin definition and automatically create its settings store.
   * Renderer plugins can use this the same way main-process plugins use
   * src/core/pluginApi.js.
   */
  function definePlugin(definition) {
    const plugin = normalizePluginDefinition(definition);
    if (Array.isArray(plugin.settings) && plugin.settings.length) {
      plugin.settingsStore = createSettingsStore(plugin.name, plugin.settings);
    }
    return plugin;
  }

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
  let _webpackReadySettled = false;
  let _resolveWebpackReady = null;
  const _webpackReady = new Promise((resolve) => { _resolveWebpackReady = resolve; });
  const _webpackReadyListeners = new Set();

  function onWebpackReady(listener) {
    if (typeof listener !== 'function') return () => {};
    if (_webpackReadySettled) {
      try { listener(_webpackRequire); } catch (err) { console.error('[Reflux:Webpack] onReady listener threw:', err); }
      return () => {};
    }
    _webpackReadyListeners.add(listener);
    return () => _webpackReadyListeners.delete(listener);
  }

  function _markWebpackReady() {
    if (_webpackReadySettled) return;
    _webpackReadySettled = true;
    _resolveWebpackReady?.(_webpackRequire);
    for (const listener of Array.from(_webpackReadyListeners)) {
      _webpackReadyListeners.delete(listener);
      try { listener(_webpackRequire); }
      catch (err) { console.error('[Reflux:Webpack] onReady listener threw:', err); }
    }
  }

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
    _markWebpackReady();

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
     * Find the first already-loaded module containing a nested export with all
     * of the given properties. Fluxer commonly exposes store singletons as
     * `exports.A`, `exports.default`, etc., so the shallow `findByProps()`
     * helper is not enough for stores and managers.
     *
     * @param {...string} props
     * @returns {any|null}
     */
    findByPropsDeep(...props) {
      return _firstNestedExport((value) => _hasProps(value, props))?.value ?? null;
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
    ready: _webpackReady,
    onReady: onWebpackReady,
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

  // ---------------------------------------------------------------------------
  // Flux / gateway event bus and store discovery
  // ---------------------------------------------------------------------------

  const GATEWAY_PATCH = Symbol('refluxGatewayPatch');

  /** @type {Map<string, Set<Function>>} */
  const _gatewayBeforeListeners = new Map();
  /** @type {Map<string, Set<Function>>} */
  const _gatewayAfterListeners = new Map();
  /** @type {Set<object>} */
  const _gatewayInstances = new Set();

  let _gatewaySettled = false;
  let _resolveGatewayReady = null;
  const _gatewayReady = new Promise((resolve) => { _resolveGatewayReady = resolve; });
  let _lastGatewayEvent = null;
  let _gatewayScanTimer = null;

  /**
   * Return a module export and its immediate values (exports.A, exports.default,
   * etc.). Stores and singletons usually live one level below the namespace.
   * Property getters are deliberately not invoked.
   */
  function _nestedExportValues(exports) {
    const values = [];
    const seen = new Set();
    const add = (value) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
      seen.add(value);
      values.push(value);
    };

    add(exports);
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return values;

    let keys = [];
    try { keys = Reflect.ownKeys(exports); } catch { /* exotic proxies */ }
    for (const key of keys) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(exports, key); } catch { continue; }
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) add(descriptor.value);
    }
    return values;
  }

  function _hasProps(value, props) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try { return props.every((prop) => prop in value); } catch { return false; }
  }

  function _firstNestedExport(predicate) {
    for (const match of patcher.findModules(() => true)) {
      for (const value of _nestedExportValues(match.exports)) {
        try {
          if (predicate(value, match.exports, match.id)) {
            return {id: match.id, exports: match.exports, value};
          }
        } catch { /* ignore hostile getters and proxies */ }
      }
    }
    return null;
  }

  const STORE_MATCHERS = {
    messages(value) {
      return typeof value?.getMessage === 'function' &&
        (typeof value.getMessages === 'function' ||
         typeof value.handleMessageDelete === 'function' ||
         typeof value.handleMessageUpdate === 'function');
    },
    channels(value) {
      return typeof value?.getChannel === 'function' &&
        (typeof value.hasChannel === 'function' ||
         typeof value.getChannelId === 'function' ||
         typeof value.getChannelIds === 'function' ||
         typeof value.getChannelMessages === 'function' ||
         typeof value.getGuildChannels === 'function' ||
         typeof value.getChannels === 'function');
    },
    users(value) {
      return typeof value?.getUser === 'function';
    },
    guilds(value) {
      return typeof value?.getGuild === 'function';
    },
  };

  const STORE_ALIASES = new Map([
    ['message', 'messages'],
    ['messageStore', 'messages'],
    ['channel', 'channels'],
    ['channelStore', 'channels'],
    ['user', 'users'],
    ['userStore', 'users'],
    ['guild', 'guilds'],
    ['guildStore', 'guilds'],
  ]);

  /** @type {Map<string, object>} */
  const _registeredStores = new Map();
  /** @type {Map<string, object>} */
  const _storeCache = new Map();
  /** @type {Map<string, number>} */
  const _storeMisses = new Map();

  function _resolveStoreName(name) {
    const key = String(name ?? '');
    return STORE_ALIASES.get(key) ?? key;
  }

  function findStore(nameOrPredicate) {
    if (typeof nameOrPredicate === 'string') {
      const name = _resolveStoreName(nameOrPredicate);
      if (_registeredStores.has(name)) return _registeredStores.get(name);
      if (_storeCache.has(name)) {
        const cached = _storeCache.get(name);
        if (cached && (!STORE_MATCHERS[name] || STORE_MATCHERS[name](cached))) return cached;
        _storeCache.delete(name);
      }
      const matcher = STORE_MATCHERS[name];
      if (!matcher) return null;
      const missedAt = _storeMisses.get(name);
      if (missedAt && Date.now() - missedAt < 1000) return null;
      const found = _firstNestedExport((value) => matcher(value));
      if (found?.value) {
        _storeCache.set(name, found.value);
        _storeMisses.delete(name);
      } else {
        _storeMisses.set(name, Date.now());
      }
      return found?.value ?? null;
    }

    if (typeof nameOrPredicate !== 'function') return null;
    for (const match of patcher.findModules(() => true)) {
      for (const value of _nestedExportValues(match.exports)) {
        try {
          if (nameOrPredicate(value)) return value;
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  function registerStore(name, store) {
    if (!name || !store) throw new Error('registerStore() requires a name and a store object.');
    const key = _resolveStoreName(name);
    _registeredStores.set(key, store);
    _storeCache.set(key, store);
    _storeMisses.delete(key);
    return () => {
      if (_registeredStores.get(key) === store) _registeredStores.delete(key);
      if (_storeCache.get(key) === store) _storeCache.delete(key);
    };
  }

  function waitForStore(nameOrPredicate, {timeout = 15000, interval = 250} = {}) {
    const existing = findStore(nameOrPredicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const found = findStore(nameOrPredicate);
        if (found || (timeout > 0 && Date.now() - started >= timeout)) {
          clearInterval(timer);
          resolve(found ?? null);
        }
      }, Math.max(50, interval));
    });
  }

  function subscribeToStore(store, listener) {
    if (!store || typeof listener !== 'function') return () => {};
    const bind = (method, removeMethod) => {
      if (typeof store[method] !== 'function') return null;
      const result = store[method](listener);
      if (typeof result === 'function') return result;
      if (removeMethod && typeof store[removeMethod] === 'function') {
        return () => store[removeMethod](listener);
      }
      return () => {};
    };

    const direct = bind('subscribe') || bind('addChangeListener', 'removeChangeListener') ||
      bind('addListener', 'removeListener');
    if (direct) return direct;

    // MobX stores expose observe(), but it is less uniform than a listener API.
    if (typeof store.observe === 'function') {
      try {
        const disposal = store.observe(() => listener());
        if (typeof disposal === 'function') return disposal;
        if (typeof disposal?.dispose === 'function') return () => disposal.dispose();
      } catch { /* not a MobX observable */ }
    }
    return () => {};
  }

  function _gatewayEventMeta(socket, event) {
    const type = event?.type ?? event?.t ?? null;
    const data = event?.data ?? event?.d ?? event ?? null;
    return {type, data, event, socket, at: Date.now()};
  }

  function _callGatewayListeners(map, type, data, meta) {
    const exact = map.get(type);
    if (exact) {
      for (const listener of Array.from(exact)) {
        try { listener(data, meta); }
        catch (err) { console.error(`[Reflux:Flux] Gateway "${type}" listener threw:`, err); }
      }
    }
    const wildcard = map.get('*');
    if (wildcard) {
      for (const listener of Array.from(wildcard)) {
        try { listener(type, data, meta); }
        catch (err) { console.error('[Reflux:Flux] Gateway wildcard listener threw:', err); }
      }
    }
  }

  function _emitGateway(phase, meta) {
    _lastGatewayEvent = {...meta, phase};
    _callGatewayListeners(
      phase === 'after' ? _gatewayAfterListeners : _gatewayBeforeListeners,
      meta.type,
      meta.data,
      meta,
    );
    events.emit(phase === 'after' ? 'gateway-after' : 'gateway-before', meta);
    events.emit('gateway', {...meta, phase});
  }

  function _markGatewayReady() {
    if (_gatewaySettled) return;
    _gatewaySettled = true;
    _resolveGatewayReady?.(gateway);
    events.emit('gateway-ready', gateway);
  }

  function _patchGatewayInstance(instance) {
    if (!instance) return false;
    let target = instance;
    let original = instance.handleGatewayDispatch;
    if (typeof original !== 'function') return false;

    // Some Fluxer builds keep the method on the prototype. Patching the
    // prototype once is enough and avoids creating a property on every
    // per-account gateway instance.
    if (!Object.prototype.hasOwnProperty.call(instance, 'handleGatewayDispatch')) {
      const proto = Object.getPrototypeOf(instance);
      if (proto && typeof proto.handleGatewayDispatch === 'function') target = proto;
    }

    if (target[GATEWAY_PATCH]) {
      _gatewayInstances.add(instance);
      return false;
    }

    original = target.handleGatewayDispatch;
    const patched = function refluxGatewayDispatch(socket, event, ...rest) {
      const meta = _gatewayEventMeta(socket, event);
      _emitGateway('before', meta);
      try {
        return original.call(this, socket, event, ...rest);
      } finally {
        _emitGateway('after', meta);
      }
    };

    try {
      Object.defineProperty(target, GATEWAY_PATCH, {value: patched, configurable: true});
      target.handleGatewayDispatch = patched;
    } catch (err) {
      console.warn('[Reflux:Flux] Could not patch gateway dispatch:', err);
      return false;
    }

    _gatewayInstances.add(instance);
    _markGatewayReady();
    console.log('[Reflux:Flux] Gateway dispatch hook installed.');
    return true;
  }

  function discoverGateway() {
    const found = _firstNestedExport((value) => typeof value?.handleGatewayDispatch === 'function');
    if (found?.value) _patchGatewayInstance(found.value);
    return found?.value ?? null;
  }

  function _gatewayOn(map, event, listener) {
    if (typeof listener !== 'function') return () => {};
    const key = String(event || '*');
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(listener);
    return () => map.get(key)?.delete(listener);
  }

  const gateway = {
    /** Fires before Fluxer processes a gateway event. */
    on(event, listener) { return _gatewayOn(_gatewayBeforeListeners, event, listener); },
    /** Fires after Fluxer has processed a gateway event. */
    after(event, listener) { return _gatewayOn(_gatewayAfterListeners, event, listener); },
    onAny(listener) { return _gatewayOn(_gatewayBeforeListeners, '*', listener); },
    once(event, listener) {
      const off = this.on(event, (data, meta) => {
        off();
        listener(data, meta);
      });
      return off;
    },
    ready: _gatewayReady,
    get patched() { return _gatewaySettled; },
    get instances() { return Array.from(_gatewayInstances); },
    get lastEvent() { return _lastGatewayEvent; },
    discover: discoverGateway,
  };

  const flux = {
    gateway,

    /** Subscribe to a gateway event before Fluxer handles it. */
    on(event, listener) { return gateway.on(event, listener); },
    /** Subscribe to a gateway event after Fluxer has handled it. */
    after(event, listener) { return gateway.after(event, listener); },
    onAny(listener) { return gateway.onAny(listener); },
    once(event, listener) { return gateway.once(event, listener); },

    findStore,
    getStore(name) { return findStore(name); },
    waitForStore,
    registerStore,
    subscribe: subscribeToStore,

    /** Publish a plugin-local event on the shared Reflux event bus. */
    emit(event, data) {
      events.emit(`flux:${event}`, data);
      events.emit('flux', event, data);
    },

    get messageStore() { return findStore('messages'); },
    get channelStore() { return findStore('channels'); },
    get userStore() { return findStore('users'); },
    get guildStore() { return findStore('guilds'); },

    useStore(store, selector) {
      const React = _react;
      if (!React?.useReducer || !React?.useEffect) {
        throw new Error('flux.useStore() requires __reflux.react.ready to resolve first.');
      }
      const [, forceUpdate] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => subscribeToStore(store, forceUpdate), [store]);
      return typeof selector === 'function' ? selector(store) : store;
    },
  };

  const stores = {
    get messages() { return findStore('messages'); },
    get channels() { return findStore('channels'); },
    get users() { return findStore('users'); },
    get guilds() { return findStore('guilds'); },
    find: findStore,
    get: findStore,
    waitFor: waitForStore,
    register: registerStore,
  };

  onWebpackReady(() => {
    if (discoverGateway()) return;
    // Stores can be instantiated lazily after their defining module loads, so
    // keep a low-frequency scan running until the gateway is discovered.
    _gatewayScanTimer = setInterval(() => {
      if (discoverGateway() && _gatewayScanTimer) {
        clearInterval(_gatewayScanTimer);
        _gatewayScanTimer = null;
      }
    }, 3000);
  });

  // Also try immediately in case webpack was captured before this section ran.
  discoverGateway();

  let _uiNavigationInProgress = false;


  // ---------------------------------------------------------------------------
  // React + Fluxer component kit
  // ---------------------------------------------------------------------------

  let _react = null;
  let _reactDOM = null;
  let _errorBoundaryClass = null;
  let _resolveReactReady = null;
  let _reactReadySettled = false;
  const _reactReady = new Promise((resolve) => { _resolveReactReady = resolve; });
  const _reactRoots = new WeakMap();
  const _componentCache = new Map();

  function reactCandidateFromExports(exports) {
    if (!exports) return null;
    const candidates = [exports, exports.default, exports.React, exports.react];
    for (const candidate of candidates) {
      if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) continue;
      if (typeof candidate.createElement === 'function' &&
          typeof candidate.useState === 'function' &&
          typeof candidate.useEffect === 'function' &&
          typeof candidate.createContext === 'function' &&
          typeof candidate.Component === 'function' &&
          candidate.Fragment !== undefined) {
        return candidate;
      }
    }
    return null;
  }

  function reactDOMCandidateFromExports(exports) {
    if (!exports) return null;
    const candidates = [exports, exports.default];
    for (const candidate of candidates) {
      if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) continue;
      if (typeof candidate.createRoot === 'function' &&
          (typeof candidate.flushSync === 'function' || typeof candidate.hydrateRoot === 'function')) {
        return candidate;
      }
      if (typeof candidate.render === 'function' && typeof candidate.unmountComponentAtNode === 'function') {
        return candidate;
      }
    }
    return null;
  }

  function settleReactReady(value) {
    if (_reactReadySettled) return;
    _reactReadySettled = true;
    _resolveReactReady?.(value);
  }

  function installReact(React) {
    if (_react || !React) return;
    _react = React;
    _reactRuntime = React;
    _errorBoundaryClass = createErrorBoundaryClass(React);
    components.ErrorBoundary = ErrorBoundary;
    settleReactReady(React);
    console.log('[Reflux:React] React runtime discovered.');
  }

  function installReactDOM(ReactDOM) {
    if (_reactDOM || !ReactDOM) return;
    _reactDOM = ReactDOM;
    console.log('[Reflux:React] ReactDOM runtime discovered.');
  }

  function findReactNow() {
    const matches = patcher.findModules((exports) => Boolean(reactCandidateFromExports(exports)));
    for (const match of matches) {
      const React = reactCandidateFromExports(match.exports);
      if (React) { installReact(React); return true; }
    }
    return false;
  }

  function findReactDOMNow() {
    const matches = patcher.findModules((exports) => Boolean(reactDOMCandidateFromExports(exports)));
    for (const match of matches) {
      const ReactDOM = reactDOMCandidateFromExports(match.exports);
      if (ReactDOM) { installReactDOM(ReactDOM); return true; }
    }
    return false;
  }

  function watchForReact() {
    if (findReactNow()) return;
    let unpatch = null;
    unpatch = patcher.patch(
      (exports) => Boolean(reactCandidateFromExports(exports)),
      (exports) => {
        const React = reactCandidateFromExports(exports);
        if (React) {
          installReact(React);
          try { unpatch?.(); } catch { /* already removed */ }
        }
      },
    );
  }

  function watchForReactDOM() {
    if (findReactDOMNow()) return;
    let unpatch = null;
    unpatch = patcher.patch(
      (exports) => Boolean(reactDOMCandidateFromExports(exports)),
      (exports) => {
        const ReactDOM = reactDOMCandidateFromExports(exports);
        if (ReactDOM) {
          installReactDOM(ReactDOM);
          try { unpatch?.(); } catch { /* already removed */ }
        }
      },
    );
  }

  function createErrorBoundaryClass(React) {
    return class RefluxErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = {error: null};
      }

      static getDerivedStateFromError(error) {
        return {error};
      }

      componentDidCatch(error, info) {
        const name = this.props?.name || 'plugin component';
        console.error(`[Reflux] ${name} failed to render:`, error, info);
        try { this.props?.onError?.(error, info); }
        catch (err) { console.error('[Reflux] ErrorBoundary onError threw:', err); }
      }

      render() {
        if (this.state.error) {
          const fallback = this.props?.fallback;
          if (typeof fallback === 'function') return fallback(this.state.error);
          return fallback === undefined ? null : fallback;
        }
        return this.props?.children ?? null;
      }
    };
  }

  function ErrorBoundary(props) {
    if (!_react) return props?.children ?? null;
    const Bound = _errorBoundaryClass ?? (_errorBoundaryClass = createErrorBoundaryClass(_react));
    return _react.createElement(Bound, props);
  }

  function normalizeReactElement(element) {
    if (!_react) throw new Error('React runtime is not ready. Await __reflux.react.ready first.');
    return _react.isValidElement(element) ? element : _react.createElement(element);
  }

  const reactApi = {
    get React() { return _react; },
    get ReactDOM() { return _reactDOM; },
    ready: _reactReady,
    ErrorBoundary,
    getReact: () => _react,
    getReactDOM: () => _reactDOM,
    createElement(...args) {
      if (!_react) throw new Error('React runtime is not ready.');
      return _react.createElement(...args);
    },
    render(element, container) {
      if (!_react || !_reactDOM) throw new Error('React/ReactDOM runtime is not ready.');
      if (!container) throw new Error('react.render() requires a container element.');

      const next = normalizeReactElement(element);
      let root = _reactRoots.get(container);

      if (!root) {
        if (typeof _reactDOM.createRoot === 'function') {
          container.textContent = '';
          root = _reactDOM.createRoot(container);
          _reactRoots.set(container, root);
        } else if (typeof _reactDOM.render === 'function') {
          _reactDOM.render(next, container);
          container.dataset.refluxReactRoot = 'true';
          return () => reactApi.unmount(container);
        } else {
          throw new Error('ReactDOM does not expose createRoot() or render().');
        }
      }

      root.render(next);
      container.dataset.refluxReactRoot = 'true';
      return () => reactApi.unmount(container);
    },
    unmount(container) {
      if (!container) return;
      const root = _reactRoots.get(container);
      if (root?.unmount) {
        try { root.unmount(); } catch { /* already unmounted */ }
        _reactRoots.delete(container);
      } else if (_reactDOM?.unmountComponentAtNode) {
        try { _reactDOM.unmountComponentAtNode(container); } catch { /* ignore */ }
      }
      if (container.dataset) delete container.dataset.refluxReactRoot;
    },
    unmountWithin(container) {
      if (!container) return;
      if (container.dataset?.refluxReactRoot) reactApi.unmount(container);
      for (const element of container.querySelectorAll?.('[data-reflux-react-root]') ?? []) {
        reactApi.unmount(element);
      }
    },
  };

  const COMPONENT_NAMES = [
    'Button',
    'Switch',
    'FormSwitch',
    'FormInput',
    'FormCombobox',
    'Clickable',
    'Flex',
    'Text',
    'Menu',
    'MenuItem',
    'Tooltip',
    'Modal',
    'Spinner',
  ];

  function findComponentNow(name) {
    if (_componentCache.has(name)) return _componentCache.get(name);
    let component = patcher.findByName(name);
    if (!component) {
      const module = patcher.findByProps(name);
      const candidate = module?.[name];
      if (candidate && (typeof candidate === 'function' || typeof candidate === 'object')) {
        component = candidate;
      }
    }
    if (component) _componentCache.set(name, component);
    return component ?? null;
  }

  const components = {
    available: [...COMPONENT_NAMES],
    ErrorBoundary,
    find(name) { return findComponentNow(name); },
    get(name) { return findComponentNow(name); },
    waitFor(name, {timeout = 10000, interval = 250} = {}) {
      const existing = findComponentNow(name);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const component = findComponentNow(name);
          if (component || (timeout > 0 && Date.now() - started >= timeout)) {
            clearInterval(timer);
            resolve(component ?? null);
          }
        }, interval);
      });
    },
    clearCache() { _componentCache.clear(); },
  };

  for (const name of COMPONENT_NAMES) {
    Object.defineProperty(components, name, {
      enumerable: true,
      get() { return findComponentNow(name); },
    });
  }

  watchForReact();
  watchForReactDOM();

  onWebpackReady(() => {
    findReactNow();
    findReactDOMNow();
  });

  setTimeout(() => {
    if (!_react) {
      console.warn('[Reflux:React] React runtime was not discovered within 15 seconds.');
      settleReactReady(null);
    }
  }, 15000);

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
  // Messages: events, cached lookup, accessories and decorations
  // ---------------------------------------------------------------------------

  const MESSAGE_CACHE_LIMIT = 5000;
  const MESSAGE_EXTENSION_CSS = `
    .reflux-message-decoration,
    .reflux-message-accessory {
      min-width: 0;
      box-sizing: border-box;
    }
    .reflux-message-decoration {
      display: flex;
      align-items: center;
      gap: .25rem;
    }
    .reflux-message-accessory {
      margin-top: .25rem;
    }
    .reflux-message-decoration:empty,
    .reflux-message-accessory:empty {
      display: none;
    }
  `;

  const MESSAGE_EVENT_ALIASES = {
    create: 'MESSAGE_CREATE',
    update: 'MESSAGE_UPDATE',
    delete: 'MESSAGE_DELETE',
    'bulk-delete': 'MESSAGE_DELETE_BULK',
  };

  /** @type {Map<string, {message: any, channelId: string, id: string, at: number, deleted: boolean}>} */
  const _messageCache = new Map();
  /** @type {Map<string, Set<Function>>} */
  const _messageListeners = new Map();
  /** @type {Map<string, object>} */
  const _messageExtensions = new Map();
  /** @type {Map<Element, Map<string, object>>} */
  const _messageMounts = new Map();

  let _messageExtensionSeq = 0;
  let _messageScanScheduled = false;
  let _messageObserver = null;

  function _messageKey(channelId, id) {
    return `${String(channelId ?? '')}\u0000${String(id ?? '')}`;
  }

  function _messageChannelId(message) {
    const value = message?.channelId ?? message?.channel_id;
    return value === undefined || value === null ? '' : String(value);
  }

  function _messageId(message) {
    const value = message?.id ?? message?.messageId ?? message?.message_id;
    return value === undefined || value === null ? '' : String(value);
  }

  function _rememberMessage(message, channelId, {deleted = false} = {}) {
    if (!message || typeof message !== 'object') return null;
    const id = _messageId(message);
    const channel = String(channelId ?? _messageChannelId(message));
    if (!id || !channel) return null;

    const key = _messageKey(channel, id);
    const previous = _messageCache.get(key);
    _messageCache.delete(key);
    _messageCache.set(key, {
      message,
      channelId: channel,
      id,
      at: Date.now(),
      deleted: Boolean(deleted || previous?.deleted),
    });

    if (_messageCache.size > MESSAGE_CACHE_LIMIT) {
      for (const oldKey of _messageCache.keys()) {
        _messageCache.delete(oldKey);
        if (_messageCache.size <= MESSAGE_CACHE_LIMIT) break;
      }
    }
    return message;
  }

  function _cachedMessage(channelId, id) {
    return _messageCache.get(_messageKey(channelId, id))?.message ?? null;
  }

  function getMessage(channelId, id) {
    const channel = String(channelId ?? '');
    const messageId = String(id ?? '');
    if (!channel || !messageId) return null;

    const store = findStore('messages');
    if (store && typeof store.getMessage === 'function') {
      try {
        const message = store.getMessage(channel, messageId);
        if (message) {
          _rememberMessage(message, channel);
          return message;
        }
      } catch { /* fall back to the gateway cache */ }
    }
    return _cachedMessage(channel, messageId);
  }

  function _asMessageArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.messages)) return value.messages;
    if (value instanceof Map) return Array.from(value.values());
    if (typeof value.toArray === 'function') {
      try { return value.toArray(); } catch { /* ignore */ }
    }
    if (typeof value.values === 'function') {
      try { return Array.from(value.values()); } catch { /* ignore */ }
    }
    if (typeof value[Symbol.iterator] === 'function') {
      try { return Array.from(value); } catch { /* ignore */ }
    }
    return [];
  }

  function getChannelMessages(channelId) {
    const channel = String(channelId ?? '');
    if (!channel) return [];
    const store = findStore('messages');
    if (store && typeof store.getMessages === 'function') {
      try {
        const messages = _asMessageArray(store.getMessages(channel));
        if (messages.length) {
          for (const message of messages) _rememberMessage(message, channel);
          return messages;
        }
      } catch { /* fall back to the cache */ }
    }
    return Array.from(_messageCache.values())
      .filter((entry) => entry.channelId === channel && !entry.deleted)
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.message);
  }

  function currentChannelId() {
    const match = window.location?.pathname?.match(/^\/channels\/(?:@me|@favorites|[^/]+)\/([^/]+)/);
    return match?.[1] ? String(match[1]) : null;
  }

  function _messageContext(message, channelId, extra = {}) {
    const id = _messageId(message) || String(extra.id ?? '');
    const channel = String(channelId ?? _messageChannelId(message));
    return {
      message,
      channelId: channel,
      messageId: id,
      id,
      ...extra,
    };
  }

  function _emitMessageEvent(event, message, context) {
    const dispatch = (name, args) => {
      const listeners = _messageListeners.get(name);
      if (!listeners) return;
      for (const listener of Array.from(listeners)) {
        try { listener(...args); }
        catch (err) { console.error(`[Reflux:Messages] "${name}" listener threw:`, err); }
      }
    };

    dispatch(event, [message, context]);
    dispatch(`message:${event}`, [message, context]);
    const raw = MESSAGE_EVENT_ALIASES[event];
    if (raw) dispatch(raw, [message, context]);
    dispatch('*', [event, message, context]);
  }

  function onMessageEvent(event, listener) {
    if (typeof listener !== 'function') return () => {};
    const key = String(event || '*');
    if (!_messageListeners.has(key)) _messageListeners.set(key, new Set());
    _messageListeners.get(key).add(listener);
    return () => _messageListeners.get(key)?.delete(listener);
  }

  function _cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function _rowsForMessage(messageId) {
    try { return Array.from(document.querySelectorAll(`[data-message-id="${_cssEscape(messageId)}"]`)); }
    catch { return []; }
  }

  function _normalizeExtensionList(value) {
    if (!value) return [];
    if (typeof value === 'function') return [{name: 'default', render: value}];
    if (Array.isArray(value)) {
      return value.filter(Boolean).map((entry, index) => {
        if (typeof entry === 'function') return {name: `item${index}`, render: entry};
        return {...entry, name: entry.name ?? entry.id ?? `item${index}`};
      });
    }
    if (typeof value === 'object') {
      return Object.entries(value).filter(([, entry]) => Boolean(entry)).map(([name, entry]) => {
        if (typeof entry === 'function') return {name, render: entry};
        return {...entry, name: entry.name ?? name};
      });
    }
    return [];
  }

  function registerMessageExtension(kind, definition, options = {}) {
    if (kind !== 'accessory' && kind !== 'decoration') {
      throw new Error('Message extensions must be an accessory or a decoration.');
    }
    const input = typeof definition === 'function'
      ? {...options, render: definition}
      : {...options, ...definition};
    if (typeof input.render !== 'function' && typeof input.component === 'function') {
      input.render = input.component;
    }
    if (typeof input.render !== 'function') {
      throw new Error(`${kind} registration requires a render() function.`);
    }

    const name = String(input.name ?? input.id ?? `${kind}-${++_messageExtensionSeq}`);
    const key = `${kind}:${name}:${++_messageExtensionSeq}`;
    const extension = {
      ...input,
      key,
      kind,
      name,
      position: input.position ?? (kind === 'decoration' ? 'before' : 'after'),
      order: Number.isFinite(input.order) ? input.order : 0,
    };
    _messageExtensions.set(key, extension);
    scheduleMessageScan();

    return () => {
      _messageExtensions.delete(key);
      for (const [row, mounts] of Array.from(_messageMounts)) {
        const mount = mounts.get(key);
        if (!mount) continue;
        _unmountMessageExtension(mount);
        mounts.delete(key);
        if (!mounts.size) _messageMounts.delete(row);
      }
      scheduleMessageScan();
    };
  }

  function _extensionApplies(extension, message, context) {
    if (extension.enabled === false) return false;
    const predicate = extension.filter ?? extension.predicate ?? extension.shouldRender;
    if (typeof predicate !== 'function') return true;
    try { return Boolean(predicate(message, context)); }
    catch (err) {
      console.error(`[Reflux:Messages] Filter for "${extension.name}" threw:`, err);
      return false;
    }
  }

  function _extensionTarget(row, extension) {
    const content = row.querySelector(
      '[data-flx^="channel.user-message.message-content"], ' +
      '[data-flx^="channel.system-message.system-message-content"], ' +
      '[data-flx^="channel.unknown-message.message-content"]',
    ) ?? row;
    const position = extension.position;
    if (position === 'inside' || position === 'content') return {parent: content, before: false};
    if (position === 'before') return {parent: row, before: true};
    return {parent: row, before: false};
  }

  function _placeExtension(container, target) {
    if (!target?.parent) return;
    if (target.before) {
      if (target.parent.firstChild !== container) target.parent.insertBefore(container, target.parent.firstChild);
    } else if (container.parentNode !== target.parent) {
      target.parent.appendChild(container);
    }
  }

  function _renderExtensionOutput(output, extension, context, container) {
    if (!container?.isConnected) return;
    const React = _react;

    const looksLikeReactElement = output && typeof output === 'object' &&
      (output.$$typeof !== undefined || output._owner !== undefined);
    if (!React && (looksLikeReactElement || typeof output === 'function')) {
      reactApi.ready.then(() => scheduleMessageScan());
      return;
    }

    if (React && React.isValidElement(output)) {
      const element = React.createElement(
        components.ErrorBoundary,
        {
          name: `Message ${extension.kind}: ${extension.name}`,
          fallback: null,
          onError: (error) => console.error(
            `[Reflux:Messages] ${extension.kind} "${extension.name}" failed:`,
            error,
          ),
        },
        output,
      );
      reactApi.render(element, container);
      return;
    }

    if (React && Array.isArray(output) && output.every((item) => React.isValidElement(item))) {
      _renderExtensionOutput(React.createElement(React.Fragment, null, ...output), extension, context, container);
      return;
    }

    if (React && typeof output === 'function') {
      _renderExtensionOutput(
        React.createElement(output, {
          message: context.message,
          channelId: context.channelId,
          messageId: context.messageId,
          context,
        }),
        extension,
        context,
        container,
      );
      return;
    }

    reactApi.unmount(container);
    if (output === undefined || output === null) {
      container.textContent = '';
      return;
    }
    if (typeof Node !== 'undefined' && output instanceof Node) {
      container.replaceChildren(output);
      return;
    }
    container.textContent = String(output);
  }

  function _renderMessageExtension(extension, context, container) {
    let output;
    try {
      output = extension.render({
        message: context.message,
        channelId: context.channelId,
        messageId: context.messageId,
        id: context.messageId,
        row: context.row,
        context,
        api: __reflux,
      });
    } catch (err) {
      console.error(`[Reflux:Messages] ${extension.kind} "${extension.name}" render threw:`, err);
      return;
    }

    if (output && typeof output.then === 'function') {
      output.then((value) => _renderExtensionOutput(value, extension, context, container))
        .catch((err) => console.error(`[Reflux:Messages] ${extension.kind} "${extension.name}" failed:`, err));
      return;
    }
    _renderExtensionOutput(output, extension, context, container);
  }

  function _unmountMessageExtension(mount) {
    if (!mount) return;
    try { mount.extension.cleanup?.(); }
    catch (err) { console.error(`[Reflux:Messages] Cleanup for "${mount.extension.name}" threw:`, err); }
    if (mount.container) {
      try { reactApi.unmount(mount.container); } catch { /* not a React root */ }
      mount.container.remove();
    }
  }

  function _unmountMessageRow(row) {
    const mounts = _messageMounts.get(row);
    if (!mounts) return;
    for (const mount of mounts.values()) _unmountMessageExtension(mount);
    _messageMounts.delete(row);
  }

  function _refreshMessageRow(row, message) {
    const mounts = _messageMounts.get(row);
    if (!mounts?.size) return;
    const channelId = _messageChannelId(message) || currentChannelId() || '';
    const context = _messageContext(message, channelId, {row});
    for (const mount of mounts.values()) {
      const target = _extensionTarget(row, mount.extension);
      _placeExtension(mount.container, target);
      mount.context = context;
      _renderMessageExtension(mount.extension, context, mount.container);
    }
  }

  function _refreshMessage(message) {
    const id = _messageId(message);
    if (!id) return;
    for (const row of _rowsForMessage(id)) _refreshMessageRow(row, message);
    scheduleMessageScan();
  }

  function _applyMessageExtensions(row, messageId) {
    const message = getMessage(currentChannelId(), messageId) ?? _cachedMessage(currentChannelId(), messageId);
    const channelId = _messageChannelId(message) || currentChannelId() || '';
    const context = _messageContext(message ?? {id: messageId, channelId}, channelId, {row});
    let mounts = _messageMounts.get(row);

    for (const extension of _messageExtensions.values()) {
      const mount = mounts?.get(extension.key);
      if (!_extensionApplies(extension, message, context)) {
        if (mount) {
          _unmountMessageExtension(mount);
          mounts.delete(extension.key);
        }
        continue;
      }

      if (mount && mount.container?.isConnected) {
        mount.context = context;
        _placeExtension(mount.container, _extensionTarget(row, extension));
        continue;
      }

      if (mount) {
        _unmountMessageExtension(mount);
        mounts.delete(extension.key);
      }

      const container = document.createElement('div');
      container.className = `reflux-message-${extension.kind}`;
      container.dataset.refluxMessageExtension = extension.kind;
      container.dataset.refluxExtensionName = extension.name;
      container.dataset.refluxMessageId = messageId;
      _placeExtension(container, _extensionTarget(row, extension));

      if (!mounts) {
        mounts = new Map();
        _messageMounts.set(row, mounts);
      }
      const nextMount = {extension, container, context};
      mounts.set(extension.key, nextMount);
      _renderMessageExtension(extension, context, container);
    }

    if (mounts && !mounts.size) _messageMounts.delete(row);
  }

  function _scanMessageRows() {
    if (!_messageExtensions.size) {
      for (const row of Array.from(_messageMounts.keys())) _unmountMessageRow(row);
      return;
    }

    const rows = Array.from(document.querySelectorAll('[data-message-id]'));
    const liveRows = new Set(rows);
    for (const [row, mounts] of Array.from(_messageMounts)) {
      if (!liveRows.has(row) || !row.isConnected) {
        _unmountMessageRow(row);
        continue;
      }
      for (const mount of Array.from(mounts.values())) {
        if (!mount.container?.isConnected) {
          _unmountMessageExtension(mount);
          mounts.delete(mount.extension.key);
        }
      }
      if (!mounts.size) _messageMounts.delete(row);
    }

    for (const row of rows) {
      const messageId = row.getAttribute('data-message-id');
      if (messageId) _applyMessageExtensions(row, messageId);
    }
  }

  function scheduleMessageScan() {
    if (_messageScanScheduled) return;
    _messageScanScheduled = true;
    const run = () => {
      _messageScanScheduled = false;
      try { _scanMessageRows(); }
      catch (err) { console.error('[Reflux:Messages] Extension scan failed:', err); }
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function ensureMessageObserver() {
    if (_messageObserver) return;
    ui.injectCSS('message-extensions', MESSAGE_EXTENSION_CSS);
    _messageObserver = new MutationObserver(() => scheduleMessageScan());
    _messageObserver.observe(document.documentElement, {childList: true, subtree: true});
    scheduleMessageScan();
  }

  function installPluginMessageExtensions(plugin) {
    if (!plugin?.name) return () => {};
    const cleanups = [];

    for (const [kind, list] of [
      ['accessory', plugin.messageAccessories],
      ['decoration', plugin.messageDecorations],
    ]) {
      for (const entry of _normalizeExtensionList(list)) {
        try {
          cleanups.push(registerMessageExtension(
            kind,
            {...entry, order: entry.order ?? 0},
            {plugin: plugin.name},
          ));
        } catch (err) {
          console.error(`[Reflux] Could not install ${kind} "${entry.name}" for "${plugin.name}":`, err);
        }
      }
    }

    const eventHandlers = plugin.messageEvents ?? {};
    for (const [event, handler] of Object.entries(eventHandlers)) {
      if (typeof handler === 'function') cleanups.push(onMessageEvent(event, handler));
    }
    for (const [event, handler] of [
      ['create', plugin.onMessageCreate],
      ['update', plugin.onMessageUpdate],
      ['delete', plugin.onMessageDelete],
    ]) {
      if (typeof handler === 'function') cleanups.push(onMessageEvent(event, handler));
    }

    return () => {
      for (const cleanup of cleanups.reverse()) {
        try { cleanup(); } catch { /* already removed */ }
      }
    };
  }

  const messages = {
    on: onMessageEvent,
    get: getMessage,
    getChannel: getChannelMessages,
    currentChannelId,
    refresh: scheduleMessageScan,

    registerAccessory(definition, options) {
      const cleanup = registerMessageExtension('accessory', definition, options);
      ensureMessageObserver();
      return cleanup;
    },
    registerDecoration(definition, options) {
      const cleanup = registerMessageExtension('decoration', definition, options);
      ensureMessageObserver();
      return cleanup;
    },
    addAccessory(definition, options) { return messages.registerAccessory(definition, options); },
    addDecoration(definition, options) { return messages.registerDecoration(definition, options); },

    get store() { return findStore('messages'); },
    get channelId() { return currentChannelId(); },
  };

  // Cache and broadcast message lifecycle events. Deletes are handled before
  // Fluxer removes the message, so plugins still receive the full object.
  gateway.on('MESSAGE_CREATE', (data) => {
    _rememberMessage(data, _messageChannelId(data));
  });
  gateway.after('MESSAGE_CREATE', (data, meta) => {
    const channelId = _messageChannelId(data) || currentChannelId() || '';
    const message = getMessage(channelId, _messageId(data)) ?? data;
    _rememberMessage(message, channelId);
    const context = _messageContext(message, channelId, {phase: meta.phase, gateway: meta});
    _emitMessageEvent('create', message, context);
    _refreshMessage(message);
  });

  gateway.on('MESSAGE_UPDATE', (data) => {
    const channelId = _messageChannelId(data) || _messageChannelId(data?.message) || currentChannelId() || '';
    const id = _messageId(data) || _messageId(data?.message);
    const message = getMessage(channelId, id) ?? data?.message ?? data;
    _rememberMessage(message, channelId);
  });
  gateway.after('MESSAGE_UPDATE', (data, meta) => {
    const channelId = _messageChannelId(data) || _messageChannelId(data?.message) || currentChannelId() || '';
    const id = _messageId(data) || _messageId(data?.message);
    const message = getMessage(channelId, id) ?? data?.message ?? data;
    _rememberMessage(message, channelId);
    const context = _messageContext(message, channelId, {phase: meta.phase, gateway: meta});
    _emitMessageEvent('update', message, context);
    _refreshMessage(message);
  });

  gateway.on('MESSAGE_DELETE', (data, meta) => {
    const channelId = _messageChannelId(data) || currentChannelId() || '';
    const id = _messageId(data);
    if (!id) return;
    const message = getMessage(channelId, id) ?? _cachedMessage(channelId, id) ?? data;
    _rememberMessage(message, channelId, {deleted: true});
    const context = _messageContext(message, channelId, {phase: meta.phase, gateway: meta});
    _emitMessageEvent('delete', message, context);
    for (const row of _rowsForMessage(id)) _unmountMessageRow(row);
  });

  function _handleBulkDelete(data, meta) {
    const channelId = _messageChannelId(data) || currentChannelId() || '';
    const ids = Array.isArray(data?.ids) ? data.ids.map(String) : [];
    const deleted = [];
    for (const id of ids) {
      const message = getMessage(channelId, id) ?? _cachedMessage(channelId, id) ?? {id, channelId, channel_id: channelId};
      _rememberMessage(message, channelId, {deleted: true});
      deleted.push(message);
      for (const row of _rowsForMessage(id)) _unmountMessageRow(row);
    }
    const context = _messageContext({id: '', channelId}, channelId, {
      ids,
      messages: deleted,
      phase: meta.phase,
      gateway: meta,
    });
    _emitMessageEvent('bulk-delete', deleted, context);
    for (const message of deleted) _emitMessageEvent('delete', message, {...context, message});
  }

  gateway.on('MESSAGE_DELETE_BULK', _handleBulkDelete);
  gateway.on('MESSAGE_BULK_DELETE', _handleBulkDelete);

  ensureMessageObserver();

  // ---------------------------------------------------------------------------
  // Context menu API
  // ---------------------------------------------------------------------------

  /**
   * A small, plugin-owned context-menu layer.  Providers are asked on every
   * `contextmenu` event; the first providers to return items win, and the
   * native Fluxer menu is suppressed for those targets.
   *
   * Provider shape:
   *   (target, event) => MenuItem[] | { title?: string, items: MenuItem[] } | null
   *
   * MenuItem shape:
   *   { label, action, icon?, danger?, disabled?, hint?, type?: 'separator' }
   */
  const contextMenu = (() => {
    /** @type {Set<Function|object>} */
    const providers = new Set();
    let menuEl = null;
    let currentTarget = null;
    let closeOnPointerDown = null;

    const MENU_CSS = `
      .reflux-context-menu {
        position: fixed;
        z-index: 2147483647;
        min-width: 13rem;
        max-width: min(21.5rem, calc(100vw - 1.5rem));
        max-height: calc(100vh - 1.5rem);
        padding: .375rem;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        overflow: auto;
        background: var(--form-surface-background, var(--background-floating, #313338));
        border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.08));
        border-radius: .5rem;
        box-shadow: 0 .5rem 1rem rgba(0,0,0,.24);
        color: var(--text-primary, var(--text-normal, #dbdee1));
        font-size: .8125rem;
        font-weight: 500;
        line-height: 1.125rem;
        -webkit-app-region: no-drag;
      }
      .reflux-context-menu-item {
        all: unset;
        display: flex;
        align-items: center;
        gap: .5rem;
        width: 100%;
        min-height: 2rem;
        padding: .3125rem .5rem;
        box-sizing: border-box;
        border: 1px solid transparent;
        border-radius: .375rem;
        color: var(--text-primary, var(--text-normal, #dbdee1));
        cursor: pointer;
        font: inherit;
        text-align: left;
      }
      .reflux-context-menu-item:hover,
      .reflux-context-menu-item:focus-visible {
        background: var(--surface-interactive-hover-bg, var(--background-modifier-hover, rgba(255,255,255,.06)));
        color: var(--text-primary, var(--text-normal, #fff));
        outline: none;
      }
      .reflux-context-menu-item[disabled] {
        opacity: .5;
        cursor: not-allowed;
      }
      .reflux-context-menu-item-danger {
        color: var(--status-danger, #ed4245);
      }
      .reflux-context-menu-item-danger:hover,
      .reflux-context-menu-item-danger:focus-visible {
        background: color-mix(in srgb, var(--status-danger, #ed4245) 12%, transparent);
        color: var(--status-danger, #ed4245);
      }
      .reflux-context-menu-icon {
        width: 1.125rem;
        height: 1.125rem;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .reflux-context-menu-icon > svg {
        width: 1.125rem;
        height: 1.125rem;
        display: block;
      }
      .reflux-context-menu-label {
        display: flex;
        align-items: center;
        gap: .5rem;
        min-width: 0;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .reflux-context-menu-hint {
        display: block;
        color: var(--text-tertiary-muted, var(--text-muted, #949ba4));
        font-size: .75rem;
        font-weight: 400;
        line-height: 1rem;
        margin-top: .0625rem;
        white-space: normal;
      }
      .reflux-context-menu-separator {
        height: 1px;
        margin: .25rem .125rem;
        background: var(--background-modifier-accent, rgba(255,255,255,.08));
        opacity: .55;
      }
    `;

    let removeCss = null;
    function ensureCss() {
      if (!removeCss) removeCss = ui.injectCSS('context-menu', MENU_CSS);
    }

    function close() {
      if (closeOnPointerDown) {
        document.removeEventListener('pointerdown', closeOnPointerDown, true);
        closeOnPointerDown = null;
      }
      if (menuEl?.parentNode) menuEl.remove();
      menuEl = null;
      currentTarget = null;
    }

    function makeMenuItem(item, onSelect) {
      if (item?.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'reflux-context-menu-separator';
        sep.setAttribute('role', 'separator');
        return sep;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reflux-context-menu-item';
      button.setAttribute('role', 'menuitem');
      if (item.danger) button.classList.add('reflux-context-menu-item-danger');
      if (item.disabled) button.disabled = true;

      if (item.icon) {
        const icon = document.createElement('span');
        icon.className = 'reflux-context-menu-icon';
        if (item.icon instanceof Node) icon.appendChild(item.icon);
        else if (/^\s*<svg[\s>]/i.test(String(item.icon))) icon.innerHTML = String(item.icon);
        else icon.textContent = String(item.icon);
        button.appendChild(icon);
      }

      const label = document.createElement('span');
      label.className = 'reflux-context-menu-label';
      const text = document.createElement('span');
      text.textContent = String(item.label ?? '');
      label.appendChild(text);
      button.appendChild(label);

      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'reflux-context-menu-hint';
        hint.textContent = String(item.hint);
        label.style.display = 'block';
        label.appendChild(hint);
      }

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (item.disabled) return;
        const target = currentTarget;
        close();
        try { item.action?.(event, target); }
        catch (err) { console.error('[Reflux:ContextMenu] Menu action threw:', err); }
        onSelect?.();
      });

      return button;
    }

    function positionMenu(menu, x, y) {
      const edge = 8;
      const rect = menu.getBoundingClientRect();
      let left = x;
      let top = y;
      if (left + rect.width > window.innerWidth - edge) left = x - rect.width;
      if (top + rect.height > window.innerHeight - edge) top = y - rect.height;
      left = Math.max(edge, Math.min(left, window.innerWidth - rect.width - edge));
      top = Math.max(edge, Math.min(top, window.innerHeight - rect.height - edge));
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    }

    function open(items, {x = 0, y = 0, target = null, title = ''} = {}) {
      close();
      const list = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!list.length) return null;

      ensureCss();
      const menu = document.createElement('div');
      menu.className = 'reflux-context-menu';
      menu.setAttribute('role', 'menu');
      if (title) menu.setAttribute('aria-label', String(title));
      currentTarget = target;

      for (const item of list) menu.appendChild(makeMenuItem(item));

      document.body.appendChild(menu);
      menuEl = menu;
      positionMenu(menu, x, y);

      for (const item of menu.querySelectorAll('.reflux-context-menu-item:not([disabled])')) {
        item.setAttribute('tabindex', '-1');
      }

      closeOnPointerDown = (event) => {
        if (menu.contains(event.target)) return;
        close();
      };
      document.addEventListener('pointerdown', closeOnPointerDown, true);

      const first = menu.querySelector('.reflux-context-menu-item:not([disabled])');
      if (first) requestAnimationFrame(() => first.focus({preventScroll: true}));
      return menu;
    }

    function getProviderItems(target, event) {
      const items = [];
      let title = '';
      for (const provider of providers) {
        try {
          const result = typeof provider === 'function'
            ? provider(target, event)
            : provider.getItems?.(target, event);
          if (!result) continue;
          const resultItems = Array.isArray(result) ? result : result.items;
          if (!Array.isArray(resultItems) || resultItems.length === 0) continue;
          if (!Array.isArray(result) && result.title) title = String(result.title);
          if (items.length && resultItems[0]?.type !== 'separator') {
            items.push({type: 'separator'});
          }
          items.push(...resultItems);
        } catch (err) {
          console.error('[Reflux:ContextMenu] Provider threw:', err);
        }
      }
      return {items, title};
    }

    function onContextMenu(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const {items, title} = getProviderItems(target, event);
      if (!items.length) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      open(items, {
        x: event.clientX || 0,
        y: event.clientY || 0,
        target,
        title,
      });
    }

    function onKeyDown(event) {
      if (!menuEl) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(menuEl.querySelectorAll('.reflux-context-menu-item:not([disabled])'));
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = index === -1
        ? (delta > 0 ? 0 : items.length - 1)
        : (index + delta + items.length) % items.length;
      items[next].focus();
    }

    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close, true);
    window.addEventListener('scroll', (event) => {
      if (menuEl?.contains(event.target)) return;
      close();
    }, true);

    return {
      /**
       * Register a context-menu provider.
       * @param {Function|{getItems: Function}} provider
       * @returns {() => void} unregister
       */
      register(provider) {
        if (!provider) return () => {};
        providers.add(provider);
        return () => providers.delete(provider);
      },
      /** Open a menu manually. */
      open,
      close,
      isOpen: () => Boolean(menuEl),
    };
  })();

  // ---------------------------------------------------------------------------
  // Native Fluxer context-menu bridge
  // ---------------------------------------------------------------------------

  const NATIVE_CONTEXT_PATCH = Symbol('refluxNativeContextPatch');
  const NATIVE_OPEN_METHODS = [
    'openFromEvent',
    'openAtPoint',
    'openForElement',
    'openAboveElementBottomLeft',
    'openAboveElementBottomRight',
    'openFromElementBottomRight',
    'openFromElementLeftStart',
  ];

  /** @type {Set<Function|object>} */
  const _nativeMenuProviders = new Set();
  let _nativeMenuModule = null;
  let _nativeMenuWatcher = null;
  let _nativeMenuGroupCache;

  function _nativeMenuPredicate(value) {
    return value &&
      typeof value.openFromEvent === 'function' &&
      typeof value.openAtPoint === 'function' &&
      typeof value.close === 'function';
  }

  function _nativeMenuTarget(value) {
    if (!value) return null;
    if (typeof Element !== 'undefined' && value instanceof Element) {
      try { return value.closest('button,[role="button"],a,[data-contextmenu-anchor="true"]') ?? value; }
      catch { return value; }
    }
    const current = value.currentTarget;
    if (current) return _nativeMenuTarget(current);
    const direct = value.target;
    if (direct && direct !== value) return _nativeMenuTarget(direct);
    return null;
  }

  function _makeNativeMenuInfo(method, args) {
    const first = args[0];
    const event = method === 'openAtPoint' ? null : (first?.nativeEvent ?? first);
    const target = method === 'openForElement'
      ? _nativeMenuTarget(first)
      : _nativeMenuTarget(event);
    const point = method === 'openAtPoint' && Number.isFinite(first?.x) && Number.isFinite(first?.y)
      ? {x: first.x, y: first.y}
      : null;
    return {
      method,
      event,
      target,
      point,
      config: method === 'openAtPoint' ? args[2] : args[2],
      module: _nativeMenuModule,
      api: __reflux,
    };
  }

  function _findNativeMenuGroup() {
    if (_nativeMenuGroupCache) return _nativeMenuGroupCache;
    let group = null;
    const module = patcher.findByCode('ui.action-menu.menu-group.menu-group-primitive');
    if (module) {
      if (typeof module === 'function') group = module;
      else {
        for (const value of _nestedExportValues(module)) {
          if (typeof value === 'function') { group = value; break; }
        }
      }
    }
    if (group) _nativeMenuGroupCache = group;
    return group;
  }

  function _renderNativeMenuItem(item, info, key) {
    if (!_react || !item) return null;
    const React = _react;
    if (React.isValidElement(item)) return React.cloneElement(item, {key});
    if (item.type === 'separator') return null;

    const MenuItem = findComponentNow('MenuItem');
    if (!MenuItem) return null;
    return React.createElement(
      MenuItem,
      {
        key,
        icon: item.icon,
        danger: Boolean(item.danger),
        disabled: Boolean(item.disabled),
        hint: item.hint,
        onClick: (event) => {
          try { item.action?.(event, info?.target, info); }
          catch (err) { console.error('[Reflux:ContextMenu] Native menu action threw:', err); }
        },
      },
      item.label ?? item.name ?? '',
    );
  }

  function _buildNativeGroups(items, info) {
    if (!_react || !Array.isArray(items) || !items.length) return [];
    const React = _react;
    const MenuGroup = _findNativeMenuGroup();
    const children = items
      .map((item, index) => _renderNativeMenuItem(item, info, `reflux-native-${index}`))
      .filter(Boolean);
    if (!children.length) return [];

    if (MenuGroup) {
      return [React.createElement(MenuGroup, {key: 'reflux-native-group'}, ...children)];
    }
    return [React.createElement(React.Fragment, {key: 'reflux-native-group'}, ...children)];
  }

  function _collectNativeGroups(info) {
    const groups = [];
    for (const provider of _nativeMenuProviders) {
      try {
        const result = typeof provider === 'function'
          ? provider(info)
          : (provider.getItems?.(info) ?? (typeof provider.items === 'function' ? provider.items(info) : provider.items));
        if (!result) continue;
        const items = Array.isArray(result) ? result : result.items;
        if (!Array.isArray(items) || !items.length) continue;
        groups.push(..._buildNativeGroups(items, info));
      } catch (err) {
        console.error('[Reflux:ContextMenu] Native provider threw:', err);
      }
    }
    return groups;
  }

  function _wrapNativeRender(originalRender, info, api) {
    let original;
    try { original = originalRender(api); }
    catch (err) {
      console.error('[Reflux:ContextMenu] Native menu render threw:', err);
      return null;
    }
    const groups = _collectNativeGroups({...info, api});
    if (!groups.length || !_react) return original;
    return _react.createElement(_react.Fragment, null, original, ...groups);
  }

  function _patchNativeMenuModule(module) {
    if (!module || !_nativeMenuPredicate(module)) return false;
    _nativeMenuModule = module;

    for (const method of NATIVE_OPEN_METHODS) {
      const original = module[method];
      if (typeof original !== 'function' || original[NATIVE_CONTEXT_PATCH]) continue;

      const patched = function refluxNativeContextMenu(...args) {
        if (typeof args[1] === 'function') {
          const info = _makeNativeMenuInfo(method, args);
          const originalRender = args[1];
          args[1] = (api) => _wrapNativeRender(originalRender, info, api);
        }
        return original.apply(this, args);
      };
      try {
        Object.defineProperty(patched, NATIVE_CONTEXT_PATCH, {value: true});
        module[method] = patched;
      } catch (err) {
        console.warn(`[Reflux:ContextMenu] Could not patch native ${method}:`, err);
      }
    }
    return true;
  }

  function _ensureNativeMenuPatch() {
    if (!_nativeMenuModule) {
      const found = _firstNestedExport(_nativeMenuPredicate);
      if (found?.value) _patchNativeMenuModule(found.value);
    }

    if (!_nativeMenuWatcher) {
      _nativeMenuWatcher = patcher.patch(
        (exports) => _nestedExportValues(exports).some(_nativeMenuPredicate),
        (exports) => {
          for (const value of _nestedExportValues(exports)) {
            if (_nativeMenuPredicate(value)) _patchNativeMenuModule(value);
          }
          return exports;
        },
      );
    }
    return Boolean(_nativeMenuModule);
  }

  const nativeContextMenu = {
    get available() { return _ensureNativeMenuPatch(); },
    get module() { _ensureNativeMenuPatch(); return _nativeMenuModule; },

    patch(provider) {
      if (!provider) return () => {};
      _nativeMenuProviders.add(provider);
      _ensureNativeMenuPatch();
      return () => _nativeMenuProviders.delete(provider);
    },
    register(provider) { return this.patch(provider); },

    openFromEvent(event, render, config) {
      if (_ensureNativeMenuPatch()) return _nativeMenuModule.openFromEvent(event, render, config);
      return null;
    },
    openAtPoint(point, render, config) {
      if (_ensureNativeMenuPatch()) return _nativeMenuModule.openAtPoint(point, render, config);
      return null;
    },
    openForElement(element, render, options) {
      if (_ensureNativeMenuPatch()) return _nativeMenuModule.openForElement(element, render, options);
      return null;
    },
    close() {
      if (!_ensureNativeMenuPatch()) return;
      try { _nativeMenuModule.close(); } catch { /* already closed */ }
    },

    /**
     * Open a native menu from the same item shape used by contextMenu.register.
     * Falls back to Reflux's DOM menu when Fluxer's menu module is unavailable.
     */
    open(items, {x = 0, y = 0, target = null} = {}) {
      const list = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!list.length) return null;
      if (_ensureNativeMenuPatch() && _react) {
        return _nativeMenuModule.openAtPoint(
          {x, y},
          () => {
            const groups = _buildNativeGroups(list, {target, method: 'manual', api: __reflux});
            return _react.createElement(_react.Fragment, null, ...groups);
          },
          {returnFocusTarget: target},
        );
      }
      return contextMenu.open(list, {x, y, target});
    },
  };

  contextMenu.native = nativeContextMenu;
  contextMenu.patchNative = (provider) => nativeContextMenu.patch(provider);
  contextMenu.openNative = (items, options) => nativeContextMenu.open(items, options);

  _ensureNativeMenuPatch();
  onWebpackReady(() => _ensureNativeMenuPatch());

  // ---------------------------------------------------------------------------
  // Notices, modals and toasts
  // ---------------------------------------------------------------------------

  const FEEDBACK_CSS = `
    .reflux-notice-stack {
      display: flex;
      flex-direction: column;
      gap: .375rem;
      width: 100%;
      box-sizing: border-box;
    }
    .reflux-notice-stack[data-reflux-floating="true"] {
      position: fixed;
      inset: 0 0 auto 0;
      z-index: 2147483000;
      padding: .5rem;
      pointer-events: none;
    }
    .reflux-notice {
      display: flex;
      align-items: flex-start;
      gap: .625rem;
      padding: .625rem .75rem;
      box-sizing: border-box;
      border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.08));
      border-radius: .5rem;
      background: var(--background-secondary-alt, var(--background-floating, #2b2d31));
      color: var(--text-primary, var(--text-normal, #dbdee1));
      box-shadow: 0 .25rem .75rem rgba(0,0,0,.18);
      font-size: .875rem;
      line-height: 1.25rem;
      pointer-events: auto;
    }
    .reflux-notice[data-reflux-floating="true"] {
      max-width: min(38rem, calc(100vw - 1rem));
      margin-inline: auto;
      width: 100%;
    }
    .reflux-notice[data-type="success"] { border-color: color-mix(in srgb, var(--status-success, #23a55a) 45%, transparent); }
    .reflux-notice[data-type="warning"] { border-color: color-mix(in srgb, var(--status-warning, #f0b232) 45%, transparent); }
    .reflux-notice[data-type="danger"] { border-color: color-mix(in srgb, var(--status-danger, #f23f43) 45%, transparent); }
    .reflux-notice-body {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: .125rem;
    }
    .reflux-notice-title {
      font-weight: 600;
    }
    .reflux-notice-message {
      color: var(--text-secondary, var(--text-normal, #dbdee1));
      overflow-wrap: anywhere;
    }
    .reflux-notice-actions {
      display: flex;
      align-items: center;
      gap: .375rem;
      flex-shrink: 0;
    }
    .reflux-notice-button {
      all: unset;
      padding: .25rem .5rem;
      border-radius: .25rem;
      color: var(--text-link, #00a8fc);
      font-weight: 500;
      cursor: pointer;
    }
    .reflux-notice-button:hover,
    .reflux-notice-button:focus-visible {
      background: var(--background-modifier-hover, rgba(255,255,255,.06));
      outline: none;
    }
    .reflux-notice-close {
      all: unset;
      flex-shrink: 0;
      width: 1.5rem;
      height: 1.5rem;
      display: grid;
      place-items: center;
      border-radius: .25rem;
      color: var(--text-tertiary-muted, var(--text-muted, #949ba4));
      cursor: pointer;
      font-size: 1rem;
      line-height: 1;
    }
    .reflux-notice-close:hover,
    .reflux-notice-close:focus-visible {
      background: var(--background-modifier-hover, rgba(255,255,255,.06));
      color: var(--text-primary, var(--text-normal, #fff));
      outline: none;
    }
    .reflux-toast-stack {
      position: fixed;
      right: 1rem;
      bottom: 1rem;
      z-index: 2147483001;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: .5rem;
      pointer-events: none;
    }
    .reflux-toast {
      display: flex;
      align-items: center;
      gap: .5rem;
      max-width: min(24rem, calc(100vw - 2rem));
      padding: .625rem .75rem;
      box-sizing: border-box;
      border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.08));
      border-radius: .5rem;
      background: var(--background-floating, #313338);
      color: var(--text-primary, var(--text-normal, #dbdee1));
      box-shadow: 0 .5rem 1rem rgba(0,0,0,.24);
      font-size: .875rem;
      line-height: 1.25rem;
      pointer-events: auto;
    }
    .reflux-toast[data-type="success"] { color: var(--status-success, #23a55a); }
    .reflux-toast[data-type="danger"],
    .reflux-toast[data-type="error"] { color: var(--status-danger, #f23f43); }
    .reflux-toast[data-type="warning"] { color: var(--status-warning, #f0b232); }
    .reflux-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483002;
      display: grid;
      place-items: center;
      padding: 1rem;
      box-sizing: border-box;
      background: rgba(0,0,0,.55);
    }
    .reflux-modal-panel {
      width: min(30rem, calc(100vw - 2rem));
      max-height: calc(100vh - 2rem);
      overflow: auto;
      padding: 1rem;
      box-sizing: border-box;
      border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.08));
      border-radius: .5rem;
      background: var(--background-floating, #313338);
      color: var(--text-primary, var(--text-normal, #dbdee1));
      box-shadow: 0 1rem 2rem rgba(0,0,0,.35);
    }
  `;

  let _feedbackCssInstalled = false;
  function ensureFeedbackCss() {
    if (_feedbackCssInstalled) return;
    _feedbackCssInstalled = true;
    ui.injectCSS('feedback', FEEDBACK_CSS);
  }

  function _renderFeedbackContent(container, content, props) {
    if (!container) return;
    try {
      if (typeof content === 'function') content = content(props);
    } catch (err) {
      console.error('[Reflux:Feedback] Content renderer threw:', err);
      container.textContent = 'Something went wrong rendering this content.';
      return;
    }

    if (_react && _react.isValidElement(content)) {
      reactApi.render(
        _react.createElement(components.ErrorBoundary, {name: 'Reflux feedback'}, content),
        container,
      );
      return;
    }
    if (typeof Node !== 'undefined' && content instanceof Node) {
      reactApi.unmount(container);
      container.replaceChildren(content);
      return;
    }
    reactApi.unmount(container);
    container.textContent = content === undefined || content === null ? '' : String(content);
  }

  let _noticeStack = null;
  let _noticeStackFloating = false;
  let _toastStack = null;

  function _noticeHost() {
    const nagbar = document.querySelector('[data-flx="app.app-layout.nagbar-container.container"]');
    if (nagbar) return {parent: nagbar, floating: false};
    return {parent: document.body, floating: true};
  }

  function _ensureNoticeStack() {
    ensureFeedbackCss();
    const host = _noticeHost();
    if (!_noticeStack || !_noticeStack.isConnected || _noticeStack.parentNode !== host.parent || _noticeStackFloating !== host.floating) {
      if (_noticeStack) {
        for (const notice of Array.from(_noticeStack.children)) {
          const body = notice.querySelector?.('.reflux-notice-body');
          if (body) reactApi.unmount(body);
        }
        _noticeStack.remove();
      }
      _noticeStack = document.createElement('div');
      _noticeStack.className = 'reflux-notice-stack';
      _noticeStack.dataset.refluxFloating = String(host.floating);
      _noticeStackFloating = host.floating;
      host.parent.appendChild(_noticeStack);
    }
    return _noticeStack;
  }

  function _ensureToastStack() {
    ensureFeedbackCss();
    if (!_toastStack || !_toastStack.isConnected) {
      _toastStack = document.createElement('div');
      _toastStack.className = 'reflux-toast-stack';
      document.body.appendChild(_toastStack);
    }
    return _toastStack;
  }

  function _normalizeFeedbackOptions(content, options) {
    const opts = options && typeof options === 'object' ? {...options} : {};
    if (content && typeof content === 'object' && !(typeof Node !== 'undefined' && content instanceof Node) &&
        !(_react && _react.isValidElement(content)) && ('title' in content || 'message' in content)) {
      return {
        ...opts,
        title: content.title ?? opts.title,
        message: content.message ?? opts.message,
        content: content.content ?? opts.content,
        actions: content.actions ?? opts.actions,
      };
    }
    return {...opts, content};
  }

  function _makeFeedbackButton(label, onClick, className = 'reflux-notice-button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = String(label ?? '');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      try { onClick?.(event); }
      catch (err) { console.error('[Reflux:Feedback] Action threw:', err); }
    });
    return button;
  }

  const notices = {
    show(content, options = {}) {
      const opts = _normalizeFeedbackOptions(content, options);
      const stack = _ensureNoticeStack();
      const floating = _noticeStackFloating;
      const notice = document.createElement('div');
      notice.className = 'reflux-notice';
      notice.dataset.type = String(opts.type ?? 'info');
      notice.dataset.refluxFloating = String(floating);
      notice.setAttribute('role', opts.type === 'danger' ? 'alert' : 'status');

      const body = document.createElement('div');
      body.className = 'reflux-notice-body';
      if (opts.title) {
        const title = document.createElement('div');
        title.className = 'reflux-notice-title';
        title.textContent = String(opts.title);
        body.appendChild(title);
      }
      const message = document.createElement('div');
      message.className = 'reflux-notice-message';
      body.appendChild(message);
      notice.appendChild(body);

      let closed = false;
      let timer = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        reactApi.unmount(message);
        notice.remove();
        if (_noticeStack && !_noticeStack.children.length) {
          _noticeStack.remove();
          _noticeStack = null;
        }
      };

      const actions = Array.isArray(opts.actions) ? opts.actions : [];
      if (actions.length || opts.dismissible !== false) {
        const actionBar = document.createElement('div');
        actionBar.className = 'reflux-notice-actions';
        for (const action of actions) {
          if (!action) continue;
          actionBar.appendChild(_makeFeedbackButton(
            action.label ?? action.name ?? 'Action',
            (event) => {
              const result = action.action?.(event, close);
              if (result !== false && action.closeOnClick !== false) close();
            },
          ));
        }
        if (opts.dismissible !== false) {
          actionBar.appendChild(_makeFeedbackButton('×', close, 'reflux-notice-close'));
        }
        notice.appendChild(actionBar);
      }

      stack.appendChild(notice);
      _renderFeedbackContent(message, opts.content ?? opts.message ?? '', {
        close,
        ...opts,
      });

      if (Number.isFinite(opts.timeout) && opts.timeout > 0) timer = setTimeout(close, opts.timeout);
      return {element: notice, close, id: opts.id ?? null};
    },

    close(handleOrElement) {
      if (!handleOrElement) return;
      if (typeof handleOrElement.close === 'function') handleOrElement.close();
      else if (handleOrElement instanceof Element) handleOrElement.remove();
    },

    clear() {
      if (!_noticeStack) return;
      for (const child of Array.from(_noticeStack.children)) {
        const body = child.querySelector?.('.reflux-notice-body');
        if (body) reactApi.unmount(body);
        child.remove();
      }
      _noticeStack.remove();
      _noticeStack = null;
    },

    get available() { return true; },
  };

  let _toastManager = null;
  function _findToastManager() {
    if (_toastManager) return _toastManager;
    const found = _firstNestedExport((value) =>
      typeof value?.createToast === 'function' && typeof value?.destroyToast === 'function');
    if (found?.value) _toastManager = found.value;
    return _toastManager;
  }

  function _showFallbackToast(content, options = {}) {
    const stack = _ensureToastStack();
    const toast = document.createElement('div');
    toast.className = 'reflux-toast';
    toast.dataset.type = String(options.type ?? 'info');
    toast.setAttribute('role', options.type === 'danger' || options.type === 'error' ? 'alert' : 'status');
    stack.appendChild(toast);

    let closed = false;
    let timer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      reactApi.unmount(toast);
      toast.remove();
      if (_toastStack && !_toastStack.children.length) {
        _toastStack.remove();
        _toastStack = null;
      }
    };

    _renderFeedbackContent(toast, content, {close, ...options});
    if (Number.isFinite(options.timeout) && options.timeout > 0) timer = setTimeout(close, options.timeout);
    return {element: toast, close, id: null};
  }

  const toasts = {
    show(content, options = {}) {
      const opts = {type: 'info', timeout: 3000, ...options};
      const manager = _findToastManager();
      if (manager) {
        try {
          const id = manager.createToast({
            type: opts.type,
            children: content,
            timeout: opts.timeout,
          });
          return {
            id,
            close() { try { manager.destroyToast(id); } catch { /* already dismissed */ } },
          };
        } catch (err) {
          console.warn('[Reflux:Toasts] Native toast failed; using fallback:', err);
        }
      }
      return _showFallbackToast(content, opts);
    },
    success(content, options = {}) { return this.show(content, {...options, type: 'success'}); },
    error(content, options = {}) { return this.show(content, {...options, type: 'error', timeout: options.timeout ?? 5000}); },
    info(content, options = {}) { return this.show(content, {...options, type: 'info'}); },
    warning(content, options = {}) { return this.show(content, {...options, type: 'warning'}); },
    dismiss(handleOrId) {
      if (handleOrId && typeof handleOrId.close === 'function') return handleOrId.close();
      const manager = _findToastManager();
      if (manager && typeof handleOrId === 'string') manager.destroyToast(handleOrId);
    },
    get available() { return Boolean(_findToastManager()); },
  };

  let _modalManager = null;
  let _modalSeq = 0;
  function _findModalManager() {
    if (_modalManager) return _modalManager;
    const found = _firstNestedExport((value) =>
      typeof value?.push === 'function' &&
      typeof value?.pop === 'function' &&
      (typeof value?.hasModal === 'function' || typeof value?.getOrderedModals === 'function'));
    if (found?.value) _modalManager = found.value;
    return _modalManager;
  }

  const _fallbackModals = new Map();

  function _showFallbackModal(element, options, key) {
    ensureFeedbackCss();
    const backdrop = document.createElement('div');
    backdrop.className = 'reflux-modal-backdrop';
    const panel = document.createElement('div');
    panel.className = 'reflux-modal-panel';
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      _fallbackModals.delete(key);
      reactApi.unmount(panel);
      backdrop.remove();
      options.onClose?.();
    };
    const onBackdrop = (event) => {
      if (event.target === backdrop && options.dismissible !== false) close();
    };
    backdrop.addEventListener('pointerdown', onBackdrop);
    _renderFeedbackContent(panel, element, {close, ...options});
    _fallbackModals.set(key, {close, backdrop});
    return {key, close};
  }

  const modals = {
    open(element, options = {}) {
      const opts = {...options};
      const key = String(opts.key ?? opts.id ?? `reflux-modal-${++_modalSeq}`);
      const manager = _findModalManager();
      const React = _react;
      let renderModal;

      if (typeof element === 'function' && React) {
        renderModal = () => React.createElement(element, {close: () => modals.close(key), ...opts});
      } else if (React && typeof element === 'string') {
        renderModal = () => React.createElement('div', null, element);
      } else {
        renderModal = () => element;
      }

      if (manager && React) {
        try {
          const modalRenderer = function refluxModal() { return renderModal(); };
          if (opts.modalType) modalRenderer.modalType = opts.modalType;
          manager.push(modalRenderer, key, {isBackground: Boolean(opts.isBackground)});
          return {
            key,
            close() { try { manager.pop(key); } catch { /* already closed */ } },
            update(nextElement) {
              renderModal = typeof nextElement === 'function'
                ? () => (React.isValidElement(nextElement) ? nextElement : React.createElement(nextElement, {close: () => modals.close(key), ...opts}))
                : () => nextElement;
              try { manager.update(key, () => modalRenderer); }
              catch (err) { console.error('[Reflux:Modals] Native modal update failed:', err); }
            },
          };
        } catch (err) {
          console.warn('[Reflux:Modals] Native modal failed; using fallback:', err);
        }
      }
      return _showFallbackModal(renderModal, opts, key);
    },

    close(handleOrKey) {
      const key = typeof handleOrKey === 'object' && handleOrKey
        ? handleOrKey.key
        : handleOrKey;
      if (key !== undefined && key !== null) {
        if (_fallbackModals.has(String(key))) {
          _fallbackModals.get(String(key))?.close();
          return;
        }
        const manager = _findModalManager();
        if (manager && typeof manager.pop === 'function') {
          try { manager.pop(String(key)); return; } catch { /* fall through */ }
        }
      }
      if (handleOrKey && typeof handleOrKey.close === 'function') handleOrKey.close();
    },

    closeAll() {
      const manager = _findModalManager();
      if (manager && typeof manager.popAll === 'function') {
        try { manager.popAll(); } catch { /* ignore */ }
      }
      for (const entry of Array.from(_fallbackModals.values())) entry.close();
    },

    get available() { return Boolean(_findModalManager()) || Boolean(_react); },
  };

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** @type {Map<string, object>} */
  const _commands = new Map();
  /** @type {Map<string, string>} */
  const _commandAliases = new Map();
  let _commandInterceptorInstalled = false;

  function _normalizeCommandName(name) {
    return String(name ?? '').trim().replace(/^\/+/, '').toLowerCase();
  }

  function _splitCommandArgs(input) {
    const args = [];
    let current = '';
    let quote = null;
    let escaped = false;

    for (const char of String(input ?? '')) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        else current += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/\s/.test(char)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += char;
    }
    if (current) args.push(current);
    return args;
  }

  function parseCommand(input) {
    const raw = String(input ?? '').trim();
    if (!raw.startsWith('/')) return null;
    const match = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return {
      raw,
      name: _normalizeCommandName(match[1]),
      args: _splitCommandArgs(match[2] ?? ''),
      rest: match[2] ?? '',
    };
  }

  function _resolveCommand(name) {
    const key = _normalizeCommandName(name);
    const canonical = _commandAliases.get(key) ?? key;
    return _commands.get(canonical) ?? null;
  }

  function registerCommand(definition) {
    const input = typeof definition === 'string'
      ? {name: definition, execute: () => {}}
      : (definition && typeof definition === 'object' ? {...definition} : null);
    if (!input) throw new Error('registerCommand() requires a command definition.');
    const name = _normalizeCommandName(input.name);
    if (!name) throw new Error('Commands require a name.');
    if (_commands.has(name)) throw new Error(`Command "/${name}" is already registered.`);

    const execute = input.execute ?? input.run ?? input.handler;
    if (typeof execute !== 'function') throw new Error(`Command "/${name}" requires execute().`);

    const command = {
      ...input,
      name,
      execute,
      description: String(input.description ?? ''),
      usage: input.usage ? String(input.usage) : `/${name}`,
      aliases: Array.isArray(input.aliases) ? input.aliases.map(_normalizeCommandName).filter(Boolean) : [],
    };

    _commands.set(name, command);
    for (const alias of command.aliases) {
      if (_commands.has(alias) || _commandAliases.has(alias)) {
        console.warn(`[Reflux:Commands] Alias "/${alias}" for "/${name}" is already in use.`);
        continue;
      }
      _commandAliases.set(alias, name);
    }

    return () => unregisterCommand(name);
  }

  function unregisterCommand(name) {
    const command = _resolveCommand(name);
    if (!command) return false;
    _commands.delete(command.name);
    for (const [alias, target] of Array.from(_commandAliases)) {
      if (target === command.name) _commandAliases.delete(alias);
    }
    return true;
  }

  function listCommands() {
    return Array.from(_commands.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function runCommand(input, args, context = {}) {
    const parsed = typeof input === 'string' && input.trim().startsWith('/')
      ? parseCommand(input)
      : {name: _normalizeCommandName(input), args: Array.isArray(args) ? args : [], raw: '', rest: ''};
    if (!parsed) return false;

    const command = _resolveCommand(parsed.name);
    if (!command) return false;

    const commandContext = {
      ...context,
      command,
      name: command.name,
      args: parsed.args,
      raw: parsed.raw || `/${command.name}${parsed.args.length ? ` ${parsed.args.join(' ')}` : ''}`,
      channelId: context.channelId ?? currentChannelId(),
      api: __reflux,
    };

    try {
      const result = await command.execute(parsed.args, commandContext);
      return result === undefined ? true : result;
    } catch (err) {
      console.error(`[Reflux:Commands] "/${command.name}" failed:`, err);
      toasts.error(`Command /${command.name} failed: ${err?.message ?? err}`);
      return false;
    }
  }

  function _composerText(composer) {
    if (!composer) return '';
    try {
      const text = typeof composer.innerText === 'string' ? composer.innerText : composer.textContent;
      return String(text ?? '').replace(/\u00a0/g, ' ').replace(/\r/g, '');
    } catch {
      return String(composer.textContent ?? '');
    }
  }

  function _clearComposer(composer) {
    if (!composer) return;
    try { composer.focus({preventScroll: true}); } catch { /* ignore */ }
    try {
      const selection = window.getSelection?.();
      const range = document.createRange?.();
      if (selection && range) {
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand?.('delete')) {
          range.deleteContents();
        }
      } else {
        composer.textContent = '';
      }
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
        data: null,
      }));
    } catch {
      try { composer.textContent = ''; } catch { /* ignore */ }
    }
  }

  function _onCommandKeyDown(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const composer = target.closest('[data-channel-textarea]');
    if (!composer) return;

    const text = _composerText(composer);
    const parsed = parseCommand(text);
    if (!parsed || !_resolveCommand(parsed.name)) return;

    // Only registered Reflux commands are swallowed. Unknown slash commands
    // keep Fluxer's built-in autocomplete and send behavior.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const command = _resolveCommand(parsed.name);
    runCommand(parsed.raw, parsed.args, {
      event,
      composer,
      channelId: currentChannelId(),
      text,
    }).then((result) => {
      if (result !== false && command.clearComposer !== false) _clearComposer(composer);
    });
  }

  function ensureCommandInterceptor() {
    if (_commandInterceptorInstalled) return;
    _commandInterceptorInstalled = true;
    document.addEventListener('keydown', _onCommandKeyDown, true);
  }

  function installPluginCommands(plugin) {
    if (!plugin?.name || !plugin.commands) return () => {};
    const definitions = Array.isArray(plugin.commands)
      ? plugin.commands
      : (typeof plugin.commands === 'object'
        ? Object.entries(plugin.commands).map(([name, command]) =>
          typeof command === 'function' ? {name, execute: command} : {name, ...command})
        : []);
    const cleanups = [];
    for (const definition of definitions) {
      try {
        cleanups.push(registerCommand({...definition, plugin: plugin.name}));
      } catch (err) {
        console.error(`[Reflux:Commands] Could not register command for "${plugin.name}":`, err);
      }
    }
    return () => {
      for (const cleanup of cleanups.reverse()) {
        try { cleanup(); } catch { /* already removed */ }
      }
    };
  }

  const commands = {
    register: registerCommand,
    add: registerCommand,
    unregister: unregisterCommand,
    remove: unregisterCommand,
    get: _resolveCommand,
    list: listCommands,
    parse: parseCommand,
    run: runCommand,
    execute: runCommand,
    clearComposer: _clearComposer,
    get channelId() { return currentChannelId(); },
  };

  // A small built-in command so users can discover plugin commands without
  // waiting for a plugin to register its own help command.
  registerCommand({
    name: 'reflux',
    description: 'List installed Reflux plugin commands.',
    usage: '/reflux',
    plugin: 'reflux',
    execute(_args, context) {
      const list = listCommands().filter((command) => command.name !== 'reflux');
      if (!list.length) {
        toasts.info('No Reflux plugin commands are registered.');
        return;
      }
      const content = document.createElement('div');
      const header = document.createElement('div');
      header.textContent = `${list.length} Reflux command${list.length === 1 ? '' : 's'}:`;
      header.style.fontWeight = '600';
      header.style.marginBottom = '.25rem';
      content.appendChild(header);
      for (const command of list) {
        const row = document.createElement('div');
        row.textContent = `${command.usage} — ${command.description || 'No description'}`;
        content.appendChild(row);
      }
      notices.show({
        type: 'info',
        title: 'Reflux commands',
        content,
        timeout: 8000,
      });
      return true;
    },
  });

  ensureCommandInterceptor();

  // ---------------------------------------------------------------------------
  // Plugin registry (renderer-side)
  // ---------------------------------------------------------------------------

  /** @type {Map<string, { plugin: object, stop: Function|null }>} */
  const _plugins = new Map();

  const pluginManager = {
    /**
     * Register and start a renderer-side plugin.
     *
     * `plugin.start()` may return a cleanup function (the legacy API) or the
     * plugin may provide `plugin.stop()`.  Both shapes are supported; the
     * returned cleanup wins when both exist.
     *
     * @param {{ name: string, start: (patcher, api) => (Function|void), stop?: Function }} plugin
     */
    register(plugin) {
      if (_plugins.has(plugin.name)) {
        console.warn(`[Reflux] Plugin "${plugin.name}" already registered.`);
        return;
      }
      if (plugin.name && plugin.settings && !plugin.settingsStore) {
        try { plugin.settingsStore = createSettingsStore(plugin.name, plugin.settings); }
        catch (err) { console.error(`[Reflux] Could not create settings store for "${plugin.name}":`, err); }
      }
      let cleanup = null;
      const cleanups = [];
      try {
        const extensionCleanup = installPluginMessageExtensions(plugin);
        if (typeof extensionCleanup === 'function') cleanups.push(extensionCleanup);
        const commandCleanup = installPluginCommands(plugin);
        if (typeof commandCleanup === 'function') cleanups.push(commandCleanup);

        const result = plugin.start?.(patcher, __reflux);
        if (typeof result === 'function') cleanups.push(result);
        else if (typeof plugin.stop === 'function') cleanups.push(() => plugin.stop());

        cleanup = () => {
          for (const fn of cleanups.reverse()) {
            try { fn(); }
            catch (err) { console.error(`[Reflux] "${plugin.name}" cleanup threw:`, err); }
          }
        };
        _plugins.set(plugin.name, { plugin, cleanup });
        console.log(`[Reflux] Plugin "${plugin.name}" started.`);
      } catch (err) {
        for (const fn of cleanups.reverse()) {
          try { fn(); } catch { /* best effort */ }
        }
        console.error(`[Reflux] Plugin "${plugin.name}" failed to start:`, err);
      }
    },

    unregister(name) {
      const entry = _plugins.get(name);
      if (!entry) return;
      try { entry.cleanup?.(); } catch (err) { console.error(`[Reflux] "${name}" stop() threw:`, err); }
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
    contextMenu,
    pluginManager,
    events,
    flux,
    gateway,
    stores,
    messages,
    notices,
    modals,
    toasts,
    commands,
    settings,
    definePlugin,
    OptionType,
    react: reactApi,
    components,
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

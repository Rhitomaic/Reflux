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
      const found = _firstNestedExport((value) => matcher(value));
      if (found?.value) _storeCache.set(name, found.value);
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
      try {
        const result = plugin.start?.(patcher, __reflux);
        cleanup = typeof result === 'function'
          ? result
          : (typeof plugin.stop === 'function' ? () => plugin.stop() : null);
        _plugins.set(plugin.name, { plugin, cleanup });
        console.log(`[Reflux] Plugin "${plugin.name}" started.`);
      } catch (err) {
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

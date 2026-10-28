/**
 * src/core/pluginSettings.js
 *
 * Main-process scoped settings store for plugins.
 *
 * Plugins normally access this through `plugin.settingsStore` (attached by
 * pluginManager before start()). It mirrors the renderer store shape:
 *
 *   plugin.settingsStore.get(key)
 *   plugin.settingsStore.set(key, value)
 *   plugin.settingsStore.plain
 *   plugin.settingsStore.store.foo
 *   plugin.settingsStore.subscribe((key, value) => {})
 */

'use strict';

const settings = require('./settings');
const {
  coerceSettingValue,
  settingsToDef,
} = require('./pluginSchema');

/**
 * @param {string} pluginName
 * @param {Array<object>|Record<string, object>} settingsSchema
 * @returns {object}
 */
function createStore(pluginName, settingsSchema) {
  const prefix = `plugins.${pluginName}`;
  let def = settingsToDef(settingsSchema);
  const plain = {};
  const listeners = new Set();

  for (const [key, setting] of Object.entries(def)) {
    plain[key] = coerceSettingValue(setting, settings.get(`${prefix}.${key}`, setting.default));
  }

  function notify(key, value) {
    for (const listener of listeners) {
      try { listener(key, value, plain); }
      catch (err) { console.error(`[Reflux:PluginSettings] "${pluginName}" listener threw:`, err); }
    }
  }

  function onChange(key, value) {
    const setting = def[key];
    if (typeof setting?.onChange !== 'function') return;
    try { setting.onChange.call(api, value); }
    catch (err) { console.error(`[Reflux:PluginSettings] "${pluginName}.${key}" onChange threw:`, err); }
  }

  const unsubscribeSettings = settings.subscribe((fullKey, value) => {
    if (!fullKey.startsWith(`${prefix}.`)) return;
    const key = fullKey.slice(prefix.length + 1);
    if (!(key in def)) return;
    plain[key] = coerceSettingValue(def[key], value);
    notify(key, plain[key]);
    onChange(key, plain[key]);
  });

  function get(key) {
    if (!(key in def)) return undefined;
    return plain[key];
  }

  function set(key, value) {
    if (!(key in def)) throw new Error(`Unknown setting "${pluginName}.${key}".`);
    const next = coerceSettingValue(def[key], value);
    settings.set(`${prefix}.${key}`, next);
    return next;
  }

  function updateSchema(settingsSchema) {
    const nextDef = settingsToDef(settingsSchema);
    Object.assign(def, nextDef);
    for (const [key, setting] of Object.entries(nextDef)) {
      if (!(key in plain)) {
        plain[key] = coerceSettingValue(setting, settings.get(`${prefix}.${key}`, setting.default));
      }
    }
    return api;
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
        set(property, value);
        return true;
      }
      target[property] = value;
      return true;
    },
    has(target, property) {
      return property in target || property in def || property === 'plain' || property === 'def' || property === 'store';
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(target, property) ?? {
        configurable: true,
        enumerable: true,
        writable: false,
        value: undefined,
      };
    },
  });

  const api = {
    def,
    plain,
    store,
    get,
    set,
    updateSchema,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toJSON() {
      return {...plain};
    },
    dispose() {
      unsubscribeSettings();
      listeners.clear();
    },
  };

  return api;
}

module.exports = {createStore};

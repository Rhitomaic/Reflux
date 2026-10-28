/**
 * src/core/pluginSchema.js
 *
 * Shared plugin definition and settings-schema helpers.
 *
 * This module is intentionally dependency-free and UMD-ish: the main process
 * can require() it, while the renderer bootstrap can receive the same code
 * before src/renderer.js runs. That keeps plugin definitions and option types
 * identical in both worlds.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__refluxPluginSchema = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OptionType = Object.freeze({
    STRING:    'string',
    NUMBER:    'number',
    BOOLEAN:   'boolean',
    SELECT:    'select',
    SLIDER:    'slider',
    COMPONENT: 'component',
    CUSTOM:    'custom',
  });

  const TYPE_ALIASES = {
    text:     OptionType.STRING,
    bool:     OptionType.BOOLEAN,
    checkbox: OptionType.BOOLEAN,
    dropdown: OptionType.SELECT,
    range:    OptionType.SLIDER,
  };

  function humanizeName(name) {
    return String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
  }

  function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.map((option, index) => {
      if (option !== null && typeof option === 'object') {
        return {
          ...option,
          label: option.label ?? option.displayName ?? String(option.value ?? index),
          value: option.value ?? index,
        };
      }
      return {label: String(option), value: option};
    });
  }

  function inferType(definition) {
    if (definition.type) {
      const type = TYPE_ALIASES[definition.type] ?? definition.type;
      return type === 'hidden' ? 'hidden' : type;
    }
    if (typeof definition.component === 'function' || typeof definition.render === 'function') {
      return OptionType.COMPONENT;
    }
    if (Array.isArray(definition.options)) return OptionType.SELECT;
    if (Array.isArray(definition.markers)) return OptionType.SLIDER;
    return OptionType.STRING;
  }

  function getSelectDefault(options) {
    const explicit = options.find((option) => option.default === true);
    if (explicit) return explicit.value;
    return options.length ? options[0].value : undefined;
  }

  function getSettingDefault(setting) {
    if (setting && Object.prototype.hasOwnProperty.call(setting, 'default')) {
      return setting.default;
    }

    switch (setting?.type) {
      case OptionType.BOOLEAN:
        return false;
      case OptionType.NUMBER:
        return 0;
      case OptionType.STRING:
        return '';
      case OptionType.SELECT:
        return getSelectDefault(setting.options ?? []);
      case OptionType.SLIDER:
        return Array.isArray(setting.markers) && setting.markers.length ? setting.markers[0] : 0;
      default:
        return undefined;
    }
  }

  function normalizeSetting(key, definition) {
    const input = definition && typeof definition === 'object' ? definition : {};
    const type = inferType(input);
    const options = normalizeOptions(input.options);
    const markers = Array.isArray(input.markers)
      ? input.markers.map(Number).filter(Number.isFinite)
      : [];

    const setting = {
      ...input,
      key,
      type,
      label: input.label ?? input.displayName ?? humanizeName(key),
      displayName: input.label ?? input.displayName ?? humanizeName(key),
      description: input.description ?? '',
      options,
      markers,
      hidden: input.hidden === true || type === 'hidden',
    };

    if (type === OptionType.SELECT && !setting.default) {
      setting.default = getSelectDefault(options);
    } else if (type === OptionType.SLIDER && setting.default === undefined) {
      setting.default = markers.length ? markers[0] : 0;
    } else if (!Object.prototype.hasOwnProperty.call(setting, 'default')) {
      setting.default = getSettingDefault(setting);
    }

    return setting;
  }

  function normalizeSettings(settings) {
    if (!settings) return [];
    const entries = Array.isArray(settings)
      ? settings.map((setting) => [setting?.key, setting])
      : Object.entries(settings);

    const result = [];
    for (const [key, definition] of entries) {
      if (!key) continue;
      result.push(normalizeSetting(String(key), definition));
    }
    return result;
  }

  function settingsToDef(settings) {
    const def = {};
    for (const setting of normalizeSettings(settings)) def[setting.key] = setting;
    return def;
  }

  function coerceSettingValue(setting, value) {
    if (!setting) return value;

    switch (setting.type) {
      case OptionType.BOOLEAN:
        return Boolean(value);

      case OptionType.NUMBER: {
        const number = Number(value);
        return Number.isFinite(number) ? number : getSettingDefault(setting);
      }

      case OptionType.STRING:
        return value === undefined || value === null ? '' : String(value);

      case OptionType.SELECT: {
        const options = setting.options ?? [];
        if (options.some((option) => Object.is(option.value, value))) return value;
        const match = options.find((option) => String(option.value) === String(value));
        return match ? match.value : getSettingDefault(setting);
      }

      case OptionType.SLIDER: {
        let number = Number(value);
        if (!Number.isFinite(number)) number = Number(getSettingDefault(setting));
        const markers = setting.markers ?? [];
        if (!markers.length) return number;

        if (setting.stickToMarkers) {
          return markers.reduce((nearest, marker) =>
            Math.abs(marker - number) < Math.abs(nearest - number) ? marker : nearest,
          markers[0]);
        }

        return Math.min(Math.max(number, Math.min(...markers)), Math.max(...markers));
      }

      default:
        return value;
    }
  }

  function evaluateSettingFlag(flag, context) {
    if (typeof flag === 'function') {
      try { return Boolean(flag.call(context)); }
      catch { return false; }
    }
    return Boolean(flag);
  }

  function mergeSettings(base, override) {
    const merged = new Map();
    for (const setting of normalizeSettings(base)) merged.set(setting.key, setting);
    for (const setting of normalizeSettings(override)) {
      merged.set(setting.key, {...(merged.get(setting.key) ?? {}), ...setting});
    }
    return Array.from(merged.values());
  }

  function normalizePlugin(plugin, {validateName = true} = {}) {
    if (plugin && plugin.__refluxPlugin) return plugin;
    if (!plugin || typeof plugin !== 'object') throw new Error('Plugin definition must be an object.');

    const normalized = {...plugin};
    normalized.name = String(plugin.name ?? '').trim();
    if (validateName && !normalized.name) throw new Error('Plugin definition is missing a valid "name".');

    normalized.displayName = plugin.displayName || humanizeName(normalized.name);
    normalized.description = plugin.description ?? '';
    normalized.authors = Array.isArray(plugin.authors) ? plugin.authors : [];
    normalized.tags = Array.isArray(plugin.tags) ? plugin.tags : [];
    normalized.dependencies = Array.isArray(plugin.dependencies) ? plugin.dependencies : [];
    normalized.enabledByDefault = plugin.enabledByDefault ?? true;
    normalized.required = Boolean(plugin.required);
    normalized.hidden = Boolean(plugin.hidden);
    normalized.requiresRestart = Boolean(plugin.requiresRestart);
    normalized.start = typeof plugin.start === 'function' ? plugin.start : function refluxNoopStart() {};
    normalized.stop = typeof plugin.stop === 'function' ? plugin.stop : function refluxNoopStop() {};

    normalized.settings = normalizeSettings(plugin.settings);
    normalized.settingsDef = settingsToDef(normalized.settings);

    Object.defineProperty(normalized, '__refluxPlugin', {
      value: true,
      configurable: true,
      enumerable: false,
    });
    return normalized;
  }

  function definePlugin(plugin) {
    return normalizePlugin(plugin);
  }

  return {
    OptionType,
    definePlugin,
    normalizePlugin,
    normalizeSetting,
    normalizeSettings,
    settingsToDef,
    getSettingDefault,
    coerceSettingValue,
    evaluateSettingFlag,
    mergeSettings,
    humanizeName,
  };
});

/**
 * src/core/pluginMetadata.js
 *
 * Metadata parsing and import validation for single-file ("imported") plugins.
 *
 * Exposed as `window.__refluxPluginMetadata` (injected before renderer.js) and
 * as a CommonJS module for the smoke tests.
 */

(function refluxPluginMetadataModule(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.__refluxPluginMetadata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function refluxPluginMetadataFactory() {
  'use strict';

  const FIELDS = ['name', 'author', 'description', 'version', 'preview', 'icon'];
  const DEFAULT_MAX_BYTES = 256 * 1024;
  const MAX_NAME_LENGTH = 100;
  const MAX_FIELD_LENGTH = 4000;

  function defaultName(filename) {
    const base = String(filename ?? '').replace(/^.*[\\/]/, '').replace(/\.js$/i, '').trim();
    return base || 'Imported Plugin';
  }

  function parseMetadata(source, filename = '') {
    const meta = {
      name: defaultName(filename),
      description: '',
      author: '',
      version: '',
      preview: '',
      icon: '',
    };
    const text = String(source ?? '');
    const block = text.match(/\/\/\s*==RefluxPlugin==([\s\S]*?)\/\/\s*==\/RefluxPlugin==/i);
    if (!block) return meta;

    for (const line of block[1].split(/\r?\n/)) {
      const match = line.match(/\/\/\s*@(\w+)\s+(.*)/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      if (!FIELDS.includes(key)) continue;
      const value = match[2].trim().slice(0, MAX_FIELD_LENGTH);
      if (value) meta[key] = value;
    }
    if (!meta.name) meta.name = defaultName(filename);
    return meta;
  }

  function byteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function validateImport({
    source,
    meta,
    imported = [],
    reservedNames = [],
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    const text = typeof source === 'string' ? source : '';
    if (!text.trim()) {
      return {ok: false, code: 'empty', error: 'The selected file is empty.'};
    }

    const bytes = byteLength(text);
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    if (bytes > limit) {
      return {
        ok: false,
        code: 'too-large',
        bytes,
        error: `Plugin file is too large (${Math.ceil(bytes / 1024)} KB; limit is ${Math.ceil(limit / 1024)} KB).`,
      };
    }

    const name = String(meta?.name ?? '').trim();
    if (!name) {
      return {ok: false, code: 'invalid-name', bytes, error: 'Plugin metadata is missing a name.'};
    }
    if (name.length > MAX_NAME_LENGTH) {
      return {
        ok: false,
        code: 'invalid-name',
        bytes,
        error: `Plugin name is too long (maximum ${MAX_NAME_LENGTH} characters).`,
      };
    }

    const normalised = name.toLowerCase();
    const existing = Array.isArray(imported) ? imported : [];
    const duplicate = existing.find((plugin) => String(plugin?.name ?? '').trim().toLowerCase() === normalised);
    if (duplicate) {
      return {
        ok: false,
        code: 'duplicate',
        bytes,
        duplicate,
        error: `A plugin named "${name}" is already installed.`,
      };
    }

    const reservedList = Array.isArray(reservedNames) ? reservedNames : [];
    const reserved = reservedList.find((value) => String(value ?? '').trim().toLowerCase() === normalised);
    if (reserved) {
      return {
        ok: false,
        code: 'duplicate',
        bytes,
        error: `The name "${name}" is reserved by a built-in plugin.`,
      };
    }

    return {ok: true, code: 'ok', bytes, error: null, duplicate: null};
  }

  return {
    DEFAULT_MAX_BYTES,
    MAX_NAME_LENGTH,
    parseMetadata,
    validateImport,
    byteLength,
  };
});

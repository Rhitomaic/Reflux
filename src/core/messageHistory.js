/**
 * src/core/messageHistory.js
 *
 * Shared serialisation and retention helpers for deleted/edited message
 * history.  Message Logger uses them at runtime, and the smoke tests exercise
 * the pure functions directly.
 *
 * Exposed as `window.__refluxMessageHistory` (injected before renderer.js) and
 * as a CommonJS module.
 */

(function refluxMessageHistoryModule(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.__refluxMessageHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function refluxMessageHistoryFactory() {
  'use strict';

  const DEFAULT_MAX_PER_CHANNEL = 250;
  const DEFAULT_MAX_TOTAL = 1200;

  function ensureChannel(history, channelId) {
    const id = String(channelId || '');
    if (!id) return null;
    let state = history.get(id);
    if (!state) {
      state = {deleted: new Map(), edited: new Map()};
      history.set(id, state);
    }
    return state;
  }

  function recordTimestamp(record) {
    const raw = record?.message?.timestamp || record?.deletedAt || record?.editedAt || 0;
    const value = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isFinite(value) ? value : 0;
  }

  function snowflakeTimestamp(id) {
    try { return Number((BigInt(String(id)) >> 22n) + 1420070400000n); }
    catch { return 0; }
  }

  /**
   * Resolve the channel id from a Fluxer route. Message links include a
   * trailing message id, so prefer the second-to-last segment when it is a
   * known channel.
   *
   * @param {string} pathname
   * @param {(channelId: string) => boolean} [hasChannel]
   * @returns {string|null}
   */
  function channelIdFromPath(pathname, hasChannel = () => false) {
    const parts = String(pathname ?? '').split('/').filter(Boolean);
    if (parts[0] !== 'channels' || parts.length < 3) return null;
    const last = parts[parts.length - 1];
    const previous = parts[parts.length - 2];
    if (hasChannel(last)) return last;
    if (hasChannel(previous)) return previous;
    return last;
  }

  function serialiseRecord(record) {
    return {
      id: record.id,
      channelId: record.channelId,
      message: record.message,
      content: record.content,
      renderedContentHtml: record.renderedContentHtml,
      richHtml: record.richHtml,
      replyHtml: record.replyHtml,
      avatarUrl: record.avatarUrl,
      authorColor: record.authorColor,
      deletedAt: record.deletedAt,
      editedAt: record.editedAt,
      originalContent: record.originalContent,
      originalHtml: record.originalHtml,
      edits: record.edits,
    };
  }

  function serializeHistory(history) {
    const channels = {};
    for (const [channelId, state] of history) {
      if (!state.deleted.size && !state.edited.size) continue;
      channels[channelId] = {
        deleted: Array.from(state.deleted.values(), serialiseRecord),
        edited: Array.from(state.edited.values(), serialiseRecord),
      };
    }
    return {version: 1, savedAt: Date.now(), channels};
  }

  function normaliseRecord(record, channelId, kind) {
    if (!record || !record.id) return null;
    const id = String(record.id);
    const message = record.message && typeof record.message === 'object' ? record.message : {};
    const resolvedChannel = String(record.channelId || record.channel_id || message.channel_id || channelId || '');
    if (!resolvedChannel) return null;
    return {
      ...record,
      id,
      channelId: resolvedChannel,
      message: {
        ...message,
        id: message.id || id,
        channel_id: message.channel_id || resolvedChannel,
        content: message.content ?? record.content ?? '',
        attachments: Array.isArray(message.attachments) ? message.attachments : [],
        embeds: Array.isArray(message.embeds) ? message.embeds : [],
        author: message.author || {},
      },
      content: record.content ?? message.content ?? '',
      renderedContentHtml: record.renderedContentHtml || '',
      richHtml: record.richHtml || '',
      replyHtml: record.replyHtml || '',
      avatarUrl: record.avatarUrl || '',
      authorColor: record.authorColor || '',
      deletedAt: kind === 'deleted' ? Number(record.deletedAt) || Date.now() : 0,
      editedAt: kind === 'edited' ? Number(record.editedAt) || Date.now() : 0,
      originalContent: record.originalContent || '',
      originalHtml: record.originalHtml || '',
      edits: Array.isArray(record.edits) ? record.edits : [],
    };
  }

  function importHistory(history, data) {
    if (!data || typeof data !== 'object' || !data.channels) return false;
    let changed = false;
    for (const [channelId, group] of Object.entries(data.channels)) {
      if (!group || typeof group !== 'object') continue;
      const state = ensureChannel(history, channelId);
      if (!state) continue;

      for (const raw of Array.isArray(group.deleted) ? group.deleted : []) {
        const record = normaliseRecord(raw, channelId, 'deleted');
        if (!record || state.deleted.has(record.id)) continue;
        state.deleted.set(record.id, record);
        changed = true;
      }
      for (const raw of Array.isArray(group.edited) ? group.edited : []) {
        const record = normaliseRecord(raw, channelId, 'edited');
        if (!record || state.edited.has(record.id)) continue;
        state.edited.set(record.id, record);
        changed = true;
      }
    }
    return changed;
  }

  function enforceLimits(history, {
    maxPerChannel = DEFAULT_MAX_PER_CHANNEL,
    maxTotal = DEFAULT_MAX_TOTAL,
  } = {}) {
    const all = [];
    for (const [channelId, state] of history) {
      for (const [id, record] of state.deleted) all.push({channelId, id, record, kind: 'deleted'});
      for (const [id, record] of state.edited) all.push({channelId, id, record, kind: 'edited'});
    }
    all.sort((a, b) => recordTimestamp(b.record) - recordTimestamp(a.record));

    const keep = new Set();
    const perChannel = new Map();
    for (const entry of all) {
      const count = perChannel.get(entry.channelId) || 0;
      if (count >= maxPerChannel) continue;
      if (keep.size >= maxTotal) break;
      perChannel.set(entry.channelId, count + 1);
      keep.add(`${entry.channelId}\u0000${entry.kind}\u0000${entry.id}`);
    }

    for (const [channelId, state] of history) {
      for (const [id] of state.deleted) {
        if (!keep.has(`${channelId}\u0000deleted\u0000${id}`)) state.deleted.delete(id);
      }
      for (const [id] of state.edited) {
        if (!keep.has(`${channelId}\u0000edited\u0000${id}`)) state.edited.delete(id);
      }
      if (!state.deleted.size && !state.edited.size) history.delete(channelId);
    }
  }

  return {
    DEFAULT_MAX_PER_CHANNEL,
    DEFAULT_MAX_TOTAL,
    ensureChannel,
    recordTimestamp,
    snowflakeTimestamp,
    channelIdFromPath,
    serializeHistory,
    normaliseRecord,
    importHistory,
    enforceLimits,
  };
});

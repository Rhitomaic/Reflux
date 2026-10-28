/**
 * src/plugins/messageLogger/renderer-side.js
 *
 * Deleted/edited message history for Fluxer.
 *
 * Fluxer's MESSAGE_DELETE gateway payload only contains `{id, channel_id}`,
 * so the message must be captured *before* Fluxer removes it from its store.
 * This plugin patches the message store's delete/update handlers, with a
 * gateway/DOM fallback when the store is not discoverable yet.
 *
 * Deleted messages are rendered as self-contained rows instead of cloning a
 * whole message group.  That keeps them visually stable when React re-renders
 * the channel, when switching channels, and when history is restored from
 * disk after a restart.
 *
 * History is kept in memory for the lifetime of the app.  The plugin setting
 * `plugins.messageLogger.persistHistory` additionally stores it under
 * `plugin-data/messageLogger.json` via the Reflux preload bridge.
 */

(function refluxMessageLogger() {
  'use strict';

  if (window.__reflux_messageLogger_loaded) return;
  window.__reflux_messageLogger_loaded = true;

  const TAG = '[Reflux:MessageLogger]';
  const patcher = window.__reflux.patcher;
  const messageHistory = window.__refluxMessageHistory;
  const PLUGIN_DATA_NAME = 'messageLogger';
  const SETTING_PERSIST = 'plugins.messageLogger.persistHistory';
  const MAX_PER_CHANNEL = 250;
  const MAX_TOTAL = 1200;
  const SAVE_DELAY_MS = 500;

  if (!messageHistory) {
    console.error(`${TAG} messageHistory helper was not injected; plugin disabled.`);
    return;
  }

  const SVG_TRASH = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>';
  const SVG_COPY = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';

  /** @type {Map<string, {deleted: Map<string, any>, edited: Map<string, any>}>} */
  const history = new Map();
  /** @type {WeakSet<object>} */
  const patchedStores = new WeakSet();
  const unpatches = [];
  let storeInstance = null;
  let gatewayPatched = false;
  let persist = false;
  let started = false;
  let stopped = false;
  let domObserver = null;
  let syncTimer = null;
  let saveTimer = null;
  let saveInFlight = false;
  let saveAgain = false;
  let savePromise = null;
  let removeCss = null;
  let unregisterContextMenu = null;
  let unsubscribeSetting = null;
  let unsubscribeWindowSetting = null;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function channelState(channelId) {
    const id = String(channelId || '');
    if (!id) return {deleted: new Map(), edited: new Map()};
    return messageHistory.ensureChannel(history, id);
  }

  function toPlainMessage(message) {
    if (!message) return null;
    try {
      if (typeof message.toJSON === 'function') return message.toJSON();
      return JSON.parse(JSON.stringify(message));
    } catch (err) {
      console.warn(`${TAG} Could not serialise message:`, err);
      return null;
    }
  }

  function displayName(author) {
    if (!author) return 'Unknown User';
    return author.global_name
      || author.globalName
      || author.display_name
      || author.displayName
      || author.username
      || author.name
      || 'Unknown User';
  }

  function recordTimestamp(record) {
    return messageHistory.recordTimestamp(record);
  }

  function snowflakeTimestamp(id) {
    return messageHistory.snowflakeTimestamp(id);
  }

  function formatTimestamp(raw) {
    const value = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(value)) return 'Unknown time';
    const date = new Date(value);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    const time = date.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
    if (sameDay) return `Today at ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = date.getFullYear() === yesterday.getFullYear()
      && date.getMonth() === yesterday.getMonth()
      && date.getDate() === yesterday.getDate();
    if (isYesterday) return `Yesterday at ${time}`;
    return `${date.toLocaleDateString()} at ${time}`;
  }

  function escapeSelector(value) {
    try { return CSS.escape(String(value)); }
    catch { return String(value).replace(/["\\]/g, '\\$&'); }
  }

  function findMessageElement(messageId) {
    if (!messageId) return null;
    const el = document.querySelector(`[data-message-id="${escapeSelector(messageId)}"]`);
    if (!el || el.closest('[data-reflux-ghost]')) return null;
    return el;
  }

  function findScroller() {
    return document.querySelector('[data-flx="channel.messages.scroller-inner"]');
  }

  function currentChannelId() {
    const scroller = findScroller();
    if (scroller) {
      const live = scroller.querySelector('[data-message-id][data-channel-id]');
      if (live) return live.getAttribute('data-channel-id');
    }

    // Empty channels (all messages deleted) have no data-channel-id nodes.
    // Fluxer routes are /channels/<guild-or-@me>/<channelId>[/<messageId>].
    return messageHistory.channelIdFromPath(location.pathname, (id) => history.has(id));
  }

  function getGroups(scroller) {
    if (!scroller) return [];
    return Array.from(scroller.querySelectorAll('[data-flx="channel.message-group.group"]'));
  }

  function groupTimestamp(group) {
    if (!group) return 0;
    const ghostTs = Number(group.getAttribute('data-reflux-ghost-timestamp'));
    if (Number.isFinite(ghostTs) && ghostTs > 0) return ghostTs;
    const time = group.querySelector('time[datetime]');
    if (time) {
      const ts = Date.parse(time.getAttribute('datetime'));
      if (Number.isFinite(ts)) return ts;
    }
    const firstMessage = group.querySelector('[data-message-id]');
    if (firstMessage) return snowflakeTimestamp(firstMessage.getAttribute('data-message-id'));
    return 0;
  }

  // ---------------------------------------------------------------------------
  // DOM snapshot / sanitisation
  // ---------------------------------------------------------------------------

  function contentRootFor(el) {
    if (!el) return null;
    return el.querySelector('[data-search-highlight-scope="message"]')
      || el.querySelector('[data-flx^="channel.user-message.render-message-content"]')
      || el.querySelector('[data-flx^="channel.user-message.message-text"] [class*="markup"]')
      || null;
  }

  function firstInGroup(el, selector) {
    const group = el?.closest?.('[data-flx="channel.message-group.group"]');
    const first = group?.querySelector('[data-message-id]');
    return first?.querySelector(selector) || el?.querySelector(selector) || null;
  }

  function readDomSnapshot(el) {
    if (!el || !el.isConnected) return {};
    const textEl = el.querySelector('[data-flx^="channel.user-message.message-text"]');
    const contentRoot = contentRootFor(el);
    const richEl = el.querySelector('[data-flx^="channel.user-message.container"]');
    const replyEl = el.querySelector('[data-flx^="channel.user-message.reply-preview"]');

    const avatarImg = firstInGroup(
      el,
      '[data-flx^="channel.user-message.message-avatar"] img, img[data-flx*="avatar"], img[class*="avatar"]',
    );
    const authorEl = firstInGroup(
      el,
      '[data-flx^="channel.message-username"], [data-flx^="channel.user-message.message-username"]',
    );

    let authorColor = '';
    if (authorEl) {
      try { authorColor = getComputedStyle(authorEl).color; } catch { /* ignore */ }
    }

    let richHtml = '';
    if (richEl) {
      const clone = richEl.cloneNode(true);
      clone.querySelectorAll('script, style, link, meta, [data-reflux-ghost]').forEach(node => node.remove());
      richHtml = clone.innerHTML;
    }

    let replyHtml = '';
    if (replyEl) {
      const clone = replyEl.cloneNode(true);
      clone.querySelectorAll('script, style, link, meta').forEach(node => node.remove());
      replyHtml = clone.innerHTML;
    }

    return {
      renderedContentHtml: contentRoot?.innerHTML || '',
      richHtml,
      replyHtml,
      avatarUrl: avatarImg?.currentSrc || avatarImg?.src || '',
      authorColor,
      domText: textEl?.innerText || textEl?.textContent || '',
    };
  }

  function sanitizeFragment(html) {
    if (!html) return '';
    const sanitizer = window.__reflux?.html;
    if (!sanitizer?.sanitize) {
      console.error(`${TAG} Safe HTML helper is unavailable; refusing to render captured HTML.`);
      return '';
    }
    return sanitizer.sanitize(String(html), {profile: 'message'});
  }

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  function makeRecord(message, action, domSnapshot = null) {
    const plain = toPlainMessage(message);
    const channelId = String(
      plain?.channel_id
      || message?.channelId
      || action?.channelId
      || action?.channel_id
      || currentChannelId()
      || '',
    );
    const id = String(plain?.id || message?.id || action?.id || '');
    if (!id || !channelId) return null;

    const snapshot = domSnapshot || readDomSnapshot(findMessageElement(id));
    const content = plain?.content
      ?? snapshot.domText
      ?? '';

    return {
      id,
      channelId,
      message: plain || {
        id,
        channel_id: channelId,
        content,
        timestamp: new Date().toISOString(),
        author: {},
        attachments: [],
        embeds: [],
      },
      content,
      renderedContentHtml: snapshot.renderedContentHtml || '',
      richHtml: snapshot.richHtml || '',
      replyHtml: snapshot.replyHtml || '',
      avatarUrl: snapshot.avatarUrl || '',
      authorColor: snapshot.authorColor || '',
      deletedAt: Date.now(),
      editedAt: 0,
      originalContent: '',
      originalHtml: '',
      edits: [],
    };
  }

  function recordDeleted(message, action) {
    const channelId = String(
      action?.channelId || action?.channel_id || message?.channelId || message?.channel_id || '',
    );
    const id = String(action?.id || message?.id || '');
    if (!channelId || !id) return;
    const state = channelState(channelId);
    if (state.deleted.has(id)) return;

    const record = makeRecord(message, {channelId, id});
    if (!record) return;

    const priorEdit = state.edited.get(id);
    if (priorEdit) {
      record.originalContent = priorEdit.originalContent || '';
      record.originalHtml = priorEdit.originalHtml || '';
      record.edits = Array.isArray(priorEdit.edits) ? priorEdit.edits.slice() : [];
      state.edited.delete(id);
    }

    state.deleted.set(id, record);
    enforceLimits();
    saveSoon();
    scheduleSync();
  }

  function recordEdited(oldMessage, newWireMessage, domSnapshot = null) {
    const oldPlain = toPlainMessage(oldMessage);
    const channelId = String(oldPlain?.channel_id || newWireMessage?.channel_id || '');
    const id = String(oldPlain?.id || newWireMessage?.id || '');
    if (!channelId || !id) return;

    const state = channelState(channelId);
    if (state.deleted.has(id)) return;

    const oldContent = oldPlain?.content || '';
    const newContent = newWireMessage?.content ?? oldContent;
    if (oldContent === newContent) return;

    const existing = state.edited.get(id);
    if (existing) {
      if (existing.message?.content === oldContent) return;
      existing.edits.push({content: oldContent, at: Date.now()});
      existing.message = oldPlain;
      existing.content = newContent;
      existing.editedAt = Date.now();
      saveSoon();
      scheduleSync();
      return;
    }

    const record = makeRecord(oldPlain || oldMessage, {channelId, id}, domSnapshot);
    if (!record) return;
    record.deletedAt = 0;
    record.editedAt = Date.now();
    record.content = newContent;
    record.originalContent = oldContent;
    record.originalHtml = record.renderedContentHtml || '';
    record.edits = [{content: oldContent, at: record.editedAt}];
    state.edited.set(id, record);
    saveSoon();
    scheduleSync();
  }

  function enforceLimits() {
    messageHistory.enforceLimits(history, {maxPerChannel: MAX_PER_CHANNEL, maxTotal: MAX_TOTAL});
  }

  // ---------------------------------------------------------------------------
  // Fluxer message-store patching
  // ---------------------------------------------------------------------------

  function asStore(exports) {
    const candidates = [exports, exports?.default, exports?.messages, exports?.store];
    for (const candidate of candidates) {
      if (candidate
        && typeof candidate.handleMessageDelete === 'function'
        && typeof candidate.getMessage === 'function') {
        return candidate;
      }
    }
    return null;
  }

  function patchStore(store) {
    if (!store || patchedStores.has(store)) return;
    patchedStores.add(store);
    storeInstance = store;

    unpatches.push(patcher.instead(store, 'handleMessageDelete', (args, original) => {
      const action = args?.[0] || {};
      try {
        if (action.channelId && action.id) {
          const message = store.getMessage(action.channelId, action.id);
          if (message) recordDeleted(message, action);
        }
      } catch (err) {
        console.warn(`${TAG} Could not capture deleted message:`, err);
      }
      const result = original(...args);
      scheduleSync();
      return result;
    }));

    unpatches.push(patcher.instead(store, 'handleMessageDeleteBulk', (args, original) => {
      const action = args?.[0] || {};
      try {
        const ids = Array.isArray(action.ids) ? action.ids : [];
        for (const id of ids) {
          const message = store.getMessage(action.channelId, id);
          if (message) recordDeleted(message, {channelId: action.channelId, id});
        }
      } catch (err) {
        console.warn(`${TAG} Could not capture bulk-deleted messages:`, err);
      }
      const result = original(...args);
      scheduleSync();
      return result;
    }));

    unpatches.push(patcher.instead(store, 'handleMessageUpdate', (args, original) => {
      const wire = args?.[0]?.message;
      let oldPlain = null;
      let domSnapshot = null;
      try {
        if (wire?.channel_id && wire?.id) {
          oldPlain = toPlainMessage(store.getMessage(wire.channel_id, wire.id));
          domSnapshot = readDomSnapshot(findMessageElement(wire.id));
        }
      } catch (err) {
        console.warn(`${TAG} Could not capture edited message:`, err);
      }
      const result = original(...args);
      try {
        if (oldPlain) recordEdited(oldPlain, wire, domSnapshot);
      } catch (err) {
        console.warn(`${TAG} Could not record edit:`, err);
      }
      scheduleSync();
      return result;
    }));

    console.log(`${TAG} Message store patched.`);
  }

  function discoverStore() {
    try {
      for (const {exports} of patcher.findModules(exports => Boolean(asStore(exports)))) {
        const store = asStore(exports);
        if (store) patchStore(store);
      }
      unpatches.push(patcher.patch(
        exports => Boolean(asStore(exports)),
        (exports) => {
          const store = asStore(exports);
          if (store) patchStore(store);
          return exports;
        },
      ));
    } catch (err) {
      console.warn(`${TAG} Store discovery failed:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Gateway / DOM fallback (used when the store is not discoverable)
  // ---------------------------------------------------------------------------

  function hasStorePatch() {
    return Boolean(storeInstance);
  }

  function fallbackDelete(data) {
    if (!data?.id || !data?.channel_id) return;
    const channelId = String(data.channel_id);
    const id = String(data.id);
    if (channelState(channelId).deleted.has(id)) return;
    if (hasStorePatch() && storeInstance) {
      try {
        const message = storeInstance.getMessage(channelId, id);
        if (message) {
          recordDeleted(message, {channelId, id});
          return;
        }
      } catch { /* ignore */ }
    }
    const el = findMessageElement(id);
    if (!el) return;
    const snapshot = readDomSnapshot(el);
    const article = el.matches('[data-message-id]') ? el : el.closest('[data-message-id]');
    const authorEl = firstInGroup(el, '[data-flx^="channel.message-username"], [data-flx^="channel.user-message.message-username"]');
    const timeEl = el.querySelector('time[datetime]');
    const fake = {
      id,
      channel_id: channelId,
      content: snapshot.domText || '',
      timestamp: timeEl?.getAttribute('datetime') || new Date().toISOString(),
      author: {
        id: article?.getAttribute('data-flx-author-id') || '',
        username: article?.getAttribute('data-flx-author-name')
          || article?.getAttribute('data-flx-author-username')
          || authorEl?.textContent?.trim()
          || 'Unknown User',
      },
      attachments: [],
      embeds: [],
    };
    recordDeleted(fake, {channelId, id});
  }

  function fallbackEdit(data) {
    if (!data?.id || !data?.channel_id) return;
    const channelId = String(data.channel_id);
    const id = String(data.id);
    if (hasStorePatch() && storeInstance) {
      try {
        const old = storeInstance.getMessage(channelId, id);
        if (old) {
          recordEdited(old, data);
          return;
        }
      } catch { /* ignore */ }
    }
    const el = findMessageElement(id);
    if (!el) return;
    const snapshot = readDomSnapshot(el);
    if (!snapshot.domText) return;
    const existing = channelState(channelId).edited.get(id);
    const oldContent = existing?.message?.content ?? snapshot.domText;
    const newContent = data.content ?? oldContent;
    if (oldContent === newContent) return;

    const article = el.matches('[data-message-id]') ? el : el.closest('[data-message-id]');
    const fakeOld = {
      id,
      channel_id: channelId,
      content: oldContent,
      timestamp: el.querySelector('time[datetime]')?.getAttribute('datetime') || new Date().toISOString(),
      author: {
        id: article?.getAttribute('data-flx-author-id') || '',
        username: article?.getAttribute('data-flx-author-name')
          || article?.getAttribute('data-flx-author-username')
          || firstInGroup(el, '[data-flx^="channel.message-username"], [data-flx^="channel.user-message.message-username"]')?.textContent?.trim()
          || 'Unknown User',
      },
      attachments: [],
      embeds: [],
    };
    const record = makeRecord(fakeOld, {channelId, id}, snapshot);
    if (!record) return;
    record.deletedAt = 0;
    record.editedAt = Date.now();
    record.content = newContent;
    record.originalContent = oldContent;
    record.originalHtml = snapshot.renderedContentHtml || '';
    record.edits = [{content: oldContent, at: record.editedAt}];
    channelState(channelId).edited.set(id, record);
    saveSoon();
    scheduleSync();
  }

  function patchGatewayFallback() {
    if (gatewayPatched) return;
    gatewayPatched = true;
    unpatches.push(patcher.instead(JSON, 'parse', (args, original) => {
      const result = original(...args);
      try {
        if (result && typeof result === 'object') {
          if (result.t === 'MESSAGE_DELETE') fallbackDelete(result.d);
          else if (result.t === 'MESSAGE_DELETE_BULK') {
            const data = result.d || {};
            if (Array.isArray(data.ids) && data.channel_id) {
              for (const id of data.ids) fallbackDelete({id, channel_id: data.channel_id});
            }
          } else if (result.t === 'MESSAGE_UPDATE') {
            fallbackEdit(result.d?.message || result.d);
          }
        }
      } catch (err) {
        console.warn(`${TAG} Gateway fallback failed:`, err);
      }
      return result;
    }));
  }

  // ---------------------------------------------------------------------------
  // Ghost rendering
  // ---------------------------------------------------------------------------

  function makeDeletionBadge() {
    const badge = document.createElement('span');
    badge.className = 'rx-ghost-badge';
    badge.textContent = 'Deleted';
    return badge;
  }

  function makeAvatar(record) {
    const avatar = document.createElement('div');
    avatar.className = 'rx-ghost-avatar';
    if (record.avatarUrl) {
      const img = document.createElement('img');
      img.src = record.avatarUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        avatar.replaceChildren(makeAvatarFallback(record));
      }, {once: true});
      avatar.appendChild(img);
    } else {
      avatar.appendChild(makeAvatarFallback(record));
    }
    return avatar;
  }

  function makeAvatarFallback(record) {
    const fallback = document.createElement('div');
    fallback.className = 'rx-ghost-avatar-fallback';
    fallback.textContent = displayName(record.message?.author).trim().charAt(0).toUpperCase() || '?';
    fallback.style.background = record.authorColor || 'var(--brand-500, #5865f2)';
    fallback.style.color = '#fff';
    return fallback;
  }

  function makeOriginalBlock(record) {
    const wrap = document.createElement('div');
    wrap.className = 'rx-edit-original';
    wrap.setAttribute('data-reflux-edit-channel', record.channelId || '');
    wrap.setAttribute('data-reflux-edit-id', record.id || '');

    const label = document.createElement('div');
    label.className = 'rx-edit-original-label';
    label.textContent = 'Original';

    const body = document.createElement('div');
    body.className = 'rx-edit-original-body';
    const html = record.originalHtml || '';
    if (html && html !== record.renderedContentHtml) body.innerHTML = sanitizeFragment(html);
    else body.textContent = record.originalContent || record.edits?.[0]?.content || '[no text]';

    wrap.appendChild(label);
    wrap.appendChild(body);
    return wrap;
  }

  function makeRichContent(record) {
    const wrap = document.createElement('div');
    wrap.className = 'rx-ghost-rich';

    if (record.richHtml) {
      wrap.innerHTML = sanitizeFragment(record.richHtml);
      return wrap;
    }

    const message = record.message || {};
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      const url = attachment.url || attachment.proxy_url || attachment.proxyURL;
      if (!url) continue;
      const type = String(attachment.content_type || attachment.contentType || '');
      const filename = attachment.filename || attachment.name || 'attachment';

      if (type.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'rx-ghost-attachment-image';
        img.src = url;
        img.alt = filename;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        wrap.appendChild(img);
      }

      const link = document.createElement('a');
      link.className = 'rx-ghost-attachment';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = filename;
      wrap.appendChild(link);
    }

    const embeds = Array.isArray(message.embeds) ? message.embeds : [];
    for (const embed of embeds) {
      if (!embed) continue;
      const url = embed.url || embed.image?.url || '';
      const line = document.createElement(url ? 'a' : 'div');
      line.className = 'rx-ghost-embed';
      if (url) {
        line.href = url;
        line.target = '_blank';
        line.rel = 'noopener noreferrer';
      }
      line.textContent = embed.title || embed.description || embed.provider?.name || url || 'Embedded content';
      wrap.appendChild(line);
    }

    return wrap;
  }

  function makeGhostRow(record) {
    const group = document.createElement('div');
    group.className = 'rx-ghost-group';
    group.setAttribute('role', 'group');
    group.setAttribute('data-flx', 'channel.message-group.group');
    group.setAttribute('data-reflux-ghost', 'true');
    group.setAttribute('data-reflux-ghost-id', record.id);
    group.setAttribute('data-reflux-ghost-channel', record.channelId);
    group.setAttribute('data-reflux-ghost-timestamp', String(recordTimestamp(record)));

    const row = document.createElement('div');
    row.className = 'rx-ghost-row';
    row.setAttribute('role', 'article');
    row.setAttribute('data-reflux-ghost-message', 'true');
    row.setAttribute('aria-label', `Deleted message from ${displayName(record.message?.author)}`);

    row.appendChild(makeAvatar(record));

    const body = document.createElement('div');
    body.className = 'rx-ghost-body';

    const header = document.createElement('div');
    header.className = 'rx-ghost-header';

    const author = document.createElement('span');
    author.className = 'rx-ghost-author';
    author.textContent = displayName(record.message?.author);
    if (record.authorColor) author.style.color = record.authorColor;

    const time = document.createElement('span');
    time.className = 'rx-ghost-time';
    time.textContent = formatTimestamp(record.message?.timestamp);

    header.appendChild(author);
    header.appendChild(time);
    header.appendChild(makeDeletionBadge());
    body.appendChild(header);

    if (record.replyHtml) {
      const reply = document.createElement('div');
      reply.className = 'rx-ghost-reply';
      reply.innerHTML = sanitizeFragment(record.replyHtml);
      body.appendChild(reply);
    }

    const content = document.createElement('div');
    content.className = 'rx-ghost-content';
    const rich = makeRichContent(record);
    if (record.renderedContentHtml) {
      content.innerHTML = sanitizeFragment(record.renderedContentHtml);
    } else if (record.message?.content) {
      content.textContent = record.message.content;
      content.style.whiteSpace = 'pre-wrap';
    } else if (!rich.childElementCount) {
      content.classList.add('rx-ghost-missing');
      content.textContent = '[message content unavailable]';
    }
    if (content.textContent.trim() || content.childElementCount) body.appendChild(content);
    if (rich.childElementCount) body.appendChild(rich);

    if (record.originalContent || record.originalHtml) {
      body.appendChild(makeOriginalBlock(record));
    }

    row.appendChild(body);
    group.appendChild(row);
    return group;
  }

  function insertGhostInOrder(ghost) {
    const scroller = findScroller();
    if (!scroller) return false;

    const groups = getGroups(scroller).filter(group => group !== ghost);
    const ghostTs = Number(ghost.getAttribute('data-reflux-ghost-timestamp')) || 0;
    let before = null;
    for (const group of groups) {
      const groupTs = groupTimestamp(group);
      if (groupTs && ghostTs && groupTs > ghostTs) {
        before = group;
        break;
      }
    }

    if (before?.parentElement) {
      before.parentElement.insertBefore(ghost, before);
      return true;
    }

    const parent = groups[groups.length - 1]?.parentElement
      || scroller.querySelector('[data-flx="channel.messages.focus-ring-scope"]')
      || scroller;
    parent.appendChild(ghost);
    return true;
  }

  function syncGhosts() {
    if (stopped) return;
    const scroller = findScroller();
    if (!scroller) {
      document.querySelectorAll('[data-reflux-ghost]').forEach(el => el.remove());
      applyEditBlocks();
      return;
    }

    const channelId = currentChannelId();
    const state = channelId ? history.get(channelId) : null;
    const records = state ? Array.from(state.deleted.values()) : [];
    const wanted = new Map(records.map(record => [record.id, record]));

    for (const ghost of Array.from(document.querySelectorAll('[data-reflux-ghost]'))) {
      const id = ghost.getAttribute('data-reflux-ghost-id');
      const ghostChannel = ghost.getAttribute('data-reflux-ghost-channel');
      if (!id || !channelId || ghostChannel !== channelId || !wanted.has(id)) ghost.remove();
    }

    const existing = new Map();
    for (const ghost of Array.from(scroller.querySelectorAll('[data-reflux-ghost]'))) {
      const id = ghost.getAttribute('data-reflux-ghost-id');
      if (id) existing.set(id, ghost);
    }

    const sorted = records.slice().sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
    for (const record of sorted) {
      if (existing.has(record.id)) continue;
      const ghost = makeGhostRow(record);
      if (insertGhostInOrder(ghost)) existing.set(record.id, ghost);
    }

    applyEditBlocks();
  }

  function scheduleSync() {
    if (stopped || syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      try { syncGhosts(); }
      catch (err) { console.warn(`${TAG} Sync failed:`, err); }
    }, 120);
  }

  function applyEditBlocks() {
    for (const state of history.values()) {
      for (const record of state.edited.values()) {
        const el = findMessageElement(record.id);
        if (!el) continue;

        const existing = el.querySelector('.rx-edit-original');
        if (!record.originalContent && !record.originalHtml) {
          existing?.remove();
          continue;
        }
        if (existing) continue;

        const text = el.querySelector('[data-flx^="channel.user-message.message-text"]')
          || el.querySelector('[data-flx^="channel.user-message.render-message-content"]');
        if (!text) continue;
        text.insertAdjacentElement('afterend', makeOriginalBlock(record));
        el.setAttribute('data-reflux-edited', 'true');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function serializeHistory() {
    return messageHistory.serializeHistory(history);
  }

  function importHistory(data) {
    if (!messageHistory.importHistory(history, data)) return;
    enforceLimits();
    scheduleSync();
  }

  async function loadPersisted() {
    const bridge = window.refluxBridge;
    if (!bridge?.readPluginData) return;
    try {
      const data = await bridge.readPluginData(PLUGIN_DATA_NAME, null);
      importHistory(data);
    } catch (err) {
      console.warn(`${TAG} Could not load history:`, err);
    }
  }

  function saveNow(force = false) {
    if (!persist || (stopped && !force)) return Promise.resolve();
    const bridge = window.refluxBridge;
    if (!bridge?.writePluginData) return Promise.resolve();
    if (saveInFlight) {
      saveAgain = true;
      return savePromise ?? Promise.resolve();
    }
    saveInFlight = true;
    savePromise = (async () => {
      try {
        await bridge.writePluginData(PLUGIN_DATA_NAME, serializeHistory());
      } catch (err) {
        console.warn(`${TAG} Could not save history:`, err);
      } finally {
        saveInFlight = false;
        savePromise = null;
        if (saveAgain) {
          saveAgain = false;
          if (!stopped) saveSoon();
        }
      }
    })();
    return savePromise;
  }

  /**
   * Wait for any in-flight write, then write the current snapshot once more.
   * stop() awaits this so hot reload cannot lose a pending debounced save.
   */
  async function flushPersistence() {
    if (!persist) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    while (saveInFlight && savePromise) {
      try { await savePromise; }
      catch { /* saveNow logs write failures */ }
    }
    saveAgain = false;
    await saveNow(true);
  }

  function saveSoon() {
    if (!persist || stopped) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveNow();
    }, SAVE_DELAY_MS);
  }

  async function clearPersisted() {
    const bridge = window.refluxBridge;
    if (!bridge?.clearPluginData) return;
    try { await bridge.clearPluginData(PLUGIN_DATA_NAME); }
    catch (err) { console.warn(`${TAG} Could not clear history file:`, err); }
  }

  // ---------------------------------------------------------------------------
  // Clear actions + context menu
  // ---------------------------------------------------------------------------

  function removeAllGhosts() {
    document.querySelectorAll('[data-reflux-ghost]').forEach(el => el.remove());
    document.querySelectorAll('.rx-edit-original').forEach(el => el.remove());
    document.querySelectorAll('[data-reflux-edited]').forEach(el => el.removeAttribute('data-reflux-edited'));
  }

  function showToast(text) {
    const toast = document.createElement('div');
    toast.textContent = text;
    toast.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:9px 14px', 'border-radius:8px',
      'background:var(--background-floating,#111214)', 'color:var(--text-primary,#fff)',
      'font-size:13px', 'font-weight:500', 'box-shadow:0 4px 16px rgba(0,0,0,.32)',
      'pointer-events:none', 'opacity:0', 'transition:opacity 140ms ease',
    ].join(';');
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 180);
    }, 2400);
  }

  function clearAllHistory() {
    history.clear();
    removeAllGhosts();
    void (persist ? saveNow() : clearPersisted());
    showToast('Message history cleared');
  }

  function clearChannelHistory(channelId) {
    if (!channelId) return;
    history.delete(channelId);
    document.querySelectorAll(`[data-reflux-ghost-channel="${escapeSelector(channelId)}"]`).forEach(el => el.remove());
    document.querySelectorAll(`[data-reflux-edit-channel="${escapeSelector(channelId)}"]`).forEach((el) => {
      const message = el.closest('[data-message-id]');
      message?.removeAttribute('data-reflux-edited');
      el.remove();
    });
    applyEditBlocks();
    void (persist ? saveNow() : clearPersisted());
    showToast('Channel message history cleared');
  }

  async function copyGhostText(ghost) {
    const channelId = ghost?.getAttribute('data-reflux-ghost-channel');
    const id = ghost?.getAttribute('data-reflux-ghost-id');
    const record = channelId && id ? history.get(channelId)?.deleted.get(id) : null;
    const text = record?.message?.content || record?.content || '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { /* clipboard may be unavailable in some contexts */ }
    showToast('Message text copied');
  }

  function registerContextMenu() {
    const api = window.__reflux?.contextMenu;
    if (!api?.register) return;
    unregisterContextMenu = api.register((target) => {
      const ghost = target.closest?.('[data-reflux-ghost]');
      if (!ghost) return null;
      const channelId = ghost.getAttribute('data-reflux-ghost-channel');
      return {
        title: 'Message Logger',
        items: [
          {
            label: 'Copy Message Text',
            icon: SVG_COPY,
            action: () => { void copyGhostText(ghost); },
          },
          {type: 'separator'},
          {
            label: 'Clear This Channel',
            icon: SVG_TRASH,
            action: () => clearChannelHistory(channelId),
          },
          {
            label: 'Clear Message History',
            icon: SVG_TRASH,
            danger: true,
            action: clearAllHistory,
          },
        ],
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  function injectStyles() {
    removeCss = window.__reflux.ui.injectCSS('messageLogger', `
      .rx-ghost-group {
        margin: 2px 0;
        border-radius: 6px;
        overflow: hidden;
        background: color-mix(in srgb, var(--status-danger, #ed4245) 6%, transparent);
        border-left: 2px solid color-mix(in srgb, var(--status-danger, #ed4245) 42%, transparent);
      }
      .rx-ghost-row {
        display: grid;
        grid-template-columns:
          var(--chat-horizontal-padding, 1rem)
          var(--message-avatar-size, 2.5rem)
          var(--message-gutter, .75rem)
          minmax(0, 1fr);
        margin-inline: calc(-1 * var(--chat-horizontal-padding, 1rem));
        padding-block: var(--message-spacing-y, .125rem);
        padding-inline-end: var(--chat-horizontal-padding, 1rem);
        box-sizing: border-box;
        color: var(--text-chat, var(--text-normal, #dbdee1));
        font-size: inherit;
        line-height: 1.375rem;
        min-width: 0;
        position: relative;
      }
      .rx-ghost-row:hover {
        background: color-mix(in srgb, var(--status-danger, #ed4245) 4%, transparent);
      }
      .rx-ghost-avatar {
        grid-column: 2;
        width: var(--message-avatar-size, 2.5rem);
        height: var(--message-avatar-size, 2.5rem);
        border-radius: 50%;
        overflow: hidden;
        flex-shrink: 0;
        background: var(--background-modifier-accent, rgba(255,255,255,.08));
      }
      .rx-ghost-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .rx-ghost-avatar-fallback {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: .9rem;
        font-weight: 700;
      }
      .rx-ghost-body {
        grid-column: 4;
        min-width: 0;
      }
      .rx-ghost-header {
        display: flex;
        align-items: baseline;
        gap: .375rem;
        flex-wrap: wrap;
        min-width: 0;
      }
      .rx-ghost-author {
        font-weight: 600;
        color: var(--text-primary, var(--text-normal, #f2f3f5));
        white-space: nowrap;
      }
      .rx-ghost-time {
        color: var(--message-timestamp-color, var(--text-primary-muted, #949ba4));
        font-size: .75rem;
        white-space: nowrap;
      }
      .rx-ghost-badge {
        display: inline-flex;
        align-items: center;
        padding: 0 .375rem;
        border-radius: 999px;
        background: color-mix(in srgb, var(--status-danger, #ed4245) 14%, transparent);
        color: var(--status-danger, #ed4245);
        font-size: .625rem;
        font-weight: 700;
        letter-spacing: .04em;
        line-height: 1.125rem;
        text-transform: uppercase;
      }
      .rx-ghost-content {
        margin-top: .0625rem;
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--text-chat, var(--text-normal, #dbdee1));
      }
      .rx-ghost-content img {
        max-width: 100%;
        height: auto;
      }
      .rx-ghost-rich {
        margin-top: .25rem;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: .25rem;
        min-width: 0;
      }
      .rx-ghost-attachment-image {
        max-width: min(100%, 28rem);
        max-height: 18rem;
        border-radius: 6px;
        object-fit: contain;
      }
      .rx-ghost-attachment,
      .rx-ghost-embed {
        color: var(--text-link, #00a8fc);
        text-decoration: none;
        overflow-wrap: anywhere;
      }
      .rx-ghost-attachment:hover,
      .rx-ghost-embed:hover {
        text-decoration: underline;
      }
      .rx-ghost-reply {
        margin-top: .25rem;
        color: var(--text-muted, #949ba4);
        font-size: .8125rem;
      }
      .rx-ghost-missing {
        color: var(--text-muted, #949ba4);
        font-style: italic;
      }
      .rx-edit-original {
        margin-top: .25rem;
        padding: .25rem .5rem;
        border-left: 2px solid color-mix(in srgb, var(--status-warning, #f0b232) 55%, transparent);
        border-radius: 0 4px 4px 0;
        background: color-mix(in srgb, var(--status-warning, #f0b232) 7%, transparent);
        color: var(--text-muted, #949ba4);
        font-size: .8125rem;
        line-height: 1.35rem;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .rx-edit-original-label {
        color: var(--status-warning, #f0b232);
        font-size: .625rem;
        font-weight: 700;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      .rx-edit-original-body {
        color: var(--text-muted, #949ba4);
      }
      .rx-edit-original-body img {
        max-width: 100%;
        height: auto;
      }
    `);
  }

  // ---------------------------------------------------------------------------
  // Boot / stop
  // ---------------------------------------------------------------------------

  function startDomObserver() {
    domObserver = new MutationObserver(() => scheduleSync());
    domObserver.observe(document.documentElement || document, {childList: true, subtree: true});
  }

  async function readPersistSetting() {
    const bridge = window.refluxBridge;
    if (!bridge?.getSetting) return false;
    try { return Boolean(await bridge.getSetting(SETTING_PERSIST, false)); }
    catch { return false; }
  }

  async function handlePersistChange(enabled) {
    const next = Boolean(enabled);
    if (persist === next) return;
    persist = next;
    if (persist) {
      await loadPersisted();
      saveSoon();
    } else {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      await clearPersisted();
    }
  }

  async function start() {
    if (started) return;
    started = true;
    stopped = false;

    injectStyles();
    discoverStore();
    patchGatewayFallback();
    registerContextMenu();
    startDomObserver();

    unsubscribeSetting = window.__reflux.events.on('setting-changed', (key, value) => {
      if (key === SETTING_PERSIST) void handlePersistChange(value);
    });
    const onWindowSetting = (event) => {
      if (event?.detail?.key === SETTING_PERSIST) void handlePersistChange(event.detail.value);
    };
    window.addEventListener('reflux:setting-changed', onWindowSetting);
    unsubscribeWindowSetting = () => window.removeEventListener('reflux:setting-changed', onWindowSetting);

    persist = await readPersistSetting();
    if (stopped) return;
    if (persist) await loadPersisted();
    if (stopped) return;
    scheduleSync();

    console.log(`${TAG} Started. Persistence: ${persist ? 'on' : 'off'}`);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;

    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;

    domObserver?.disconnect();
    domObserver = null;

    unregisterContextMenu?.();
    unregisterContextMenu = null;
    unsubscribeSetting?.();
    unsubscribeSetting = null;
    unsubscribeWindowSetting?.();
    unsubscribeWindowSetting = null;

    for (const unpatch of unpatches.splice(0)) {
      try { unpatch(); } catch { /* ignore */ }
    }

    removeAllGhosts();
    removeCss?.();
    removeCss = null;

    started = false;
    try {
      await flushPersistence();
    } finally {
      history.clear();
      window.__reflux_messageLogger_loaded = false;
      console.log(`${TAG} Stopped.`);
    }
  }

  window.__reflux.pluginManager.register({
    name: 'messageLogger',
    start,
    stop,
  });
})();

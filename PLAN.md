# Plugin Optimization Plan

## Current plugin audit

| Plugin | Main issues found | Priority |
|---|---|---|
| **Debug Tools** | Patches global `JSON.parse`, parses unrelated JSON, re-renders the entire log on every gateway event, uses inline styles, no filtering/export, weak accessibility | High |
| **Invisible Typing** | Hardcoded `web.fluxer.app` filter, installs/replaces a global `webRequest` listener, no validation against other listeners, no status feedback | Medium |
| **Message Logger** | Large HTML snapshots are injected with a permissive sanitizer, possible duplicate content rendering, whole-document mutation scans, heavy persistence writes, save/stop race during hot reload | Highest |
| **Settings UI** | React custom settings can leak when cards are rebuilt, imported plugins are accepted even if registration fails, raw SVG/icon HTML injection, broad settings observer, missing import preview/confirmation | High |

---

# Improvement plan

## 1. Shared platform groundwork

Do these once, then reuse across plugins.

### 1.1 Add a safe HTML rendering helper
- Add a renderer helper for allowlist-based HTML sanitization.
- Strip scripts, event attributes, dangerous URLs, forms, embeds, SVG script content, and unsafe CSS.
- Use it from **Message Logger** and **Settings UI** instead of ad-hoc sanitizers.
- Keep plugin-specific policy options, because message content and plugin icons need different allowlists.

### 1.2 Support async plugin shutdown
- Teach `pluginManager` to await `stop()` when reloading/unregistering.
- Specifically needed for Message Logger so it can flush pending persistence before hot reload.
- Keep backwards compatibility with synchronous `stop()` implementations.

### 1.3 Standardize on Phase 3 APIs
Replace legacy patterns where practical:
- `this.styles` instead of manual `<style>` injection.
- `this.patches` / `patchRegistry` instead of manual `unpatches` arrays.
- `this.dataStore` for small UI state.
- `gateway` instead of `JSON.parse` interception.
- `toasts` instead of custom toast DOM.
- `commands` for debug/message-logger actions.
- `this.ipc` only where native main-process work is actually needed.

### 1.4 Add a plugin smoke harness
No test framework currently exists, so add focused VM/browser-style scripts for:
- HTML sanitization
- metadata parsing
- history serialization/import
- record limits/eviction
- import validation
- filtering/matching logic

---

## 2. Debug Tools

### P0 — correctness and overhead
- Replace the global `JSON.parse` patch with `window.__reflux.gateway.onAny()`.
- Wait for `gateway.ready` before reporting the panel as active.
- If the gateway hook is unavailable, show that state in the panel instead of silently patching `JSON.parse`.
- Stop rendering the log while the panel is closed.
- Keep a fixed-size ring buffer and update the visible log on a short debounce, not on every event.
- Avoid pretty-printing every entry on every update; cache serialized entries or build output lazily.

### P1 — usability
- Add event-type filtering and text search.
- Add “Export JSON” and “Copy filtered log”.
- Show a clear paused/active status indicator.
- Persist `paused` and `includeContent` through `DataStore`.
- Add commands: open panel, clear log, toggle pause.

### P2 — UI and maintainability
- Move inline styles into a managed CSS block.
- Use a proper dialog/panel with `role="dialog"`, focus handling, Escape-to-close, and keyboard-accessible controls.
- Clarify redaction behavior and avoid logging sensitive IDs/content unless explicitly enabled.

---

## 3. Invisible Typing

### P0 — make the interception reliable
- Replace the hardcoded host with a filter that covers stable and Canary Fluxer domains.
- Restrict the filter to the actual typing endpoint and `POST` requests.
- Verify Electron’s `onBeforeRequest` listener behavior so stopping this plugin cannot remove another plugin’s request listener.
- Prefer centralizing request interception in a small shared network-filter registry if more plugins need it.

### P1 — reduce global impact
- Investigate replacing the network hook with a targeted renderer patch on Fluxer’s typing-send method.
- Keep the request-level block only as a fallback.
- Add status reporting so the user can see whether interception is active.

### P2 — UX
- Add a settings toggle only if it can be done without breaking the current always-on behavior.
- Use the toast API for enable/disable feedback.

---

## 4. Message Logger

This is the largest and highest-risk plugin, so handle it first within the plugin work.

### P0 — safety and correctness
- Replace the current sanitizer with an allowlist-based sanitizer.
- Stop injecting raw `innerHTML` unless it has passed that sanitizer.
- Remove duplicate render paths:
  - `renderedContentHtml`
  - `richHtml`
  - plain `message.content`

  Normalize these into one render model so the same content is not shown twice.
- Prefer capturing a structured snapshot instead of cloning the entire message container.
- Continue using the message-store patch as the primary capture path.
- Replace `JSON.parse` gateway fallback with `gateway.on('MESSAGE_DELETE' / 'MESSAGE_UPDATE' / 'MESSAGE_DELETE_BULK')`.
- Store only the minimum needed HTML/text/attachment/embed data.
- Ensure `stop()` flushes persistence before unregistering, using the async lifecycle support.

### P1 — performance
- Scope the DOM observer to the message scroller instead of the entire document.
- Ignore mutations caused by the plugin’s own ghost/edit nodes.
- Index records by channel and message ID.
- Run `applyEditBlocks()` only for the current channel, not all history.
- Reuse ghost nodes instead of rebuilding and rescanning on every sync.
- Make record limits incremental rather than sorting the entire history on every delete/edit.
- Cap saved HTML size per record and skip oversized snapshots.
- Debounce and coalesce persistence writes; avoid rewriting large JSON while nothing changed.
- Use the shared toast API instead of the custom toast implementation.

### P2 — UX and maintenance
- Add confirmation for “Clear all history” and “Clear this channel.”
- Show edit counts and clearer deleted/edited timestamps.
- Add a filter/search panel for history.
- Add commands for clear-current-channel and clear-all.
- Migrate to `this.styles` and `this.patches` for automatic cleanup.
- Verify hot reload preserves or intentionally clears history.

### Live validation matrix
- Single delete
- Bulk delete
- Repeated edits
- Replies, attachments, embeds, images, emoji
- Channel switching
- Restart with persistence enabled
- Hot reload with pending save
- Malicious/odd HTML content
- Large history near 250/channel and 1200 total limits

---

## 5. Settings UI

### P0 — fix leaks and import reliability
- Call `react.unmountWithin(instContent)` before `instContent.innerHTML = ''` in `renderPlugins()`. Currently custom setting React roots can leak when the plugin list is rebuilt.
- Make imported plugin startup report success/failure:
  - Detect duplicate plugin names.
  - Detect registration failure.
  - Do not mark an imported plugin enabled if it never registered.
  - Show a toast/error instead of silently storing it.
- Avoid raw SVG/`onerror` injection for plugin icons.
  - Validate raw SVG or render it through the shared safe HTML helper.
  - Attach image error fallback with an event listener, not inline JavaScript.
- Add confirmation before removing an imported plugin.

### P1 — import workflow
- Add an import preview showing name, author, version, description, icon, and file size.
- Detect duplicate names and offer update/replace instead of silently failing.
- Add export/backup for imported plugins.
- Enforce a reasonable source-size limit.
- Cache the imported plugin list instead of reading settings repeatedly.
- Load built-in plugin settings in parallel where possible.
- Add success/failure toasts for import, toggle, remove, and settings save.

### P1 — performance and stability
- Make the sidebar MutationObserver cheap:
  - Return immediately if the Reflux section already exists.
  - Scope observation to the settings modal when possible.
  - Avoid scanning all sidebar categories on every app mutation.
- Add a fallback when the “Developer” section cannot be found.
- Keep the Reflux panel and native panel state synchronized when settings closes via Escape or backdrop click.

### P2 — accessibility and maintainability
- Add focus management, Escape handling, and correct ARIA relationships for the custom panel.
- Reduce the broad `!important` CSS overrides where scoped selectors can work.
- Split the large renderer file into clearly separated internal sections or helper modules if the injection mechanism permits it.
- Preserve the existing visual rules:
  - Import Plugin stays at the top.
  - Do not add extra dividers.
  - Built-in and imported plugin cards keep consistent Fluxer-style controls.

---

## 6. Suggested execution order

1. **Safety foundation**
   - Shared safe HTML helper.
   - Async plugin `stop()` support for hot reload.
   - Smoke harness scaffolding.

2. **Message Logger P0**
   - Sanitizer, single render path, gateway fallback, persistence flush.
   - Then observer/indexing performance work.

3. **Settings UI P0**
   - React unmount leak.
   - Import validation and failure reporting.
   - Icon sanitization and remove confirmation.

4. **Debug Tools P0**
   - Gateway hook replacement.
   - Incremental logging.

5. **Invisible Typing**
   - Host/filter correction and listener isolation.

6. **UX and Phase 3 migration**
   - Toasts, commands, DataStore, managed styles, patch registries.
   - Import preview/export, debug filters, message history controls.

7. **Final validation**
   - Syntax checks.
   - VM smoke harnesses.
   - Live Fluxer checks for settings, message deletion/editing, persistence, hot reload, and network interception.

The first pass should focus on **Message Logger safety**, **Settings UI leaks/import failures**, and **Debug Tools’ global JSON.parse patch**, since those have the highest correctness, security, and performance impact.

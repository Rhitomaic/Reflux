# Writing Plugins for Reflux

Reflux plugins have two sides: a **main-process side** (Node.js) and an optional **renderer side** (browser/web context). You only need what your plugin actually uses.

---

## Quick start

There are two ways to write a Reflux plugin depending on what you want to do:

- **Contributing to Reflux** — clone the repo and add your plugin under `src/plugins/<your-plugin-name>/`. It will be discovered automatically on the next Fluxer launch.
- **Personal use / sharing** — write a standalone `.js` file and import it via **Reflux Settings → Plugins → Import Plugin**. You don't need to clone the repo at all. See [Importable plugins](#importable-plugins-js-files) below.

The rest of this section covers the built-in plugin format. For the importable format, skip to [Importable plugins](#importable-plugins-js-files).

---

Create a folder under `src/plugins/<your-plugin-name>/` and add `index.js`:

```js
'use strict';

const {definePlugin, OptionType} = require('../../core/pluginApi');

module.exports = definePlugin({
  name:        'myPlugin',       // unique ID — used as the settings key
  displayName: 'My Plugin',      // shown in the Reflux settings UI
  description: 'One-line description shown in the plugin list.',
  rendererSrc: null,             // path to renderer script, or null
  settings: {
    enabledThing: {
      label: 'Enable thing',
      description: 'Turns the thing on.',
      type: OptionType.BOOLEAN,
      default: true,
    },
  },
  start() {},
  stop()  {},
});
```

That's it. Reflux discovers and loads it automatically on the next Fluxer launch.

`definePlugin()` is optional — plain objects are normalized too — but it gives you
`OptionType`, consistent metadata defaults, and a scoped `plugin.settingsStore`.

---

## Plugin fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Unique ID. Used as the settings key — don't change it after release. |
| `displayName` | `string` | | Human-readable name shown in the UI. Defaults to `name`. |
| `description` | `string` | | Short description shown in the plugin card. |
| `rendererSrc` | `string \| null` | | Absolute path to a renderer-side script injected into the Fluxer web context. |
| `settings` | `object \| array` | | Optional settings schema. Object form is preferred; legacy arrays are normalized. See [Plugin settings](#plugin-settings). |
| `settingsStore` | `object` | | Scoped settings store attached by Reflux before `start()`. Read/write and subscribe to settings here. |
| `authors` | `array` | | Optional author metadata. |
| `tags` | `string[]` | | Optional categories shown in the plugin UI. |
| `dependencies` | `string[]` | | Names of plugins that must be enabled first. |
| `enabledByDefault` | `boolean` | | Defaults to `true` for backwards compatibility. |
| `required` / `hidden` | `boolean` | | Mark core or hidden plugins. |
| `requiresRestart` | `boolean` | | Hint that toggling the plugin needs a Fluxer restart. |
| `start()` | `function` | ✅ | Called when the plugin is enabled. |
| `stop()` | `function` | ✅ | Called when the plugin is disabled or Reflux unloads. |

### Plugin settings

`settings` can be an object keyed by setting name (preferred) or the legacy
array form. Keys are saved at `plugins.<plugin-name>.<setting-key>`.

```js
const {definePlugin, OptionType} = require('../../core/pluginApi');

module.exports = definePlugin({
  name: 'myPlugin',
  displayName: 'My Plugin',
  description: 'Does stuff.',
  settings: {
    showBadge: {
      label: 'Show badge',
      description: 'Display a small badge next to message authors.',
      type: OptionType.BOOLEAN,
      default: true,
    },
  },
});
```

The settings schema is normalized by `definePlugin()`. Supported option types
in the core API are `OptionType.STRING`, `NUMBER`, `BOOLEAN`, `SELECT`,
`SLIDER`, `COMPONENT`, and `CUSTOM`.

```js
settings: {
  displayName: {
    type: OptionType.STRING,
    description: 'Text shown next to your messages.',
    placeholder: 'Anonymous',
    default: '',
  },
  messageLimit: {
    type: OptionType.NUMBER,
    description: 'How many messages to keep per channel.',
    min: 10,
    max: 1000,
    step: 10,
    default: 250,
  },
  mode: {
    type: OptionType.SELECT,
    description: 'How messages are displayed.',
    options: [
      {label: 'Compact', value: 'compact'},
      {label: 'Detailed', value: 'detailed', default: true},
    ],
  },
  opacity: {
    type: OptionType.SLIDER,
    description: 'Overlay opacity.',
    markers: [0, 25, 50, 75, 100],
    default: 75,
  },
  customHeader: {
    type: OptionType.COMPONENT,
    description: 'A custom control rendered by the plugin.',
    component({value, setValue, disabled}) {
      // Renderer-side only: return a DOM node or React element.
      const button = document.createElement('button');
      button.textContent = value ? 'On' : 'Off';
      button.disabled = disabled;
      button.onclick = () => setValue(!value);
      return button;
    },
  },
}
```

| Field | Applies to | Description |
|---|---|---|
| `label` / `displayName` | all | Row label. Defaults to a humanized key. |
| `description` | all | Helper text below the label. |
| `default` | all | Initial value. Selects default to their `default: true` option. |
| `options` | select | `string[]` or `{label, value, default?}[]`. |
| `markers` | slider | Allowed marker values; also determines the range. |
| `stickToMarkers` | slider | Snap saved values to the nearest marker. |
| `multiline` | string | Render a textarea instead of a single-line input. |
| `placeholder` | string | Input placeholder. |
| `min` / `max` / `step` | number | Native number input constraints. |
| `hidden` | all | Boolean or function; hides the row. |
| `disabled` | all | Boolean or function; disables the control. |
| `isValid(value)` | all | Return `true`, `false`, or a custom error string. |
| `onChange(value)` | all | Called after a value changes. |
| `component` / `render` | component/custom | Renderer-side custom control factory. |
| `restartNeeded` | all | Show that a Fluxer restart is required after changing it. |

`hidden`, `disabled`, and `isValid` functions receive the current settings
object as `this`:

```js
{
  type: OptionType.BOOLEAN,
  description: 'Only applies in detailed mode.',
  hidden() { return this.mode !== 'detailed'; },
  default: true,
}
```

`definePlugin()` attaches a main-process settings store before `start()`:

```js
module.exports = definePlugin({
  name: 'myPlugin',
  settings: {
    threshold: {type: OptionType.NUMBER, default: 10, description: '…'},
  },
  start() {
    const threshold = this.settingsStore.get('threshold');
    this.settingsStore.set('threshold', 20);

    // React to changes made by the settings UI.
    this.settingsStore.subscribe((key, value) => {
      console.log('setting changed:', key, value);
    });

    // Dot access is also proxied:
    console.log(this.settingsStore.store.threshold);
  },
  stop() {},
});
```

Renderer-side plugins can use the same shape through `window.__reflux`:

```js
const plugin = window.__reflux.definePlugin({
  name: 'myRendererPlugin',
  settings: {
    enabledThing: {
      type: window.__reflux.OptionType.BOOLEAN,
      description: '…',
      default: true,
    },
  },
});

await plugin.settingsStore.ready;
console.log(plugin.settingsStore.store.enabledThing);
```

Renderer plugins can also register settings without `definePlugin()`:

```js
const store = window.__reflux.settings.createStore('myRendererPlugin', {
  enabledThing: {
    type: window.__reflux.OptionType.BOOLEAN,
    description: '…',
    default: true,
  },
});
```

`settingsStore.plain` is a plain object, `settingsStore.store` is a reactive
proxy, `settingsStore.subscribe(listener)` returns an unsubscribe function, and
`settingsStore.use(paths)` is available once the React runtime is loaded.
Setting changes emit both `window.__reflux.events.on('setting-changed', ...)`
and the DOM event `reflux:setting-changed`.

> **Renderer-side functions:** settings functions such as `onChange`,
> `hidden`, `disabled`, `component`, and `render` must be declared in the
> renderer-side schema. Main-process schemas are serialized over IPC, so only
> their plain data (labels, types, defaults, options) reaches the settings UI.

---

## Main-process side

`start()` and `stop()` run in **Electron's main process** (Node.js). You have access to the full Node.js API and Electron modules.

```js
// src/plugins/myPlugin/index.js
'use strict';

const { app } = require('electron');

let _interval = null;

module.exports = {
  name:        'myPlugin',
  displayName: 'My Plugin',
  description: 'Logs a message every 10 seconds.',
  rendererSrc: null,

  start() {
    _interval = setInterval(() => {
      console.log('[myPlugin] Still running in main process');
    }, 10_000);
  },

  stop() {
    clearInterval(_interval);
    _interval = null;
  },
};
```

---

## Renderer side

If your plugin needs to interact with the Fluxer web UI, set `rendererSrc` to the path of a JavaScript file. Reflux injects it into the web context via `executeJavaScript` after the page loads.

```js
// src/plugins/myPlugin/index.js
'use strict';
const path = require('node:path');

module.exports = {
  name:        'myPlugin',
  displayName: 'My Plugin',
  description: 'Adds a banner to the Fluxer UI.',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),
  start() {},
  stop()  {},
};
```

```js
// src/plugins/myPlugin/renderer-side.js
(function myPlugin() {
  if (window.__myPlugin_loaded) return;
  window.__myPlugin_loaded = true;

  const banner = document.createElement('div');
  banner.id = 'my-plugin-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:4px;background:#5865f2;color:#fff;text-align:center;z-index:9999;font-size:13px;';
  banner.textContent = 'My Plugin is active!';
  document.body.appendChild(banner);

  // Register with Reflux so stop() can clean up
  window.__reflux?.pluginManager?.register?.({
    name: 'myPlugin',
    start() {},
    stop() {
      document.getElementById('my-plugin-banner')?.remove();
      window.__myPlugin_loaded = false;
    },
  });
})();
```

> **Guard against double-injection** — always check a flag like `window.__myPlugin_loaded` at the top of your renderer script. Fluxer may reload pages without a full restart.

## Patching React components

Renderer plugins can wrap a function component by its `displayName`. The
callback runs after the original component renders and receives the rendered
element, props, and original component. Return a replacement element to change
the output, or return `undefined` to leave it unchanged.

```js
(function myComponentPatch() {
  const unpatch = window.__reflux.patcher.patchReactComponent(
    'MessageContent',
    (element, props) => {
      if (!element || !props?.message) return;

      // Return a React element created with Fluxer's React runtime here.
      // Returning undefined keeps the original component output.
      console.log('Message:', props.message.id);
    },
  );

  window.__reflux.pluginManager.register({
    name: 'myComponentPatch',
    start() {},
    stop() {
      unpatch();
    },
  });
})();
```

`patchReactComponent()` handles components that are already loaded as well as
components loaded later. It currently targets function components; class,
`memo`, and `forwardRef` wrappers need separate handling because they do not
all have the same callable shape.

## Finding modules and patching methods

The patcher also provides small Vencord-style helpers for common webpack
module tasks. These helpers search the modules that Fluxer has already loaded:

```js
const { findByProps, findByName, findByCode } = window.__reflux.patcher;

// Find a module export with these properties.
const messageStore = findByProps('getMessage', 'getMessages');

// Find a function export by function name or React displayName.
const MessageContent = findByName('MessageContent');

// Find a loaded module whose webpack factory contains every snippet.
const targetModule = findByCode('MESSAGE_CREATE', 'getChannel');
```

`findByCode()` searches webpack factory source and is therefore more fragile
than property or name lookups. All three finders return `null` when there is no
match. They do not force lazy modules to load.

If your plugin starts before Reflux has captured webpack's module cache, wait
for it first:

```js
await window.__reflux.patcher.ready;
```

`patcher.ready` resolves once the cache is available, and
`patcher.onReady(callback)` provides a callback form.

For patching methods on a module or object, use `before`, `after`, or `instead`.
Each returns an unpatch function and should be cleaned up from the plugin's
`stop()` method:

```js
const { findByProps, after, instead } = window.__reflux.patcher;
const messageStore = findByProps('getMessage');

const unpatchRead = after(messageStore, 'getMessage', (args, result) => {
  console.log('Read message:', args[0]);
  return result;
});

const unpatchSend = instead(messageStore, 'sendMessage', (args, original) => {
  console.log('Sending:', args[0]);
  return original(...args);
});

window.__reflux.pluginManager.register({
  name: 'storePatch',
  start() {},
  stop() {
    unpatchRead();
    unpatchSend();
  },
});
```

`before` receives `(args)`, where changing the array changes the arguments
passed to the original method. `after` receives `(args, result)` and can
replace the result by returning a value. `instead` receives `(args, original)`;
`original` is bound to the target object. These method helpers patch the
specific object supplied to them; they do not search for methods themselves.

## Existing UI and navigation helpers

Use `window.__reflux.ui` when a plugin needs to work with Fluxer's existing
controls and routes without depending on hashed CSS classes or private React
internals:

```js
const {ui} = window.__reflux;

// Wait for a lazy-loaded control, then use the existing UI behavior.
const settingsButton = await ui.waitFor('[aria-label="Settings"]');
ui.click(settingsButton);

// Text and role lookups are useful when class names change between builds.
const pluginsTab = ui.findByRole('tab', 'Plugins');
ui.click(pluginsTab);

// Navigate the SPA and receive future route changes.
const stopRouting = ui.onNavigate((url) => {
  if (url.pathname.startsWith('/channels/')) console.log('Channel route:', url.pathname);
});
ui.navigate('/channels/123/general');
```

Available helpers are `find`, `findAll`, `findByText`, `findByRole`, `waitFor`,
`click`, `injectCSS`, `navigate`, and `onNavigate`. `waitFor()` resolves to
the first matching element or `null` after its timeout. `injectCSS()` and
`onNavigate()` return cleanup functions. `navigate()` uses the browser
history API and dispatches `popstate`; it is intended for Fluxer routes that
already respond to normal browser navigation.

---

## React runtime and Fluxer components

Reflux discovers Fluxer's React and ReactDOM modules lazily and exposes them on
`window.__reflux.react`. Wait for `ready` before using them:

```js
const {react, components} = window.__reflux;

const React = await react.ready;
if (!React) throw new Error('React was not found');

const {createElement: h} = React;

// Mount a React element into a DOM node.
const host = document.createElement('div');
document.body.appendChild(host);
react.render(h('div', null, 'Hello from Reflux'), host);

// Later
react.unmount(host);
```

`react` also exposes `React`/`ReactDOM` getters, `getReact()`, `getReactDOM()`,
`createElement()`, `render(element, container)`, `unmount(container)`, and
`unmountWithin(container)`. `render()` returns an unmount function.

### Component kit

Common Fluxer components are available lazily:

```js
const Button = components.Button ?? await components.waitFor('Button');
const Switch = await components.waitFor('Switch');

components.find('Tooltip');     // search already-loaded modules
components.waitFor('Modal');    // wait for lazy-loaded modules
```

The kit predefines getters for `Button`, `Switch`, `FormSwitch`, `FormInput`,
`FormCombobox`, `Clickable`, `Flex`, `Text`, `Menu`, `Tooltip`, `Modal`, and
`Spinner`. Availability depends on Fluxer's current build; always handle a
`null` result.

### ErrorBoundary

Wrap plugin-rendered components so a crash does not take down the whole
settings panel:

```js
const {react, components} = window.__reflux;
const React = await react.ready;

const node = React.createElement(
  components.ErrorBoundary,
  {
    name: 'My plugin panel',
    fallback: React.createElement('span', null, 'Something went wrong.'),
  },
  React.createElement(MyPanel),
);
```

`ErrorBoundary` accepts `name`, `fallback`, and `onError(error, info)` props.
It is also available as `react.ErrorBoundary`.

### React-backed settings

Once React is ready, plugin settings stores gain a `use()` hook:

```js
const plugin = window.__reflux.definePlugin({
  name: 'myPlugin',
  settings: {
    showBadge: {type: window.__reflux.OptionType.BOOLEAN, default: true},
  },
});

await window.__reflux.react.ready;
const React = window.__reflux.react.React;

function MyPanel() {
  const {showBadge} = plugin.settingsStore.use(['showBadge']);
  return React.createElement('span', null, showBadge ? 'On' : 'Off');
}
```

---

## Accessing settings from the renderer

The `refluxBridge` object is exposed by Reflux's preload script and is available in the renderer as `window.refluxBridge`.

```js
// Read a value (async)
const volume = await window.refluxBridge.getSetting('myPlugin.volume', 100);

// Write a value (async)
await window.refluxBridge.setSetting('myPlugin.volume', 80);
```

Settings are stored in `%APPDATA%\Reflux\settings.json` on Windows, or
`$XDG_CONFIG_HOME/Reflux/settings.json` (usually `~/.config/Reflux/settings.json`)
on Linux, under your plugin's key namespace.

---

## Plugin data storage

Use plugin data for state that is not configuration: caches, logs, saved
history, and other larger or frequently-written values. Each plugin gets its own
JSON file under `plugin-data/<plugin-name>.json` next to `settings.json`.

```js
// Read (returns defaultValue when the file is missing)
const state = await window.refluxBridge.readPluginData('myPlugin', {items: []});

// Write atomically
await window.refluxBridge.writePluginData('myPlugin', {items: [1, 2, 3]});

// Delete the plugin's file
await window.refluxBridge.clearPluginData('myPlugin');
```

Plugin names are sanitised before they are used as filenames. Data written here
is separate from settings and is never loaded automatically; your plugin decides
when to call `readPluginData()`.

---

## Context menus

`window.__reflux.contextMenu` is a small plugin-owned menu layer. Register a
provider that returns items for the elements it understands. Returning items
suppresses Fluxer's native context menu for that target; returning `null` lets
Fluxer handle it normally.

```js
const unregister = window.__reflux.contextMenu.register((target) => {
  const item = target.closest?.('[data-my-plugin-item]');
  if (!item) return null;

  return {
    title: 'My Plugin',
    items: [
      {
        label: 'Do something',
        icon: mySvgString, // optional inline SVG or text
        action: (event, targetElement) => {
          console.log('clicked', item);
        },
      },
      {type: 'separator'},
      {
        label: 'Delete',
        danger: true,
        action: () => item.remove(),
      },
    ],
  };
});

// Call from your plugin's stop()
unregister();
```

Menu items support `label`, `action`, `icon`, `danger`, `disabled`, `hint`, and
`type: 'separator'`. Providers are evaluated in registration order and results
are merged, so multiple plugins can contribute items for the same target.
`contextMenu.open(items, {x, y, target, title})` can also open a menu manually,
and `contextMenu.close()` / `contextMenu.isOpen()` are available.

---

## Intercepting the gateway WebSocket

Fluxer decompresses its zstd-stream WebSocket frames and calls `JSON.parse()` on the result. Hook `JSON.parse` to intercept decoded gateway payloads without dealing with compression.

```js
(function myPlugin() {
  const _orig = JSON.parse;

  JSON.parse = function(text, ...rest) {
    const result = _orig.call(this, text, ...rest);
    try {
      if (result?.op === 0 && result?.t) onGatewayEvent(result);
    } catch {}
    return result;
  };

  function onGatewayEvent({ t, d }) {
    if (t === 'MESSAGE_CREATE') {
      console.log('New message:', d.content);
    }
  }

  window.__reflux?.pluginManager?.register?.({
    name: 'myPlugin',
    start() {},
    stop() {
      JSON.parse = _orig; // restore on disable
    },
  });
})();
```

---

## Importable plugins (`.js` files)

Users can import external `.js` plugins directly from the Reflux settings UI without touching the file system. Add a metadata block at the top of your file:

```js
// ==RefluxPlugin==
// @name        My Plugin
// @author      3rr0r
// @description Does something cool
// @version     1.0.0
// @icon        🔌
// ==/RefluxPlugin==

(function myPlugin() {
  // Your plugin code here
  console.log('My importable plugin loaded!');
})();
```

All fields in the block are optional. If omitted, the filename is used as the plugin name.

### `@icon` formats

The `@icon` field accepts three formats:

**Emoji** — simplest option:
```js
// @icon        🔌
```

**Image URL** — any publicly accessible image:
```js
// @icon        https://i.imgur.com/abc123.png
```

**Inline `data:` URI** — embed the image directly in the file so it works offline:
```js
// @icon        data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB...
```

**Raw SVG** — paste an SVG string directly:
```js
// @icon        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ef4444" d="M12 2L2 7l10 5 10-5-10-5z"/></svg>
```

Reflux renders whatever string is in `@icon` as the `src` of an `<img>` tag, falling back to displaying it as text if the image fails to load — so emojis and SVGs both work.

The user imports it via **Reflux Settings → Plugins → Import Plugin**.

---

## Full example — Delete Logger

Logs a message to the console whenever someone deletes a message. This is an importable plugin — save it as `deleteLogger.js` and import it via **Reflux Settings → Plugins → Import Plugin**.

```js
// deleteLogger.js
// ==RefluxPlugin==
// @name        Delete Logger
// @author      3rr0r
// @description Logs deleted messages to the console.
// @version     1.0.0
// @icon        🗑️
// ==/RefluxPlugin==

(function deleteLogger() {
  if (window.__reflux_deleteLogger_loaded) return;
  window.__reflux_deleteLogger_loaded = true;

  const _origParse = JSON.parse;

  JSON.parse = function(text, ...rest) {
    const result = _origParse.call(this, text, ...rest);
    try {
      if (result?.op === 0 && result?.t === 'MESSAGE_DELETE') {
        console.log('[DeleteLogger] Message deleted:', result.d.content);
      }
    } catch {}
    return result;
  };

  window.__reflux?.pluginManager?.register?.({
    name: 'deleteLogger',
    start() {},
    stop() {
      JSON.parse = _origParse;
      window.__reflux_deleteLogger_loaded = false;
    },
  });
})();
```

---

## Tips

- **Settings namespace** — prefix all your settings keys with your plugin name to avoid collisions: `myPlugin.someKey`.
- **CSS class names** — Fluxer's class names include a build hash (e.g. `Message.module__message___XzQ1Zj`). Use `[class*="message__"]` attribute selectors to match them resilently.
- **Clean up everything** — your `stop()` must undo everything `start()` did: remove DOM nodes, disconnect observers, restore patched globals.
- **No eval** — use `new Function(src)()` if you need to execute dynamic code, and be aware of the security implications.
- **Double-injection guard** — always check `window.__yourPlugin_loaded` at the top of renderer scripts.

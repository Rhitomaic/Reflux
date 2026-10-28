<p align="center">
  <img src=".github/assets/text_logo.png" alt="Reflux"/>
</p>

<p align="center">
  Reflux is a Vencord-style runtime injector for the Fluxer desktop app. Modified to at least work, still vibe coded btw I don't know if
  I'll have time to learn what this actually does.
</p>

<h3 align="center">
  <a href="docs/writing-plugins.md">📃 Documentation →</a>
</h3>

<h2 align="center">Main features</h2>

- In-place asar injection into Fluxer's main process (`dist/main/index.js`) — the archive is patched without repacking, so `app.asar.unpacked` stays intact
- CSP stripping so injected renderer scripts load without restriction
- Preload bridge registered with `session.setPreloads()` — Fluxer's own preload file is left untouched
- Plugin lifecycle (`start`, `stop`, enable/disable with persistent state)
- `contextBridge` IPC bridge exposing settings, plugin management, and plugin-owned data to the renderer
- Gateway WebSocket interception for event hooks
- Injected **Reflux** section inside Fluxer's native settings panel, including per-plugin settings
- Import custom `.js` plugins at runtime with `==RefluxPlugin==` metadata blocks
- Reusable renderer context-menu API for plugin-provided menu items
- Settings persisted to `%APPDATA%\Reflux\settings.json` on Windows or `~/.config/Reflux/settings.json` on Linux; plugin data lives under `plugin-data/`
- Recognizes both Fluxer's packaged renderer (`fluxer-app://app/`) and the browser build (`https://web.fluxer.app`)

<h2 align="center">Bundled plugins</h2>

| Plugin | Description |
|---|---|
| **Settings UI** | Adds a "Reflux" sidebar section to Fluxer settings with plugin toggles, per-plugin settings, and import |
| **Message Logger** | Re-displays deleted messages inline, highlights edited originals, and optionally persists history across restarts |
| **Gateway Debug Tools** | Captures redacted gateway event summaries in a copyable in-app log |
| **Invisible Typing** | Prevents Fluxer from sending typing indicators to other users |

<h2 align="center">Install</h2>

Install dependencies inside `installer/`:

```bash
cd installer
npm install
```

Run the installer CLI:

```bash
node cli/index.js
```

Or, from the repository root:

```bash
node installer/cli/index.js
```

For convenience, the root package exposes the same flow as npm scripts:

```bash
npm run cli          # install / repair the current Fluxer instance
npm run update-dev   # same as above, for local development
npm run unpatch      # restore Fluxer's original app.asar
```

Restart Fluxer after running an install/update command.

Reflux searches the usual Fluxer locations automatically:

- **Windows**: `%LOCALAPPDATA%\fluxer_app`, `%LOCALAPPDATA%\Fluxer`, and Canary equivalents
- **Linux**: `~/.local/share/Fluxer`, `~/.local/share/fluxer`, `~/.local/share/fluxer_app`, `~/.config/Fluxer`, `~/.config/fluxer`, `/opt/fluxer-bin/resources`, and common `/usr/lib` / `/usr/share` locations

If Fluxer lives somewhere else, provide the exact `app.asar` path with `FLUXER_ASAR`:

```bash
FLUXER_ASAR=/opt/fluxer-bin/resources/app.asar node installer/cli/index.js
```

If Fluxer is installed system-wide (for example under `/opt`), the installer needs write access. Either run it with `sudo`, or use the GUI installer, which can request elevation through PolicyKit:

```bash
sudo FLUXER_ASAR=/opt/fluxer-bin/resources/app.asar node installer/cli/index.js
```

On Windows, the equivalent is:

```powershell
$env:FLUXER_ASAR = "C:\Users\<USERNAME>\AppData\Local\fluxer_app\app-0.0.8\resources\app.asar"
node installer\cli\index.js
```

### Building Linux artifacts

The build detects the current operating system automatically:

```bash
node installer/build.js
```

On Linux this produces:

- `installer/dist/reflux-v<version>-linux-x64-setup.AppImage` — GUI installer
- `installer/dist/reflux-v<version>-linux-x64-cli` — executable launcher using the system `node`

The Linux CLI intentionally does not bundle or compile Node.js. Install Node.js
from Arch's repositories first if needed:

```bash
sudo pacman -S nodejs npm
```

On Windows, the same build command produces a portable GUI `.exe` and a
standalone CLI `.exe`.

<h2 align="center">Verify the install</h2>

Restart Fluxer after installing. The main-process log should contain:

```text
[Reflux:Main] Bootstrap loaded.
[Reflux:Main] Ready. Settings: ...
[Reflux:Main] Active plugins: debugTools, invisibleTyping, messageLogger, settingsUI
```

Open Fluxer's user settings and look for the **Reflux → Plugins** section. In
DevTools, both globals should be available:

```js
window.__reflux            // patcher, UI helpers, renderer plugin manager
window.refluxBridge        // settings and plugin IPC bridge
```

This repository has been tested against Fluxer `2026.1018.223338` on Linux x64.

<h2 align="center">Uninstall</h2>

```bash
node installer/cli/unpatch.js
```

Use the same `FLUXER_ASAR` override (and `sudo`, if needed) as the installer.
This restores `app.asar` from `app.asar.bak` and removes any legacy
preload-injection lines left by older Reflux versions.

<h2 align="center">Writing a plugin</h2>

Create `src/plugins/<name>/index.js` exporting:

```js
module.exports = {
  name:        'myPlugin',       // unique ID, used as settings key
  displayName: 'My Plugin',      // shown in the UI
  description: 'Does stuff.',
  rendererSrc: require('path').join(__dirname, 'renderer-side.js'), // optional
  settings: [                    // optional rows in Reflux → Plugins
    {key: 'enabledThing', label: 'Enable thing', type: 'boolean', default: true},
  ],
  start() { /* main-process setup */ },
  stop()  { /* cleanup */ },
};
```

The optional `rendererSrc` file is injected into Fluxer's web context via
`executeJavaScript` after the core bootstrap runs. Use `window.__reflux` and
`window.refluxBridge` inside it. See [Writing Plugins](docs/writing-plugins.md)
for the plugin settings, plugin data, and context-menu APIs.

Right-clicking a deleted message rendered by **Message Logger** opens its
context menu; use **Clear Message History** to remove all logged history or
**Clear This Channel** to remove only the current channel's entries.

<h3 align="center">Importable plugins (`.js` files)</h3>

Drop a `.js` file into the Plugins → Import panel in Fluxer settings. Optionally include a metadata block at the top:

```js
// ==RefluxPlugin==
// @name        My Plugin
// @author      3rr0r
// @description Does cool stuff
// @version     1.0.0
// @preview     https://i.imgur.com/example.png
// ==/RefluxPlugin==
```

<h2 align="center">Repo layout</h2>

```
installer/          Injector (standalone package with its own dependencies)
  cli/
    index.js        Locate and patch Fluxer's app.asar
    unpatch.js      Restore app.asar from the backup
  gui/              GUI installer (Electron + PolicyKit/UAC elevation)
  build.js          Build GUI and CLI artifacts for the current platform
src/
  main-inject.mjs   ESM module injected into Fluxer's main process
  preload.js        Sandboxed preload — exposes refluxBridge via contextBridge
  renderer.js       Core bootstrap injected into the web renderer
  core/
    settings.js     Read/write settings.json, IPC handlers
    pluginData.js   Read/write per-plugin JSON data, IPC handlers
    pluginManager.js  Discover, start/stop plugins, IPC handlers
    patcher.js      Thin wrapper around window.__reflux.patcher
    ui.js           Renderer-side UI helper passthrough
  plugins/
    settingsUI/     Settings panel injected into Fluxer's native settings UI
    messageLogger/  Deleted/edited message history with optional persistence
    debugTools/     Redacted gateway event inspector with copyable logs
    invisibleTyping/ Cancels outgoing typing-indicator requests
```

<h2 align="center">What injection modifies</h2>

- `resources/app.asar` — an `await import("file:///.../src/main-inject.mjs");` line is prepended to `dist/main/index.js`
  - backup: `app.asar.bak`
  - the asar header is updated in place; the rest of the archive, including `app.asar.unpacked`, is not repacked
- `resources/app.asar.unpacked/dist/preload/index.cjs` — **not modified**. Reflux registers `src/preload.js` at runtime with `session.setPreloads()`
- Older Reflux versions that prepended a `require(...)` line to the unpacked preload are cleaned up by the installer and uninstaller

Settings are stored at `%APPDATA%\Reflux\settings.json` on Windows and
`$XDG_CONFIG_HOME/Reflux/settings.json` (usually `~/.config/Reflux/settings.json`)
on Linux. Plugin-owned data is stored alongside it under `plugin-data/`. The old
Linux path, `~/AppData/Roaming/Reflux/settings.json`, is migrated automatically
the first time the new version loads.

<h2 align="center">Default install path</h2>

- Windows: `%LOCALAPPDATA%\fluxer_app\app-<version>\resources\`
- Canary: `%LOCALAPPDATA%\Fluxer Canary\app-<version>\resources\`
- Linux (local/unpacked): `~/.local/share/Fluxer/` or `~/.local/share/fluxer/`
- Linux alternatives: `~/.local/share/fluxer_app/`, `~/.config/Fluxer/`, `~/.config/fluxer/`
- Linux distro package: `/opt/fluxer-bin/resources/` (also `/usr/lib/fluxer/resources/` and similar)
- Custom installation: set `FLUXER_ASAR` to the full path of `resources/app.asar`

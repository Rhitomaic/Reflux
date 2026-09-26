<p align="center">
  <img src=".github/assets/text_logo.png" alt="Reflux"/>
</p>

<p align="center">
  Reflux is a Vencord-style runtime injector for the Fluxer desktop app.
  Original dev vibe coded this, still trying to navigate this mess to make it work with newer Fluxcord versions
</p>

<h3 align="center">
  <a href="docs/writing-plugins.md">📃 Documentation →</a>
</h3>

<h2 align="center">Main features</h2>

- asar injection into Fluxer's main process (ESM-compatible, no repacking for preload)
- CSP stripping so renderer scripts load without restriction
- Plugin lifecycle (`start`, `stop`, enable/disable with persistent state)
- `contextBridge` IPC bridge exposing settings and plugin management to the renderer
- Gateway WebSocket interception (`wss://gateway.fluxer.app`) for event hooks
- Injected **Reflux** section inside Fluxer's native settings panel
- Import custom `.js` plugins at runtime with `==RefluxPlugin==` metadata blocks
- Settings persisted to `%APPDATA%\Reflux\settings.json` on Windows or `~/AppData/Roaming/Reflux/settings.json` on Linux

<h2 align="center">Bundled plugins</h2>

| Plugin | Description |
|---|---|
| **Settings UI** | Adds a "Reflux" sidebar section to Fluxer settings with plugin toggles and import |
| **Message Logger** | Intercepts `MESSAGE_DELETE` gateway events and re-displays deleted messages inline |

<h2 align="center">Install</h2>

Install dependencies from the repository root:

```bash
cd installer
npm install
```

Run the installer CLI:

```bash
node cli/index.js
```

On Windows, Reflux searches the Fluxer installation under `%LOCALAPPDATA%`.
On Linux, it searches common locations under `~/.local/share` and `~/.config`.
You can always provide the exact Fluxer archive path with `FLUXER_ASAR`:

Override the target manually:

```bash
FLUXER_ASAR=/path/to/Fluxer/resources/app.asar node installer/cli/index.js
```

For Windows, the equivalent is:

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

<h2 align="center">Uninstall</h2>

```bash
node installer/cli/unpatch.js
```

Restores `app.asar` from `app.asar.bak` and removes all injected lines from the unpacked preload.

<h2 align="center">Writing a plugin</h2>

Create `src/plugins/<name>/index.js` exporting:

```js
module.exports = {
  name:        'myPlugin',       // unique ID, used as settings key
  displayName: 'My Plugin',      // shown in the UI
  description: 'Does stuff.',
  rendererSrc: require('path').join(__dirname, 'renderer-side.js'), // optional
  start() { /* main-process setup */ },
  stop()  { /* cleanup */ },
};
```

The optional `rendererSrc` file is injected into Fluxer's web context via `executeJavaScript` after the core bootstrap runs. Use `window.__reflux` and `window.refluxBridge` inside it.

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
installer/          Injector script (standalone, own package.json + deps)
  index.js          Inject Reflux into Fluxer
  unpatch.js        Remove Reflux from Fluxer
src/
  main-inject.mjs   ESM module injected into Fluxer's main process
  preload.js        Sandboxed preload — exposes refluxBridge via contextBridge
  renderer.js       Core bootstrap injected into the web renderer
  core/
    settings.js     Read/write %APPDATA%\Reflux\settings.json, IPC handlers
    pluginManager.js  Discover, start/stop plugins, IPC handlers
    patcher.js      Thin wrapper around window.__reflux.patcher
  plugins/
    settingsUI/     Settings panel injected into Fluxer's native settings UI
    messageLogger/  Deleted message logger via gateway WebSocket interception
```

<h2 align="center">What injection modifies</h2>

- `resources/app.asar` — `await import(...)` line prepended to `src-electron/dist/main/index.js`
  - backup: `app.asar.bak`
- `resources/app.asar.unpacked/src-electron/dist/preload/index.js` — no longer patched directly; Reflux preload is registered via `session.setPreloads()` instead

Settings are stored at `%APPDATA%\Reflux\settings.json` on Windows. On Linux,
the current settings implementation uses `~/AppData/Roaming/Reflux/settings.json`.

<h2 align="center">Default install path</h2>

- Windows: `%LOCALAPPDATA%\fluxer_app\app-<version>\resources\`
- Canary: `%LOCALAPPDATA%\Fluxer Canary\app-<version>\resources\`
- Linux: `~/.local/share/Fluxer/` or `~/.local/share/fluxer/`
- Linux alternatives: `~/.local/share/fluxer_app/`, `~/.config/Fluxer/`, `~/.config/fluxer/`
- Custom installation: set `FLUXER_ASAR` to the full path of `resources/app.asar`


/**
 * installer/cli/index.js
 *
 * Locates Fluxer's installed resources and injects Reflux by:
 *
 *   1. Backing up the original app.asar as app.asar.bak (idempotent).
 *   2. Prepending an `await import(...)` line to the main-process entry inside
 *      app.asar so Reflux's main-side code (CSP stripping, renderer/plugin
 *      injection) runs before any Fluxer windows are created.
 *   3. Cleaning up the old unpacked-preload injection from older Reflux
 *      versions.  The current preload is registered at runtime via
 *      session.setPreloads(); Fluxer's preload file is not modified.
 *
 * The asar is patched in place: only the header and the main entry are
 * rewritten, so `app.asar.unpacked` and all other archive offsets stay intact.
 *
 * On Windows, Fluxer uses the Squirrel installer, so the install path is:
 *   %LOCALAPPDATA%\Fluxer\app-<version>\resources\
 *   %LOCALAPPDATA%\Fluxer Canary\app-<version>\resources\   (canary builds)
 * On Linux, use FLUXER_ASAR when Fluxer is installed in a custom location;
 * common native package and unpacked-app locations are also searched.
 *
 * Run with: node installer/cli/index.js
 * Override asar path: FLUXER_ASAR=/opt/fluxer-bin/resources/app.asar node installer/cli/index.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const asar = require('@electron/asar');
const {pathToFileURL} = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// When compiled with pkg, __dirname is a virtual snapshot path.
// Use the exe's actual directory and navigate up to the repo root instead.
const _BASE = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const REFLUX_ROOT   = path.resolve(_BASE, '..');
const REFLUX_MAIN   = path.join(REFLUX_ROOT, 'src', 'main-inject.mjs');
const REFLUX_PRELOAD = path.join(REFLUX_ROOT, 'src', 'preload.js');

/**
 * Squirrel installs Fluxer into versioned subdirectories under %LOCALAPPDATA%.
 * We search inside each product name's folder for the latest app-<version>.
 */
const home = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

const PRODUCT_DIRS = process.platform === 'win32'
  ? [
    path.join(localAppData, 'fluxer_app'),
    path.join(localAppData, 'fluxer_app_canary'),
    path.join(localAppData, 'Fluxer'),
    path.join(localAppData, 'Fluxer Canary'),
    path.join('C:\\', 'Program Files', 'Fluxer', 'resources'),
    path.join('C:\\', 'Program Files (x86)', 'Fluxer', 'resources'),
  ]
  : [
    path.join(dataHome, 'Fluxer'),
    path.join(dataHome, 'fluxer'),
    path.join(dataHome, 'fluxer_app'),
    path.join(home, '.config', 'Fluxer'),
    path.join(home, '.config', 'fluxer'),
    '/opt/Fluxer/resources',
    '/opt/fluxer/resources',
    '/opt/fluxer-bin/resources',
    '/opt/fluxer_app/resources',
    '/usr/lib/Fluxer/resources',
    '/usr/lib/fluxer/resources',
    '/usr/share/Fluxer/resources',
    '/usr/share/fluxer/resources',
  ];

/** Path inside the asar where the main-process entry lives (ESM). */
const ASAR_MAIN_ENTRY = 'dist/main/index.js';

/** Old preload path used by previous Reflux versions (cleanup only). */
const ASAR_PRELOAD_ENTRY = 'dist/preload/index.cjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Within a Squirrel product directory, find the resources folder of the latest
 * installed version (app-<semver>/resources).
 * @param {string} productDir  e.g. %LOCALAPPDATA%\Fluxer
 * @returns {string|null}
 */
function findLatestResourcesDir(productDir) {
  if (!fs.existsSync(productDir)) return null;

  const appDirs = fs.readdirSync(productDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('app-'))
    .map(e => e.name)
    .sort()          // lexicographic sort is fine for semver-like "app-1.2.3"
    .reverse();      // newest first

  for (const dir of appDirs) {
    const resources = path.join(productDir, dir, 'resources');
    const asarPath  = path.join(resources, 'app.asar');
    if (fs.existsSync(asarPath)) return resources;
  }
  return null;
}

/**
 * Locate Fluxer's resources directory.
 * @returns {string}
 */
function findResourcesDir() {
  if (process.env.FLUXER_ASAR) {
    return path.dirname(process.env.FLUXER_ASAR);
  }

  for (const dir of PRODUCT_DIRS) {
    // Direct resources dir (Program Files style).
    if (fs.existsSync(path.join(dir, 'app.asar'))) return dir;
    // Squirrel style — find latest versioned subdir.
    const resources = findLatestResourcesDir(dir);
    if (resources) return resources;
  }

  throw new Error(
    'Could not locate Fluxer\'s resources directory.\n' +
    'Searched:\n' + PRODUCT_DIRS.map(d => '  ' + d).join('\n') + '\n' +
    'Set FLUXER_ASAR=/full/path/to/app.asar and retry.'
  );
}

/**
 * Serialize a uint32 in Electron's pickle format (8-byte outer length + value).
 * @param {number} value
 * @returns {Buffer}
 */
function pickleUInt32(value) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(value, 4);
  return buf;
}

/**
 * Serialize a string in Electron's pickle format.
 * @param {string} str
 * @returns {Buffer}
 */
function pickleString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const aligned = (strBuf.length + 3) & ~3;
  const buf = Buffer.allocUnsafe(4 + 4 + aligned);
  buf.writeUInt32LE(4 + aligned, 0);
  buf.writeUInt32LE(strBuf.length, 4);
  strBuf.copy(buf, 8);
  if (aligned > strBuf.length) buf.fill(0, 8 + strBuf.length);
  return buf;
}

/**
 * Walk the asar header tree to an entry.
 * @param {Record<string, any>} files
 * @param {string} entryPath
 * @returns {Record<string, any>|null}
 */
function getAsarEntry(files, entryPath) {
  const parts = entryPath.split('/');
  let node = files;
  for (let i = 0; i < parts.length; i++) {
    const child = node[parts[i]];
    if (!child) return null;
    if (i === parts.length - 1) return child;
    if (!child.files) return null;
    node = child.files;
  }
  return null;
}

/**
 * Find Fluxer's main-process entry inside app.asar.
 * Prefers package.json "main", then known Fluxer layouts.
 * @param {string} asarPath
 * @returns {string}
 */
function findMainEntryInAsar(asarPath) {
  const {header} = asar.getRawHeader(asarPath);

  try {
    const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    if (pkg.main) {
      const candidate = pkg.main.replace(/^\.\//, '');
      if (getAsarEntry(header.files, candidate)) return candidate;
    }
  } catch {
    /* no package.json or unreadable */
  }

  const candidates = [ASAR_MAIN_ENTRY, 'app/dist/main/index.js', 'main/index.js', 'main.js', 'index.js'];
  for (const candidate of candidates) {
    if (getAsarEntry(header.files, candidate)) return candidate;
  }

  throw new Error(`Main entry not found in asar. Tried: ${candidates.join(', ')}`);
}

/**
 * Prepend `patchLine` to one file inside app.asar without repacking the whole
 * archive.  Only the header and the target entry are rewritten; every other
 * file keeps its original bytes and offset.
 *
 * @param {string} asarPath
 * @param {string} entryPath
 * @param {string} patchLine
 * @returns {boolean} true if patched, false if already patched
 */
function patchAsarEntry(asarPath, entryPath, patchLine) {
  const {header, headerSize} = asar.getRawHeader(asarPath);
  const dataStart = 8 + headerSize;

  const entry = getAsarEntry(header.files, entryPath);
  if (!entry || entry.files) throw new Error(`Entry '${entryPath}' not found in asar.`);

  const oldOffset = Number(entry.offset);
  const oldSize = entry.size;

  const rfd = fs.openSync(asarPath, 'r');
  const originalBuf = Buffer.alloc(oldSize);
  try {
    fs.readSync(rfd, originalBuf, 0, oldSize, dataStart + oldOffset);
  } finally {
    fs.closeSync(rfd);
  }

  const originalStr = originalBuf.toString('utf8');
  if (originalStr.startsWith(patchLine)) return false;

  const patchedBuf = Buffer.from(`${patchLine}\n${originalStr}`, 'utf8');
  const sizeDelta = patchedBuf.length - oldSize;

  entry.size = patchedBuf.length;
  delete entry.integrity;

  if (sizeDelta !== 0) {
    (function adjustOffsets(files) {
      for (const child of Object.values(files)) {
        if (child.files) adjustOffsets(child.files);
        else if (Number(child.offset) > oldOffset) {
          child.offset = String(Number(child.offset) + sizeDelta);
        }
      }
    })(header.files);
  }

  const newHeaderBuf = pickleString(JSON.stringify(header));
  const newSizeBuf = pickleUInt32(newHeaderBuf.length);

  const tmpPath = path.join(os.tmpdir(), `reflux-patch-${process.pid}-${Date.now()}.asar`);
  const wfd = fs.openSync(tmpPath, 'w');
  const rfd2 = fs.openSync(asarPath, 'r');
  try {
    fs.writeSync(wfd, newSizeBuf);
    fs.writeSync(wfd, newHeaderBuf);

    const CHUNK = 4 * 1024 * 1024;
    const asarTotalSize = fs.fstatSync(rfd2).size;
    const entryAbsStart = dataStart + oldOffset;

    for (let pos = dataStart; pos < entryAbsStart; ) {
      const len = Math.min(CHUNK, entryAbsStart - pos);
      const chunk = Buffer.allocUnsafe(len);
      fs.readSync(rfd2, chunk, 0, len, pos);
      fs.writeSync(wfd, chunk);
      pos += len;
    }

    fs.writeSync(wfd, patchedBuf);

    for (let pos = entryAbsStart + oldSize; pos < asarTotalSize; ) {
      const len = Math.min(CHUNK, asarTotalSize - pos);
      const chunk = Buffer.allocUnsafe(len);
      fs.readSync(rfd2, chunk, 0, len, pos);
      fs.writeSync(wfd, chunk);
      pos += len;
    }
  } finally {
    fs.closeSync(rfd2);
    fs.closeSync(wfd);
  }

  fs.copyFileSync(tmpPath, asarPath);
  fs.unlinkSync(tmpPath);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const resourcesDir = findResourcesDir();
  const asarPath     = path.join(resourcesDir, 'app.asar');
  const bakPath      = asarPath + '.bak';
  const unpackedDir  = asarPath + '.unpacked'; // Electron's standard name

  console.log(`[Reflux] Resources dir: ${resourcesDir}`);

  try {
    fs.accessSync(resourcesDir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `No write permission for ${resourcesDir}.\n` +
      'Run the installer with sudo (or use the GUI installer, which can request elevation).'
    );
  }

  // ── Step 1: Backup ──────────────────────────────────────────────────────
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(asarPath, bakPath);
    console.log(`[Reflux] Backup created: ${bakPath}`);
  } else {
    console.log(`[Reflux] Backup already present: ${bakPath}`);
  }

  // ── Step 2: Clean up any old preload injection (from a previous approach) ──
  // Sandboxed preloads cannot require() arbitrary files outside the asar.
  // Reflux's preload is now loaded via session.setPreloads() in main-inject.mjs,
  // so any previously injected require() line must be removed.
  const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
  if (fs.existsSync(unpackedPreload)) {
    const oldInjectLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
    let contents = fs.readFileSync(unpackedPreload, 'utf8');
    if (contents.startsWith(oldInjectLine)) {
      fs.writeFileSync(unpackedPreload, contents.slice(oldInjectLine.length), 'utf8');
      console.log('[Reflux] Removed old preload injection line.');
    }
  }

  // ── Step 3: Patch the main-process entry inside the asar ────────────────
  // We need to inject our main-side bootstrap so Reflux can:
  //  • Strip CSP headers (allowing renderer content-script injection)
  //  • Inject renderer.js into the web context via webContents events
  //
  // The main entry is ESM (type: "module"), so we use top-level await + dynamic import.
  // On Windows, dynamic import() requires a file:// URL — raw C:\... paths are rejected by the ESM loader.
  const mainInjectUrl  = pathToFileURL(REFLUX_MAIN).href;
  const mainInjectLine = `await import(${JSON.stringify(mainInjectUrl)});`;

  console.log('[Reflux] Patching main entry in place…');
  const mainEntry = findMainEntryInAsar(asarPath);
  const alreadyPatched = !patchAsarEntry(asarPath, mainEntry, mainInjectLine);

  if (alreadyPatched) {
    console.log('[Reflux] Main entry already patched — no changes made.');
  } else {
    console.log(`[Reflux] Main entry patched: ${mainEntry}`);
  }

  console.log('\n[Reflux] Installation complete! Restart Fluxer to activate Reflux.');
}

main().catch(err => {
  console.error('[Reflux] Installation failed:', err.message);
  process.exit(1);
});

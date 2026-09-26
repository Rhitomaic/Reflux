'use strict';

const {parentPort, workerData} = require('worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const {execSync} = require('node:child_process');
const asar = require('@electron/asar');
const {pathToFileURL} = require('node:url');

process.noAsar = true;

// ── Constants ─────────────────────────────────────────────────────────────────

const ASAR_MAIN_ENTRY = 'src-electron/dist/main/index.js';
const ASAR_PRELOAD_ENTRY = 'src-electron/dist/preload/index.js';
const GITHUB_REPO = 'its3rr0rswrld/Reflux';

const HOME = process.env.HOME || os.homedir();
const APPDATA = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'));

const REFLUX_APPDATA_SRC = path.join(APPDATA, 'Reflux', 'src');

// ── Inputs ────────────────────────────────────────────────────────────────────

const {op, asarPath, isPackaged, devSrc} = workerData;

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(type, message) {
    parentPort.postMessage({event: 'progress', type, message});
}

function complete(success, message) {
    parentPort.postMessage({event: 'complete', success, message});
}

// ── Permission & Elevated Execution Helpers ───────────────────────────────────

function requiresElevation(targetPath) {
    try {
        const checkPath = fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath);
        fs.accessSync(checkPath, fs.constants.W_OK);
        return false;
    } catch {
        return true;
    }
}

function execElevated(command) {
    if (process.platform === 'linux') {
        try {
            // pkexec triggers standard Linux desktop graphical authorization dialog (Polkit)
            execSync(`pkexec sh -c ${JSON.stringify(command)}`, {stdio: 'pipe'});
        } catch (err) {
            throw new Error(`Root permission denied (pkexec failed): ${err.message}`);
        }
    } else if (process.platform === 'win32') {
        const psCmd = `Start-Process cmd -ArgumentList '/c ${command.replace(/'/g, "''")}' -Verb RunAs -Wait`;
        execSync(`powershell -NonInteractive -Command "${psCmd}"`, {stdio: 'pipe'});
    } else {
        execSync(command, {stdio: 'pipe'});
    }
}

function safeCopyFile(src, dest) {
    if (requiresElevation(dest)) {
        send('step', 'Requesting root permissions to copy file…');
        execElevated(`cp -f "${src}" "${dest}"`);
    } else {
        fs.copyFileSync(src, dest);
    }
}

function safeUnlink(target) {
    if (!fs.existsSync(target)) return;
    if (requiresElevation(target)) {
        send('step', 'Requesting root permissions to delete file…');
        execElevated(`rm -f "${target}"`);
    } else {
        fs.unlinkSync(target);
    }
}

function safeRemoveDir(target) {
    if (!fs.existsSync(target)) return;
    if (requiresElevation(target)) {
        send('step', 'Requesting root permissions to delete directory…');
        execElevated(`rm -rf "${target}"`);
    } else {
        fs.rmSync(target, {recursive: true, force: true});
    }
}

function safeMove(src, dest) {
    if (requiresElevation(dest) || requiresElevation(src)) {
        send('step', 'Requesting root permissions to write application files…');
        execElevated(`mv -f "${src}" "${dest}"`);
    } else {
        try {
            fs.renameSync(src, dest);
        } catch (err) {
            if (err.code === 'EXDEV') { // Cross-device move fallback (/tmp -> system drive)
                fs.copyFileSync(src, dest);
                fs.unlinkSync(src);
            } else {
                throw err;
            }
        }
    }
}

// ── Zip extraction ────────────────────────────────────────────────────────────

function extractZip(zipPath, destDir) {
    if (process.platform === 'win32') {
        execSync(
            `powershell -NonInteractive -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force"`,
            {stdio: 'pipe'},
        );
    } else {
        try {
            execSync(`unzip -o "${zipPath}" -d "${destDir}"`, {stdio: 'pipe'});
        } catch {
            // Fallback for Linux distributions without unzip installed
            execSync(`python3 -m zipfile -e "${zipPath}" "${destDir}"`, {stdio: 'pipe'});
        }
    }
}

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        function get(u) {
            const mod = u.startsWith('https') ? https : http;
            mod.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    get(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    file.close();
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        }
        get(url);
    });
}

async function downloadSrc() {
    const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/reflux-src.zip`;
    const tmpZip = path.join(os.tmpdir(), `reflux-src-${Date.now()}.zip`);

    send('step', `Downloading Reflux runtime from GitHub…`);
    await download(url, tmpZip);

    const zipSize = fs.statSync(tmpZip).size;
    if (zipSize < 100) {
        fs.unlinkSync(tmpZip);
        throw new Error(`Downloaded file is too small (${zipSize} bytes) — GitHub release asset may be missing.`);
    }
    send('step', `Downloaded ${(zipSize / 1024).toFixed(1)} KB. Extracting…`);

    if (fs.existsSync(REFLUX_APPDATA_SRC)) safeRemoveDir(REFLUX_APPDATA_SRC);
    fs.mkdirSync(REFLUX_APPDATA_SRC, {recursive: true});

    extractZip(tmpZip, REFLUX_APPDATA_SRC);
    fs.unlinkSync(tmpZip);

    return REFLUX_APPDATA_SRC;
}

async function getRefluxSrc() {
    if (!isPackaged) {
        send('step', 'Using local Reflux source (dev mode)…');
        return devSrc;
    }
    return await downloadSrc();
}

// ── Asar pickle helpers ───────────────────────────────────────────────────────

function pickleUInt32(value) {
    const buf = Buffer.allocUnsafe(8);
    buf.writeUInt32LE(4, 0);
    buf.writeUInt32LE(value, 4);
    return buf;
}

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

// ── Asar header helpers ───────────────────────────────────────────────────────

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

function findMainEntryInAsar(asarPath) {
    const {header} = asar.readHeader(asarPath);

    try {
        const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
        if (pkg.main) {
            const candidate = pkg.main.replace(/^\.\//, '');
            if (getAsarEntry(header.files, candidate)) return candidate;
        }
    } catch {
        /* no package.json or unreadable */
    }

    const candidates = [ASAR_MAIN_ENTRY, 'dist/main/index.js', 'app/dist/main/index.js', 'main/index.js', 'main.js', 'index.js'];
    for (const c of candidates) {
        if (getAsarEntry(header.files, c)) return c;
    }

    throw new Error(`Main entry not found in asar. Tried: ${candidates.join(', ')}`);
}

// ── Streaming asar patch ──────────────────────────────────────────────────────

function patchAsarEntry(asarPath, entryPath, patchLine) {
    const {header, headerSize} = asar.readHeader(asarPath);
    const dataStart = 8 + headerSize;

    const entry = getAsarEntry(header.files, entryPath);
    if (!entry || entry.files) throw new Error(`Entry '${entryPath}' not found`);

    const oldOffset = Number(entry.offset);
    const oldSize = entry.size;

    const rfd = fs.openSync(asarPath, 'r');
    const originalBuf = Buffer.alloc(oldSize);
    fs.readSync(rfd, originalBuf, 0, oldSize, dataStart + oldOffset);
    fs.closeSync(rfd);

    const originalStr = originalBuf.toString('utf8');
    if (originalStr.startsWith(patchLine)) return false;

    const patchedBuf = Buffer.from(patchLine + '\n' + originalStr, 'utf8');
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

    // Build temporary asar in system temp dir to avoid permission issues during creation
    const tmpPath = path.join(os.tmpdir(), `reflux-patch-${Date.now()}.asar`);
    const wfd = fs.openSync(tmpPath, 'w');
    try {
        fs.writeSync(wfd, newSizeBuf);
        fs.writeSync(wfd, newHeaderBuf);

        const CHUNK = 4 * 1024 * 1024;
        const rfd2 = fs.openSync(asarPath, 'r');
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

        fs.closeSync(rfd2);
    } catch (err) {
        fs.closeSync(wfd);
        safeUnlink(tmpPath);
        throw err;
    }
    fs.closeSync(wfd);

    safeMove(tmpPath, asarPath);
    return true;
}

// ── Install / Repair ───────────────────────────────────────────────────────────

async function runInstall(asarPath) {
    const bakPath = asarPath + '.bak';
    const unpackedDir = asarPath + '.unpacked';
    const resourcesDir = path.dirname(asarPath);

    const activeSrc = await getRefluxSrc();
    const REFLUX_MAIN = path.join(activeSrc, 'main-inject.mjs');
    const REFLUX_PRELOAD = path.join(activeSrc, 'preload.js');

    send('step', 'Backing up app.asar…');
    if (!fs.existsSync(bakPath)) {
        safeCopyFile(asarPath, bakPath);
    } else {
        send('warn', 'Backup already exists — skipping.');
    }

    const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
    if (fs.existsSync(unpackedPreload)) {
        const oldLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
        try {
            const contents = fs.readFileSync(unpackedPreload, 'utf8');
            if (contents.startsWith(oldLine)) {
                const tmpFile = path.join(os.tmpdir(), `unpacked-preload-${Date.now()}`);
                fs.writeFileSync(tmpFile, contents.slice(oldLine.length), 'utf8');
                safeMove(tmpFile, unpackedPreload);
                send('warn', 'Removed legacy preload injection.');
            }
        } catch { /* skip */ }
    }

    const mainInjectLine = `await import(${JSON.stringify(pathToFileURL(REFLUX_MAIN).href)});`;

    send('step', 'Patching app.asar…');
    let patched;
    try {
        const mainEntry = findMainEntryInAsar(asarPath);
        patched = patchAsarEntry(asarPath, mainEntry, mainInjectLine);
    } catch (err) {
        send('warn', `Streaming patch failed (${err.message}), falling back to full extract…`);
        patched = await runInstallFull(asarPath, resourcesDir, mainInjectLine);
    }

    if (!patched) send('warn', 'Already patched — no changes made.');

    complete(true, 'Reflux installed successfully. Restart Fluxer to activate.');
}

async function runInstallFull(asarPath, resourcesDir, mainInjectLine) {
    const extractDir = path.join(os.tmpdir(), `reflux-extract-${Date.now()}`);
    const repackedAsar = path.join(os.tmpdir(), `reflux-repacked-${Date.now()}.asar`);

    if (fs.existsSync(extractDir)) safeRemoveDir(extractDir);

    send('step', 'Extracting asar…');
    asar.extractAll(asarPath, extractDir);

    send('step', 'Locating main entry…');
    const candidates = [ASAR_MAIN_ENTRY, 'dist/main/index.js', 'app/dist/main/index.js', 'main/index.js', 'main.js', 'index.js'];
    let mainEntryPath = null;
    for (const c of candidates) {
        const p = path.join(extractDir, ...c.split('/'));
        if (fs.existsSync(p)) {
            mainEntryPath = p;
            break;
        }
    }
    if (!mainEntryPath) {
        safeRemoveDir(extractDir);
        throw new Error(`Main entry not found. Tried: ${candidates.join(', ')}`);
    }

    const contents = fs.readFileSync(mainEntryPath, 'utf8');
    if (contents.startsWith(mainInjectLine)) {
        safeRemoveDir(extractDir);
        return false;
    }

    fs.writeFileSync(mainEntryPath, mainInjectLine + '\n' + contents, 'utf8');

    send('step', 'Repacking asar — this may take a moment…');
    await asar.createPackage(extractDir, repackedAsar);
    safeRemoveDir(extractDir);

    safeMove(repackedAsar, asarPath);
    return true;
}

// ── Update ────────────────────────────────────────────────────────────────────

async function runUpdate() {
    if (!isPackaged) {
        complete(true, 'Running in dev mode — source is already up to date.');
        return;
    }
    await downloadSrc();

    let newVersion = null;
    try {
        const preloadSrc = fs.readFileSync(path.join(REFLUX_APPDATA_SRC, 'preload.js'), 'utf8');
        const m = preloadSrc.match(/version:\s*'([^']+)'/);
        if (m) newVersion = m[1];
    } catch { /* non-fatal */ }

    const msg = newVersion
        ? `Updated to Reflux v${newVersion}. Restart Fluxer to apply.`
        : 'Reflux runtime updated. Restart Fluxer to apply.';
    complete(true, msg);
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

function runUninstall(asarPath) {
    const bakPath = asarPath + '.bak';
    const unpackedDir = asarPath + '.unpacked';
    const resourcesDir = path.dirname(asarPath);

    send('step', 'Restoring original asar…');
    if (!fs.existsSync(bakPath)) throw new Error('Backup not found. Cannot restore.');
    safeCopyFile(bakPath, asarPath);

    send('step', 'Removing backup…');
    safeUnlink(bakPath);

    const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
    if (fs.existsSync(unpackedPreload)) {
        const oldLine = `require(${JSON.stringify(path.join(REFLUX_APPDATA_SRC, 'preload.js').replace(/\\/g, '/'))});\n`;
        try {
            const contents = fs.readFileSync(unpackedPreload, 'utf8');
            if (contents.startsWith(oldLine)) {
                const tmpFile = path.join(os.tmpdir(), `unpacked-preload-${Date.now()}`);
                fs.writeFileSync(tmpFile, contents.slice(oldLine.length), 'utf8');
                safeMove(tmpFile, unpackedPreload);
                send('warn', 'Removed legacy preload injection.');
            }
        } catch { /* skip */ }
    }

    send('step', 'Cleaning up temp files…');
    for (const suffix of ['.reflux-extract', '.reflux-tmp', '.reflux-full-extract', '.reflux-patch']) {
        const p = path.join(resourcesDir, suffix);
        safeRemoveDir(p);
    }

    complete(true, 'Reflux uninstalled successfully. Restart Fluxer to apply.');
}

// ── Entry ─────────────────────────────────────────────────────────────────────

(async () => {
    try {
        if (op === 'install') await runInstall(asarPath);
        else if (op === 'update') await runUpdate();
        else if (op === 'uninstall') runUninstall(asarPath);
        else complete(false, `Unknown op: ${op}`);
    } catch (err) {
        send('error', err.message);
        complete(false, err.message);
    }
})();
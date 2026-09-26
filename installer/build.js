'use strict';

/**
 * installer/build.js
 *
 * Builds GUI and CLI installer artifacts for the current platform and places
 * them in installer/dist/:
 *
 *   reflux-v{version}-{platform}-setup.*  — GUI (Electron, bundles src/)
 *   reflux-v{version}-{platform}-cli.*    — CLI launcher (system Node on Linux,
 *                                           pkg single-file on Windows)
 *
 * Usage:
 *   node installer/build.js          (from repo root)
 *   node build.js                    (from installer/)
 *
 * Prerequisites: pnpm install inside installer/ first.
 */

const {execSync} = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname; // installer/
const {version} = require(path.join(ROOT, 'package.json'));
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, {recursive: true});

const tag = `v${version}`;
const targets = {
	win32: {
		label: 'Windows x64',
		platform: 'win-x64',
		electronArgs: '--win portable',
		pkgTarget: 'node20-win-x64',
		cliExtension: '.exe',
		artifactExtensions: ['.exe', '.zip'],
	},
	linux: {
		label: 'Linux x64',
		platform: 'linux-x64',
		electronArgs: '--linux AppImage',
		cliExtension: '',
		artifactExtensions: ['.AppImage', '.zip'],
	},
};

const target = targets[process.platform];
if (!target) {
	throw new Error(`Unsupported build platform: ${process.platform}. Supported platforms: Windows and Linux.`);
}

console.log(`\nBuilding Reflux ${tag} — ${target.label}\n${'─'.repeat(44)}`);

// ── 1. GUI: electron-builder portable ────────────────────────────────────────
console.log('\n[1/2] GUI installer (electron-builder portable)…');

execSync(`npx electron-builder ${target.electronArgs} --publish never`, {
	cwd: ROOT,
	stdio: 'inherit',
	env: {
		...process.env,
		// Suppress code-signing prompts in CI / local builds without a cert.
		CSC_IDENTITY_AUTO_DISCOVERY: 'false',
	},
});

console.log('[1/2] Done.');

// ── 2. CLI: package for the current platform ─────────────────────────────────
console.log(`\n[2/2] CLI installer (${process.platform === 'win32' ? 'pkg executable' : 'system Node launcher'})…`);

const cliOut = path.join(DIST, `reflux-${tag}-${target.platform}-cli${target.cliExtension}`);

if (process.platform === 'win32') {
	execSync(`npx pkg cli/index.js --targets node20-win-x64 --output "${cliOut}"`, {
		cwd: ROOT,
		stdio: 'inherit',
	});
} else {
	const launcher = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
exec node "$REPO_ROOT/installer/cli/index.js" "$@"
`;
	fs.writeFileSync(cliOut, launcher, {mode: 0o755});
}

console.log('[2/2] Done.');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(44)}\nArtifacts in installer/dist/:\n`);

const artifactNames = new Set([path.basename(cliOut)]);
for (const f of fs.readdirSync(DIST)) {
	if (!artifactNames.has(f) && !target.artifactExtensions.some((extension) => f.endsWith(extension))) continue;
	const {size} = fs.statSync(path.join(DIST, f));
	console.log(`  ${f}  (${(size / 1_048_576).toFixed(1)} MB)`);
}

console.log();

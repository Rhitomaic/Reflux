/**
 * Browser-like environment helpers for the smoke harness.
 *
 * The helpers evaluate the same self-contained scripts that main-inject.mjs
 * prepends to renderer.js inside a jsdom window. Tests therefore exercise the
 * browser branch of each UMD module rather than a Node-only shortcut.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');

function createBrowser(html = '<!doctype html><html><body></body></html>') {
  return new JSDOM(html, {
    url: 'https://web.fluxer.app/channels/@me/123456789012345678',
    runScripts: 'outside-only',
  });
}

function loadScript(dom, relativePath) {
  const filename = path.resolve(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  dom.window.eval(source);
  return dom.window;
}

function loadSanitizer() {
  const dom = createBrowser();
  const window = loadScript(dom, 'src/core/safeHtml.js');
  return {dom, window, sanitizer: window.__refluxSafeHtml.createSanitizer(window.document)};
}

function loadHistoryHelpers() {
  const dom = createBrowser();
  const window = loadScript(dom, 'src/core/messageHistory.js');
  return {dom, window, history: window.__refluxMessageHistory};
}

function loadMetadataHelpers() {
  const dom = createBrowser();
  const window = loadScript(dom, 'src/core/pluginMetadata.js');
  return {dom, window, metadata: window.__refluxPluginMetadata};
}

module.exports = {
  ROOT,
  createBrowser,
  loadScript,
  loadSanitizer,
  loadHistoryHelpers,
  loadMetadataHelpers,
};

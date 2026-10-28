'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {loadMetadataHelpers} = require('./helpers/browser');

const {metadata} = loadMetadataHelpers();

const FULL_BLOCK = `// ==RefluxPlugin==
// @name        Sample Plugin
// @author      3rr0r
// @description Does something cool
// @version     1.2.3
// @preview     https://example.test/preview.png
// @icon        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"></path></svg>
// ==/RefluxPlugin==

(function sample() {})();
`;

test('parseMetadata reads every supported field', () => {
  assert.deepEqual({...metadata.parseMetadata(FULL_BLOCK, 'sample.js')}, {
    name: 'Sample Plugin',
    author: '3rr0r',
    description: 'Does something cool',
    version: '1.2.3',
    preview: 'https://example.test/preview.png',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"></path></svg>',
  });
});

test('parseMetadata falls back to the filename without a metadata block', () => {
  const parsed = metadata.parseMetadata('(function () {})();', 'my-plugin.js');
  assert.equal(parsed.name, 'my-plugin');
  assert.equal(parsed.author, '');
});

test('parseMetadata handles CRLF and ignores unknown fields', () => {
  const source = [
    '// ==RefluxPlugin==',
    '// @name CRLF Plugin',
    '// @unknown ignored',
    '// @author Ada',
    '// ==/RefluxPlugin==',
  ].join('\r\n');
  const parsed = metadata.parseMetadata(source, 'fallback.js');
  assert.equal(parsed.name, 'CRLF Plugin');
  assert.equal(parsed.author, 'Ada');
});

test('validateImport rejects empty and oversized sources', () => {
  const empty = metadata.validateImport({source: '  ', meta: {name: 'x'}});
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');

  const oversized = metadata.validateImport({source: 'x'.repeat(64), meta: {name: 'x'}, maxBytes: 16});
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'too-large');
});

test('validateImport rejects missing names and duplicates case-insensitively', () => {
  const missing = metadata.validateImport({source: 'x', meta: {name: '   '}});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'invalid-name');

  const duplicate = metadata.validateImport({
    source: 'x',
    meta: {name: 'Sample Plugin'},
    imported: [{name: 'other'}, {name: 'sample plugin'}],
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate');

  const reserved = metadata.validateImport({
    source: 'x',
    meta: {name: 'messageLogger'},
    reservedNames: ['messageLogger'],
  });
  assert.equal(reserved.ok, false);
  assert.equal(reserved.code, 'duplicate');
});

test('validateImport accepts a valid plugin and reports byte length', () => {
  const result = metadata.validateImport({
    source: '(function () {})();',
    meta: {name: 'New Plugin'},
    imported: [{name: 'Old Plugin'}],
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.equal(result.bytes, Buffer.byteLength('(function () {})();'));
});

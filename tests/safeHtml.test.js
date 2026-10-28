'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {loadSanitizer} = require('./helpers/browser');

function sanitize(html, options) {
  const {sanitizer} = loadSanitizer();
  return sanitizer.sanitize(html, options);
}

test('message policy keeps formatting but removes scripts and embedded content', () => {
  const output = sanitize([
    '<p class="markup" onclick="steal()">Hello <strong>world</strong></p>',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.test"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<form action="https://evil.test"><input value="x"></form>',
  ].join(''));

  assert.match(output, /<p class="markup">Hello <strong>world<\/strong><\/p>/);
  assert.doesNotMatch(output, /script|iframe|object|embed|form|input/i);
  assert.doesNotMatch(output, /onclick/i);
});

test('unknown tags are unwrapped so their text survives', () => {
  assert.equal(sanitize('<custom-tag>kept</custom-tag><p>text</p>'), 'kept<p>text</p>');
});

test('dangerous URLs are removed while normal links are kept', () => {
  const output = sanitize([
    '<a href="javascript:alert(1)">js</a>',
    '<a href=" JAVASCRIPT:alert(1)">spaced</a>',
    '<a href="https://fluxer.app/channels">safe</a>',
    '<a href="#anchor">anchor</a>',
    '<img src="data:text/html;base64,PHNjcmlwdD4=">',
    '<img src="data:image/png;base64,AAAA">',
  ].join(''));

  assert.doesNotMatch(output, /javascript/i);
  assert.doesNotMatch(output, /data:text\/html/i);
  assert.match(output, /href="https:\/\/fluxer\.app\/channels"/);
  assert.match(output, /href="#anchor"/);
  assert.match(output, /src="data:image\/png;base64,AAAA"/);
  assert.match(output, /rel="noopener noreferrer"/);
});

test('srcset candidates are filtered individually', () => {
  const output = sanitize(
    '<img src="https://cdn.test/a.png" srcset="https://cdn.test/a.png 1x, javascript:alert(1) 2x, data:image/gif;base64,AA 3x">',
  );

  assert.match(output, /srcset="https:\/\/cdn\.test\/a\.png 1x, data:image\/gif;base64,AA 3x"/);
  assert.doesNotMatch(output, /javascript/i);
});

test('unsafe CSS declarations are dropped and safe ones are kept', () => {
  const output = sanitize(
    '<span style="color:red;position:absolute;background-image:url(https://evil.test/x);' +
    'width:expression(alert(1));font-weight:600;white-space:pre">x</span>',
  );

  assert.match(output, /style="color: red; font-weight: 600; white-space: pre"/);
  assert.doesNotMatch(output, /position|expression|background-image|evil/i);
});

test('comments, ids, contenteditable and data-reflux hooks are removed', () => {
  const output = sanitize(
    '<!-- comment --><p id="clobber" contenteditable="true" data-reflux-ghost="1" data-flx="keep">x</p>',
  );

  assert.equal(output, '<p data-flx="keep">x</p>');
});

test('icon policy accepts SVG paths and strips scripting and external references', () => {
  const output = sanitize([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="evil()">',
    '<script>alert(1)</script>',
    '<foreignObject><div>bad</div></foreignObject>',
    '<defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"></stop></linearGradient></defs>',
    '<path d="M1 1 L2 2" fill="url(#g)" onclick="evil()"></path>',
    '<use href="https://evil.test/icon.svg#x"></use>',
    '<use href="#g"></use>',
    '</svg>',
  ].join(''), {profile: 'icon'});

  assert.match(output, /^<svg /);
  assert.match(output, /viewBox="0 0 24 24"/);
  assert.match(output, /<path d="M1 1 L2 2" fill="url\(#g\)"><\/path>/);
  assert.match(output, /<use href="#g"><\/use>/);
  assert.doesNotMatch(output, /script|foreignObject|onload|onclick|evil\.test/i);
});

test('icon policy rejects raw HTML and external CSS URLs', () => {
  const output = sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" style="fill:url(https://evil.test/x);stroke:#000;position:absolute"></rect></svg>',
    {profile: 'icon'},
  );

  assert.match(output, /stroke: #000/);
  assert.doesNotMatch(output, /evil|position/i);
});

test('custom policy options extend or replace the allowlist', () => {
  const extended = sanitize('<p><mark>word</mark></p>', {allowedTags: ['mark']});
  assert.equal(extended, '<p><mark>word</mark></p>');

  const replaced = sanitize('<p><mark>word</mark></p>', {tags: ['mark'], attributes: []});
  assert.equal(replaced, '<mark>word</mark>');
});

test('set() writes sanitised markup and escape() produces inert text', () => {
  const {dom, sanitizer} = loadSanitizer();
  const element = sanitizer.set(dom.window.document.createElement('div'), '<b onclick="x">bold</b><script>x</script>');
  assert.equal(element.innerHTML, '<b>bold</b>');
  assert.equal(sanitizer.escape('<img src=x>'), '&lt;img src=x&gt;');
});

test('isSafeUrl helper exposes the same scheme policy', () => {
  const {sanitizer} = loadSanitizer();
  assert.equal(sanitizer.isSafeUrl('https://fluxer.app'), true);
  assert.equal(sanitizer.isSafeUrl('mailto:test@example.com'), true);
  assert.equal(sanitizer.isSafeUrl('javascript:alert(1)'), false);
  assert.equal(sanitizer.isSafeUrl('data:image/png;base64,AA', {kind: 'resource'}), true);
  assert.equal(sanitizer.isSafeUrl('data:image/svg+xml;base64,AA', {kind: 'resource'}), false);
});

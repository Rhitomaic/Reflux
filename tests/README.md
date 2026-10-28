# Smoke harness

`npm test` runs the Node test runner against the focused smoke tests in this
directory. The helpers in `helpers/browser.js` evaluate the same UMD scripts
that `src/main-inject.mjs` injects before `renderer.js`, using a jsdom window so
the browser branch is exercised.

Current coverage:

| File | Area |
|---|---|
| `safeHtml.test.js` | Allowlist filtering, URL/CSS handling, SVG icon policy |
| `pluginMetadata.test.js` | `==RefluxPlugin==` metadata parsing and import validation |
| `messageHistory.test.js` | History serialization/import, retention limits, route matching |

Add a new `*.test.js` file for plugin-specific pure logic. Keep browser/DOM
tests in the jsdom helper rather than adding a second test framework.

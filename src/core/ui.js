/**
 * Renderer-side UI helpers for Reflux plugins.
 *
 * The implementation lives in src/renderer.js and is exposed through
 * window.__reflux.ui. This file provides a convenient CommonJS passthrough.
 */

'use strict';

function getUI() {
  if (!window.__reflux) {
    throw new Error('[Reflux] UI helpers are not available — window.__reflux is not set.');
  }
  return window.__reflux.ui;
}

function find(selector, root)                    { return getUI().find(selector, root); }
function findAll(selector, root)                 { return getUI().findAll(selector, root); }
function findByText(text, root, exact)            { return getUI().findByText(text, root, exact); }
function findByRole(role, name, root)             { return getUI().findByRole(role, name, root); }
function waitFor(selector, options)               { return getUI().waitFor(selector, options); }
function click(target, root)                     { return getUI().click(target, root); }
function injectCSS(id, cssText)                  { return getUI().injectCSS(id, cssText); }
function navigate(to, options)                   { return getUI().navigate(to, options); }
function onNavigate(callback)                    { return getUI().onNavigate(callback); }

module.exports = {
  find, findAll, findByText, findByRole, waitFor,
  click, injectCSS, navigate, onNavigate, getUI,
};
/**
 * src/plugins/settingsUI/renderer-side.js
 *
 * Injects a "Reflux" section into Fluxer's settings sidebar.
 *
 * Panel rendering strategy
 * ─────────────────────────
 * We discover every CSS class name by reading them off existing live DOM
 * elements (resilient to hash changes between Fluxer builds), then build
 * our panel using the *exact* same HTML structure Fluxer uses.
 *
 * To avoid breaking React's reconciler we never touch the real tabpanel.
 * Instead we insert our panel as a sibling, and simply toggle display:none
 * on the real tabpanel while ours is active. React keeps rendering into
 * its (hidden) div normally.
 *
 * Imported plugins
 * ────────────────
 * Stored in settings at `reflux.importedPlugins`. Supports a Tampermonkey-
 * style metadata block at the top of each file:
 *   // ==RefluxPlugin==
 *   // @name        My Plugin
 *   // @author      Brady
 *   // @description Does cool stuff
 *   // @version     1.0.0
 *   // @preview     https://i.imgur.com/abc.png
 *   // ==/RefluxPlugin==
 */

(function refluxSettingsUI() {
  'use strict';

  if (window.__reflux_settingsUI_loaded) return;
  window.__reflux_settingsUI_loaded = true;

  // ─── SVG paths ────────────────────────────────────────────────────────────
  const SVG_PLUG   = 'M229.66,26.34a8,8,0,0,0-11.32,0L160,84.69l-5.38-5.38a32.05,32.05,0,0,0-45.25,0L96,92.69,82.34,79A8,8,0,0,0,71,90.34L84.69,104,48,140.69a32,32,0,0,0,0,45.26L57.37,195,26.34,226.06a8,8,0,0,0,11.32,11.32L68.69,206.63l9.37,9.38a32,32,0,0,0,45.26,0L160,179.32l13.66,13.65a8,8,0,0,0,11.32-11.31L171.32,168l13.37-13.38a32,32,0,0,0,0-45.25l-5.38-5.38,58.35-58.34A8,8,0,0,0,229.66,26.34ZM91.32,204.69a16,16,0,0,1-22.63,0L31.32,167.32a16,16,0,0,1,0-22.63L88,108l60,60Zm82.05-60.06L160,158l-62-62,13.38-13.37a16,16,0,0,1,22.62,0l49.38,49.37A16,16,0,0,1,173.37,144.63Z';
  const SVG_UPLOAD = 'M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z';
  const SVG_TRASH  = 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z';
  const SVG_PUZZLE = 'M223.07,111.06l-32-16A8,8,0,0,0,180,102.46V120H160V102.46a8,8,0,0,0-11.07-7.4l-32,16a8,8,0,0,0,0,14.88L144,136.2V160H128a8,8,0,0,0,0,16h16v23.8l-27.07,10.74a8,8,0,0,0,0,14.88l32,16A8,8,0,0,0,160,224V206.54a8,8,0,0,0,11.07,7.4l32-16a8,8,0,0,0,0-14.88L176,172.72V160h16a8,8,0,0,0,0-16H176V136.2l27.07-10.26a8,8,0,0,0,0-14.88ZM160,64V48a8,8,0,0,0-16,0V64a8,8,0,0,0,16,0ZM88,160H64a8,8,0,0,0,0,16H88a8,8,0,0,0,0-16Zm144-64H216a8,8,0,0,0,0,16h16a8,8,0,0,0,0-16ZM40,96H56a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16Zm48-32A8,8,0,0,0,99.31,58.34l-32,32a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,88,64Zm128,128a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,216,192ZM88,192a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,88,192Z';
  const SVG_CHECK  = 'M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z';
  const SVG_X      = 'M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z';

  function svgEl(path, w = 20, h = 20, extraStyle = '') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" fill="currentColor" viewBox="0 0 256 256"${extraStyle ? ` style="${extraStyle}"` : ''}><path d="${path}"></path></svg>`;
  }

  function switchIcon(path, cls, size) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" viewBox="0 0 256 256" class="${cls}" aria-hidden="true"><path d="${path}"></path></svg>`;
  }

  /**
   * Renders a plugin icon from three accepted formats:
   *   - Raw SVG string  (<svg …>)
   *   - Image URL       (https://… or data:…)
   *   - Emoji / text    (anything else — short string)
   * Falls back to the generic puzzle SVG when icon is falsy.
   */
  function renderIcon(icon) {
    if (!icon) return svgEl(SVG_PUZZLE, 18, 18);
    const s = String(icon).trim();
    if (/^<svg/i.test(s)) return s;
    if (/^(https?:|data:)/i.test(s)) {
      return `<img src="${esc(s)}" width="22" height="22" style="object-fit:contain;border-radius:4px;" alt="" onerror="this.replaceWith(document.createRange().createContextualFragment('${svgEl(SVG_PUZZLE, 18, 18).replace(/'/g, "\\'")}'))">`;
    }
    // Emoji or short text
    return `<span style="font-size:20px;line-height:1;user-select:none;">${esc(s)}</span>`;
  }

  // ─── Utility ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function uid() { return '_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // ─── Settings styling ─────────────────────────────────────────────────────
  // Mirrors Fluxer's own SettingsSection / FormSwitch components so plugin
  // controls sit naturally inside the native settings panel.
  const SETTINGS_STYLE_ID = 'reflux-settings-ui-style';
  const SETTINGS_CSS = `
    .reflux-plugins-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-5, 1.25rem);
    }
    .reflux-plugin {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-2, 0.5rem);
      min-width: 0;
    }
    .reflux-plugin-header {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-3, 0.75rem);
      min-width: 0;
    }
    .reflux-plugin-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      flex: 0 0 auto;
      box-sizing: border-box;
      border-radius: 0.625rem;
      background: var(--background-secondary-lighter, var(--background-modifier-accent, rgba(255, 255, 255, 0.06)));
      color: var(--interactive-normal, var(--text-secondary, #b5bac1));
      overflow: hidden;
    }
    .reflux-plugin-icon > svg {
      display: block;
      width: 1.25rem;
      height: 1.25rem;
    }
    .reflux-plugin-icon > img {
      display: block;
      width: 1.375rem;
      height: 1.375rem;
      object-fit: contain;
      border-radius: 0.25rem;
    }
    .reflux-plugin-info {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
      flex: 1 1 auto;
    }
    .reflux-plugin-name-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }
    .reflux-plugin-name {
      min-width: 0;
      overflow: hidden;
      color: var(--text-primary, var(--text-normal, #dbdee1));
      font-size: 0.9375rem;
      font-weight: 600;
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .reflux-plugin-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      padding: 0.125rem 0.375rem;
      border-radius: 0.4375rem;
      background: var(--background-modifier-accent, rgba(255, 255, 255, 0.08));
      color: var(--text-secondary, var(--text-muted, #949ba4));
      font-size: 0.625rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .reflux-plugin-meta {
      color: var(--text-tertiary, var(--text-muted, #949ba4));
      font-size: 0.75rem;
      line-height: 1.25rem;
    }
    .reflux-plugin-description {
      color: var(--text-secondary, var(--text-muted, #949ba4));
      font-size: 0.8125rem;
      line-height: 1.4;
    }
    .reflux-plugin-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      flex: 0 0 auto;
      padding-top: 0.5rem;
    }
    .reflux-plugin-settings {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
      margin-left: calc(2.5rem + var(--spacing-3, 0.75rem));
    }

    .reflux-switch-row {
      display: flex;
      min-height: 2.75rem;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.25rem 0;
    }
    .reflux-switch-inline {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
    }
    .reflux-switch-label-container {
      display: flex;
      min-width: 0;
      flex: 1 1 0%;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
      text-align: left;
      cursor: pointer;
    }
    .reflux-switch-label {
      display: flex;
      min-width: 0;
      max-width: 100%;
      align-items: center;
      gap: 0.5rem;
      color: var(--text-primary, var(--text-normal, #dbdee1));
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.25rem;
    }
    .reflux-switch-description {
      padding-right: 1rem;
      color: var(--text-primary-muted, var(--text-secondary, var(--text-muted, #949ba4)));
      font-size: 0.875rem;
      line-height: 1.25rem;
    }
    .reflux-switch-root {
      display: inline-flex;
      align-items: center;
      position: relative;
      height: 1.5rem;
      width: 2.75rem;
      flex: 0 0 auto;
      padding: 0;
      border: 0;
      border-radius: 624.9375rem;
      background-color: rgb(107 114 128);
      box-shadow:
        inset 0 0.125rem 0.25rem 0 rgba(0, 0, 0, 0.15),
        0 0.0625rem 0 0 rgba(255, 255, 255, 0.1);
      transition:
        color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
        background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
        border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
        box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
    }
    .reflux-switch-root:hover:not(:disabled) {
      box-shadow:
        inset 0 0.125rem 0.25rem 0 rgba(0, 0, 0, 0.15),
        0 0.0625rem 0 0 rgba(255, 255, 255, 0.15);
    }
    .reflux-switch-root:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    .reflux-switch-root[data-state="checked"] {
      background-color: var(--brand-primary, var(--brand-500, #5865f2));
      box-shadow:
        inset 0 0.125rem 0.25rem 0 rgba(0, 0, 0, 0.1),
        0 0.0625rem 0 0 rgba(255, 255, 255, 0.15);
    }
    .reflux-switch-thumb {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      border-radius: 624.9375rem;
      background-color: #fff;
      box-shadow:
        inset 0 -0.0625rem 0.125rem 0 rgba(0, 0, 0, 0.08),
        0 0.0625rem 0 0 rgba(0, 0, 0, 0.15),
        0 0.125rem 0.25rem -0.0625rem rgba(0, 0, 0, 0.2);
      transition:
        transform 0.15s cubic-bezier(0.4, 0, 0.2, 1),
        box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1);
      will-change: transform;
      transform: translateX(0.125rem);
    }
    .reflux-switch-thumb[data-state="checked"] {
      background-color: var(--brand-primary-fill, #fff);
      transform: translateX(1.375rem);
    }
    .reflux-switch-thumb svg {
      display: block;
      width: 0.75rem;
      height: 0.75rem;
    }
    .reflux-switch-thumb .reflux-switch-icon-unchecked {
      width: 0.625rem;
      height: 0.625rem;
    }
    .reflux-switch-icon-checked {
      color: var(--brand-primary, var(--brand-500, #5865f2));
    }
    .reflux-switch-icon-unchecked {
      color: rgb(107 114 128);
    }

    .reflux-setting-row {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-height: 2.75rem;
      padding: 0.5rem 0;
    }
    .reflux-setting-main {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
    }
    .reflux-setting-row-inline {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .reflux-setting-text {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-width: 0;
    }
    .reflux-setting-control {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }
    .reflux-setting-control-full {
      width: 100%;
    }
    .reflux-setting-input,
    .reflux-setting-select {
      box-sizing: border-box;
      min-height: 2.25rem;
      padding: 0.4375rem 0.625rem;
      border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.08));
      border-radius: 0.5rem;
      background: var(--form-surface-background, var(--background-secondary, #2b2d31));
      color: var(--text-primary, var(--text-normal, #dbdee1));
      font: inherit;
      font-size: 0.875rem;
      line-height: 1.25rem;
    }
    .reflux-setting-input {
      width: 100%;
    }
    textarea.reflux-setting-input {
      min-height: 5.5rem;
      resize: vertical;
    }
    .reflux-setting-select {
      min-width: 9rem;
      max-width: 100%;
    }
    .reflux-setting-control-full .reflux-setting-select {
      width: 100%;
    }
    .reflux-setting-input:disabled,
    .reflux-setting-select:disabled,
    .reflux-setting-slider:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .reflux-setting-input:focus-visible,
    .reflux-setting-select:focus-visible,
    .reflux-setting-slider:focus-visible {
      outline: 2px solid var(--brand-primary, var(--brand-500, #5865f2));
      outline-offset: 1px;
    }
    .reflux-setting-slider-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
    }
    .reflux-setting-slider {
      width: 100%;
      accent-color: var(--brand-primary, var(--brand-500, #5865f2));
    }
    .reflux-setting-value {
      min-width: 2.5rem;
      color: var(--text-secondary, var(--text-muted, #949ba4));
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .reflux-setting-error {
      color: var(--status-danger, #ed4245);
      font-size: 0.75rem;
      line-height: 1.25rem;
    }
    .reflux-setting-custom {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      width: 100%;
      min-width: 0;
    }
    .reflux-setting-fallback {
      color: var(--text-tertiary, var(--text-muted, #949ba4));
      font-size: 0.8125rem;
      line-height: 1.35;
    }

    .reflux-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      min-height: 2.25rem;
      padding: 0.4375rem 0.75rem;
      box-sizing: border-box;
      border: 1px solid transparent;
      border-radius: 0.5rem;
      font-family: inherit;
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.125rem;
      cursor: pointer;
      transition:
        background-color 0.12s ease,
        border-color 0.12s ease,
        color 0.12s ease,
        opacity 0.12s ease;
    }
    .reflux-button > svg {
      display: block;
      width: 1rem;
      height: 1rem;
    }
    .reflux-button-primary {
      background-color: var(--brand-primary, var(--brand-500, #5865f2));
      border-color: color-mix(in srgb, var(--brand-primary, var(--brand-500, #5865f2)) 82%, white 18%);
      color: var(--brand-primary-fill, #fff);
    }
    .reflux-button-primary:hover {
      background-color: var(--brand-secondary, var(--brand-560, #4752c4));
    }
    .reflux-icon-button {
      all: unset;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border-radius: 0.375rem;
      color: var(--text-tertiary, var(--text-muted, #949ba4));
      cursor: pointer;
      transition:
        background-color 0.12s ease,
        color 0.12s ease;
    }
    .reflux-icon-button:hover {
      background-color: var(--background-modifier-hover, rgba(255, 255, 255, 0.06));
      color: var(--text-primary, var(--text-normal, #dbdee1));
    }
    .reflux-icon-button-danger:hover {
      background-color: color-mix(in srgb, var(--status-danger, #ed4245) 12%, transparent);
      color: var(--status-danger, #ed4245);
    }
    .reflux-empty-state {
      margin: 0.5rem 0 0;
      color: var(--text-secondary, var(--text-muted, #949ba4));
      font-size: 0.875rem;
      line-height: 1.35;
    }
    .reflux-switch-root:focus-visible,
    .reflux-button:focus-visible,
    .reflux-icon-button:focus-visible {
      outline: 2px solid var(--brand-primary, var(--brand-500, #5865f2));
      outline-offset: 2px;
    }
  `;

  function ensureSettingsStyles() {
    if (document.getElementById(SETTINGS_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SETTINGS_STYLE_ID;
    style.textContent = SETTINGS_CSS;
    document.head.appendChild(style);
  }

  function removeSettingsStyles() {
    document.getElementById(SETTINGS_STYLE_ID)?.remove();
  }

  // ─── Class discovery ──────────────────────────────────────────────────────
  const SETTINGS_CONTENT_SELECTOR = '[data-flx="app.settings-modal-layout.settings-modal-desktop-content-component.desktop-content"]';

  function findSettingsContent() {
    const sidebar = findDeveloperSection();
    if (!sidebar) return null;

    // Keep the lookup inside the settings modal that owns the sidebar. A bare
    // role="tabpanel" also matches unrelated app panels such as Friends.
    let ancestor = sidebar.parentElement;
    while (ancestor) {
      const content = ancestor.querySelector(SETTINGS_CONTENT_SELECTOR);
      if (content) return content;
      ancestor = ancestor.parentElement;
    }

    return document.querySelector(SETTINGS_CONTENT_SELECTOR);
  }

  function discoverClasses() {
    const panel = findSettingsContent();
    if (!panel) return null;

    function pickAll(el) { return el ? Array.from(el.classList).join(' ') : ''; }
    function first(...selectors) {
      for (const selector of selectors) {
        const element = panel.querySelector(selector);
        if (element) return element;
      }
      return null;
    }

    const pad        = panel.querySelector('div');
    const card       = pad?.querySelector('div');
    const header     = first('[data-flx="app.settings-modal-header.header"]', '[class*="desktopHeader"]');
    const titleCont  = first('[data-flx="app.settings-modal-header.title-content"]', '[class*="titleContent"]');
    const closeBtn   = first('[data-flx="app.settings-modal-header.button.close"]', '[aria-label="Close"]');
    const h1         = panel.querySelector('h1');
    const scrollWrap = panel.querySelector('[class*="scrollerWrap"]');
    const scroller   = first('[data-settings-scroll-container]', '[data-fluxer-scroll-container]');
    const scrollCh   = scroller?.firstElementChild;
    const spacerTop  = first('[data-flx="app.settings-modal-layout.settings-modal-desktop-scroll.desktop-scroll-spacer-top"]', '[class*="ScrollSpacerTop"]');
    const scrollInner= first('[data-flx="app.settings-modal-layout.settings-modal-desktop-scroll.desktop-scroll-inner"]', '[class*="desktopScrollInner"]');
    const spacerBot  = first('[data-flx="app.settings-modal-layout.settings-modal-desktop-scroll.desktop-scroll-spacer-bottom"]', '[class*="ScrollSpacerBottom"]');
    const tabCont    = first(
      '[data-flx="app.settings-tab-layout.settings-tab-container.container"]',
      '[class*="SettingsTabLayout"][class*="container"]',
    ) || Array.from(scrollInner?.children ?? []).find(child => child.tagName !== 'OUTPUT');
    const subsec     = first('[data-flx="app.settings-section.section"]', '[class*="subsection"]');
    const subsecHdr  = subsec?.querySelector('[data-flx="app.settings-section.section-header"], [class*="subsectionHeader"]');
    const subsecTitle= subsecHdr?.querySelector('[data-flx="app.settings-section.section-title"], h3, h4');
    const subsecDesc = subsecHdr?.querySelector('[data-flx="app.settings-section.section-description"], p');
    const subsecTitleRow = subsecHdr?.querySelector('[data-flx="app.settings-section.section-title-row"], [class*="sectionTitleRow"]');
    const subsecCont = subsec?.querySelector('[data-flx="app.settings-section.section-content"], [class*="subsectionContent"]');
    const trackEl    = first('[data-flx="ui.scroller.scroller-track.presentation.track-pointer-down"]', '[class*="ScrollerTrack"][class*="track"]');
    const thumbEl    = trackEl?.querySelector('[data-scroller-thumb="true"], [class*="thumb"]');

    return {
      desktopContent:    pickAll(panel),
      desktopContentPad: pickAll(pad),
      desktopContentCard:pickAll(card),
      desktopHeader:     pickAll(header),
      titleContent:      pickAll(titleCont),
      closeButton:       pickAll(closeBtn),
      closeIcon:         pickAll(closeBtn?.querySelector('svg')),
      title:             pickAll(h1),
      scrollerWrap:      pickAll(scrollWrap),
      scroller:          pickAll(scroller),
      scrollerChildren:  pickAll(scrollCh),
      spacerTop:         pickAll(spacerTop),
      scrollInner:       pickAll(scrollInner),
      spacerBot:         pickAll(spacerBot),
      tabContainer:      pickAll(tabCont),
      subsection:        pickAll(subsec),
      subsectionHeader:  pickAll(subsecHdr),
      subsectionTitleRow:pickAll(subsecTitleRow),
      subsectionTitle:   pickAll(subsecTitle),
      subsectionDesc:    pickAll(subsecDesc),
      subsectionContent: pickAll(subsecCont),
      scrollTrack:       pickAll(trackEl),
      scrollTrackThumb:  pickAll(thumbEl),
      // sidebar (filled in by discoverSidebarClasses)
      cat: '', catTitle: '', item: '', itemIcon: '', itemLabel: '', tabLabel: '',
    };
  }

  function discoverSidebarClasses(devSection) {
    function pick(el) { return el ? Array.from(el.classList).join(' ') : ''; }
    const btn  = devSection.querySelector('button');
    const svgE = btn?.querySelector('svg');
    const span = btn?.querySelector('span');
    const inner= btn?.querySelector('span > div');
    return {
      cat:      pick(devSection),
      catTitle: pick(devSection.querySelector('h2')),
      item:     pick(btn),
      itemIcon: pick(svgE),
      itemLabel:pick(span),
      tabLabel: pick(inner),
    };
  }

  // ─── Sidebar highlight override ───────────────────────────────────────────
  // Injected while our panel is active so the previously-selected Fluxer tab
  // loses its highlight and our button gains it.
  let _styleTag = null;

  function injectActiveStyle() {
    if (_styleTag) return;
    _styleTag = document.createElement('style');
    _styleTag.id = 'reflux-active-style';
    // Suppress highlight on all non-Reflux sidebar tabs
    _styleTag.textContent = `
      [data-flx="app.settings-modal-layout.settings-modal-sidebar-category.sidebar-category"]:not(#reflux-sidebar-section) [role="treeitem"][aria-selected="true"],
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarItemSelected"],
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarItemFocused"],
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="treeitem"][aria-selected="true"],
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="tab"][aria-selected="true"],
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="treeitem"][data-selected="true"] {
        background: transparent !important;
        box-shadow: none !important;
        color: var(--text-primary-muted, var(--interactive-normal, #b9bbbe)) !important;
      }
      [data-flx="app.settings-modal-layout.settings-modal-sidebar-category.sidebar-category"]:not(#reflux-sidebar-section) [role="treeitem"][aria-selected="true"] > *,
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarItemSelected"] > *,
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarItemFocused"] > *,
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="treeitem"][aria-selected="true"] > *,
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="tab"][aria-selected="true"] > * {
        opacity: 0.7 !important;
      }
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarItemSelected"] svg,
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarItemFocused"] svg,
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="treeitem"][aria-selected="true"] svg {
        color: var(--text-tertiary, #949ba4) !important;
      }
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [class*="sidebarSubItemActive"] {
        background: transparent !important;
        color: var(--text-tertiary, #949ba4) !important;
      }
      #reflux-tab-plugins {
        background: var(--background-modifier-selected, rgba(255,255,255,0.1)) !important;
        color: var(--interactive-active, #fff) !important;
      }
      #reflux-tab-plugins > * {
        opacity: 1 !important;
      }
      #reflux-tab-plugins svg {
        color: var(--settings-sidebar-highlight, var(--interactive-active, #fff)) !important;
      }
      #reflux-tab-plugins:focus-visible {
        outline: 2px solid var(--brand-primary, #5865f2);
        outline-offset: 2px;
      }
    `;
    document.head.appendChild(_styleTag);
  }

  function removeActiveStyle() {
    _styleTag?.remove();
    _styleTag = null;
  }

  /**
   * Collapse the native tab that was selected before Reflux opened. Fluxer
   * keeps expandable categories (e.g. Advanced) open until their own tab is
   * clicked again, which leaves a stale submenu under the Reflux item.
   */
  function collapseNativeSidebarSections() {
    const selected = Array.from(document.querySelectorAll(
      '[data-flx="app.settings-modal-layout.settings-modal-sidebar-category.sidebar-category"] [role="treeitem"][aria-selected="true"], ' +
      '[class*="sidebarCategory"] [role="treeitem"][aria-selected="true"]',
    )).find(el => !el.closest('#reflux-sidebar-section'));

    if (selected?.getAttribute('aria-expanded') === 'true') selected.click();
  }

  // ─── Imported plugin storage ───────────────────────────────────────────────
  async function getImported() {
    try { return await window.refluxBridge?.getSetting('reflux.importedPlugins', []) ?? []; }
    catch { return []; }
  }
  async function saveImported(list) {
    try { await window.refluxBridge?.setSetting('reflux.importedPlugins', list); }
    catch (e) { console.error('[Reflux:SettingsUI] save failed', e); }
  }

  function parseMetadata(src, filename) {
    const meta = { name: filename.replace(/\.js$/i,''), description: '', author: '', version: '', preview: '', icon: '' };
    const block = src.match(/\/\/\s*==RefluxPlugin==([\s\S]*?)\/\/\s*==\/RefluxPlugin==/i);
    if (block) {
      for (const line of block[1].split('\n')) {
        const m = line.match(/\/\/\s*@(\w+)\s+(.*)/);
        if (m && m[1] in meta) meta[m[1]] = m[2].trim();
      }
    }
    return meta;
  }

  function runPlugin(src) {
    try { new Function(src)(); }
    catch (e) { console.error('[Reflux:SettingsUI] Plugin runtime error:', e); }
  }

  const _importedRuntime = new Map();

  function startImportedPlugin(plugin) {
    const before = new Set(window.__reflux?.pluginManager?.list?.() ?? []);
    runPlugin(plugin.source);
    const after = window.__reflux?.pluginManager?.list?.() ?? [];
    _importedRuntime.set(plugin.id, after.filter(name => !before.has(name)));
  }

  function stopImportedPlugin(id) {
    for (const name of _importedRuntime.get(id) ?? []) {
      window.__reflux?.pluginManager?.unregister?.(name);
    }
    _importedRuntime.delete(id);
  }

  getImported().then(list => list.filter(p => p.enabled !== false).forEach(startImportedPlugin));

  // ─── Setting controls ──────────────────────────────────────────────────────
  function evaluateSettingFlag(flag, context) {
    if (typeof flag === 'function') {
      try { return Boolean(flag.call(context)); }
      catch (err) {
        console.error('[Reflux:SettingsUI] Setting flag threw:', err);
        return false;
      }
    }
    return Boolean(flag);
  }

  function settingLabel(setting) {
    return setting.label || setting.displayName || setting.key;
  }

  function selectedOptionValue(setting, rawValue) {
    const options = Array.isArray(setting.options) ? setting.options : [];
    const match = options.find((option) => String(option.value) === String(rawValue));
    return match ? match.value : rawValue;
  }

  function validateSetting(setting, value, values) {
    if (typeof setting.isValid !== 'function') return true;
    try {
      const result = setting.isValid.call(values, value);
      if (result === false) return 'Invalid value';
      if (typeof result === 'string') return result;
      return true;
    } catch (err) {
      console.error('[Reflux:SettingsUI] Setting validation threw:', err);
      return 'Validation failed';
    }
  }

  function makeSettingRow(setting, value, onChange, disabled, values) {
    const type = setting.type || 'string';
    const label = settingLabel(setting);
    const description = setting.description || '';

    if (type === 'boolean') {
      return makeToggle(Boolean(value), onChange, {label, description, disabled}).el;
    }

    const row = document.createElement('div');
    row.className = 'reflux-setting-row';

    const main = document.createElement('div');
    main.className = 'reflux-setting-main' + (type === 'select' ? ' reflux-setting-row-inline' : '');

    const text = document.createElement('div');
    text.className = 'reflux-setting-text';
    if (label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'reflux-switch-label';
      labelEl.textContent = label;
      text.appendChild(labelEl);
    }
    if (description) {
      const descEl = document.createElement('span');
      descEl.className = 'reflux-switch-description';
      descEl.textContent = description;
      text.appendChild(descEl);
    }
    main.appendChild(text);

    const control = document.createElement('div');
    control.className = 'reflux-setting-control' + (type === 'select' ? '' : ' reflux-setting-control-full');

    const error = document.createElement('div');
    error.className = 'reflux-setting-error';
    error.hidden = true;

    async function commit(nextValue) {
      const validation = validateSetting(setting, nextValue, values);
      if (validation !== true) {
        error.hidden = false;
        error.textContent = validation;
        return;
      }
      error.hidden = true;
      try { await onChange(nextValue); }
      catch (err) {
        console.error(`[Reflux:SettingsUI] Failed to save "${setting.key}":`, err);
        error.hidden = false;
        error.textContent = 'Could not save this setting.';
      }
    }

    if (type === 'string') {
      const input = document.createElement(setting.multiline ? 'textarea' : 'input');
      input.className = 'reflux-setting-input';
      if (!setting.multiline) input.type = 'text';
      input.value = value ?? '';
      input.disabled = disabled;
      if (setting.placeholder) input.placeholder = setting.placeholder;
      input.addEventListener('change', () => commit(input.value));
      control.appendChild(input);
    } else if (type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'reflux-setting-input';
      input.value = value ?? '';
      input.disabled = disabled;
      input.step = setting.step ?? 'any';
      if (setting.min !== undefined) input.min = String(setting.min);
      if (setting.max !== undefined) input.max = String(setting.max);
      input.addEventListener('change', () => {
        commit(input.value === '' ? setting.default ?? 0 : Number(input.value));
      });
      control.appendChild(input);
    } else if (type === 'select') {
      const select = document.createElement('select');
      select.className = 'reflux-setting-select';
      select.disabled = disabled;
      for (const option of setting.options || []) {
        const optionEl = document.createElement('option');
        optionEl.value = String(option.value);
        optionEl.textContent = option.label ?? String(option.value);
        select.appendChild(optionEl);
      }
      select.value = String(value ?? '');
      select.addEventListener('change', () => commit(selectedOptionValue(setting, select.value)));
      control.appendChild(select);
    } else if (type === 'slider') {
      const markers = Array.isArray(setting.markers) && setting.markers.length
        ? setting.markers
        : [0, 100];
      const min = Math.min(...markers);
      const max = Math.max(...markers);

      const sliderRow = document.createElement('div');
      sliderRow.className = 'reflux-setting-slider-row';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'reflux-setting-slider';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(setting.step ?? 1);
      slider.value = String(value ?? setting.default ?? min);
      slider.disabled = disabled;

      const output = document.createElement('span');
      output.className = 'reflux-setting-value';
      output.textContent = slider.value;

      slider.addEventListener('input', () => { output.textContent = slider.value; });
      slider.addEventListener('change', () => commit(Number(slider.value)));
      sliderRow.append(slider, output);
      control.appendChild(sliderRow);
    } else if (type === 'component' || type === 'custom') {
      const host = document.createElement('div');
      host.className = 'reflux-setting-custom';
      const render = setting.component || setting.render;

      if (typeof render === 'function') {
        try {
          const result = render.call(setting, {
            value,
            setValue: (nextValue) => commit(nextValue),
            option: setting,
            disabled,
            closePluginSettings: () => {},
          });

          if (result instanceof Node) {
            host.appendChild(result);
          } else if (Array.isArray(result)) {
            for (const child of result) {
              if (child instanceof Node) host.appendChild(child);
            }
          } else if (result != null) {
            const react = window.__reflux?.react;
            if (react?.render) {
              const React = react.React;
              const element = React && react.ErrorBoundary
                ? React.createElement(
                    react.ErrorBoundary,
                    {name: `Custom setting "${label}"`, fallback: null},
                    result,
                  )
                : result;
              react.render(element, host);
            } else {
              const fallback = document.createElement('span');
              fallback.className = 'reflux-setting-fallback';
              fallback.textContent = 'This custom setting requires the React runtime.';
              host.appendChild(fallback);
            }
          }
        } catch (err) {
          console.error(`[Reflux:SettingsUI] Custom setting "${setting.key}" threw:`, err);
          const fallback = document.createElement('span');
          fallback.className = 'reflux-setting-fallback';
          fallback.textContent = 'This custom setting failed to render.';
          host.appendChild(fallback);
        }
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'reflux-setting-fallback';
        fallback.textContent = 'No custom renderer was provided for this setting.';
        host.appendChild(fallback);
      }

      control.appendChild(host);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'reflux-setting-fallback';
      fallback.textContent = `Unsupported setting type: ${type}`;
      control.appendChild(fallback);
    }

    main.appendChild(control);
    row.appendChild(main);
    row.appendChild(error);
    return row;
  }

  // ─── Plugin card component ─────────────────────────────────────────────────
  // Built from Fluxer's own settings/switch layout and CSS variables, so it
  // follows the active Fluxer theme without depending on hashed classes.
  function makePluginCard({ id, icon, name, description, author, version, badge, enabled, onToggle, onRemove, settings = [], settingValues = {}, onSettingChange }) {
    ensureSettingsStyles();

    const card = document.createElement('div');
    card.className = 'reflux-plugin';
    card.dataset.rxId = id;

    const header = document.createElement('div');
    header.className = 'reflux-plugin-header';

    // Left: icon — use plugin-specific icon if available, else generic puzzle
    const iconWrap = document.createElement('div');
    iconWrap.className = 'reflux-plugin-icon';
    iconWrap.innerHTML = renderIcon(icon);

    // Middle: text info
    const info = document.createElement('div');
    info.className = 'reflux-plugin-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'reflux-plugin-name-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'reflux-plugin-name';
    nameEl.textContent = name;
    nameRow.appendChild(nameEl);

    if (badge) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'reflux-plugin-badge';
      badgeEl.textContent = badge;
      nameRow.appendChild(badgeEl);
    }
    info.appendChild(nameRow);

    const meta = [author ? `by ${author}` : '', version ? `v${version}` : ''].filter(Boolean).join(' · ');
    if (meta) {
      const metaEl = document.createElement('div');
      metaEl.className = 'reflux-plugin-meta';
      metaEl.textContent = meta;
      info.appendChild(metaEl);
    }
    if (description) {
      const desc = document.createElement('div');
      desc.className = 'reflux-plugin-description';
      desc.textContent = description;
      info.appendChild(desc);
    }

    header.appendChild(iconWrap);
    header.appendChild(info);

    // Right: enable toggle + remove button (imported plugins only)
    const actions = document.createElement('div');
    actions.className = 'reflux-plugin-actions';

    let pluginEnabled = enabled !== false;

    const enableToggle = makeToggle(pluginEnabled, async (on) => {
      await onToggle(on);
      applyEnabled(on);
    }, { ariaLabel: `${pluginEnabled ? 'Disable' : 'Enable'} ${name}` });

    function applyEnabled(on) {
      pluginEnabled = Boolean(on);
      enableToggle.setAriaLabel(`${pluginEnabled ? 'Disable' : 'Enable'} ${name}`);
      renderSettings();
    }

    actions.appendChild(enableToggle.el);

    if (onRemove) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'reflux-icon-button reflux-icon-button-danger';
      del.title = 'Remove plugin';
      del.setAttribute('aria-label', `Remove ${name}`);
      del.innerHTML = svgEl(SVG_TRASH, 16, 16);
      del.addEventListener('click', onRemove);
      actions.appendChild(del);
    }

    header.appendChild(actions);
    card.appendChild(header);

    const settingSchema = Array.isArray(settings)
      ? settings
      : Object.entries(settings || {}).map(([key, setting]) => ({key, ...setting}));

    const settingsWrap = document.createElement('div');
    settingsWrap.className = 'reflux-plugin-settings';
    card.appendChild(settingsWrap);

    async function changeSetting(setting, value) {
      if (!onSettingChange) return;
      const saved = await onSettingChange(setting, value);
      settingValues[setting.key] = saved === undefined ? value : saved;
      renderSettings();
    }

    function renderSettings() {
      window.__reflux?.react?.unmountWithin?.(settingsWrap);
      settingsWrap.innerHTML = '';

      for (const setting of settingSchema) {
        if (!setting || !setting.key || setting.type === 'hidden') continue;
        if (evaluateSettingFlag(setting.hidden, settingValues)) continue;

        settingsWrap.appendChild(makeSettingRow(
          setting,
          settingValues[setting.key] ?? setting.default,
          (value) => changeSetting(setting, value),
          !pluginEnabled || evaluateSettingFlag(setting.disabled, settingValues),
          settingValues,
        ));
      }

      settingsWrap.style.display = settingsWrap.childElementCount ? '' : 'none';
    }

    renderSettings();
    return card;
  }

  /**
   * Builds a switch that matches Fluxer's FormSwitch component, optionally
   * including the label/description layout used by native settings rows.
   * Returns the wrapper plus small helpers for syncing state from outside.
   */
  function makeToggle(initialChecked, onChange, { label = '', description = '', disabled = false, ariaLabel = '' } = {}) {
    let checked = Boolean(initialChecked);
    let disabledByOwner = Boolean(disabled);
    let busy = false;

    const wrap = document.createElement('div');
    wrap.className = label ? 'reflux-switch-row' : 'reflux-switch-inline';
    wrap.dataset.flx = 'ui.form.switch.container';

    let labelContainer = null;
    if (label) {
      labelContainer = document.createElement('label');
      labelContainer.className = 'reflux-switch-label-container';
      labelContainer.dataset.flx = 'ui.form.switch.label-container';

      const labelEl = document.createElement('span');
      labelEl.className = 'reflux-switch-label';
      labelEl.dataset.flx = 'ui.form.switch.label';
      labelEl.textContent = label;
      labelContainer.appendChild(labelEl);

      if (description) {
        const descEl = document.createElement('span');
        descEl.className = 'reflux-switch-description';
        descEl.dataset.flx = 'ui.form.switch.description';
        descEl.textContent = description;
        labelContainer.appendChild(descEl);
      }

      wrap.appendChild(labelContainer);
    }

    const root = document.createElement('button');
    root.type = 'button';
    root.id = uid();
    root.className = 'reflux-switch-root';
    root.setAttribute('role', 'switch');
    root.dataset.flx = 'ui.form.switch.switch-root';
    if (labelContainer) labelContainer.htmlFor = root.id;
    else if (ariaLabel) root.setAttribute('aria-label', ariaLabel);

    const thumb = document.createElement('span');
    thumb.className = 'reflux-switch-thumb';
    thumb.dataset.flx = 'ui.form.switch.switch-thumb';
    root.appendChild(thumb);
    wrap.appendChild(root);

    const applyState = (on) => {
      checked = Boolean(on);
      const state = checked ? 'checked' : 'unchecked';
      root.setAttribute('aria-checked', String(checked));
      root.dataset.state = state;
      thumb.dataset.state = state;
      thumb.innerHTML = checked
        ? switchIcon(SVG_CHECK, 'reflux-switch-icon-checked', 12)
        : switchIcon(SVG_X, 'reflux-switch-icon-unchecked', 10);
    };

    const syncDisabled = () => {
      root.disabled = disabledByOwner || busy;
      if (labelContainer) labelContainer.style.cursor = root.disabled ? 'not-allowed' : 'pointer';
    };

    applyState(checked);
    syncDisabled();

    root.addEventListener('click', async () => {
      if (disabledByOwner || busy) return;

      const next = !checked;
      applyState(next);
      busy = true;
      syncDisabled();
      try {
        await onChange(next);
      } catch {
        applyState(!next);
      } finally {
        busy = false;
        syncDisabled();
      }
    });

    return {
      el: wrap,
      setChecked: applyState,
      setDisabled: (value) => { disabledByOwner = Boolean(value); syncDisabled(); },
      setAriaLabel: (value) => { if (!labelContainer) root.setAttribute('aria-label', value); },
    };
  }

  // ─── Subsection builder ───────────────────────────────────────────────────
  function makeSubsection(c, title, description) {
    const sec = document.createElement('div');
    sec.className = c.subsection;
    // Reflux owns this panel; don't draw section dividers between its sections.
    sec.style.borderTop = 'none';

    const hdr = document.createElement('div');
    hdr.className = c.subsectionHeader;
    hdr.dataset.flx = 'app.settings-section.section-header';

    const titleRow = document.createElement('div');
    titleRow.className = c.subsectionTitleRow;
    titleRow.dataset.flx = 'app.settings-section.section-title-row';

    const titleEl = document.createElement('h3');
    titleEl.className = c.subsectionTitle;
    titleEl.dataset.flx = 'app.settings-section.section-title';
    titleEl.textContent = title;
    titleRow.appendChild(titleEl);
    hdr.appendChild(titleRow);

    if (description) {
      const descEl = document.createElement('p');
      descEl.className = c.subsectionDesc;
      descEl.dataset.flx = 'app.settings-section.section-description';
      descEl.textContent = description;
      hdr.appendChild(descEl);
    }

    const content = document.createElement('div');
    content.className = c.subsectionContent;
    content.dataset.flx = 'app.settings-section.section-content';

    sec.appendChild(hdr);
    sec.appendChild(content);
    return { sec, content };
  }

  async function preparePluginSettings(pluginName, mainSchema) {
    let store = null;
    try {
      store = window.__reflux?.settings?.createStore?.(pluginName, mainSchema) ?? null;
      if (store?.ready) await store.ready;
    } catch (err) {
      console.warn(`[Reflux:SettingsUI] Could not create settings store for "${pluginName}":`, err);
    }

    if (store) {
      return {
        store,
        schema: Object.values(store.def),
        values: {...store.plain},
      };
    }

    const values = {};
    for (const setting of mainSchema || []) {
      if (!setting?.key) continue;
      try {
        values[setting.key] = await window.refluxBridge?.getSetting(
          `plugins.${pluginName}.${setting.key}`,
          setting.default,
        );
      } catch {
        values[setting.key] = setting.default;
      }
    }
    return {store: null, schema: mainSchema || [], values};
  }

  function makeSettingChangeHandler(pluginName, store) {
    return async (setting, value) => {
      if (store) return await store.set(setting.key, value);

      const key = `plugins.${pluginName}.${setting.key}`;
      await window.refluxBridge?.setSetting(key, value);
      window.__reflux?.events?.emit?.('setting-changed', key, value);
      window.dispatchEvent(new CustomEvent('reflux:setting-changed', {detail: {key, value}}));
      return value;
    };
  }

  // ─── Full page builder ────────────────────────────────────────────────────
  async function buildPluginsPage(c) {
    ensureSettingsStyles();

    const page = document.createElement('div');
    page.className = c.desktopContent;
    page.setAttribute('role', 'region');
    page.setAttribute('aria-labelledby', 'reflux-tab-plugins');
    page.dataset.flx = 'app.settings-modal-layout.settings-modal-desktop-content-component.desktop-content';
    page.id = 'reflux-tabpanel-plugins';

    page.innerHTML = `
      <div class="${c.desktopContentPad}">
        <div class="${c.desktopContentCard}">
          <div class="${c.desktopHeader}" style="transition-duration:200ms;">
            <div class="${c.titleContent}" style="opacity:1;">
              <h1 class="${c.title}">Plugins</h1>
            </div>
            <button type="button" class="${c.closeButton}" aria-label="Close" data-flx="app.settings-modal-header.button.close">
              <svg class="${c.closeIcon}" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"></path></svg>
            </button>
          </div>
          <div role="group" class="${c.scrollerWrap}">
            <div class="${c.scroller}" dir="ltr" data-fluxer-scroll-container="true" data-settings-scroll-container="true" style="overflow:hidden auto;">
              <div class="${c.scrollerChildren}">
                <div class="${c.spacerTop}"></div>
                <div class="${c.scrollInner}">
                  <div class="${c.tabContainer}" id="rx-tab-inner"></div>
                </div>
                <div class="${c.spacerBot}"></div>
              </div>
            </div>
            <div class="${c.scrollTrack}" role="presentation" style="pointer-events:none;">
              <div class="${c.scrollTrackThumb}" data-scroller-thumb="true" role="presentation" style="height:0"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const inner = page.querySelector('#rx-tab-inner');

    // ── Import subsection ─────────────────────────────────────────────────
    const { sec: impSec, content: impContent } = makeSubsection(
      c, 'Import Plugin',
      'Load a .js plugin file from your computer. The plugin runs immediately and on every future launch.',
    );
    inner.appendChild(impSec);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.js';
    fileInput.style.display = 'none';
    impContent.appendChild(fileInput);

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'reflux-button reflux-button-primary';
    importBtn.innerHTML = svgEl(SVG_UPLOAD, 16, 16) + '<span>Import Plugin</span>';
    importBtn.addEventListener('click', () => fileInput.click());
    impContent.appendChild(importBtn);

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const source = ev.target.result;
        const meta   = parseMetadata(source, file.name);
        const plugin = { id: uid(), ...meta, enabled: true, source };
        const all    = await getImported();
        all.push(plugin);
        await saveImported(all);
        startImportedPlugin(plugin);
        await renderPlugins();
      };
      reader.readAsText(file);
      fileInput.value = '';
    });

    // ── Installed Plugins subsection ─────────────────────────────────────
    const { sec: instSec, content: instContent } = makeSubsection(
      c, 'Installed Plugins',
      'Toggle plugins on or off. Changes take effect immediately.',
    );
    inner.appendChild(instSec);

    async function renderPlugins() {
      instContent.innerHTML = '';

      const list = document.createElement('div');
      list.className = 'reflux-plugins-list';

      // Built-ins from main process
      let builtins = [];
      try {
        builtins = (await window.refluxBridge?.listPlugins() ?? [])
          .filter(p => p.name !== 'settingsUI');
      } catch { /* ignore */ }

      for (const p of builtins) {
        const {store, schema, values} = await preparePluginSettings(p.name, p.settings || []);

        const card = makePluginCard({
          id:          'rx-' + p.name,
          icon:        p.icon || null,
          name:        p.displayName || p.name,
          description: p.description || '',
          badge:       'Built-in',
          enabled:     p.enabled ?? true,
          settings:    schema,
          settingValues: values,
          onSettingChange: makeSettingChangeHandler(p.name, store),
          onToggle: async (on) => {
            try {
              if (on) await window.refluxBridge?.enablePlugin(p.name);
              else    await window.refluxBridge?.disablePlugin(p.name);
            } catch (e) { console.error(e); throw e; }
          },
        });
        list.appendChild(card);
      }

      // Imported plugins
      const imported = await getImported();
      for (const p of imported) {
        const importedSchema = window.__reflux?.settings?.getSchema?.(p.name) ?? [];
        const prepared = importedSchema.length
          ? await preparePluginSettings(p.name, importedSchema)
          : {store: null, schema: [], values: {}};

        const card = makePluginCard({
          id:          'rx-imp-' + p.id,
          icon:        p.icon || null,
          name:        p.name,
          description: p.description || '',
          author:      p.author || '',
          version:     p.version || '',
          badge:       'Imported',
          enabled:     p.enabled !== false,
          settings:    prepared.schema,
          settingValues: prepared.values,
          onSettingChange: makeSettingChangeHandler(p.name, prepared.store),
          onToggle: async (on) => {
            const all = await getImported();
            const t = all.find(x => x.id === p.id);
            if (!t) return;
            if (on) startImportedPlugin(t);
            else stopImportedPlugin(t.id);
            t.enabled = on;
            await saveImported(all);
          },
          onRemove: async () => {
            const all = await getImported();
            const idx = all.findIndex(x => x.id === p.id);
            if (idx !== -1) {
              stopImportedPlugin(p.id);
              all.splice(idx, 1);
              await saveImported(all);
              renderPlugins();
            }
          },
        });
        list.appendChild(card);
      }

      if (list.hasChildNodes()) {
        instContent.appendChild(list);
      } else {
        const empty = document.createElement('p');
        empty.className = 'reflux-empty-state';
        empty.textContent = 'No plugins installed. Import a .js file above.';
        instContent.appendChild(empty);
      }
    }

    await renderPlugins();

    return page;
  }

  // ─── Overlay management ───────────────────────────────────────────────────
  let _ourPanel  = null;
  let _realPanel = null;
  let _cleanupFn = null;

  async function showRefluxPanel(sc) {
    // Discover structural classes; retry once if DOM not fully settled
    let c = discoverClasses();
    if (!c || !c.desktopContentPad) {
      await new Promise(r => setTimeout(r, 200));
      c = discoverClasses();
      if (!c) return;
    }
    Object.assign(c, sc);

    _realPanel = findSettingsContent();
    if (!_realPanel) return;

    // Remove any stale panel from a previous open
    document.getElementById('reflux-tabpanel-plugins')?.remove();

    _ourPanel = await buildPluginsPage(c);

    const nativeClose = _realPanel.querySelector('[data-flx="app.settings-modal-header.button.close"]');
    const replacementClose = _ourPanel.querySelector('[data-flx="app.settings-modal-header.button.close"]');
    replacementClose?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideRefluxPanel();
      nativeClose?.click();
    });

    _realPanel.insertAdjacentElement('afterend', _ourPanel);
    _realPanel.style.display = 'none';

    // Drop the listener from a previous Reflux panel before clicking any
    // native tab below, otherwise that click would immediately close us.
    if (_cleanupFn) { _cleanupFn(); _cleanupFn = null; }

    // Collapse the previously-selected expandable category, then suppress its
    // highlight while our panel is active.
    collapseNativeSidebarSections();
    injectActiveStyle();

    // Restore when any native Fluxer tab is clicked
    const handler = (e) => {
      const tab = e.target.closest('[role="treeitem"], [role="tab"]');
      if (tab && tab.id !== 'reflux-tab-plugins') hideRefluxPanel();
    };
    document.addEventListener('click', handler, true);
    _cleanupFn = () => document.removeEventListener('click', handler, true);

    // Keep keyboard focus on the Reflux item instead of the native tab we
    // just clicked to collapse its submenu.
    requestAnimationFrame(() => {
      document.getElementById('reflux-tab-plugins')?.focus({preventScroll: true});
    });
  }

  function hideRefluxPanel() {
    removeActiveStyle();
    if (_realPanel)  { _realPanel.style.display = ''; _realPanel = null; }
    if (_ourPanel)   {
      window.__reflux?.react?.unmountWithin?.(_ourPanel);
      _ourPanel.remove();
      _ourPanel = null;
    }
    if (_cleanupFn)  { _cleanupFn(); _cleanupFn = null; }
    document.getElementById('reflux-tab-plugins')?.setAttribute('aria-selected', 'false');
    document.getElementById('reflux-tab-plugins')?.setAttribute('tabindex', '-1');
  }

  // ─── Sidebar injection ────────────────────────────────────────────────────
  function findDeveloperSection() {
    for (const s of document.querySelectorAll(
      '[data-flx="app.settings-modal-layout.settings-modal-sidebar-category.sidebar-category"], ' +
      '[class*="sidebarCategory"]',
    )) {
      if (s.querySelector('h2')?.textContent.trim() === 'Developer') return s;
    }
    return null;
  }

  function buildSidebarSection(sc) {
    const section = document.createElement('section');
    section.id = 'reflux-sidebar-section';
    section.className = sc.cat;
    section.dataset.flx = 'app.settings-modal-layout.settings-modal-sidebar-category.sidebar-category';
    section.setAttribute('aria-labelledby', 'reflux-sidebar-heading');

    const h2 = document.createElement('h2');
    h2.id = 'reflux-sidebar-heading';
    h2.className = sc.catTitle;
    h2.dataset.flx = 'app.settings-modal-layout.settings-modal-sidebar-category-title.sidebar-category-title';
    h2.textContent = 'Reflux';
    section.appendChild(h2);

    const btn = document.createElement('button');
    btn.id = 'reflux-tab-plugins';
    btn.type = 'button';
    btn.className = sc.item;
    btn.setAttribute('role', 'treeitem');
    btn.setAttribute('data-settings-sidebar-item', 'true');
    btn.setAttribute('data-settings-tab', 'true');
    btn.setAttribute('aria-level', '1');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('tabindex', '-1');
    btn.setAttribute('aria-controls', 'reflux-tabpanel-plugins');
    btn.dataset.flx = 'app.settings-modal-layout.settings-modal-sidebar-item.button';

    const iconWrap = document.createElement('span');
    iconWrap.innerHTML = svgEl(SVG_PLUG);
    const svgE = iconWrap.firstElementChild;
    if (svgE) svgE.setAttribute('class', sc.itemIcon);

    const ver = window.refluxBridge?.version;

    const labelSpan = document.createElement('span');
    labelSpan.className = sc.itemLabel;
    labelSpan.innerHTML = `<div class="${sc.tabLabel}"><span>Plugins</span></div>`;

    btn.appendChild(svgE || iconWrap);
    btn.appendChild(labelSpan);

    const verSpan = document.createElement('span');
    verSpan.id = 'reflux-version-badge';
    verSpan.textContent = `Reflux${ver ? ` (${ver})` : ''}`;
    verSpan.style.cssText = [
      'font-size:10px', 'font-weight:600',
      'color:var(--text-muted,#949ba4)',
      'padding:1px 5px', 'border-radius:3px',
      'background:var(--background-tertiary,#2b2d31)',
      'white-space:nowrap', 'flex-shrink:0',
    ].join(';');
    btn.appendChild(verSpan);

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      btn.setAttribute('aria-selected', 'true');
      btn.setAttribute('tabindex', '0');
      await showRefluxPanel(sc);
    });

    section.appendChild(btn);
    return section;
  }

  function inject(devSection) {
    if (document.getElementById('reflux-sidebar-section')) return;
    const sc = discoverSidebarClasses(devSection);
    devSection.parentNode.insertBefore(buildSidebarSection(sc), devSection);
    console.log('[Reflux:SettingsUI] Sidebar injected.');
  }

  // ─── MutationObserver ─────────────────────────────────────────────────────
  let _timer = null;
  function tryInject() {
    const dev = findDeveloperSection();
    if (dev) inject(dev);
  }

  tryInject();

  const observer = new MutationObserver(() => {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = null; tryInject(); }, 100);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  window.__reflux?.pluginManager?.register?.({
    name: 'settingsUI',
    start() {},
    stop() {
      observer.disconnect();
      clearTimeout(_timer);
      hideRefluxPanel();
      document.getElementById('reflux-sidebar-section')?.remove();
      removeActiveStyle();
      removeSettingsStyles();
      window.__reflux_settingsUI_loaded = false;
    },
  });

  console.log('[Reflux:SettingsUI] Ready.');
})();

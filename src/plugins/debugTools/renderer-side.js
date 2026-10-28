(function refluxDebugTools() {
  'use strict';

  if (window.__reflux_debugTools_loaded) return;
  window.__reflux_debugTools_loaded = true;

  const TAG = '[Reflux:DebugTools]';
  const MAX_ENTRIES = 500;
  const entries = [];
  let paused = false;
  let includeContent = false;
  let textarea = null;
  let countLabel = null;
  let panel = null;
  let launcher = null;

  function stringify(value) {
    return JSON.stringify(value, null, 2);
  }

  function pushEntry(entry) {
    if (paused) return;
    entries.push({at: new Date().toISOString(), ...entry});
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    renderLog();
  }

  function summarizeGateway(payload) {
    const data = payload?.d;
    const summary = {
      kind: 'gateway',
      op: payload?.op,
      event: payload?.t || null,
      sequence: payload?.s ?? null,
      dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    };

    if (data && typeof data === 'object') {
      for (const key of ['id', 'guild_id', 'channel_id', 'user_id', 'message_id', 'name']) {
        if (data[key] !== undefined) summary[key] = data[key];
      }

      if (Array.isArray(data.emojis)) {
        summary.emojis = data.emojis.map(emoji => ({
          id: emoji?.id ?? null,
          name: emoji?.name ?? null,
          animated: Boolean(emoji?.animated),
          available: emoji?.available,
          guild_id: emoji?.guild_id ?? data.guild_id ?? data.id ?? null,
        }));
      }

      if (includeContent && typeof data.content === 'string') {
        summary.content = data.content;
      }
    }

    return summary;
  }

  function inspectParsedValue(value) {
    if (!value || typeof value !== 'object') return;
    const payloads = Array.isArray(value) ? value : [value];

    for (const payload of payloads) {
      if (!payload || typeof payload !== 'object' || typeof payload.t !== 'string') continue;
      pushEntry(summarizeGateway(payload));
    }
  }

  function renderLog() {
    if (!textarea) return;
    textarea.value = entries.map(stringify).join('\n\n');
    textarea.scrollTop = textarea.scrollHeight;
    if (countLabel) countLabel.textContent = `${entries.length}/${MAX_ENTRIES}`;
  }

  function button(label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.cssText = [
      'border:0', 'border-radius:4px', 'padding:5px 8px', 'cursor:pointer', 'z-index:2147483646',
      '-webkit-app-region:no-drag',
      'background:var(--background-modifier-accent,#4e5058)',
      'color:var(--text-normal,#dbdee1)', 'font-size:12px',
    ].join(';');
    element.addEventListener('click', onClick);
    return element;
  }

  function setPanelOpen(open) {
    if (!panel) return;
    panel.hidden = !open;
    panel.style.display = open ? 'flex' : 'none';
    if (launcher) {
      launcher.hidden = Boolean(open);
      launcher.style.display = open ? 'none' : '';
    }
  }

  function buildPanel() {
    panel = document.createElement('section');
    panel.id = 'reflux-debug-tools-panel';
    panel.hidden = true;
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483646',
      '-webkit-app-region:no-drag',
      'width:min(720px,calc(100vw - 32px))', 'height:min(520px,calc(100vh - 32px))',
      'display:none', 'flex-direction:column', 'gap:8px', 'padding:12px',
      'box-sizing:border-box', 'border:1px solid var(--background-modifier-accent,#4e5058)',
      'border-radius:8px', 'background:var(--background-secondary,#313338)',
      'box-shadow:0 8px 32px rgba(0,0,0,.45)', 'color:var(--text-normal,#dbdee1)',
      'font-family:var(--font-primary, sans-serif)',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const title = document.createElement('strong');
    title.textContent = 'Reflux Gateway Debug';
    title.style.flex = '1';
    countLabel = document.createElement('span');
    countLabel.style.cssText = 'font-size:11px;color:var(--text-muted,#949ba4);';
    header.append(title, countLabel, button('Close', () => setPanelOpen(false)));

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    controls.append(
      button('Copy log', async () => {
        try {
          await navigator.clipboard.writeText(textarea.value);
          title.textContent = 'Copied gateway log';
          setTimeout(() => { title.textContent = 'Reflux Gateway Debug'; }, 1200);
        } catch { textarea.select(); document.execCommand('copy'); }
      }),
      button('Clear', () => { entries.length = 0; renderLog(); }),
      button('Pause', event => {
        paused = !paused;
        event.currentTarget.textContent = paused ? 'Resume' : 'Pause';
      }),
    );

    const contentLabel = document.createElement('label');
    contentLabel.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;';
    const contentCheckbox = document.createElement('input');
    contentCheckbox.type = 'checkbox';
    contentCheckbox.addEventListener('change', () => { includeContent = contentCheckbox.checked; });
    contentLabel.append(contentCheckbox, document.createTextNode('Include message content'));
    controls.appendChild(contentLabel);

    textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'Reflux gateway debug log');
    textarea.style.cssText = [
      'flex:1', 'min-height:0', 'width:100%', 'resize:none', 'box-sizing:border-box',
      'padding:8px', 'border:1px solid var(--background-modifier-accent,#4e5058)',
      'border-radius:4px', 'background:var(--background-tertiary,#2b2d31)',
      'color:var(--text-normal,#dbdee1)', 'font:12px/1.4 ui-monospace,monospace',
    ].join(';');

    const hint = document.createElement('div');
    hint.textContent = 'Logs gateway event names, IDs, keys, and emoji metadata. Content is redacted by default.';
    hint.style.cssText = 'font-size:11px;color:var(--text-muted,#949ba4);';
    panel.append(header, controls, textarea, hint);
    document.body.appendChild(panel);
  }

  function buildLauncher() {
    launcher = button('DBG', () => setPanelOpen(panel.hidden));
    launcher.id = 'reflux-debug-tools-launcher';
    launcher.title = 'Open Reflux Gateway Debug';
    launcher.style.cssText += [
      'position:fixed', 'right:12px', 'top:50%', 'transform:translateY(-50%)',
      'z-index:2147483645', 'padding:8px 7px', 'border-radius:8px',
      '-webkit-app-region:no-drag', 'pointer-events:auto', 'user-select:none',
      'font-weight:700', 'letter-spacing:.4px', 'box-shadow:0 4px 14px rgba(0,0,0,.35)',
    ].join(';');
    document.body.appendChild(launcher);
  }

  buildPanel();
  buildLauncher();

  const unpatchJSONParse = window.__reflux?.patcher?.instead?.(
    JSON,
    'parse',
    (args, original) => {
      const result = original(...args);
      try { inspectParsedValue(result); } catch (error) { console.warn(TAG, error); }
      return result;
    },
  ) ?? (() => {});

  window.__refluxDebugTools = {
    getLogs: () => entries.map(entry => ({...entry})),
    clear: () => { entries.length = 0; renderLog(); },
    setPaused: value => { paused = Boolean(value); },
  };

  window.__reflux?.pluginManager?.register?.({
    name: 'debugTools',
    start() {},
    stop() {
      unpatchJSONParse();
      panel?.remove();
      launcher?.remove();
      delete window.__refluxDebugTools;
      window.__reflux_debugTools_loaded = false;
    },
  });

  console.log(TAG, 'Loaded. Open the DBG button to view gateway summaries.');
})();
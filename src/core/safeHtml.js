/**
 * src/core/safeHtml.js
 *
 * Allowlist-based HTML sanitizer shared by the Reflux renderer and plugins.
 *
 * The module is injected into the web context before renderer.js (see
 * src/main-inject.mjs) and exposed as `window.__refluxSafeHtml`.  It is also
 * CommonJS-compatible so the smoke tests can load it in a browser-like
 * environment.
 *
 * Two policies are built in:
 *   - `message` (default): the subset of HTML Fluxer uses for message content.
 *   - `icon`: inline SVG icons, with scripting and external references removed.
 *
 * Callers can extend either policy with `allowedTags` / `allowedAttributes`,
 * or switch to an explicit allowlist with `tags` / `attributes`.
 */

(function refluxSafeHtmlModule(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.__refluxSafeHtml = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function refluxSafeHtmlFactory() {
  'use strict';

  const MESSAGE_TAGS = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
    'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
    'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike',
    'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u',
    'ul', 'var', 'wbr',
  ]);

  const MESSAGE_ATTRIBUTES = new Set(['class', 'style', 'title', 'dir', 'lang', 'role']);

  const MESSAGE_TAG_ATTRIBUTES = {
    a: new Set(['href', 'rel', 'target']),
    abbr: new Set(['title']),
    details: new Set(['open']),
    img: new Set(['src', 'srcset', 'alt', 'width', 'height', 'loading', 'decoding']),
    ol: new Set(['start', 'reversed', 'type']),
    td: new Set(['colspan', 'rowspan']),
    th: new Set(['colspan', 'rowspan', 'scope']),
    time: new Set(['datetime']),
  };

  const ICON_TAGS = new Set([
    'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs',
    'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'symbol', 'use', 'title', 'desc',
  ]);

  const ICON_ATTRIBUTES = new Set([
    'xmlns', 'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity',
    'transform', 'class', 'style', 'aria-hidden', 'role', 'focusable', 'id',
  ]);

  const ICON_TAG_ATTRIBUTES = {
    circle: new Set(['cx', 'cy', 'r']),
    clippath: new Set(['clippathunits']),
    ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
    line: new Set(['x1', 'x2', 'y1', 'y2']),
    lineargradient: new Set(['x1', 'x2', 'y1', 'y2', 'gradientunits', 'gradienttransform']),
    mask: new Set(['maskunits', 'maskcontentunits', 'x', 'y', 'width', 'height']),
    path: new Set(['d']),
    polygon: new Set(['points']),
    polyline: new Set(['points']),
    radialgradient: new Set(['cx', 'cy', 'r', 'fx', 'fy', 'gradientunits', 'gradienttransform']),
    rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
    stop: new Set(['offset', 'stop-color', 'stop-opacity']),
    svg: new Set(['version', 'preserveaspectratio']),
    symbol: new Set(['viewbox', 'preserveaspectratio']),
    use: new Set(['href', 'xlink:href', 'x', 'y', 'width', 'height']),
  };

  const BLOCKED_TAGS = new Set([
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
    'button', 'textarea', 'select', 'option', 'optgroup', 'link', 'meta', 'base', 'template', 'portal',
    'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set',
  ]);

  const MESSAGE_STYLE_PROPERTIES = new Set([
    'color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-color',
    'text-decoration-line', 'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'opacity',
  ]);

  const ICON_STYLE_PROPERTIES = new Set([
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'display',
    'visibility', 'clip-path', 'mask',
  ]);

  const SVG_REFERENCE_ATTRIBUTES = new Set(['clip-path', 'mask', 'filter', 'fill', 'stroke']);
  const SVG_NUMBER_ATTRIBUTES = new Set([
    'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
    'stroke-width', 'stroke-dashoffset', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity',
    'offset',
  ]);
  const URL_ATTRIBUTES = new Set(['href', 'src', 'poster', 'xlink:href']);
  const BLOCKED_ATTRIBUTES = new Set([
    'action', 'formaction', 'srcdoc', 'contenteditable', 'tabindex', 'autofocus', 'http-equiv',
  ]);
  const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'blob:']);
  const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);/i;
  const SAFE_SVG_REFERENCE = /^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i;
  const SAFE_SVG_ID = /^[\w:.-]+$/;

  const BASE_POLICIES = {
    message: {
      profile: 'message',
      tags: MESSAGE_TAGS,
      attributes: MESSAGE_ATTRIBUTES,
      tagAttributes: MESSAGE_TAG_ATTRIBUTES,
      styleProperties: MESSAGE_STYLE_PROPERTIES,
      allowDataImages: true,
    },
    icon: {
      profile: 'icon',
      tags: ICON_TAGS,
      attributes: ICON_ATTRIBUTES,
      tagAttributes: ICON_TAG_ATTRIBUTES,
      styleProperties: ICON_STYLE_PROPERTIES,
      allowDataImages: false,
    },
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  function buildPolicy(options = {}) {
    const base = BASE_POLICIES[options.profile === 'icon' ? 'icon' : 'message'];
    const tags = options.tags ? new Set(options.tags) : new Set(base.tags);
    if (Array.isArray(options.allowedTags)) {
      for (const tag of options.allowedTags) tags.add(String(tag).toLowerCase());
    }
    const attributes = options.attributes ? new Set(options.attributes) : new Set(base.attributes);
    if (Array.isArray(options.allowedAttributes)) {
      for (const attribute of options.allowedAttributes) attributes.add(String(attribute).toLowerCase());
    }
    const policy = {
      profile: base.profile,
      tags,
      attributes,
      tagAttributes: base.tagAttributes,
      styleProperties: base.styleProperties,
      allowDataImages: options.allowDataImages ?? base.allowDataImages,
    };

    if (options.tagAttributes && typeof options.tagAttributes === 'object') {
      policy.tagAttributes = {...base.tagAttributes};
      for (const [tag, values] of Object.entries(options.tagAttributes)) {
        if (!Array.isArray(values)) continue;
        policy.tagAttributes[String(tag).toLowerCase()] = new Set(values.map((value) => String(value).toLowerCase()));
      }
    }
    return policy;
  }

  function normaliseUrl(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0020\u007f]+/g, '')
      .trim();
  }

  function isSafeUrl(value, kind, policy) {
    const url = normaliseUrl(value);
    if (!url) return false;
    if (url.startsWith('#')) return kind === 'link';
    if (url.startsWith('//')) return false;

    const match = url.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!match) return true;
    const scheme = `${match[1].toLowerCase()}:`;
    if (scheme === 'data:') {
      return policy.allowDataImages && kind === 'resource' && SAFE_DATA_IMAGE.test(url);
    }
    if (scheme === 'blob:') return kind === 'resource';
    if (scheme === 'mailto:' || scheme === 'tel:') return kind === 'link';
    return scheme === 'http:' || scheme === 'https:';
  }

  function isSafeSvgReference(value) {
    const text = String(value ?? '').trim();
    return SAFE_SVG_REFERENCE.test(text) || /^(?:none|currentColor|transparent|inherit)$/i.test(text) ||
      /^#[0-9a-f]{3,8}$/i.test(text) || /^(?:rgb|rgba|hsl|hsla)\([^<>;]*\)$/i.test(text) ||
      /^[a-z-]+$/i.test(text);
  }

  function isSafeCssValue(value, policy) {
    const text = String(value ?? '').trim();
    if (!text || /[<>]/.test(text)) return false;
    if (/expression\s*\(|javascript\s*:|vbscript\s*:|@import|behavior\s*:|-moz-binding/i.test(text)) return false;
    const urls = text.match(/url\s*\([^)]*\)/gi) ?? [];
    if (urls.length !== (text.match(/url\s*\(/gi) ?? []).length) return false;
    for (const url of urls) {
      if (policy.profile !== 'icon' || !SAFE_SVG_REFERENCE.test(url)) return false;
    }
    return true;
  }

  function sanitizeStyle(value, policy) {
    const declarations = [];
    for (const declaration of String(value ?? '').split(';')) {
      const separator = declaration.indexOf(':');
      if (separator === -1) continue;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const propertyValue = declaration.slice(separator + 1).trim();
      if (!property || !propertyValue || !policy.styleProperties.has(property)) continue;
      if (!isSafeCssValue(propertyValue, policy)) continue;
      declarations.push(`${property}: ${propertyValue}`);
    }
    return declarations.length ? declarations.join('; ') : null;
  }

  function parseSrcset(value) {
    const text = String(value ?? '').trim();
    const candidates = [];
    let index = 0;
    while (index < text.length) {
      while (index < text.length && /[\s,]/.test(text[index])) index += 1;
      if (index >= text.length) break;
      const start = index;
      const isDataUrl = text.slice(start, start + 5).toLowerCase() === 'data:';
      while (index < text.length && !/\s/.test(text[index]) && (isDataUrl || text[index] !== ',')) {
        index += 1;
      }
      const url = text.slice(start, index);
      const descriptorStart = index;
      while (index < text.length && text[index] !== ',') index += 1;
      const descriptor = text.slice(descriptorStart, index).trim();
      if (index < text.length) index += 1;
      candidates.push({url, descriptor});
    }
    return candidates;
  }

  function sanitizeSrcset(value, policy) {
    const candidates = [];
    for (const candidate of parseSrcset(value)) {
      if (!candidate.url || !isSafeUrl(candidate.url, 'resource', policy)) continue;
      candidates.push(candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url);
    }
    return candidates.length ? candidates.join(', ') : null;
  }

  function isAttributeAllowed(tag, name, policy) {
    if (name.startsWith('on') || BLOCKED_ATTRIBUTES.has(name)) return false;
    if (name.startsWith('aria-')) return true;
    if (name.startsWith('data-')) return policy.profile === 'message' && !name.startsWith('data-reflux');
    if (policy.attributes.has(name)) return true;
    return Boolean(policy.tagAttributes[tag]?.has(name));
  }

  function sanitizeAttributeValue(tag, name, value, policy) {
    if (name === 'id') return policy.profile === 'icon' && SAFE_SVG_ID.test(value) ? value : null;
    if (name === 'style') return sanitizeStyle(value, policy);
    if (name === 'srcset') return sanitizeSrcset(value, policy);
    if (name === 'xmlns') return value === 'http://www.w3.org/2000/svg' ? value : null;
    if (name === 'href' || name === 'xlink:href') {
      if (policy.profile === 'icon' || tag === 'use') {
        return value.startsWith('#') && SAFE_SVG_ID.test(value.slice(1)) ? value : null;
      }
      return isSafeUrl(value, 'link', policy) ? value : null;
    }
    if (URL_ATTRIBUTES.has(name)) return isSafeUrl(value, 'resource', policy) ? value : null;
    if (policy.profile === 'icon') {
      if (SVG_REFERENCE_ATTRIBUTES.has(name)) return isSafeSvgReference(value) ? value : null;
      if (name === 'd' || name === 'points') return /^[\sMmLlHhVvCcSsQqTtAaZz0-9eE.,+\-]+$/.test(value) ? value : null;
      if (name === 'transform' || name === 'gradienttransform') {
        return /^[\sA-Za-z0-9().,+\-]+$/.test(value) ? value : null;
      }
      if (name === 'viewbox') return /^[\s0-9.,+\-]+$/.test(value) ? value : null;
      if (SVG_NUMBER_ATTRIBUTES.has(name)) return /^[\s0-9.eE%+\-]+$/.test(value) ? value : null;
      if (name === 'stop-color') return isSafeSvgReference(value) ? value : null;
    }
    return value;
  }

  function sanitizeAttributes(element, tag, policy) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!isAttributeAllowed(tag, name, policy)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      const next = sanitizeAttributeValue(tag, name, attribute.value ?? '', policy);
      if (next === null || next === undefined || next === '') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (next !== attribute.value) element.setAttribute(attribute.name, next);
    }

    if (tag === 'a') {
      element.setAttribute('rel', 'noopener noreferrer');
      if (element.getAttribute('target') === '_blank') return;
      element.removeAttribute('target');
    }
  }

  function sanitizeChildren(parent, policy) {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) continue;
      if (node.nodeType !== 1) {
        node.remove();
        continue;
      }

      const tag = node.tagName.toLowerCase();
      if (BLOCKED_TAGS.has(tag)) {
        node.remove();
        continue;
      }

      if (!policy.tags.has(tag)) {
        sanitizeChildren(node, policy);
        const fragment = parent.ownerDocument.createDocumentFragment();
        while (node.firstChild) fragment.appendChild(node.firstChild);
        node.replaceWith(fragment);
        continue;
      }

      sanitizeAttributes(node, tag, policy);
      sanitizeChildren(node, policy);
    }
  }

  function createSanitizer(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      throw new TypeError('safeHtml.createSanitizer() requires a document.');
    }

    function sanitize(input, options = {}) {
      const html = String(input ?? '');
      if (!html) return '';
      const policy = buildPolicy(options);
      const template = documentRef.createElement('template');
      template.innerHTML = html;
      sanitizeChildren(template.content, policy);
      return template.innerHTML;
    }

    function set(element, input, options = {}) {
      if (!element) return null;
      element.innerHTML = sanitize(input, options);
      return element;
    }

    return {
      sanitize,
      set,
      escape: escapeHtml,
      createPolicy: buildPolicy,
      isSafeUrl(value, options = {}) {
        return isSafeUrl(value, options.kind === 'resource' ? 'resource' : 'link', buildPolicy(options));
      },
    };
  }

  function defaultDocument() {
    if (typeof document === 'undefined') return null;
    return document;
  }

  return {
    profiles: Object.freeze({message: 'message', icon: 'icon'}),
    createSanitizer,
    escape: escapeHtml,
    isSafeUrl,
    sanitize(input, options = {}) {
      const documentRef = defaultDocument();
      if (!documentRef) {
        // Node without a DOM: return inert text rather than throwing.
        return escapeHtml(input);
      }
      return createSanitizer(documentRef).sanitize(input, options);
    },
    set(element, input, options = {}) {
      if (!element) return null;
      const documentRef = element.ownerDocument || defaultDocument();
      if (!documentRef) {
        element.textContent = String(input ?? '');
        return element;
      }
      return createSanitizer(documentRef).set(element, input, options);
    },
  };
});

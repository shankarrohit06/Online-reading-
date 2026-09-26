// Ruled lines, extra line spacing and the reading font.
//
// Every "leaf" block of text (a block that holds text but no other text
// blocks) gets the .rp-ruled class plus two custom properties: its line
// height in px (--rp-lh) and where the rule sits inside each line (--rp-off).
// content.css turns those into a notebook-paper gradient behind the text.
//
// Ruled blocks also get room for the pencil: extra space between words and
// lines tall enough that a word enlarged to the chosen pencil size never
// reaches the lines above or below it.
(() => {
  'use strict';
  const RP = (window.__readingPencil ||= {});
  RP.ruler?.disable();

  // Text inside these is left alone: code, form controls, menus and toolbars.
  const SKIP =
    'script,style,noscript,template,textarea,input,select,option,button,pre,code,kbd,samp,svg,math,' +
    'nav,[role="navigation"],[role="button"],[role="menu"],[role="menubar"],[role="toolbar"],' +
    '[role="tablist"],[contenteditable=""],[contenteditable="true"],reading-pencil-overlay';

  const ruled = new Set();
  const roomy = new Set(); // blocks holding other blocks: extra word space only
  const saved = new WeakMap(); // element -> { fs, lh, ch, hadStyle, hadClass }
  let settings = null;
  let styleEl = null;
  let observer = null;
  let pending = new Set();
  let timer = 0;
  let measuredFont = null;

  function blockOf(el) {
    for (; el && el !== document.documentElement; el = el.parentElement) {
      const display = getComputedStyle(el).display;
      if (display === 'none') return null;
      if (!display.startsWith('inline') && display !== 'contents') return el;
    }
    return null;
  }

  function collect(root, blocks, cache) {
    const visit = (text) => {
      if (!/\S/.test(text.data)) return;
      const parent = text.parentElement;
      if (!parent || parent.closest(SKIP)) return;
      let block = cache.get(parent);
      if (block === undefined) cache.set(parent, (block = blockOf(parent)));
      if (block && block !== document.body) blocks.add(block);
    };
    if (root.nodeType === Node.TEXT_NODE) return visit(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) visit(n);
  }

  // Height of the text's content area (ascender to descender) in `el`,
  // which is how tall the pencil's box is before it is scaled.
  function measureTextHeight(el, fallback) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.search(/\S/);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const h = range.getBoundingClientRect().height;
      if (h > 0) return h;
    }
    return fallback;
  }

  function lineBox(el) {
    const { fs, lh, ch } = saved.get(el);
    // A word scaled by s from its middle reaches (s - 1) * ch / 2 above and
    // below its own text. The neighbouring lines' text starts (line height -
    // ch) away, so this line height keeps the enlarged word clear of them.
    const room = (ch * (1 + settings.growScale)) / 2 + 2;
    const target = Math.max(lh, room, settings.lineSpacing ? fs * settings.lineSpacing : 0);
    // Just under the descenders of the text, but never past the line box.
    const off = Math.min(target - 1, target / 2 + fs * 0.66);
    return { lh: target, off: Math.max(0, off) };
  }

  function setLineBox(el) {
    const { lh, off } = lineBox(el);
    el.style.setProperty('--rp-lh', `${lh.toFixed(2)}px`);
    el.style.setProperty('--rp-off', `${off.toFixed(2)}px`);
  }

  function rule(el) {
    setLineBox(el);
    el.classList.add('rp-ruled');
    ruled.add(el);
  }

  // Text height depends on the font, so it is measured with the reading
  // font already applied; reads all come first, then all the writes.
  function measure(els) {
    for (const el of els) {
      const s = saved.get(el);
      s.ch = measureTextHeight(el, s.fs * 1.15);
    }
    els.forEach(setLineBox);
    measuredFont = settings.font;
  }

  function remember(el) {
    if (!saved.has(el)) {
      saved.set(el, { hadStyle: el.hasAttribute('style'), hadClass: el.hasAttribute('class') });
    }
  }

  // Puts the element back exactly as the page had it.
  function unrule(el) {
    const s = saved.get(el);
    el.classList.remove('rp-ruled', 'rp-room');
    roomy.delete(el);
    el.style.removeProperty('--rp-lh');
    el.style.removeProperty('--rp-off');
    if (s && !s.hadStyle && !el.getAttribute('style')) el.removeAttribute('style');
    if (s && !s.hadClass && !el.getAttribute('class')) el.removeAttribute('class');
    ruled.delete(el);
  }

  function applyBlocks(candidates) {
    // Only leaf blocks get rules; a parent's gradient would double up with
    // its children's and drift out of line with them.
    const all = new Set([...candidates, ...ruled]);
    const containers = new Set();
    for (const el of all) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (all.has(a)) containers.add(a);
      }
    }
    for (const el of containers) {
      if (ruled.has(el)) unrule(el);
      if (!roomy.has(el)) {
        remember(el);
        el.classList.add('rp-room');
        roomy.add(el);
      }
    }

    // Read every style first, then write, so layout is computed only once.
    const fresh = [];
    for (const el of candidates) {
      if (containers.has(el) || ruled.has(el)) continue;
      if (roomy.has(el)) unrule(el); // its inner blocks are gone; rule it instead
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== 'none') continue; // don't clobber the page's own backgrounds
      const fs = parseFloat(cs.fontSize);
      const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
      if (!fs || !lh) continue;
      saved.set(el, {
        fs,
        lh,
        ch: fs * 1.15,
        hadStyle: el.hasAttribute('style'),
        hadClass: el.hasAttribute('class'),
      });
      fresh.push(el);
    }
    fresh.forEach(rule);
    measure(fresh);
  }

  function scan(roots) {
    const blocks = new Set();
    const cache = new Map();
    for (const root of roots) if (root.isConnected) collect(root, blocks, cache);
    applyBlocks(blocks);
  }

  function flush() {
    timer = 0;
    for (const el of ruled) if (!el.isConnected) ruled.delete(el);
    for (const el of roomy) if (!el.isConnected) roomy.delete(el);
    const roots = pending;
    pending = new Set();
    scan(roots);
  }

  function onMutations(records) {
    for (const r of records) for (const n of r.addedNodes) pending.add(n);
    if (pending.size && !timer) timer = setTimeout(flush, 300);
  }

  function writeStyle() {
    const color =
      settings.ruleColor === 'auto'
        ? 'color-mix(in srgb, currentColor 24%, transparent)'
        : `color-mix(in srgb, ${settings.ruleColor} 75%, transparent)`;
    let css = `:root { --rp-rule: ${color}; }\n`;
    css += `.rp-ruled, .rp-room { word-spacing: ${RPSettings.wordRoom(settings.growScale)}em !important; }\n`;
    if (!settings.showRules) css += '.rp-ruled { background-image: none !important; }\n';
    const font = RPSettings.FONTS[settings.font];
    if (font) {
      for (const [family, weight, file] of font.faces) {
        css +=
          `@font-face { font-family: '${family}'; font-weight: ${weight}; font-style: normal; ` +
          `font-display: swap; src: url('${chrome.runtime.getURL(file)}') format('woff2'); }\n`;
      }
      css += `.rp-ruled { font-family: ${font.family} !important; }\n`;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'reading-pencil-style';
    }
    styleEl.textContent = css;
    if (!styleEl.isConnected) document.documentElement.appendChild(styleEl);
  }

  // Web fonts can finish loading after the first measurement.
  function onFontsLoaded() {
    if (observer) measure([...ruled]);
  }

  RP.blockOf = blockOf;
  RP.ruler = {
    get active() {
      return !!observer;
    },

    enable(next) {
      settings = next;
      if (observer) return this.update(next);
      writeStyle();
      // A page can limit the lines to one part of it (the practice page does).
      const scope = document.querySelector('[data-rp-scope]') || document.body;
      scan([scope]);
      observer = new MutationObserver(onMutations);
      observer.observe(scope, { childList: true, subtree: true });
      document.fonts.addEventListener('loadingdone', onFontsLoaded);
    },

    update(next) {
      settings = next;
      if (!observer) return;
      writeStyle();
      if (settings.font !== measuredFont) measure([...ruled]);
      else ruled.forEach(setLineBox);
    },

    disable() {
      observer?.disconnect();
      observer = null;
      document.fonts.removeEventListener('loadingdone', onFontsLoaded);
      clearTimeout(timer);
      timer = 0;
      pending.clear();
      for (const el of [...ruled, ...roomy]) unrule(el);
      styleEl?.remove();
      styleEl = null;
    },
  };
})();

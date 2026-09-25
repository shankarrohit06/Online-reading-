// Ruled lines, extra line spacing and the reading font.
//
// Every "leaf" block of text (a block that holds text but no other text
// blocks) gets the .rp-ruled class plus two custom properties: its line
// height in px (--rp-lh) and where the rule sits inside each line (--rp-off).
// content.css turns those into a notebook-paper gradient behind the text.
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
  const saved = new WeakMap(); // element -> { fs, lh, hadStyle, hadClass }
  let settings = null;
  let styleEl = null;
  let observer = null;
  let pending = new Set();
  let timer = 0;

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

  function lineBox(el) {
    const { fs, lh } = saved.get(el);
    const target = settings.lineSpacing ? Math.max(lh, fs * settings.lineSpacing) : lh;
    // Just under the descenders of the text, but never past the line box.
    const off = Math.min(target - 1, target / 2 + fs * 0.66);
    return { lh: target, off: Math.max(0, off) };
  }

  function rule(el) {
    const { lh, off } = lineBox(el);
    el.style.setProperty('--rp-lh', `${lh.toFixed(2)}px`);
    el.style.setProperty('--rp-off', `${off.toFixed(2)}px`);
    el.classList.add('rp-ruled');
    ruled.add(el);
  }

  // Puts the element back exactly as the page had it.
  function unrule(el) {
    const s = saved.get(el);
    el.classList.remove('rp-ruled');
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
    for (const el of containers) if (ruled.has(el)) unrule(el);

    // Read every style first, then write, so layout is computed only once.
    const fresh = [];
    for (const el of candidates) {
      if (containers.has(el) || ruled.has(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== 'none') continue; // don't clobber the page's own backgrounds
      const fs = parseFloat(cs.fontSize);
      const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
      if (!fs || !lh) continue;
      saved.set(el, { fs, lh, hadStyle: el.hasAttribute('style'), hadClass: el.hasAttribute('class') });
      fresh.push(el);
    }
    fresh.forEach(rule);
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

  RP.ruler = {
    get active() {
      return !!observer;
    },

    enable(next) {
      settings = next;
      if (observer) return this.update(next);
      writeStyle();
      scan([document.body]);
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true });
    },

    update(next) {
      settings = next;
      if (!observer) return;
      writeStyle();
      for (const el of ruled) {
        const { lh, off } = lineBox(el);
        el.style.setProperty('--rp-lh', `${lh.toFixed(2)}px`);
        el.style.setProperty('--rp-off', `${off.toFixed(2)}px`);
      }
    },

    disable() {
      observer?.disconnect();
      observer = null;
      clearTimeout(timer);
      timer = 0;
      pending.clear();
      for (const el of [...ruled]) unrule(el);
      styleEl?.remove();
      styleEl = null;
    },
  };
})();

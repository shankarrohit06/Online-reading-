// The "pencil": the word under the mouse (or the word you've stepped to with
// Alt+arrows) pops out slightly larger with a soft highlight.
//
// The page's text is never modified. A single overlay element, positioned over
// the word and scaled up from its center, draws the enlarged copy, so nothing
// around it moves.
(() => {
  'use strict';
  const RP = (window.__readingPencil ||= {});
  RP.pencil?.disable();

  const SKIP =
    'script,style,noscript,template,textarea,input,select,option,' +
    '[contenteditable=""],[contenteditable="true"],reading-pencil-overlay';
  const EDITABLE = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
  const MAX_STEPS = 4000; // cap on words scanned when looking for the next line

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  let settings = null;
  let enabled = false;
  let host = null; // overlay element
  let box = null; // the enlarged word inside it
  let current = null; // { node, start, end }
  let mode = 'mouse'; // who moved the pencil last: 'mouse' | 'keyboard'
  let mouseX = -1;
  let mouseY = -1;
  let mouseDown = false;
  let overEditable = false;
  let goalX = null; // keeps the column steady while moving line to line
  let raf = 0;

  // ---- Finding words -------------------------------------------------------

  function isEditable(el) {
    return !!el && (el.isContentEditable || !!el.closest?.(EDITABLE));
  }

  function readable(text) {
    const parent = text.parentElement;
    return (
      !!parent &&
      /\S/.test(text.data) &&
      !parent.closest(SKIP) &&
      parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = document.caretRangeFromPoint(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }

  // The word in `node` that contains character `offset`, if it is a word
  // (not whitespace or punctuation).
  function wordAt(node, offset) {
    const text = node.data;
    if (offset < 0 || offset >= text.length) return null;
    const from = Math.max(0, offset - 80);
    const seg = segmenter.segment(text.slice(from, offset + 80)).containing(offset - from);
    if (!seg || !seg.isWordLike) return null;
    return { node, start: from + seg.index, end: from + seg.index + seg.segment.length };
  }

  function rangeOf(w) {
    const r = document.createRange();
    r.setStart(w.node, w.start);
    r.setEnd(w.node, w.end);
    return r;
  }

  function rectOf(w) {
    return rangeOf(w).getClientRects()[0] || null;
  }

  function wordAtPoint(x, y) {
    const c = caretAt(x, y);
    if (!c || c.node.nodeType !== Node.TEXT_NODE || !readable(c.node)) return null;
    // The caret lands on the nearest gap between letters, so the word may
    // be on either side of it. Only accept a word that is really under the
    // pointer, not one that is merely nearby.
    for (const offset of [c.offset, c.offset - 1]) {
      const w = wordAt(c.node, offset);
      if (!w) continue;
      for (const r of rangeOf(w).getClientRects()) {
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 3 && y <= r.bottom + 3) return w;
      }
    }
    return null;
  }

  function walkerAt(node) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (readable(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    walker.currentNode = node;
    return walker;
  }

  function firstWordIn(node, from = 0) {
    for (const s of segmenter.segment(node.data.slice(from))) {
      if (s.isWordLike) return { node, start: from + s.index, end: from + s.index + s.segment.length };
    }
    return null;
  }

  function lastWordIn(node, to = node.data.length) {
    let last = null;
    for (const s of segmenter.segment(node.data.slice(0, to))) {
      if (s.isWordLike) last = { node, start: s.index, end: s.index + s.segment.length };
    }
    return last;
  }

  function nextWord(w) {
    const here = firstWordIn(w.node, w.end);
    if (here) return here;
    const walker = walkerAt(w.node);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const found = firstWordIn(n);
      if (found) return found;
    }
    return null;
  }

  function prevWord(w) {
    const here = lastWordIn(w.node, w.start);
    if (here) return here;
    const walker = walkerAt(w.node);
    for (let n = walker.previousNode(); n; n = walker.previousNode()) {
      const found = lastWordIn(n);
      if (found) return found;
    }
    return null;
  }

  function visibleRect(r) {
    return !!r && r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  // Skips words that take up no space (collapsed, clipped, etc.).
  function step(w, dir) {
    for (let i = 0; i < MAX_STEPS; i++) {
      w = dir > 0 ? nextWord(w) : prevWord(w);
      if (!w) return null;
      const r = rectOf(w);
      if (r && r.width > 0) return w;
    }
    return null;
  }

  // Where the keyboard starts when nothing is under the pencil yet: the
  // first word that is on screen.
  function firstVisibleWord() {
    const walker = walkerAt(document.body);
    for (let n = walker.nextNode(), i = 0; n && i < 20000; n = walker.nextNode(), i++) {
      const range = document.createRange();
      range.selectNodeContents(n);
      if (!visibleRect(range.getBoundingClientRect())) continue;
      for (let w = firstWordIn(n); w; w = firstWordIn(n, w.end)) {
        const r = rectOf(w);
        if (visibleRect(r) && r.top >= 0 && r.bottom <= innerHeight) return w;
      }
    }
    return null;
  }

  // The word on the next (dir = 1) or previous (dir = -1) line that sits
  // closest to the column we're reading in. Walks words in reading order, so
  // it follows the text across paragraphs and off-screen content too.
  function wordOnAdjacentLine(from, dir) {
    const r0 = rectOf(from);
    if (!r0) return null;
    if (goalX === null) goalX = r0.left + r0.width / 2;
    let lineY = null;
    let lineH = 0;
    let best = null;
    let bestDist = Infinity;
    let w = from;
    for (let i = 0; i < MAX_STEPS; i++) {
      w = step(w, dir);
      if (!w) break;
      const r = rectOf(w);
      const cy = r.top + r.height / 2;
      if (lineY === null) {
        const onNewLine = dir > 0 ? r.top >= r0.bottom - r0.height / 2 : r.bottom <= r0.top + r0.height / 2;
        if (!onNewLine) continue;
        lineY = cy;
        lineH = r.height;
      } else if (Math.abs(cy - lineY) > Math.max(lineH, r.height) / 2) {
        break; // gone past the target line
      }
      const d = Math.abs(r.left + r.width / 2 - goalX);
      if (d < bestDist) {
        best = w;
        bestDist = d;
      }
    }
    return best;
  }

  // ---- Drawing -------------------------------------------------------------

  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement('reading-pencil-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .w {
          position: fixed; left: 0; top: 0; box-sizing: border-box;
          display: flex; align-items: center; justify-content: center;
          white-space: pre; pointer-events: none; border-radius: 0.22em;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22);
          opacity: 0; transform-origin: 50% 50%;
        }
        /* Fade in only: fading out would briefly double the text. */
        .w.on { opacity: 1; transition: opacity 90ms ease-out; }
        @media (prefers-reduced-motion: reduce) { .w { transition: none; } }
      </style>
      <div class="w"></div>`;
    box = shadow.querySelector('.w');
    document.documentElement.appendChild(host);
  }

  // The first solid background behind an element, so the enlarged word
  // fully covers the original one underneath it.
  function backgroundBehind(el) {
    for (; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const [r, g, b, a = '1'] = m[1].split(/[,/\s]+/).filter(Boolean);
      if (parseFloat(a) > 0.5) return `rgb(${r}, ${g}, ${b})`;
    }
    return '#ffffff';
  }

  function same(a, b) {
    return !!a && !!b && a.node === b.node && a.start === b.start && a.end === b.end;
  }

  function show(w, { animate = true } = {}) {
    const r = rectOf(w);
    if (!r || !r.width) return hide();
    ensureOverlay();
    const changed = !same(w, current) || !box.classList.contains('on');
    current = w;
    const el = w.node.parentElement;
    const cs = getComputedStyle(el);
    const pad = parseFloat(cs.fontSize) * 0.14;
    const scale = settings.growScale;
    const highlight = `color-mix(in srgb, ${settings.highlightColor} 45%, transparent)`;
    box.textContent = w.node.data.slice(w.start, w.end);
    Object.assign(box.style, {
      left: `${r.left - pad}px`,
      top: `${r.top}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height}px`,
      lineHeight: `${r.height}px`,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      fontVariant: cs.fontVariant,
      fontStretch: cs.fontStretch,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      color: cs.color,
      background: `linear-gradient(${highlight}, ${highlight}), ${backgroundBehind(el)}`,
      transform: `scale(${scale})`,
    });
    box.classList.add('on');
    if (animate && changed && !reducedMotion.matches) {
      box.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})` }], {
        duration: 110,
        easing: 'ease-out',
      });
    }
  }

  function hide() {
    current = null;
    box?.classList.remove('on');
  }

  function scrollIntoReach(w) {
    const margin = Math.min(80, innerHeight / 6);
    let r = rectOf(w);
    if (!r) return;
    if (r.top < margin || r.bottom > innerHeight - margin) {
      window.scrollBy({ top: r.top - innerHeight * 0.35, behavior: 'instant' });
      r = rectOf(w);
    }
    if (r && !visibleRect(r)) w.node.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  // ---- Input ---------------------------------------------------------------

  function tick() {
    raf = 0;
    if (!enabled) return;
    if (mode === 'keyboard') {
      if (current?.node.isConnected) show(current, { animate: false });
      else hide();
      return;
    }
    if (mouseDown || overEditable || mouseX < 0) return hide();
    const w = wordAtPoint(mouseX, mouseY);
    if (!w) hide();
    else if (!same(w, current)) show(w);
    else show(w, { animate: false }); // same word, but it may have moved (scroll)
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function onMouseMove(e) {
    // Chrome sends a still "mousemove" after scrolling; don't let that
    // steal the pencil from the keyboard.
    if (mode === 'keyboard' && e.movementX === 0 && e.movementY === 0) return;
    mode = 'mouse';
    goalX = null;
    mouseX = e.clientX;
    mouseY = e.clientY;
    overEditable = isEditable(e.target);
    schedule();
  }

  function onMouseDown() {
    mouseDown = true;
    hide(); // stay out of the way while selecting text
  }

  function onMouseUp() {
    mouseDown = false;
    schedule();
  }

  function onMouseOut(e) {
    if (!e.relatedTarget && mode === 'mouse') {
      mouseX = mouseY = -1;
      hide();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      hide();
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (isEditable(document.activeElement)) return; // Alt+arrows mean something in text fields

    // Always claim the key, or Alt+Left/Right would navigate back/forward.
    e.preventDefault();
    e.stopPropagation();

    const start = current?.node.isConnected ? current : null;
    let next;
    if (!start) {
      next = firstVisibleWord();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      goalX = null;
      next = step(start, e.key === 'ArrowRight' ? 1 : -1);
    } else {
      next = wordOnAdjacentLine(start, e.key === 'ArrowDown' ? 1 : -1);
    }
    if (!next) return;
    mode = 'keyboard';
    scrollIntoReach(next);
    show(next);
  }

  const listeners = [
    [window, 'mousemove', onMouseMove, { passive: true, capture: true }],
    [window, 'mousedown', onMouseDown, { passive: true, capture: true }],
    [window, 'mouseup', onMouseUp, { passive: true, capture: true }],
    [document, 'mouseout', onMouseOut, { passive: true, capture: true }],
    [window, 'keydown', onKeyDown, { capture: true }],
    [document, 'scroll', schedule, { passive: true, capture: true }],
    [window, 'resize', schedule, { passive: true }],
    [window, 'blur', () => (mouseDown = false), { passive: true }],
  ];

  RP.pencil = {
    enable(next) {
      settings = next;
      if (enabled) return;
      enabled = true;
      for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
    },

    update(next) {
      settings = next;
      if (enabled && current) show(current, { animate: false });
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
      cancelAnimationFrame(raf);
      raf = 0;
      current = null;
      goalX = null;
      host?.remove();
      host = box = null;
    },
  };
})();

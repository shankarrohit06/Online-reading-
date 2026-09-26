// Read aloud. Select text and a speaker button appears beside it; click it
// and Chrome's text-to-speech reads from the start of the selection onwards
// through the rest of the page. The pencil follows the voice word by word and
// the sentence being read is tinted. A mini player at the bottom of the page
// pauses, skips sentences, changes speed and stops.
//
// Speech runs in the background worker (chrome.tts) and is sent one sentence
// at a time over a port, so skipping and speed changes are instant and
// Chrome's cut-off on long utterances never kicks in.
(() => {
  'use strict';
  const RP = (window.__readingPencil ||= {});
  RP.reader?.disable();

  // Not read: code, form controls, menus and toolbars, hidden text.
  const SKIP =
    'script,style,noscript,template,textarea,input,select,option,button,pre,code,kbd,samp,svg,math,' +
    'nav,[role="navigation"],[role="button"],[role="menu"],[role="menubar"],[role="toolbar"],' +
    '[role="tablist"],[aria-hidden="true"],reading-pencil-overlay,reading-pencil-reader';
  // Page furniture that reading carries on past, unless it started inside it:
  // sidebars, footers, footnote markers ("[1]"), Wikipedia's "[edit]" links.
  const FURNITURE =
    'aside,footer,[role="complementary"],[role="contentinfo"],sup > a[href^="#"],.mw-editsection';
  const EDITABLE = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
  // Clicking these does something already; a click anywhere else on the text
  // while reading jumps the voice to that word.
  const INTERACTIVE =
    'a,button,input,select,textarea,label,summary,video,audio,[role="button"],[role="link"],' +
    '[contenteditable=""],[contenteditable="true"],[onclick]';
  const HAS_WORD = /[\p{L}\p{N}]/u;
  const CHARS_PER_SECOND = 14; // pace estimate for voices that don't report words

  const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

  let settings = null;
  let enabled = false;
  let spokenWith = null; // rate and voice of the sentence being spoken
  let host = null;
  let ui = null;
  let port = null;
  let pendingRange = null; // the selection the speaker button would read
  let reading = null; // { stream, list, index, playing, lastChar, utter }
  let utterId = 0;
  let timers = [];
  let styleEl = null;
  let followScroll = true; // false once you scroll away while it's reading
  let lastScrollInput = 0; // when you last used the wheel, touch, keys or scrollbar
  let lostSight = false; // the word being read has left the screen since you scrolled

  // ---- What to read --------------------------------------------------------

  function speakable(text, home) {
    const parent = text.parentElement;
    if (!parent || !/\S/.test(text.data) || parent.closest(SKIP)) return false;
    const furniture = parent.closest(FURNITURE);
    if (furniture && furniture !== home) return false;
    return parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  // Runs of text belonging to the same block (paragraph, heading, list
  // item...), in reading order, starting at a given character. Each run keeps
  // where its characters came from so spoken positions map back to the page.
  function* runs(startNode, startOffset) {
    // Starting inside a sidebar or footer reads on through that one.
    const home = startNode.parentElement?.closest(FURNITURE) || null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (speakable(n, home) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    walker.currentNode = startNode;
    const blocks = new Map();
    const blockOf = (n) => {
      const p = n.parentElement;
      if (!blocks.has(p)) blocks.set(p, RP.blockOf?.(p) || p);
      return blocks.get(p);
    };
    let run = null;
    let from = startOffset;
    for (let node = startNode; node; node = walker.nextNode()) {
      const block = blockOf(node);
      if (run && block !== run.block) {
        yield run;
        run = null;
      }
      run ||= { block, text: '', pieces: [] };
      run.pieces.push({ node, from, at: run.text.length });
      // Line breaks in the page's source aren't sentence ends; turn every
      // whitespace character into a plain space (one for one, so positions
      // still line up with the page).
      run.text += node.data.slice(from).replace(/\s/g, ' ');
      from = 0;
    }
    if (run) yield run;
  }

  function* sentences(startNode, startOffset) {
    for (const run of runs(startNode, startOffset)) {
      for (const s of sentenceSegmenter.segment(run.text)) {
        if (!HAS_WORD.test(s.segment)) continue;
        const start = s.index + s.segment.search(/\S/);
        const text = s.segment.trim();
        yield { run, start, end: start + text.length, text };
      }
    }
  }

  // Character `i` of a run, as a position in the page.
  function locate(run, i) {
    let piece = run.pieces[0];
    for (const p of run.pieces) {
      if (p.at <= i) piece = p;
      else break;
    }
    const offset = Math.min(piece.from + (i - piece.at), piece.node.data.length);
    return { node: piece.node, offset };
  }

  // Where reading starts: the first text at or after the selection's start.
  function startOf(range) {
    let node = range.startContainer;
    let offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const at = node.childNodes[offset] || node;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      walker.currentNode = at;
      node = at.nodeType === Node.TEXT_NODE ? at : walker.nextNode();
      offset = 0;
      while (node && !/\S/.test(node.data)) node = walker.nextNode();
    }
    if (!node) return null;
    while (offset < node.data.length && /\s/.test(node.data[offset])) offset++;
    return { node, offset };
  }

  // ---- Speaking ------------------------------------------------------------

  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'rp-tts' });
    port.onMessage.addListener(onEngine);
    port.onDisconnect.addListener(() => {
      port = null;
      if (reading?.playing) pause();
    });
    return port;
  }

  // Sends to the speech engine; false if the extension was updated or
  // reloaded since this page opened (then only a page reload reconnects).
  function send(msg) {
    try {
      connect().postMessage(msg);
      return true;
    } catch (_) {
      port = null;
      return false;
    }
  }

  function sentenceAt(i) {
    while (reading.list.length <= i) {
      const next = reading.stream.next();
      if (next.done) return null;
      reading.list.push(next.value);
    }
    return reading.list[i];
  }

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  // Moves the pencil to character `c` of sentence `s` (or the next word).
  // The page scrolls along unless you've scrolled away to look at something;
  // it picks up again once the word being read is back on screen.
  function follow(s, c) {
    while (c < s.text.length && /\s/.test(s.text[c])) c++;
    reading.lastChar = c;
    const { node, offset } = locate(s.run, s.start + c);
    const { visible } = RP.pencil?.follow(node, offset, { scroll: followScroll }) || {};
    if (followScroll) return;
    if (!visible) lostSight = true;
    else if (lostSight) {
      followScroll = true; // you've scrolled back to it
      renderPlayer();
    }
  }

  // A scroll counts as yours (and the page stops following the voice) only
  // right after you've used the wheel, touch, scrolling keys or the scrollbar;
  // the pencil's own scrolling never does.
  function onScroll() {
    if (pendingRange) hideButton();
    if (reading && followScroll && Date.now() - lastScrollInput < 1000) {
      followScroll = false;
      lostSight = false;
      renderPlayer();
    }
  }

  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']);
  function onScrollInput(e) {
    if (e.type === 'keydown' && (!SCROLL_KEYS.has(e.key) || e.altKey || typing())) return;
    // A mouse press counts only on the page's scrollbar.
    if (
      e.type === 'mousedown' &&
      !(e.target === document.documentElement && e.clientX >= document.documentElement.clientWidth)
    )
      return;
    lastScrollInput = Date.now();
  }

  function backToReading() {
    followScroll = true;
    const s = reading && reading.list[reading.index];
    if (!s) return;
    const { node, offset } = locate(s.run, s.start + reading.lastChar);
    node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    RP.pencil?.follow(node, offset, { scroll: false });
    renderPlayer();
  }

  function tint(s) {
    const range = document.createRange();
    const a = locate(s.run, s.start);
    const b = locate(s.run, s.end);
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    if (window.CSS?.highlights && window.Highlight) CSS.highlights.set('rp-sentence', new Highlight(range));
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'reading-pencil-reader-style';
    }
    styleEl.textContent =
      `::highlight(rp-sentence) { background-color: ` +
      `color-mix(in srgb, ${settings.highlightColor} 22%, transparent); }`;
    if (!styleEl.isConnected) document.documentElement.appendChild(styleEl);
  }

  function untint() {
    if (window.CSS?.highlights) CSS.highlights.delete('rp-sentence');
    styleEl?.remove();
    styleEl = null;
  }

  // Voices that don't report each word: move the pencil at an estimated pace
  // until the sentence ends (or a real word event shows up).
  function estimate(s, from, id) {
    const pace = CHARS_PER_SECOND * settings.speechRate;
    const text = s.text.slice(from);
    const begin = () => {
      if (reading?.utter.id !== id || reading.utter.started) return;
      reading.utter.started = true;
      clearTimers();
      for (const w of wordSegmenter.segment(text)) {
        if (!w.isWordLike || w.index === 0) continue;
        timers.push(
          setTimeout(
            () => {
              if (reading?.utter.id === id && !reading.utter.heard) follow(s, from + w.index);
            },
            (w.index / pace) * 1000,
          ),
        );
      }
    };
    reading.utter.begin = begin;
    timers.push(setTimeout(begin, 400)); // in case the voice never says "start"
  }

  function play(i, from = 0) {
    const s = sentenceAt(i);
    if (!s) return stop(); // end of the page
    clearTimers();
    const id = ++utterId;
    reading.index = i;
    reading.playing = true;
    reading.utter = { id, base: from, heard: false, started: false };
    spokenWith = { rate: settings.speechRate, voice: settings.voiceName };
    tint(s);
    follow(s, from);
    const sent = send({
      type: 'speak',
      id,
      text: s.text.slice(from),
      rate: settings.speechRate,
      voiceName: settings.voiceName,
      lang: document.documentElement.lang || '',
    });
    if (!sent) return pause('Reading Pencil was updated. Reload the page to keep reading.');
    estimate(s, from, id);
    renderPlayer();
  }

  function onEngine(msg) {
    if (!reading || msg.id !== reading.utter?.id) return;
    const s = reading.list[reading.index];
    switch (msg.type) {
      case 'start':
        reading.utter.begin?.();
        break;
      case 'word':
        reading.utter.heard = true;
        clearTimers();
        follow(s, reading.utter.base + msg.charIndex);
        break;
      case 'end':
        play(reading.index + 1);
        break;
      case 'interrupted':
      case 'cancelled':
        pause(); // something else took over Chrome's voice
        break;
      case 'error':
        pause(`Couldn't speak: ${msg.error || 'no voice available'}`);
        break;
    }
  }

  // Starts reading at a page position ({ node, offset } in a text node).
  function start(at) {
    if (!at) return;
    stop();
    getSelection().removeAllRanges();
    hideButton();
    followScroll = true;
    reading = { stream: sentences(at.node, at.offset), list: [], index: 0, playing: false, lastChar: 0 };
    RP.pencil?.setSpeaking(true);
    play(0);
  }

  function pause(message) {
    if (!reading) return;
    utterId++;
    reading.playing = false;
    reading.message = message || '';
    clearTimers();
    if (port) send({ type: 'stop' });
    renderPlayer();
  }

  function resume() {
    if (reading) play(reading.index, reading.lastChar);
  }

  function skip(dir) {
    if (!reading) return;
    play(Math.max(0, reading.index + dir));
  }

  function stop() {
    utterId++;
    clearTimers();
    if (reading && port) send({ type: 'stop' });
    reading = null;
    untint();
    RP.pencil?.setSpeaking(false);
    renderPlayer();
  }

  // ---- Speaker button and mini player --------------------------------------

  const ICONS = {
    speaker:
      '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    prev: '<path d="M6 5h2v14H6zM20 5v14L9 12z"/>',
    next: '<path d="M16 5h2v14h-2zM4 5v14l11-7z"/>',
    play: '<path d="M7 5v14l12-7z"/>',
    pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
    stop:
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round"/>',
    locate:
      '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  function ensureUI() {
    if (host?.isConnected) return;
    host = document.createElement('reading-pencil-reader');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { --bg: #fffdf8; --fg: #1f2a37; --muted: #667085; --line: #e6e0d2; --accent: #2f6fb0; }
        @media (prefers-color-scheme: dark) {
          :host { --bg: #242a31; --fg: #e8ebef; --muted: #9aa4b2; --line: #3a434e; --accent: #6aa8e8; }
        }
        * { box-sizing: border-box; }
        button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; padding: 0; }
        button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        svg { width: 18px; height: 18px; fill: currentColor; display: block; }
        .speak {
          position: fixed; width: 34px; height: 34px; border-radius: 50%;
          display: none; align-items: center; justify-content: center;
          background: var(--accent); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .speak.on { display: flex; }
        .speak:hover { filter: brightness(1.08); }
        .player {
          position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
          display: none; align-items: center; gap: 4px; padding: 6px 10px 6px 8px;
          border-radius: 999px; background: var(--bg); color: var(--fg);
          border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
          font: 13px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; white-space: nowrap;
        }
        .player.on { display: flex; }
        .player button { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; }
        .player button:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
        .player .main { background: var(--accent); color: #fff; }
        .player .main:hover { background: var(--accent); filter: brightness(1.08); }
        .speed { display: flex; align-items: center; gap: 6px; margin: 0 6px 0 8px; color: var(--muted); }
        .speed input { width: 90px; accent-color: var(--accent); }
        .speed output { min-width: 34px; font-variant-numeric: tabular-nums; color: var(--fg); }
        .msg { color: #c0392b; margin-left: 4px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
        .msg:empty { display: none; }
        .sep { width: 1px; height: 22px; background: var(--line); }
        .player .locate { width: auto; padding: 0 10px 0 8px; gap: 6px; display: none; border-radius: 999px;
          color: var(--accent); font-weight: 600; }
        .player .locate.on { display: flex; align-items: center; }
        .player .locate svg { width: 16px; height: 16px; }
        @media (max-width: 560px) { .speed span { display: none; } .speed input { width: 70px; } }
      </style>
      <button class="speak" title="Read aloud from here (Alt+S)" aria-label="Read aloud from here">${icon('speaker')}</button>
      <div class="player" role="toolbar" aria-label="Read aloud">
        <button class="prev" title="Previous sentence (Alt+←)" aria-label="Previous sentence">${icon('prev')}</button>
        <button class="main" title="Pause (Alt+S)" aria-label="Pause">${icon('pause')}</button>
        <button class="next" title="Next sentence (Alt+→)" aria-label="Next sentence">${icon('next')}</button>
        <label class="speed"><span>Speed</span>
          <input type="range" min="50" max="200" step="5" aria-label="Reading speed">
          <output>1.0×</output>
        </label>
        <button class="locate" title="Scroll back to the words being read" aria-label="Back to reading">${icon('locate')}Back to reading</button>
        <span class="msg" role="status"></span>
        <span class="sep"></span>
        <button class="stop" title="Stop reading (Esc)" aria-label="Stop reading">${icon('stop')}</button>
      </div>`;
    const $ = (sel) => shadow.querySelector(sel);
    ui = {
      speak: $('.speak'),
      player: $('.player'),
      main: $('.main'),
      rate: $('.speed input'),
      rateLabel: $('.speed output'),
      msg: $('.msg'),
      locate: $('.locate'),
    };
    // Keep the page's selection when the button is pressed.
    ui.speak.addEventListener('mousedown', (e) => e.preventDefault());
    ui.speak.addEventListener('click', () => pendingRange && start(startOf(pendingRange)));
    ui.locate.addEventListener('click', backToReading);
    $('.prev').addEventListener('click', () => skip(-1));
    $('.next').addEventListener('click', () => skip(1));
    $('.stop').addEventListener('click', stop);
    ui.main.addEventListener('click', () => (reading?.playing ? pause() : resume()));
    ui.rate.addEventListener('input', () => (ui.rateLabel.textContent = rateText(ui.rate.value / 100)));
    ui.rate.addEventListener('change', () => chrome.storage.sync.set({ speechRate: ui.rate.value / 100 }));
    document.documentElement.appendChild(host);
  }

  const rateText = (r) => `${r.toFixed(r * 10 === Math.round(r * 10) ? 1 : 2)}×`;

  // Removes the UI entirely when nothing is showing, leaving the page as it was.
  function tidyUI() {
    if (host && !reading && !ui.speak.classList.contains('on')) {
      host.remove();
      host = ui = null;
    }
  }

  function renderPlayer() {
    if (!reading) {
      if (ui) ui.player.classList.remove('on');
      tidyUI();
      return;
    }
    ensureUI();
    ui.player.classList.add('on');
    const playing = reading.playing;
    ui.main.innerHTML = icon(playing ? 'pause' : 'play');
    ui.main.title = playing ? 'Pause (Alt+S)' : 'Resume (Alt+S)';
    ui.main.setAttribute('aria-label', playing ? 'Pause' : 'Resume');
    ui.locate.classList.toggle('on', !followScroll);
    ui.rate.value = Math.round(settings.speechRate * 100);
    ui.rateLabel.textContent = rateText(settings.speechRate);
    ui.msg.textContent = playing ? '' : reading.message || '';
  }

  function hideButton() {
    pendingRange = null;
    if (!ui) return;
    ui.speak.classList.remove('on');
    tidyUI();
  }

  function checkSelection() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !HAS_WORD.test(sel.toString())) return hideButton();
    const range = sel.getRangeAt(0);
    const el =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    if (!el || el.closest(EDITABLE) || el.isContentEditable || document.activeElement?.matches?.(EDITABLE)) {
      return hideButton();
    }
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] || range.getBoundingClientRect();
    pendingRange = range.cloneRange();
    ensureUI();
    // In the margin beside the last selected line, so it covers no words;
    // just below the end of the selection when there's no margin.
    const block = (RP.blockOf?.(el) || el).getBoundingClientRect();
    let x = Math.max(block.right, last.right) + 10;
    let y = last.top + last.height / 2 - 17;
    if (x + 40 > innerWidth) {
      x = last.right + 6;
      y = last.bottom + 4;
    }
    ui.speak.style.left = `${Math.min(Math.max(4, x), innerWidth - 40)}px`;
    ui.speak.style.top = `${Math.min(Math.max(4, y), innerHeight - 40)}px`;
    ui.speak.classList.add('on');
  }

  function onMouseUp(e) {
    if (e.composedPath().includes(host)) return;
    setTimeout(checkSelection, 0);
  }

  function onSelectionChange() {
    if (pendingRange && getSelection().isCollapsed) hideButton();
  }

  function typing() {
    const el = document.activeElement;
    return !!el && (el.isContentEditable || !!el.closest?.(EDITABLE));
  }

  // Esc stops. Alt+S reads the selection (or from the pencil), and pauses or
  // resumes once reading. While reading, Alt+← / Alt+→ skip by sentence.
  function onKeyDown(e) {
    if (e.key === 'Escape' && reading) return stop();
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || typing()) return;
    // e.code, since Option+S types "ß" on a Mac.
    if (e.code === 'KeyS') {
      e.preventDefault();
      e.stopPropagation();
      if (reading) return reading.playing ? pause() : resume();
      const sel = getSelection();
      if (sel.rangeCount && !sel.isCollapsed && HAS_WORD.test(sel.toString())) {
        return start(startOf(sel.getRangeAt(0)));
      }
      return start(RP.pencil?.position());
    }
    if (reading && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); // also keeps Alt+← from going back a page
      e.stopPropagation();
      skip(e.key === 'ArrowRight' ? 1 : -1);
    }
  }

  // While reading, click any word to have the voice jump there.
  function onClick(e) {
    if (!reading || e.button !== 0 || e.defaultPrevented) return;
    if (host && e.composedPath().includes(host)) return;
    if (!getSelection().isCollapsed || e.target.closest?.(INTERACTIVE)) return;
    const at = RP.pencil?.wordAt(e.clientX, e.clientY);
    if (at) start(at);
  }

  const listeners = [
    [document, 'mouseup', onMouseUp, { capture: true }],
    [document, 'click', onClick, { capture: true }],
    [document, 'selectionchange', onSelectionChange, {}],
    [document, 'scroll', onScroll, { passive: true, capture: true }],
    [window, 'wheel', onScrollInput, { passive: true, capture: true }],
    [window, 'touchmove', onScrollInput, { passive: true, capture: true }],
    [window, 'keydown', onScrollInput, { passive: true, capture: true }],
    [window, 'mousedown', onScrollInput, { passive: true, capture: true }],
    [window, 'keydown', onKeyDown, { capture: true }],
  ];

  RP.reader = {
    enable(next) {
      settings = next;
      if (enabled) return;
      enabled = true;
      for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
    },

    update(next) {
      settings = next;
      if (!enabled) return;
      // A new speed or voice takes over from the word being read.
      const changed =
        spokenWith && (spokenWith.rate !== settings.speechRate || spokenWith.voice !== settings.voiceName);
      if (reading?.playing && changed) play(reading.index, reading.lastChar);
      else {
        if (reading?.list[reading.index]) tint(reading.list[reading.index]); // new highlight color
        renderPlayer();
      }
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
      stop();
      hideButton();
      host?.remove();
      host = ui = null;
      try {
        port?.disconnect();
      } catch (_) {
        // extension reloaded
      }
      port = null;
    },
  };
})();

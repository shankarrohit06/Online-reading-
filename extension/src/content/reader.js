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
  const EDITABLE = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
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

  // ---- What to read --------------------------------------------------------

  function speakable(text) {
    const parent = text.parentElement;
    return (
      !!parent &&
      /\S/.test(text.data) &&
      !parent.closest(SKIP) &&
      parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  }

  // Runs of text belonging to the same block (paragraph, heading, list
  // item...), in reading order, starting at a given character. Each run keeps
  // where its characters came from so spoken positions map back to the page.
  function* runs(startNode, startOffset) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (speakable(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
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
      run.text += node.data.slice(from);
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
  function follow(s, c) {
    while (c < s.text.length && /\s/.test(s.text[c])) c++;
    reading.lastChar = c;
    const { node, offset } = locate(s.run, s.start + c);
    RP.pencil?.follow(node, offset);
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
    connect().postMessage({
      type: 'speak',
      id,
      text: s.text.slice(from),
      rate: settings.speechRate,
      voiceName: settings.voiceName,
      lang: document.documentElement.lang || '',
    });
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

  function start(range) {
    const at = startOf(range);
    if (!at) return;
    stop();
    getSelection().removeAllRanges();
    hideButton();
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
    port?.postMessage({ type: 'stop' });
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
    if (reading) port?.postMessage({ type: 'stop' });
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
      </style>
      <button class="speak" title="Read aloud from here" aria-label="Read aloud from here">${icon('speaker')}</button>
      <div class="player" role="toolbar" aria-label="Read aloud">
        <button class="prev" title="Previous sentence" aria-label="Previous sentence">${icon('prev')}</button>
        <button class="main" title="Pause" aria-label="Pause">${icon('pause')}</button>
        <button class="next" title="Next sentence" aria-label="Next sentence">${icon('next')}</button>
        <label class="speed">Speed
          <input type="range" min="50" max="200" step="5" aria-label="Reading speed">
          <output>1.0×</output>
        </label>
        <span class="msg"></span>
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
    };
    // Keep the page's selection when the button is pressed.
    ui.speak.addEventListener('mousedown', (e) => e.preventDefault());
    ui.speak.addEventListener('click', () => pendingRange && start(pendingRange));
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
    ui.main.title = playing ? 'Pause' : 'Resume';
    ui.main.setAttribute('aria-label', ui.main.title);
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
    ui.speak.style.left = `${Math.min(Math.max(4, last.right + 6), innerWidth - 40)}px`;
    ui.speak.style.top = `${Math.min(Math.max(4, last.bottom + 4), innerHeight - 40)}px`;
    ui.speak.classList.add('on');
  }

  function onMouseUp(e) {
    if (e.composedPath().includes(host)) return;
    setTimeout(checkSelection, 0);
  }

  function onSelectionChange() {
    if (pendingRange && getSelection().isCollapsed) hideButton();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && reading) stop();
  }

  const listeners = [
    [document, 'mouseup', onMouseUp, { capture: true }],
    [document, 'selectionchange', onSelectionChange, {}],
    [document, 'scroll', () => pendingRange && hideButton(), { passive: true, capture: true }],
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
      else renderPlayer();
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

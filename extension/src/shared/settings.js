// Shared by the content scripts, the popup and the background worker.
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabledSites: {}, // { hostname: true }
    growScale: 1.25, // how much the word under the pencil grows
    highlightColor: '#ffe14d',
    showRules: true,
    ruleColor: 'auto', // 'auto' = match the page's text color, or a hex color
    lineSpacing: 0, // 0 = page default, otherwise a multiple of the font size
    font: 'page', // 'page' | 'atkinson' | 'opendyslexic' | 'verdana'
    speechRate: 1, // read-aloud speed, 0.5 to 2
    voiceName: '', // '' = Chrome's default voice for the page's language
  });

  const FONTS = Object.freeze({
    page: null,
    atkinson: {
      family: "'RP Atkinson Hyperlegible', 'Atkinson Hyperlegible', sans-serif",
      faces: [
        ['RP Atkinson Hyperlegible', 400, 'fonts/atkinson-hyperlegible-latin-400-normal.woff2'],
        ['RP Atkinson Hyperlegible', 700, 'fonts/atkinson-hyperlegible-latin-700-normal.woff2'],
      ],
    },
    opendyslexic: {
      family: "'RP OpenDyslexic', 'OpenDyslexic', sans-serif",
      faces: [
        ['RP OpenDyslexic', 400, 'fonts/opendyslexic-latin-400-normal.woff2'],
        ['RP OpenDyslexic', 700, 'fonts/opendyslexic-latin-700-normal.woff2'],
      ],
    },
    verdana: { family: 'Verdana, Geneva, Tahoma, sans-serif', faces: [] },
  });

  // Padding (in em) on each side of the enlarged word's highlight.
  const PENCIL_PAD_EM = 0.1;

  // Extra space (in em) added between words so that a word up to about
  // DESIGN_WORD_EM wide can grow to `scale` without touching its neighbours.
  // Each side must absorb half the growth plus the scaled highlight padding;
  // a normal space already gives about 0.25em of that.
  const DESIGN_WORD_EM = 3;
  function wordRoom(scale) {
    const needed = ((scale - 1) * DESIGN_WORD_EM) / 2 + PENCIL_PAD_EM * scale - 0.25;
    return Math.max(0.05, Math.round(needed * 100) / 100);
  }

  // The key a page's on/off state is remembered under, or null if the
  // extension can't run there (chrome://, the Web Store, ...). "www." is
  // dropped so www.example.com and example.com count as one site.
  function hostKey(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
      if (u.protocol === 'file:') return 'file://';
    } catch (_) {
      // not a URL
    }
    return null;
  }

  async function load() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  }

  async function setSiteEnabled(host, on) {
    const { enabledSites = {} } = await chrome.storage.sync.get('enabledSites');
    if (on) enabledSites[host] = true;
    else delete enabledSites[host];
    await chrome.storage.sync.set({ enabledSites });
  }

  async function toggleSite(host) {
    const { enabledSites = {} } = await chrome.storage.sync.get('enabledSites');
    const on = !enabledSites[host];
    await setSiteEnabled(host, on);
    return on;
  }

  // Restores every setting except which sites are switched on.
  async function reset() {
    const { enabledSites = {} } = await chrome.storage.sync.get('enabledSites');
    await chrome.storage.sync.set({ ...DEFAULTS, enabledSites });
  }

  // Friendly name for a site key, for messages and the popup.
  function siteName(host) {
    return host === 'file://' ? 'local files' : host;
  }

  // Sites saved before "www." was dropped from site keys.
  async function migrate() {
    const { enabledSites = {} } = await chrome.storage.sync.get('enabledSites');
    const keys = Object.keys(enabledSites);
    if (!keys.some((k) => k.startsWith('www.'))) return;
    const next = {};
    for (const k of keys) next[k.replace(/^www\./, '')] = true;
    await chrome.storage.sync.set({ enabledSites: next });
  }

  root.RPSettings = {
    DEFAULTS,
    FONTS,
    PENCIL_PAD_EM,
    wordRoom,
    hostKey,
    siteName,
    migrate,
    load,
    setSiteEnabled,
    toggleSite,
    reset,
  };
})(typeof self !== 'undefined' ? self : this);

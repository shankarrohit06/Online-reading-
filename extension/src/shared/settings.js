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

  // The key a page's on/off state is remembered under, or null if the
  // extension can't run there (chrome://, the Web Store, ...).
  function hostKey(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
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

  root.RPSettings = { DEFAULTS, FONTS, hostKey, load, setSiteEnabled, toggleSite, reset };
})(typeof self !== 'undefined' ? self : this);

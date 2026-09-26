importScripts('shared/settings.js');

const CONTENT = chrome.runtime.getManifest().content_scripts[0];

// Tabs that were open before the extension was installed (or reloaded) don't
// have the content scripts yet, so inject them on demand.
async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'rp-ping' });
    return true;
  } catch (_) {
    // no listener: not injected yet
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT.css });
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT.js });
    return true;
  } catch (_) {
    return false; // a page extensions may not touch
  }
}

function setBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6fb0' });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
    return;
  }
  if (reason !== 'update') return;
  await RPSettings.migrate();
  // Pages that were already open still run the old copy of the extension,
  // which can no longer talk to it. Give tabs on switched-on sites a fresh one.
  const { enabledSites = {} } = await chrome.storage.sync.get('enabledSites');
  for (const tab of await chrome.tabs.query({})) {
    const host = RPSettings.hostKey(tab.url || '');
    if (host && enabledSites[host]) ensureInjected(tab.id);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-reading-pencil') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = tab && RPSettings.hostKey(tab.url);
  if (!host) return;
  const on = await RPSettings.toggleSite(host);
  if (on) ensureInjected(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'rp-state' && sender.tab) {
    setBadge(sender.tab.id, msg.on);
  } else if (msg?.type === 'rp-ensure') {
    ensureInjected(msg.tabId).then((ok) => sendResponse({ ok }));
    return true;
  }
});

// ---- Read aloud ------------------------------------------------------------
// Pages send one sentence at a time over a port named "rp-tts"; the voice's
// start/word/end events go back the same way, tagged with the sentence's id.

// The speech engine. Kept on `self` so the automated tests can swap in a fake
// voice (the test machine has no real ones).
self.rpSpeech = {
  speak: (text, options) => chrome.tts.speak(text, options),
  stop: () => chrome.tts.stop(),
};

// Match the page's language only when a voice for it is installed.
async function hasVoiceFor(lang) {
  const prefix = lang.toLowerCase().split('-')[0];
  const voices = await chrome.tts.getVoices();
  return voices.some((v) => v.lang?.toLowerCase().startsWith(prefix));
}

const RELAYED = new Set(['start', 'word', 'end', 'interrupted', 'cancelled', 'error']);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rp-tts') return;
  let active = null; // id of the sentence this page is speaking

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'speak') {
      active = msg.id;
      const options = { rate: msg.rate, enqueue: false };
      if (msg.voiceName) options.voiceName = msg.voiceName;
      else if (msg.lang && (await hasVoiceFor(msg.lang))) options.lang = msg.lang;
      if (active !== msg.id) return; // stopped or replaced while looking up voices
      options.onEvent = (e) => {
        if (active !== msg.id || !RELAYED.has(e.type)) return;
        if (e.type !== 'word' && e.type !== 'start') active = null;
        try {
          port.postMessage({ type: e.type, id: msg.id, charIndex: e.charIndex, error: e.errorMessage });
        } catch (_) {
          // the page went away
        }
      };
      self.rpSpeech.speak(msg.text, options);
    } else if (msg.type === 'stop') {
      if (active !== null) self.rpSpeech.stop();
      active = null;
    }
  });

  port.onDisconnect.addListener(() => {
    if (active !== null) self.rpSpeech.stop();
  });
});

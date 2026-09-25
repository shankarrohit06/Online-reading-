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

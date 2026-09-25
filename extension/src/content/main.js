// Turns the ruler and the pencil on or off for this site and passes along
// setting changes as they happen.
(() => {
  'use strict';
  const RP = (window.__readingPencil ||= {});
  RP.main?.destroy();

  const host = RPSettings.hostKey(location.href);
  let settings = null;
  let on = false;

  function apply() {
    const wanted = !!(host && settings.enabledSites[host]);
    if (wanted) {
      RP.ruler.enable(settings);
      if (on) RP.pencil.update(settings);
      else RP.pencil.enable(settings);
    } else if (on) {
      RP.ruler.disable();
      RP.pencil.disable();
    }
    if (wanted !== on) {
      chrome.runtime.sendMessage({ type: 'rp-state', on: wanted }).catch(() => {});
    }
    on = wanted;
  }

  function onStorage(changes, area) {
    if (area !== 'sync' || !settings) return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue ?? RPSettings.DEFAULTS[key];
    }
    apply();
  }

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === 'rp-ping') sendResponse({ host, on });
  }

  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onMessage);

  RPSettings.load().then((loaded) => {
    settings = loaded;
    on = false;
    if (host && settings.enabledSites[host]) apply();
  });

  RP.main = {
    destroy() {
      try {
        chrome.storage.onChanged.removeListener(onStorage);
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch (_) {
        // the old extension context is already gone
      }
      RP.ruler?.disable();
      RP.pencil?.disable();
    },
  };
})();

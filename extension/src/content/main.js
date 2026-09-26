// Turns the ruler, the pencil and read-aloud on or off for this site and
// passes along setting changes as they happen.
(() => {
  'use strict';
  const RP = (window.__readingPencil ||= {});
  RP.main?.destroy();

  // The extension's own practice page is always on.
  const alwaysOn =
    location.protocol === 'chrome-extension:' && !!document.querySelector('[data-rp-always-on]');
  const host = alwaysOn ? 'practice' : RPSettings.hostKey(location.href);
  let settings = null;
  let on = false;
  let ready = false;

  function apply() {
    const wanted = alwaysOn || !!(host && settings.enabledSites[host]);
    if (wanted) {
      RP.ruler.enable(settings);
      if (on) {
        RP.pencil.update(settings);
        RP.reader.update(settings);
      } else {
        RP.pencil.enable(settings);
        RP.reader.enable(settings);
      }
    } else if (on) {
      RP.reader.disable();
      RP.ruler.disable();
      RP.pencil.disable();
    }
    if (wanted !== on) {
      chrome.runtime.sendMessage({ type: 'rp-state', on: wanted }).catch(() => {});
      // Say so when it's switched on or off while you're on the page (the
      // keyboard shortcut otherwise gives no feedback).
      if (ready && !alwaysOn && document.visibilityState === 'visible') {
        toast(wanted ? `Reading Pencil is on for ${RPSettings.siteName(host)}` : 'Reading Pencil is off');
      }
    }
    on = wanted;
  }

  // ---- Toast -----------------------------------------------------------------

  let toastHost = null;
  let toastTimer = 0;

  function toast(message) {
    clearTimeout(toastTimer);
    toastHost?.remove();
    toastHost = document.createElement('reading-pencil-toast');
    toastHost.setAttribute('role', 'status');
    const shadow = toastHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0; width: 0; height: 0; }
        .t {
          position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
          display: flex; align-items: center; gap: 8px; padding: 9px 16px 9px 12px;
          border-radius: 999px; background: #1f2a37; color: #fff;
          font: 600 14px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); white-space: nowrap;
          animation: in 160ms ease-out;
        }
        img { width: 20px; height: 20px; }
        @keyframes in { from { opacity: 0; transform: translate(-50%, -6px); } }
        @media (prefers-reduced-motion: reduce) { .t { animation: none; } }
      </style>
      <div class="t"><img alt="" src="${chrome.runtime.getURL('icons/icon32.png')}"><span></span></div>`;
    shadow.querySelector('span').textContent = message;
    document.documentElement.appendChild(toastHost);
    toastTimer = setTimeout(() => {
      toastHost?.remove();
      toastHost = null;
    }, 1800);
  }

  // ---- Wiring ----------------------------------------------------------------

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

  // After the extension is updated or reloaded, this copy can no longer talk
  // to it. Tidy the page up instead of leaving half-working pieces behind.
  function checkAlive() {
    if (!chrome.runtime?.id) RP.main?.destroy();
  }

  const lifecycle = [
    [document, 'visibilitychange', checkAlive],
    [window, 'focus', checkAlive],
    [window, 'pointerdown', checkAlive],
  ];

  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onMessage);
  for (const [target, type, fn] of lifecycle)
    target.addEventListener(type, fn, { passive: true, capture: true });

  RPSettings.load().then((loaded) => {
    settings = loaded;
    on = false;
    if (alwaysOn || (host && settings.enabledSites[host])) apply();
    ready = true;
  });

  RP.main = {
    destroy() {
      try {
        chrome.storage.onChanged.removeListener(onStorage);
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch (_) {
        // the old extension context is already gone
      }
      for (const [target, type, fn] of lifecycle) target.removeEventListener(type, fn, { capture: true });
      clearTimeout(toastTimer);
      toastHost?.remove();
      RP.reader?.disable();
      RP.ruler?.disable();
      RP.pencil?.disable();
      RP.main = null;
    },
  };
})();

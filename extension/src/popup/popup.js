(async () => {
  'use strict';
  const S = RPSettings;
  const $ = (id) => document.getElementById(id);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = tab && S.hostKey(tab.url);
  let settings = await S.load();

  const save = (patch) => {
    Object.assign(settings, patch);
    return chrome.storage.sync.set(patch);
  };

  // ---- This site ----
  function renderSite() {
    const on = !!(host && settings.enabledSites[host]);
    $('siteLabel').textContent = host === 'file://' ? 'Local files' : host || 'This page';
    $('siteToggle').checked = on;
    $('siteToggle').disabled = !host;
    $('siteState').textContent = !host ? 'Not available here' : on ? 'On for this site' : 'Off for this site';
    $('unsupported').hidden = !!host;
  }

  $('siteToggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await S.setSiteEnabled(host, on);
    settings = await S.load();
    renderSite();
    if (on) chrome.runtime.sendMessage({ type: 'rp-ensure', tabId: tab.id });
  });

  // ---- Pencil size ----
  function renderGrow(pct) {
    $('grow').value = pct;
    $('growValue').textContent = `${pct}%`;
    $('previewWord').style.transform = `scale(${pct / 100})`;
    $('previewWord').parentElement.style.wordSpacing = `${S.wordRoom(pct / 100)}em`;
  }
  $('grow').addEventListener('input', (e) => renderGrow(+e.target.value));
  // Saved on release; sync storage limits how often it may be written.
  $('grow').addEventListener('change', (e) => save({ growScale: +e.target.value / 100 }));

  // ---- Highlight color ----
  function renderHighlight(color) {
    $('highlight').value = color;
    document.body.style.setProperty('--hl', color);
    for (const b of $('highlightSwatches').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.color === color));
    }
  }
  $('highlightSwatches').addEventListener('click', (e) => {
    const color = e.target.closest('button')?.dataset.color;
    if (!color) return;
    renderHighlight(color);
    save({ highlightColor: color });
  });
  $('highlight').addEventListener('input', (e) => renderHighlight(e.target.value));
  $('highlight').addEventListener('change', (e) => save({ highlightColor: e.target.value }));

  // ---- Ruled lines ----
  function renderRules() {
    const custom = settings.ruleColor !== 'auto';
    $('showRules').checked = settings.showRules;
    $('ruleMode').value = custom ? 'custom' : 'auto';
    $('ruleMode').disabled = !settings.showRules;
    $('ruleColor').hidden = !custom;
    $('ruleColor').disabled = !settings.showRules;
    if (custom) $('ruleColor').value = settings.ruleColor;
  }
  $('showRules').addEventListener('change', async (e) => {
    await save({ showRules: e.target.checked });
    renderRules();
  });
  $('ruleMode').addEventListener('change', async (e) => {
    const color = e.target.value === 'auto' ? 'auto' : $('ruleColor').value || '#8a9bb0';
    await save({ ruleColor: color });
    renderRules();
  });
  $('ruleColor').addEventListener('change', (e) => save({ ruleColor: e.target.value }));

  // ---- Line spacing ----
  function renderSpacing() {
    for (const b of $('spacing').querySelectorAll('button')) {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(+b.dataset.value === settings.lineSpacing));
    }
  }
  $('spacing').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ lineSpacing: +b.dataset.value });
    renderSpacing();
  });

  // ---- Font ----
  $('font').addEventListener('change', (e) => save({ font: e.target.value }));

  // ---- Footer ----
  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-reading-pencil');
  $('toggleKey').textContent = toggle?.shortcut || 'not set';

  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  $('reset').addEventListener('click', async (e) => {
    e.preventDefault();
    await S.reset();
    settings = await S.load();
    renderAll();
  });

  function renderAll() {
    renderSite();
    renderGrow(Math.round(settings.growScale * 100));
    renderHighlight(settings.highlightColor);
    renderRules();
    renderSpacing();
    $('font').value = settings.font;
  }

  renderAll();
})();

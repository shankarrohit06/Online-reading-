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
    $('siteLabel').textContent = host ? S.siteName(host) : 'This page';
    $('siteLabel').title = $('siteLabel').textContent;
    $('siteToggle').checked = on;
    $('siteToggle').disabled = !host;
    $('siteState').textContent = !host
      ? 'Not available here'
      : on
        ? 'On for this site'
        : 'Off. Switch on to start.';
    $('site').classList.toggle('is-on', on);
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
      const checked = +b.dataset.value === settings.lineSpacing;
      b.setAttribute('aria-checked', String(checked));
      b.tabIndex = checked ? 0 : -1;
    }
  }
  $('spacing').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ lineSpacing: +b.dataset.value });
    renderSpacing();
  });
  // Arrow keys move between the choices, as in any radio group.
  $('spacing').addEventListener('keydown', async (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const buttons = [...$('spacing').querySelectorAll('button')];
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[(i + step + buttons.length) % buttons.length];
    await save({ lineSpacing: +next.dataset.value });
    renderSpacing();
    next.focus();
  });

  // ---- Font ----
  $('font').addEventListener('change', (e) => save({ font: e.target.value }));

  // ---- Read aloud ----
  const rateText = (r) => `${r.toFixed(r * 10 === Math.round(r * 10) ? 1 : 2)}×`;
  const lang = navigator.language.toLowerCase().split('-')[0];
  const voices = (await chrome.tts.getVoices()).filter((v) => v.voiceName);
  const byName = (a, b) => a.voiceName.localeCompare(b.voiceName);
  const mine = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang)).sort(byName);
  const others = voices
    .filter((v) => !mine.includes(v))
    .sort((a, b) => (a.lang || '').localeCompare(b.lang || '') || byName(a, b));
  const addGroup = (label, list, showLang) => {
    if (!list.length) return;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const v of list) {
      const option = document.createElement('option');
      option.value = v.voiceName;
      option.textContent = `${v.voiceName}${showLang && v.lang ? ` (${v.lang})` : ''}${v.remote ? ' · online' : ''}`;
      group.append(option);
    }
    $('voice').append(group);
  };
  addGroup('Your language', mine, false);
  addGroup('Other languages', others, true);

  function voiceNote() {
    const v = voices.find((x) => x.voiceName === settings.voiceName);
    if (!voices.length) return 'No voices found. Chrome adds them from your system settings.';
    if (!v) return 'Chrome picks a voice that matches each page’s language.';
    const where = v.remote ? 'Online voice: the text is sent to be spoken.' : 'Runs on this computer.';
    const sync = v.eventTypes?.includes('word')
      ? 'The pencil follows it word by word.'
      : 'The pencil follows it at an estimated pace.';
    return `${where} ${sync}`;
  }

  function renderSpeech() {
    $('rate').value = Math.round(settings.speechRate * 100);
    $('rateValue').textContent = rateText(settings.speechRate);
    $('voice').value = settings.voiceName;
    if ($('voice').value !== settings.voiceName) $('voice').value = ''; // voice no longer installed
    $('voiceNote').textContent = voiceNote();
  }
  $('voice').addEventListener('change', async (e) => {
    await save({ voiceName: e.target.value });
    renderSpeech();
  });
  $('rate').addEventListener('input', (e) => ($('rateValue').textContent = rateText(e.target.value / 100)));
  $('rate').addEventListener('change', (e) => save({ speechRate: +e.target.value / 100 }));

  let testing = false;
  const setTesting = (on) => {
    testing = on;
    $('testVoice').textContent = on ? '■ Stop' : '▶ Test';
  };
  $('testVoice').addEventListener('click', () => {
    if (testing) {
      chrome.tts.stop();
      return setTesting(false);
    }
    const options = {
      rate: settings.speechRate,
      onEvent: (e) => {
        if (['end', 'error', 'interrupted', 'cancelled'].includes(e.type)) setTesting(false);
      },
    };
    if (settings.voiceName) options.voiceName = settings.voiceName;
    setTesting(true);
    chrome.tts.speak('This is how Reading Pencil sounds when it reads to you.', options);
  });

  // ---- Footer ----
  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-reading-pencil');
  $('toggleKey').textContent = toggle?.shortcut || 'Not set';

  try {
    $('keysBox').open = localStorage.getItem('rp-keys-open') === '1';
  } catch (_) {
    // storage unavailable; stays closed
  }
  $('keysBox').addEventListener('toggle', () => {
    try {
      localStorage.setItem('rp-keys-open', $('keysBox').open ? '1' : '0');
    } catch (_) {
      // not remembered
    }
  });

  $('guide').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
  });

  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Reset asks for a second click instead of acting straight away.
  let resetArmed = 0;
  $('reset').addEventListener('click', async (e) => {
    e.preventDefault();
    if (!resetArmed) {
      $('reset').textContent = 'Click again to reset';
      resetArmed = setTimeout(() => {
        resetArmed = 0;
        $('reset').textContent = 'Reset settings';
      }, 3000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = 0;
    await S.reset();
    settings = await S.load();
    renderAll();
    $('reset').textContent = 'Settings reset';
    setTimeout(() => ($('reset').textContent = 'Reset settings'), 1500);
  });

  function renderAll() {
    renderSite();
    renderGrow(Math.round(settings.growScale * 100));
    renderHighlight(settings.highlightColor);
    renderRules();
    renderSpacing();
    renderSpeech();
    $('font').value = settings.font;
  }

  renderAll();
})();

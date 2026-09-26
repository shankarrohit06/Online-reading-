// Guide page: shows the real shortcut, and lists Chrome's voices so you can
// hear each one and choose it for read aloud.
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SAMPLE = 'This is how Reading Pencil sounds when it reads a page to you.';
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>';

  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-reading-pencil');
  if (toggle?.shortcut) $('toggleKey').textContent = toggle.shortcut;

  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  let chosen = (await chrome.storage.sync.get({ voiceName: '' })).voiceName;
  let playing = null; // the row whose voice is speaking

  const langNames = (() => {
    try {
      return new Intl.DisplayNames([navigator.language], { type: 'language' });
    } catch (_) {
      return null;
    }
  })();
  const languageName = (tag) => {
    try {
      return (tag && langNames?.of(tag)) || tag || 'Any language';
    } catch (_) {
      return tag;
    }
  };

  function setPlaying(row) {
    if (playing) {
      playing.querySelector('.play').innerHTML = ICON_PLAY;
      playing.querySelector('.play').setAttribute('aria-label', `Play ${playing.dataset.name}`);
    }
    playing = row;
    if (row) {
      row.querySelector('.play').innerHTML = ICON_STOP;
      row.querySelector('.play').setAttribute('aria-label', `Stop ${row.dataset.name}`);
    }
  }

  function play(voice, row) {
    const same = playing === row;
    chrome.tts.stop();
    setPlaying(null);
    if (same) return;
    setPlaying(row);
    chrome.tts.speak(SAMPLE, {
      voiceName: voice.voiceName,
      onEvent: (e) => {
        if (['end', 'error', 'interrupted', 'cancelled'].includes(e.type) && playing === row)
          setPlaying(null);
      },
    });
  }

  function renderChosen() {
    for (const row of document.querySelectorAll('.voice')) {
      const on = row.dataset.name === chosen;
      row.classList.toggle('chosen', on);
      row.querySelector('.use').textContent = on ? 'Chosen' : 'Use this voice';
      row.querySelector('.use').setAttribute('aria-pressed', String(on));
    }
  }

  function row(voice) {
    const el = document.createElement('div');
    el.className = 'voice';
    el.dataset.name = voice.voiceName;
    const words = voice.eventTypes?.includes('word');
    el.innerHTML = `
      <button class="play" type="button">${ICON_PLAY}</button>
      <div>
        <div class="name"></div>
        <div class="meta">
          <span class="lang"></span>
          <span class="badge ${voice.remote ? 'online' : ''}">${voice.remote ? 'Online' : 'On this computer'}</span>
          <span class="badge ${words ? 'good' : 'warn'}">${words ? 'Word by word' : 'Estimated pace'}</span>
        </div>
      </div>
      <button class="use" type="button" aria-pressed="false">Use this voice</button>`;
    el.querySelector('.name').textContent = voice.voiceName;
    el.querySelector('.lang').textContent = languageName(voice.lang);
    el.querySelector('.play').setAttribute('aria-label', `Play ${voice.voiceName}`);
    el.querySelector('.play').addEventListener('click', () => play(voice, el));
    el.querySelector('.use').addEventListener('click', async () => {
      chosen = chosen === voice.voiceName ? '' : voice.voiceName;
      await chrome.storage.sync.set({ voiceName: chosen });
      renderChosen();
    });
    return el;
  }

  const lang = navigator.language.toLowerCase().split('-')[0];
  const voices = (await chrome.tts.getVoices()).filter((v) => v.voiceName);
  const byName = (a, b) => a.voiceName.localeCompare(b.voiceName);
  const mine = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang)).sort(byName);
  const others = voices
    .filter((v) => !mine.includes(v))
    .sort((a, b) => (a.lang || '').localeCompare(b.lang || '') || byName(a, b));
  $('voices').replaceChildren(...mine.map(row));
  $('others').replaceChildren(...others.map(row));
  $('othersBox').hidden = !others.length;
  $('othersSummary').textContent = `Other languages (${others.length})`;
  $('noVoices').hidden = voices.length > 0;
  renderChosen();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && 'voiceName' in changes) {
      chosen = changes.voiceName.newValue || '';
      renderChosen();
    }
  });
})();

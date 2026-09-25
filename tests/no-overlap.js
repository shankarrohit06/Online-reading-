// Steps the pencil through every word of the test page at each pencil size,
// font and browser zoom level, and checks that the enlarged word never
// covers any other letter on the page.
// Usage: node tests/no-overlap.js   (also run by npm test)
const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EXT = path.resolve(__dirname, '..', 'extension');
const SCALES = [1.1, 1.25, 1.5, 1.75, 2];
const FONTS = ['page', 'atkinson', 'opendyslexic'];
// Browser zoom changes the CSS viewport width and the device pixel ratio.
const ZOOMS = [
  { zoom: 1, scales: SCALES, fonts: FONTS },
  { zoom: 0.67, scales: [1.25, 2], fonts: ['page'] },
  { zoom: 1.5, scales: [1.25, 2], fonts: ['page', 'opendyslexic'] },
  { zoom: 2, scales: [1.25, 2], fonts: ['page'] },
];

// Runs in the page: the pencil box, and every letter it overlaps other than
// the letters of the word it is showing.
function inspect() {
  const box = document.querySelector('reading-pencil-overlay')?.shadowRoot.querySelector('.w');
  if (!box || !box.classList.contains('on')) return null;
  for (const a of box.getAnimations()) a.finish(); // measure the settled size
  const b = box.getBoundingClientRect();
  const word = box.textContent;
  const scale = parseFloat(/scale\(([\d.]+)\)/.exec(box.style.transform)[1]);
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('textarea, reading-pencil-overlay')) continue;
    for (let i = 0; i < n.data.length; i++) {
      if (!/\S/.test(n.data[i])) continue;
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      const x = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const y = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (x > 0.5 && y > 0.5) hits.push({ n, i, r });
    }
  }
  // Drop the word's own letters: a run in one text node spelling the word.
  const own = new Set();
  for (let k = 0; k < hits.length; k++) {
    const { n, i } = hits[k];
    if (n.data.startsWith(word, i) && hits[k + word.length - 1]?.n === n) {
      for (let j = 0; j < word.length; j++) own.add(k + j);
      break;
    }
  }
  if (!own.size) return { word, scale, others: ['(word not under its pencil)'], x: b.left, y: b.top };
  // Letters the page itself already lays out touching the word (like a comma
  // after slanted italic text) overlap it before the pencil does anything.
  const ownRects = [...own].map((k) => hits[k].r);
  const touchedByPage = (r) =>
    ownRects.some(
      (q) =>
        Math.min(r.right, q.right) - Math.max(r.left, q.left) > 0.5 &&
        Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 0.5,
    );
  const others = hits.filter((h, k) => !own.has(k) && !touchedByPage(h.r)).map(({ n, i }) => n.data[i]);
  return { word, scale, others, x: Math.round(b.left), y: Math.round(b.top) };
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let failures = 0;

  for (const { zoom, scales, fonts } of ZOOMS) {
    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: Math.round(1000 / zoom), height: Math.round(2400 / zoom) },
      deviceScaleFactor: zoom,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
    const page = await ctx.newPage();
    await page.goto(url);
    await sw.evaluate(() => chrome.storage.sync.set({ enabledSites: { '127.0.0.1': true } }));
    await page.waitForSelector('.rp-ruled');

    for (const font of fonts) {
      for (const scale of scales) {
        await sw.evaluate((p) => chrome.storage.sync.set(p), { growScale: scale, font });
        await page.waitForTimeout(font === 'page' ? 150 : 400);
        await page.mouse.move(1, 1);
        await page.keyboard.press('Escape');
        await page.evaluate(() => scrollTo(0, 0));

        let steps = 0;
        let full = 0;
        let smallest = Infinity;
        let last = null;
        const bad = [];
        for (;;) {
          await page.keyboard.press('Alt+ArrowRight');
          const s = await page.evaluate(inspect);
          if (!s) break;
          const key = `${s.word}@${s.x},${s.y}`;
          if (key === last) break; // reached the last word
          last = key;
          steps++;
          if (s.scale >= scale - 1e-6) full++;
          smallest = Math.min(smallest, s.scale);
          if (s.others.length) bad.push(`"${s.word}" covers ${JSON.stringify(s.others.join(''))}`);
          if (steps > 500) break;
        }
        const label = `zoom ${zoom * 100}%, pencil ${Math.round(scale * 100)}%, font ${font}`;
        const summary = `${steps} words, ${full} at full size, smallest ${Math.round(smallest * 100)}%`;
        try {
          assert.ok(steps > 80, `stepped through the page (${steps})`);
          assert.deepEqual(bad, []);
          console.log(`  ✓ ${label}: no overlaps (${summary})`);
        } catch (err) {
          failures++;
          console.log(`  ✗ ${label}: ${summary}\n    ${bad.slice(0, 8).join('\n    ') || err.message}`);
        }
      }
    }
    await ctx.close();
  }
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nNo overlaps at any size, font or zoom.');
  process.exit(failures ? 1 : 0);
})();

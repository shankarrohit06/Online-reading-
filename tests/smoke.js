// End-to-end check: loads the unpacked extension in Chromium, turns it on for
// a local test page and drives the pencil with the mouse and keyboard.
// Usage: npm test   (screenshots land in tests/output/ or $RP_SHOT_DIR)
const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EXT = path.resolve(__dirname, '..', 'extension');
const OUT = process.env.RP_SHOT_DIR || path.join(__dirname, 'output');

function check(name, fn) {
  return fn().then(
    () => console.log(`  ✓ ${name}`),
    (err) => {
      console.log(`  ✗ ${name}`);
      throw err;
    },
  );
}

// Overlay state, read from the page (the overlay uses an open shadow root).
const overlay = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('reading-pencil-overlay')?.shadowRoot.querySelector('.w');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return {
      word: box.textContent,
      on: box.classList.contains('on'),
      transform: box.style.transform,
      top: r.top,
    };
  });

const wordCenter = (page, id, word) =>
  page.evaluate(
    ([id, word]) => {
      const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(word);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + word.length);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    },
    [id, word],
  );

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let failed = false;
  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
    const extId = new URL(sw.url()).host;
    const setSettings = (patch) => sw.evaluate((p) => chrome.storage.sync.set(p), patch);

    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);
    const pristine = await page.evaluate(() => document.documentElement.outerHTML);

    await check('does nothing until switched on for the site', async () => {
      assert.equal(await page.locator('.rp-ruled').count(), 0);
      assert.equal(await page.locator('reading-pencil-overlay').count(), 0);
    });

    await setSettings({ enabledSites: { '127.0.0.1': true } });
    await page.waitForSelector('.rp-ruled');

    await check('rules leaf text blocks and skips nav, code and textareas', async () => {
      const ruled = await page.$$eval('.rp-ruled', (els) => els.map((e) => e.id || e.tagName));
      for (const id of ['p1', 'p2', 'p3', 'inner', 'H1', 'LI']) assert.ok(ruled.includes(id), `${id} ruled`);
      for (const tag of ['NAV', 'PRE', 'CODE', 'TEXTAREA', 'mixed', 'BODY'])
        assert.ok(!ruled.includes(tag), `${tag} not ruled`);
      const lh = await page.$eval('#p1', (e) => e.style.getPropertyValue('--rp-lh'));
      assert.equal(lh, '27.00px'); // 18px * 1.5
      const spacing = await page.$eval('#p1', (e) => parseFloat(getComputedStyle(e).wordSpacing));
      assert.ok(spacing > 3, `extra space between words (${spacing}px)`);
      const nav = await page.$eval('nav', (e) => getComputedStyle(e).wordSpacing);
      assert.equal(nav, '0px', 'menus keep their spacing');
    });

    await check('hovering a word pops it out at 125%', async () => {
      const c = await wordCenter(page, 'p1', 'pencil');
      await page.mouse.move(c.x - 30, c.y);
      await page.mouse.move(c.x, c.y, { steps: 3 });
      await page.waitForTimeout(150);
      const o = await overlay(page);
      assert.equal(o.word, 'pencil,'); // punctuation travels with its word
      assert.ok(o.on);
      assert.equal(o.transform, 'scale(1.25)');
    });

    // caret: 'initial' stops Playwright leaving style="" on the textarea.
    await page.screenshot({ path: path.join(OUT, 'on-hover.png'), caret: 'initial' });

    await check('Alt+Right steps to the next word', async () => {
      await page.keyboard.press('Alt+ArrowRight');
      await page.waitForTimeout(50);
      assert.equal((await overlay(page)).word, 'keeping');
      await page.keyboard.press('Alt+ArrowLeft');
      await page.waitForTimeout(50);
      assert.equal((await overlay(page)).word, 'pencil,');
    });

    await check('Alt+Down moves to the line below', async () => {
      const before = await overlay(page);
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForTimeout(50);
      const after = await overlay(page);
      assert.notEqual(after.word, before.word);
      assert.ok(after.top > before.top + 15, `moved down (${before.top} -> ${after.top})`);
      await page.keyboard.press('Alt+ArrowUp');
      await page.waitForTimeout(50);
      assert.ok(Math.abs((await overlay(page)).top - before.top) < 2, 'back on the first line');
    });

    await check('Alt+Left does not navigate the page away', async () => {
      assert.equal(page.url(), url);
    });

    await check('settings apply live', async () => {
      await setSettings({ growScale: 1.5, lineSpacing: 2, font: 'atkinson' });
      await page.waitForTimeout(150);
      const grown = parseFloat(/scale\(([\d.]+)\)/.exec((await overlay(page)).transform)[1]);
      assert.ok(grown > 1.4 && grown <= 1.5, `grew to ~150% (${grown})`);
      assert.equal(await page.$eval('#p1', (e) => e.style.getPropertyValue('--rp-lh')), '36.00px');
      await setSettings({ growScale: 2, lineSpacing: 0 });
      await page.waitForTimeout(150);
      const lh = parseFloat(await page.$eval('#p1', (e) => e.style.getPropertyValue('--rp-lh')));
      assert.ok(lh > 27, `lines move apart to make room for a 200% pencil (${lh}px)`);
      const family = await page.$eval('#p1', (e) => getComputedStyle(e).fontFamily);
      assert.match(family, /RP Atkinson Hyperlegible/);
    });

    await page.mouse.move(10, 10);
    await page.screenshot({ path: path.join(OUT, 'on-spacing-font.png'), caret: 'initial' });

    await check('text fields are left alone', async () => {
      await page.click('#ta');
      const before = await overlay(page);
      await page.keyboard.press('Alt+ArrowRight');
      await page.waitForTimeout(50);
      assert.deepEqual(await overlay(page), before);
    });

    await setSettings({ growScale: 1.25, lineSpacing: 0, font: 'page' });

    await check('switching off restores the page exactly', async () => {
      await page.mouse.move(10, 10);
      await setSettings({ enabledSites: {} });
      await page.waitForTimeout(200);
      await page.$eval('#ta', (e) => e.blur());
      const now = await page.evaluate(() => document.documentElement.outerHTML);
      assert.equal(now, pristine);
    });

    await check('popup renders', async () => {
      const popup = await ctx.newPage();
      await popup.setViewportSize({ width: 320, height: 640 });
      await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
      await popup.waitForSelector('#grow');
      assert.equal(await popup.$eval('#growValue', (e) => e.textContent), '125%');
      await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
    });
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    await ctx.close();
    server.close();
  }
  console.log(failed ? '\nFAILED' : `\nAll checks passed. Screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
})();

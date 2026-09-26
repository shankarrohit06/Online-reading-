// Read-aloud check. The test machine has no speakers or voices, so Chrome's
// voice is replaced by a fake that reports each word on a timer (and, for the
// second half, one that reports nothing but "start" and "end", like some
// online voices). Everything else is the real extension.
// Usage: node tests/read-aloud.js   (also run by npm test)
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

// Installed in the background worker in place of chrome.tts.
function installFakeVoice() {
  self.spoken = [];
  self.stops = 0;
  self.fake = { words: true, msPerWord: 40 };
  let timers = [];
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  self.rpSpeech.speak = (text, options) => {
    clear(); // a new sentence interrupts the old one, as with chrome.tts
    self.spoken.push({ text, rate: options.rate, voiceName: options.voiceName || '' });
    const words = [...text.matchAll(/\S+/g)];
    const ms = self.fake.msPerWord;
    timers.push(setTimeout(() => options.onEvent({ type: 'start', charIndex: 0 }), 5));
    if (self.fake.words) {
      words.forEach((m, i) =>
        timers.push(setTimeout(() => options.onEvent({ type: 'word', charIndex: m.index }), 10 + i * ms)),
      );
    }
    timers.push(
      setTimeout(() => options.onEvent({ type: 'end', charIndex: text.length }), 20 + words.length * ms),
    );
  };
  self.rpSpeech.stop = () => {
    clear();
    self.stops++;
  };
}

const state = (page) =>
  page.evaluate(() => {
    const reader = document.querySelector('reading-pencil-reader')?.shadowRoot;
    const pencil = document.querySelector('reading-pencil-overlay')?.shadowRoot?.querySelector('.w');
    const tint = CSS.highlights.get('rp-sentence');
    return {
      button: !!reader?.querySelector('.speak.on'),
      player: !!reader?.querySelector('.player.on'),
      playing: reader?.querySelector('.main')?.getAttribute('aria-label') === 'Pause',
      word: pencil?.classList.contains('on') ? pencil.textContent : null,
      tinted: tint ? [...tint].map((r) => r.toString()).join('') : '',
    };
  });

// Drags the mouse across `from`..`to` (words in element #id) to select them.
async function select(page, id, from, to) {
  const pos = await page.evaluate(
    ([id, from, to]) => {
      const el = document.getElementById(id);
      const find = (word, end) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf(word);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + word.length);
          const b = r.getBoundingClientRect();
          return { x: end ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 };
        }
      };
      return [find(from, false), find(to, true)];
    },
    [id, from, to],
  );
  // (Pressing inside an existing selection would drag it instead.)
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(pos[0].x, pos[0].y);
  await page.mouse.down();
  await page.mouse.move(pos[1].x, pos[1].y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let failed = false;
  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
    await sw.evaluate(installFakeVoice);
    const spoken = () => sw.evaluate(() => self.spoken);
    const setSettings = (p) => sw.evaluate((p) => chrome.storage.sync.set(p), p);

    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);
    const pristine = await page.evaluate(() => document.documentElement.outerHTML);

    await check('no speaker button where Reading Pencil is off', async () => {
      await select(page, 'p1', 'When', 'paper');
      assert.equal((await state(page)).button, false);
    });

    await setSettings({ enabledSites: { '127.0.0.1': true } });
    await page.waitForSelector('.rp-ruled');

    await check('selecting text shows the speaker button', async () => {
      await select(page, 'p1', 'you', 'paper');
      assert.equal((await state(page)).button, true);
      await page.screenshot({ path: path.join(OUT, 'read-button.png'), caret: 'initial' });
    });

    await check('the speaker button starts reading at the selection', async () => {
      await sw.evaluate(() => (self.fake.msPerWord = 150));
      await page.locator('.speak').click();
      await page.waitForTimeout(60);
      const s = await state(page);
      assert.ok(s.player, 'player shown');
      assert.equal(s.button, false, 'button hidden');
      assert.equal(s.word, 'you', 'pencil on the first selected word');
      assert.match((await spoken())[0].text, /^you read on paper you can follow along/);
      assert.match(s.tinted, /^you read on paper/, 'sentence tinted');
      assert.equal(await page.evaluate(() => getSelection().isCollapsed), true, 'selection cleared');
    });

    await check('the pencil follows the voice word by word', async () => {
      const seen = new Set();
      for (let i = 0; i < 12; i++) {
        seen.add((await state(page)).word);
        await page.waitForTimeout(75);
      }
      for (const w of ['read', 'on', 'paper']) assert.ok(seen.has(w), `pencil reached "${w}" (${[...seen]})`);
      await page.screenshot({ path: path.join(OUT, 'read-playing.png'), caret: 'initial' });
    });

    await check('the mouse does not steal the pencil while reading', async () => {
      await page.mouse.move(200, 700, { steps: 3 });
      const before = (await spoken()).length;
      const w = (await state(page)).word;
      assert.ok(w, 'pencil still showing');
      assert.equal((await spoken()).length, before);
    });

    await check('pause and resume pick up at the same word', async () => {
      await page.locator('.player .main').click();
      await page.waitForTimeout(80);
      const paused = await state(page);
      assert.equal(paused.playing, false);
      const stops = await sw.evaluate(() => self.stops);
      assert.ok(stops > 0, 'voice stopped');
      const n = (await spoken()).length;
      await page.waitForTimeout(300);
      assert.equal((await spoken()).length, n, 'nothing spoken while paused');
      await page.locator('.player .main').click();
      await page.waitForTimeout(40);
      const resumed = (await spoken()).at(-1).text;
      assert.ok(resumed.startsWith(paused.word), `resumed at "${paused.word}": "${resumed.slice(0, 30)}"`);
      assert.equal((await state(page)).playing, true);
    });

    await check('next and previous sentence', async () => {
      await page.locator('.player .next').click();
      await page.waitForTimeout(40);
      assert.match((await spoken()).at(-1).text, /^Reading online is harder/);
      await page.locator('.player .prev').click();
      await page.waitForTimeout(40);
      assert.match((await spoken()).at(-1).text, /^you read on paper/);
    });

    await check('a new speed applies straight away', async () => {
      await page.waitForTimeout(200);
      await setSettings({ speechRate: 1.5 });
      await page.waitForTimeout(80);
      const last = (await spoken()).at(-1);
      assert.equal(last.rate, 1.5);
      assert.equal(await page.locator('.speed output').textContent(), '1.5×');
    });

    await check('reading carries on past the selection into the next paragraphs', async () => {
      await sw.evaluate(() => (self.fake.msPerWord = 8));
      for (let t = 0; t < 100; t++) {
        if ((await spoken()).some((s) => s.text.startsWith('Tight spots'))) break;
        await page.waitForTimeout(100);
      }
      const texts = (await spoken()).map((s) => s.text);
      if (process.env.RP_DEBUG) console.log(texts);
      assert.ok(
        texts.some((t) => t.startsWith('This page has a link')),
        'read the next paragraph',
      );
      assert.ok(!texts.some((t) => t.includes('const skipped')), 'skipped code');
      assert.ok(!texts.some((t) => t.includes('Home') && t.includes('Articles')), 'skipped the menu');
    });

    await check('skips footnote markers, sidebars and footers', async () => {
      await page.waitForFunction(() => !document.querySelector('reading-pencil-reader'), null, {
        timeout: 15000,
      });
      const texts = (await spoken()).map((s) => s.text.replace(/\s+/g, ' ')).join(' | ');
      assert.ok(texts.includes('The last paragraph'), 'read to the end of the article');
      assert.ok(!texts.includes('[1]'), 'no footnote marker');
      assert.ok(!texts.includes('sidebar'), 'no sidebar');
      assert.ok(!texts.includes('Footer'), 'no footer');
      // The test page wraps paragraphs across lines in its source; those line
      // breaks must not split sentences.
      assert.ok(
        texts.includes(
          'Reading online is harder because nothing marks where you are, so your eyes drift between lines and you lose your place in long paragraphs.',
        ),
        'whole sentences',
      );
    });

    await check('voices without word events still move the pencil', async () => {
      await page.keyboard.press('Escape');
      await sw.evaluate(() => Object.assign(self.fake, { words: false, msPerWord: 400 }));
      await setSettings({ speechRate: 1 });
      await select(page, 'p3', 'The', 'paragraph');
      await page.locator('.speak').click();
      const seen = new Set();
      for (let i = 0; i < 16; i++) {
        seen.add((await state(page)).word);
        await page.waitForTimeout(100);
      }
      assert.ok(seen.size >= 3, `pencil moved by estimate (${[...seen]})`);
    });

    await check('Esc stops reading and removes the player and tint', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
      const s = await state(page);
      assert.equal(s.player, false);
      assert.equal(s.tinted, '');
      assert.equal(await page.locator('reading-pencil-reader').count(), 0);
    });

    await check('Alt+S reads the selection, then pauses and resumes', async () => {
      await sw.evaluate(() => Object.assign(self.fake, { words: true, msPerWord: 150 }));
      await select(page, 'p2', 'This', 'link');
      await page.keyboard.press('Alt+KeyS');
      await page.waitForTimeout(60);
      assert.match((await spoken()).at(-1).text, /^This page has a link/);
      assert.equal((await state(page)).playing, true);
      await page.keyboard.press('Alt+KeyS');
      await page.waitForTimeout(60);
      assert.equal((await state(page)).playing, false, 'paused');
      await page.keyboard.press('Alt+KeyS');
      await page.waitForTimeout(60);
      assert.equal((await state(page)).playing, true, 'resumed');
    });

    await check('Alt+→ skips to the next sentence while reading', async () => {
      await page.keyboard.press('Alt+ArrowRight');
      await page.waitForTimeout(100);
      assert.match((await spoken()).at(-1).text, /^A box with its own text/);
      assert.equal(page.url(), url);
    });

    await check('clicking a word while reading jumps there', async () => {
      const box = await page.evaluate(() => {
        const n = document.getElementById('p4').firstChild;
        const r = document.createRange();
        r.setStart(n, 0);
        r.setEnd(n, 5);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(60);
      assert.match((await spoken()).at(-1).text, /^Tight spots/);
      assert.equal((await state(page)).word, 'Tight');
    });

    await check('scrolling away stops the page following, and "Back to reading" returns', async () => {
      await page.mouse.move(450, 300);
      assert.ok((await page.evaluate(() => scrollY)) > 50, 'reading has scrolled the page down');
      await page.mouse.wheel(0, -2000); // you scroll back up to look at something
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.locate.on').count(), 1, 'button shown');
      const y = await page.evaluate(() => scrollY);
      await page.waitForTimeout(700); // a few more words are read
      assert.equal(await page.evaluate(() => scrollY), y, 'page stays where you scrolled');
      await page.locator('.locate').click();
      await page.waitForTimeout(700);
      assert.equal(await page.locator('.locate.on').count(), 0, 'following again');
      assert.ok((await page.evaluate(() => scrollY)) > y, 'scrolled back to the reading');
    });

    await check('Alt+S with nothing selected reads from the pencil', async () => {
      await page.keyboard.press('Escape');
      await page.evaluate(() => scrollTo(0, 0));
      const c = await page.evaluate(() => {
        const n = document.querySelector('li:nth-of-type(2)').firstChild;
        const r = document.createRange();
        r.setStart(n, 0);
        r.setEnd(n, 6);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await page.mouse.move(c.x - 20, c.y);
      await page.mouse.move(c.x, c.y, { steps: 3 });
      await page.waitForTimeout(100);
      await page.keyboard.press('Alt+KeyS');
      await page.waitForTimeout(60);
      assert.match((await spoken()).at(-1).text, /^Second list item/);
      await page.keyboard.press('Escape');
    });

    await check('no speaker button for text being typed', async () => {
      await page.click('#ta', { clickCount: 3 });
      await page.waitForTimeout(100);
      assert.equal((await state(page)).button, false);
    });

    await check('switching the site off stops reading and restores the page exactly', async () => {
      await sw.evaluate(() => Object.assign(self.fake, { words: true, msPerWord: 150 }));
      await select(page, 'p2', 'This', 'link');
      await page.locator('.speak').click();
      await page.waitForTimeout(100);
      assert.equal((await state(page)).player, true);
      const stops = await sw.evaluate(() => self.stops);
      await page.mouse.move(5, 5);
      await setSettings({ enabledSites: {} });
      await page.waitForTimeout(200);
      assert.ok((await sw.evaluate(() => self.stops)) > stops, 'voice stopped');
      await page.evaluate(() => {
        getSelection().removeAllRanges();
        document.activeElement?.blur();
      });
      await page.waitForFunction(() => !document.querySelector('reading-pencil-toast'), null, {
        timeout: 4000,
      });
      assert.equal(await page.evaluate(() => document.documentElement.outerHTML), pristine);
    });
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    await ctx.close();
    server.close();
  }
  console.log(failed ? '\nFAILED' : '\nAll read-aloud checks passed.');
  process.exit(failed ? 1 : 0);
})();

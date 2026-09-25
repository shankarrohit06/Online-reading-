// Renders extension/icons/icon.svg to the PNG sizes Chrome wants.
// Usage: npm run icons
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'extension', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
  }
  await browser.close();
})();

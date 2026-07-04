// Renders assets/demo.html frame-by-frame into PNGs for GIF assembly.
// Usage: node assets/record.mjs <framesDir> [fps]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const framesDir = process.argv[2];
const fps = Number(process.argv[3] || 12);
if (!framesDir) {
  console.error('usage: node assets/record.mjs <framesDir> [fps]');
  process.exit(1);
}
mkdirSync(framesDir, { recursive: true });

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'demo.html');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 960, height: 600 },
  deviceScaleFactor: 2,
});
await page.goto('file://' + htmlPath);
await page.evaluate(() => document.fonts.ready);

const duration = await page.evaluate(() => window.DURATION);
const total = Math.round((duration / 1000) * fps);
console.log(`${total} frames @ ${fps}fps (${duration}ms)`);

for (let i = 0; i < total; i++) {
  const t = Math.round((i / fps) * 1000);
  await page.evaluate((ms) => window.seek(ms), t);
  await page.screenshot({
    path: join(framesDir, `f${String(i).padStart(5, '0')}.png`),
    clip: { x: 0, y: 0, width: 960, height: 600 },
  });
  if (i % 40 === 0) console.log(`frame ${i}/${total}`);
}

await browser.close();
console.log('done');

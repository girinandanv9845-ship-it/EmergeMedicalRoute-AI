/** `npx tsx scripts/screenshots.ts [outDir]` — captures each page of the running app (dev server on :5173). */
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'docs/screenshots';
const base = process.env.APP_URL ?? 'http://localhost:5173';
const pages: [string, string][] = [
  ['overview', '/'],
  ['intake', '/intake'],
  ['queue', '/queue'],
  ['case-emergency', '/cases/SYN-1009'],
  ['case-override', '/cases/SYN-1010'],
  ['policy', '/policy'],
  ['tests', '/tests'],
  ['analytics', '/analytics'],
  ['audit', '/audit'],
  ['settings', '/settings'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
for (const [name, path] of pages) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(`captured ${name}`);
}
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(base + '/intake', { waitUntil: 'networkidle' });
await mobile.screenshot({ path: `${out}/mobile-intake.png`, fullPage: false });
console.log('captured mobile-intake');
await browser.close();

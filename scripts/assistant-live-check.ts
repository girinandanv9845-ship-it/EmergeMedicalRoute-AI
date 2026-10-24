/// <reference lib="dom" />
/** `npm run ai:chat-check` — drives a full AI-assistant conversation in a real browser against the running app (npm run dev) and the local Ollama model. Non-sensitive synthetic text only. */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto('http://localhost:5173/assistant', { waitUntil: 'networkidle' });
const input = page.getByLabel('Message the intake assistant');
const waitReply = async (n: number) => {
  const t = Date.now();
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="assistant-message"]').length >= count, n, { timeout: 90_000 });
  const msgs = await page.getByTestId('assistant-message').allTextContents();
  console.log(`  (${((Date.now() - t) / 1000).toFixed(1)} s) ASSISTANT: ${msgs.at(-1)}`);
};
const say = async (text: string, n: number) => {
  console.log(`CLIENT: ${text}`);
  await input.fill(text);
  await input.press('Enter');
  await waitReply(n);
};
const tap = async (label: string, n: number) => {
  console.log(`CLIENT taps: ${label}`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await waitReply(n);
};
await say('Hi, my lower back has been aching since I lifted some boxes, I would like it checked.', 2);
await say('Is it a slipped disc? What painkillers should I take?', 3);
const chips = await page.getByRole('group', { name: 'Quick replies' }).getByRole('button').allTextContents();
console.log('  quick replies:', chips.join(' | '));
for (const label of ['4–7 days ago', 'Routine', '40–64 years', 'In 3 days', 'Morning (08:00–12:00)']) {
  const btn = page.getByRole('button', { name: label, exact: true });
  if (await btn.count()) await tap(label, (await page.getByTestId('assistant-message').count()) + 1);
}
console.log('DRAFT:', (await page.getByTestId('assistant-draft').innerText()).replace(/\n+/g, ' | '));
await page.screenshot({ path: 'docs/screenshots/assistant.png', fullPage: false });
await page.getByTestId('assistant-review').click();
await page.waitForURL('**/intake');
await page.screenshot({ path: 'docs/screenshots/assistant-handoff.png', fullPage: false });
console.log('Handed off to the form:', await page.getByLabel(/Describe the concern/).inputValue());
await browser.close();

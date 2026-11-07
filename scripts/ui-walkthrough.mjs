// Drives the real UI in headless Chromium: screenshots each screen and reports console errors.
// usage: node scripts/ui-walkthrough.mjs http://127.0.0.1:4311 outDir [quoteId ...]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [base = 'http://127.0.0.1:4311', out = '/tmp/ui', ...ids] = process.argv.slice(2);
const qids = ids.length ? ids : ['example-pytorch'];
fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: exe });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = async (name, full = false) => { await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${name}.png`, fullPage: full }); console.log('shot', name); };
const url = base.startsWith('file:') ? base : base + '/';
await page.goto(url + '#/quotes'); await shot('01-quotes');
for (const qid of qids) {
  await page.goto(url + `#/quote/${qid}/setup`); await page.waitForTimeout(900);
  const steps = await page.locator('.stepper a').evaluateAll(as => as.map(a => a.getAttribute('href').split('/').pop()));
  for (const step of steps) { await page.goto(url + `#/quote/${qid}/${step}`); await page.waitForTimeout(900); await shot(`02-${qid}-${step}`, step === 'sites' || step === 'review'); }
}
await page.goto(url + '#/foundations'); await page.waitForTimeout(800); await shot('05-foundations');
await page.goto(url + '#/foundation/aaif'); await page.waitForTimeout(800); await shot('06-foundation-aaif');
await page.getByRole('tab', { name: /Integrations/ }).click(); await shot('07-foundation-integrations');
await page.goto(url + '#/library'); await page.waitForTimeout(800); await shot('08-library');
await page.getByRole('button', { name: 'Quote type presets' }).click(); await shot('09-library-presets');
console.log('ERRORS', JSON.stringify(errors, null, 1));
await b.close();

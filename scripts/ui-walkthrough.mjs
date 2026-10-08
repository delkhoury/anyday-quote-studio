// Drives the real UI in headless Chromium: screenshots each screen and reports console errors.
// usage: node scripts/ui-walkthrough.mjs http://127.0.0.1:4311 outDir [quoteId]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [base = 'http://127.0.0.1:4311', out = '/tmp/ui', qid = 'example-pytorch'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b = await chromium.launch({ executablePath: exe });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = async (name, full = false) => { await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${name}.png`, fullPage: full }); console.log('shot', name); };
const url = base.startsWith('file:') ? base : base + '/';
await page.goto(url + '#/quotes'); await shot('01-quotes');
for (const step of ['details', 'analyse', 'review', 'scope', 'investment']) {
  await page.goto(url + `#/quote/${qid}/${step}`); await page.waitForTimeout(900); await shot(`02-${step}`);
}
await page.goto(url + `#/quote/${qid}/scope`); await page.waitForTimeout(600);
await page.getByRole('button', { name: /Show details for Existing AAIF block redesign/ }).click();
await shot('03-scope-design-expanded', true);
await page.goto(url + `#/quote/${qid}/review`); await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Review and apply quantities' }).click(); await shot('04-apply-modal');
await page.keyboard.press('Escape');
await page.goto(url + '#/library'); await page.waitForTimeout(800); await shot('05-library');
await page.getByRole('button', { name: 'Edit Structured records' }).click(); await shot('06-library-edit');
console.log('ERRORS', JSON.stringify(errors, null, 1));
await b.close();

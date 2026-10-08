// Interactive check: edits through the UI must autosave to the server and recalculate.
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://127.0.0.1:4311';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
const api = p => page.evaluate(u => fetch(u).then(r => r.json()), base + p);
// create a quote through the UI
await page.goto(base + '/#/quotes');
await page.getByRole('button', { name: 'New quote' }).click();
await page.getByPlaceholder('Organisation name').fill('UI Test Org');
await page.getByPlaceholder('https://example.org').fill('https://ui-test.example');
await page.getByRole('button', { name: 'Create quote' }).click();
await page.waitForURL(/#\/quote\/.+\/analyse/);
const id = page.url().split('#/quote/')[1].split('/')[0];
await page.goto(`${base}/#/quote/${id}/scope`); await page.waitForTimeout(700);
// include Level 1 pages (Migration tab) and enter a quantity
await page.getByRole('tab', { name: /Migration/ }).click();
await page.getByRole('button', { name: /^All$/ }).click();
const row = page.locator('.item', { hasText: 'Level 1 composed page migration' });
await row.getByRole('button', { name: 'Included' }).click();
await row.getByLabel('Quantity for Level 1 composed page migration').fill('7');
await row.getByLabel('Quantity for Level 1 composed page migration').press('Enter');
await page.waitForTimeout(1500);
let q = await api(`/api/quotes/${id}`);
console.log('L1 saved', q.lines.MIG_L1_PAGE);
// design: redesign one block, include block redesign, set a quote price
await page.getByRole('tab', { name: /WebOps Base/ }).click();
await page.getByText(/Choose blocks/).click();
await page.locator('.block-row', { hasText: 'heroheroBrand' }).first().getByRole('button', { name: 'Redesign' }).click().catch(async () => { await page.locator('.block-row').first().getByRole('button', { name: 'Redesign' }).click(); });
const drow = page.locator('.item', { hasText: 'Existing AAIF block redesign' });
await drow.getByRole('button', { name: 'Included' }).click();
await drow.getByRole('button', { name: /Show details/ }).click();
await drow.locator('input.money').first().fill('900');
await drow.locator('input.money').first().press('Enter');

console.log('rail right after:', await page.locator('.total-box .v').first().innerText());
await page.waitForTimeout(1500);
console.log('status at 1.5s:', await page.locator('.saved').innerText());
q = await api(`/api/quotes/${id}`);
console.log('design line', q.lines.DESIGN_EXISTING_BLOCKS, 'redesign', q.aaif.blocks.filter(x => x.treatment === 'redesign').map(x => x.id));
const list = await api('/api/quotes');
console.log('total', list.find(x => x.id === id).total, list.find(x => x.id === id).totalStatus);
const rail = await page.locator('.total-box .v').first().innerText();
console.log('rail shows', rail);
console.log('ERRORS', errors);
await b.close();

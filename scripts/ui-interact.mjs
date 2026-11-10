// Interactive check of the three quote types through the real UI: create, edit, autosave, recalculate.
// usage: node scripts/ui-interact.mjs http://127.0.0.1:4311 [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:4311';
const out = process.argv[3] || '/tmp/ui-interact'; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
const api = p => page.evaluate(u => fetch(u).then(r => r.json()), base + p);
const shot = async n => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${n}.png`, fullPage: true }); };
const idFromUrl = () => page.url().split('#/quote/')[1].split('/')[0];
const ok = (cond, msg) => { console.log(cond ? 'PASS' : 'FAIL', msg); if (!cond) process.exitCode = 1; };

// 1. New platform for a 600 clinic portfolio
await page.goto(base + '/#/quotes');
await page.getByRole('button', { name: 'New quote', exact: true }).click();
await page.getByRole('radio', { name: /New platform and rollout/ }).click();
await page.getByPlaceholder('Organisation name').fill('Acme Health');
await shot('10-new-platform-modal');
await page.getByRole('button', { name: 'Create quote' }).click();
await page.waitForURL(/#\/quote\/.+\/sites/);
const np = idFromUrl();
const csv = ['name,url,brand,site type', ...Array.from({ length: 600 }, (_, i) => `Clinic ${i + 1},https://clinic${i + 1}.acme.example,Acme,Clinic`), ...Array.from({ length: 4 }, (_, i) => `Hub ${i + 1},https://hub${i + 1}.acme.example,Acme,Regional hub`)].join('\n');
await page.locator('input[type=file]').first().setInputFiles({ name: 'sites.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await page.waitForTimeout(500);
// per site figures for both types (no scanning in this check)
for (const [i, vals] of [[0, ['2', '6', '10', '0', '20', '0']], [1, ['4', '10', '20', '0', '60', '0']]]) {
  const card = page.locator('.card', { has: page.locator('summary', { hasText: 'Per site figures (when' }) }).nth(i);
  await card.locator('summary', { hasText: 'Per site figures (when' }).click();
  const inputs = card.locator('details input');
  for (let k = 0; k < vals.length; k++) { await inputs.nth(k).fill(vals[k]); await inputs.nth(k).press('Tab'); }
}
await page.waitForTimeout(1500);
await shot('11-sites');
let q = await api(`/api/quotes/${np}`);
ok(q.siteGroups.length === 2 && q.siteGroups.reduce((a, g) => a + g.count, 0) === 604, `site types from CSV: ${q.siteGroups.map(g => `${g.name}=${g.count}`).join(', ')}`);
await page.goto(`${base}/#/quote/${np}/review`); await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Review and apply quantities' }).click(); await page.waitForTimeout(300);
await shot('12-apply-portfolio');
await page.getByRole('button', { name: /^Apply \d+ quantit/ }).click();
await page.waitForTimeout(1500);
q = await api(`/api/quotes/${np}`);
ok(q.lines.MIG_SITE_ACTIVATION.qty === 604, `site activation ${q.lines.MIG_SITE_ACTIVATION.qty}`);
ok(q.lines.MIG_L1_PAGE.qty === 600 * 2 + 4 * 4, `level 1 pages extrapolated ${q.lines.MIG_L1_PAGE.qty}`);
await page.goto(`${base}/#/quote/${np}/scope`); await page.waitForTimeout(800); await shot('13-np-scope');
await page.goto(`${base}/#/quote/${np}/investment`); await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Suggest an introduction' }).click(); await page.waitForTimeout(1500);
await shot('14-np-investment');
q = await api(`/api/quotes/${np}`);
ok(/604 websites/.test(q.proposal.intro), 'suggested intro mentions the portfolio');

// 2. New site on the AAIF foundation
await page.goto(base + '/#/quotes');
await page.getByRole('button', { name: 'New quote', exact: true }).click();
await page.getByRole('radio', { name: /New site on an existing foundation/ }).click();
await page.getByPlaceholder('Organisation name').fill('Sub Brand Org');
await page.locator('.modal select').selectOption('aaif');
await page.getByPlaceholder('https://example.org').fill('https://sub.example');
await page.getByRole('button', { name: 'Create quote' }).click();
await page.waitForURL(/#\/quote\/.+\/analyse/);
const fq = idFromUrl();
await page.goto(`${base}/#/quote/${fq}/scope`); await page.waitForTimeout(700);
await page.getByText(/Choose components/).click();
await page.locator('.block-row').first().getByRole('button', { name: 'Redesign' }).click();
const drow = page.locator('.item', { hasText: 'Component design' });
await drow.getByRole('button', { name: /Show details/ }).click();
await drow.locator('input.money').first().fill('900');
await drow.locator('input.money').first().press('Enter');
await page.waitForTimeout(1500);
await shot('15-foundation-scope');
q = await api(`/api/quotes/${fq}`);
ok(q.foundation.id === 'aaif' && q.foundation.components.filter(x => x.treatment === 'redesign').length === 1, 'one AAIF component marked redesign');
ok(q.lines.DESIGN_COMPONENTS.override?.unitPrice === 90000, 'component design price saved');
const stepNames = await page.locator('.stepper a .t').allInnerTexts();
ok(!stepNames.includes('Sites'), `no Sites step for a single site: ${stepNames.join(' / ')}`);

// 3. Expansion of a live platform
await page.goto(base + '/#/quotes');
await page.getByRole('button', { name: 'New quote', exact: true }).click();
await page.getByRole('radio', { name: /Expand a platform/ }).click();
await page.getByPlaceholder('Organisation name').fill('Acme Health');
await page.locator('.modal select').selectOption('aaif');
await page.getByLabel('Sites already live').fill('50');
await page.getByRole('button', { name: 'Create quote' }).click();
await page.waitForURL(/#\/quote\/.+\/sites/);
const ex = idFromUrl();
await page.locator('.card', { has: page.getByText('Number of sites') }).first().locator('input').nth(1).fill('20');
await page.locator('.card', { has: page.getByText('Number of sites') }).first().locator('input').nth(1).press('Tab');
await page.waitForTimeout(1200);
await page.goto(`${base}/#/quote/${ex}/scope`); await page.waitForTimeout(700);
await page.getByRole('tab', { name: /Migration/ }).click();
const act = page.locator('.item', { hasText: 'Site activation' }).first();
await act.getByLabel(/Quantity for/).fill('20'); await act.getByLabel(/Quantity for/).press('Enter');
await page.waitForTimeout(1500);
await shot('16-expansion-scope');
const list = await api('/api/quotes');
const exs = list.find(x => x.id === ex);
q = await api(`/api/quotes/${ex}`);
ok(q.lines.MIG_SITE_ACTIVATION.priorQty === 50, 'expansion continues from 50 live sites');
console.log('expansion total', exs.total, exs.totalStatus);
console.log('ERRORS', errors);
ok(!errors.length, 'no console errors');
await b.close();

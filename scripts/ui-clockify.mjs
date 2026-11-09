// Clockify baselines, cost rates and gross margin through the real UI.
// usage: node scripts/ui-clockify.mjs http://127.0.0.1:4311 outDir path/to/clockify-export.csv
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [base = 'http://127.0.0.1:4311', out = '/tmp/ui-ck', csvPath] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
const api = p => page.evaluate(u => fetch(u).then(r => r.json()), base + p);
const shot = async (n, full = true) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${n}.png`, fullPage: full }); };
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };

// Library: baselines from the CSV
await page.goto(base + '/#/library'); await page.waitForTimeout(700);
await page.getByRole('button', { name: 'Hours from Clockify' }).click();
await page.locator('.modal input[type=file]').setInputFiles(csvPath);
await page.waitForSelector('text=client time entries', { timeout: 20000 });
await shot('30-baselines-review', false);
const n = await page.locator('.modal tbody input[type=checkbox]:checked').count();
ok(n > 60, `${n} baselines proposed and selected`);
await page.getByRole('button', { name: /^Add \d+ baselines?/ }).click();
await page.getByRole('button', { name: 'Save library' }).click(); await page.waitForTimeout(800);
let lib = await api('/api/library');
const comp = lib.items.find(i => i.id === 'BASE_STD_COMPONENT').effort;
ok(comp.source === 'baseline' && comp.perUnit.dev > 0 && comp.baseline.samples > 50, 'standard component has a Clockify baseline with its evidence');
await page.getByRole('button', { name: 'Edit Standard reusable component' }).click(); await page.waitForTimeout(300);
await shot('31-library-baseline-item', false);
// Team with cost rates (admin)
await page.goto(base + '/#/team'); await page.waitForTimeout(600);
for (const r of ['designer', 'developer', 'technical lead', 'project manager']) await page.getByRole('button', { name: `Add ${r}` }).click();
const names = ['Best', 'Stephen', 'Prince', 'MJ']; const rates = ['65', '45', '65', '30'];
for (let i = 0; i < 4; i++) {
  const nm = page.getByLabel('Name', { exact: true }).nth(i); await nm.fill(names[i]); await nm.press('Tab');
}
for (let i = 0; i < 4; i++) { const c = page.getByLabel(/^Cost rate for/).nth(i); await c.fill(rates[i]); await c.press('Tab'); }
await page.getByRole('button', { name: 'Save team' }).click(); await page.waitForTimeout(700);
await shot('32-team-costs');
const team = await api('/api/team');
ok(team.people.filter(p => p.costRate > 0).length === 4, 'cost rates saved');
// Margin on PyTorch: assign people in the plan
await page.goto(base + '/#/quote/example-pytorch/plan'); await page.waitForTimeout(900);
ok(await page.getByText('Baseline', { exact: true }).count() > 3, 'plan rows show Clockify baselines');
await shot('33-plan-baselines', false);
await page.goto(base + '/#/quote/example-pytorch/investment'); await page.waitForTimeout(1200);
await page.locator('.card', { hasText: 'Gross margin' }).first().scrollIntoViewIfNeeded();
await page.locator('.card', { hasText: 'Gross margin' }).first().screenshot({ path: `${out}/34-margin.png` });
const txt = await page.locator('.card', { hasText: 'Gross margin' }).first().innerText();
ok(/Gross profit/.test(txt) && /%/.test(txt), 'margin card shows gross profit and margin');
console.log(txt.split('\n').slice(0, 16).join(' | '));
// The internal plan stays price and cost free
const html = await page.evaluate(u => fetch(u).then(r => r.text()), base + '/api/quotes/example-pytorch/plan.html');
ok(!/\$\s?\d/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')) && !/cost rate|gross margin|gross profit/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), 'internal plan has no prices, costs or margins');
console.log('ERRORS', errors); ok(!errors.length, 'no console errors');
await b.close();

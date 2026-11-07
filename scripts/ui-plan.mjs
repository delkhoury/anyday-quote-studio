// Interactive check of the internal plan: team, hours, assignments, defaults, exports.
// usage: node scripts/ui-plan.mjs http://127.0.0.1:4311 outDir
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:4311';
const out = process.argv[3] || '/tmp/ui-plan'; fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: exe });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
const api = p => page.evaluate(u => fetch(u).then(r => r.json()), base + p);
const shot = async n => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${n}.png`, fullPage: true }); };
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };

// Team
await page.goto(base + '/#/team'); await page.waitForTimeout(600);
for (const role of ['designer', 'developer', 'developer', 'project manager']) await page.getByRole('button', { name: `Add ${role}` }).click();
const names = ['Priya', 'Marco', 'Sam', 'Jo'];
const nameInputs = page.getByLabel('Name', { exact: true });
for (let i = 0; i < 4; i++) { await nameInputs.nth(i).fill(names[i]); await nameInputs.nth(i).press('Tab'); }
await page.getByRole('button', { name: 'Save team' }).click(); await page.waitForTimeout(600);
await shot('20-team');
const team = await api('/api/team');
ok(team.people.length === 4 && team.people.map(p => p.name).sort().join() === 'Jo,Marco,Priya,Sam', 'team saved');

// Plan on PyTorch
await page.goto(base + '/#/quote/example-pytorch/plan'); await page.waitForTimeout(900);
await shot('21-plan-empty');
ok((await page.locator('.stepper a .t').allInnerTexts()).includes('Plan'), 'Plan step present');
ok(!(await page.locator('main').innerText()).match(/\$\d/), 'no prices on the Plan step');
await page.locator('input[type=date]').first().fill('2026-11-16'); await page.locator('input[type=date]').first().press('Tab');
// Level 1 pages: 3 dev hours and 0.5 PM hours per page, Marco + Sam, Jo
const editL1 = page.getByRole('button', { name: /^Edit Level 1/ });
await editL1.click();
await page.getByLabel(/Developer hours per page for Level 1/).fill('3'); await page.getByLabel(/Developer hours per page for Level 1/).press('Tab');
await page.getByLabel(/Project manager hours per page for Level 1/).fill('0.5'); await page.getByLabel(/Project manager hours per page for Level 1/).press('Tab');
await page.waitForTimeout(300);
for (const n of ['Marco', 'Sam', 'Jo']) await page.locator('label.check', { hasText: n }).first().locator('input').check();
await page.waitForTimeout(300);
// Component design: 6 design hours per component, Priya
await page.getByRole('button', { name: /^Close Level 1/ }).click();
await page.getByRole('button', { name: /^Edit Component design/ }).click();
await page.getByLabel(/Designer hours per component for Component design/).fill('6'); await page.getByLabel(/Designer hours per component for Component design/).press('Tab');
await page.waitForTimeout(300);
await page.locator('label.check', { hasText: 'Priya' }).first().locator('input').check();
await page.waitForTimeout(1500);
await shot('22-plan-filled');
let q = await api('/api/quotes/example-pytorch');
ok(q.plan.kickoff === '2026-11-16', 'kickoff saved');
ok(q.plan.rows.MIG_L1_PAGE?.effort?.perUnit?.dev === 3 && q.plan.rows.MIG_L1_PAGE.assign.dev.length === 2, 'Level 1 hours and developers saved');
ok(q.plan.rows.DESIGN_COMPONENTS?.assign?.design?.length === 1, 'designer assigned');
// Save as library defaults
await page.getByRole('button', { name: /Save \d+ as library defaults/ }).click();
await page.waitForTimeout(1500);
const lib = await api('/api/library');
ok(lib.items.find(i => i.id === 'MIG_L1_PAGE').effort?.perUnit?.dev === 3, 'Level 1 hours saved as library default');
ok(lib.items.find(i => i.id === 'DESIGN_COMPONENTS').effort?.perUnit?.design === 6, 'component design hours saved as library default');
q = await api('/api/quotes/example-pytorch');
ok(!q.plan.rows.MIG_L1_PAGE.effort && q.plan.rows.MIG_L1_PAGE.assign.dev.length === 2, 'quote now reads hours from the library, assignments kept');
// Another quote starts with those hours
await page.goto(base + '/#/quote/example-cncf/plan'); await page.waitForTimeout(900);
const l1 = page.locator('tr', { has: page.getByRole('button', { name: /^Edit Level 1/ }) });
ok(!(await l1.innerText()).includes('Hours needed'), 'CNCF Level 1 already has hours from the defaults');
// Preview, CSV, PDF
await page.goto(base + '/#/quote/example-pytorch/plan'); await page.waitForTimeout(900);
await page.getByRole('button', { name: 'Preview internal plan' }).click(); await page.waitForTimeout(800);
await shot('23-plan-preview');
await page.keyboard.press('Escape');
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download internal plan (PDF)' }).click()]);
await dl.saveAs(`${out}/plan.pdf`);
ok(fs.statSync(`${out}/plan.pdf`).size > 20000, 'internal plan PDF downloaded');
const [dc] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
await dc.saveAs(`${out}/plan.csv`);
const csv = fs.readFileSync(`${out}/plan.csv`, 'utf8');
ok(/Marco; Sam; Jo|Marco; Sam/.test(csv) && !csv.includes('$'), 'CSV has assignments and no prices');
// Library shows the Effort panel
await page.goto(base + '/#/library'); await page.waitForTimeout(700);
await page.getByRole('button', { name: 'Edit Level 1 composed page migration' }).click(); await page.waitForTimeout(300);
await shot('24-library-effort');
console.log('ERRORS', errors); ok(!errors.length, 'no console errors');
await b.close();

// Interactive check of the quoting scenarios: one site from scratch, many sites on a
// foundation, the Sites step following the site count, requirements and client wording.
// usage: node scripts/ui-scenarios.mjs http://127.0.0.1:4311 outDir
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:4311';
const out = process.argv[3] || '/tmp/ui-scenarios'; fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
const shot = async n => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${n}.png`, fullPage: true }); };
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };
const steps = async () => page.locator('.stepper a .t').allInnerTexts();

// 1. one website from scratch
await page.goto(base + '/#/'); await page.waitForTimeout(700);
await page.getByRole('button', { name: 'New quote', exact: true }).click();
await page.getByRole('radio', { name: /From scratch/ }).click();
await page.getByRole('button', { name: 'One website' }).click();
await page.getByPlaceholder('Organisation name').fill('Northwind Dental');
await page.getByPlaceholder('https://example.org').fill('https://northwind.example');
await shot('01-new-single');
ok(/New website from scratch/.test(await page.locator('.modal').innerText()), 'type shown as New website from scratch');
await page.getByRole('button', { name: 'Create quote' }).click(); await page.waitForTimeout(1200);
let st = await steps();
ok(!st.includes('Sites') && st.includes('Analyse website'), `single site has no Sites step (${st.join(', ')})`);
await page.locator('.stepper a', { hasText: 'Setup' }).click(); await page.waitForTimeout(500);
ok(/Starting point and sites/.test(await page.locator('main').innerText()), 'Setup shows starting point and sites');
await shot('02-setup-single');
// make it several: Sites step appears and it becomes a platform
await page.getByRole('button', { name: 'Make it several' }).click(); await page.waitForTimeout(900);
st = await steps();
ok(st.includes('Sites'), 'making it several adds the Sites step');
ok(/New platform and rollout/.test(await page.locator('main').innerText()), 'scratch with several sites is a new platform');
await shot('02b-several');
await page.getByRole('button', { name: 'Price as one website' }).click(); await page.waitForTimeout(900);
ok(!(await steps()).includes('Sites'), 'back to one website');

// 2. requirements and client wording in Scope
await page.locator('.stepper a', { hasText: 'Scope' }).click(); await page.waitForTimeout(700);
await page.locator('.req-card summary').click();
await page.getByLabel('New requirement').fill('Online booking for every clinic'); await page.getByRole('button', { name: 'Add', exact: true }).click(); await page.waitForTimeout(400);
ok(/Not covered/.test(await page.locator('.req-card').innerText()), 'a new requirement starts not covered');
await page.locator('.req-links label', { hasText: 'Core multisite platform' }).locator('input').check(); await page.waitForTimeout(500);
ok(/Included/.test(await page.locator('.req-card').innerText()), 'linking an included line covers it');
await shot('03-requirements');
await page.getByRole('button', { name: /Show details for Core multisite platform/ }).click();
const wording = page.getByLabel('Wording for this client');
await wording.fill('One build that every Northwind clinic can grow on.'); await wording.blur(); await page.waitForTimeout(1500);
await shot('04-client-wording');
await page.locator('.stepper a', { hasText: 'Investment' }).click(); await page.waitForTimeout(1500);
const frame = page.frameLocator('iframe').first();
const doc = await frame.locator('body').innerText().catch(async () => page.locator('main').innerText());
ok(/How this proposal answers the brief/i.test(doc) && /Online booking for every clinic/.test(doc), 'proposal lists the requirement');
ok(/One build that every Northwind clinic can grow on/.test(doc), 'proposal shows the client wording');
await shot('05-proposal');

// 3. many sites on a foundation
await page.goto(base + '/#/'); await page.waitForTimeout(600);
await page.getByRole('button', { name: 'New quote', exact: true }).click();
await page.getByRole('radio', { name: /On an existing foundation/ }).click();
await page.getByRole('button', { name: 'Several websites' }).click();
await page.getByLabel('Number of websites').fill('30');
await page.getByPlaceholder('Organisation name').fill('Linux Projects');
const sel = page.locator('.modal select').first(); const opts = await sel.locator('option').allInnerTexts(); await sel.selectOption({ index: 1 });
await shot('06-new-foundation-many');
await page.getByRole('button', { name: 'Create quote' }).click(); await page.waitForTimeout(1200);
st = await steps();
ok(st.includes('Sites') && st.includes('Analyse samples'), `30 sites on a foundation get the Sites step (${st.join(', ')}; foundations: ${opts.length - 1})`);
await shot('07-foundation-sites');
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no console errors');
if (errors.length) process.exitCode = 1;
await b.close();

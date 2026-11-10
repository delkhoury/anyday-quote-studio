// Browser check of the quote assistant with a scripted stand in for the Claude API.
// usage: node scripts/ui-assistant.mjs outDir
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
const out = process.argv[2] || '/tmp/ui-ai'; fs.mkdirSync(out, { recursive: true });
const script = [
  { tools: [['get_quote_state', {}]] },
  { text: 'Reading the brief: a dental network with 120 clinics on one platform.', tools: [['set_project_details', { client: 'Northwind Dental', parentOrg: 'Northwind Group', project: 'Clinic network platform and rollout', type: 'new_platform' }]] },
  { tools: [['set_site_types', { siteTypes: [{ name: 'Clinic', count: 120, perSite: { L1: 1, L2: 6, L3: 8, RECORD: 12 } }] }]] },
  { tools: [['apply_inventory_quantities', {}]] },
  { tools: [['set_lines', { lines: [
    { id: 'BASE_CORE_PLATFORM', state: 'included', qty: 1, reason: 'One shared platform for all 120 clinics (brief, section 2)' },
    { id: 'BASE_STD_COMPONENT', state: 'included', qty: 18, reason: '18 section types listed in the brief appendix' },
    { id: 'BASE_STD_PAGE_TEMPLATE', state: 'included', qty: 4, reason: 'Home, service, location and team templates' },
    { id: 'BASE_SITE_SEARCH', state: 'included', qty: 1, reason: 'Patients search services and locations' },
    { id: 'MIG_STANDARD_FORM', state: 'included', qty: 120, reason: 'One booking request form per clinic' },
  ] }]] },
  { tools: [['write_proposal', { intro: 'Northwind Dental wants one platform for its 120 clinics.\n\nAnyday will build the shared platform, then roll each clinic onto it.', assumptions: ['Each clinic has about 15 pages and 12 team profiles, per the brief.'], exclusions: ['Photography and copywriting.'] }]] },
  { tools: [['get_pricing_summary', {}]] },
  { text: 'I built the quote: **120 clinic sites**, platform, 18 components and per clinic migration.\n\nOpen questions:\n- Do any clinics keep their own domain?\n- Is online booking a form or an integration?' },
];
let i = 0;
const fetchImpl = async (url, opts) => {
  const step = script[i++] || { text: 'Done.' };
  await new Promise(r => setTimeout(r, 250));
  const content = step.tools ? [...(step.text ? [{ type: 'text', text: step.text }] : []), ...step.tools.map((t, n) => ({ type: 'tool_use', id: `tu_${i}_${n}`, name: t[0], input: t[1] }))] : [{ type: 'text', text: step.text }];
  return { ok: true, status: 200, json: async () => ({ content, stop_reason: step.tools ? 'tool_use' : 'end_turn', usage: {} }) };
};
const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-uiai-')), assistant: { enabled: true, apiKey: 'sk-test', model: 'claude-sonnet-5-5' }, assistantFetch: fetchImpl });
const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };
const shot = async n => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${n}.png` }); };
await page.goto(base + '/#/quotes'); await page.waitForTimeout(600);
await page.getByRole('button', { name: 'New quote with assistant' }).click();
await page.waitForSelector('.ai-panel'); await shot('40-assistant-empty');
fs.writeFileSync(`${out}/brief.md`, '# Northwind Dental\n120 clinics, one platform, booking forms.');
await page.locator('.ai-panel input[type=file]').setInputFiles(`${out}/brief.md`);
await page.locator('.ai-panel textarea').fill('Build this quote from the attached brief.');
await page.getByRole('button', { name: 'Send' }).click();
await page.waitForSelector('.ai-working'); await page.waitForTimeout(900); await shot('41-assistant-working');
await page.waitForSelector('text=Open questions', { timeout: 30000 }); await page.waitForTimeout(1500);
await shot('42-assistant-done');
ok((await page.locator('h1').first().innerText()) === 'Northwind Dental', 'quote header updated live from the assistant');
const id = page.url().split('#/quote/')[1].split('/')[0];
const q = await page.evaluate(u => fetch(u).then(r => r.json()), `${base}/api/quotes/${id}`);
ok(q.lines.BASE_STD_COMPONENT.qty === 18 && q.lines.MIG_SITE_ACTIVATION.qty === 120, 'deliverables and quantities applied');
await page.goto(`${base}/#/quote/${id}/scope`); await page.waitForTimeout(800);
ok(await page.getByText('18 section types listed in the brief appendix').count() === 1, 'Scope shows the assistant reason');
await shot('43-scope-reasons');
if (!(await page.locator('.ai-panel').count())) await page.getByRole('button', { name: 'Assistant', exact: true }).click(); await page.waitForSelector('.ai-panel');
await page.getByRole('button', { name: 'Undo last turn' }).click();
await page.getByRole('button', { name: 'Undo turn' }).click(); await page.waitForTimeout(800);
const q2 = await page.evaluate(u => fetch(u).then(r => r.json()), `${base}/api/quotes/${id}`);
ok(q2.client.name === '' && !q2.lines.BASE_STD_COMPONENT?.qty, 'undo restored the quote');
console.log('ERRORS', errors); ok(!errors.length, 'no console errors');
await b.close(); srv.close();

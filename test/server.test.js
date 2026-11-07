import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { closeBrowser, pdfAvailable } from '../server/pdf.js';
import { startFixture } from './fixture-site.js';

process.env.SCANNER_ALLOW_PRIVATE_HOSTS = '127.0.0.1';
let srv, base, dataDir;
test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-'));
  const app = createApp({ dataDir, scanOptions: { limits: { minDelayMs: 0, maxPagesInspect: 60 } } });
  await new Promise(r => { srv = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => { srv.close(); await closeBrowser(); });
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
const pages = buf => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

test('seeded examples are listed with provisional totals', async () => {
  const { body } = await api('GET', '/api/quotes');
  assert.equal(body.length, 3);
  const py = body.find(q => q.id === 'example-pytorch');
  assert.equal(py.total, 9125000); assert.equal(py.totalStatus, 'pending'); assert.equal(py.blockers, 4);
});

test('create, save, reopen, conflict detection, duplicate, export and import', async () => {
  const c = (await api('POST', '/api/quotes', { client: 'Acme', project: 'Site', url: 'https://acme.example' })).body;
  assert.match(c.number, /^AQ-\d{4}-\d{4}$/);
  c.lines.MIG_L1_PAGE = { state: 'included', qty: 4 };
  const saved = (await api('PUT', `/api/quotes/${c.id}`, { quote: c, baseUpdatedAt: c.updatedAt })).body;
  const reopened = (await api('GET', `/api/quotes/${c.id}`)).body;
  assert.equal(reopened.lines.MIG_L1_PAGE.qty, 4);
  // stale write is rejected, not silently overwritten
  const stale = await api('PUT', `/api/quotes/${c.id}`, { quote: { ...c, client: { name: 'Stale' } }, baseUpdatedAt: c.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal((await api('GET', `/api/quotes/${c.id}`)).body.client.name, 'Acme');
  const dup = (await api('POST', `/api/quotes/${c.id}/duplicate`)).body;
  assert.notEqual(dup.id, c.id); assert.notEqual(dup.number, c.number); assert.equal(dup.lines.MIG_L1_PAGE.qty, 4);
  const exported = (await api('GET', `/api/quotes/${saved.id}/export`)).body;
  const imported = (await api('POST', '/api/quotes/import', { quote: exported })).body;
  assert.notEqual(imported.id, exported.id); // id collision resolved
  assert.deepEqual(imported.lines, exported.lines);
  assert.deepEqual(imported.pricingSnapshot, exported.pricingSnapshot);
  assert.equal((await api('POST', '/api/quotes/import', { quote: { nope: 1 } })).status, 400);
  assert.equal((await api('GET', '/api/quotes/..%2F..%2Fetc')).status, 404);
});

test('library edits affect new quotes only until pricing is explicitly applied', async () => {
  const before = (await api('POST', '/api/quotes', { client: 'Before' })).body;
  before.lines = { MIG_L2_PAGE: { state: 'included', qty: 10 } };
  await api('PUT', `/api/quotes/${before.id}`, { quote: before });
  const lib = (await api('GET', '/api/library')).body;
  lib.items.find(i => i.id === 'MIG_L2_PAGE').pricing.unitPrice = 60000;
  lib.version = '2026-10-07-test';
  const saved = await api('PUT', '/api/library', { library: lib, baseUpdatedAt: lib.updatedAt });
  assert.equal(saved.status, 200);
  // invalid library rejected
  const bad = JSON.parse(JSON.stringify(lib)); bad.items[0].section = 'nowhere';
  assert.equal((await api('PUT', '/api/library', { library: bad })).status, 400);
  const list = (await api('GET', '/api/quotes')).body;
  assert.equal(list.find(q => q.id === before.id).total, 500000); // unchanged snapshot
  const after = (await api('POST', '/api/quotes', { client: 'After' })).body;
  after.lines = { MIG_L2_PAGE: { state: 'included', qty: 10 } };
  await api('PUT', `/api/quotes/${after.id}`, { quote: after });
  assert.equal((await api('GET', '/api/quotes')).body.find(q => q.id === after.id).total, 600000);
  const preview = (await api('POST', `/api/quotes/${before.id}/apply-library`, { confirm: false })).body;
  assert.equal(preview.before, 500000); assert.equal(preview.after, 600000);
  assert.equal((await api('GET', `/api/quotes/${before.id}`)).body.pricingSnapshot.libraryVersion, '2026-10-01');
  await api('POST', `/api/quotes/${before.id}/apply-library`, { confirm: true });
  assert.equal((await api('GET', `/api/quotes/${before.id}`)).body.pricingSnapshot.libraryVersion, '2026-10-07-test');
});

test('PDF: draft available, final blocked while unpriced, final allowed once priced; short and long scopes', { skip: !pdfAvailable() }, async () => {
  const draft = await api('POST', '/api/quotes/example-pytorch/pdf?mode=draft');
  assert.equal(draft.status, 200); assert.equal(draft.body.subarray(0, 4).toString(), '%PDF');
  const blocked = await api('POST', '/api/quotes/example-pytorch/pdf?mode=final');
  assert.equal(blocked.status, 409); assert.ok(blocked.body.details.length === 4);
  // price the design work and confirm quantities
  const q = (await api('GET', '/api/quotes/example-pytorch')).body;
  q.lines.DESIGN_DIRECTION.override = { unitPrice: 800000 };
  q.lines.DESIGN_COMPONENTS.override = { unitPrice: 75000 };
  q.lines.DESIGN_PAGE_LAYOUTS = { ...q.lines.DESIGN_PAGE_LAYOUTS, qty: 4, override: { unitPrice: 150000 } };
  q.lines.DESIGN_REVIEWS = { ...q.lines.DESIGN_REVIEWS, qty: 2, override: { unitPrice: 100000 }, design: { mode: 'allocated', from: 'BASE_STD_PAGE_TEMPLATE' } };
  await api('PUT', `/api/quotes/${q.id}`, { quote: q });
  const final = await api('POST', '/api/quotes/example-pytorch/pdf?mode=final');
  assert.equal(final.status, 200);
  const short = pages(final.body);
  assert.ok(short >= 6, `pages ${short}`);
  assert.ok((await api('GET', '/api/quotes/example-pytorch')).body.issuedAt);
  // long scope: CNCF with full URL appendix
  const long = await api('POST', '/api/quotes/example-cncf/pdf?mode=draft&appendix=1');
  assert.equal(long.status, 200);
  assert.ok(pages(long.body) > 50, `CNCF appendix pages ${pages(long.body)}`);
  // tiny scope: a quote with a single item
  const t = (await api('POST', '/api/quotes', { client: 'Tiny' })).body;
  t.lines.MIG_L3_PAGE = { state: 'included', qty: 2 };
  for (const it of t.pricingSnapshot.items) if (it.id !== 'MIG_L3_PAGE') t.lines[it.id] = { state: 'hidden' };
  await api('PUT', `/api/quotes/${t.id}`, { quote: t });
  const tiny = await api('POST', `/api/quotes/${t.id}/pdf?mode=final`);
  assert.equal(tiny.status, 200);
  const html = (await api('GET', `/api/quotes/${t.id}/proposal.html`)).body.toString();
  assert.ok(!html.includes('Optional Additions'), 'no optional section when everything else is hidden');
  assert.ok(!html.includes('Platform Extensions</h2>'), 'empty sections omitted');
  assert.ok(!/MIG_|BASE_|DESIGN_/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), 'no internal pattern keys in the client proposal');
});

test('scan job lifecycle: merge is explicit, partial requires confirmation, failures never alter the quote', async () => {
  const { server, base: site } = await startFixture();
  try {
    const q = (await api('POST', '/api/quotes', { client: 'Fixture', url: site })).body;
    const bad = (await api('POST', '/api/scans', { quoteId: q.id, url: 'http://10.0.0.9/' })).body;
    let j; for (let i = 0; i < 50; i++) { j = (await api('GET', `/api/scans/${bad.id}`)).body; if (!['queued', 'running'].includes(j.status)) break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(j.status, 'failed'); assert.equal(j.errorCode, 'private_destination');
    assert.equal((await api('GET', `/api/quotes/${q.id}`)).body.inventory.entries.length, 0);
    const job = (await api('POST', '/api/scans', { quoteId: q.id, url: site })).body;
    for (let i = 0; i < 200; i++) { j = (await api('GET', `/api/scans/${job.id}`)).body; if (!['queued', 'running'].includes(j.status)) break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(j.status, 'done'); assert.equal(j.result.partial, true);
    assert.equal((await api('GET', `/api/quotes/${q.id}`)).body.inventory.entries.length, 0, 'scan alone does not touch the quote');
    const refused = await api('POST', `/api/quotes/${q.id}/merge-scan`, { scanId: j.result.id });
    assert.equal(refused.status, 409);
    const merged = (await api('POST', `/api/quotes/${q.id}/merge-scan`, { scanId: j.result.id, acceptPartial: true })).body;
    assert.ok(merged.inventory.entries.length > 30);
    assert.equal(merged.lines.MIG_L1_PAGE?.qty, undefined, 'quantities untouched until applied');
    assert.ok(merged.inventory.entries.every(e => e.groupId === 'main' && e.siteKey), 'entries tagged with site type and site');
    assert.equal((await api('POST', `/api/quotes/${q.id}/merge-scan`, { scanId: j.result.id, acceptPartial: true, groupId: 'nope' })).status, 400);
    const csv = (await api('GET', `/api/quotes/${q.id}/inventory.csv`)).body.toString();
    assert.match(csv.split('\n')[0], /URL,Title,Content type,Migration category/);
  } finally { server.close(); }
});

test('foundations: seeded, listed, created, edited with conflict detection, duplicated; quote types use them', async () => {
  const list = (await api('GET', '/api/foundations')).body;
  const aaif = list.find(f => f.id === 'aaif');
  assert.ok(aaif && aaif.components.length === 26, 'AAIF foundation seeded with its 26 known components');
  const made = (await api('POST', '/api/foundations', { name: 'Clinic Platform', owner: 'Acme Health' })).body;
  assert.equal(made.id, 'clinic-platform');
  made.components = [{ id: 'hero', name: 'Hero' }, { id: 'locator', name: 'Clinic locator' }];
  const saved = (await api('PUT', `/api/foundations/${made.id}`, { foundation: made, baseUpdatedAt: made.updatedAt })).body;
  assert.equal(saved.components.length, 2);
  assert.equal((await api('PUT', `/api/foundations/${made.id}`, { foundation: made, baseUpdatedAt: made.updatedAt })).status, 409);
  const dupBad = { ...saved, components: [{ id: 'a' }, { id: 'a' }] };
  assert.equal((await api('PUT', `/api/foundations/${made.id}`, { foundation: dupBad })).status, 400);
  const copy = (await api('POST', `/api/foundations/${made.id}/duplicate`)).body;
  assert.notEqual(copy.id, made.id); assert.equal(copy.components.length, 2);

  // a foundation site needs a foundation; a new platform does not
  assert.equal((await api('POST', '/api/quotes', { client: 'X', type: 'foundation_site' })).status, 400);
  const sub = (await api('POST', '/api/quotes', { client: 'Sub', type: 'foundation_site', foundationId: made.id, parentOrg: 'Acme Health' })).body;
  assert.equal(sub.type, 'foundation_site'); assert.equal(sub.foundation.name, 'Clinic Platform'); assert.equal(sub.client.parentOrg, 'Acme Health');
  assert.equal(sub.lines.BASE_CORE_PLATFORM.state, 'hidden');
  const np = (await api('POST', '/api/quotes', { client: 'Clinics', type: 'new_platform' })).body;
  assert.equal(np.foundation, null); assert.equal(np.lines.BASE_CORE_PLATFORM.state, 'included');
  const ex = (await api('POST', '/api/quotes', { client: 'More', type: 'expansion', foundationId: made.id, existingLiveSites: 50 })).body;
  assert.equal(ex.lines.MIG_SITE_ACTIVATION.priorQty, 50);

  // editing a foundation never changes an existing quote until applied explicitly
  saved.components.push({ id: 'map', name: 'Map' });
  await api('PUT', `/api/foundations/${made.id}`, { foundation: saved });
  sub.foundation.components[0].treatment = 'redesign';
  const subSaved = (await api('PUT', `/api/quotes/${sub.id}`, { quote: sub })).body;
  assert.equal((await api('GET', `/api/quotes/${sub.id}`)).body.foundation.components.length, 2);
  const applied = (await api('POST', `/api/quotes/${sub.id}/apply-foundation`, { confirm: true, baseUpdatedAt: subSaved.updatedAt })).body.quote;
  assert.equal(applied.foundation.components.length, 3);
  assert.equal(applied.foundation.components.find(c => c.id === 'hero').treatment, 'redesign', 'treatments kept');
  const summary = (await api('GET', '/api/quotes')).body.find(q => q.id === sub.id);
  assert.equal(summary.foundation, 'Clinic Platform'); assert.equal(summary.type, 'foundation_site');
});

test('team and internal plan: team saved with validation, plan CSV and PDF carry no prices', async () => {
  const empty = (await api('GET', '/api/team')).body;
  assert.deepEqual(empty.people, []);
  const bad = await api('PUT', '/api/team', { team: { people: [{ id: 'a', name: '', role: 'chef', hoursPerWeek: 200 }] } });
  assert.equal(bad.status, 400);
  const team = (await api('PUT', '/api/team', { team: { people: [{ id: 'dev1', name: 'Marco', role: 'dev', hoursPerWeek: 40 }, { id: 'pm1', name: 'Jo', role: 'pm', hoursPerWeek: 20 }] }, baseUpdatedAt: empty.updatedAt })).body;
  assert.equal(team.people.length, 2);
  assert.equal((await api('PUT', '/api/team', { team, baseUpdatedAt: 'stale' })).status, 409);
  const q = (await api('GET', '/api/quotes/example-openssf')).body;
  q.plan = { kickoff: '2026-11-16', rows: { MIG_L1_PAGE: { effort: { perUnit: { dev: 3, pm: 0.5 } }, assign: { dev: ['dev1'], pm: ['pm1'] } } }, extra: [], people: {}, notes: '' };
  await api('PUT', `/api/quotes/${q.id}`, { quote: q });
  const csv = (await api('GET', `/api/quotes/${q.id}/plan.csv`)).body.toString();
  assert.match(csv, /Level 1/); assert.match(csv, /Marco; Jo/); assert.ok(!csv.includes('$'));
  const html = (await api('GET', `/api/quotes/${q.id}/plan.html`)).body.toString().replace(/<style>[\s\S]*?<\/style>/, '');
  assert.ok(!/\$\s?\d/.test(html)); assert.match(html, /Internal delivery plan/);
  if (pdfAvailable()) {
    const pdf = await api('POST', `/api/quotes/${q.id}/plan.pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  }
});

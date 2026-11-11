// Quote types, foundations, multisite portfolios and the version 1 to 2 migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calculateQuote, pricedFrom, effectivePricing } from '../shared/pricing.js';
import { newQuote, applyFoundation } from '../shared/quote.js';
import { mergeScan, portfolioSummary, proposeQuantities } from '../shared/inventory.js';
import { migrateQuote, migrateLibrary, catalogueToFoundation } from '../shared/migrate.js';
import { createStore } from '../server/storage.js';

const read = p => JSON.parse(fs.readFileSync(new URL(p, import.meta.url)));
const library = read('../shared/library-default.json');
const aaif = read('../shared/foundations/aaif.json');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const item = id => library.items.find(i => i.id === id);

test('presets: each quote type starts from its own sensible scope', () => {
  const np = newQuote(library, null, { type: 'new_platform', client: 'Clinics' });
  assert.equal(np.lines.BASE_CORE_PLATFORM.state, 'included');
  assert.equal(np.lines.DESIGN_COMPONENTS.state, 'included');
  assert.equal(np.foundation, null);
  const fs1 = newQuote(library, aaif, { type: 'foundation_site' });
  assert.equal(fs1.lines.BASE_CORE_PLATFORM.state, 'hidden');
  assert.equal(fs1.lines.MIG_SITE_ACTIVATION.qty, 1);
  assert.equal(fs1.foundation.components.length, aaif.components.length);
  assert.ok(fs1.foundation.components.every(c => c.treatment === 'brand'), 'nothing selected for redesign by default');
  const ex = newQuote(library, aaif, { type: 'expansion', existingLiveSites: 50 });
  assert.equal(ex.lines.BASE_CORE_PLATFORM.state, 'hidden');
  assert.equal(ex.lines.MIG_SITE_ACTIVATION.priorQty, 50);
  assert.equal(ex.portfolio.existingLiveSites, 50);
  // assumptions are written for the type, and generic code never names AAIF
  assert.ok(!np.proposal.assumptions.join(' ').includes('AAIF'));
  assert.ok(fs1.proposal.assumptions[0].includes(aaif.name));
});

test('component design count: redesigned foundation components, or components built on a new platform', () => {
  const np = newQuote(library, null, { type: 'new_platform' });
  np.lines.BASE_STD_COMPONENT = { state: 'included', qty: 12 };
  np.lines.BASE_ADV_COMPONENT = { state: 'included', qty: 3 };
  assert.equal(calculateQuote(np).lines.find(l => l.id === 'DESIGN_COMPONENTS').qty, 15);
  const fq = newQuote(library, aaif, { type: 'foundation_site' });
  fq.lines.BASE_STD_COMPONENT = { state: 'included', qty: 2 }; // new components on a foundation are not double counted with redesigns
  fq.foundation.components[0].treatment = 'redesign';
  assert.equal(calculateQuote(fq).lines.find(l => l.id === 'DESIGN_COMPONENTS').qty, 1);
});

test('expansion: site activation continues the volume tiers from sites already live', () => {
  const p = effectivePricing(item('MIG_SITE_ACTIVATION'), {});
  // 50 live, 20 more: all 20 fall in "51 to 100" at $1,250
  const r = pricedFrom(p, 50, 20);
  assert.equal(r.amount, 20 * 125000);
  // 5 live, 10 more: 5 at $2,500 then 5 at $1,750
  assert.equal(pricedFrom(p, 5, 10).amount, 5 * 250000 + 5 * 175000);
  assert.equal(pricedFrom(p, 5, 10).breakdown.length, 2);
  assert.equal(pricedFrom(p, 50, 0).amount, 0);
  const q = newQuote(library, aaif, { type: 'expansion', existingLiveSites: 100 });
  q.lines = { MIG_SITE_ACTIVATION: { state: 'included', qty: 600, priorQty: 100 } };
  assert.equal(calculateQuote(q).total, 600 * 75000);
});

test('portfolio: sampled site types extrapolate to the full count; scans merge per site without clobbering others', () => {
  const q = newQuote(library, null, { type: 'new_platform' });
  q.siteGroups = [
    { id: 'clinic', name: 'Clinic site', count: 600, samples: [] },
    { id: 'hub', name: 'Regional hub', count: 4, samples: [], manual: { L1: 3, L2: 10, L3: 20, BULK_STATIC: 0, RECORD: 40, ARCHIVE: 0 } },
  ];
  const scan = (host, n) => ({ id: `s-${host}`, rootUrl: `https://${host}/`, finishedAt: '2026-10-08T00:00:00Z', partial: false, entries: Array.from({ length: n }, (_, i) => ({ url: `https://${host}/p${i}`, key: `https://${host}/p${i}`, findings: { category: i === 0 ? 'L1' : 'L3', include: true } })), templates: [], media: null });
  let inv = mergeScan(q.inventory, scan('a.clinic.example', 10), { groupId: 'clinic' });
  inv = mergeScan(inv, scan('b.clinic.example', 20), { groupId: 'clinic' });
  // rescanning site a with fewer pages marks only site a's missing pages as not seen
  inv = mergeScan(inv, scan('a.clinic.example', 8), { groupId: 'clinic' });
  q.inventory = inv;
  const b = inv.entries.filter(e => e.siteKey === 'b.clinic.example');
  assert.equal(b.length, 20); assert.ok(b.every(e => e.status !== 'not_seen'));
  assert.equal(inv.entries.filter(e => e.siteKey === 'a.clinic.example' && e.status === 'not_seen').length, 2);

  const pf = portfolioSummary(q);
  assert.equal(pf.totalSites, 604);
  const clinic = pf.groups.find(g => g.id === 'clinic');
  assert.equal(clinic.sampled, 2); assert.equal(clinic.perSite.L1, 1);
  assert.equal(pf.totals.L1, 600 + 4 * 3);
  assert.ok(pf.extrapolated);
  const { rows } = proposeQuantities(q);
  const r = Object.fromEntries(rows.map(x => [x.id, x]));
  assert.equal(r.MIG_SITE_ACTIVATION.proposed, 604);
  assert.equal(r.MIG_BRAND_CONFIG.proposed, 604);
  assert.equal(r.MIG_BRAND_CONFIG.selected, false);
  assert.match(r.MIG_L1_PAGE.basis, /extrapolated/);
});

test('migration: a version 1 AAIF quote becomes a foundation site quote with identical totals', () => {
  const v1 = read('./fixtures/v1-quote-pytorch.json');
  const before = calculateQuote(v1);
  const lib2 = migrateLibrary(read('./fixtures/v1-library.json'), library);
  assert.equal(lib2.schemaVersion, 2); assert.ok(lib2.quoteTypes.length === 4);
  assert.ok(lib2.items.find(i => i.id === 'DESIGN_COMPONENTS') && !lib2.items.find(i => i.id === 'DESIGN_EXISTING_BLOCKS'));
  const v2 = migrateQuote(v1, lib2);
  assert.equal(v2.schemaVersion, 2); assert.equal(v2.type, 'foundation_site');
  assert.equal(v2.aaif, undefined); assert.equal(v2.foundation.id, 'aaif');
  assert.equal(v2.client.parentOrg, 'Linux Foundation');
  assert.ok(v2.lines.DESIGN_COMPONENTS && !v2.lines.DESIGN_EXISTING_BLOCKS);
  const after = calculateQuote(v2);
  assert.equal(after.total, before.total);
  assert.deepEqual(after.sections.map(s => s.subtotal), before.sections.map(s => s.subtotal));
  assert.equal(after.lines.find(l => l.id === 'DESIGN_COMPONENTS').qty, 22);
  assert.equal(migrateQuote(v2), v2, 'already current quotes are left alone');
  const f = catalogueToFoundation(read('./fixtures/v1-aaif-catalogue.json'));
  assert.equal(f.components.length, 26); assert.equal(f.expectedComponents, 39); assert.equal(f.integrations.length, 3);
});

test('migration on startup: version 1 data is backed up, upgraded, and the AAIF catalogue becomes a foundation', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-mig-'));
  fs.mkdirSync(path.join(dataDir, 'quotes'));
  fs.copyFileSync(new URL('./fixtures/v1-library.json', import.meta.url), path.join(dataDir, 'library.json'));
  fs.copyFileSync(new URL('./fixtures/v1-aaif-catalogue.json', import.meta.url), path.join(dataDir, 'aaif-catalogue.json'));
  fs.copyFileSync(new URL('./fixtures/v1-quote-pytorch.json', import.meta.url), path.join(dataDir, 'quotes', 'example-pytorch.json'));
  fs.writeFileSync(path.join(dataDir, 'counter.json'), '{"next":4}');
  const store = createStore({ dataDir, root: ROOT });
  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  assert.equal(backups.length, 1); assert.match(backups[0], /^pre-v2-/);
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', backups[0], 'quotes', 'example-pytorch.json')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'aaif-catalogue.json')));
  assert.equal(store.getLibrary().schemaVersion, 2);
  assert.equal(store.getQuote('example-pytorch').schemaVersion, 2);
  assert.equal(calculateQuote(store.getQuote('example-pytorch')).total, 9125000);
  assert.deepEqual(store.listFoundations().map(f => f.id), ['aaif']);
  // a second start changes nothing
  createStore({ dataDir, root: ROOT });
  assert.equal(fs.readdirSync(path.join(dataDir, 'backups')).length, 1);
});

test('applying a newer foundation keeps redesign choices and components added in the quote', () => {
  const q = newQuote(library, aaif, { type: 'foundation_site' });
  q.foundation.components[2].treatment = 'redesign';
  q.foundation.components.push({ id: 'custom', name: 'Custom', treatment: 'new', addedInQuote: true });
  const f2 = { ...aaif, components: [...aaif.components, { id: 'statsBand', name: 'Stats band' }], updatedAt: '2026-10-09T00:00:00Z' };
  const next = applyFoundation(q, f2);
  assert.equal(next.foundation.components.length, aaif.components.length + 2);
  assert.equal(next.foundation.components[2].treatment, 'redesign');
  assert.ok(next.foundation.components.some(c => c.id === 'custom'));
});

test('site list CSV: header detection, quoted cells, dedupe, and site types with samples', async () => {
  const { parseSiteList, applySiteList } = await import('../shared/sitelist.js');
  const csv = 'Site Name,Website,Brand,Site Type\n"Clinic, North",clinic-n.example,Acme,Clinic\nClinic South,https://clinic-s.example,Acme,clinic\nHub,https://hub.example,Acme,Regional hub\nHub,https://hub.example,Acme,Regional hub\n';
  const { sites, skipped } = parseSiteList(csv);
  assert.equal(sites.length, 3); assert.equal(skipped, 1);
  assert.equal(sites[0].name, 'Clinic, North'); assert.equal(sites[0].url, 'https://clinic-n.example');
  const groups = applySiteList([{ id: 'main', name: 'Site type 1', count: 1, samples: [] }], sites);
  assert.deepEqual(groups.map(g => [g.name, g.count, g.samples.length]), [['Clinic', 2, 2], ['Regional hub', 1, 1]]);
});

test('single site and site counts: starting point and number of sites decide the type and the steps', async () => {
  const { typeFor, isMultiSite, plannedSites } = await import('../shared/quote.js');
  assert.equal(typeFor('scratch', false), 'new_site');
  assert.equal(typeFor('scratch', true), 'new_platform');
  assert.equal(typeFor('foundation', true), 'foundation_site');
  assert.equal(typeFor('live', false), 'expansion');
  const one = newQuote(library, null, { type: 'new_site', client: 'Acme', url: 'https://acme.example' });
  assert.equal(one.lines.BASE_CORE_PLATFORM.state, 'included');
  assert.equal(one.lines.MIG_SITE_ACTIVATION.qty, 1);
  assert.equal(one.lines.MIG_BRAND_CONFIG.state, 'hidden');
  assert.equal(isMultiSite(one), false);
  assert.equal(one.siteGroups[0].name, 'Website');
  assert.match(one.proposal.assumptions[0], /one website from scratch/);
  // a foundation quote for many sites behaves like a portfolio
  const many = newQuote(library, aaif, { type: 'foundation_site', sites: 30 });
  assert.equal(plannedSites(many), 30);
  assert.equal(isMultiSite(many), true);
  assert.equal(many.lines.MIG_SITE_ACTIVATION.qty, 30);
  assert.equal(many.lines.MIG_BRAND_CONFIG.qty, 30);
  assert.ok(many.proposal.assumptions.some(a => /extrapolated/.test(a)));
  // component design on a scratch site counts the components being built
  const { componentDesignCount } = await import('../shared/pricing.js');
  one.lines.BASE_STD_COMPONENT = { state: 'included', qty: 9 };
  assert.equal(componentDesignCount(one), 9);
  // reusing a foundation turns a scratch site into a foundation site
  assert.equal(applyFoundation(one, aaif).type, 'foundation_site');
  const { suggestedIntro } = await import('../shared/proposal.js');
  assert.match(suggestedIntro(one), /new website to replace acme\.example/);
});

test('library upgrade adds new quote types and their presets without touching prices', async () => {
  const { upgradeLibrary } = await import('../shared/migrate.js');
  const old = JSON.parse(JSON.stringify(library));
  old.quoteTypes = old.quoteTypes.filter(t => t.id !== 'new_site');
  for (const it of old.items) { delete it.presets?.new_site; }
  old.items.find(i => i.id === 'MIG_L1_PAGE').pricing.unitPrice = 123456;
  const up = upgradeLibrary(old, library);
  assert.equal(up.changed, true);
  assert.equal(up.lib.quoteTypes[0].id, 'new_site');
  assert.equal(up.lib.items.find(i => i.id === 'BASE_CORE_PLATFORM').presets.new_site.state, 'included');
  assert.equal(up.lib.items.find(i => i.id === 'MIG_L1_PAGE').pricing.unitPrice, 123456);
  assert.equal(upgradeLibrary(up.lib, library).changed, false);
});

test('site insights: exact CMS counts, scratch templates and components, languages, integrations', () => {
  const q = newQuote(library, null, { type: 'new_site', url: 'https://acme.example' });
  const entries = [
    ...Array.from({ length: 4 }, (_, i) => ({ url: `https://acme.example/p${i}`, findings: { category: 'L2', include: true, confidence: 'high', contentType: 'Page' } })),
    ...Array.from({ length: 30 }, (_, i) => ({ url: `https://acme.example/news/n${i}`, findings: { category: 'RECORD', include: true, confidence: 'high', contentType: 'News' } })),
  ];
  const insights = {
    pagesInspected: 10, cms: { id: 'wordpress', name: 'WordPress', confidence: 'high' },
    integrations: [{ id: 'ga4', name: 'Google Analytics', category: 'analytics' }, { id: 'hubspot_tracking', name: 'HubSpot', category: 'crm' }, { id: 'calendly', name: 'Calendly', category: 'booking' }],
    languages: { codes: ['en', 'fr'], count: 2, evidence: 'hreflang' },
    components: { count: 14, standard: 10, interactive: 4 }, templates: { count: 5, advanced: 1 },
    cmsCounts: { source: 'wp-rest', available: true, types: [{ slug: 'page', name: 'Pages', total: 4 }, { slug: 'post', name: 'News', total: 60 }, { slug: 'event', name: 'Events', total: 0 }], media: 900, taxonomies: [] },
  };
  const inv = mergeScan(q.inventory, { id: 's1', rootUrl: 'https://acme.example/', entries, insights, finishedAt: '2026-11-01' });
  const qq = { ...q, inventory: inv };
  const rows = Object.fromEntries(proposeQuantities(qq).rows.map(r => [r.id, r]));
  assert.equal(rows.MIG_MEDIA.proposed, 900);
  assert.match(rows.MIG_MEDIA.basis, /WordPress REST API/);
  assert.equal(rows.MIG_CONTENT_TYPE_MAP.proposed, 1); // Events has no published items
  assert.equal(rows.MIG_STRUCTURED_RECORDS.proposed, 30);
  assert.match(rows.MIG_STRUCTURED_RECORDS.note, /reports 60/);
  assert.equal(rows.BASE_STD_PAGE_TEMPLATE.proposed, 5); // 4 standard layouts + 1 record detail template
  assert.equal(rows.BASE_ADV_PAGE_TEMPLATE.proposed, 1);
  assert.equal(rows.BASE_STD_COMPONENT.proposed, 10);
  assert.equal(rows.BASE_ADV_COMPONENT.proposed, 4);
  assert.equal(rows.BASE_STD_COMPONENT.selected, true);
  assert.equal(rows.MIG_LANGUAGE.proposed, 1);
  assert.equal(rows.BASE_SHARED_INTEGRATION_NEW.proposed, 2);
  assert.equal(rows.BASE_SHARED_INTEGRATION_NEW.selected, false);
  assert.equal(rows.MIG_ANALYTICS.selected, false);
  assert.equal(new Set(proposeQuantities(qq).rows.map(r => r.id)).size, proposeQuantities(qq).rows.length, 'one row per line');
});

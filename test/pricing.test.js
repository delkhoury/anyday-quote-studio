import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { priceForQuantity, effectivePricing, calculateQuote, incrementalPrice, describePricing } from '../shared/pricing.js';
import { newQuote, applyLibraryPricing, validateLibraryShape } from '../shared/quote.js';

const library = JSON.parse(fs.readFileSync(new URL('../shared/library-default.json', import.meta.url)));
const foundation = JSON.parse(fs.readFileSync(new URL('../shared/foundations/aaif.json', import.meta.url)));
// a quote with no lines chosen yet (type presets cleared), so each test sets exactly what it checks
const blankQuote = (lib = library, f = foundation, opts = {}) => { const q = newQuote(lib, f, opts); q.lines = {}; return q; };
const item = id => library.items.find(i => i.id === id);
const P = (id, q, line = {}) => priceForQuantity(effectivePricing(item(id), line), q);
const $ = d => d * 100;

test('library is valid and every source row price is preserved', () => {
  assert.deepEqual(validateLibraryShape(library), []);
  assert.equal(library.sourceRows.length, 82);
  for (const row of library.sourceRows) {
    const it = library.items.find(i => i.keys.includes(row.key));
    assert.ok(it, `missing ${row.key}`);
    const p = it.pricing;
    const prices = p.model === 'per_unit' ? [p.unitPrice] : p.model === 'batched' ? [p.first.price, p.additional.price]
      : p.model === 'progressive' ? p.tiers.map(t => t.price) : p.model === 'per_block' ? [p.price] : [0];
    const matched = p.model === 'batched' ? (p.first.key === row.key ? p.first.price : p.additional.price)
      : p.model === 'progressive' ? p.tiers.find(t => t.key === row.key).price : prices[0];
    assert.equal(matched, row.price, `${row.key} price`);
  }
  // spot checks against the Pricing Library tab (Oct 1 2026)
  assert.equal(item('BASE_CORE_PLATFORM').pricing.unitPrice, $(75000));
  assert.equal(item('BASE_ADV_BRAND_CONTROLS').pricing.unitPrice, $(20000));
  assert.equal(item('BASE_SIMPLE_TOOL').pricing.status, 'starting_at');
  assert.equal(item('MIG_BASIC_CLEANUP').pricing.model, 'included');
  assert.equal(item('MIG_HTML_CLEANUP').pricing.blockSize, 500);
});

test('section mapping follows the calculator tabs, not the Phase field', () => {
  // Phase says Migration but tab 03 places these under Platform Extensions
  for (const id of ['MIG_BRAND_CONFIG', 'MIG_CRM_SETUP', 'MIG_SEO_METADATA', 'MIG_BASIC_CLEANUP']) {
    assert.equal(item(id).phase, 'Migration');
    assert.equal(item(id).section, 'extensions');
  }
  for (const id of ['MIG_SITE_ACTIVATION', 'MIG_L1_PAGE', 'MIG_REDIRECTS', 'MIG_CONTENT_TYPE_MAP']) assert.equal(item(id).section, 'migration');
  for (const id of ['DESIGN_COMPONENTS', 'BASE_SITE_SEARCH']) assert.equal(item(id).section, 'base');
});

test('first batch plus additional batch boundaries', () => {
  const cases = [
    ['MIG_STRUCTURED_RECORDS', [[0, 0], [1, 5000], [500, 5000], [501, 8500], [1000, 8500], [1001, 12000], [3009, 26000]]],
    ['MIG_MEDIA', [[0, 0], [1000, 2500], [1001, 4000], [2000, 4000], [6000, 10000]]],
    ['MIG_REDIRECTS', [[0, 0], [250, 1500], [251, 2250], [439, 2250], [1292, 5250], [3101, 10500]]],
    ['MIG_BULK_STATIC', [[0, 0], [50, 3500], [51, 6000], [100, 6000], [101, 8500]]],
  ];
  for (const [id, rows] of cases) for (const [q, d] of rows) assert.equal(P(id, q).amount, $(d), `${id} @ ${q}`);
});

test('zero quantity never charges a first batch', () => {
  assert.equal(P('MIG_STRUCTURED_RECORDS', 0).amount, 0);
  assert.equal(P('MIG_HTML_CLEANUP', 0).amount, 0);
  assert.equal(P('MIG_SITE_ACTIVATION', 0).amount, 0);
});

test('progressive site activation tiers', () => {
  const rows = [[1, 2500], [10, 25000], [11, 26750], [50, 95000], [51, 96250], [100, 157500], [101, 158250], [130, 180000]];
  for (const [q, d] of rows) assert.equal(P('MIG_SITE_ACTIVATION', q).amount, $(d), `sites ${q}`);
});

test('per 500 record units calculate from record quantities', () => {
  assert.equal(P('MIG_HTML_CLEANUP', 1).amount, $(2500));
  assert.equal(P('MIG_HTML_CLEANUP', 500).amount, $(2500));
  assert.equal(P('MIG_HTML_CLEANUP', 501).amount, $(5000));
  assert.equal(P('MIG_METADATA_CLEANUP', 1500).amount, $(4500));
});

test('included items price at zero; per unit multiplies', () => {
  assert.equal(P('MIG_BASIC_CLEANUP', 1).amount, 0);
  assert.equal(P('MIG_L2_PAGE', 43).amount, $(21500));
  assert.equal(P('MIG_L2_PAGE', 0).amount, 0);
  assert.equal(P('MIG_L2_PAGE', null).status, 'qty_needed');
  assert.equal(P('MIG_L2_PAGE', -1).status, 'invalid');
});

test('starting at prices stay distinct until confirmed', () => {
  const e = effectivePricing(item('BASE_SIMPLE_TOOL'), {});
  assert.equal(e.status, 'starting_at');
  assert.match(describePricing(e), /^Starting at \$7,500/);
  const c = effectivePricing(item('BASE_SIMPLE_TOOL'), { confirmedPrice: $(9000) });
  assert.equal(c.status, 'confirmed');
  assert.equal(priceForQuantity(c, 1).amount, $(9000));
});

test('unpriced design items block final export; drafts still calculate', () => {
  const q = blankQuote();
  q.lines.DESIGN_DIRECTION = { state: 'included', qty: 1 };
  q.lines.MIG_L1_PAGE = { state: 'included', qty: 2 };
  const c = calculateQuote(q);
  assert.equal(c.canExportFinal, false);
  assert.equal(c.totalStatus, 'pending');
  assert.equal(c.total, $(2000));
  q.lines.DESIGN_DIRECTION.override = { unitPrice: $(8000), reason: 'Confirmed design rate' };
  const c2 = calculateQuote(q);
  assert.equal(c2.canExportFinal, true);
  assert.equal(c2.total, $(10000));
  assert.equal(c2.sections[0].designSubtotal, $(8000));
});

test('quote override does not change the library; snapshot isolates library edits', () => {
  const q = blankQuote();
  q.lines.MIG_L1_PAGE = { state: 'included', qty: 3, override: { unitPrice: $(900) } };
  assert.equal(calculateQuote(q).total, $(2700));
  assert.equal(item('MIG_L1_PAGE').pricing.unitPrice, $(1000));
  const lib2 = JSON.parse(JSON.stringify(library));
  lib2.items.find(i => i.id === 'MIG_L2_PAGE').pricing.unitPrice = $(650);
  q.lines.MIG_L2_PAGE = { state: 'included', qty: 10 };
  assert.equal(calculateQuote(q).total, $(2700 + 5000)); // still old snapshot
  const { quote: q2, changes } = applyLibraryPricing(q, lib2);
  assert.equal(changes.length, 1);
  assert.equal(calculateQuote(q2).total, $(2700 + 6500)); // override kept, new library price applied
  const fresh = blankQuote(lib2);
  fresh.lines.MIG_L2_PAGE = { state: 'included', qty: 10 };
  assert.equal(calculateQuote(fresh).total, $(6500));
});

test('design allocation changes the breakdown without increasing the total', () => {
  const q = blankQuote();
  q.lines.BASE_STD_PAGE_TEMPLATE = { state: 'included', qty: 2 }; // $5,000 bundled fee
  q.lines.DESIGN_PAGE_LAYOUTS = { state: 'included', qty: 2, override: { unitPrice: $(1000) }, design: { mode: 'allocated', from: 'BASE_STD_PAGE_TEMPLATE' } };
  const c = calculateQuote(q);
  assert.equal(c.total, $(5000));
  const base = c.sections[0];
  assert.equal(base.designSubtotal, $(2000));
  assert.equal(base.implementationSubtotal, $(3000));
  assert.equal(base.subtotal, $(5000));
  assert.equal(c.canExportFinal, true);
  // as an additional charge the total increases
  q.lines.DESIGN_PAGE_LAYOUTS.design.mode = 'additional';
  assert.equal(calculateQuote(q).total, $(7000));
  // over allocation is blocked, never silently absorbed
  q.lines.DESIGN_PAGE_LAYOUTS = { ...q.lines.DESIGN_PAGE_LAYOUTS, qty: 6, design: { mode: 'allocated', from: 'BASE_STD_PAGE_TEMPLATE' } };
  const c3 = calculateQuote(q);
  assert.equal(c3.canExportFinal, false);
  assert.ok(c3.blockers.some(b => b.kind === 'allocation'));
});

test('optional additions never contribute to the total; tiered additions price the increment', () => {
  const q = blankQuote();
  q.lines.MIG_SITE_ACTIVATION = { state: 'included', qty: 10, addition: { qty: 5 } };
  q.lines.MIG_L1_PAGE = { state: 'optional', optionalQty: 10 };
  const c = calculateQuote(q);
  assert.equal(c.total, $(25000));
  const opt = c.optional.find(o => o.id === 'MIG_L1_PAGE');
  assert.equal(opt.estimate.amount, $(10000));
  assert.equal(c.additions[0].addition.amount, $(5 * 1750)); // sites 11 to 15 at the second tier
  assert.equal(incrementalPrice(effectivePricing(item('MIG_STRUCTURED_RECORDS'), {}), 500, 1).amount, $(3500));
  assert.equal(incrementalPrice(effectivePricing(item('MIG_STRUCTURED_RECORDS'), {}), 0, 1).amount, $(5000));
});

test('hidden items are excluded from optional additions', () => {
  const q = blankQuote();
  q.lines.BASE_CORE_PLATFORM = { state: 'hidden' };
  const c = calculateQuote(q);
  assert.ok(!c.optional.some(o => o.id === 'BASE_CORE_PLATFORM'));
  assert.ok(c.optional.some(o => o.id === 'BASE_FACETED_SEARCH'));
});

test('dependencies: prerequisite satisfied by foundation is not charged twice', () => {
  const q = blankQuote();
  q.lines.MIG_SEARCH_SETUP = { state: 'included', qty: 1 };
  assert.ok(calculateQuote(q).warnings.some(w => w.kind === 'dependency'));
  q.foundation.providedCapabilities = ['BASE_SITE_SEARCH'];
  const c = calculateQuote(q);
  assert.ok(!c.warnings.some(w => w.kind === 'dependency'));
  assert.equal(c.total, $(2500));
  const opt = c.optional.find(o => o.id === 'BASE_SEARCH_INDEX');
  assert.deepEqual(opt.requires, []);
});

test('existing AAIF connector cannot be charged as a new connector build', () => {
  const q = blankQuote();
  q.lines.BASE_NEW_SIMPLE_API = { state: 'included', qty: 1 };
  q.foundation.integrations[0] = { ...q.foundation.integrations[0], existingMeetsRequirement: true, pricedAs: 'BASE_NEW_SIMPLE_API' };
  const c = calculateQuote(q);
  assert.equal(c.canExportFinal, false);
  assert.ok(c.blockers.some(b => b.kind === 'duplicate'));
});

test('component design count is unique redesigned components and never every component by default', () => {
  const q = blankQuote();
  q.lines.DESIGN_COMPONENTS = { state: 'included' };
  assert.equal(calculateQuote(q).lines.find(l => l.id === 'DESIGN_COMPONENTS').qty, 0);
  q.foundation.components[0].treatment = 'redesign';
  q.foundation.components.push({ ...q.foundation.components[0] }); // same block listed twice (reused on many pages)
  q.foundation.components[3].treatment = 'redesign';
  assert.equal(calculateQuote(q).lines.find(l => l.id === 'DESIGN_COMPONENTS').qty, 2);
});

test('LF examples reproduce workbook migration and extension totals', () => {
  const expect = { 'example-pytorch': [54000, 7250, 30000], 'example-openssf': [81500, 8000, 27500], 'example-cncf': [111500, 8750, 47500] };
  for (const [id, [mig, ext, base]] of Object.entries(expect)) {
    const q = JSON.parse(fs.readFileSync(new URL(`../seed/quotes/${id}.json`, import.meta.url)));
    const c = calculateQuote(q);
    const s = Object.fromEntries(c.sections.map(x => [x.id, x]));
    assert.equal(s.migration.subtotal, $(mig), `${id} migration`);
    assert.equal(s.extensions.subtotal, $(ext), `${id} extensions`);
    assert.equal(s.base.subtotal, $(base), `${id} base (design pending)`);
    assert.equal(c.canExportFinal, false, 'design unpriced blocks final export');
    assert.equal(q.lines.BASE_CORE_PLATFORM.state, 'hidden');
    assert.equal(q.lines.BASE_ADV_BRAND_CONTROLS.state, 'hidden');
  }
});

test('proposal appendix is capped so huge inventories cannot exhaust the PDF renderer', async () => {
  const { renderProposal, APPENDIX_MAX_ROWS } = await import('../shared/proposal.js');
  const q = JSON.parse(fs.readFileSync(new URL('../seed/quotes/example-cncf.json', import.meta.url)));
  const base = q.inventory.entries;
  q.inventory.entries = Array.from({ length: 5 }, (_, i) => base.map(e => ({ ...e, url: e.url + '?v' + i }))).flat();
  const html = renderProposal(q, { appendix: true });
  const appendix = html.slice(html.indexOf('class="block newpage appendix"'));
  assert.equal((appendix.match(/<tr><td>/g) || []).length, APPENDIX_MAX_ROWS);
  assert.match(appendix, /The first 2,000 are listed here, included URLs first; the complete inventory is provided as a spreadsheet/);
});

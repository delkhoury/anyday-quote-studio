// Build seed data: AAIF catalogue and the three LF example quotes (provisional, dated examples).
import fs from 'node:fs';
import path from 'node:path';
import { newQuote, blockLabel } from '../shared/quote.js';
import { normalizeUrl } from '../shared/inventory.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const library = JSON.parse(fs.readFileSync(path.join(root, 'shared/library-default.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(root, 'sources/examples-raw.json'), 'utf8'));

const catalogue = {
  schemaVersion: 1,
  complete: false,
  expectedCount: 39,
  source: 'Block names referenced in the PyTorch, OpenSSF and CNCF workbooks (Oct 6 2026). The AAIF documentation describing all 39 blocks was not supplied; import it to complete this list.',
  blocks: raw.blocksReferenced.map(id => ({ id, name: blockLabel(id), documented: false })),
  integrations: [
    { id: 'luma_gateway', name: 'Luma events via Gateway', confirmed: false, source: 'Anyday engagement notes, Jul 30 2026. Confirm against AAIF documentation.' },
    { id: 'lfx_data', name: 'LFX structured project and governance data', confirmed: false, source: 'Anyday engagement notes. Confirm against AAIF documentation.' },
    { id: 'lfx_committee_calendar', name: 'LFX committee meetings (V2 API) for calendar', confirmed: false, source: 'Anyday engagement notes, Jul 30 2026. Confirm against AAIF documentation.' },
  ],
  providedCapabilities: [],
};
fs.mkdirSync(path.join(root, 'seed/quotes'), { recursive: true });
fs.writeFileSync(path.join(root, 'shared/aaif-catalogue.json'), JSON.stringify(catalogue, null, 1));

const MIG_ROW = {
  'Sites to activate': 'MIG_SITE_ACTIVATION', 'Bulk static pages': 'MIG_BULK_STATIC',
  'Source content types': 'MIG_CONTENT_TYPE_MAP', 'Media assets': 'MIG_MEDIA', 'Redirect URLs': 'MIG_REDIRECTS',
};
const INVENTORY_ROW = { 'Level 1 composed pages': 'L1', 'Level 2 composed pages': 'L2', 'Level 3 simple pages': 'L3', 'Structured records': 'RECORD' };
const INVENTORY_ITEM = { L1: 'MIG_L1_PAGE', L2: 'MIG_L2_PAGE', L3: 'MIG_L3_PAGE', RECORD: 'MIG_STRUCTURED_RECORDS' };
// AAIF Option 1: reuse the existing foundation; do not select a new core build or expanded theme system.
const OPTION1_HIDDEN = ['BASE_CORE_PLATFORM', 'BASE_STD_BRAND_CONTROLS', 'BASE_ADV_BRAND_CONTROLS'];

raw.examples.forEach((ex, idx) => {
  const q = newQuote(library, catalogue, {
    client: ex.client, project: `${ex.short} website on the AAIF foundation`, url: ex.url,
    number: `AQ-2026-${String(idx + 1).padStart(4, '0')}`,
  });
  q.id = `example-${ex.short.toLowerCase()}`;
  q.example = { label: `${ex.short} (Linux Foundation Option 1 example)`, workbook: ex.workbook, workbookDate: ex.workbookDate, provisional: true };
  const L = q.lines;
  for (const id of OPTION1_HIDDEN) L[id] = { state: 'hidden', hiddenReason: 'AAIF Option 1 reuses the existing foundation' };

  for (const [k, v] of Object.entries(ex.baseQty)) {
    if (k.startsWith('DESIGN_')) continue;
    if (v > 0) L[k] = { state: 'included', qty: v, qtySource: 'example', provisional: true };
  }
  // design: unpriced, editable
  L.DESIGN_DIRECTION = { state: 'included', qty: 1, qtySource: 'example', design: { mode: 'additional' } };
  L.DESIGN_EXISTING_BLOCKS = { state: 'included', qtySource: 'aaif', design: { mode: 'additional' } };
  L.DESIGN_PAGE_LAYOUTS = { state: 'included', qty: null, design: { mode: 'additional' } };
  L.DESIGN_REVIEWS = { state: 'included', qty: null, design: { mode: 'additional' } };

  // AAIF blocks: workbook selection = redesign; everything else = brand application only
  const sel = new Set(ex.blocks);
  q.aaif.blocks = q.aaif.blocks.map(b => ({ ...b, treatment: sel.has(b.id) ? 'redesign' : 'brand', note: sel.has(b.id) ? 'Provisional selection from workbook' : '' }));

  // inventory (dated example, not a live scan)
  q.inventory = {
    source: { type: 'imported_example', label: `${ex.short} workbook Sitemap Analysis`, date: `${ex.workbookDate}T00:00:00Z`, provisional: true,
      note: 'Dated example inventory imported from the workbook. Not a fresh scan. Page levels and redesign selections are provisional.' },
    entries: ex.entries.map(e => ({
      url: e.url, key: normalizeUrl(e.url), status: null, origin: 'imported_example',
      findings: {
        title: e.title, contentType: e.contentType, category: e.category, include: e.include, reason: e.reason,
        evidence: `Workbook import: ${e.evidence}`, confidence: e.confidence, sourceCmsType: e.sourceCmsType, sitemap: e.sitemap,
        lastmod: e.lastmod, headings: e.headings, forms: e.forms, embeds: e.embeds, fetchError: e.fetchError, suggestedBlocks: [],
      },
      decision: {},
    })),
    scans: [], templates: [],
    media: { discovered: null, imageSitemap: null, verified: null },
  };

  // migration: counts from the inventory; other rows from the workbook
  for (const [row, val] of Object.entries(ex.migration)) {
    if (INVENTORY_ROW[row]) {
      const cat = INVENTORY_ROW[row];
      const n = ex.entries.filter(e => e.category === cat && e.include).length;
      if (n > 0) L[INVENTORY_ITEM[cat]] = { state: 'included', qty: n, qtySource: 'inventory', provisional: true };
      continue;
    }
    const id = MIG_ROW[row];
    if (typeof val === 'number' && val > 0) L[id] = { state: 'included', qty: val, qtySource: 'example', provisional: true, sourceComment: ex.migrationComments[row] || '' };
  }
  for (const [k, v] of Object.entries(ex.extensions)) if (v > 0) L[k] = { state: 'included', qty: v, qtySource: 'example', provisional: true };

  const recordTypes = [...new Set(ex.entries.filter(e => e.category === 'RECORD').map(e => e.contentType))];
  q.proposal.intro = `${ex.client} wants to move ${ex.url.replace(/^https?:\/\//, '')} onto the platform foundation Anyday built for the Agentic AI Foundation (AAIF). This proposal reuses that existing foundation: its block library, content models and integrations. Anyday will apply the ${ex.short} brand, redesign the selected blocks, and migrate the site's pages, ${recordTypes.length ? recordTypes.slice(0, 3).map(t => t.toLowerCase()).join(', ') + ' and other records' : 'records'}, media and URLs.`;
  q.proposal.assumptions = [
    'This proposal reuses the existing AAIF platform foundation. No new core platform or expanded theme system is included.',
    `Quantities come from a dated public sitemap review (${ex.workbookDate}). Page levels and block redesign selections are provisional and will be confirmed during discovery.`,
    'Media volume is a planning allowance. A public sitemap does not establish the size of the media library, so the allowance will be confirmed against a CMS media export.',
    'Redirect volume is a maximum planning allowance. URLs that keep their path need no redirect.',
    'Generated tag, category and author archives are regenerated from migrated content and are not charged per URL.',
    'Redesigned AAIF blocks keep their existing schema and behaviour.',
  ];
  if (ex.short === 'CNCF') q.proposal.assumptions.push('Record content types were inferred from URLs. Source CMS types will be verified from a CMS export.');
  if (ex.short === 'PyTorch') q.proposal.assumptions.push('Eight existing WordPress pages are proposed as structured records in the new content model, pending review.');
  q.provisional = ex.notes;
  fs.writeFileSync(path.join(root, `seed/quotes/${q.id}.json`), JSON.stringify(q));
  console.log(q.number, q.client.name, Object.values(L).filter(l => l.state === 'included').length, 'included lines');
});

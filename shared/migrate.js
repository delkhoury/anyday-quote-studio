// Schema migrations. Version 1 quotes carried an AAIF block library baked into the quote
// (quote.aaif). Version 2 quotes have a type and a generic foundation snapshot, so any
// foundation can be reused and new platforms can be priced from scratch.
import { blockLabel, defaultSiteGroups, QUOTE_TYPES_FALLBACK } from './quote.js';
import { siteKeyOf } from './inventory.js';

const RENAMED_ITEMS = { DESIGN_EXISTING_BLOCKS: 'DESIGN_COMPONENTS' };
const LEGACY_FOUNDATION = { id: 'aaif', name: 'AAIF (Linux Foundation)', owner: 'Linux Foundation' };

const clone = o => JSON.parse(JSON.stringify(o));
const renameKeys = (obj = {}) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [RENAMED_ITEMS[k] || k, v]));

// An old AAIF catalogue file becomes a foundation record.
export function catalogueToFoundation(cat, fields = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, ...LEGACY_FOUNDATION,
    description: 'Multisite platform Anyday built for the Agentic AI Foundation. Linux Foundation projects can launch on it by reusing its components, content models and integrations.',
    archived: false,
    complete: !!cat.complete, expectedComponents: cat.expectedCount ?? null, source: cat.source || '',
    components: (cat.blocks || []).map(b => ({ id: b.id, name: b.name || blockLabel(b.id), kind: 'block', documented: !!b.documented, description: b.description || '' })),
    contentModels: cat.contentModels || [],
    integrations: (cat.integrations || []).map(i => ({ ...i })),
    providedCapabilities: [...(cat.providedCapabilities || [])],
    notes: '', documents: [],
    createdAt: now, updatedAt: now, ...fields,
  };
}

function migrateItem(it, defaultsById) {
  if (!RENAMED_ITEMS[it.id]) return it;
  const fresh = defaultsById?.[RENAMED_ITEMS[it.id]];
  // keep any pricing Anyday already entered; take the new wording from the default library
  return { ...(fresh ? clone(fresh) : it), id: RENAMED_ITEMS[it.id], keys: [RENAMED_ITEMS[it.id]], pricing: { ...it.pricing, qtyUnit: 'component', qtyUnitPlural: 'components' }, quantitySource: 'component_design_count' };
}

export function migrateLibrary(lib, defaults = null) {
  if ((lib.schemaVersion || 1) >= 2) return lib;
  const d = defaults ? Object.fromEntries(defaults.items.map(i => [i.id, i])) : null;
  const items = lib.items.map(it => {
    const m = migrateItem(it, d);
    // presets come from the default library: they describe quote types, not prices
    if (d?.[m.id]?.presets && !m.presets) m.presets = clone(d[m.id].presets);
    return m;
  });
  return { ...lib, schemaVersion: 2, quoteTypes: clone(defaults?.quoteTypes || QUOTE_TYPES_FALLBACK), items };
}

export function migrateQuote(q, defaults = null) {
  if ((q.schemaVersion || 1) >= 2) return q;
  const c = clone(q);
  const d = defaults ? Object.fromEntries(defaults.items.map(i => [i.id, i])) : null;
  c.type = c.type || 'foundation_site';
  if (c.aaif) {
    const a = c.aaif;
    c.foundation = {
      ...LEGACY_FOUNDATION, updatedAt: null, takenAt: c.createdAt || new Date().toISOString(),
      complete: !!a.catalogue?.complete, expectedComponents: a.catalogue?.expectedCount ?? null, source: a.catalogue?.source || '',
      components: (a.blocks || []).map(b => ({ id: b.id, name: b.name || blockLabel(b.id), kind: 'block', treatment: b.treatment || 'brand', note: b.note || '', ...(b.addedInQuote ? { addedInQuote: true } : {}) })),
      contentModels: [],
      integrations: a.integrations || [],
      providedCapabilities: a.providedCapabilities || [],
    };
    delete c.aaif;
  } else if (c.foundation === undefined) c.foundation = null;
  c.lines = renameKeys(c.lines);
  for (const l of Object.values(c.lines)) {
    if (l.qtySource === 'aaif') l.qtySource = 'foundation';
    if (l.design?.from && RENAMED_ITEMS[l.design.from]) l.design.from = RENAMED_ITEMS[l.design.from];
  }
  c.sectionOverrides = renameKeys(c.sectionOverrides);
  if (c.pricingSnapshot) {
    c.pricingSnapshot.items = c.pricingSnapshot.items.map(it => migrateItem(it, d));
    if (!c.pricingSnapshot.quoteTypes) c.pricingSnapshot.quoteTypes = clone(defaults?.quoteTypes || QUOTE_TYPES_FALLBACK);
  }
  c.client = { contact: '', ...(c.client || {}) };
  if (c.client.parentOrg === undefined) c.client.parentOrg = c.foundation?.owner || '';
  c.portfolio = c.portfolio || { existingLiveSites: 0, siteList: [] };
  c.siteGroups = c.siteGroups || defaultSiteGroups(c.type, c.project?.url || '');
  if (c.inventory?.entries) for (const e of c.inventory.entries) { e.groupId = e.groupId || 'main'; e.siteKey = e.siteKey || siteKeyOf(e.url); }
  if (c.proposal?.exclusions) c.proposal.exclusions = c.proposal.exclusions.map(x => x.replace('redesigned AAIF blocks', 'redesigned components'));
  if (c.proposal?.assumptions) c.proposal.assumptions = c.proposal.assumptions.map(x => x.replace('Redesigned AAIF blocks keep', 'Redesigned components keep'));
  c.schemaVersion = 2;
  c.history = [...(c.history || []), { at: new Date().toISOString(), kind: 'migrated', from: q.schemaVersion || 1, to: 2 }];
  return c;
}

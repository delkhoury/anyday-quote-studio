// Quote factory and lifecycle helpers. A quote carries its own pricing snapshot so library
// changes never alter an existing quote unless the user explicitly applies current pricing.

import { diffSnapshots } from './pricing.js';
import { emptyPlan } from './plan.js';

export const QUOTE_SCHEMA_VERSION = 2;

export const QUOTE_TYPES_FALLBACK = [
  { id: 'new_site', name: 'New website from scratch', description: 'Design and build one website from scratch, with nothing reused from an existing platform.', usesFoundation: 'none', sitesStep: false },
  { id: 'new_platform', name: 'New platform and rollout', description: 'Build a new multisite platform from scratch, then roll out the portfolio of sites onto it.', usesFoundation: 'optional', sitesStep: true },
  { id: 'foundation_site', name: 'New site on an existing foundation', description: 'Build a site for a sub brand or sister organisation by reusing a platform foundation Anyday already built.', usesFoundation: 'required', sitesStep: false },
  { id: 'expansion', name: 'Expand a platform we already run', description: 'Add new sites to a live Anyday platform. Volume pricing continues from the sites already live.', usesFoundation: 'required', sitesStep: true },
];
export function quoteTypes(libraryOrSnapshot) { return libraryOrSnapshot?.quoteTypes?.length ? libraryOrSnapshot.quoteTypes : QUOTE_TYPES_FALLBACK; }
export function quoteTypeOf(quote) { return quoteTypes(quote.pricingSnapshot).find(t => t.id === quote.type) || QUOTE_TYPES_FALLBACK.find(t => t.id === (quote.type || 'foundation_site')) || QUOTE_TYPES_FALLBACK.find(t => t.id === 'foundation_site'); }

// Two questions decide the quote type: where the build starts, and whether it is one site or many.
export const STARTING_POINTS = [
  { id: 'scratch', name: 'From scratch', description: 'Nothing is reused. Anyday designs and builds everything.' },
  { id: 'foundation', name: 'On an existing foundation', description: 'Reuse a platform Anyday already built for another client or brand.' },
  { id: 'live', name: 'On a platform we already run', description: 'Add sites to a live Anyday platform for this client.' },
];
export function typeFor(start, multi) {
  if (start === 'live') return 'expansion';
  if (start === 'foundation') return 'foundation_site';
  return multi ? 'new_platform' : 'new_site';
}
export function startingPointOf(type) {
  return type === 'expansion' ? 'live' : type === 'foundation_site' ? 'foundation' : 'scratch';
}
export function plannedSites(quote) {
  return (quote.siteGroups || []).reduce((a, g) => a + Math.max(0, Number(g.count) || 0), 0);
}
// Portfolio behaviour (Sites step, sampled analysis, portfolio wording) follows the number of
// sites, so a foundation quote for 30 sites works like a portfolio and a scratch quote for one does not.
export function isMultiSite(quote) {
  return !!quoteTypeOf(quote).sitesStep || (quote.siteGroups || []).length > 1 || plannedSites(quote) > 1;
}
export const isScratch = quote => ['new_site', 'new_platform'].includes(quote?.type);

export function snapshotFromLibrary(library) {
  return {
    libraryName: library.name,
    libraryVersion: library.version,
    libraryUpdatedAt: library.updatedAt,
    currency: library.currency || 'USD',
    takenAt: new Date().toISOString(),
    quoteTypes: JSON.parse(JSON.stringify(quoteTypes(library))),
    sections: JSON.parse(JSON.stringify(library.sections)),
    items: JSON.parse(JSON.stringify(library.items)),
  };
}

export function blockLabel(id) {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()).replace(/\bFaq\b/, 'FAQ');
}

// ---------------------------------------------------------------------------
// Foundations: reusable platforms (component library, content models,
// integrations, capabilities). A quote keeps its own snapshot of the foundation,
// so editing a foundation never changes a quote that was already prepared.
// ---------------------------------------------------------------------------
export function emptyFoundation(fields = {}) {
  return {
    schemaVersion: 1, id: '', name: '', owner: '', description: '', archived: false,
    complete: false, expectedComponents: null, source: '',
    components: [], contentModels: [], integrations: [], providedCapabilities: [], notes: '', documents: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...fields,
  };
}

export function snapshotFoundation(f, previous = null) {
  if (!f) return null;
  const prevComp = Object.fromEntries((previous?.components || []).map(c => [c.id, c]));
  const prevInteg = Object.fromEntries((previous?.integrations || []).map(i => [i.id, i]));
  const extraComp = (previous?.components || []).filter(c => c.addedInQuote && !f.components.some(x => x.id === c.id));
  return {
    id: f.id, name: f.name, owner: f.owner || '', updatedAt: f.updatedAt, takenAt: new Date().toISOString(),
    complete: !!f.complete, expectedComponents: f.expectedComponents ?? null, source: f.source || '',
    components: [...f.components.map(c => ({ id: c.id, name: c.name || blockLabel(c.id), kind: c.kind || '', treatment: prevComp[c.id]?.treatment || 'brand', note: prevComp[c.id]?.note || '' })), ...extraComp],
    contentModels: JSON.parse(JSON.stringify(f.contentModels || [])),
    integrations: (f.integrations || []).map(i => ({ ...i, existingMeetsRequirement: prevInteg[i.id]?.existingMeetsRequirement ?? null, pricedAs: prevInteg[i.id]?.pricedAs ?? null, note: prevInteg[i.id]?.note || '' })),
    providedCapabilities: [...(f.providedCapabilities || [])],
  };
}

export function applyFoundation(q, foundation) {
  const now = new Date().toISOString();
  // a single site from scratch that now reuses a foundation is a foundation site
  return { ...q, ...(q.type === 'new_site' ? { type: 'foundation_site' } : {}), foundation: snapshotFoundation(foundation, q.foundation?.id === foundation.id ? q.foundation : null), history: [...(q.history || []), { at: now, kind: 'applied_foundation', foundation: foundation.id, updatedAt: foundation.updatedAt }] };
}

export function defaultSiteGroups(type, url = '', sites = 1) {
  const n = Math.max(1, Number(sites) || 1);
  const single = n === 1 && ['foundation_site', 'new_site'].includes(type);
  return [{ id: 'main', name: single ? 'Website' : 'Site type 1', count: n, samples: url ? [{ url }] : [], manual: null, notes: '' }];
}

export function defaultProposal() {
  return {
    intro: '',
    assumptions: [],
    autoAssumptions: [],
    exclusions: [
      'Functional changes to redesigned components, such as new fields, filters or workflows, unless listed in this proposal.',
      'Content, sites and URLs outside the reviewed inventory.',
    ],
    paymentTerms: '',
    validity: '',
    timeline: '',
    includeAppendix: false,
    showDesignBreakdown: true,
  };
}

// Starter assumptions per quote type (editable on the quote).
export function typeAssumptions(type, foundationName = '', { sites = 1 } = {}) {
  const f = foundationName || 'the existing foundation';
  const extrapolated = 'Where sites are grouped into site types, migration volumes are extrapolated from the sampled sites in each type and will be confirmed during discovery.';
  if (type === 'new_site') return [
    'This proposal covers designing and building one website from scratch.',
    'Page, record and media volumes come from the review of the current website and will be confirmed during discovery.',
    'Media volume is a planning allowance until verified against a CMS media export.',
    'Redirect volume is a planning allowance. URLs that keep their path need no redirect.',
  ];
  if (type === 'new_platform') return [
    'This proposal includes building a new shared multisite platform. Every site in the portfolio runs on it.',
    'Where sites are grouped into site types, migration volumes are extrapolated from the sampled sites in each type and will be confirmed during discovery.',
    'Media volume is a planning allowance until verified against a CMS media export.',
    'Redirect volume is a planning allowance. URLs that keep their path need no redirect.',
  ];
  if (type === 'expansion') return [
    `New sites join the live ${f} platform. No new platform build is included.`,
    'Site activation pricing continues from the volume tier reached by the sites already live.',
    'Where sites are grouped into site types, migration volumes are extrapolated from the sampled sites in each type and will be confirmed during discovery.',
  ];
  return [
    `This proposal reuses ${f}: its components, content models and integrations. No new core platform or expanded theme system is included.`,
    'Redesigned components keep their existing schema and behaviour.',
    ...(sites > 1 ? [extrapolated] : []),
    'Media volume is a planning allowance until verified against a CMS media export.',
    'Redirect volume is a planning allowance. URLs that keep their path need no redirect.',
  ];
}

export function newQuote(library, foundation, { client = '', project = '', url = '', number = '', preparedBy = 'Anyday', type = 'foundation_site', parentOrg = '', existingLiveSites = 0, sites = 1 } = {}) {
  const nSites = Math.max(1, Math.round(Number(sites) || 1));
  const now = new Date().toISOString();
  const lines = {};
  for (const it of library.items) {
    const p = it.presets?.[type];
    if (!p) continue;
    lines[it.id] = { state: p.state, ...(p.qty !== undefined ? { qty: p.qty } : {}), ...(p.state === 'included' ? { qtySource: 'preset' } : {}) };
  }
  if (type === 'expansion' && lines.MIG_SITE_ACTIVATION) lines.MIG_SITE_ACTIVATION.priorQty = existingLiveSites || 0;
  if (nSites > 1) for (const id of ['MIG_SITE_ACTIVATION', 'MIG_BRAND_CONFIG']) if (lines[id]?.state === 'included') { lines[id].qty = nSites; lines[id].qtySource = 'preset'; }
  const fsnap = foundation ? snapshotFoundation(foundation) : null;
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    id: cryptoId(),
    number,
    type,
    createdAt: now, updatedAt: now,
    client: { name: client, contact: '', parentOrg },
    project: { name: project, url },
    preparedBy,
    pricingSnapshot: snapshotFromLibrary(library),
    lines,
    sectionOverrides: {},
    foundation: fsnap,
    portfolio: { existingLiveSites: type === 'expansion' ? (existingLiveSites || 0) : 0, siteList: [] },
    siteGroups: defaultSiteGroups(type, url, nSites),
    inventory: { source: null, entries: [], scans: [], templates: [], media: { discovered: null, imageSitemap: null, verified: null } },
    proposal: { ...defaultProposal(), assumptions: typeAssumptions(type, fsnap?.name, { sites: nSites }) },
    plan: emptyPlan(),
    provisional: [],
    history: [{ at: now, kind: 'created', libraryVersion: library.version, type, foundation: fsnap?.id || null }],
  };
}

export function duplicateQuote(q, number = '') {
  const c = JSON.parse(JSON.stringify(q));
  const now = new Date().toISOString();
  c.id = cryptoId();
  c.number = number;
  c.createdAt = now; c.updatedAt = now;
  c.project = { ...c.project, name: c.project.name ? `${c.project.name} (copy)` : '' };
  c.history = [...(c.history || []), { at: now, kind: 'duplicated_from', from: q.id, fromNumber: q.number }];
  return c;
}

// Explicit, user-initiated: replace the quote's snapshot with the current library.
// Quantities, states and quote-specific overrides are kept.
export function applyLibraryPricing(q, library) {
  const changes = diffSnapshots(q.pricingSnapshot.items, library.items);
  const now = new Date().toISOString();
  return {
    quote: { ...q, pricingSnapshot: snapshotFromLibrary(library), history: [...(q.history || []), { at: now, kind: 'applied_library_pricing', from: q.pricingSnapshot.libraryVersion, to: library.version, changes: changes.length }] },
    changes,
  };
}

export function cryptoId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'q_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function validateQuoteShape(q) {
  const errs = [];
  if (!q || typeof q !== 'object') return ['Not a quote object'];
  if (!q.pricingSnapshot?.items?.length) errs.push('Missing pricing snapshot');
  if (!q.lines || typeof q.lines !== 'object') errs.push('Missing lines');
  if (!q.id) errs.push('Missing id');
  return errs;
}

export function validateLibraryShape(l) {
  const errs = [];
  if (!l || typeof l !== 'object') return ['Not a library object'];
  if (!Array.isArray(l.items) || !l.items.length) errs.push('Library has no items');
  if (!Array.isArray(l.sections) || l.sections.length !== 3) errs.push('Library must define the three proposal sections');
  const ids = new Set();
  for (const it of l.items || []) {
    if (!it.id) errs.push('Item without id');
    if (ids.has(it.id)) errs.push(`Duplicate item id ${it.id}`);
    ids.add(it.id);
    if (!['base', 'migration', 'extensions'].includes(it.section)) errs.push(`${it.id}: unknown section ${it.section}`);
    const p = it.pricing || {};
    if (!['per_unit', 'batched', 'progressive', 'per_block', 'included'].includes(p.model)) errs.push(`${it.id}: unknown pricing model`);
    if (p.model === 'batched' && (!(p.first?.size > 0) || !(p.additional?.size > 0))) errs.push(`${it.id}: batch sizes must be positive`);
    if (p.model === 'per_block' && !(p.blockSize > 0)) errs.push(`${it.id}: block size must be positive`);
    if (p.model === 'progressive') {
      let prev = 0;
      (p.tiers || []).forEach((t, i) => {
        const last = i === p.tiers.length - 1;
        if (!last && !(t.upTo > prev)) errs.push(`${it.id}: tier ${i + 1} must end above ${prev}`);
        if (last && t.upTo !== null && t.upTo !== undefined) errs.push(`${it.id}: the last tier must be open ended`);
        prev = t.upTo ?? prev;
      });
    }
  }
  return errs;
}

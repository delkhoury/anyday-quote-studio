// Quote factory and lifecycle helpers. A quote carries its own pricing snapshot so library
// changes never alter an existing quote unless the user explicitly applies current pricing.

import { diffSnapshots } from './pricing.js';

export const QUOTE_SCHEMA_VERSION = 1;

export function snapshotFromLibrary(library) {
  return {
    libraryName: library.name,
    libraryVersion: library.version,
    libraryUpdatedAt: library.updatedAt,
    currency: library.currency || 'USD',
    takenAt: new Date().toISOString(),
    sections: JSON.parse(JSON.stringify(library.sections)),
    items: JSON.parse(JSON.stringify(library.items)),
  };
}

export function blockLabel(id) {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()).replace(/\bFaq\b/, 'FAQ');
}

export function defaultAaif(catalogue) {
  return {
    foundationReused: true,
    catalogue: { complete: catalogue.complete, expectedCount: catalogue.expectedCount, source: catalogue.source },
    blocks: catalogue.blocks.map(b => ({ id: b.id, name: b.name || blockLabel(b.id), treatment: 'brand', note: '' })),
    integrations: (catalogue.integrations || []).map(i => ({ ...i, existingMeetsRequirement: null, pricedAs: null, note: '' })),
    providedCapabilities: catalogue.providedCapabilities || [],
  };
}

export function defaultProposal() {
  return {
    intro: '',
    assumptions: [],
    autoAssumptions: [],
    exclusions: [
      'Functional changes to redesigned AAIF blocks, such as new fields, filters or workflows, unless listed in this proposal.',
      'Content, sites and URLs outside the reviewed inventory.',
    ],
    paymentTerms: '',
    validity: '',
    timeline: '',
    includeAppendix: false,
    showDesignBreakdown: true,
  };
}

export function newQuote(library, catalogue, { client = '', project = '', url = '', number = '', preparedBy = 'Anyday' } = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    id: cryptoId(),
    number,
    createdAt: now, updatedAt: now,
    client: { name: client, contact: '' },
    project: { name: project, url },
    preparedBy,
    pricingSnapshot: snapshotFromLibrary(library),
    lines: {},
    sectionOverrides: {},
    aaif: defaultAaif(catalogue),
    inventory: { source: null, entries: [], scans: [], templates: [], media: { discovered: null, imageSitemap: null, verified: null } },
    proposal: defaultProposal(),
    provisional: [],
    history: [{ at: now, kind: 'created', libraryVersion: library.version }],
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

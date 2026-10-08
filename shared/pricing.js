// Deterministic pricing engine. Every investment figure in the app, the proposal and the PDF
// comes from this module. It reads only the quote's own pricing snapshot, never live UI state.
// Money is integer cents.

import { fmtMoney, fmtInt } from './format.js';
import { summarize } from './inventory.js';

export const LINE_STATES = ['included', 'optional', 'hidden'];

// ---------------------------------------------------------------------------
// Effective pricing for one item on one quote: library snapshot + quote override
// + confirmed "starting at" price.
// ---------------------------------------------------------------------------
export function effectivePricing(item, line = {}) {
  const base = item.pricing;
  const p = JSON.parse(JSON.stringify(base));
  const ov = line.override || null;
  let source = 'library';

  if (ov) {
    if (p.model === 'per_unit' && isNum(ov.unitPrice)) { p.unitPrice = ov.unitPrice; source = 'override'; }
    if (p.model === 'per_block' && isNum(ov.price)) { p.price = ov.price; source = 'override'; }
    if (p.model === 'batched') {
      if (isNum(ov.firstPrice)) { p.first.price = ov.firstPrice; source = 'override'; }
      if (isNum(ov.additionalPrice)) { p.additional.price = ov.additionalPrice; source = 'override'; }
    }
    if (p.model === 'progressive' && Array.isArray(ov.tierPrices)) {
      ov.tierPrices.forEach((v, i) => { if (isNum(v) && p.tiers[i]) { p.tiers[i].price = v; source = 'override'; } });
    }
  }

  // Status: unpriced -> confirmed once a price exists; starting_at -> confirmed once confirmed or overridden.
  let status = base.status;
  if (status === 'starting_at' && isNum(line.confirmedPrice) && p.model === 'per_unit') {
    if (source !== 'override') p.unitPrice = line.confirmedPrice;
    status = 'confirmed';
    if (source !== 'override') source = 'confirmed';
  } else if (source === 'override') {
    status = 'confirmed';
  }
  if (p.model === 'per_unit' && !isNum(p.unitPrice)) status = 'unpriced';
  if (p.model === 'per_unit' && status === 'unpriced' && isNum(p.unitPrice)) status = 'confirmed';
  p.status = status;
  p.priceSource = source;
  return p;
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// ---------------------------------------------------------------------------
// Amount for a quantity. Returns { amount, status, breakdown[] }.
// status: priced | price_needed | qty_needed | invalid
// ---------------------------------------------------------------------------
export function priceForQuantity(p, qty) {
  if (p.model === 'included') {
    return { amount: 0, status: 'priced', breakdown: [{ label: 'Included at no charge', amount: 0 }] };
  }
  if (qty === null || qty === undefined || qty === '' || Number.isNaN(Number(qty))) {
    return { amount: null, status: 'qty_needed', breakdown: [] };
  }
  qty = Number(qty);
  if (qty < 0) return { amount: null, status: 'invalid', breakdown: [], error: 'Quantity cannot be negative' };

  switch (p.model) {
    case 'per_unit': {
      if (!isNum(p.unitPrice)) return { amount: null, status: 'price_needed', breakdown: [] };
      const amount = Math.round(qty * p.unitPrice);
      return { amount, status: 'priced', breakdown: qty === 0 ? [] : [{ label: `${fmtInt(qty)} × ${fmtMoney(p.unitPrice)}`, amount }] };
    }
    case 'batched': {
      if (qty === 0) return { amount: 0, status: 'priced', breakdown: [] }; // never charge a first batch for zero
      const extraUnits = Math.max(0, qty - p.first.size);
      const extraBatches = Math.ceil(extraUnits / p.additional.size);
      const amount = p.first.price + extraBatches * p.additional.price;
      const bd = [{ label: `First ${fmtInt(p.first.size)} ${p.qtyUnitPlural}`, amount: p.first.price }];
      if (extraBatches > 0) bd.push({ label: `${extraBatches} additional batch${extraBatches === 1 ? '' : 'es'} of ${fmtInt(p.additional.size)} × ${fmtMoney(p.additional.price)}`, amount: extraBatches * p.additional.price });
      return { amount, status: 'priced', breakdown: bd, batches: 1 + extraBatches };
    }
    case 'per_block': {
      if (qty === 0) return { amount: 0, status: 'priced', breakdown: [] };
      const blocks = Math.ceil(qty / p.blockSize);
      const amount = blocks * p.price;
      return { amount, status: 'priced', breakdown: [{ label: `${blocks} block${blocks === 1 ? '' : 's'} of up to ${fmtInt(p.blockSize)} ${p.qtyUnitPlural} × ${fmtMoney(p.price)}`, amount }], batches: blocks };
    }
    case 'progressive': {
      let remaining = qty, prev = 0, amount = 0; const bd = [];
      for (const t of p.tiers) {
        if (remaining <= 0) break;
        const cap = t.upTo === null || t.upTo === undefined ? Infinity : t.upTo - prev;
        const n = Math.min(remaining, cap);
        if (n > 0) { amount += n * t.price; bd.push({ label: `${t.label}: ${fmtInt(n)} × ${fmtMoney(t.price)}`, amount: n * t.price }); }
        remaining -= n; prev = t.upTo ?? prev;
      }
      return { amount, status: 'priced', breakdown: bd };
    }
    default:
      return { amount: null, status: 'invalid', breakdown: [], error: `Unknown pricing model ${p.model}` };
  }
}

// Change in price when adding `add` units on top of `current` units (tier and batch aware).
export function incrementalPrice(p, current, add) {
  const before = priceForQuantity(p, current || 0);
  const after = priceForQuantity(p, (current || 0) + (add || 0));
  if (before.status !== 'priced' || after.status !== 'priced') return { amount: null, status: after.status === 'priced' ? before.status : after.status };
  return { amount: after.amount - before.amount, status: 'priced', before: before.amount, after: after.amount };
}

// Plain language "how it is priced".
export function describePricing(p) {
  const prefix = p.status === 'starting_at' ? 'Starting at ' : '';
  switch (p.model) {
    case 'included': return 'Included at no charge';
    case 'per_unit':
      if (!isNum(p.unitPrice)) return `Price needed (priced per ${p.qtyUnit})`;
      return `${prefix}${fmtMoney(p.unitPrice)} per ${p.qtyUnit}`;
    case 'batched':
      return `${fmtMoney(p.first.price)} for the first ${fmtInt(p.first.size)} ${p.qtyUnitPlural}, then ${fmtMoney(p.additional.price)} for each additional ${fmtInt(p.additional.size)} or part. Nothing is charged when the quantity is zero.`;
    case 'per_block':
      return `${fmtMoney(p.price)} per ${fmtInt(p.blockSize)} ${p.qtyUnitPlural} or part`;
    case 'progressive':
      return 'Progressive volume pricing: ' + p.tiers.map(t => `${t.label.toLowerCase()} at ${fmtMoney(t.price)} each`).join('; ');
    default: return '';
  }
}

// Short label for an optional addition's price when no quantity is stated.
export function shortPrice(p) {
  const prefix = p.status === 'starting_at' ? 'From ' : '';
  switch (p.model) {
    case 'included': return 'Included';
    case 'per_unit': return isNum(p.unitPrice) ? `${prefix}${fmtMoney(p.unitPrice)} per ${p.qtyUnit}` : 'Price needed';
    case 'batched': return `${fmtMoney(p.first.price)} first ${fmtInt(p.first.size)}, ${fmtMoney(p.additional.price)} per additional ${fmtInt(p.additional.size)}`;
    case 'per_block': return `${fmtMoney(p.price)} per ${fmtInt(p.blockSize)} ${p.qtyUnitPlural}`;
    case 'progressive': return `From ${fmtMoney(p.tiers[p.tiers.length - 1].price)} to ${fmtMoney(p.tiers[0].price)} per ${p.qtyUnit}`;
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// AAIF foundation helpers
// ---------------------------------------------------------------------------
export function redesignCount(quote) {
  const blocks = quote.aaif?.blocks || [];
  const ids = new Set(blocks.filter(b => b.treatment === 'redesign').map(b => b.id));
  return ids.size; // unique per site regardless of reuse
}

export function blockTreatmentCounts(quote) {
  const c = { brand: 0, redesign: 0, extend: 0, new: 0, not_used: 0, unassigned: 0 };
  const seen = new Set();
  for (const b of quote.aaif?.blocks || []) {
    if (seen.has(b.id)) continue; seen.add(b.id);
    c[b.treatment || 'unassigned'] = (c[b.treatment || 'unassigned'] || 0) + 1;
  }
  return c;
}

function foundationProvides(quote, id) {
  return (quote.aaif?.providedCapabilities || []).includes(id);
}

// ---------------------------------------------------------------------------
// Full quote calculation.
// ---------------------------------------------------------------------------
export function lineFor(quote, item) {
  const l = quote.lines?.[item.id];
  if (l) return { state: l.state || 'optional', ...l };
  return { state: item.optionalAvailable === false ? 'hidden' : 'optional' };
}

export function quantityFor(quote, item, line) {
  if (item.quantitySource === 'aaif_redesign_count') return redesignCount(quote);
  return line.qty;
}

export function calculateQuote(quote) {
  const snap = quote.pricingSnapshot;
  if (!snap) throw new Error('Quote has no pricing snapshot');
  const items = snap.items;
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const sectionMap = quote.sectionOverrides || {};
  const sectionOf = item => sectionMap[item.id] || item.section;

  const blockers = [];
  const warnings = [];
  const lines = [];

  // pass 1: included lines
  for (const item of items) {
    const line = lineFor(quote, item);
    const p = effectivePricing(item, line);
    const qty = quantityFor(quote, item, line);
    const entry = {
      id: item.id, item, line, pricing: p, qty, state: line.state, section: sectionOf(item),
      subsection: item.isDesign ? 'design' : 'implementation', isDesign: !!item.isDesign,
    };
    if (line.state === 'included') {
      const r = priceForQuantity(p, qty);
      entry.result = r;
      entry.amount = r.status === 'priced' ? r.amount : null;
      entry.displayAmount = entry.amount;
      if (r.status === 'price_needed') blockers.push({ id: item.id, kind: 'price_needed', message: `${item.name}: price needed` });
      if (r.status === 'qty_needed') blockers.push({ id: item.id, kind: 'qty_needed', message: `${item.name}: quantity needed` });
      if (r.status === 'invalid') blockers.push({ id: item.id, kind: 'invalid', message: `${item.name}: ${r.error}` });
      entry.startingAt = p.status === 'starting_at';
      // add-on increment offered on top of included scope (tier aware)
      if (line.addition && isNum(Number(line.addition.qty)) && Number(line.addition.qty) > 0 && r.status === 'priced') {
        entry.addition = { qty: Number(line.addition.qty), ...incrementalPrice(p, Number(qty) || 0, Number(line.addition.qty)) };
      }
    }
    lines.push(entry);
  }
  const byLine = Object.fromEntries(lines.map(l => [l.id, l]));
  const isIncluded = id => byLine[id]?.state === 'included';

  // pass 2: design allocations (re-attribute part of a bundled fee; never changes totals)
  for (const l of lines) {
    if (!(l.state === 'included' && l.isDesign && l.line.design?.mode === 'allocated')) continue;
    const fromId = l.line.design.from;
    const src = byLine[fromId];
    l.allocated = true;
    if (!fromId || !src || src.state !== 'included') {
      blockers.push({ id: l.id, kind: 'allocation', message: `${l.item.name}: choose an included item whose fee already covers this design work` });
      continue;
    }
    if (l.amount === null) continue; // already blocked as price needed
    if (src.displayAmount === null) {
      blockers.push({ id: l.id, kind: 'allocation', message: `${l.item.name}: the source item ${src.item.name} has no amount yet` });
      continue;
    }
    if (l.amount > src.displayAmount) {
      blockers.push({ id: l.id, kind: 'allocation', message: `${l.item.name}: allocation ${fmtMoney(l.amount)} exceeds the remaining ${fmtMoney(src.displayAmount)} in ${src.item.name}` });
      continue;
    }
    src.displayAmount -= l.amount;
    src.allocatedOut = (src.allocatedOut || 0) + l.amount;
    l.allocatedFrom = src.id;
  }

  // pass 3: dependencies for included lines
  for (const l of lines) {
    if (l.state !== 'included') continue;
    for (const group of l.item.dependsOn || []) {
      const ok = group.some(id => isIncluded(id) || foundationProvides(quote, id));
      if (!ok) {
        const names = group.map(id => byId[id]?.name || id).join(' or ');
        warnings.push({ id: l.id, kind: 'dependency', message: `${l.item.name} normally requires ${names}. Include it, or mark the capability as already provided by the AAIF foundation.` });
      }
    }
  }

  // pass 4: duplicate charge checks
  const counts = blockTreatmentCounts(quote);
  if (counts.extend > 0) {
    warnings.push({ kind: 'aaif_extend', message: `${counts.extend} AAIF block${counts.extend === 1 ? ' is' : 's are'} marked "extend functionality". Visual redesign keeps existing schema and behaviour, so add separately identified development scope (i.e. a reusable component) for the new fields, filters or workflows.` });
  }
  if (counts.new > 0) {
    const comp = (isIncluded('BASE_STD_COMPONENT') ? Number(byLine.BASE_STD_COMPONENT.qty) || 0 : 0) + (isIncluded('BASE_ADV_COMPONENT') ? Number(byLine.BASE_ADV_COMPONENT.qty) || 0 : 0);
    if (comp < counts.new) warnings.push({ kind: 'aaif_new', message: `${counts.new} new block${counts.new === 1 ? '' : 's'} identified but only ${comp} reusable component${comp === 1 ? '' : 's'} included.` });
  }
  for (const integ of quote.aaif?.integrations || []) {
    if (integ.existingMeetsRequirement && integ.pricedAs && ['BASE_SHARED_INTEGRATION_NEW', 'BASE_NEW_SIMPLE_API', 'BASE_NEW_ADV_API'].includes(integ.pricedAs) && isIncluded(integ.pricedAs)) {
      blockers.push({ id: integ.pricedAs, kind: 'duplicate', message: `${integ.name}: an existing AAIF connector meets the requirement, so it should be priced as configuration and compatibility review, not a new connector build.` });
    }
  }
  // page level vs bulk static vs records double counting
  const inv = quote.inventory?.entries;
  if (inv && inv.length) {
    const pageIds = ['MIG_L1_PAGE', 'MIG_L2_PAGE', 'MIG_L3_PAGE', 'MIG_BULK_STATIC', 'MIG_STRUCTURED_RECORDS'];
    const sum = pageIds.filter(isIncluded).reduce((a, id) => a + (Number(byLine[id].qty) || 0), 0);
    const migratable = summarize(quote.inventory).migratableUrls;
    if (isNum(migratable) && sum > migratable) {
      warnings.push({ kind: 'double_count', message: `Page and record quantities (${fmtInt(sum)}) exceed the reviewed URLs included for migration (${fmtInt(migratable)}). The same content should be charged once: as a composed page, a bulk static page or a structured record.` });
    }
  }

  // sections
  const sections = [...snap.sections].sort((a, b) => a.order - b.order).map(sec => {
    const inc = lines.filter(l => l.section === sec.id && l.state === 'included');
    const impl = inc.filter(l => !l.isDesign);
    const design = inc.filter(l => l.isDesign);
    const sumOf = arr => arr.reduce((a, l) => a + (l.displayAmount ?? l.amount ?? 0), 0);
    // design lines: allocated amounts are part of an existing fee, shown in the design subtotal
    // an allocation that could not be applied (blocked) is shown as zero until fixed
    const designSubtotal = design.reduce((a, l) => a + ((l.allocated && !l.allocatedFrom) ? 0 : (l.amount ?? 0)), 0);
    const implSubtotal = sumOf(impl);
    const allocatedIntoThisSectionFromElsewhere = design.filter(l => l.allocatedFrom && byLine[l.allocatedFrom].section !== sec.id).reduce((a, l) => a + l.amount, 0);
    const allocatedOutToOtherSections = impl.reduce((a, l) => a + lines.filter(d => d.allocatedFrom === l.id && d.section !== sec.id).reduce((x, d) => x + d.amount, 0), 0);
    const pending = inc.some(l => l.amount === null);
    return {
      ...sec, lines: inc, implementation: impl, design,
      implementationSubtotal: implSubtotal, designSubtotal,
      subtotal: implSubtotal + designSubtotal,
      designAllocated: design.filter(l => l.allocated).reduce((a, l) => a + (l.amount ?? 0), 0),
      designAdditional: design.filter(l => !l.allocated).reduce((a, l) => a + (l.amount ?? 0), 0),
      crossAllocation: { in: allocatedIntoThisSectionFromElsewhere, out: allocatedOutToOtherSections },
      pending, startingAt: inc.some(l => l.startingAt), empty: inc.length === 0,
    };
  });

  // Total = sum of every included line's own amount. An allocated design line is carved out of an
  // existing fee, so it adds nothing; it only moves part of that fee into the design breakdown.
  const included = lines.filter(l => l.state === 'included');
  const total = included.reduce((a, l) => a + (l.allocated ? 0 : (l.amount ?? 0)), 0);
  const check = sections.reduce((a, s) => a + s.subtotal, 0);
  if (check !== total) throw new Error(`Internal consistency check failed: sections ${check} != total ${total}`);

  // optional additions (never in totals)
  const optional = lines.filter(l => l.state === 'optional' && l.item.optionalAvailable !== false).map(l => {
    const oq = l.line.optionalQty;
    let estimate = null;
    if (oq !== undefined && oq !== null && oq !== '' && Number(oq) > 0) {
      const r = priceForQuantity(l.pricing, Number(oq));
      estimate = { qty: Number(oq), amount: r.status === 'priced' ? r.amount : null, status: r.status };
    }
    const unmet = (l.item.dependsOn || []).filter(g => !g.some(id => isIncluded(id) || foundationProvides(quote, id)))
      .map(g => g.map(id => byId[id]?.name || id));
    return { ...l, estimate, priceLabel: shortPrice(l.pricing), requires: unmet };
  });
  const additions = included.filter(l => l.addition).map(l => ({ ...l, kind: 'increment' }));

  if (!included.length) blockers.push({ kind: 'empty', message: 'Nothing is included in the quote yet' });
  const unpriced = blockers.length > 0;
  const startingAt = included.some(l => l.startingAt);
  return {
    sections, lines, total, totalStatus: unpriced ? 'pending' : (startingAt ? 'starting_at' : 'confirmed'),
    blockers, warnings, optional, additions, canExportFinal: blockers.length === 0,
    designSubtotal: sections.reduce((a, s) => a + s.designSubtotal, 0),
  };
}

// Compare a quote's pricing snapshot to a newer library (for "apply current library pricing").
export function diffSnapshots(oldItems, newItems) {
  const o = Object.fromEntries(oldItems.map(i => [i.id, i]));
  const n = Object.fromEntries(newItems.map(i => [i.id, i]));
  const changes = [];
  for (const id of new Set([...Object.keys(o), ...Object.keys(n)])) {
    if (!o[id]) { changes.push({ id, kind: 'added', name: n[id].name }); continue; }
    if (!n[id]) { changes.push({ id, kind: 'removed', name: o[id].name }); continue; }
    const a = JSON.stringify(o[id].pricing), b = JSON.stringify(n[id].pricing);
    if (a !== b) changes.push({ id, kind: 'price', name: n[id].name, before: describePricing(o[id].pricing), after: describePricing(n[id].pricing) });
    else if (o[id].section !== n[id].section) changes.push({ id, kind: 'section', name: n[id].name, before: o[id].section, after: n[id].section });
    else if (JSON.stringify(o[id]) !== JSON.stringify(n[id])) changes.push({ id, kind: 'details', name: n[id].name });
  }
  return changes;
}

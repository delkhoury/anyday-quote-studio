// URL inventory: scan findings are kept separately from Anyday's review decisions.
// Every entry has exactly one migration pricing category at any time.

import { priceForQuantity, effectivePricing, lineFor, quantityFor } from './pricing.js';
import { fmtInt } from './format.js';

export const CATEGORIES = [
  { id: 'L1', label: 'Level 1 composed page', short: 'Level 1', itemId: 'MIG_L1_PAGE', help: 'A major page requiring substantial assembly.' },
  { id: 'L2', label: 'Level 2 composed page', short: 'Level 2', itemId: 'MIG_L2_PAGE', help: 'A supporting page assembled from established patterns.' },
  { id: 'L3', label: 'Level 3 simple page', short: 'Level 3', itemId: 'MIG_L3_PAGE', help: 'A simple, standardised page with limited assembly.' },
  { id: 'BULK_STATIC', label: 'Bulk static page', short: 'Bulk static', itemId: 'MIG_BULK_STATIC', help: 'Near identical static pages migrated in bulk rather than page by page.' },
  { id: 'RECORD', label: 'Structured record', short: 'Record', itemId: 'MIG_STRUCTURED_RECORDS', help: 'Repeatable content such as articles, news, events, people, projects and resources.' },
  { id: 'ARCHIVE', label: 'Generated archive', short: 'Archive', itemId: null, help: 'Tag, category, author or similar routes generated from content. These are not automatically individually composed pages.' },
  { id: 'REVIEW', label: 'Needs classification', short: 'Review', itemId: null, help: 'Not enough evidence to classify. Review before applying quantities.' },
];
export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    if ((x.protocol === 'https:' && x.port === '443') || (x.protocol === 'http:' && x.port === '80')) x.port = '';
    // keep query (it can be meaningful) but drop common tracking params
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) x.searchParams.delete(k);
    let s = x.toString();
    if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1);
    return s;
  } catch { return String(u).trim(); }
}

export function effective(entry) {
  const f = entry.findings || {};
  const d = entry.decision || {};
  const category = d.category || f.category || 'REVIEW';
  const include = d.include !== undefined ? d.include : (f.include !== undefined ? f.include : category !== 'REVIEW');
  const contentType = d.contentType || f.contentType || '';
  const reviewed = !!d.reviewed;
  const needsReview = !reviewed && (category === 'REVIEW' || f.confidence === 'low' || !!f.fetchError);
  return {
    category, include, contentType, reviewed, needsReview,
    blocks: d.blocks || f.suggestedBlocks || [],
    edited: Object.keys(d).some(k => k !== 'reviewed' && d[k] !== undefined),
  };
}

export function summarize(inventory) {
  const entries = inventory?.entries || [];
  const s = {
    discovered: entries.length, included: 0, excluded: 0,
    byCategory: Object.fromEntries(CATEGORIES.map(c => [c.id, 0])),
    byCategoryAll: Object.fromEntries(CATEGORIES.map(c => [c.id, 0])),
    recordsByType: {}, archivesIncluded: 0, needsReview: 0, edited: 0,
    statusCounts: { new: 0, changed: 0, unchanged: 0, not_seen: 0 }, migratableUrls: 0,
    sourceTypes: new Set(),
  };
  for (const e of entries) {
    const ef = effective(e);
    s.byCategoryAll[ef.category]++;
    if (ef.needsReview) s.needsReview++;
    if (ef.edited) s.edited++;
    if (e.status && s.statusCounts[e.status] !== undefined) s.statusCounts[e.status]++;
    if (!ef.include) { s.excluded++; continue; }
    s.included++;
    s.byCategory[ef.category]++;
    if (ef.category === 'RECORD') {
      const t = ef.contentType || 'Uncategorised';
      s.recordsByType[t] = (s.recordsByType[t] || 0) + 1;
      s.sourceTypes.add(e.findings?.sourceCmsType && e.findings.sourceCmsType !== 'Unverified' ? e.findings.sourceCmsType : t);
    }
    if (ef.category === 'ARCHIVE') s.archivesIncluded++;
    if (!['ARCHIVE', 'REVIEW'].includes(ef.category)) s.migratableUrls++;
  }
  s.sourceTypeCount = s.sourceTypes.size;
  s.sourceTypes = [...s.sourceTypes];
  return s;
}

// Merge a fresh scan into an existing inventory without losing decisions.
// Entries absent from the new scan are kept and marked not_seen.
export function mergeScan(inventory, scan) {
  const old = new Map((inventory?.entries || []).map(e => [e.key || normalizeUrl(e.url), e]));
  const seen = new Set();
  const out = [];
  for (const r of scan.entries) {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = old.get(key);
    const findings = { ...r.findings, scanId: scan.id };
    if (!prev) {
      out.push({ url: r.url, key, findings, decision: {}, status: 'new', firstSeen: scan.id, lastSeen: scan.id, origin: 'scan' });
    } else {
      const changed = (prev.findings?.fingerprint && findings.fingerprint && prev.findings.fingerprint !== findings.fingerprint)
        || (prev.findings?.lastmod && findings.lastmod && prev.findings.lastmod !== findings.lastmod)
        || (prev.findings?.category && prev.findings.category !== findings.category);
      out.push({ ...prev, findings, previousFindings: changed ? prev.findings : prev.previousFindings, status: changed ? 'changed' : 'unchanged', lastSeen: scan.id });
    }
  }
  for (const [key, prev] of old) if (!seen.has(key)) out.push({ ...prev, status: 'not_seen' });
  return {
    ...inventory,
    entries: out,
    source: { type: 'scan', label: `Live scan of ${scan.rootUrl}`, date: scan.finishedAt, scanId: scan.id, partial: !!scan.partial, provisional: true },
    scans: [...(inventory?.scans || []), { id: scan.id, rootUrl: scan.rootUrl, startedAt: scan.startedAt, finishedAt: scan.finishedAt, partial: !!scan.partial, coverage: scan.coverage, limits: scan.limits }],
    templates: scan.templates || inventory?.templates || [],
    media: mergeMedia(inventory?.media, scan.media),
    coverage: scan.coverage,
  };
}

function mergeMedia(prev, scanned) {
  return { ...(prev || {}), discovered: scanned?.discovered ?? prev?.discovered ?? null, imageSitemap: scanned?.imageSitemap ?? prev?.imageSitemap ?? null, verified: prev?.verified ?? null };
}

export function applyDecision(entry, patch) {
  return { ...entry, decision: { ...(entry.decision || {}), ...patch } };
}

// ---------------------------------------------------------------------------
// Review and apply quantities: proposals compared with the quote's current quantities.
// Nothing is written until the user applies the rows they choose.
// ---------------------------------------------------------------------------
export function proposeQuantities(quote) {
  const inv = quote.inventory;
  const s = summarize(inv);
  const items = Object.fromEntries(quote.pricingSnapshot.items.map(i => [i.id, i]));
  const dateLabel = inv?.source?.date ? inv.source.date.slice(0, 10) : 'undated';
  const srcLabel = inv?.source?.type === 'imported_example' ? `the dated example inventory (${dateLabel})` : `the reviewed scan (${dateLabel})`;
  const rows = [];
  const push = (id, proposed, basis, assumption, opts = {}) => {
    const item = items[id];
    if (!item) return;
    const line = lineFor(quote, item);
    const p = effectivePricing(item, line);
    const current = quantityFor(quote, item, line);
    const curAmt = line.state === 'included' ? priceForQuantity(p, current) : { amount: 0, status: 'priced' };
    const newAmt = priceForQuantity(p, proposed);
    const cur = line.state === 'included' ? (current ?? null) : null;
    rows.push({
      id, name: item.name, state: line.state, current: cur, proposed, basis, assumption,
      currentAmount: curAmt.status === 'priced' ? curAmt.amount : null,
      proposedAmount: newAmt.status === 'priced' ? newAmt.amount : null,
      change: curAmt.status === 'priced' && newAmt.status === 'priced' ? newAmt.amount - curAmt.amount : null,
      manual: line.qtySource === 'manual',
      selected: opts.selected ?? (proposed !== cur && !(cur === null && !proposed) && line.qtySource !== 'manual'),
      editable: !!opts.editable, note: opts.note,
    });
  };
  push('MIG_L1_PAGE', s.byCategory.L1, `${fmtInt(s.byCategory.L1)} included URLs classified Level 1`, `Level 1 page count reflects ${srcLabel}; classifications are recommendations confirmed during discovery.`);
  push('MIG_L2_PAGE', s.byCategory.L2, `${fmtInt(s.byCategory.L2)} included URLs classified Level 2`, `Level 2 page count reflects ${srcLabel}.`);
  push('MIG_L3_PAGE', s.byCategory.L3, `${fmtInt(s.byCategory.L3)} included URLs classified Level 3`, `Level 3 page count reflects ${srcLabel}.`);
  push('MIG_BULK_STATIC', s.byCategory.BULK_STATIC, `${fmtInt(s.byCategory.BULK_STATIC)} included URLs classified bulk static`, 'Bulk static pages are near identical and are not also charged as composed pages.');
  push('MIG_STRUCTURED_RECORDS', s.byCategory.RECORD, `${fmtInt(s.byCategory.RECORD)} included structured records across ${s.sourceTypeCount} content type${s.sourceTypeCount === 1 ? '' : 's'}`, `Structured record volume reflects ${srcLabel}; generated archives are regenerated, not charged per URL.`);
  push('MIG_CONTENT_TYPE_MAP', s.sourceTypeCount, `${s.sourceTypeCount} distinct record types observed: ${s.sourceTypes.slice(0, 8).join(', ')}${s.sourceTypes.length > 8 ? '…' : ''}`, 'Source content type count is based on publicly observable types and should be confirmed against a CMS export.', { selected: false, note: 'Public sitemaps do not always expose CMS types. Off by default.' });
  const verified = inv?.media?.verified;
  if (verified && Number.isFinite(verified.migrateTotal ?? verified.total)) {
    const v = verified.migrateTotal ?? verified.total;
    push('MIG_MEDIA', v, `Verified CMS media export: ${fmtInt(v)} assets (${verified.fileName || 'export'})`, 'Media volume is based on the verified CMS media export.');
  }
  const redirectRef = s.migratableUrls + s.byCategory.ARCHIVE;
  push('MIG_REDIRECTS', quantityFor(quote, items.MIG_REDIRECTS, lineFor(quote, items.MIG_REDIRECTS)) ?? 0, `Up to ${fmtInt(redirectRef)} included URLs could change. Only URLs whose path changes need a redirect.`, 'Redirect volume is a planning allowance; URLs that keep their path need no redirect.', { selected: false, editable: true, note: 'Set independently. Not derived from the URL count.' });
  return { rows, summary: s };
}

export function applyProposals(quote, rows, { at = new Date().toISOString() } = {}) {
  const lines = { ...(quote.lines || {}) };
  const applied = [];
  for (const r of rows) {
    if (!r.selected) continue;
    const prev = lines[r.id] || {};
    const state = prev.state === 'hidden' || !prev.state || prev.state === 'optional' ? (Number(r.proposed) > 0 ? 'included' : (prev.state || 'optional')) : prev.state;
    lines[r.id] = { ...prev, state, qty: Number(r.proposed), qtySource: r.editable ? 'manual' : 'inventory', qtyAppliedAt: at };
    applied.push(r);
  }
  const auto = new Set((quote.proposal?.autoAssumptions || []));
  for (const r of applied) if (r.assumption) auto.add(r.assumption);
  return { ...quote, lines, proposal: { ...(quote.proposal || {}), autoAssumptions: [...auto] }, history: [...(quote.history || []), { at, kind: 'apply_quantities', rows: applied.map(r => ({ id: r.id, from: r.current, to: r.proposed })) }] };
}

export function inventoryCsv(quote) {
  const rows = [['URL', 'Title', 'Content type', 'Migration category', 'Included', 'Classification reason', 'Evidence source', 'Confidence', 'Review status', 'Scan status', 'Suggested AAIF blocks']];
  for (const e of quote.inventory?.entries || []) {
    const ef = effective(e);
    rows.push([e.url, e.findings?.title || '', ef.contentType, CATEGORY_BY_ID[ef.category]?.label || ef.category,
      ef.category === 'ARCHIVE' ? (ef.include ? 'Regenerate' : 'No') : (ef.include ? 'Yes' : 'No'),
      e.decision?.notes ? `${e.findings?.reason || ''} | Reviewer: ${e.decision.notes}` : (e.findings?.reason || ''),
      e.findings?.evidence || '', e.findings?.confidence || '', ef.reviewed ? 'Reviewed' : (ef.needsReview ? 'Needs review' : 'Recommendation'),
      e.status || '', (ef.blocks || []).join('; ')]);
  }
  return rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)).join(',')).join('\n');
}

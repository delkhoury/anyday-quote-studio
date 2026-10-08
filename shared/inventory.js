// URL inventory: scan findings are kept separately from Anyday's review decisions.
// Every entry has exactly one migration pricing category at any time.

import { priceForQuantity, effectivePricing, lineFor, quantityFor, incrementalPrice } from './pricing.js';
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

export function siteKeyOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// Which site type an inventory entry belongs to. Entries from before site types existed
// belong to the first site type.
export function groupOf(entry, groups) {
  if (entry.groupId && (!groups || groups.some(g => g.id === entry.groupId))) return entry.groupId;
  return groups?.[0]?.id || 'main';
}

export function summarize(inventory, { groupId = null, groups = null } = {}) {
  const all = inventory?.entries || [];
  const entries = groupId ? all.filter(e => groupOf(e, groups) === groupId) : all;
  const s = {
    discovered: entries.length, included: 0, excluded: 0,
    byCategory: Object.fromEntries(CATEGORIES.map(c => [c.id, 0])),
    byCategoryAll: Object.fromEntries(CATEGORIES.map(c => [c.id, 0])),
    recordsByType: {}, archivesIncluded: 0, needsReview: 0, edited: 0,
    statusCounts: { new: 0, changed: 0, unchanged: 0, not_seen: 0 }, migratableUrls: 0,
    sourceTypes: new Set(), sites: new Set(),
  };
  for (const e of entries) {
    const ef = effective(e);
    s.byCategoryAll[ef.category]++;
    s.sites.add(e.siteKey || siteKeyOf(e.url));
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
  s.siteCount = s.sites.size;
  s.sites = [...s.sites];
  return s;
}

// Merge a fresh scan into an existing inventory without losing decisions.
// Entries absent from the new scan are kept and marked not_seen.
export function mergeScan(inventory, scan, { groupId = 'main' } = {}) {
  const site = siteKeyOf(scan.rootUrl || scan.entries?.[0]?.url || '');
  const all = inventory?.entries || [];
  // only entries from the scanned site take part; other sampled sites are left untouched
  const others = all.filter(e => (e.siteKey || siteKeyOf(e.url)) !== site);
  const old = new Map(all.filter(e => (e.siteKey || siteKeyOf(e.url)) === site).map(e => [e.key || normalizeUrl(e.url), e]));
  const seen = new Set();
  const out = [];
  for (const r of scan.entries) {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = old.get(key);
    const findings = { ...r.findings, scanId: scan.id };
    if (!prev) {
      out.push({ url: r.url, key, siteKey: site, groupId, findings, decision: {}, status: 'new', firstSeen: scan.id, lastSeen: scan.id, origin: 'scan' });
    } else {
      const changed = (prev.findings?.fingerprint && findings.fingerprint && prev.findings.fingerprint !== findings.fingerprint)
        || (prev.findings?.lastmod && findings.lastmod && prev.findings.lastmod !== findings.lastmod)
        || (prev.findings?.category && prev.findings.category !== findings.category);
      out.push({ ...prev, siteKey: site, groupId, findings, previousFindings: changed ? prev.findings : prev.previousFindings, status: changed ? 'changed' : 'unchanged', lastSeen: scan.id });
    }
  }
  for (const [key, prev] of old) if (!seen.has(key)) out.push({ ...prev, siteKey: site, status: 'not_seen' });
  return {
    ...inventory,
    entries: [...others, ...out],
    source: { type: 'scan', label: `Live scan of ${scan.rootUrl}`, date: scan.finishedAt, scanId: scan.id, partial: !!scan.partial, provisional: true },
    scans: [...(inventory?.scans || []), { id: scan.id, rootUrl: scan.rootUrl, site, groupId, startedAt: scan.startedAt, finishedAt: scan.finishedAt, partial: !!scan.partial, coverage: scan.coverage, limits: scan.limits }],
    templates: [...(inventory?.templates || []).filter(t => t.site && t.site !== site), ...(scan.templates || []).map(t => ({ ...t, site, groupId }))],
    media: mergeMedia(inventory?.media, scan.media, site),
    coverage: scan.coverage,
  };
}

function mergeMedia(prev, scanned, site) {
  // per site media findings are kept separately and added up; verified CMS totals are untouched
  const bySite = { ...(prev?.bySite || {}) };
  if (scanned) bySite[site] = { discovered: scanned.discovered ?? null, imageSitemap: scanned.imageSitemap ?? null };
  const sites = Object.values(bySite);
  const sum = (f) => sites.reduce((a, x) => a + (f(x) || 0), 0);
  const discovered = sites.some(x => x.discovered) ? {
    pagesInspected: sum(x => x.discovered?.pagesInspected),
    images: { unique: sum(x => x.discovered?.images?.unique), references: sum(x => x.discovered?.images?.references), variantsCollapsed: sum(x => x.discovered?.images?.variantsCollapsed) },
    documents: { unique: sum(x => x.discovered?.documents?.unique) },
    videos: { externalReferences: sum(x => x.discovered?.videos?.externalReferences), note: 'External video embeds are references, not files to migrate' },
    label: `Media URLs found on ${sum(x => x.discovered?.pagesInspected)} inspected page(s) across ${sites.length} scanned site(s). This is not a complete media library count.`,
  } : (prev?.discovered ?? null);
  const imageSitemap = sites.some(x => x.imageSitemap) ? { entries: sum(x => x.imageSitemap?.entries), unique: sum(x => x.imageSitemap?.unique), label: 'Image entries declared in the scanned sites\' sitemaps' } : (prev?.imageSitemap ?? null);
  return { ...(prev || {}), bySite, discovered, imageSitemap, verified: prev?.verified ?? null };
}

export function applyDecision(entry, patch) {
  return { ...entry, decision: { ...(entry.decision || {}), ...patch } };
}

// ---------------------------------------------------------------------------
// Portfolio: site types (groups of similar sites). Each type's reviewed inventory is
// averaged over its sampled sites and multiplied by the number of sites of that type.
// A type with no scan can carry manual per-site figures instead.
// ---------------------------------------------------------------------------
const PORTFOLIO_CATS = ['L1', 'L2', 'L3', 'BULK_STATIC', 'RECORD', 'ARCHIVE'];

export function portfolioSummary(quote) {
  const groups = quote.siteGroups?.length ? quote.siteGroups : [{ id: 'main', name: 'Website', count: 1, samples: [] }];
  const totals = Object.fromEntries(PORTFOLIO_CATS.map(c => [c, 0]));
  const recordsByType = {};
  const sourceTypes = new Set();
  let extrapolated = false; let totalSites = 0; let missing = [];
  const out = groups.map(g => {
    const s = summarize(quote.inventory, { groupId: g.id, groups });
    const count = Math.max(0, Number(g.count) || 0);
    totalSites += count;
    let sampled = s.siteCount, perSite = {}, source = 'none', perSiteTypes = {};
    if (sampled > 0) {
      source = 'scan';
      for (const c of PORTFOLIO_CATS) perSite[c] = s.byCategory[c] / sampled;
      for (const [t, n] of Object.entries(s.recordsByType)) perSiteTypes[t] = n / sampled;
      s.sourceTypes.forEach(t => sourceTypes.add(t));
    } else if (g.manual) {
      source = 'manual'; sampled = 0;
      for (const c of PORTFOLIO_CATS) perSite[c] = Number(g.manual[c]) || 0;
      if (perSite.RECORD) { perSiteTypes['Structured records'] = perSite.RECORD; sourceTypes.add(`${g.name} records`); }
    } else { for (const c of PORTFOLIO_CATS) perSite[c] = 0; if (count > 0) missing.push(g.name); }
    const exact = source === 'scan' && sampled >= count;
    if (source !== 'none' && !exact) extrapolated = true;
    const gt = {};
    for (const c of PORTFOLIO_CATS) { gt[c] = exact ? s.byCategory[c] : Math.round(perSite[c] * count); totals[c] += gt[c]; }
    for (const [t, n] of Object.entries(perSiteTypes)) recordsByType[t] = (recordsByType[t] || 0) + (exact ? Math.round(n * sampled) : Math.round(n * count));
    return { ...g, count, sampled, source, perSite, totals: gt, exact, discovered: s.discovered };
  });
  const migratableUrls = totals.L1 + totals.L2 + totals.L3 + totals.BULK_STATIC + totals.RECORD;
  return { groups: out, totals, totalSites, recordsByType, sourceTypes: [...sourceTypes], sourceTypeCount: sourceTypes.size, migratableUrls, extrapolated, missing };
}

// ---------------------------------------------------------------------------
// Review and apply quantities: proposals compared with the quote's current quantities.
// Nothing is written until the user applies the rows they choose.
// ---------------------------------------------------------------------------
export function proposeQuantities(quote) {
  const inv = quote.inventory;
  const s = summarize(inv);
  const pf = portfolioSummary(quote);
  const T = pf.totals;
  const items = Object.fromEntries(quote.pricingSnapshot.items.map(i => [i.id, i]));
  const dateLabel = inv?.source?.date ? inv.source.date.slice(0, 10) : 'undated';
  const anyScan = pf.groups.some(g => g.source === 'scan');
  const anyManual = pf.groups.some(g => g.source === 'manual');
  const srcLabel = inv?.source?.type === 'imported_example' ? `the dated example inventory (${dateLabel})`
    : anyScan ? `the reviewed scan${pf.groups.length > 1 ? 's' : ''} (${dateLabel})${anyManual ? ' and typical per site figures for site types without a scan' : ''}`
    : 'typical per site figures provided for each site type';
  const ex = pf.extrapolated ? `, extrapolated from sampled sites to ${fmtInt(pf.totalSites)} sites` : '';
  const exNote = pf.extrapolated ? ' Figures for site types are extrapolated from the sampled sites in each type.' : '';
  const rows = [];
  const push = (id, proposed, basis, assumption, opts = {}) => {
    const item = items[id];
    if (!item) return;
    const line = lineFor(quote, item);
    const p = effectivePricing(item, line);
    const current = quantityFor(quote, item, line);
    const prior = Number(line.priorQty) || 0;
    const amt = q => prior > 0 ? incrementalPrice(p, prior, q) : priceForQuantity(p, q);
    const hasQty = current !== null && current !== undefined && current !== '';
    const curAmt = line.state === 'included' && hasQty ? amt(current) : { amount: 0, status: 'priced' };
    const newAmt = amt(proposed);
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
  if (pf.totalSites !== 1 || (quote.siteGroups || []).length > 1 || quote.type !== 'foundation_site') {
    push('MIG_SITE_ACTIVATION', pf.totalSites, `${fmtInt(pf.totalSites)} site${pf.totalSites === 1 ? '' : 's'} across ${pf.groups.length} site type${pf.groups.length === 1 ? '' : 's'}${(Number(quote.lines?.MIG_SITE_ACTIVATION?.priorQty) || 0) > 0 ? `, continuing from ${fmtInt(quote.lines.MIG_SITE_ACTIVATION.priorQty)} already live` : ''}`, `The portfolio includes ${fmtInt(pf.totalSites)} site${pf.totalSites === 1 ? '' : 's'}.`);
  }
  push('MIG_L1_PAGE', T.L1, `${fmtInt(T.L1)} included URLs classified Level 1${ex}`, `Level 1 page count reflects ${srcLabel}; classifications are recommendations confirmed during discovery.${exNote}`);
  push('MIG_L2_PAGE', T.L2, `${fmtInt(T.L2)} included URLs classified Level 2${ex}`, `Level 2 page count reflects ${srcLabel}.${exNote}`);
  push('MIG_L3_PAGE', T.L3, `${fmtInt(T.L3)} included URLs classified Level 3${ex}`, `Level 3 page count reflects ${srcLabel}.${exNote}`);
  push('MIG_BULK_STATIC', T.BULK_STATIC, `${fmtInt(T.BULK_STATIC)} included URLs classified bulk static${ex}`, 'Bulk static pages are near identical and are not also charged as composed pages.');
  push('MIG_STRUCTURED_RECORDS', T.RECORD, `${fmtInt(T.RECORD)} included structured records across ${pf.sourceTypeCount} content type${pf.sourceTypeCount === 1 ? '' : 's'}${ex}`, `Structured record volume reflects ${srcLabel}; generated archives are regenerated, not charged per URL.${exNote}`);
  push('MIG_CONTENT_TYPE_MAP', pf.sourceTypeCount, `${pf.sourceTypeCount} distinct record types observed: ${pf.sourceTypes.slice(0, 8).join(', ')}${pf.sourceTypes.length > 8 ? '…' : ''}`, 'Source content type count is based on publicly observable types and should be confirmed against a CMS export.', { selected: false, note: 'Public sitemaps do not always expose CMS types. Off by default.' });
  const verified = inv?.media?.verified;
  if (verified && Number.isFinite(verified.migrateTotal ?? verified.total)) {
    const v = verified.migrateTotal ?? verified.total;
    push('MIG_MEDIA', v, `Verified CMS media export: ${fmtInt(v)} assets (${verified.fileName || 'export'})`, 'Media volume is based on the verified CMS media export.');
  }
  const redirectRef = pf.migratableUrls + T.ARCHIVE;
  push('MIG_REDIRECTS', quantityFor(quote, items.MIG_REDIRECTS, lineFor(quote, items.MIG_REDIRECTS)) ?? 0, `Up to ${fmtInt(redirectRef)} included URLs could change. Only URLs whose path changes need a redirect.`, 'Redirect volume is a planning allowance; URLs that keep their path need no redirect.', { selected: false, editable: true, note: 'Set independently. Not derived from the URL count.' });
  if (pf.totalSites > 1) push('MIG_BRAND_CONFIG', pf.totalSites, `One brand configuration per site (${fmtInt(pf.totalSites)} sites)`, 'Each site receives its own brand configuration using the existing global controls.', { selected: false, editable: true, note: 'Lower this if several sites share one brand.' });
  return { rows, summary: s, portfolio: pf };
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
  const groupName = Object.fromEntries((quote.siteGroups || []).map(g => [g.id, g.name]));
  const rows = [['Site type', 'URL', 'Title', 'Content type', 'Migration category', 'Included', 'Classification reason', 'Evidence source', 'Confidence', 'Review status', 'Scan status', 'Suggested components']];
  for (const e of quote.inventory?.entries || []) {
    const ef = effective(e);
    rows.push([groupName[groupOf(e, quote.siteGroups)] || '', e.url, e.findings?.title || '', ef.contentType, CATEGORY_BY_ID[ef.category]?.label || ef.category,
      ef.category === 'ARCHIVE' ? (ef.include ? 'Regenerate' : 'No') : (ef.include ? 'Yes' : 'No'),
      e.decision?.notes ? `${e.findings?.reason || ''} | Reviewer: ${e.decision.notes}` : (e.findings?.reason || ''),
      e.findings?.evidence || '', e.findings?.confidence || '', ef.reviewed ? 'Reviewed' : (ef.needsReview ? 'Needs review' : 'Recommendation'),
      e.status || '', (ef.blocks || []).join('; ')]);
  }
  return rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)).join(',')).join('\n');
}

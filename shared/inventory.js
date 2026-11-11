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
    insights: scan.insights ? { ...(inventory?.insights || {}), [site]: { ...scan.insights, groupId, scanId: scan.id, at: scan.finishedAt } } : (inventory?.insights || {}),
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
// Planning allowance for media when no CMS export is verified: unique images and documents per
// inspected page, scaled to every included URL across the portfolio; never below the image
// sitemap count (scaled to all sites when only samples were scanned).
export function mediaEstimate(media, pf) {
  const d = media?.discovered; const sm = media?.imageSitemap;
  const pages = d?.pagesInspected || 0;
  const found = (d?.images?.unique || 0) + (d?.documents?.unique || 0);
  const scannedSites = Object.keys(media?.bySite || {}).length || 1;
  const siteScale = pf.totalSites && pf.extrapolated ? pf.totalSites / scannedSites : 1;
  const perPage = pages ? found / pages : 0;
  const fromPages = Math.round(perPage * (pf.migratableUrls || 0));
  const fromSitemap = Math.round((sm?.unique || 0) * siteScale);
  const qty = Math.max(fromPages, fromSitemap);
  if (!qty) return null;
  const parts = [];
  if (fromPages) parts.push(`${fmtInt(found)} unique images and documents on ${fmtInt(pages)} inspected pages (${(Math.round(perPage * 10) / 10).toLocaleString('en-US')} per page) × ${fmtInt(pf.migratableUrls)} included URLs`);
  if (fromSitemap) parts.push(`${fmtInt(sm.unique)} image sitemap entries${siteScale !== 1 ? ` scaled to ${fmtInt(pf.totalSites)} sites` : ''}`);
  return { qty, basis: `Estimated ${fmtInt(qty)} assets: the larger of ${parts.join(' and ')}.`, fromPages, fromSitemap };
}

// ---------------------------------------------------------------------------
// Site insights across the scanned sites: CMS, exact CMS counts, integrations, languages,
// templates and components. A platform shares templates and components, so those take the
// largest scanned site; volumes (records, media) scale by site type like the inventory.
// ---------------------------------------------------------------------------
const PAGE_TYPES = /^(page|pages)$/;
export function siteInsights(quote) {
  const all = quote.inventory?.insights || {};
  const groups = quote.siteGroups?.length ? quote.siteGroups : [{ id: 'main', name: 'Website', count: 1 }];
  const sites = Object.entries(all).map(([site, i]) => ({ site, ...i, groupId: groups.some(g => g.id === i.groupId) ? i.groupId : groups[0].id }));
  if (!sites.length) return null;
  const cms = {}; const integ = {}; let langs = { count: 1, codes: [] };
  let components = { count: 0, standard: 0, interactive: 0 }; let templates = { count: 0, advanced: 0 }; let compSite = null; let tplSite = null;
  const recordTypes = new Set();
  for (const x of sites) {
    if (x.cms) (cms[x.cms.id] = cms[x.cms.id] || { ...x.cms, sites: [] }).sites.push(x.site);
    for (const i of x.integrations || []) (integ[i.id] = integ[i.id] || { id: i.id, name: i.name, category: i.category, categoryName: i.categoryName, sites: [] }).sites.push(x.site);
    if ((x.languages?.count || 1) > langs.count) langs = { count: x.languages.count, codes: x.languages.codes, evidence: x.languages.evidence, site: x.site };
    if ((x.components?.count || 0) > components.count) { components = x.components; compSite = x.site; }
    if ((x.templates?.count || 0) > templates.count) { templates = x.templates; tplSite = x.site; }
    for (const t of x.cmsCounts?.available ? x.cmsCounts.types : []) if (!PAGE_TYPES.test(t.slug) && t.total > 0) recordTypes.add(t.name);
  }
  // exact CMS volumes, scaled per site type
  const withCounts = sites.filter(x => x.cmsCounts?.available);
  const scaled = f => {
    let total = 0; let extrapolated = false;
    for (const g of groups) {
      const xs = withCounts.filter(x => x.groupId === g.id); if (!xs.length) continue;
      const n = Math.max(0, Number(g.count) || 0);
      const vals = xs.map(f).filter(v => Number.isFinite(v));
      if (!vals.length) continue;
      if (xs.length >= n) total += vals.reduce((a, b) => a + b, 0);
      else { total += Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * n); extrapolated = true; }
    }
    return { total, extrapolated };
  };
  const recordsOf = x => x.cmsCounts.types.filter(t => !PAGE_TYPES.test(t.slug)).reduce((a, t) => a + (t.total || 0), 0);
  const pagesOf = x => x.cmsCounts.types.filter(t => PAGE_TYPES.test(t.slug)).reduce((a, t) => a + (t.total || 0), 0);
  const coversAll = groups.every(g => !(Number(g.count) > 0) || withCounts.some(x => x.groupId === g.id));
  const exact = withCounts.length ? {
    sites: withCounts.length, coversAll, cms: withCounts[0].cmsCounts.source,
    records: scaled(recordsOf), pages: scaled(pagesOf), media: scaled(x => x.cmsCounts.media ?? NaN),
    recordTypes: [...recordTypes],
    types: withCounts.length === 1 ? withCounts[0].cmsCounts.types : null, taxonomies: withCounts.length === 1 ? withCounts[0].cmsCounts.taxonomies : null,
  } : null;
  return {
    sites: sites.map(x => ({ site: x.site, groupId: x.groupId, cms: x.cms, pagesInspected: x.pagesInspected, components: x.components?.count || 0, templates: x.templates?.count || 0, languages: x.languages?.count || 1, integrations: (x.integrations || []).length, exact: !!x.cmsCounts?.available })),
    cms: Object.values(cms), integrations: Object.values(integ).sort((a, b) => a.category.localeCompare(b.category)),
    languages: langs, components: { ...components, site: compSite }, templates: { ...templates, site: tplSite }, exact,
  };
}

const BUSINESS_INTEGRATIONS = new Set(['crm', 'newsletter', 'search', 'commerce', 'booking', 'events', 'identity', 'translation']);

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
    if (!item || rows.some(r => r.id === id)) return;
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
  const exactTypes = siteInsights(quote)?.exact;
  if (exactTypes?.recordTypes?.length) push('MIG_CONTENT_TYPE_MAP', exactTypes.recordTypes.length, `${exactTypes.recordTypes.length} published content types reported by the ${cmsLabel(exactTypes.cms)}: ${exactTypes.recordTypes.slice(0, 8).join(', ')}`, 'Source content types are the published types reported by the site\'s CMS, excluding pages, media and system types.', { note: 'Exact from the CMS, not inferred from the sitemap.' });
  else push('MIG_CONTENT_TYPE_MAP', pf.sourceTypeCount, `${pf.sourceTypeCount} distinct record types observed: ${pf.sourceTypes.slice(0, 8).join(', ')}${pf.sourceTypes.length > 8 ? '…' : ''}`, 'Source content type count is based on publicly observable types and should be confirmed against a CMS export.', { selected: false, note: 'Public sitemaps do not always expose CMS types. Off by default.' });
  const verified = inv?.media?.verified;
  if (verified && Number.isFinite(verified.migrateTotal ?? verified.total)) {
    const v = verified.migrateTotal ?? verified.total;
    push('MIG_MEDIA', v, `Verified CMS media export: ${fmtInt(v)} assets (${verified.fileName || 'export'})`, 'Media volume is based on the verified CMS media export.');
  } else if (siteInsights(quote)?.exact?.media?.total > 0) {
    const ex = siteInsights(quote).exact; const m = ex.media;
    const line = quote.lines?.MIG_MEDIA || {};
    const empty = line.qty === undefined || line.qty === null || Number(line.qty) === 0;
    push('MIG_MEDIA', m.total, `${fmtInt(m.total)} files in the media library, reported by the ${cmsLabel(ex.cms)}${m.extrapolated ? `, extrapolated from ${fmtInt(ex.sites)} scanned site${ex.sites === 1 ? '' : 's'} to ${fmtInt(pf.totalSites)}` : ''}`, `Media volume is the media library total reported by the site's CMS${m.extrapolated ? ', extrapolated from the sampled sites' : ''}. Unused files can be excluded once a CMS media export is reviewed.`, { selected: empty && line.qtySource !== 'manual', editable: true, note: 'From the CMS media library count. This includes files that may no longer be used on any page.' });
  } else {
    const est = mediaEstimate(inv?.media, pf);
    if (est) {
      const line = quote.lines?.MIG_MEDIA || {};
      const empty = line.qty === undefined || line.qty === null || Number(line.qty) === 0;
      push('MIG_MEDIA', est.qty, est.basis, 'Media volume is a planning allowance estimated from the website scan, which does not see the whole media library. It will be confirmed against a CMS media export.', { selected: empty && line.qtySource !== 'manual', editable: true, note: 'Estimate from the scan. Import a CMS media export on Analyse for a verified count.' });
    }
  }
  const redirectRef = pf.migratableUrls + T.ARCHIVE;
  push('MIG_REDIRECTS', quantityFor(quote, items.MIG_REDIRECTS, lineFor(quote, items.MIG_REDIRECTS)) ?? 0, `Up to ${fmtInt(redirectRef)} included URLs could change. Only URLs whose path changes need a redirect.`, 'Redirect volume is a planning allowance; URLs that keep their path need no redirect.', { selected: false, editable: true, note: 'Set independently. Not derived from the URL count.' });
  insightRows(quote, push, siteInsights(quote), pf, T, rows);
  if (pf.totalSites > 1) push('MIG_BRAND_CONFIG', pf.totalSites, `One brand configuration per site (${fmtInt(pf.totalSites)} sites)`, 'Each site receives its own brand configuration using the existing global controls.', { selected: false, editable: true, note: 'Lower this if several sites share one brand.' });
  return { rows, summary: s, portfolio: pf };
}

const cmsLabel = src => src === 'wp-rest' ? 'WordPress REST API' : 'CMS';

// Rows from site insights: exact record cross check, scratch build templates and components,
// languages and integrations. Only exact or clearly derived figures are selected by default.
function insightRows(quote, push, si, pf, T, rows) {
  if (!si) return;
  const lines = quote.lines || {};
  const isEmpty = id => { const l = lines[id] || {}; return (l.qty === undefined || l.qty === null || l.qty === '' || Number(l.qty) === 0) && l.qtySource !== 'manual'; };
  const scratch = ['new_site', 'new_platform'].includes(quote.type);
  if (scratch) {
    const recTypes = si.exact?.recordTypes?.length || pf.sourceTypeCount || 0;
    const adv = si.templates.advanced || 0; const std = Math.max(0, (si.templates.count || 0) - adv) + recTypes;
    const where = si.templates.site && si.sites.length > 1 ? ` (largest scanned site, ${si.templates.site})` : '';
    if (std) push('BASE_STD_PAGE_TEMPLATE', std, `${fmtInt(Math.max(0, si.templates.count - adv))} repeated page layouts found by the scan${where}, plus one detail template for each of ${fmtInt(recTypes)} record type${recTypes === 1 ? '' : 's'}`, 'Page template counts come from distinct page structures found on the current site and are confirmed in discovery.', { selected: isEmpty('BASE_STD_PAGE_TEMPLATE'), editable: true, note: 'Layouts shared by two or more pages. One off pages are assembled from components instead.' });
    if (adv) push('BASE_ADV_PAGE_TEMPLATE', adv, `${fmtInt(adv)} page layout${adv === 1 ? '' : 's'} with six or more section types or used by Level 1 pages`, 'Advanced templates are layouts with many section types or major landing pages.', { selected: isEmpty('BASE_ADV_PAGE_TEMPLATE'), editable: true });
    const c = si.components;
    const whereC = c.site && si.sites.length > 1 ? ` on the largest scanned site (${c.site})` : '';
    if (c.standard) push('BASE_STD_COMPONENT', c.standard, `${fmtInt(c.standard)} distinct static section patterns${whereC}: same section type and shape counted once`, 'Component counts are estimated from distinct section patterns on the current site and are confirmed in discovery.', { selected: isEmpty('BASE_STD_COMPONENT'), editable: true, note: 'An estimate from page structure. Review against the brief before applying.' });
    if (c.interactive) push('BASE_ADV_COMPONENT', c.interactive, `${fmtInt(c.interactive)} interactive section patterns${whereC} (forms, tabs, accordions, carousels or embeds)`, 'Advanced components are the interactive section patterns found on the current site.', { selected: isEmpty('BASE_ADV_COMPONENT'), editable: true, note: 'An estimate from page structure.' });
    if (recTypes) push('BASE_STRUCT_CONTENT_MODEL', recTypes, `${fmtInt(recTypes)} record type${recTypes === 1 ? '' : 's'}${si.exact?.recordTypes?.length ? ` reported by the ${cmsLabel(si.exact.cms)}: ${si.exact.recordTypes.slice(0, 6).join(', ')}` : ' observed in the sitemaps'}`, 'Each source record type becomes a structured content model.', { selected: isEmpty('BASE_STRUCT_CONTENT_MODEL'), editable: true });
  }
  if (si.exact?.records?.total && si.exact.coversAll) {
    const r = si.exact.records.total;
    const row = rows.find(x => x.id === 'MIG_STRUCTURED_RECORDS');
    if (row && Math.abs(r - T.RECORD) / Math.max(r, 1) > 0.1) {
      row.basis += `. The ${cmsLabel(si.exact.cms)} reports ${fmtInt(r)} published records${si.exact.records.extrapolated ? ' (extrapolated)' : ''}; the gap is usually records left out of the sitemap or listed as pages`;
      row.note = `Cross check: the CMS reports ${fmtInt(r)}. Change it in Scope if you want to commit to that figure.`;
      row.cmsTotal = r;
    } else if (row) row.basis += `. Matches the ${fmtInt(r)} published records the ${cmsLabel(si.exact.cms)} reports`;
  }
  const langs = si.languages?.count || 1;
  if (langs > 1) push('MIG_LANGUAGE', langs - 1, `${langs} languages found (${(si.languages.codes || []).join(', ')}), so ${langs - 1} additional language${langs - 1 === 1 ? '' : 's'} beyond the first`, `The current site publishes in ${langs} languages; each additional language is configured on the new build.`, { selected: isEmpty('MIG_LANGUAGE'), editable: true, note: si.languages.evidence });
  const ints = si.integrations || [];
  const names = cat => ints.filter(i => i.category === cat).map(i => i.name);
  if (names('analytics').length) push('MIG_ANALYTICS', 1, `Analytics found on the current site: ${names('analytics').join(', ')}`, 'Analytics is reconfigured and validated on the new build.', { selected: false, editable: true, note: 'Detected from page scripts.' });
  if (scratch) {
    const biz = ints.filter(i => BUSINESS_INTEGRATIONS.has(i.category));
    if (biz.length) push('BASE_SHARED_INTEGRATION_NEW', biz.length, `Third party services found on the current site: ${biz.map(i => i.name).join(', ')}`, 'Integrations found on the current site are rebuilt on the new platform unless the brief retires them.', { selected: false, editable: true, note: 'Detected from page scripts. Confirm which ones the client keeps.' });
  } else {
    if (names('crm').length) push('MIG_CRM_SETUP', 1, `CRM or marketing automation found: ${names('crm').join(', ')}`, 'The existing CRM connection is set up on the new site.', { selected: false, editable: true, note: 'Detected from page scripts.' });
    if (names('newsletter').length) push('MIG_NEWSLETTER', 1, `Newsletter platform found: ${names('newsletter').join(', ')}`, 'The newsletter sign up is connected on the new site.', { selected: false, editable: true, note: 'Detected from page scripts.' });
  }
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

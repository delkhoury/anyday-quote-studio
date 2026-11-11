// Scan orchestrator: robots -> sitemaps (or an explicitly requested bounded crawl) -> scope filter
// -> bounded page inspection -> grouping -> classification -> media summary.
import crypto from 'node:crypto';
import { safeFetch, validateUrl, ScanError, USER_AGENT } from './net.js';
import { parseRobots, makeRobotsChecker } from './robots.js';
import { collectSitemaps, COMMON_SITEMAP_PATHS } from './sitemap.js';
import { extractPage } from './extract.js';
import { probeWordPress, buildInsights } from './insights.js';
import { groupUrls, urlPattern, sitemapHint, classifyInspected, classifyUninspected, suggestBlocks, summarizeMedia, isArchiveUrl } from './classify.js';

export const DEFAULT_LIMITS = {
  maxSitemaps: 200, maxUrls: 20000, maxPagesInspect: 150, maxCrawlPages: 300, maxCrawlDepth: 3,
  requestTimeoutMs: 15000, maxPageBytes: 3 * 1024 * 1024, concurrency: 4, minDelayMs: 250, maxCrawlDelayMs: 5000, totalBudgetMs: 10 * 60 * 1000,
};

const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

export async function runScan({ rootUrl, includeHosts = [], crawlIfNoSitemap = false, limits: lim = {}, catalogueIds = [], onProgress = () => {}, signal } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...lim };
  limits.maxPagesInspect = Math.min(limits.maxPagesInspect, 600);
  const started = Date.now();
  const id = 'scan_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '_' + crypto.randomBytes(3).toString('hex');
  const log = []; const failures = [];
  const inspectedData = new Map();
  let disallowed = []; let budgetHit = false;
  const progress = (phase, message, extra = {}) => { const p = { phase, message, at: new Date().toISOString(), ...extra }; log.push(p); onProgress(p); };
  const timeLeft = () => limits.totalBudgetMs - (Date.now() - started);

  const root = validateUrl(rootUrl);
  const origin = root.origin;
  const rootHost = root.hostname;
  const allowedHosts = new Set([rootHost, ...includeHosts.map(h => h.toLowerCase())]);
  const inScope = u => { try { const h = new URL(u).hostname.toLowerCase(); return [...allowedHosts].some(a => sameSite(a, h)); } catch { return false; } };

  // 1. robots.txt
  progress('robots', `Reading ${origin}/robots.txt`);
  let robots = { groups: [], sitemaps: [] }; let robotsStatus = null;
  try {
    const r = await safeFetch(origin + '/robots.txt', { timeoutMs: limits.requestTimeoutMs, maxBytes: 512 * 1024, accept: 'text/plain', signal });
    robotsStatus = r.status;
    if (r.status < 400) robots = parseRobots(r.body.toString('utf8'));
  } catch (e) {
    if (e.code === 'private_destination' || e.code === 'bad_url') throw e;
    if (e.code === 'cancelled') throw e;
    failures.push({ url: origin + '/robots.txt', stage: 'robots', error: e.message });
  }
  const checker = makeRobotsChecker(robots);
  const delay = Math.min(Math.max(limits.minDelayMs, (checker.crawlDelay || 0) * 1000), limits.maxCrawlDelayMs);

  // 2. sitemaps
  let seeds = robots.sitemaps.filter(s => { try { return inScope(s) || sameSite(new URL(s).hostname, rootHost); } catch { return false; } });
  let seedSource = 'robots.txt';
  const outOfScopeSitemaps = robots.sitemaps.filter(s => !seeds.includes(s));
  if (!seeds.length) { seeds = COMMON_SITEMAP_PATHS.map(p => origin + p); seedSource = 'common locations'; }
  progress('sitemaps', `Reading sitemaps from ${seedSource}`, { seeds: seeds.length });
  const sm = await collectSitemaps(seeds, {
    maxSitemaps: limits.maxSitemaps, maxUrls: limits.maxUrls, signal,
    fetchOpts: { timeoutMs: limits.requestTimeoutMs },
    onProgress: p => progress('sitemaps', `Read ${p.sitemapsFetched} sitemap file${p.sitemapsFetched === 1 ? '' : 's'}, ${p.urlsFound} URLs so far`, p),
  });
  // common location probes that 404 are expected, not failures
  const sitemapFiles = sm.files.filter(f => !(seedSource === 'common locations' && f.depth === 0 && (f.status === 404 || /Not a sitemap/.test(f.error || ''))));
  for (const f of sitemapFiles) if (f.error) failures.push({ url: f.url, stage: 'sitemap', error: f.error });
  const foundSitemap = sitemapFiles.some(f => f.type);

  // dedupe + scope
  const seen = new Map(); const external = {};
  for (const u of sm.urls) {
    let key; try { const x = new URL(u.loc); x.hash = ''; key = x.toString(); } catch { continue; }
    if (!inScope(key)) { const h = new URL(key).hostname; external[h] = (external[h] || 0) + 1; continue; }
    if (!seen.has(key)) seen.set(key, { ...u, loc: key });
  }
  let urls = [...seen.values()];
  let mode = 'sitemap'; let crawlInfo = null;

  // 3. no sitemap: bounded crawl only when explicitly requested
  if (!foundSitemap || !urls.length) {
    if (!crawlIfNoSitemap) {
      progress('done', 'No sitemap found. A bounded crawl can be run on request.');
      return finish({ status: 'no_sitemap' });
    }
    mode = 'crawl';
    progress('crawl', `No sitemap found. Running a bounded crawl (up to ${limits.maxCrawlPages} pages, depth ${limits.maxCrawlDepth}).`);
    crawlInfo = await boundedCrawl();
    urls = crawlInfo.urls;
  }

  // 4. choose pages to inspect: pages first, then representatives of each repeatable group
  const groups = groupUrls(urls);
  const groupOf = new Map(); for (const g of groups) for (const u of g.urls) groupOf.set(u, g);
  const meta = new Map(urls.map(u => [u.loc, u]));
  disallowed = urls.filter(u => !checker.allowed(u.loc)).map(u => u.loc);
  const candidates = urls.filter(u => checker.allowed(u.loc));
  const priority = []; const reps = [];
  for (const u of candidates) {
    const hint = sitemapHint(u.sitemap);
    const g = groupOf.get(u.loc);
    if (hint?.kind === 'archive' || isArchiveUrl(u.loc)) continue;
    if (hint?.kind === 'record' || (g.size >= 5 && g.pattern.includes('*'))) continue;
    priority.push(u.loc);
  }
  for (const g of groups) {
    const allowedInGroup = g.urls.filter(u => checker.allowed(u) && !isArchiveUrl(u));
    if (g.size >= 5 && g.pattern.includes('*')) reps.push(...allowedInGroup.slice(0, 3));
    else if (sitemapHint(meta.get(g.urls[0])?.sitemap)?.kind === 'record') reps.push(...allowedInGroup.slice(0, 2));
  }
  const toInspect = [...new Set([...priority, ...reps])].slice(0, limits.maxPagesInspect);
  if (crawlInfo) for (const [k, v] of crawlInfo.inspected) inspectedData.set(k, v);
  const pending = toInspect.filter(u => !inspectedData.has(u));
  progress('inspect', `Inspecting ${toInspect.length} of ${urls.length} URLs`, { pagesPlanned: toInspect.length, pagesInspected: inspectedData.size });

  await pool(pending, limits.concurrency, async (u) => {
    if (signal?.aborted) return;
    if (timeLeft() < 5000) { budgetHit = true; return; }
    try {
      const r = await safeFetch(u, { timeoutMs: limits.requestTimeoutMs, maxBytes: limits.maxPageBytes, accept: 'text/html,application/xhtml+xml', signal });
      if (r.status >= 400) throw new ScanError('http', `HTTP ${r.status}`);
      const ct = r.headers['content-type'] || '';
      if (!/html/i.test(ct)) throw new ScanError('not_html', `Not HTML (${ct || 'unknown type'})`);
      const finalUrl = r.url;
      if (!inScope(finalUrl)) throw new ScanError('redirect_out_of_scope', `Redirected outside the site to ${finalUrl}`);
      inspectedData.set(u, { ...extractPage(r.body.toString('utf8'), finalUrl), finalUrl, status: r.status });
    } catch (e) {
      if (e.code === 'cancelled') return;
      inspectedData.set(u, { error: e.message });
      failures.push({ url: u, stage: 'page', error: e.message });
    }
    progress('inspect', `Inspected ${inspectedData.size} of ${toInspect.length} pages`, { pagesPlanned: toInspect.length, pagesInspected: inspectedData.size });
    await sleep(delay);
  });
  if (signal?.aborted) throw new ScanError('cancelled', 'Scan cancelled');

  // 5. classify
  progress('classify', 'Grouping and classifying');
  const entries = []; const groupResults = new Map();
  for (const u of urls) {
    const f = inspectedData.get(u.loc);
    if (!f || f.error) continue;
    const g = groupOf.get(u.loc); const hint = sitemapHint(u.sitemap);
    const c = classifyInspected(u.loc, f, { group: g, hint });
    const gr = groupResults.get(g.pattern) || { counts: {}, inspected: 0, fingerprints: {} };
    gr.counts[c.category + '|' + c.contentType] = (gr.counts[c.category + '|' + c.contentType] || 0) + 1;
    gr.inspected++; gr.fingerprints[f.fingerprint] = (gr.fingerprints[f.fingerprint] || 0) + 1;
    groupResults.set(g.pattern, gr);
  }
  for (const [pat, gr] of groupResults) {
    const [top] = Object.entries(gr.counts).sort((a, b) => b[1] - a[1]);
    const [category, contentType] = top[0].split('|');
    gr.category = category; gr.contentType = contentType;
    gr.sameStructure = Object.keys(gr.fingerprints).length === 1 && gr.inspected >= 2;
    void pat;
  }
  const templates = new Map();
  for (const u of urls) {
    const f = inspectedData.get(u.loc); const g = groupOf.get(u.loc); const hint = sitemapHint(u.sitemap);
    let c; let headings = ''; let suggested = []; let fingerprint = null; let forms = null; let embeds = null; let title = '';
    if (!checker.allowed(u.loc)) {
      c = { category: 'REVIEW', contentType: '', reason: 'Disallowed by robots.txt, not inspected', confidence: 'low', evidence: 'robots.txt' };
      const fallback = classifyUninspected(u.loc, { group: g, hint, groupResult: null });
      if (fallback.category !== 'REVIEW') c = { ...fallback, reason: fallback.reason + '; page disallowed by robots.txt, not inspected' };
    } else if (f && !f.error) {
      c = classifyInspected(u.loc, f, { group: g, hint });
      // bulk static: many near identical non-record pages sharing one structure
      const gr = groupResults.get(g.pattern);
      if (['L2', 'L3'].includes(c.category) && g.size >= 10 && gr?.sameStructure) {
        c = { ...c, category: 'BULK_STATIC', reason: `Near identical structure across inspected pages in ${g.pattern} (${g.size} URLs); candidate for bulk static pricing`, confidence: 'medium' };
      }
      title = f.title; headings = [...f.h1, ...f.h2].slice(0, 8).join('; ');
      suggested = suggestBlocks(f, u.loc, catalogueIds); fingerprint = f.fingerprint;
      forms = f.forms.length; embeds = f.iframes;
      if (!['ARCHIVE', 'RECORD'].includes(c.category)) {
        const t = templates.get(f.fingerprint) || { id: f.fingerprint, pages: [], category: c.category, blockTypes: f.blockTypes };
        t.pages.push(u.loc); templates.set(f.fingerprint, t);
      }
    } else {
      const gr = groupResults.get(g.pattern);
      c = classifyUninspected(u.loc, { group: g, hint, groupResult: gr && gr.inspected ? { ...gr, category: gr.category === 'BULK_STATIC' ? 'L2' : gr.category } : null });
      if (gr?.sameStructure && g.size >= 10 && ['L2', 'L3'].includes(c.category)) c = { ...c, category: 'BULK_STATIC', reason: `Near identical structure across inspected pages in ${g.pattern}; candidate for bulk static pricing`, confidence: 'low' };
      if (f?.error) c = { ...c, category: c.category === 'REVIEW' ? 'REVIEW' : c.category, reason: `${c.reason}. Page fetch failed: ${f.error}`, confidence: 'low' };
    }
    entries.push({
      url: u.loc,
      findings: {
        title, contentType: c.contentType, category: c.category, include: c.category !== 'REVIEW', reason: c.reason, evidence: c.evidence,
        confidence: c.confidence, sourceCmsType: hint?.cmsType || '', sitemap: u.sitemap || (mode === 'crawl' ? 'bounded crawl' : ''), lastmod: u.lastmod || '',
        headings: headings.slice(0, 240), forms, embeds, fetchError: f?.error || '', suggestedBlocks: suggested, fingerprint, inspected: !!(f && !f.error), pattern: g.pattern,
      },
    });
  }

  const pagesMedia = [...inspectedData.values()].filter(f => f.media).map(f => f.media);
  const media = summarizeMedia(pagesMedia, pagesMedia.length, sm.imageEntries);
  const templateList = [...templates.values()].filter(t => t.pages.length >= 2).sort((a, b) => b.pages.length - a.pages.length)
    .map(t => ({ id: t.id, pages: t.pages.length, sample: t.pages[0], category: t.category, blockTypes: t.blockTypes.slice(0, 10) }));
  const groupList = groups.filter(g => g.size >= 5).sort((a, b) => b.size - a.size).slice(0, 50).map(g => ({ pattern: g.pattern, size: g.size, category: groupResults.get(g.pattern)?.category || null, contentType: groupResults.get(g.pattern)?.contentType || null }));

  // site insights, plus exact content counts from the CMS when it publishes them
  const pagesOk = [...inspectedData.values()].filter(f => !f.error);
  let insights = buildInsights(pagesOk, { templates: templateList });
  const wpLikely = insights.cms?.id === 'wordpress' || urls.some(u => /wp-sitemap|\/wp-content\//.test(u.sitemap || ''));
  if (wpLikely && timeLeft() > 20000 && !signal?.aborted) {
    progress('cms', 'Reading content counts from the WordPress REST API');
    try {
      const counts = await probeWordPress(origin, { allowed: u => checker.allowed(u), timeoutMs: limits.requestTimeoutMs, signal });
      insights = buildInsights(pagesOk, { templates: templateList, cmsCounts: counts });
      if (!insights.cms) insights.cms = { id: 'wordpress', name: 'WordPress', confidence: counts.available ? 'high' : 'medium', evidence: counts.available ? 'public WordPress REST API' : 'WordPress sitemap' };
    } catch (e) { if (e.code === 'cancelled') throw e; failures.push({ url: origin + '/wp-json/wp/v2/types', stage: 'cms', error: e.message }); }
  }

  const partial = !!(sm.limited || budgetHit || failures.some(f => !['robots', 'cms'].includes(f.stage)) || (crawlInfo && crawlInfo.limited));
  return finish({ status: 'complete', entries, templates: templateList, groups: groupList, media, partial, insights });

  // ---------------------------------------------------------------------
  function finish(extra) {
    const inspectedOk = [...inspectedData.values()].filter(f => !f.error).length;
    const coverage = {
      mode, seedSource, robotsStatus, sitemapFiles: sitemapFiles.length, sitemapFilesFailed: sitemapFiles.filter(f => f.error).length,
      urlsDiscovered: urls.length, urlsOutOfScope: external, outOfScopeSitemaps, disallowedByRobots: disallowed.length,
      pagesInspected: inspectedOk, pagesFailed: [...inspectedData.values()].filter(f => f.error).length,
      limitedBy: [sm.limited, budgetHit && 'Time budget reached before every planned page was inspected', crawlInfo?.limited].filter(Boolean),
      crawl: crawlInfo ? { pages: crawlInfo.urls.length, depth: limits.maxCrawlDepth, note: 'Bounded crawl from the homepage. It shows what was reachable within the limits, not the full size of the site.' } : null,
      userAgent: USER_AGENT, crawlDelayMs: delay,
    };
    return {
      id, rootUrl: root.toString(), startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
      limits, log, failures: failures.slice(0, 500), failureCount: failures.length, sitemaps: sitemapFiles.map(f => ({ url: f.url, type: f.type, count: f.count, depth: f.depth, error: f.error, status: f.status })),
      coverage, entries: [], templates: [], groups: [], media: null, partial: false, insights: null, ...extra,
    };
  }

  async function boundedCrawl() {
    const q = [{ url: root.toString().split('#')[0], depth: 0 }]; const found = new Map(); const inspected = [];
    let limited = null;
    while (q.length) {
      if (signal?.aborted) throw new ScanError('cancelled', 'Scan cancelled');
      if (found.size >= limits.maxCrawlPages) { limited = `Bounded crawl stopped at ${limits.maxCrawlPages} pages`; break; }
      if (timeLeft() < 5000) { limited = 'Time budget reached during crawl'; break; }
      const { url, depth } = q.shift();
      if (found.has(url) || !checker.allowed(url)) continue;
      found.set(url, { loc: url, lastmod: null, sitemap: null });
      try {
        const r = await safeFetch(url, { timeoutMs: limits.requestTimeoutMs, maxBytes: limits.maxPageBytes, accept: 'text/html', signal });
        if (r.status >= 400 || !/html/i.test(r.headers['content-type'] || '')) { inspected.push([url, { error: `HTTP ${r.status}` }]); continue; }
        const f = extractPage(r.body.toString('utf8'), r.url);
        inspected.push([url, { ...f, finalUrl: r.url, status: r.status }]);
        if (depth < limits.maxCrawlDepth) for (const l of f.links) {
          if (!inScope(l) || found.has(l)) continue;
          if (/\.(jpe?g|png|gif|svg|webp|pdf|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|$)/i.test(l)) continue;
          q.push({ url: l, depth: depth + 1 });
        }
      } catch (e) { if (e.code === 'cancelled') throw e; inspected.push([url, { error: e.message }]); failures.push({ url, stage: 'crawl', error: e.message }); }
      progress('crawl', `Crawled ${found.size} pages`, { pagesInspected: inspected.length });
      await sleep(delay);
    }
    return { urls: [...found.values()], inspected, limited };
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } });
  await Promise.all(workers);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
export { urlPattern };

// Anyday Quote Studio server: storage API, website scanner jobs and PDF export.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore, Invalid } from './storage.js';
import { authConfig, installAuth } from './auth.js';
import { loginPage } from './login-page.js';
import { htmlToPdf, pdfAvailable, markDataUri, PDF_ASSET_BASE, closeBrowser } from './pdf.js';
import { runScan } from './scanner/scan.js';
import { calculateQuote } from '../shared/pricing.js';
import { renderProposal } from '../shared/proposal.js';
import { mergeScan, inventoryCsv, portfolioSummary } from '../shared/inventory.js';
import { applyLibraryPricing, applyFoundation, quoteTypeOf } from '../shared/quote.js';
import { migrateLibrary } from '../shared/migrate.js';
import { schedulePlan, planCsv } from '../shared/plan.js';
import { renderPlanDoc } from '../shared/plan-doc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

export function createApp({ dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), scanOptions = {}, auth = authConfig(), fetchImpl } = {}) {
  const store = createStore({ dataDir, root: ROOT });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '40mb' }));
  app.set('trust proxy', 1); // Render and most hosts terminate HTTPS at a proxy
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (auth.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Google sign-in: everything below this line requires an anyday.inc account when enabled
  app.use(installAuth(app, { cfg: auth, loginPage, ...(fetchImpl ? { fetchImpl } : {}) }));

  const h = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      res.status(status).json({ error: e.message, details: e.details, current: e.current, code: e.code });
    }
  };
  const quoteSummary = q => {
    let calc = null; try { calc = calculateQuote(q); } catch { /* corrupt quote still listed */ }
    return {
      id: q.id, number: q.number, client: q.client?.name, project: q.project?.name, url: q.project?.url, updatedAt: q.updatedAt, createdAt: q.createdAt,
      example: q.example?.label || null, libraryVersion: q.pricingSnapshot?.libraryVersion, total: calc?.total ?? null, totalStatus: calc?.totalStatus ?? null,
      blockers: calc?.blockers.length ?? null, urls: q.inventory?.entries?.length || 0, issuedAt: q.issuedAt || null,
      type: q.type || 'foundation_site', typeName: quoteTypeOf(q).name, foundation: q.foundation?.name || null, sites: (() => { try { return portfolioSummary(q).totalSites; } catch { return null; } })(),
    };
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'server', pdf: pdfAvailable(), scanner: true, auth: auth.enabled }));

  // ---- library -------------------------------------------------------------
  app.get('/api/library', h((req, res) => res.json(store.getLibrary())));
  app.put('/api/library', h((req, res) => res.json(store.saveLibrary({ ...req.body.library, updatedBy: req.user?.email || null }, { baseUpdatedAt: req.body.baseUpdatedAt }))));
  app.get('/api/library/export', h((req, res) => {
    const lib = store.getLibrary();
    res.setHeader('Content-Disposition', `attachment; filename="anyday-pricing-library-${lib.version}.json"`);
    res.json(lib);
  }));
  app.post('/api/library/import', h((req, res) => res.json(store.saveLibrary(migrateLibrary(req.body.library || {}, store.getLibrary())))));
  app.get('/api/library/versions', h((req, res) => res.json(store.listLibraryVersions())));

  // ---- team: people who deliver the work (internal planning) ----------------
  app.get('/api/team', h((req, res) => res.json(store.getTeam())));
  app.put('/api/team', h((req, res) => res.json(store.saveTeam(req.body.team, { baseUpdatedAt: req.body.baseUpdatedAt }))));

  // ---- foundations: reusable platforms a quote can build on -----------------
  app.get('/api/foundations', h((req, res) => res.json(store.listFoundations())));
  app.post('/api/foundations', h((req, res) => res.json(store.createFoundation({ name: req.body.name || '', owner: req.body.owner || '', description: req.body.description || '', createdBy: req.user?.email || null }))));
  app.get('/api/foundations/:id', h((req, res) => res.json(store.getFoundation(req.params.id))));
  app.put('/api/foundations/:id', h((req, res) => {
    const f = req.body.foundation;
    if (!f || f.id !== req.params.id) throw new Invalid('Foundation id mismatch');
    res.json(store.saveFoundation({ ...f, updatedBy: req.user?.email || null }, { baseUpdatedAt: req.body.baseUpdatedAt }));
  }));
  app.post('/api/foundations/:id/duplicate', h((req, res) => res.json(store.duplicateFoundation(req.params.id))));

  // ---- quotes --------------------------------------------------------------
  app.get('/api/quotes', h((req, res) => res.json(store.listQuotes().map(quoteSummary).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')))));
  app.post('/api/quotes', h((req, res) => {
    const b = req.body || {};
    res.json(store.createQuote({ client: b.client || '', project: b.project || '', url: b.url || '', type: b.type || (b.foundationId ? 'foundation_site' : 'new_platform'), foundationId: b.foundationId || null, parentOrg: b.parentOrg || '', existingLiveSites: Math.max(0, Math.floor(Number(b.existingLiveSites) || 0)), preparedBy: req.user?.name || 'Anyday', createdBy: req.user?.email || null }));
  }));
  app.post('/api/quotes/import', h((req, res) => res.json(store.importQuote(req.body.quote))));
  app.get('/api/quotes/:id', h((req, res) => res.json(store.getQuote(req.params.id))));
  app.put('/api/quotes/:id', h((req, res) => {
    const q = req.body.quote;
    if (!q || q.id !== req.params.id) throw new Invalid('Quote id mismatch');
    res.json(store.saveQuote({ ...q, updatedBy: req.user?.email || q.updatedBy || null }, { baseUpdatedAt: req.body.baseUpdatedAt }));
  }));
  app.delete('/api/quotes/:id', h((req, res) => { store.deleteQuote(req.params.id); res.json({ ok: true }); }));
  app.post('/api/quotes/:id/duplicate', h((req, res) => res.json(store.duplicateQuote(req.params.id))));
  app.get('/api/quotes/:id/export', h((req, res) => {
    const q = store.getQuote(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="${(q.number || q.id)}-quote.json"`);
    res.json(q);
  }));
  // explicit: preview the price changes, then apply with confirm=true
  app.post('/api/quotes/:id/apply-library', h((req, res) => {
    const q = store.getQuote(req.params.id);
    const { quote, changes } = applyLibraryPricing(q, store.getLibrary());
    if (!req.body.confirm) return res.json({ changes, before: calculateQuote(q).total, after: calculateQuote(quote).total });
    res.json({ changes, quote: store.saveQuote(quote, { baseUpdatedAt: req.body.baseUpdatedAt }) });
  }));
  // explicit: refresh the quote's foundation snapshot from the current foundation (treatments are kept)
  app.post('/api/quotes/:id/apply-foundation', h((req, res) => {
    const q = store.getQuote(req.params.id);
    const fid = req.body.foundationId || q.foundation?.id;
    if (!fid) throw new Invalid('Choose a foundation');
    const next = applyFoundation(q, store.getFoundation(fid));
    if (!req.body.confirm) return res.json({ before: calculateQuote(q).total, after: calculateQuote(next).total, components: next.foundation.components.length });
    res.json({ quote: store.saveQuote(next, { baseUpdatedAt: req.body.baseUpdatedAt }) });
  }));
  app.get('/api/quotes/:id/inventory.csv', h((req, res) => {
    const q = store.getQuote(req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${q.number || q.id}-url-inventory.csv"`);
    res.send(inventoryCsv(q));
  }));

  // ---- proposal / PDF ------------------------------------------------------
  const mark = markDataUri(PUBLIC);
  async function pdfFor(q, mode, appendix) {
    const calc = calculateQuote(q);
    if (mode === 'final' && !calc.canExportFinal) {
      throw Object.assign(new Error('Final export is blocked until every included item has a price and quantity.'), { status: 409, details: calc.blockers.map(b => b.message) });
    }
    const html = renderProposal(q, { mode, appendix, calc, assetBase: PDF_ASSET_BASE, markDataUri: mark, quoteDate: mode === 'final' ? new Date().toISOString() : undefined });
    return htmlToPdf(html, { publicDir: PUBLIC });
  }
  app.get('/api/quotes/:id/proposal.html', h((req, res) => {
    const q = store.getQuote(req.params.id);
    res.type('html').send(renderProposal(q, { mode: req.query.mode === 'final' ? 'final' : 'draft', appendix: req.query.appendix === '1', assetBase: '/assets', markDataUri: mark, screen: req.query.screen === '1' }));
  }));
  app.post('/api/quotes/:id/pdf', h(async (req, res) => {
    let q = store.getQuote(req.params.id);
    const mode = req.query.mode === 'final' ? 'final' : 'draft';
    const appendix = req.query.appendix === '1';
    const pdf = await pdfFor(q, mode, appendix);
    if (mode === 'final') {
      const calc = calculateQuote(q);
      q = store.saveQuote({ ...q, issuedAt: new Date().toISOString(), history: [...(q.history || []), { at: new Date().toISOString(), kind: 'final_pdf', total: calc.total }] });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${q.number || 'quote'}-${mode === 'final' ? 'proposal' : 'draft'}.pdf"`);
    res.send(pdf);
  }));

  // ---- internal delivery plan: price free, for the delivery team -----------
  const planFor = q => { const team = store.getTeam(); return { team, sched: schedulePlan(q, { team, library: store.getLibrary() }) }; };
  app.get('/api/quotes/:id/plan.html', h((req, res) => {
    const q = store.getQuote(req.params.id); const { team, sched } = planFor(q);
    res.type('html').send(renderPlanDoc(q, sched, team, { assetBase: '/assets', markDataUri: mark, screen: true }));
  }));
  app.get('/api/quotes/:id/plan.csv', h((req, res) => {
    const q = store.getQuote(req.params.id); const { team, sched } = planFor(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${q.number || q.id}-internal-plan.csv"`);
    res.send(planCsv(q, sched, team));
  }));
  app.post('/api/quotes/:id/plan.pdf', h(async (req, res) => {
    const q = store.getQuote(req.params.id); const { team, sched } = planFor(q);
    const pdf = await htmlToPdf(renderPlanDoc(q, sched, team, { assetBase: PDF_ASSET_BASE, markDataUri: mark }), { publicDir: PUBLIC });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${q.number || 'quote'}-internal-plan.pdf"`);
    res.send(pdf);
  }));

  // ---- scanning ------------------------------------------------------------
  const jobs = new Map();
  let running = 0; const queue = [];
  const MAX_CONCURRENT = 1; // be polite: one site at a time per server
  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift(); running++;
      job.status = 'running';
      runScan({ ...job.params, ...scanOptions, signal: job.ctl.signal, onProgress: p => { job.progress = { ...job.progress, ...p }; job.recent.push(p); if (job.recent.length > 40) job.recent.shift(); } })
        .then(result => { store.saveScan(result); job.result = summary(result); job.status = result.status === 'no_sitemap' ? 'no_sitemap' : 'done'; })
        .catch(e => { job.status = e.code === 'cancelled' ? 'cancelled' : 'failed'; job.error = e.message; job.errorCode = e.code; })
        .finally(() => { running--; job.finishedAt = new Date().toISOString(); pump(); });
    }
  }
  const summary = r => ({ id: r.id, status: r.status, partial: r.partial, coverage: r.coverage, failureCount: r.failureCount, failures: r.failures.slice(0, 50), sitemaps: r.sitemaps.slice(0, 200), templates: r.templates, groups: r.groups, media: r.media, urls: r.entries.length, startedAt: r.startedAt, finishedAt: r.finishedAt });

  app.post('/api/scans', h((req, res) => {
    const { quoteId, url, includeHosts = [], crawlIfNoSitemap = false, limits = {} } = req.body || {};
    const lim = {};
    if (Number.isFinite(limits.maxPagesInspect)) lim.maxPagesInspect = Math.max(1, Math.min(600, limits.maxPagesInspect));
    if (Number.isFinite(limits.maxUrls)) lim.maxUrls = Math.max(10, Math.min(50000, limits.maxUrls));
    if (Number.isFinite(limits.maxCrawlPages)) lim.maxCrawlPages = Math.max(10, Math.min(1000, limits.maxCrawlPages));
    const q0 = quoteId ? store.getQuote(quoteId) : null;
    const componentIds = (q0?.foundation?.components || []).map(c => c.id);
    const job = { id: 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quoteId, status: 'queued', createdAt: new Date().toISOString(), progress: { phase: 'queued', message: 'Waiting to start' }, recent: [], ctl: new AbortController(),
      params: { rootUrl: url, includeHosts: includeHosts.filter(x => typeof x === 'string' && /^[a-z0-9.-]+$/i.test(x)), crawlIfNoSitemap: !!crawlIfNoSitemap, limits: lim, catalogueIds: componentIds } };
    jobs.set(job.id, job); queue.push(job); pump();
    res.json(publicJob(job));
  }));
  const publicJob = j => ({ id: j.id, quoteId: j.quoteId, status: j.status, progress: j.progress, recent: j.recent.slice(-12), result: j.result || null, error: j.error || null, errorCode: j.errorCode || null, createdAt: j.createdAt, finishedAt: j.finishedAt || null, params: { url: j.params.rootUrl, crawlIfNoSitemap: j.params.crawlIfNoSitemap, includeHosts: j.params.includeHosts, limits: j.params.limits } });
  app.get('/api/scans/:job', h((req, res) => { const j = jobs.get(req.params.job); if (!j) return res.status(404).json({ error: 'Scan job not found (the server may have restarted)' }); res.json(publicJob(j)); }));
  app.post('/api/scans/:job/cancel', h((req, res) => { const j = jobs.get(req.params.job); if (!j) return res.status(404).json({ error: 'not found' }); j.ctl.abort(); if (j.status === 'queued') { j.status = 'cancelled'; queue.splice(queue.indexOf(j), 1); } res.json(publicJob(j)); }));
  // merging is explicit; a failed or partial scan never alters the quote on its own
  app.post('/api/quotes/:id/merge-scan', h((req, res) => {
    const q = store.getQuote(req.params.id);
    const scan = store.getScan(req.body.scanId);
    if (scan.status !== 'complete') throw new Invalid('This scan has no URL results to merge');
    if (scan.partial && !req.body.acceptPartial) throw Object.assign(new Error('This scan is partial. Confirm to merge the partial results.'), { status: 409, code: 'partial' });
    const groupId = String(req.body.groupId || q.siteGroups?.[0]?.id || 'main');
    if (q.siteGroups?.length && !q.siteGroups.some(g => g.id === groupId)) throw new Invalid('Unknown site type');
    const inventory = mergeScan(q.inventory, scan, { groupId });
    const next = { ...q, inventory, history: [...(q.history || []), { at: new Date().toISOString(), kind: 'merged_scan', scanId: scan.id, partial: scan.partial, urls: scan.entries.length, groupId }] };
    res.json(store.saveQuote(next, { baseUpdatedAt: req.body.baseUpdatedAt }));
  }));

  // ---- static app ----------------------------------------------------------
  app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: '7d' }));
  app.use(express.static(PUBLIC, { index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  app.locals.store = store;
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 4310);
  const host = process.env.HOST || '127.0.0.1';
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!local && !authConfig().enabled && process.env.ALLOW_NO_AUTH !== '1') {
    console.error('Refusing to start on a public address without Google sign-in. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET (or ALLOW_NO_AUTH=1 behind your own access control).');
    process.exit(1);
  }
  const app = createApp();
  const server = app.listen(port, host, () => console.log(`Anyday Quote Studio running at http://${host}:${port}`));
  const stop = async () => { server.close(); await closeBrowser(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void fs;

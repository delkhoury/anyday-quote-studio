// Data access. ServerApi talks to the Node server. MemoryApi runs the same app without a
// server (Artifact prototype): data lives in memory only, scanning and PDF are unavailable.
import { newQuote, duplicateQuote, applyLibraryPricing, applyFoundation, validateQuoteShape, validateLibraryShape, cryptoId, emptyFoundation, quoteTypes, quoteTypeOf } from '../shared/quote.js';
import { migrateQuote, migrateLibrary } from '../shared/migrate.js';
import { calculateQuote } from '../shared/pricing.js';
import { inventoryCsv, portfolioSummary } from '../shared/inventory.js';
import { emptyTeam, schedulePlan, planCsv } from '../shared/plan.js';
import { entriesFromCsv, computeBaselines } from '../shared/baselines.js';
import { computeMargin, DEFAULT_SETTINGS } from '../shared/margin.js';

async function j(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.code === 'auth') { location.href = '/auth/login'; throw new Error('Signed out'); }
  if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.status = res.status; e.details = body.details; e.current = body.current; e.code = body.code; throw e; }
  return body;
}
const send = (method, url, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);

export class ServerApi {
  constructor() { this.mode = 'server'; }
  health() { return fetch('/api/health').then(j); }
  me() { return fetch('/api/me').then(j); }
  logout() { return fetch('/auth/logout', { method: 'POST' }).then(() => { location.href = '/auth/login'; }); }
  library() { return fetch('/api/library').then(j); }
  saveLibrary(library, baseUpdatedAt) { return send('PUT', '/api/library', { library, baseUpdatedAt }); }
  importLibrary(library) { return send('POST', '/api/library/import', { library }); }
  team() { return fetch('/api/team').then(j); }
  clockifySync() { return send('POST', '/api/team/clockify-sync', {}); }
  baselines(body) { return send('POST', '/api/library/baselines', body); }
  settings() { return fetch('/api/settings').then(j); }
  saveSettings(s) { return send('PUT', '/api/settings', s); }
  margin(id) { return fetch(`/api/quotes/${encodeURIComponent(id)}/margin`).then(j); }
  saveTeam(team, baseUpdatedAt) { return send('PUT', '/api/team', { team, baseUpdatedAt }); }
  async planPdf(id) {
    const res = await fetch(`/api/quotes/${encodeURIComponent(id)}/plan.pdf`, { method: 'POST' });
    if (!res.ok) return j(res);
    return res.blob();
  }
  exportPlanCsv(q) { const a = document.createElement('a'); a.href = `/api/quotes/${encodeURIComponent(q.id)}/plan.csv`; a.download = `${q.number}-internal-plan.csv`; document.body.appendChild(a); a.click(); a.remove(); }
  foundations() { return fetch('/api/foundations').then(j); }
  foundation(id) { return fetch(`/api/foundations/${encodeURIComponent(id)}`).then(j); }
  createFoundation(fields) { return send('POST', '/api/foundations', fields); }
  saveFoundation(foundation, baseUpdatedAt) { return send('PUT', `/api/foundations/${encodeURIComponent(foundation.id)}`, { foundation, baseUpdatedAt }); }
  duplicateFoundation(id) { return send('POST', `/api/foundations/${encodeURIComponent(id)}/duplicate`, {}); }
  applyFoundation(id, foundationId, confirm, baseUpdatedAt) { return send('POST', `/api/quotes/${encodeURIComponent(id)}/apply-foundation`, { foundationId, confirm, baseUpdatedAt }); }
  quotes() { return fetch('/api/quotes').then(j); }
  quote(id) { return fetch(`/api/quotes/${encodeURIComponent(id)}`).then(j); }
  createQuote(fields) { return send('POST', '/api/quotes', fields); }
  saveQuote(q, baseUpdatedAt) { return send('PUT', `/api/quotes/${encodeURIComponent(q.id)}`, { quote: q, baseUpdatedAt }); }
  deleteQuote(id) { return send('DELETE', `/api/quotes/${encodeURIComponent(id)}`); }
  duplicateQuote(id) { return send('POST', `/api/quotes/${encodeURIComponent(id)}/duplicate`, {}); }
  importQuote(quote) { return send('POST', '/api/quotes/import', { quote }); }
  applyLibrary(id, confirm, baseUpdatedAt) { return send('POST', `/api/quotes/${encodeURIComponent(id)}/apply-library`, { confirm, baseUpdatedAt }); }
  async pdf(id, mode, appendix) {
    const res = await fetch(`/api/quotes/${encodeURIComponent(id)}/pdf?mode=${mode}${appendix ? '&appendix=1' : ''}`, { method: 'POST' });
    if (!res.ok) return j(res);
    return res.blob();
  }
  inventoryCsvUrl(id) { return `/api/quotes/${encodeURIComponent(id)}/inventory.csv`; }
  exportCsv(q) { const a = document.createElement('a'); a.href = this.inventoryCsvUrl(q.id); a.download = `${q.number}-url-inventory.csv`; document.body.appendChild(a); a.click(); a.remove(); }
  startScan(params) { return send('POST', '/api/scans', params); }
  scan(jobId) { return fetch(`/api/scans/${encodeURIComponent(jobId)}`).then(j); }
  cancelScan(jobId) { return send('POST', `/api/scans/${encodeURIComponent(jobId)}/cancel`, {}); }
  mergeScan(quoteId, scanId, acceptPartial, baseUpdatedAt, groupId) { return send('POST', `/api/quotes/${encodeURIComponent(quoteId)}/merge-scan`, { scanId, acceptPartial, baseUpdatedAt, groupId }); }
}

export class MemoryApi {
  constructor(seed) {
    this.mode = 'prototype';
    this.lib = JSON.parse(JSON.stringify(seed.library));
    this.fs = new Map((seed.foundations || []).map(f => [f.id, JSON.parse(JSON.stringify(f))]));
    this.tm = seed.team ? JSON.parse(JSON.stringify(seed.team)) : emptyTeam();
    this.qs = new Map(seed.quotes.map(q => [q.id, migrateQuote(q, this.lib)]));
    this.n = seed.quotes.length + 1;
  }
  num() { return `AQ-${new Date().getUTCFullYear()}-${String(this.n++).padStart(4, '0')}`; }
  async health() { return { ok: true, mode: 'prototype', pdf: false, scanner: false, clockify: false }; }
  async me() { return { user: null, auth: false, admin: true }; }
  async clockifySync() { throw new Error('Clockify sync needs the Anyday Quote Studio server. Import a Clockify CSV in the Pricing Library instead.'); }
  async baselines(body) {
    if (body.source !== 'csv') throw new Error('Reading Clockify directly needs the server. Upload a Clockify CSV export instead.');
    const byName = Object.fromEntries(this.tm.people.map(p => [String(p.name).trim().toLowerCase(), p]));
    return computeBaselines(entriesFromCsv(body.csv, { roleOf: u => (byName[String(u).trim().toLowerCase()] ? { role: byName[String(u).trim().toLowerCase()].role } : null) }), this.lib);
  }
  async settings() { return { ...DEFAULT_SETTINGS, ...(this.st || {}) }; }
  async saveSettings(s) { this.st = { ...s }; return this.settings(); }
  async margin(id) { const q = await this.quote(id); return computeMargin(calculateQuote(q), schedulePlan(q, { team: this.tm, library: this.lib }), this.tm, await this.settings()); }
  async logout() {}
  async library() { return JSON.parse(JSON.stringify(this.lib)); }
  async saveLibrary(library, baseUpdatedAt) {
    const errs = validateLibraryShape(library); if (errs.length) throw Object.assign(new Error('Library is not valid'), { details: errs });
    if (baseUpdatedAt && baseUpdatedAt !== this.lib.updatedAt) throw Object.assign(new Error('Library changed'), { status: 409 });
    this.lib = { ...library, updatedAt: new Date().toISOString() }; return this.library();
  }
  async importLibrary(library) { return this.saveLibrary(migrateLibrary(library, this.lib)); }
  async team() { return JSON.parse(JSON.stringify(this.tm)); }
  async saveTeam(team, base) {
    if (base && base !== this.tm.updatedAt) throw Object.assign(new Error('The team changed since you opened it'), { status: 409 });
    this.tm = { schemaVersion: 1, people: JSON.parse(JSON.stringify(team.people)), updatedAt: new Date().toISOString() }; return this.team();
  }
  async planPdf() { throw new Error('PDF export needs the Anyday Quote Studio server. Use the CSV here, or the preview.'); }
  exportPlanCsv(q) { const cur = this.qs.get(q.id) || q; download(`${q.number}-internal-plan.csv`, planCsv(cur, schedulePlan(cur, { team: this.tm, library: this.lib }), this.tm), 'text/csv'); }
  async foundations() { return [...this.fs.values()].map(f => JSON.parse(JSON.stringify(f))).sort((a, b) => (a.archived - b.archived) || a.name.localeCompare(b.name)); }
  async foundation(id) { const f = this.fs.get(id); if (!f) throw new Error('Foundation not found'); return JSON.parse(JSON.stringify(f)); }
  async createFoundation(fields) {
    if (!String(fields.name || '').trim()) throw new Error('Foundation needs a name');
    const base = fields.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'foundation'; let id = base, n = 2; while (this.fs.has(id)) id = `${base}-${n++}`;
    const f = emptyFoundation({ ...fields, id }); this.fs.set(id, f); return this.foundation(id);
  }
  async saveFoundation(f, base) {
    const cur = this.fs.get(f.id); if (!cur) throw new Error('Foundation not found');
    if (base && cur.updatedAt !== base) throw Object.assign(new Error('This foundation changed since you opened it'), { status: 409, current: cur });
    const ids = f.components.map(c => c.id); if (new Set(ids).size !== ids.length) throw Object.assign(new Error('Foundation is not valid'), { details: ['Duplicate component id'] });
    this.fs.set(f.id, { ...JSON.parse(JSON.stringify(f)), updatedAt: new Date().toISOString() }); return this.foundation(f.id);
  }
  async duplicateFoundation(id) { const src = await this.foundation(id); return this.createFoundation({ ...src, name: `${src.name} (copy)`, archived: false }); }
  async applyFoundation(id, foundationId, confirm) {
    const q = await this.quote(id); const f = await this.foundation(foundationId || q.foundation?.id);
    const next = applyFoundation(q, f);
    if (!confirm) return { before: calculateQuote(q).total, after: calculateQuote(next).total, components: next.foundation.components.length };
    return { quote: await this.saveQuote(next) };
  }
  async quotes() {
    return [...this.qs.values()].map(q => { let c = null; try { c = calculateQuote(q); } catch { /* */ } let sites = null; try { sites = portfolioSummary(q).totalSites; } catch { /* */ }
      return { id: q.id, number: q.number, client: q.client?.name, project: q.project?.name, url: q.project?.url, updatedAt: q.updatedAt, example: q.example?.label || null, libraryVersion: q.pricingSnapshot?.libraryVersion, total: c?.total ?? null, totalStatus: c?.totalStatus, blockers: c?.blockers.length, urls: q.inventory?.entries?.length || 0, type: q.type, typeName: quoteTypeOf(q).name, foundation: q.foundation?.name || null, sites }; })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async quote(id) { const q = this.qs.get(id); if (!q) throw new Error('Quote not found'); return JSON.parse(JSON.stringify(q)); }
  async createQuote(f) {
    const type = quoteTypes(this.lib).find(t => t.id === f.type) || quoteTypes(this.lib).find(t => t.id === (f.foundationId ? 'foundation_site' : 'new_platform'));
    const foundation = f.foundationId ? await this.foundation(f.foundationId) : null;
    if (type.usesFoundation === 'required' && !foundation) throw new Error(`${type.name} needs a foundation`);
    const q = newQuote(this.lib, foundation, { ...f, type: type.id, number: this.num() }); this.qs.set(q.id, q); return this.quote(q.id);
  }
  async saveQuote(q, base) {
    const cur = this.qs.get(q.id);
    if (cur && base && cur.updatedAt !== base) throw Object.assign(new Error('This quote was changed elsewhere'), { status: 409, current: cur });
    const next = { ...JSON.parse(JSON.stringify(q)), number: q.number || this.num(), updatedAt: new Date().toISOString() };
    this.qs.set(q.id, next); return this.quote(q.id);
  }
  async deleteQuote(id) { this.qs.delete(id); return { ok: true }; }
  async duplicateQuote(id) { const c = duplicateQuote(await this.quote(id), this.num()); this.qs.set(c.id, c); return this.quote(c.id); }
  async importQuote(quote) {
    const errs = validateQuoteShape(quote); if (errs.length) throw Object.assign(new Error('Not a valid quote export'), { details: errs });
    const q = migrateQuote(JSON.parse(JSON.stringify(quote)), this.lib); if (this.qs.has(q.id)) q.id = cryptoId(); if (!q.number) q.number = this.num();
    this.qs.set(q.id, q); return this.quote(q.id);
  }
  async applyLibrary(id, confirm) {
    const q = await this.quote(id); const { quote, changes } = applyLibraryPricing(q, this.lib);
    if (!confirm) return { changes, before: calculateQuote(q).total, after: calculateQuote(quote).total };
    return { changes, quote: await this.saveQuote(quote) };
  }
  async pdf() { throw new Error('PDF export needs the Anyday Quote Studio server. This prototype runs without one.'); }
  inventoryCsvUrl() { return '#'; }
  exportCsv(q) { download(`${q.number}-url-inventory.csv`, inventoryCsv(this.qs.get(q.id) || q), 'text/csv'); }
  async startScan() { throw new Error('Website scanning needs the Anyday Quote Studio server. This prototype cannot fetch external sites.'); }
  async scan() { throw new Error('No scanner in prototype mode'); }
  async cancelScan() { return {}; }
  async mergeScan() { throw new Error('No scanner in prototype mode'); }
}

// In the Artifact prototype the viewer blocks file downloads, so exports open an in-page
// panel with the text and a copy button instead.
export function download(filename, data, type = 'application/json') {
  if (window.__SEED__ && !(data instanceof Blob)) { window.__showExport?.(filename, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return; }
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 1)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(file); });
}

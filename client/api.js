// Data access. ServerApi talks to the Node server. MemoryApi runs the same app without a
// server (Artifact prototype): data lives in memory only, scanning and PDF are unavailable.
import { newQuote, duplicateQuote, applyLibraryPricing, validateQuoteShape, validateLibraryShape, cryptoId } from '../shared/quote.js';
import { calculateQuote } from '../shared/pricing.js';
import { inventoryCsv } from '../shared/inventory.js';

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
  catalogue() { return fetch('/api/catalogue').then(j); }
  saveCatalogue(c) { return send('PUT', '/api/catalogue', c); }
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
  mergeScan(quoteId, scanId, acceptPartial, baseUpdatedAt) { return send('POST', `/api/quotes/${encodeURIComponent(quoteId)}/merge-scan`, { scanId, acceptPartial, baseUpdatedAt }); }
}

export class MemoryApi {
  constructor(seed) {
    this.mode = 'prototype';
    this.lib = JSON.parse(JSON.stringify(seed.library));
    this.cat = JSON.parse(JSON.stringify(seed.catalogue));
    this.qs = new Map(seed.quotes.map(q => [q.id, q]));
    this.n = seed.quotes.length + 1;
  }
  num() { return `AQ-${new Date().getUTCFullYear()}-${String(this.n++).padStart(4, '0')}`; }
  async health() { return { ok: true, mode: 'prototype', pdf: false, scanner: false }; }
  async me() { return { user: null, auth: false }; }
  async logout() {}
  async library() { return JSON.parse(JSON.stringify(this.lib)); }
  async saveLibrary(library, baseUpdatedAt) {
    const errs = validateLibraryShape(library); if (errs.length) throw Object.assign(new Error('Library is not valid'), { details: errs });
    if (baseUpdatedAt && baseUpdatedAt !== this.lib.updatedAt) throw Object.assign(new Error('Library changed'), { status: 409 });
    this.lib = { ...library, updatedAt: new Date().toISOString() }; return this.library();
  }
  async importLibrary(library) { return this.saveLibrary(library); }
  async catalogue() { return JSON.parse(JSON.stringify(this.cat)); }
  async saveCatalogue(c) { this.cat = JSON.parse(JSON.stringify(c)); return this.catalogue(); }
  async quotes() {
    return [...this.qs.values()].map(q => { let c = null; try { c = calculateQuote(q); } catch { /* */ } return { id: q.id, number: q.number, client: q.client?.name, project: q.project?.name, url: q.project?.url, updatedAt: q.updatedAt, example: q.example?.label || null, libraryVersion: q.pricingSnapshot?.libraryVersion, total: c?.total ?? null, totalStatus: c?.totalStatus, blockers: c?.blockers.length, urls: q.inventory?.entries?.length || 0 }; })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async quote(id) { const q = this.qs.get(id); if (!q) throw new Error('Quote not found'); return JSON.parse(JSON.stringify(q)); }
  async createQuote(f) { const q = newQuote(this.lib, this.cat, { ...f, number: this.num() }); this.qs.set(q.id, q); return this.quote(q.id); }
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
    const q = JSON.parse(JSON.stringify(quote)); if (this.qs.has(q.id)) q.id = cryptoId(); if (!q.number) q.number = this.num();
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

// File based storage with atomic writes. Pricing configuration, quotes and scans are plain JSON
// files under DATA_DIR so they are easy to back up, diff and restore.
import fs from 'node:fs';
import path from 'node:path';
import { newQuote, duplicateQuote, validateQuoteShape, validateLibraryShape, cryptoId } from '../shared/quote.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export class NotFound extends Error { constructor(m) { super(m); this.status = 404; } }
export class Conflict extends Error { constructor(m, current) { super(m); this.status = 409; this.current = current; } }
export class Invalid extends Error { constructor(m, details) { super(m); this.status = 400; this.details = details; } }

export function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

export function createStore({ dataDir, root }) {
  const dirs = { quotes: path.join(dataDir, 'quotes'), scans: path.join(dataDir, 'scans'), libVersions: path.join(dataDir, 'library-versions'), trash: path.join(dataDir, 'trash') };
  for (const d of [dataDir, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
  const libFile = path.join(dataDir, 'library.json');
  const catFile = path.join(dataDir, 'aaif-catalogue.json');
  const counterFile = path.join(dataDir, 'counter.json');

  // first run: seed the library, the AAIF catalogue and the LF example quotes
  if (!fs.existsSync(libFile)) atomicWriteJson(libFile, readJson(path.join(root, 'shared/library-default.json')));
  if (!fs.existsSync(catFile)) atomicWriteJson(catFile, readJson(path.join(root, 'shared/aaif-catalogue.json')));
  if (!fs.existsSync(counterFile)) {
    const seedDir = path.join(root, 'seed/quotes');
    let max = 0;
    if (fs.existsSync(seedDir)) for (const f of fs.readdirSync(seedDir)) {
      const q = readJson(path.join(seedDir, f));
      atomicWriteJson(path.join(dirs.quotes, `${q.id}.json`), q);
      const n = Number((q.number || '').split('-').pop()); if (n > max) max = n;
    }
    atomicWriteJson(counterFile, { next: max + 1 });
  }

  const quotePath = id => { if (!ID_RE.test(id)) throw new NotFound('Unknown quote'); return path.join(dirs.quotes, `${id}.json`); };

  function nextNumber() {
    const c = readJson(counterFile);
    const n = c.next || 1;
    atomicWriteJson(counterFile, { next: n + 1 });
    return `AQ-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
  }

  return {
    dataDir,
    getLibrary: () => readJson(libFile),
    saveLibrary(lib, { baseUpdatedAt } = {}) {
      const errs = validateLibraryShape(lib);
      if (errs.length) throw new Invalid('Library is not valid', errs);
      const cur = readJson(libFile);
      if (baseUpdatedAt && cur.updatedAt !== baseUpdatedAt) throw new Conflict('The library changed since you opened it. Reload and reapply your edits.', cur);
      atomicWriteJson(path.join(dirs.libVersions, `${(cur.updatedAt || 'unknown').replace(/[:.]/g, '-')}.json`), cur);
      const next = { ...lib, updatedAt: new Date().toISOString() };
      atomicWriteJson(libFile, next);
      return next;
    },
    listLibraryVersions: () => fs.readdirSync(dirs.libVersions).filter(f => f.endsWith('.json')).sort().reverse(),
    getCatalogue: () => readJson(catFile),
    saveCatalogue(cat) {
      if (!Array.isArray(cat?.blocks)) throw new Invalid('Catalogue needs a blocks array');
      const ids = new Set();
      for (const b of cat.blocks) { if (!b.id) throw new Invalid('Every block needs an id'); if (ids.has(b.id)) throw new Invalid(`Duplicate block ${b.id}`); ids.add(b.id); }
      atomicWriteJson(catFile, cat); return cat;
    },
    listQuotes() {
      return fs.readdirSync(dirs.quotes).filter(f => f.endsWith('.json')).map(f => {
        try { return readJson(path.join(dirs.quotes, f)); } catch { return null; }
      }).filter(Boolean);
    },
    getQuote(id) {
      const p = quotePath(id);
      if (!fs.existsSync(p)) throw new NotFound('Quote not found');
      return readJson(p);
    },
    saveQuote(q, { baseUpdatedAt } = {}) {
      const errs = validateQuoteShape(q);
      if (errs.length) throw new Invalid('Quote is not valid', errs);
      const p = quotePath(q.id);
      if (fs.existsSync(p) && baseUpdatedAt) {
        const cur = readJson(p);
        if (cur.updatedAt !== baseUpdatedAt) throw new Conflict('This quote was changed elsewhere since you opened it.', cur);
      }
      const next = { ...q, number: q.number || nextNumber(), updatedAt: new Date().toISOString() };
      atomicWriteJson(p, next);
      return next;
    },
    createQuote(fields) {
      const q = newQuote(readJson(libFile), readJson(catFile), { ...fields, number: nextNumber() });
      if (fields.createdBy) { q.createdBy = fields.createdBy; q.history[0].by = fields.createdBy; }
      atomicWriteJson(quotePath(q.id), q);
      return q;
    },
    duplicateQuote(id) {
      const c = duplicateQuote(this.getQuote(id), nextNumber());
      atomicWriteJson(quotePath(c.id), c);
      return c;
    },
    importQuote(obj) {
      const errs = validateQuoteShape(obj);
      if (errs.length) throw new Invalid('Not a valid quote export', errs);
      const q = JSON.parse(JSON.stringify(obj));
      if (!ID_RE.test(q.id || '') || fs.existsSync(quotePath(q.id))) q.id = cryptoId();
      if (!q.number) q.number = nextNumber();
      q.history = [...(q.history || []), { at: new Date().toISOString(), kind: 'imported' }];
      atomicWriteJson(quotePath(q.id), q);
      return q;
    },
    deleteQuote(id) {
      const p = quotePath(id);
      if (!fs.existsSync(p)) throw new NotFound('Quote not found');
      fs.renameSync(p, path.join(dirs.trash, `${id}.${Date.now()}.json`)); // recoverable
    },
    saveScan(scan) { atomicWriteJson(path.join(dirs.scans, `${scan.id}.json`), scan); },
    getScan(id) {
      if (!ID_RE.test(id)) throw new NotFound('Unknown scan');
      const p = path.join(dirs.scans, `${id}.json`);
      if (!fs.existsSync(p)) throw new NotFound('Scan not found');
      return readJson(p);
    },
    nextNumber,
  };
}

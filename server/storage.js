// File based storage with atomic writes. Pricing configuration, quotes and scans are plain JSON
// files under DATA_DIR so they are easy to back up, diff and restore.
import fs from 'node:fs';
import path from 'node:path';
import { newQuote, duplicateQuote, validateQuoteShape, validateLibraryShape, cryptoId, emptyFoundation, quoteTypes } from '../shared/quote.js';
import { migrateQuote, migrateLibrary, catalogueToFoundation } from '../shared/migrate.js';
import { emptyTeam, ROLE_IDS } from '../shared/plan.js';

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
  const dirs = { quotes: path.join(dataDir, 'quotes'), scans: path.join(dataDir, 'scans'), libVersions: path.join(dataDir, 'library-versions'), trash: path.join(dataDir, 'trash'), foundations: path.join(dataDir, 'foundations'), foundationVersions: path.join(dataDir, 'foundation-versions') };
  const libFile = path.join(dataDir, 'library.json');
  const legacyCatFile = path.join(dataDir, 'aaif-catalogue.json');
  const counterFile = path.join(dataDir, 'counter.json');
  const teamFile = path.join(dataDir, 'team.json');
  const defaults = readJson(path.join(root, 'shared/library-default.json'));
  const firstRun = !fs.existsSync(libFile);
  migrateDataDir({ dataDir, dirs, libFile, legacyCatFile, defaults });
  for (const d of [dataDir, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });

  // first run: seed the library, the foundations and the LF example quotes
  if (firstRun) atomicWriteJson(libFile, defaults);
  if (!fs.readdirSync(dirs.foundations).some(f => f.endsWith('.json'))) {
    const seedF = path.join(root, 'shared/foundations');
    if (fs.existsSync(seedF)) for (const f of fs.readdirSync(seedF)) if (f.endsWith('.json')) fs.copyFileSync(path.join(seedF, f), path.join(dirs.foundations, f));
  }
  if (!fs.existsSync(counterFile)) {
    const seedDir = path.join(root, 'seed/quotes');
    let max = 0;
    if (fs.existsSync(seedDir)) for (const f of fs.readdirSync(seedDir)) {
      const q = migrateQuote(readJson(path.join(seedDir, f)), defaults);
      atomicWriteJson(path.join(dirs.quotes, `${q.id}.json`), q);
      const n = Number((q.number || '').split('-').pop()); if (n > max) max = n;
    }
    atomicWriteJson(counterFile, { next: max + 1 });
  }

  const foundationPath = id => { if (!ID_RE.test(id || '')) throw new NotFound('Unknown foundation'); return path.join(dirs.foundations, `${id}.json`); };
  function getFoundation(id) { const p = foundationPath(id); if (!fs.existsSync(p)) throw new NotFound('Foundation not found'); return readJson(p); }
  function validateFoundation(f) {
    const errs = [];
    if (!f || typeof f !== 'object') return ['Not a foundation object'];
    if (!String(f.name || '').trim()) errs.push('Foundation needs a name');
    for (const k of ['components', 'contentModels', 'integrations', 'providedCapabilities']) if (f[k] !== undefined && !Array.isArray(f[k])) errs.push(`${k} must be a list`);
    const ids = new Set();
    for (const c of f.components || []) { if (!c.id) errs.push('Every component needs an id'); else if (ids.has(c.id)) errs.push(`Duplicate component ${c.id}`); ids.add(c.id); }
    const iids = new Set();
    for (const i of f.integrations || []) { if (!i.id) errs.push('Every integration needs an id'); else if (iids.has(i.id)) errs.push(`Duplicate integration ${i.id}`); iids.add(i.id); }
    return errs;
  }
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'foundation';
  function uniqueFoundationId(name) {
    const base = slug(name); let id = base, n = 2;
    while (fs.existsSync(path.join(dirs.foundations, `${id}.json`))) id = `${base}-${n++}`;
    return id;
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
    getTeam: () => (fs.existsSync(teamFile) ? readJson(teamFile) : emptyTeam()),
    saveTeam(team, { baseUpdatedAt } = {}) {
      if (!Array.isArray(team?.people)) throw new Invalid('Team needs a people list');
      const ids = new Set(); const errs = [];
      for (const p of team.people) {
        if (!p.id || !ID_RE.test(p.id)) errs.push('Every person needs an id');
        else if (ids.has(p.id)) errs.push(`Duplicate person ${p.id}`);
        ids.add(p.id);
        if (!String(p.name || '').trim()) errs.push('Every person needs a name');
        if (!ROLE_IDS.includes(p.role)) errs.push(`${p.name || p.id}: unknown role`);
        if (!(Number(p.hoursPerWeek) >= 0 && Number(p.hoursPerWeek) <= 80)) errs.push(`${p.name || p.id}: hours per week must be 0 to 80`);
      }
      if (errs.length) throw new Invalid('Team is not valid', errs);
      const cur = fs.existsSync(teamFile) ? readJson(teamFile) : null;
      if (cur && baseUpdatedAt && cur.updatedAt !== baseUpdatedAt) throw new Conflict('The team changed since you opened it. Reload and reapply your edits.', cur);
      const next = { schemaVersion: 1, people: team.people, updatedAt: new Date().toISOString() };
      atomicWriteJson(teamFile, next); return next;
    },
    listFoundations() {
      return fs.readdirSync(dirs.foundations).filter(f => f.endsWith('.json')).map(f => { try { return readJson(path.join(dirs.foundations, f)); } catch { return null; } })
        .filter(Boolean).sort((a, b) => (a.archived - b.archived) || a.name.localeCompare(b.name));
    },
    getFoundation,
    createFoundation(fields = {}) {
      const f = emptyFoundation({ ...fields, id: uniqueFoundationId(fields.name) });
      const errs = validateFoundation(f); if (errs.length) throw new Invalid('Foundation is not valid', errs);
      atomicWriteJson(foundationPath(f.id), f); return f;
    },
    saveFoundation(f, { baseUpdatedAt } = {}) {
      const errs = validateFoundation(f); if (errs.length) throw new Invalid('Foundation is not valid', errs);
      const cur = getFoundation(f.id);
      if (baseUpdatedAt && cur.updatedAt !== baseUpdatedAt) throw new Conflict('This foundation changed since you opened it. Reload and reapply your edits.', cur);
      atomicWriteJson(path.join(dirs.foundationVersions, `${f.id}.${(cur.updatedAt || 'unknown').replace(/[:.]/g, '-')}.json`), cur);
      const next = { ...cur, ...f, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
      atomicWriteJson(foundationPath(f.id), next); return next;
    },
    duplicateFoundation(id) {
      const src = getFoundation(id);
      const now = new Date().toISOString();
      const c = { ...JSON.parse(JSON.stringify(src)), id: uniqueFoundationId(`${src.name} copy`), name: `${src.name} (copy)`, archived: false, createdAt: now, updatedAt: now };
      atomicWriteJson(foundationPath(c.id), c); return c;
    },
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
      const lib = readJson(libFile);
      const type = quoteTypes(lib).find(t => t.id === fields.type) || quoteTypes(lib).find(t => t.id === (fields.foundationId ? 'foundation_site' : 'new_platform'));
      const foundation = fields.foundationId ? getFoundation(fields.foundationId) : null;
      if (type.usesFoundation === 'required' && !foundation) throw new Invalid(`${type.name} needs a foundation`);
      const q = newQuote(lib, foundation, { ...fields, type: type.id, number: nextNumber() });
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
      const q = migrateQuote(JSON.parse(JSON.stringify(obj)), readJson(libFile));
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

// One-off upgrade of a data folder written by schema version 1 (AAIF baked into quotes).
// Everything is copied to backups/pre-v2-<timestamp>/ before anything is rewritten.
function migrateDataDir({ dataDir, dirs, libFile, legacyCatFile, defaults }) {
  if (!fs.existsSync(libFile)) return;
  const lib = readJson(libFile);
  const quoteFiles = fs.existsSync(dirs.quotes) ? fs.readdirSync(dirs.quotes).filter(f => f.endsWith('.json')) : [];
  const oldQuotes = quoteFiles.filter(f => { try { return (readJson(path.join(dirs.quotes, f)).schemaVersion || 1) < 2; } catch { return false; } });
  const needs = (lib.schemaVersion || 1) < 2 || oldQuotes.length || fs.existsSync(legacyCatFile);
  if (!needs) return;
  const backup = path.join(dataDir, 'backups', `pre-v2-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.join(backup, 'quotes'), { recursive: true });
  fs.copyFileSync(libFile, path.join(backup, 'library.json'));
  if (fs.existsSync(legacyCatFile)) fs.copyFileSync(legacyCatFile, path.join(backup, 'aaif-catalogue.json'));
  for (const f of oldQuotes) fs.copyFileSync(path.join(dirs.quotes, f), path.join(backup, 'quotes', f));
  if ((lib.schemaVersion || 1) < 2) atomicWriteJson(libFile, migrateLibrary(lib, defaults));
  const migratedLib = readJson(libFile);
  for (const f of oldQuotes) atomicWriteJson(path.join(dirs.quotes, f), migrateQuote(readJson(path.join(dirs.quotes, f)), migratedLib));
  if (fs.existsSync(legacyCatFile)) {
    fs.mkdirSync(dirs.foundations, { recursive: true });
    const target = path.join(dirs.foundations, 'aaif.json');
    if (!fs.existsSync(target)) atomicWriteJson(target, catalogueToFoundation(readJson(legacyCatFile)));
    fs.unlinkSync(legacyCatFile);
  }
  console.log(`Upgraded data to schema version 2 (${oldQuotes.length} quotes). Backup: ${backup}`);
}

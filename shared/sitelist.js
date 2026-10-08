// Portfolio site lists: a CSV of the sites to roll out (name, URL, brand, site type) and how
// it feeds the quote's site types.

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t' || ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}

const HEAD = {
  name: /^(site\s*)?name$|^site$|^clinic$|^location$|^title$/i,
  url: /^(url|website|domain|address|site\s*url|homepage)$/i,
  brand: /^brand$/i,
  siteType: /^(site\s*type|type|template|tier|category|group)$/i,
};

// Returns { sites: [{ name, url, brand, siteType }], columns, skipped }
export function parseSiteList(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { sites: [], columns: {}, skipped: 0 };
  const head = rows[0];
  const cols = {};
  head.forEach((h, i) => { for (const [k, re] of Object.entries(HEAD)) if (cols[k] === undefined && re.test(h)) cols[k] = i; });
  let body = rows.slice(1);
  if (cols.url === undefined && cols.name === undefined) {
    // no header row: treat each line as a URL, or "name, url"
    body = rows;
    const urlCol = rows[0].findIndex(c => /^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(c));
    cols.url = urlCol >= 0 ? urlCol : 0;
    if (rows[0].length > 1) cols.name = cols.url === 0 ? 1 : 0;
  }
  let skipped = 0;
  const seen = new Set();
  const sites = [];
  for (const r of body) {
    let url = cols.url !== undefined ? r[cols.url] || '' : '';
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    const name = (cols.name !== undefined ? r[cols.name] : '') || url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!name && !url) { skipped++; continue; }
    const key = (url || name).toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    sites.push({ name, url, brand: cols.brand !== undefined ? r[cols.brand] || '' : '', siteType: cols.siteType !== undefined ? r[cols.siteType] || '' : '' });
  }
  return { sites, columns: cols, skipped };
}

// Merge a site list into site types: one site type per distinct value (matched by name),
// counts from the list, and up to `samplesPerType` sites picked as samples where a type has none.
export function applySiteList(groups, sites, { samplesPerType = 2, inUse = new Set() } = {}) {
  const out = groups.map(g => ({ ...g, samples: [...(g.samples || [])] }));
  const byName = new Map(out.map(g => [g.name.trim().toLowerCase(), g]));
  const counts = new Map();
  const firstUntyped = out[0];
  for (const s of sites) {
    let g = s.siteType ? byName.get(s.siteType.trim().toLowerCase()) : firstUntyped;
    if (!g) {
      g = { id: 'type_' + Math.random().toString(36).slice(2, 8), name: s.siteType.trim(), count: 0, samples: [], manual: null, notes: '' };
      out.push(g); byName.set(g.name.toLowerCase(), g);
    }
    counts.set(g.id, (counts.get(g.id) || 0) + 1);
  }
  for (const g of out) {
    if (counts.has(g.id)) g.count = counts.get(g.id);
    if (!g.samples.length) {
      const typeName = g.name.trim().toLowerCase();
      const pool = sites.filter(s => s.url && (s.siteType ? s.siteType.trim().toLowerCase() === typeName : g === firstUntyped));
      g.samples = pool.slice(0, samplesPerType).map(s => ({ url: s.url, name: s.name }));
    }
  }
  // drop an unused, empty default type left over from a fresh quote
  return out.filter(g => !(g === firstUntyped && !counts.has(g.id) && !inUse.has(g.id) && out.length > 1 && !g.samples.length && !g.manual && (g.count || 0) <= 1));
}

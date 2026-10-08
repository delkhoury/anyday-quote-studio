// Media helpers shared by the scanner and the CMS export import.

const TRANSFORM_PARAMS = /^(w|h|width|height|fit|crop|q|quality|auto|fm|format|dpr|resize|size|ssl|strip|v|ver|rect|ar)$/i;
const IMG = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic)$/i;
const DOC = /\.(pdf|docx?|pptx?|xlsx?|csv|zip|odt|ods|odp|rtf|epub|txt|key|pages|numbers)$/i;
const VID = /\.(mp4|mov|webm|m4v|avi|mkv)$/i;
const AUD = /\.(mp3|wav|m4a|ogg|flac)$/i;

// Collapse responsive sizes and transformed versions to their original asset when the
// relationship can be established from the URL.
export function canonicalAsset(raw) {
  let u;
  try { u = new URL(raw); } catch { return { key: String(raw), transformed: false }; }
  let transformed = false;
  if (u.pathname.includes('/_next/image') && u.searchParams.get('url')) {
    try { u = new URL(u.searchParams.get('url'), u); transformed = true; } catch { /* keep */ }
  }
  const p0 = u.pathname;
  u.pathname = u.pathname.replace(/(\/image\/upload\/)((?:[a-z]{1,3}_[^/]+,?)+\/)+/i, '$1');
  if (u.pathname !== p0) transformed = true;
  for (const k of [...u.searchParams.keys()]) if (TRANSFORM_PARAMS.test(k)) { u.searchParams.delete(k); transformed = true; }
  const before = u.pathname;
  u.pathname = u.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i, '').replace(/-scaled(?=\.[a-z0-9]+$)/i, '').replace(/-e\d{10,13}(?=\.[a-z0-9]+$)/i, '')
    .replace(/(\.(jpe?g|png|gif))\.(webp|avif)$/i, '$1');
  if (u.pathname !== before) transformed = true;
  u.hash = '';
  return { key: u.toString(), transformed };
}

export function assetKind(name = '', mime = '') {
  const m = String(mime).toLowerCase(); const n = String(name).toLowerCase().replace(/[?#].*$/, '');
  if (m.startsWith('image/') || IMG.test(n)) return 'images';
  if (m.startsWith('video/') || VID.test(n)) return 'video';
  if (m.startsWith('audio/') || AUD.test(n)) return 'audio';
  if (DOC.test(n) || /pdf|msword|officedocument|spreadsheet|presentation|zip|text\//.test(m)) return 'documents';
  return 'other';
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

// Parse a CMS media export (CSV with a url/filename column, a WordPress media JSON export,
// a Sanity asset export, or any JSON array of objects with url-like fields).
export function parseCmsExport(text, fileName = 'export') {
  const assets = [];
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    let data; try { data = JSON.parse(t); } catch { data = null; }
    // NDJSON (Sanity export)
    if (!data && t.includes('\n')) data = t.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const list = Array.isArray(data) ? data : (data?.result || data?.items || data?.assets || data?.data || []);
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      if (o._type && !/asset/i.test(o._type)) continue; // Sanity documents that are not assets
      const url = o.url || o.source_url || o.guid?.rendered || o.guid || o.src || o.path || o.originalFilename || o.filename || o.file;
      const mime = o.mimeType || o.mime_type || o.mime || o.type || '';
      if (url) assets.push({ url: String(url), mime: String(mime) });
    }
  } else {
    const rows = parseCsv(t);
    const head = (rows[0] || []).map(h => h.trim().toLowerCase());
    let col = head.findIndex(h => /^(url|source_url|file_url|path|filename|file|attachment_url|guid)$/.test(h));
    if (col < 0) col = head.findIndex(h => /url|file|path/.test(h));
    const mcol = head.findIndex(h => /mime|type/.test(h));
    const start = col >= 0 ? 1 : 0; if (col < 0) col = 0;
    for (const r of rows.slice(start)) if (r[col]?.trim()) assets.push({ url: r[col].trim(), mime: mcol >= 0 ? r[mcol] : '' });
  }
  const seen = new Map();
  for (const a of assets) { const k = canonicalAsset(a.url).key; if (!seen.has(k)) seen.set(k, assetKind(a.url, a.mime)); }
  const counts = { images: 0, documents: 0, video: 0, audio: 0, other: 0 };
  for (const kind of seen.values()) counts[kind]++;
  return { source: 'CMS export', fileName, importedAt: new Date().toISOString(), rows: assets.length, total: seen.size, duplicatesCollapsed: assets.length - seen.size, ...counts };
}

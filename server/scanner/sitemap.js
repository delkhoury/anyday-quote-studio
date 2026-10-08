// Sitemap discovery and recursive extraction (indexes, nested indexes, .gz files, image entries).
import * as cheerio from 'cheerio';
import { safeFetch, maybeGunzip, ScanError } from './net.js';

export const COMMON_SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap-index.xml', '/sitemap.xml.gz', '/sitemaps/sitemap.xml'];

export function parseSitemapXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const root = $.root().children().first();
  const rootName = (root.prop('tagName') || root[0]?.name || '').toLowerCase().replace(/^.*:/, '');
  if (rootName === 'sitemapindex') {
    const children = [];
    root.children().each((_, el) => {
      const loc = $(el).children().filter((_, c) => /(^|:)loc$/i.test(c.name)).first().text().trim();
      if (loc) children.push(loc);
    });
    return { type: 'index', children };
  }
  if (rootName === 'urlset') {
    const urls = [];
    root.children().each((_, el) => {
      const kids = $(el).children();
      const loc = kids.filter((_, c) => /(^|:)loc$/i.test(c.name) && !/image/i.test(c.name)).first().text().trim();
      if (!loc) return;
      const lastmod = kids.filter((_, c) => /(^|:)lastmod$/i.test(c.name)).first().text().trim() || null;
      const images = [];
      kids.filter((_, c) => /(^|:)image$/i.test(c.name)).each((_, im) => {
        const il = $(im).children().filter((_, c) => /(^|:)loc$/i.test(c.name)).first().text().trim();
        if (il) images.push(il);
      });
      urls.push({ loc, lastmod, images });
    });
    return { type: 'urlset', urls };
  }
  // plain text sitemap: one URL per line
  if (!/^\s*</.test(xml)) {
    const urls = String(xml).split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s)).map(loc => ({ loc, lastmod: null, images: [] }));
    if (urls.length) return { type: 'urlset', urls };
  }
  throw new ScanError('not_sitemap', `Not a sitemap (root element <${rootName || 'none'}>)`);
}

// Walk sitemaps from the given seeds. onProgress({sitemapsFetched, urlsFound, current}).
export async function collectSitemaps(seeds, { maxSitemaps = 200, maxUrls = 50000, maxDepth = 5, fetchOpts = {}, onProgress = () => {}, signal } = {}) {
  const visited = new Set();
  const files = []; // {url, type, depth, parent, count, error, status}
  const urls = new Map(); // loc -> {loc, lastmod, sitemap, images}
  const imageEntries = new Set();
  let limited = null;
  const queue = seeds.map(u => ({ url: u, depth: 0, parent: null }));
  while (queue.length) {
    if (signal?.aborted) throw new ScanError('cancelled', 'Scan cancelled');
    const { url, depth, parent } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    if (files.length >= maxSitemaps) { limited = `Stopped after ${maxSitemaps} sitemap files`; break; }
    const rec = { url, depth, parent, type: null, count: 0, error: null, status: null };
    files.push(rec);
    onProgress({ sitemapsFetched: files.length, urlsFound: urls.size, current: url });
    try {
      const res = await safeFetch(url, { ...fetchOpts, maxBytes: 20 * 1024 * 1024, accept: 'application/xml,text/xml,application/gzip,text/plain;q=0.8,*/*;q=0.5', signal });
      rec.status = res.status;
      if (res.status >= 400) { rec.error = `HTTP ${res.status}`; continue; }
      const xml = maybeGunzip(res.body).toString('utf8');
      const parsed = parseSitemapXml(xml);
      rec.type = parsed.type;
      if (parsed.type === 'index') {
        rec.count = parsed.children.length;
        if (depth + 1 > maxDepth) { rec.error = `Nested deeper than ${maxDepth} levels; children skipped`; continue; }
        for (const c of parsed.children) {
          try { queue.push({ url: new URL(c, url).toString(), depth: depth + 1, parent: url }); } catch { /* skip bad loc */ }
        }
      } else {
        for (const u of parsed.urls) {
          if (urls.size >= maxUrls) { limited = `Stopped at ${maxUrls} URLs`; break; }
          if (!urls.has(u.loc)) urls.set(u.loc, { loc: u.loc, lastmod: u.lastmod, sitemap: url });
          for (const i of u.images) imageEntries.add(i);
          rec.count++;
        }
        if (limited) break;
      }
    } catch (e) {
      if (e.code === 'cancelled') throw e;
      rec.error = e.message;
    }
  }
  return { files, urls: [...urls.values()], imageEntries: [...imageEntries], limited };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture-site.js';
import { runScan } from '../server/scanner/scan.js';
import { isPrivateAddress, safeFetch } from '../server/scanner/net.js';
import { parseRobots, makeRobotsChecker } from '../server/scanner/robots.js';
import { parseSitemapXml } from '../server/scanner/sitemap.js';
import { canonicalAsset, parseCmsExport } from '../shared/media.js';
import { mergeScan, summarize, effective, applyDecision, proposeQuantities, applyProposals } from '../shared/inventory.js';
import { newQuote } from '../shared/quote.js';
import fs from 'node:fs';

process.env.SCANNER_ALLOW_PRIVATE_HOSTS = '127.0.0.1';
const library = JSON.parse(fs.readFileSync(new URL('../shared/library-default.json', import.meta.url)));
const foundation = JSON.parse(fs.readFileSync(new URL('../shared/foundations/aaif.json', import.meta.url)));
const fast = { minDelayMs: 0, requestTimeoutMs: 5000 };
const ids = foundation.components.map(b => b.id);

test('private and reserved addresses are rejected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('safeFetch refuses private destinations and unsafe redirects', async () => {
  const { server, base } = await startFixture();
  try {
    await assert.rejects(safeFetch('http://localhost/'), e => e.code === 'private_destination');
    await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data'), e => e.code === 'private_destination');
    await assert.rejects(safeFetch('file:///etc/passwd'), e => e.code === 'bad_url');
    await assert.rejects(safeFetch('http://user:pw@example.org/'), e => e.code === 'bad_url');
    // fixture host is allowed in tests, but its redirect to 10.0.0.5 must be refused
    await assert.rejects(safeFetch(base + '/go-internal'), e => e.code === 'private_destination');
    const ok = await safeFetch(base + '/robots.txt');
    assert.equal(ok.status, 200);
    await assert.rejects(safeFetch(base + '/', { maxBytes: 100 }), e => e.code === 'too_large');
  } finally { server.close(); }
});

test('robots.txt rules, wildcards and sitemaps', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public$\nDisallow: /*.pdf$\nCrawl-delay: 2\nSitemap: https://x.org/s.xml');
  const c = makeRobotsChecker(r);
  assert.equal(c.allowed('https://x.org/private/a'), false);
  assert.equal(c.allowed('https://x.org/private/public'), true);
  assert.equal(c.allowed('https://x.org/file.pdf'), false);
  assert.equal(c.allowed('https://x.org/about'), true);
  assert.equal(c.crawlDelay, 2);
  assert.deepEqual(r.sitemaps, ['https://x.org/s.xml']);
});

test('sitemap parsing: index, urlset with images', () => {
  const idx = parseSitemapXml('<sitemapindex><sitemap><loc>https://a/x.xml</loc></sitemap></sitemapindex>');
  assert.deepEqual(idx, { type: 'index', children: ['https://a/x.xml'] });
  const us = parseSitemapXml('<urlset xmlns:image="i"><url><loc>https://a/p</loc><lastmod>2026</lastmod><image:image><image:loc>https://a/i.jpg</image:loc></image:image></url></urlset>');
  assert.equal(us.urls[0].loc, 'https://a/p'); assert.deepEqual(us.urls[0].images, ['https://a/i.jpg']);
  assert.throws(() => parseSitemapXml('<html><body>no</body></html>'));
});

test('full scan: nested and gzipped sitemaps, partial failures, scope, robots, classification, media', async () => {
  const { server, base } = await startFixture();
  try {
    const r = await runScan({ rootUrl: base, catalogueIds: ids, limits: fast });
    assert.equal(r.status, 'complete');
    const urls = r.entries.map(e => e.url);
    // nested index + gzip followed
    assert.ok(urls.includes(base + '/events/e-3/'));
    assert.ok(urls.includes(base + '/blog/post-12/'));
    // dedupe
    assert.equal(urls.filter(u => u === base + '/about/').length, 1);
    // out of scope host kept separate
    assert.ok(!urls.some(u => u.includes('sub.other.org')));
    assert.equal(r.coverage.urlsOutOfScope['sub.other.org'], 1);
    assert.deepEqual(r.coverage.outOfScopeSitemaps, ['http://other.example/sitemap.xml']);
    // partial failures reported, not fatal
    assert.equal(r.partial, true);
    assert.ok(r.failures.some(f => f.url.endsWith('/broken.xml') && /500/.test(f.error)));
    assert.ok(r.failures.some(f => f.url.endsWith('/missing.xml') && /404/.test(f.error)));
    // robots respected: disallowed URL not inspected
    const priv = r.entries.find(e => e.url.endsWith('/private/secret/'));
    assert.equal(priv.findings.inspected, false);
    assert.equal(r.coverage.disallowedByRobots, 1);
    const by = u => r.entries.find(e => e.url === base + u).findings;
    assert.equal(by('/').category, 'L1');
    assert.equal(by('/privacy/').category, 'L3');
    assert.equal(by('/blog/post-1/').category, 'RECORD');
    assert.equal(by('/blog/post-5/').category, 'RECORD'); // long article stays a record, never Level 1 by length
    assert.equal(by('/events/e-1/').category, 'RECORD');
    assert.equal(by('/events/e-1/').contentType, 'Event');
    assert.equal(by('/tag/news/').category, 'ARCHIVE');
    assert.equal(by('/locations/l-3/').category, 'BULK_STATIC');
    assert.ok(by('/').suggestedBlocks.includes('hero'));
    assert.ok(by('/').suggestedBlocks.includes('contactSection'));
    for (const e of r.entries) { assert.ok(e.findings.reason); assert.ok(e.findings.confidence); }
    // media: responsive sizes collapsed, documents and video references separated
    const d = r.media.discovered;
    assert.ok(d.images.variantsCollapsed > 0);
    assert.ok(d.documents.unique >= 1);
    assert.equal(d.videos.externalReferences, 1);
    assert.match(d.label, /not a complete media library count/);
    assert.ok(r.media.imageSitemap.entries >= 1);
  } finally { server.close(); }
});

test('rescan keeps decisions and identifies new, changed and missing URLs', async () => {
  const { server, base, state } = await startFixture();
  try {
    const s1 = await runScan({ rootUrl: base, catalogueIds: ids, limits: fast });
    let inv = mergeScan({ entries: [] }, s1);
    assert.ok(inv.entries.every(e => e.status === 'new'));
    const idx = inv.entries.findIndex(e => e.url === base + '/about/');
    inv.entries[idx] = applyDecision(inv.entries[idx], { category: 'L1', reviewed: true, notes: 'Complex team page' });
    state.extraPage = true; state.privacyText = 'Changed policy with a table <section class="x"></section><section class="y"></section>'; state.dropContact = true;
    const s2 = await runScan({ rootUrl: base, catalogueIds: ids, limits: fast });
    inv = mergeScan(inv, s2);
    const get = u => inv.entries.find(e => e.url === base + u);
    assert.equal(get('/about/').decision.category, 'L1');
    assert.equal(effective(get('/about/')).category, 'L1');
    assert.equal(get('/about/').findings.category, 'L2'); // original finding preserved separately
    assert.equal(get('/new-page/').status, 'new');
    assert.equal(get('/contact/').status, 'not_seen');
    assert.equal(get('/blog/post-1/').status, 'unchanged');
    assert.equal(inv.scans.length, 2);
  } finally { server.close(); }
});

test('no sitemap: reports it, bounded crawl only on request and labelled', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<main><h1>Home</h1><a href="/a">A</a><a href="/b">B</a><a href="https://elsewhere.org/x">X</a></main>'); }
    if (req.url === '/a' || req.url === '/b') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<main><h1>Page</h1><p>Text</p></main>'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r1 = await runScan({ rootUrl: base, limits: fast });
    assert.equal(r1.status, 'no_sitemap');
    assert.equal(r1.entries.length, 0);
    const r2 = await runScan({ rootUrl: base, crawlIfNoSitemap: true, limits: { ...fast, maxCrawlPages: 10 } });
    assert.equal(r2.coverage.mode, 'crawl');
    assert.equal(r2.entries.length, 3);
    assert.match(r2.coverage.crawl.note, /not the full size of the site/);
  } finally { srv.close(); }
});

test('canonical assets and CMS export parsing', () => {
  assert.equal(canonicalAsset('https://a.org/wp-content/uploads/x-1024x683.jpg').key, 'https://a.org/wp-content/uploads/x.jpg');
  assert.equal(canonicalAsset('https://a.org/_next/image?url=%2Fimg%2Fhero.png&w=1080&q=75').key, 'https://a.org/img/hero.png');
  assert.equal(canonicalAsset('https://res.cloudinary.com/demo/image/upload/w_300,c_fill/v1/sample.jpg').key, 'https://res.cloudinary.com/demo/image/upload/v1/sample.jpg');
  const csv = 'id,url,mime_type\n1,https://a.org/u/a.jpg,image/jpeg\n2,https://a.org/u/a-300x200.jpg,image/jpeg\n3,https://a.org/u/r.pdf,application/pdf\n4,https://a.org/u/v.mp4,video/mp4';
  const r = parseCmsExport(csv, 'media.csv');
  assert.equal(r.total, 3); assert.equal(r.images, 1); assert.equal(r.documents, 1); assert.equal(r.video, 1); assert.equal(r.duplicatesCollapsed, 1);
  const wp = parseCmsExport(JSON.stringify([{ source_url: 'https://a.org/x.png', mime_type: 'image/png' }, { source_url: 'https://a.org/y.docx' }]));
  assert.equal(wp.images, 1); assert.equal(wp.documents, 1);
  const sanity = parseCmsExport('{"_type":"sanity.imageAsset","url":"https://cdn.sanity.io/i.jpg"}\n{"_type":"post","title":"x"}\n{"_type":"sanity.fileAsset","url":"https://cdn.sanity.io/f.pdf"}');
  assert.equal(sanity.total, 2);
});

test('apply quantities: proposals do not overwrite manual quantities and redirects stay independent', () => {
  const q = newQuote(library, foundation);
  q.inventory = { source: { type: 'scan', date: '2026-10-07' }, entries: [
    { url: 'https://x/a', findings: { category: 'L1', include: true } },
    { url: 'https://x/b', findings: { category: 'L2', include: true } },
    { url: 'https://x/c', findings: { category: 'RECORD', include: true, contentType: 'Post' } },
    { url: 'https://x/d', findings: { category: 'RECORD', include: false, contentType: 'Post' } },
    { url: 'https://x/t', findings: { category: 'ARCHIVE', include: true } },
  ], media: {} };
  q.lines.MIG_L2_PAGE = { state: 'included', qty: 5, qtySource: 'manual' };
  q.lines.MIG_REDIRECTS = { state: 'included', qty: 40, qtySource: 'manual' };
  const { rows, summary } = proposeQuantities(q);
  assert.equal(summary.discovered, 5); assert.equal(summary.byCategory.RECORD, 1); assert.equal(summary.byCategoryAll.RECORD, 2);
  const r = Object.fromEntries(rows.map(x => [x.id, x]));
  assert.equal(r.MIG_L1_PAGE.proposed, 1); assert.equal(r.MIG_L1_PAGE.selected, true);
  assert.equal(r.MIG_L2_PAGE.proposed, 1); assert.equal(r.MIG_L2_PAGE.selected, false); // manual: not auto selected
  assert.equal(r.MIG_REDIRECTS.proposed, 40); assert.equal(r.MIG_REDIRECTS.selected, false);
  assert.equal(r.MIG_BULK_STATIC.selected, false); // zero into an item not in scope is never preselected
  assert.equal(r.MIG_L1_PAGE.change, 100000);
  const next = applyProposals(q, rows);
  assert.equal(next.lines.MIG_L1_PAGE.qty, 1); assert.equal(next.lines.MIG_L1_PAGE.state, 'included');
  assert.equal(next.lines.MIG_L2_PAGE.qty, 5);
  assert.equal(next.lines.MIG_REDIRECTS.qty, 40);
  assert.ok(next.proposal.autoAssumptions.length >= 1);
  // nothing infers new components or integrations
  assert.ok(!rows.some(x => /^BASE_/.test(x.id)));
});

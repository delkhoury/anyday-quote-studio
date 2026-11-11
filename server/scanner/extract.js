// Deterministic page structure extraction. Produces structural signals used for classification;
// no AI involved.
import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { detectTech, detectLanguages, sectionSignature } from './tech.js';

const BLOCK_SELECTORS = [
  '.vc_row', '.wpb_row', '.elementor-section', '.elementor-top-section', '[class*="wp-block-"]', 'section', '[class*="block"]', '[class*="section"]', '[data-block]', '[data-component]',
];
const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'figure', 'blockquote', 'img', 'span', 'a', 'strong', 'em', 'pre', 'code', 'table', 'hr', 'br']);
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|zip|odt|ods|odp|rtf|epub)(\?|#|$)/i;
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(\?|#|$)/i;
const VIDEO_HOSTS = /(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|player\.vimeo\.com|wistia\.(com|net)|loom\.com|vidyard\.com|brightcove)/i;

function topLevelBlocks($, main) {
  // Find the shallowest repeated container level inside main that looks like page sections.
  let best = [];
  for (const sel of BLOCK_SELECTORS) {
    // text level elements (paragraphs, headings, lists) are content, not page sections
    const top = main.find(sel).filter((_, el) => !TEXT_TAGS.has(el.name) && $(el).parentsUntil(main, sel).length === 0);
    if (top.length > best.length && top.length < 200) best = top.toArray();
  }
  if (best.length < 2) best = main.children().filter((_, el) => !['script', 'style', 'noscript', 'link', 'meta'].includes(el.name)).toArray();
  return best;
}

function blockType($, el) {
  const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean)
    .map(c => c.replace(/[-_]?\d+$/, '').replace(/--.*$/, ''))
    .filter(c => !/^(container|row|col|wrapper|inner|clearfix|w-|is-|has-|js-|align|vc_custom|elementor-element|e-con|wp-block-group$)/.test(c));
  const t = cls.find(c => /hero|banner|grid|card|list|tabs|accordion|faq|slider|carousel|gallery|form|cta|callout|testimonial|quote|stats|logo|team|people|member|event|calendar|news|blog|video|map|feature|pricing|timeline/i.test(c)) || cls[0] || el.name;
  return t.toLowerCase().slice(0, 40);
}

function repeatedSiblingGroups($, root) {
  // Card grids: a parent with >= 6 children sharing the same tag + first class
  let grids = 0; let maxRun = 0;
  root.find('*').each((_, el) => {
    const kids = $(el).children();
    if (kids.length < 6) return;
    const sigs = {};
    kids.each((_, k) => { const s = k.name + '.' + (($(k).attr('class') || '').split(/\s+/)[0] || ''); sigs[s] = (sigs[s] || 0) + 1; });
    const top = Math.max(...Object.values(sigs));
    if (top >= 6 && top / kids.length > 0.7 && kids.first().find('a').length) { grids++; maxRun = Math.max(maxRun, top); }
  });
  return { grids, maxRun };
}

export function extractPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const title = $('title').first().text().trim().replace(/\s+/g, ' ');
  const h1 = $('h1').map((_, e) => $(e).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  const h2 = $('h2').map((_, e) => $(e).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  const ogType = $('meta[property="og:type"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const generator = $('meta[name="generator"]').attr('content') || '';
  const schemaTypes = new Set();
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); const t = o['@type']; if (t) [].concat(t).forEach(x => schemaTypes.add(String(x))); if (o['@graph']) walk(o['@graph']); };
      walk(JSON.parse($(s).contents().text()));
    } catch { /* ignore malformed JSON-LD */ }
  });
  const bodyClass = $('body').attr('class') || '';

  // main content region (exclude header/nav/footer chrome)
  let main = $('main').first();
  if (!main.length) main = $('[role="main"]').first();
  if (!main.length) main = $('#content, #main, .site-content, .content').first();
  if (!main.length) main = $('body');
  const chrome = main.find('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');

  const blocks = topLevelBlocks($, main);
  const types = blocks.map(el => blockType($, el));
  const distinctTypes = new Set(types);
  const sectionMap = new Map();
  blocks.forEach((el, i) => { const sg = sectionSignature($, el, types[i]); if (!sectionMap.has(sg.sig)) sectionMap.set(sg.sig, sg); });
  const tech = detectTech($, html, generator);
  const languages = detectLanguages($, pageUrl);

  const forms = main.find('form').toArray();
  const formKinds = forms.map(f => {
    const $f = $(f); const inputs = $f.find('input, select, textarea').filter((_, i) => !['hidden', 'submit', 'button'].includes(($(i).attr('type') || '').toLowerCase()));
    const action = ($f.attr('action') || '').toLowerCase(); const role = ($f.attr('role') || '').toLowerCase();
    if (role === 'search' || $f.find('input[type="search"]').length || /search|\?s=/.test(action)) return 'search';
    if (inputs.length <= 2 && $f.find('input[type="email"]').length) return 'newsletter';
    if ($f.find('select').length && inputs.length <= 4 && !$f.find('textarea').length) return 'filter';
    return 'contact';
  });
  const iframes = main.find('iframe').map((_, e) => $(e).attr('src') || $(e).attr('data-src') || '').get();
  const videoEmbeds = iframes.filter(s => VIDEO_HOSTS.test(s));
  const mapEmbeds = iframes.filter(s => /maps\.google|google\.com\/maps|mapbox|openstreetmap/i.test(s));
  const otherEmbeds = iframes.filter(s => !VIDEO_HOSTS.test(s) && !/maps\.google|google\.com\/maps|mapbox|openstreetmap/i.test(s));

  const signals = {
    tabs: main.find('[role="tablist"], .tabs, [class*="tab-"], .vc_tta-tabs').length > 0,
    accordion: main.find('details, [class*="accordion"], .vc_tta-accordion, [aria-expanded]').length > 0,
    carousel: main.find('[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="slick"]').length > 0,
    filters: formKinds.includes('filter') || main.find('[data-filter], [class*="filter"], [class*="facet"]').length > 0,
    pagination: main.find('.pagination, nav[aria-label*="agination"], [class*="pagination"], a[rel="next"]').length > 0,
    map: mapEmbeds.length > 0,
    calendar: main.find('[class*="calendar"], [class*="tribe-events"], [class*="event-list"], [class*="events-list"]').length > 0,
    testimonial: main.find('blockquote, [class*="testimonial"]').length > 0,
    logoWall: main.find('img').filter((_, i) => /logo|member|sponsor|partner/i.test(($(i).attr('alt') || '') + ($(i).attr('src') || '') + ($(i).parent().attr('class') || ''))).length >= 8,
    peopleGrid: main.find('[class*="person"], [class*="people"], [class*="team"], [class*="staff"], [class*="speaker"], [class*="member-card"]').length >= 4,
    hero: (() => { const first = blocks[0] ? $(blocks[0]) : null; return !!(first && (first.find('h1').length || /hero|banner|masthead/i.test(first.attr('class') || '')) && (first.find('img, picture, video').length || /background/i.test(first.attr('style') || '') || /hero|banner/i.test(first.attr('class') || ''))); })(),
    faqHeading: [...h1, ...h2].some(t => /\bfaqs?\b|frequently asked/i.test(t)),
  };
  const grid = repeatedSiblingGroups($, main);
  const article = main.find('article').length;
  const hasTime = main.find('time[datetime], .entry-date, .post-date, [class*="published"]').length > 0;
  const hasByline = $('a[rel="author"], .author, .byline, [class*="author"], meta[name="author"]').length > 0;
  const textClone = main.clone(); textClone.find('script, style, noscript, nav, header, footer, form').remove();
  const words = textClone.text().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  void chrome;

  // structural fingerprint for template grouping (block type sequence, collapsed runs)
  const seq = types.filter((t, i) => t !== types[i - 1]).slice(0, 30).join('>');
  const fingerprint = crypto.createHash('sha1').update(seq + '|' + (bodyClass.match(/\b(page-template-[\w-]+|single-[\w-]+|post-type-[\w-]+|archive|home|blog)\b/g) || []).join(',')).digest('hex').slice(0, 12);

  // media
  const media = { images: [], documents: [], videos: videoEmbeds.slice() };
  const abs = s => { try { return new URL(s, base).toString(); } catch { return null; } };
  $('img, source').each((_, el) => {
    const $e = $(el);
    for (const attr of ['src', 'data-src', 'data-lazy-src']) { const v = $e.attr(attr); if (v && !v.startsWith('data:')) { const a = abs(v); if (a) media.images.push(a); } }
    for (const attr of ['srcset', 'data-srcset']) { const v = $e.attr(attr); if (v) v.split(',').map(x => x.trim().split(/\s+/)[0]).filter(x => x && !x.startsWith('data:')).forEach(x => { const a = abs(x); if (a) media.images.push(a); }); }
  });
  $('a[href], link[href]').each((_, el) => { const v = $(el).attr('href'); if (v && DOC_EXT.test(v)) { const a = abs(v); if (a) media.documents.push(a); } });
  $('video[src], video source[src]').each((_, el) => { const a = abs($(el).attr('src')); if (a) media.videos.push(a); });
  media.images = media.images.filter(u => IMG_EXT.test(u) || /\/_next\/image|\/image\/upload\/|imgix|cloudinary|\/wp-content\/uploads\//i.test(u));

  // internal links (for bounded crawl)
  const links = [];
  $('a[href]').each((_, el) => { const a = abs($(el).attr('href')); if (a && /^https?:/.test(a)) links.push(a.split('#')[0]); });

  return {
    title, h1, h2: h2.slice(0, 12), ogType, schemaTypes: [...schemaTypes], canonical, robotsMeta, generator, bodyClass: bodyClass.slice(0, 300),
    blocks: blocks.length, blockTypes: [...distinctTypes].slice(0, 30), distinctBlockTypes: distinctTypes.size,
    forms: formKinds, iframes: iframes.length, videoEmbeds: videoEmbeds.length, mapEmbeds: mapEmbeds.length, otherEmbeds: otherEmbeds.length,
    signals, cardGrids: grid.grids, article, hasTime, hasByline, words, fingerprint, media, links,
    tech, languages, sections: [...sectionMap.values()].slice(0, 40),
  };
}

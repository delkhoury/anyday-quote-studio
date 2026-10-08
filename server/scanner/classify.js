// Deterministic classification. Every result is a recommendation with a stated reason, evidence
// source and confidence. Complexity comes from page structure and functionality, never URL depth
// or word count alone.

const ARCHIVE_PATH = /\/(tag|tags|category|categories|author|authors|topic|topics|archive|archives|type|series)\/[^/]+\/?$|\/page\/\d+\/?$|\/\d{4}\/(\d{2}\/)?$/i;
const ARCHIVE_QUERY = /[?&](tag|cat|category|author|paged|page)=/i;

export function sitemapHint(sitemapUrl) {
  if (!sitemapUrl) return null;
  const f = sitemapUrl.toLowerCase().split('/').pop().replace(/\.gz$/, '');
  let m;
  if ((m = f.match(/^wp-sitemap-taxonomies-([a-z0-9_-]+?)-\d+\.xml$/))) return { kind: 'archive', cmsType: m[1] };
  if (/^wp-sitemap-users-\d+\.xml$/.test(f)) return { kind: 'archive', cmsType: 'author' };
  if ((m = f.match(/^wp-sitemap-posts-([a-z0-9_-]+?)-\d+\.xml$/))) return { kind: m[1] === 'page' ? 'page' : 'record', cmsType: m[1] };
  if ((m = f.match(/^([a-z0-9_-]+?)-sitemap\d*\.xml$/))) { // Yoast / Rank Math
    const t = m[1];
    if (/^(category|post_tag|tag|author|.*_cat|.*_tag|.*taxonomy.*)$/.test(t)) return { kind: 'archive', cmsType: t };
    if (t === 'page') return { kind: 'page', cmsType: 'page' };
    return { kind: 'record', cmsType: t };
  }
  if (/tag|categor|author|taxonom/.test(f)) return { kind: 'archive', cmsType: null };
  return null;
}

const TYPE_LABELS = [
  [/^(post|posts|blog|blogs|article|articles|blogposting|newsarticle|stories)$/i, 'Editorial post'],
  [/^(news|press|press-releases?|announcements?|announcement)$/i, 'News / announcement'],
  [/^(events?|tribe_events|webinars?|meetups?|event)$/i, 'Event'],
  [/^(people|person|team|staff|speakers?|ambassadors?|profiles?)$/i, 'Person'],
  [/^(projects?|project)$/i, 'Project'],
  [/^(resources?|reports?|whitepapers?|ebooks?|guides?|publications?|research)$/i, 'Resource / report'],
  [/^(case-stud(y|ies)|case_study|customers?|stories)$/i, 'Case study'],
  [/^(jobs?|careers?)$/i, 'Job'],
  [/^(videos?|podcasts?|episodes?|webinar)$/i, 'Media item'],
  [/^(members?|organizations?|companies)$/i, 'Member'],
  [/^(products?|product)$/i, 'Product'],
];
export function labelForType(t) {
  if (!t) return '';
  for (const [re, label] of TYPE_LABELS) if (re.test(t)) return label;
  return t.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
}

export function urlPattern(u) {
  const x = new URL(u);
  const segs = x.pathname.split('/').filter(Boolean);
  if (!segs.length) return '/';
  if (segs.length === 1) return '/' + segs[0];
  return '/' + segs[0] + '/' + segs.slice(1).map(() => '*').join('/');
}

// Group URLs into repeatable patterns (same first segment, same depth). Large groups are
// candidates for structured records or bulk static pages.
export function groupUrls(urls) {
  const groups = new Map();
  for (const u of urls) {
    const key = urlPattern(u.loc);
    if (!groups.has(key)) groups.set(key, { pattern: key, urls: [], sitemaps: new Set() });
    const g = groups.get(key); g.urls.push(u.loc); if (u.sitemap) g.sitemaps.add(u.sitemap);
  }
  return [...groups.values()].map(g => ({ ...g, sitemaps: [...g.sitemaps], size: g.urls.length }));
}

export function isArchiveUrl(u) {
  const x = new URL(u);
  return ARCHIVE_PATH.test(x.pathname) || ARCHIVE_QUERY.test(x.search);
}

const RECORD_SCHEMA = /^(Article|NewsArticle|BlogPosting|TechArticle|Report|ScholarlyArticle|Event|Person|Product|CreativeWork|VideoObject|PodcastEpisode|JobPosting|Course|Recipe|Review)$/;

// Assess one inspected page. group: { size, pattern }, hint: sitemapHint
export function classifyInspected(url, f, { group, hint }) {
  const isHome = new URL(url).pathname.replace(/\/+$/, '') === '';
  const schemaRecord = f.schemaTypes.find(t => RECORD_SCHEMA.test(t));
  const reasons = [];
  const evidence = ['HTML inspected'];
  if (hint) evidence.push(`sitemap type: ${hint.cmsType || hint.kind}`);

  if (!isHome && (hint?.kind === 'archive' || isArchiveUrl(url))) {
    return { category: 'ARCHIVE', contentType: 'Taxonomy / author index', reason: 'Archive route generated from content; regenerate from migrated records rather than compose per URL', confidence: hint?.kind === 'archive' ? 'high' : 'medium', evidence: evidence.join('; ') };
  }

  const recordSignals = [];
  if (schemaRecord && schemaRecord !== 'CreativeWork') recordSignals.push(`schema.org ${schemaRecord}`);
  if (/article/i.test(f.ogType)) recordSignals.push('og:type article');
  if (f.article === 1 && f.hasTime) recordSignals.push('single article with a publish date');
  if (f.hasByline && f.hasTime) recordSignals.push('byline and date');
  if (/\bsingle-[a-z_-]+|\bsingle\b|post-template/.test(f.bodyClass)) recordSignals.push('single item template class');
  const big = group && group.size >= 5 && group.pattern.includes('*');
  if (!isHome && (hint?.kind === 'record' || (recordSignals.length >= 2) || (recordSignals.length >= 1 && big))) {
    const t = labelForType(hint?.cmsType && hint.kind === 'record' ? hint.cmsType : (schemaRecord && schemaRecord !== 'CreativeWork' ? schemaRecord : group?.pattern.split('/')[1]));
    if (hint?.kind === 'record') reasons.push(`CMS type "${hint.cmsType}" from the sitemap`);
    if (recordSignals.length) reasons.push(recordSignals.join(', '));
    if (big) reasons.push(`one of ${group.size} URLs sharing ${group.pattern}`);
    return { category: 'RECORD', contentType: t || 'Structured record', reason: 'Repeatable content: ' + reasons.join('; '), confidence: hint?.kind === 'record' ? 'high' : (recordSignals.length >= 2 ? 'medium' : 'low'), evidence: evidence.join('; ') };
  }

  // composed page complexity from structure and functionality
  const s = f.signals;
  const interactive = [
    s.tabs && 'tabs', s.accordion && 'accordion', s.carousel && 'carousel', s.filters && 'filters', s.map && 'map',
    s.calendar && 'calendar', f.forms.filter(k => k === 'contact').length && 'form', f.videoEmbeds && 'video embed',
    f.otherEmbeds && 'embedded app', f.cardGrids && 'card grid', s.pagination && 'listing with pagination',
  ].filter(Boolean);
  const sections = f.blocks; const distinct = f.distinctBlockTypes;
  const desc = `${sections} section${sections === 1 ? '' : 's'}, ${distinct} distinct block type${distinct === 1 ? '' : 's'}${interactive.length ? ', ' + interactive.join(', ') : ''}`;
  let category, why;
  if (isHome) { category = 'L1'; why = 'Homepage: major assembly'; }
  else if (interactive.length >= 3 || (distinct >= 7 && sections >= 8) || (interactive.length >= 2 && distinct >= 5)) { category = 'L1'; why = 'Rich structure or several interactive features'; }
  else if (sections <= 3 && distinct <= 2 && interactive.length === 0) { category = 'L3'; why = 'Simple standardised layout'; }
  else { category = 'L2'; why = 'Assembled from established patterns'; }
  if (f.words > 1500 && category === 'L1' && interactive.length < 3 && !isHome) { category = 'L2'; why += '; long text alone does not make a Level 1 page'; }
  const t = hint?.kind === 'page' ? 'Page' : (f.cardGrids || s.pagination ? 'Listing / landing' : (category === 'L3' ? 'Simple / reference page' : 'Landing / informational'));
  return { category, contentType: t, reason: `${why} (${desc})`, confidence: 'medium', evidence: evidence.join('; ') };
}

// Classification for URLs that were not inspected (beyond the page limit).
export function classifyUninspected(url, { group, hint, groupResult }) {
  const isHome = new URL(url).pathname.replace(/\/+$/, '') === '';
  if (!isHome && (hint?.kind === 'archive' || isArchiveUrl(url))) {
    return { category: 'ARCHIVE', contentType: 'Taxonomy / author index', reason: 'Archive route by sitemap type or URL pattern; regenerated, not composed per URL', confidence: hint?.kind === 'archive' ? 'high' : 'medium', evidence: hint ? `sitemap type: ${hint.cmsType || hint.kind}` : 'URL pattern' };
  }
  if (hint?.kind === 'record') {
    return { category: 'RECORD', contentType: labelForType(hint.cmsType), reason: `CMS type "${hint.cmsType}" established by the sitemap; migrate as repeatable content`, confidence: 'high', evidence: `sitemap type: ${hint.cmsType} (page not inspected)` };
  }
  if (groupResult) {
    return { category: groupResult.category, contentType: groupResult.contentType, reason: `Inferred from ${groupResult.inspected} inspected page${groupResult.inspected === 1 ? '' : 's'} sharing ${group.pattern}`, confidence: 'low', evidence: 'URL group representative (page not inspected)' };
  }
  return { category: 'REVIEW', contentType: '', reason: 'Not inspected within the page limit and no sitemap type to rely on', confidence: 'low', evidence: 'Sitemap only' };
}

// Suggest existing AAIF blocks only where structural evidence supports a match.
export function suggestBlocks(f, url, catalogueIds) {
  const has = id => catalogueIds.includes(id);
  const out = [];
  const isHome = new URL(url).pathname.replace(/\/+$/, '') === '';
  const s = f.signals;
  if (s.hero) out.push(isHome ? 'hero' : 'pageHero');
  if (s.accordion) out.push(s.faqHeading ? 'faq' : 'accordionSection');
  if (s.tabs) out.push('tabsListingSection');
  if (f.forms.includes('contact')) out.push('contactSection');
  if (f.forms.includes('newsletter')) out.push('subscription');
  if (s.calendar) out.push('calendar');
  if (s.testimonial) out.push('testimonial');
  if (s.logoWall) out.push('membersSection');
  if (s.peopleGrid) out.push('peopleSection');
  if (f.videoEmbeds >= 2) out.push('videoListingSection');
  const heads = [...f.h1, ...f.h2].join(' ').toLowerCase();
  if (f.cardGrids && /\bblog\b/.test(heads)) out.push('blogList');
  if (f.cardGrids && /\bnews\b/.test(heads)) out.push('newsList');
  if (f.cardGrids && /\bprojects?\b/.test(heads)) out.push('projects');
  return [...new Set(out)].filter(has);
}

import { canonicalAsset } from '../../shared/media.js';
export { canonicalAsset };

export function summarizeMedia(pagesMedia, pagesInspected, imageEntries) {
  const images = new Map(); const docs = new Set(); const videos = new Set();
  let rawImages = 0;
  for (const m of pagesMedia) {
    for (const i of m.images) { rawImages++; const c = canonicalAsset(i); if (!images.has(c.key)) images.set(c.key, 0); images.set(c.key, images.get(c.key) + 1); }
    for (const d of m.documents) docs.add(canonicalAsset(d).key);
    for (const v of m.videos) videos.add(v.replace(/[?#].*$/, ''));
  }
  const imgSitemap = new Set((imageEntries || []).map(i => canonicalAsset(i).key));
  return {
    discovered: {
      pagesInspected,
      images: { unique: images.size, references: rawImages, variantsCollapsed: Math.max(0, rawImages - images.size) },
      documents: { unique: docs.size, byExtension: countExt([...docs]) },
      videos: { externalReferences: videos.size, note: 'External video embeds are references, not files to migrate' },
      label: `Media URLs found on ${pagesInspected} inspected page${pagesInspected === 1 ? '' : 's'}. This is not a complete media library count.`,
    },
    imageSitemap: imageEntries?.length ? { entries: imageEntries.length, unique: imgSitemap.size, label: 'Image entries declared in the sitemaps' } : null,
  };
}
function countExt(list) { const c = {}; for (const d of list) { const m = d.match(/\.([a-z0-9]+)(?:[?#]|$)/i); const e = m ? m[1].toLowerCase() : 'other'; c[e] = (c[e] || 0) + 1; } return c; }

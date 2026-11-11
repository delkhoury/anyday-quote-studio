// Site insights: the CMS and its exact content counts (when the CMS publishes them), integrations,
// languages, templates and distinct components, built from the inspected pages.
import { safeFetch } from './net.js';
import { INTEGRATION_CATEGORIES } from './tech.js';

// WordPress internals that are not content to migrate.
const WP_SKIP = /^(attachment|wp_block|wp_template|wp_template_part|wp_navigation|nav_menu_item|wp_global_styles|wp_font_family|wp_font_face|revision|customize_changeset|oembed_cache|user_request|custom_css|elementor_library|e-landing-page|acf-field|acf-field-group|wpcf7_contact_form|shop_order|shop_coupon)$/;
const WP_TAX_SKIP = /^(nav_menu|wp_theme|wp_template_part_area|wp_pattern_category|link_category|post_format|product_shipping_class|product_visibility)$/;

async function getJson(url, opts) {
  const r = await safeFetch(url, { ...opts, accept: 'application/json', maxBytes: 2 * 1024 * 1024 });
  if (r.status >= 400) return { status: r.status, json: null, headers: r.headers };
  try { return { status: r.status, json: JSON.parse(r.body.toString('utf8')), headers: r.headers }; } catch { return { status: r.status, json: null, headers: r.headers }; }
}
const totalOf = h => { const n = Number(h?.['x-wp-total']); return Number.isFinite(n) ? n : null; };

// The public WordPress REST API reports exact totals per post type in X-WP-Total.
// Read only, one request per type, and only what robots.txt allows.
export async function probeWordPress(origin, { allowed = () => true, timeoutMs = 15000, signal, maxTypes = 30 } = {}) {
  const base = origin.replace(/\/$/, '') + '/wp-json/wp/v2';
  if (!allowed(base + '/types')) return { source: 'wp-rest', available: false, reason: 'The REST API is disallowed by robots.txt' };
  const opts = { timeoutMs, signal };
  let types;
  try { types = await getJson(base + '/types', opts); } catch (e) { return { source: 'wp-rest', available: false, reason: e.message }; }
  if (!types.json || typeof types.json !== 'object') return { source: 'wp-rest', available: false, reason: `REST API not public (HTTP ${types.status})` };
  const out = { source: 'wp-rest', available: true, types: [], taxonomies: [], media: null, users: null };
  const list = Object.entries(types.json).filter(([slug, t]) => !WP_SKIP.test(slug) && t?.rest_base).slice(0, maxTypes);
  for (const [slug, t] of list) {
    try {
      const r = await getJson(`${base}/${t.rest_base}?per_page=1&_fields=id`, opts);
      out.types.push({ slug, name: t.name || slug, restBase: t.rest_base, total: r.status < 400 ? totalOf(r.headers) : null, hierarchical: !!t.hierarchical });
    } catch (e) { if (e.code === 'cancelled') throw e; out.types.push({ slug, name: t.name || slug, restBase: t.rest_base, total: null, error: e.message }); }
  }
  try { const m = await getJson(`${base}/media?per_page=1&_fields=id`, opts); out.media = m.status < 400 ? totalOf(m.headers) : null; } catch (e) { if (e.code === 'cancelled') throw e; }
  try {
    const tx = await getJson(base + '/taxonomies', opts);
    for (const [slug, t] of Object.entries(tx.json || {}).filter(([s, t]) => !WP_TAX_SKIP.test(s) && t?.rest_base).slice(0, 15)) {
      try { const r = await getJson(`${base}/${t.rest_base}?per_page=1&_fields=id`, opts); out.taxonomies.push({ slug, name: t.name || slug, total: r.status < 400 ? totalOf(r.headers) : null, types: t.types || [] }); }
      catch (e) { if (e.code === 'cancelled') throw e; }
    }
  } catch (e) { if (e.code === 'cancelled') throw e; }
  if (!out.types.some(t => t.total !== null)) return { ...out, available: false, reason: 'The REST API did not report totals' };
  return out;
}

const pct = (n, d) => d ? Math.round(n / d * 100) : 0;

// Roll page level detections up to the site.
export function buildInsights(pages, { templates = [], cmsCounts = null } = {}) {
  const ok = pages.filter(p => p && !p.error);
  const n = ok.length;
  const cmsVotes = {}; const fw = {}; const integ = {}; const langs = {}; const hreflang = new Set(); const comps = new Map();
  for (const p of ok) {
    for (const c of p.tech?.cms || []) { const v = cmsVotes[c.id] || (cmsVotes[c.id] = { id: c.id, name: c.name, pages: 0, strong: false, evidence: c.evidence }); v.pages++; if (c.strong) { v.strong = true; v.evidence = c.evidence; } }
    for (const f of p.tech?.frameworks || []) fw[f.id] = fw[f.id] || { ...f, pages: 0 }, fw[f.id].pages++;
    for (const i of p.tech?.integrations || []) { integ[i.id] = integ[i.id] || { ...i, pages: 0, categoryName: INTEGRATION_CATEGORIES[i.category] || i.category }; integ[i.id].pages++; }
    if (p.languages?.lang) langs[p.languages.lang] = (langs[p.languages.lang] || 0) + 1;
    for (const a of p.languages?.alternates || []) hreflang.add(a.code);
    for (const s of p.sections || []) { const c = comps.get(s.sig) || { ...s, pages: 0 }; c.pages++; comps.set(s.sig, c); }
  }
  const cmsList = Object.values(cmsVotes).sort((a, b) => (b.strong - a.strong) || (b.pages - a.pages));
  const top = cmsList[0] || null;
  const cms = top ? { id: top.id, name: top.name, confidence: top.strong || pct(top.pages, n) >= 60 ? 'high' : pct(top.pages, n) >= 25 ? 'medium' : 'low', evidence: `${top.evidence}; seen on ${top.pages} of ${n} inspected pages` } : null;
  // languages: hreflang alternates are the strongest evidence of a multilingual site
  const baseCodes = new Set([...hreflang].map(c => c.split('-')[0]));
  const pageLangs = Object.keys(langs);
  const codes = baseCodes.size ? [...baseCodes] : pageLangs;
  const languages = { codes: codes.sort(), count: Math.max(codes.length, 1), hreflang: [...hreflang].sort(), pageLangs: langs, evidence: baseCodes.size ? `hreflang alternates on inspected pages: ${[...hreflang].slice(0, 8).join(', ')}` : pageLangs.length ? `html lang attribute: ${pageLangs.join(', ')}` : 'no language markers' };
  // components: section signatures seen on inspected pages, ignoring bare text sections
  const all = [...comps.values()].filter(c => c.flags.length || c.pages >= 2);
  const components = {
    count: all.length, interactive: all.filter(c => c.interactive).length, standard: all.filter(c => !c.interactive).length,
    list: all.sort((a, b) => b.pages - a.pages).slice(0, 60).map(c => ({ sig: c.sig, type: c.type, flags: c.flags, interactive: c.interactive, pages: c.pages })),
    basis: `${all.length} distinct section patterns across ${n} inspected pages (same section type and shape counted once)`,
  };
  const tpl = { count: templates.length, advanced: templates.filter(t => (t.blockTypes || []).length >= 6 || t.category === 'L1').length, list: templates.slice(0, 30) };
  return {
    pagesInspected: n, cms, cmsCandidates: cmsList.slice(0, 4).map(c => ({ id: c.id, name: c.name, pages: c.pages })),
    frameworks: Object.values(fw).sort((a, b) => b.pages - a.pages),
    integrations: Object.values(integ).sort((a, b) => a.category.localeCompare(b.category) || b.pages - a.pages),
    languages, components, templates: tpl, cmsCounts,
  };
}

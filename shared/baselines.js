// Hour baselines from logged time (Clockify). Clockify entries carry a project, a free text
// description, a person, a "Task Category" and hours, but no quantities. So baselines are best
// guesstimates: each rule finds the work that matches a deliverable, treats one description (or
// one project) as one unit, and takes a percentile of the hours per unit. Every proposal says
// how it was derived, how many units it rests on, and how confident it is. Nothing here
// overwrites hours a person entered.
import { parseCsv } from './sitelist.js';
import { ROLE_IDS } from './plan.js';

// Clockify user group -> studio role. Leads take precedence over the plain groups.
export function roleFromGroups(groupNames = []) {
  const g = groupNames.map(s => String(s).trim().toLowerCase());
  const has = re => g.some(x => re.test(x));
  if (has(/^dev(eloper)?s? leads?$|^tech(nical)? leads?$/)) return { role: 'lead', lead: true };
  if (has(/^project managers?$|^pms?$/)) return { role: 'pm', lead: false };
  if (has(/^design leads?$/)) return { role: 'design', lead: true };
  if (has(/^designers?$/)) return { role: 'design', lead: false };
  if (has(/^developers?$/)) return { role: 'dev', lead: false };
  return null;
}

const INTERNAL_CLIENT = /^(anyday|midday)\b|anyday \/ midday/i;
const r2 = v => Math.round(v * 4) / 4; // quarter hours

// ---- normalising inputs ------------------------------------------------------
// Clockify detailed report CSV export (Project, Client, Description, User, Group, Duration (decimal), Task Category …)
export function entriesFromCsv(text, { roleOf = null } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  const col = name => head.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const c = { project: col('Project'), client: col('Client'), desc: col('Description'), user: col('User'), group: col('Group'), hours: col('Duration (decimal)'), cat: col('Task Category'), date: col('Start Date'), cost: col('Cost Rate (CAD)'), task: col('Task') };
  if (c.hours < 0 || c.user < 0) throw new Error('This does not look like a Clockify detailed report export (no User or Duration (decimal) column).');
  return rows.slice(1).map(r => {
    const groups = c.group >= 0 ? (r[c.group] || '').split(/,\s*/).filter(Boolean) : [];
    const mapped = roleOf?.(r[c.user]) || roleFromGroups(groups);
    return {
      project: r[c.project] || '', client: c.client >= 0 ? r[c.client] || '' : '', description: r[c.desc] || '', task: c.task >= 0 ? r[c.task] || '' : '',
      user: r[c.user] || '', role: mapped?.role || null, hours: Number(r[c.hours]) || 0,
      categories: c.cat >= 0 ? splitCategories(r[c.cat]) : [], date: c.date >= 0 ? r[c.date] : '',
      costRate: c.cost >= 0 && r[c.cost] !== '' ? Number(r[c.cost]) : null,
    };
  });
}

// Clockify reports API (detailed report "timeentries")
export function entriesFromReport(timeentries, { roleOfUserId = () => null, categoryField = 'Task Category', customFieldNames = {} } = {}) {
  return (timeentries || []).map(e => {
    const cf = (e.customFields || e.customFieldValues || []).find(f => (f.name || customFieldNames[f.customFieldId] || '') === categoryField);
    const v = cf ? (Array.isArray(cf.value) ? cf.value.join(', ') : cf.value) : '';
    return {
      project: e.projectName || '', client: e.clientName || '', description: e.description || '', task: e.taskName || '',
      user: e.userName || '', userId: e.userId || '', role: roleOfUserId(e.userId)?.role || null,
      hours: durationHours(e.timeInterval?.duration), categories: splitCategories(v), date: e.timeInterval?.start || '',
    };
  });
}

export function durationHours(d) {
  if (typeof d === 'number') return d / 3600;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(d || ''));
  return m ? (Number(m[1] || 0) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600) : 0;
}

// Categories are comma separated, but some category names contain commas ("QA, Feedback & Remediation").
const KNOWN_CATS = ['QA, Feedback & Remediation', 'Integrations, Forms & Tracking', 'Infrastructure, Deployment & Security', 'Launch, SEO & Redirects', 'Documentation, Training & Enablement', 'Discovery, Requirements & Scoping', 'Commercial, Legal & Proposals'];
export function splitCategories(s) {
  let rest = String(s || '').trim(); if (!rest) return [];
  const out = [];
  for (const k of KNOWN_CATS) if (rest.includes(k)) { out.push(k); rest = rest.split(k).join('|'); }
  for (const p of rest.split(/\s*[|,]\s*/)) if (p.trim()) out.push(p.trim());
  return out;
}

// ---- statistics -------------------------------------------------------------
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const PICK = { p25: 0.25, median: 0.5, p75: 0.75, p90: 0.9 };

// Remediation work (fixes, QA rounds, tweaks) is excluded from build rules, so a baseline for
// building something is not diluted by small follow up tasks on it.
const FIX = /\bfix|bug|issue|tweak|adjust|broken|error|qa\b|feedback|revision|polish|cleanup|clean up|update|minor|small change|hotfix|debug/;
const REMEDIATION_ONLY = cs => cs.length > 0 && cs.every(c => /^(QA|Debugging|Maintenance|Performance)/.test(c));

function units(entries, { match, cat, roles, unit, projects, build = true }) {
  const m = new Map();
  for (const e of entries) {
    if (build && (FIX.test(e.description.toLowerCase()) || REMEDIATION_ONLY(e.categories))) continue;
    if (!e.role || e.hours <= 0) continue;
    if (roles && !roles.includes(e.role)) continue;
    if (projects && !projects(e)) continue;
    const d = e.description.toLowerCase();
    if (match && !match.test(d)) continue;
    if (cat && !e.categories.some(c => cat.test(c))) continue;
    const key = unit === 'project' ? `${e.client}|${e.project}` : `${e.client}|${e.project}|${d.replace(/\s+/g, ' ').trim()}`;
    const u = m.get(key) || { key, hours: 0, byRole: {} };
    u.hours += e.hours; u.byRole[e.role] = (u.byRole[e.role] || 0) + e.hours;
    m.set(key, u);
  }
  return [...m.values()].filter(u => u.hours >= 0.25);
}

// ---- rules: deliverable -> evidence -----------------------------------------
const R = {
  design: /design|figma|mockup|wireframe|prototype|\bui\b|\bux\b|visual|layout/,
  brand: /brand|style ?guide|guideline|design system|typograph|colou?r|moodboard|visual direction|re-?skin|look and feel/,
  component: /components?\b|\bblocks?\b|\bsections?\b|\bnav\b|\bmenu\b|header|footer|\bhero\b|carousel|slider|accordion|\bcards?\b|banner|\bmodal\b|popup/,
  page: /\bpages?\b|homepage|landing/,
  template: /template|detail page|single|listing|archive|\bpdp\b|\bplp\b/,
  schema: /schema|document type|content model|post type|content type/,
  form: /\bforms?\b|hubspot|pardot|mailchimp|newsletter|web-to-lead|gravity/,
  crm: /hubspot|pardot|salesforce|sfdc|crm|mailchimp|klaviyo/,
  newsletter: /newsletter|mailchimp|klaviyo|subscribe/,
  seo: /\bseo\b|metadata|meta tags?|schema markup|structured data|sitemap|open ?graph/,
  redirect: /redirect/,
  migration: /migrat|import|scrap|content entry|populate|move content|transfer content/,
  search: /\bsearch\b|algolia|typesense|elastic/,
  analytics: /analytics|\bgtm\b|tag manager|\bga4\b|tracking|pixel|hotjar/,
  integration: /\bapi\b|integrat|webhook|\bsync\b|endpoint|connector/,
  webhook: /webhook/,
  data: /\bdata\b|feed|sync|import|etl|csv/,
  translation: /translat|locali[sz]|french|language|i18n|multilingual|weglot|smartling/,
  commerce: /shop|shopify|commerce|cart|checkout|product|woocommerce|stripe/,
  auth: /login|sign ?in|auth|portal|member|account|dashboard|sso|gated/,
  tool: /\btool\b|calculator|\bapp\b|booking|quiz|configurator|finder|mvp/,
  cleanup: /clean ?up|cleanup|normali[sz]|tidy|broken link|duplicate content/,
  setup: /set ?up|setup|activation|deploy|launch|domain|dns|vercel|config|go-live|go live|provision|environment/,
  platform: /platform|studio|infrastructure|architecture|monorepo|boilerplate|starter|sdk|multisite|multi-site/,
  review: /feedback|review|revision|iteration|refine|tweaks?|changes/,
};
const CATS = {
  design: /^Design & Prototyping$/, frontend: /^Frontend Components/, buildout: /^Site Buildout/, integ: /^Integrations, Forms/,
  migration: /^Content Migration/, launch: /^Launch, SEO/, cms: /^CMS Platform/, infra: /^Infrastructure/, perf: /^Performance/, access: /^Accessibility/,
};

// Projects that are one site of a multi site client (i.e. VOS clinic sites): a client with five
// or more projects, excluding the umbrella project named like the client.
function siteProjectsOf(entries) {
  const byClient = new Map();
  for (const e of entries) { if (!e.client) continue; if (!byClient.has(e.client)) byClient.set(e.client, new Set()); byClient.get(e.client).add(e.project); }
  const keys = new Set();
  for (const [client, ps] of byClient) {
    if (ps.size < 5) continue;
    const cl = client.toLowerCase();
    for (const p of ps) { const pl = p.toLowerCase(); if (pl === cl || pl.includes(cl) || cl.includes(pl)) continue; keys.add(`${client}|${p}`); }
  }
  return e => keys.has(`${e.client}|${e.project}`);
}

// Rule table. pick: which percentile of hours per unit. mode: perUnit (× quantity) or setup (fixed).
function rulesFor(sites) {
  const D = ['design'], DEV = ['dev', 'lead'];
  return [
    { items: ['DESIGN_DIRECTION'], match: R.brand, roles: D, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'design hours per project on brand, style and design system work' },
    { items: ['DESIGN_COMPONENTS'], match: R.component, roles: D, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'design hours per component task' },
    { items: ['DESIGN_PAGE_LAYOUTS'], match: R.page, roles: D, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'design hours per page or layout task' },
    { items: ['DESIGN_REVIEWS'], match: R.review, roles: D, unit: 'desc', build: false, pick: 'median', mode: 'perUnit', basis: 'design hours per feedback or revision round' },
    { items: ['BASE_CORE_PLATFORM'], cat: /^(Site Buildout|CMS Platform|Infrastructure)/, roles: DEV, unit: 'project', pick: 'p75', mode: 'perUnit', min: 3, projectMin: 60, basis: 'developer hours per large project on site buildout, CMS platform and infrastructure (upper quartile)' },
    { items: ['BASE_STD_PAGE_TEMPLATE'], match: R.template, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per page template task' },
    { items: ['BASE_ADV_PAGE_TEMPLATE'], match: R.template, roles: DEV, unit: 'desc', pick: 'p75', mode: 'perUnit', basis: 'developer hours per page template task (upper quartile)' },
    { items: ['BASE_STD_COMPONENT'], match: R.component, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per component task' },
    { items: ['BASE_ADV_COMPONENT'], match: R.component, roles: DEV, unit: 'desc', pick: 'p90', mode: 'perUnit', basis: 'developer hours per component task (top 10%)' },
    { items: ['BASE_STRUCT_CONTENT_MODEL'], match: R.schema, roles: DEV, unit: 'desc', pick: 'p75', mode: 'perUnit', basis: 'developer hours per schema or content type task (upper quartile)' },
    { items: ['BASE_STD_BRAND_CONTROLS', 'BASE_GLOBAL_DESIGN_CONTROL'], match: R.brand, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per brand, theme or design system task' },
    { items: ['BASE_ADV_BRAND_CONTROLS'], match: R.brand, roles: DEV, unit: 'desc', pick: 'p90', mode: 'perUnit', basis: 'developer hours per brand, theme or design system task (top 10%)' },
    { items: ['BASE_SHARED_INTEGRATION_EXISTING', 'BASE_ENDPOINT', 'MIG_API_SETUP'], match: R.integration, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per integration task' },
    { items: ['BASE_SHARED_INTEGRATION_NEW', 'BASE_NEW_SIMPLE_API'], match: R.integration, roles: DEV, unit: 'project', pick: 'p75', mode: 'perUnit', basis: 'developer hours per project on integration work (upper quartile)' },
    { items: ['BASE_NEW_ADV_API', 'BASE_COMPLEX_SYNC_SOURCE'], match: R.integration, roles: DEV, unit: 'project', pick: 'p90', mode: 'perUnit', basis: 'developer hours per project on integration work (top 10%)' },
    { items: ['BASE_WEBHOOK'], match: R.webhook, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', min: 3, basis: 'developer hours per webhook task', fallback: 'BASE_ENDPOINT' },
    { items: ['BASE_DATA_SOURCE', 'BASE_DATA_MAPPING', 'BASE_SCHEDULED_SYNC', 'MIG_DATA_SOURCE_SETUP'], match: R.data, cat: CATS.integ, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per data or sync task' },
    { items: ['BASE_SITE_SEARCH', 'MIG_SEARCH_SETUP'], match: R.search, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on search' },
    { items: ['BASE_FACETED_SEARCH', 'BASE_EXTERNAL_SEARCH', 'BASE_SEARCH_INDEX', 'BASE_MULTI_CONTENT_SEARCH'], match: R.search, roles: DEV, unit: 'project', pick: 'p75', mode: 'perUnit', basis: 'developer hours per project on search (upper quartile)' },
    { items: ['BASE_TRANSLATION_INTEGRATION', 'BASE_LOCALIZATION_ARCH'], match: R.translation, roles: DEV, unit: 'project', pick: 'p75', mode: 'perUnit', basis: 'developer hours per project on translation (upper quartile)' },
    { items: ['MIG_ENABLE_TRANSLATION', 'MIG_LOCALIZATION', 'MIG_LANGUAGE', 'MIG_LOCALE_NAV', 'MIG_LOCALE_RULES', 'MIG_REGION_VARIATION'], match: R.translation, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per translation task' },
    { items: ['BASE_ECOMMERCE_SIMPLE', 'MIG_ECOMMERCE_SETUP'], match: R.commerce, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on shop work' },
    { items: ['BASE_ECOMMERCE_PLATFORM', 'BASE_PRODUCT_CATALOG', 'BASE_FULL_COMMERCE'], match: R.commerce, roles: DEV, unit: 'project', pick: 'p90', mode: 'perUnit', basis: 'developer hours per project on shop work (top 10%)' },
    { items: ['BASE_GATED_RESOURCE', 'BASE_REG_GATE', 'BASE_CRM_GATE', 'BASE_ROLE_GATE', 'MIG_MEMBER_DIRECTORY', 'MIG_GATED_CONTENT_SETUP'], match: R.auth, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per login, member or gated content task' },
    { items: ['BASE_AUTH_AREA', 'BASE_USER_PROFILES', 'BASE_ROLE_PERMISSIONS', 'BASE_IDP'], match: R.auth, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on login and member features' },
    { items: ['BASE_DASHBOARD', 'BASE_COMPLEX_PORTAL'], match: R.auth, roles: DEV, unit: 'project', pick: 'p75', mode: 'perUnit', basis: 'developer hours per project on portal work (upper quartile)' },
    { items: ['BASE_SIMPLE_TOOL'], match: R.tool, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on tools and apps' },
    { items: ['BASE_DATA_APP'], match: R.tool, roles: DEV, unit: 'project', pick: 'p90', mode: 'perUnit', basis: 'developer hours per project on tools and apps (top 10%)' },
    { items: ['MIG_SITE_ACTIVATION'], match: R.setup, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', projects: sites, min: 3, basis: 'developer hours per clinic site on setup, configuration, deployment and launch' },
    { items: ['MIG_BRAND_CONFIG'], roles: D, unit: 'project', pick: 'median', mode: 'perUnit', projects: sites, min: 3, basis: 'design hours per clinic site' },
    { items: ['MIG_L1_PAGE'], match: R.page, roles: DEV, unit: 'desc', pick: 'p75', mode: 'perUnit', basis: 'developer hours per page task (upper quartile)' },
    { items: ['MIG_L2_PAGE'], match: R.page, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per page task' },
    { items: ['MIG_L3_PAGE'], match: R.page, roles: DEV, unit: 'desc', pick: 'p25', mode: 'perUnit', basis: 'developer hours per page task (lower quartile)' },
    { items: ['MIG_CONTENT_TYPE_MAP', 'MIG_FIELD_NORMALIZE'], match: R.migration, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per content migration task' },
    { items: ['MIG_BASIC_CLEANUP', 'MIG_URL_NORMALIZE'], match: R.cleanup, roles: DEV, unit: 'project', build: false, pick: 'median', mode: 'perUnit', basis: 'developer hours per project on content cleanup' },
    { items: ['MIG_STANDARD_FORM'], match: R.form, roles: DEV, unit: 'desc', pick: 'median', mode: 'perUnit', basis: 'developer hours per form task' },
    { items: ['MIG_ADV_FORM'], match: R.form, roles: DEV, unit: 'desc', pick: 'p75', mode: 'perUnit', basis: 'developer hours per form task (upper quartile)' },
    { items: ['MIG_CRM_SETUP'], match: R.crm, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on CRM work' },
    { items: ['MIG_NEWSLETTER'], match: R.newsletter, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', min: 3, basis: 'developer hours per project on newsletter work', fallback: 'MIG_CRM_SETUP' },
    { items: ['MIG_ANALYTICS'], match: R.analytics, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on analytics and tracking' },
    { items: ['MIG_SEO_METADATA'], match: R.seo, roles: DEV, unit: 'project', pick: 'median', mode: 'perUnit', basis: 'developer hours per project on SEO and metadata' },
  ];
}

// Volume items Clockify cannot measure (no counts logged): planning assumptions, clearly labelled.
const ASSUMPTIONS = [
  { id: 'MIG_BULK_STATIC', perUnit: { dev: 0.1 }, basis: 'Assumption: about 6 minutes per near identical page migrated in bulk. Clockify has no page counts.' },
  { id: 'MIG_STRUCTURED_RECORDS', perUnit: { dev: 0.02 }, basis: 'Assumption: scripted migration, about 1 minute per record including spot checks. Clockify has no record counts.' },
  { id: 'MIG_MEDIA', perUnit: { dev: 0.005 }, basis: 'Assumption: scripted media transfer, about 20 seconds per asset. Clockify has no asset counts.' },
  { id: 'MIG_REDIRECTS', perUnit: { dev: 0.01 }, basis: 'Assumption: mapped in bulk, under a minute per redirect. Clockify has no redirect counts.' },
  { id: 'MIG_HTML_CLEANUP', perUnit: { dev: 0.01 }, basis: 'Assumption: scripted cleanup, under a minute per record.' },
  { id: 'MIG_METADATA_CLEANUP', perUnit: { dev: 0.01 }, basis: 'Assumption: scripted cleanup, under a minute per record.' },
];

// Project management share: hours in "Program Management & Collaboration" over all client hours.
function pmRatio(entries) {
  let pm = 0, all = 0;
  for (const e of entries) { all += e.hours; if (e.categories.some(c => /^Program Management|^Client Communication/.test(c))) pm += e.hours; }
  return all ? pm / all : 0.08;
}

export function computeBaselines(rawEntries, library, { includeIds = null } = {}) {
  const entries = rawEntries.filter(e => e.client && !INTERNAL_CLIENT.test(e.client) && !e.categories.some(c => /^Internal/.test(c)));
  const items = Object.fromEntries((library?.items || []).map(i => [i.id, i]));
  const sites = siteProjectsOf(entries);
  const pmShare = Math.min(0.2, pmRatio(entries));
  const out = {};
  const people = new Set(entries.map(e => e.user));
  for (const rule of rulesFor(sites)) {
    let us = units(entries, rule);
    if (rule.projectMin) us = us.filter(u => u.hours >= rule.projectMin);
    const n = us.length;
    if (n < (rule.min || 5)) continue;
    const sorted = us.map(u => u.hours).sort((a, b) => a - b);
    const H = pct(sorted, PICK[rule.pick]);
    const total = us.reduce((a, u) => a + u.hours, 0);
    const share = Object.fromEntries(ROLE_IDS.map(r => [r, us.reduce((a, u) => a + (u.byRole[r] || 0), 0) / (total || 1)]));
    const hours = {};
    for (const r of ROLE_IDS) if (r !== 'pm' && share[r] > 0.02) hours[r] = r2(H * share[r]);
    const work = Object.values(hours).reduce((a, b) => a + b, 0);
    if (work > 0 && pmShare > 0) hours.pm = r2(Math.max(0.25, work * pmShare / (1 - pmShare)));
    const range = { low: Math.round(pct(sorted, 0.25) * 10) / 10, high: Math.round(pct(sorted, 0.75) * 10) / 10 };
    for (const id of rule.items) {
      if (!items[id] || out[id]) continue;
      out[id] = {
        id, effort: { [rule.mode]: hours }, method: 'clockify', unit: rule.unit, samples: n, range,
        confidence: n >= 15 && rule.unit === 'desc' ? 'medium' : n >= 8 ? 'medium' : 'low',
        basis: `${pickLabel(rule.pick)} of ${rule.basis}: ${fmt(H)}h across ${n} ${rule.unit === 'project' ? (rule.projects ? 'sites' : 'projects') : 'tasks'} (middle half ${fmt(range.low)} to ${fmt(range.high)}h). Project management added at ${Math.round(pmShare * 100)}% of hours.`,
      };
    }
  }
  // rules whose evidence was too thin fall back to a related deliverable
  for (const rule of rulesFor(sites)) if (rule.fallback) for (const id of rule.items) if (items[id] && !out[id] && out[rule.fallback]) {
    out[id] = { ...out[rule.fallback], id, method: 'analogy', confidence: 'low', basis: `Too few matching entries; uses ${items[rule.fallback]?.name || rule.fallback}. ${out[rule.fallback].basis}` };
  }
  for (const a of ASSUMPTIONS) if (items[a.id] && !out[a.id]) out[a.id] = { id: a.id, effort: { perUnit: a.perUnit }, method: 'assumption', confidence: 'low', samples: 0, basis: a.basis };
  // anything still missing: closest item in the same subcategory, else hours needed
  for (const it of library?.items || []) {
    if (out[it.id] || it.pricing.model === 'included' && !/CLEANUP/.test(it.id)) continue;
    const sib = (library.items || []).find(x => x.id !== it.id && x.subcategory === it.subcategory && out[x.id] && out[x.id].method === 'clockify');
    if (sib) out[it.id] = { ...out[sib.id], id: it.id, method: 'analogy', confidence: 'low', basis: `No direct evidence; uses ${sib.name}. ${out[sib.id].basis}` };
  }
  const proposals = Object.values(out).filter(p => !includeIds || includeIds.includes(p.id));
  return {
    proposals,
    summary: {
      entries: entries.length, hours: Math.round(entries.reduce((a, e) => a + e.hours, 0)), people: people.size,
      projects: new Set(entries.map(e => `${e.client}|${e.project}`)).size, pmShare: Math.round(pmShare * 1000) / 10,
      categorised: Math.round(100 * entries.filter(e => e.categories.length).reduce((a, e) => a + e.hours, 0) / (entries.reduce((a, e) => a + e.hours, 0) || 1)),
      missing: (library?.items || []).filter(i => !out[i.id] && i.pricing.model !== 'included').map(i => i.id),
    },
  };
}
const pickLabel = p => ({ p25: 'Lower quartile', median: 'Median', p75: 'Upper quartile', p90: 'Top 10%' }[p]);
const fmt = v => (Math.round(v * 10) / 10).toLocaleString('en-US');

// Apply proposals to a library. Never replaces hours a person set: only empty effort or an
// earlier Clockify baseline is replaced. Returns { library, applied: [ids], skipped: [ids] }.
export function applyBaselines(library, proposals, { at = new Date().toISOString(), ids = null } = {}) {
  const byId = Object.fromEntries(proposals.map(p => [p.id, p]));
  const applied = []; const skipped = [];
  const items = library.items.map(it => {
    const p = byId[it.id]; if (!p || (ids && !ids.includes(it.id))) return it;
    const cur = it.effort || {};
    const isSet = ROLE_IDS.some(r => cur.setup?.[r] != null || cur.perUnit?.[r] != null);
    if (isSet && cur.source !== 'baseline') { skipped.push(it.id); return it; }
    applied.push(it.id);
    const empty = Object.fromEntries(ROLE_IDS.map(r => [r, null]));
    return { ...it, effort: { ...cur, setup: { ...empty, ...(p.effort.setup || {}) }, perUnit: { ...empty, ...(p.effort.perUnit || {}) }, source: 'baseline', baseline: { method: p.method, confidence: p.confidence, samples: p.samples, basis: p.basis, at } } };
  });
  return { library: { ...library, items }, applied, skipped };
}

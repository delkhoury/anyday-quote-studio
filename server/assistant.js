// Quote assistant: Claude reads a brief (text, PDF, Word, images) and builds the quote with
// tools that act on it directly: project setup, site types, website analysis, deliverables and
// quantities, component treatments, proposal text and first pass Plan hours.
// Every turn saves a restore point first, so a turn can be undone in one click.
import fs from 'node:fs';
import path from 'node:path';
import { calculateQuote } from '../shared/pricing.js';
import { applyFoundation, quoteTypes, quoteTypeOf } from '../shared/quote.js';
import { summarize, mergeScan, portfolioSummary, proposeQuantities, applyProposals } from '../shared/inventory.js';
import { ROLE_IDS, PHASES, emptyPlan, planRows } from '../shared/plan.js';
import { describePricing } from '../shared/pricing.js';

export function assistantConfig(env = process.env) {
  return { apiKey: env.ANTHROPIC_API_KEY || '', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', enabled: !!env.ANTHROPIC_API_KEY };
}

const MAX_STEPS = 40;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const CATEGORY_KEYS = ['L1', 'L2', 'L3', 'BULK_STATIC', 'RECORD', 'ARCHIVE'];
const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// ---- prompt ------------------------------------------------------------------
function catalogue(quote) {
  const items = quote.pricingSnapshot.items;
  return items.map(i => [
    i.id, i.name, `${i.section}${i.isDesign ? '/design' : ''}`, `per ${i.pricing.qtyUnit}`,
    i.pricing.model === 'included' ? 'included' : (i.pricing.status === 'unpriced' ? 'price needed' : describePricing(i.pricing).replace(/Progressive volume pricing: /, 'tiers: ')),
    i.quantitySource ? 'quantity computed automatically' : '',
    trim(i.what, 220),
  ].filter(Boolean).join(' | ')).join('\n');
}

export function systemPrompt(quote, { foundations = [] } = {}) {
  const types = quoteTypes(quote.pricingSnapshot).map(t => `- ${t.id}: ${t.name}. ${t.description} Foundation ${t.usesFoundation}.`).join('\n');
  const fnd = foundations.filter(f => !f.archived).map(f => `- ${f.id}: ${f.name}${f.owner ? ` (${f.owner})` : ''}, ${f.components.length} components${f.complete ? '' : ' (component list incomplete)'}. ${trim(f.description, 160)}`).join('\n') || '- none yet';
  return `You are the quoting assistant inside Anyday Quote Studio. Anyday is a Toronto WebOps agency that designs and builds unified headless CMS platforms (Next.js, Sanity, Vercel) for multi brand enterprises.

Your job: from a project brief or a conversation, build the quote in the studio yourself, using the tools. Changes apply to the quote immediately; the user can undo a whole turn. Work through it end to end without asking permission for each step:
1. Read the brief. Call get_quote_state first.
2. Set up the project: client, parent organisation, project name, main URL, quote type, and a foundation when the work reuses one.
3. For multi site work, set site types with counts and one or two sample URLs each; give typical per site figures for types you cannot scan.
4. Analyse websites named in the brief with analyse_website (one call per site, main site first, at most 4 sites per turn), then apply_inventory_quantities so migration volumes come from real URLs.
5. Choose every deliverable with set_lines: included lines with exact quantities, optional lines for credible upsells, hidden lines for anything irrelevant. Give a short concrete reason for every included line, citing the brief or the scan.
6. On a foundation quote, set component treatments (brand, redesign, extend, new, not_used) from what the brief asks for.
7. Write the proposal: a two paragraph introduction, assumptions for every guess you made, exclusions.
8. Add first pass Plan hours for included lines that need hours (set_plan_hours), by role: design, dev, pm, lead.
9. Call get_pricing_summary, then finish with a short summary: what you set, the total, and the open questions the brief did not answer.

Rules:
- Use only item ids from the catalogue below. Never set prices; prices come from the Pricing Library. Items marked "price needed" stay unpriced and you say so.
- Quantities must be defensible. Prefer scan results over guesses. When you estimate, say so in the reason and add an assumption.
- Charge content once: a URL is a Level 1, 2 or 3 page, a bulk static page, or a structured record, never two of these. Generated archives (tags, categories, authors) are not charged.
- Redirects: a planning allowance, usually the number of URLs whose path will change.
- Media: apply_inventory_quantities proposes an allowance estimated from the scan (media per inspected page × included URLs, or the image sitemap). It is an estimate until a CMS media export is imported; say so in an assumption.
- Items whose quantity is computed automatically (i.e. Component design) only need to be included.
- On a foundation quote, do not include the core platform or brand control build items; the foundation provides them.
- If the brief is too thin to quote, still build the best first draft, state the assumptions, and list the questions.
- Writing style for anything client facing (introduction, assumptions, exclusions, reasons): plain, specific, Canadian English spelling, no em dashes, use "i.e." and never "e.g.".
- Keep chat replies short. The quote itself is the deliverable.

Quote types:
${types}

Foundations:
${fnd}

Pricing Library catalogue (id | name | section | unit | price | notes | what it is):
${catalogue(quote)}`;
}

// ---- tools ---------------------------------------------------------------------
const roleHours = { type: 'object', properties: Object.fromEntries(ROLE_IDS.map(r => [r, { type: 'number', minimum: 0 }])), additionalProperties: false };
export const TOOLS = [
  { name: 'get_quote_state', description: 'Current state of the quote: setup, foundation, site types, inventory, included lines, totals, open issues.', input_schema: { type: 'object', properties: {} } },
  { name: 'set_project_details', description: 'Set client and project details, the quote type and the foundation. Only the fields given change.', input_schema: { type: 'object', properties: {
    client: { type: 'string' }, parentOrg: { type: 'string' }, contact: { type: 'string' }, project: { type: 'string' }, url: { type: 'string' },
    type: { type: 'string', enum: ['new_platform', 'foundation_site', 'expansion'] }, foundationId: { type: 'string', description: "A foundation id, or 'none' to remove the foundation" }, existingLiveSites: { type: 'integer', minimum: 0 } } } },
  { name: 'set_site_types', description: 'Replace the site types of a multi site quote. Each has a name, a count, sample URLs to analyse, and optional typical per site figures (L1, L2, L3, BULK_STATIC, RECORD, ARCHIVE) used when no sample is analysed.', input_schema: { type: 'object', required: ['siteTypes'], properties: { siteTypes: { type: 'array', items: { type: 'object', required: ['name', 'count'], properties: {
    name: { type: 'string' }, count: { type: 'integer', minimum: 0 }, samples: { type: 'array', items: { type: 'string' } },
    perSite: { type: 'object', properties: Object.fromEntries(CATEGORY_KEYS.map(k => [k, { type: 'number', minimum: 0 }])) }, notes: { type: 'string' } } } } } } },
  { name: 'analyse_website', description: 'Scan a website (sitemaps plus a bounded page inspection) and merge its URLs into the inventory under a site type. Takes one to three minutes. Returns page, record and media counts for that site.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, siteType: { type: 'string', description: 'Site type name; defaults to the first' }, maxPages: { type: 'integer', minimum: 10, maximum: 200 } } } },
  { name: 'apply_inventory_quantities', description: 'Set migration quantities (site activation, page levels, records, content types, brand configuration) from the analysed inventory and site types. Returns what was applied.', input_schema: { type: 'object', properties: {} } },
  { name: 'set_lines', description: 'Include, offer as optional, or hide deliverables, with quantities and a reason. Lines not mentioned are unchanged.', input_schema: { type: 'object', required: ['lines'], properties: { lines: { type: 'array', items: { type: 'object', required: ['id', 'state'], properties: {
    id: { type: 'string' }, state: { type: 'string', enum: ['included', 'optional', 'hidden'] }, qty: { type: 'number', minimum: 0 }, optionalQty: { type: 'number', minimum: 0 }, reason: { type: 'string' } } } } } } },
  { name: 'set_component_treatments', description: 'On a foundation quote, set what happens to each foundation component: brand (branding only), redesign (visual redesign, same schema), extend (needs new fields or functionality), new, not_used.', input_schema: { type: 'object', required: ['components'], properties: { components: { type: 'array', items: { type: 'object', required: ['id', 'treatment'], properties: { id: { type: 'string' }, treatment: { type: 'string', enum: ['brand', 'redesign', 'extend', 'new', 'not_used'] }, note: { type: 'string' } } } } } } },
  { name: 'write_proposal', description: 'Write proposal text. Only the fields given change. assumptions and exclusions replace the current lists.', input_schema: { type: 'object', properties: { intro: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, exclusions: { type: 'array', items: { type: 'string' } }, timeline: { type: 'string' } } } },
  { name: 'set_plan_hours', description: 'First pass internal Plan hours for included deliverables, by role (design, dev, pm, lead): fixed hours and hours per unit. Stored on this quote only.', input_schema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, setup: roleHours, perUnit: roleHours, phase: { type: 'string', enum: PHASES }, note: { type: 'string' } } } } } } },
  { name: 'get_pricing_summary', description: 'Totals by section, total status, items blocking final export, and checks to review.', input_schema: { type: 'object', properties: {} } },
];

function quoteState(q) {
  const calc = calculateQuote(q);
  const pf = portfolioSummary(q);
  const s = summarize(q.inventory);
  const t = quoteTypeOf(q);
  return {
    type: q.type, typeName: t.name, client: q.client, project: q.project,
    foundation: q.foundation ? { id: q.foundation.id, name: q.foundation.name, components: q.foundation.components.map(c => `${c.id}:${c.treatment}`) } : null,
    siteTypes: pf.groups.map(g => ({ name: g.name, count: g.count, samples: (g.samples || []).map(x => x.url), basis: g.source, totals: g.totals })),
    existingLiveSites: q.portfolio?.existingLiveSites || 0,
    inventory: { urls: s.discovered, included: s.included, byCategory: s.byCategory, recordTypes: Object.entries(s.recordsByType).sort((a, b) => b[1] - a[1]).slice(0, 12), sites: s.sites, media: q.inventory?.media?.discovered ? { images: q.inventory.media.discovered.images?.unique, documents: q.inventory.media.discovered.documents?.unique } : null },
    included: calc.lines.filter(l => l.state === 'included').map(l => ({ id: l.id, qty: l.qty ?? null, amount: l.amount, note: l.line.aiNote || undefined })),
    total: calc.total, totalStatus: calc.totalStatus, blockers: calc.blockers.map(b => b.message).slice(0, 20),
    proposal: { intro: trim(q.proposal?.intro, 400), assumptions: q.proposal?.assumptions || [], exclusions: q.proposal?.exclusions || [] },
    planHoursNeeded: planRows(q, { calc }).filter(r => r.hoursNeeded).map(r => r.id),
  };
}

// Each tool returns { result (sent to Claude), summary (shown to the user) }.
function makeTools({ store, scan, signal, onProgress }) {
  return {
    get_quote_state: async (input, ctx) => ({ result: quoteState(ctx.q), summary: 'Read the quote' }),

    set_project_details: async (x, ctx) => {
      let q = ctx.q; const changed = [];
      if (x.foundationId !== undefined) {
        if (x.foundationId === null || x.foundationId === 'none') { q = { ...q, foundation: null }; changed.push('removed the foundation'); }
        else { const f = store.getFoundation(x.foundationId); q = applyFoundation(q, f); changed.push(`foundation ${f.name}`); }
      }
      if (x.type) {
        const t = quoteTypes(q.pricingSnapshot).find(y => y.id === x.type);
        if (!t) throw new Error(`Unknown quote type ${x.type}`);
        if (t.usesFoundation === 'required' && !q.foundation) throw new Error(`${t.name} needs a foundation. Set foundationId first.`);
        q = { ...q, type: x.type }; changed.push(t.name);
      }
      const client = { ...q.client }; const project = { ...q.project };
      const label = { parentOrg: 'parent organisation', contact: 'contact', project: 'project name', url: 'website' };
      for (const k of ['client', 'parentOrg', 'contact']) if (x[k] !== undefined) { client[k === 'client' ? 'name' : k] = String(x[k]).trim(); changed.push(k === 'client' ? `client ${x[k]}` : label[k]); }
      for (const k of ['project', 'url']) if (x[k] !== undefined) { project[k === 'project' ? 'name' : 'url'] = String(x[k]).trim(); changed.push(label[k]); }
      q = { ...q, client, project };
      if (x.existingLiveSites !== undefined) {
        q = { ...q, portfolio: { ...(q.portfolio || {}), existingLiveSites: x.existingLiveSites }, lines: { ...q.lines, MIG_SITE_ACTIVATION: { ...(q.lines.MIG_SITE_ACTIVATION || { state: 'included' }), priorQty: x.existingLiveSites } } };
        changed.push(`${x.existingLiveSites} live sites`);
      }
      ctx.q = q; await ctx.save();
      return { result: { ok: true, changed }, summary: `Set up the project: ${changed.join(', ') || 'no changes'}` };
    },

    set_site_types: async (x, ctx) => {
      const old = ctx.q.siteGroups || [];
      const byName = new Map(old.map(g => [g.name.trim().toLowerCase(), g]));
      const groups = x.siteTypes.map((t, i) => {
        const prev = byName.get(t.name.trim().toLowerCase()) || (i === 0 && old.length === 1 ? old[0] : null);
        return { id: prev?.id || 'type_' + Math.random().toString(36).slice(2, 8), name: t.name.trim(), count: t.count, samples: (t.samples || []).map(url => ({ url })), manual: t.perSite ? Object.fromEntries(CATEGORY_KEYS.map(k => [k, Number(t.perSite[k]) || 0])) : (prev?.manual || null), notes: t.notes || prev?.notes || '' };
      });
      if (!groups.length) throw new Error('At least one site type is needed');
      const keep = new Set(groups.map(g => g.id));
      const entries = (ctx.q.inventory?.entries || []).map(e => (keep.has(e.groupId) ? e : { ...e, groupId: groups[0].id }));
      ctx.q = { ...ctx.q, siteGroups: groups, inventory: { ...ctx.q.inventory, entries } };
      await ctx.save();
      const total = groups.reduce((a, g) => a + g.count, 0);
      return { result: { ok: true, siteTypes: groups.map(g => ({ name: g.name, count: g.count })), totalSites: total }, summary: `Set ${groups.length} site type${groups.length === 1 ? '' : 's'}, ${total.toLocaleString()} sites` };
    },

    analyse_website: async (x, ctx) => {
      const groups = ctx.q.siteGroups || [];
      const g = (x.siteType && groups.find(y => y.name.trim().toLowerCase() === x.siteType.trim().toLowerCase())) || groups[0];
      const url = /^https?:\/\//i.test(x.url) ? x.url : 'https://' + x.url;
      onProgress(`Analysing ${url.replace(/^https?:\/\//, '')}…`);
      const result = await scan({ rootUrl: url, crawlIfNoSitemap: true, limits: { maxPagesInspect: Math.min(200, x.maxPages || 80) }, catalogueIds: (ctx.q.foundation?.components || []).map(c => c.id), signal, onProgress: p => p.message && onProgress(p.message) });
      store.saveScan(result);
      if (result.status !== 'complete' || !result.entries?.length) return { result: { ok: false, status: result.status, message: 'No URLs found. Use typical per site figures instead.' }, summary: `Could not read ${url}` };
      const inventory = mergeScan(ctx.q.inventory, result, { groupId: g?.id || 'main' });
      const samples = g && !(g.samples || []).some(s => s.url === url) ? [...(g.samples || []), { url }] : g?.samples;
      ctx.q = { ...ctx.q, inventory, siteGroups: groups.map(y => (y === g ? { ...y, samples } : y)), history: [...(ctx.q.history || []), { at: new Date().toISOString(), kind: 'merged_scan', scanId: result.id, partial: result.partial, urls: result.entries.length, by: 'assistant' }] };
      await ctx.save();
      const site = summarize({ entries: inventory.entries.filter(e => e.siteKey === inventory.scans.at(-1).site) });
      return {
        result: { ok: true, urls: result.entries.length, partial: !!result.partial, limitedBy: result.coverage?.limitedBy || [], byCategory: site.byCategory, archives: site.byCategoryAll.ARCHIVE, recordTypes: Object.entries(site.recordsByType).sort((a, b) => b[1] - a[1]).slice(0, 12), needsReview: site.needsReview, media: result.media ? { images: result.media.images?.unique, documents: result.media.documents?.unique } : null, siteType: g?.name },
        summary: `Analysed ${url.replace(/^https?:\/\//, '')}: ${result.entries.length.toLocaleString()} URLs${result.partial ? ' (partial)' : ''}`,
      };
    },

    apply_inventory_quantities: async (x, ctx) => {
      const { rows } = proposeQuantities(ctx.q);
      const chosen = rows.map(r => ({ ...r, selected: r.selected || (!r.manual && !r.editable && Number(r.proposed) > 0 && r.id !== 'MIG_CONTENT_TYPE_MAP') || (r.id === 'MIG_CONTENT_TYPE_MAP' && r.proposed > 0) }));
      let q = applyProposals(ctx.q, chosen);
      const lines = { ...q.lines };
      for (const r of chosen.filter(r => r.selected)) if (lines[r.id]) lines[r.id] = { ...lines[r.id], aiNote: r.basis };
      ctx.q = { ...q, lines }; await ctx.save();
      const applied = chosen.filter(r => r.selected).map(r => ({ id: r.id, qty: r.proposed, basis: r.basis }));
      return { result: { applied, notApplied: chosen.filter(r => !r.selected).map(r => ({ id: r.id, proposed: r.proposed, note: r.note })) }, summary: `Applied ${applied.length} quantities from the inventory` };
    },

    set_lines: async (x, ctx) => {
      const items = Object.fromEntries(ctx.q.pricingSnapshot.items.map(i => [i.id, i]));
      const lines = { ...ctx.q.lines }; const errors = []; let inc = 0, opt = 0, hid = 0;
      for (const l of x.lines) {
        const it = items[l.id];
        if (!it) { errors.push(`Unknown item ${l.id}`); continue; }
        const cur = lines[l.id] || {};
        const next = { ...cur, state: l.state, aiNote: l.reason || cur.aiNote };
        if (l.state === 'included' && !it.quantitySource && it.pricing.model !== 'included') {
          if (l.qty === undefined || l.qty === null) { if (cur.qty == null) errors.push(`${l.id}: included without a quantity`); }
          else { next.qty = Math.round(Number(l.qty) * 100) / 100; next.qtySource = 'assistant'; }
        }
        if (l.optionalQty !== undefined) next.optionalQty = l.optionalQty;
        lines[l.id] = next;
        if (l.state === 'included') inc++; else if (l.state === 'optional') opt++; else hid++;
      }
      ctx.q = { ...ctx.q, lines }; await ctx.save();
      const calc = calculateQuote(ctx.q);
      return { result: { ok: !errors.length, errors, total: calc.total, totalStatus: calc.totalStatus, blockers: calc.blockers.length }, summary: `Set ${x.lines.length} deliverables (${inc} included, ${opt} optional, ${hid} hidden)` };
    },

    set_component_treatments: async (x, ctx) => {
      if (!ctx.q.foundation) throw new Error('This quote has no foundation');
      const by = Object.fromEntries(x.components.map(c => [c.id, c]));
      const known = new Set(ctx.q.foundation.components.map(c => c.id));
      const unknown = x.components.filter(c => !known.has(c.id)).map(c => c.id);
      const added = unknown.map(id => ({ id, name: id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()), treatment: by[id].treatment, note: by[id].note || '', addedInQuote: true }));
      ctx.q = { ...ctx.q, foundation: { ...ctx.q.foundation, components: [...ctx.q.foundation.components.map(c => (by[c.id] ? { ...c, treatment: by[c.id].treatment, note: by[c.id].note || c.note } : c)), ...added] } };
      await ctx.save();
      const n = ctx.q.foundation.components.filter(c => c.treatment === 'redesign').length;
      return { result: { ok: true, redesign: n, addedToQuote: unknown }, summary: `Set ${x.components.length} component treatments (${n} redesign)` };
    },

    write_proposal: async (x, ctx) => {
      const p = { ...(ctx.q.proposal || {}) };
      for (const k of ['intro', 'assumptions', 'exclusions', 'timeline']) if (x[k] !== undefined) p[k] = x[k];
      ctx.q = { ...ctx.q, proposal: p }; await ctx.save();
      return { result: { ok: true }, summary: `Wrote the proposal: ${['intro', 'assumptions', 'exclusions', 'timeline'].filter(k => x[k] !== undefined).join(', ')}` };
    },

    set_plan_hours: async (x, ctx) => {
      const plan = ctx.q.plan || emptyPlan();
      const rows = { ...(plan.rows || {}) }; const errors = [];
      const included = new Set(calculateQuote(ctx.q).lines.filter(l => l.state === 'included').map(l => l.id));
      for (const r of x.rows) {
        if (!included.has(r.id)) { errors.push(`${r.id} is not included`); continue; }
        const clean = o => Object.fromEntries(ROLE_IDS.map(k => [k, o?.[k] == null ? null : Number(o[k])]));
        rows[r.id] = { ...(rows[r.id] || {}), effort: { setup: clean(r.setup), perUnit: clean(r.perUnit), source: 'assistant' }, ...(r.phase ? { phase: r.phase } : {}), ...(r.note ? { note: r.note } : {}) };
      }
      ctx.q = { ...ctx.q, plan: { ...plan, rows } }; await ctx.save();
      return { result: { ok: !errors.length, errors }, summary: `Added Plan hours for ${x.rows.length - errors.length} deliverables` };
    },

    get_pricing_summary: async (x, ctx) => {
      const c = calculateQuote(ctx.q);
      return { result: { total: c.total / 100, currency: 'USD', status: c.totalStatus, sections: c.sections.map(s => ({ name: s.name, subtotal: s.subtotal / 100, pending: s.pending })), blockers: c.blockers.map(b => b.message), checks: c.warnings.map(w => w.message).slice(0, 15), optionalAdditions: c.optional.length }, summary: 'Checked the totals' };
    },
  };
}

// ---- Claude API ----------------------------------------------------------------------
export async function callClaude({ apiKey, model, system, messages, tools, fetchImpl = fetch, signal }) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16000, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages, tools }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `status ${res.status}`;
    throw Object.assign(new Error(res.status === 401 ? 'The Claude API refused the key. Check ANTHROPIC_API_KEY in Render.' : `Claude API error: ${msg}`), { status: 502 });
  }
  return body;
}

// Attachments become Claude content blocks: PDFs and images natively, Word as text, text files as text.
export async function fileBlocks(files = []) {
  const out = [];
  for (const f of files.slice(0, 5)) {
    const buf = Buffer.from(String(f.data || ''), 'base64');
    if (buf.length > MAX_FILE_BYTES) throw Object.assign(new Error(`${f.name} is larger than 15 MB`), { status: 400 });
    const name = String(f.name || 'file'); const type = String(f.type || '').toLowerCase();
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: name });
    else if (/^image\/(png|jpeg|gif|webp)$/.test(type)) out.push({ type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } });
    else if (/\.docx$/i.test(name) || type.includes('wordprocessingml')) {
      const mammoth = (await import('mammoth')).default;
      const { value } = await mammoth.extractRawText({ buffer: buf });
      out.push({ type: 'text', text: `Attached Word document "${name}":\n\n${value.slice(0, 200000)}` });
    } else if (/^text\/|json|csv|markdown/.test(type) || /\.(txt|md|csv|json)$/i.test(name)) out.push({ type: 'text', text: `Attached file "${name}":\n\n${buf.toString('utf8').slice(0, 200000)}` });
    else throw Object.assign(new Error(`${name}: use PDF, Word (.docx), text, Markdown, CSV or an image`), { status: 400 });
  }
  return out;
}

// Make a stored conversation valid for the Messages API: it starts with the user, roles
// alternate, and every tool_use is answered by a tool_result in the very next message.
// Repairs conversations saved by earlier versions that could stop on a cut off reply.
export function repairMessages(messages) {
  const out = [];
  const asBlocks = c => (Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }]);
  for (const m of messages || []) {
    const msg = { role: m.role, content: asBlocks(m.content).filter(b => b && b.type) };
    if (!msg.content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) { prev.content = [...prev.content, ...msg.content]; continue; }
    out.push(msg);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'assistant') continue;
    const ids = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
    let next = out[i + 1];
    if (!ids.length) continue;
    if (!next) { next = { role: 'user', content: [] }; out.push(next); }
    const have = new Set(next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
    const missing = ids.filter(id => !have.has(id)).map(id => ({ type: 'tool_result', tool_use_id: id, content: 'This call was not run (the turn was interrupted).', is_error: true }));
    // tool results must come first in the user message
    const results = [...next.content.filter(b => b.type === 'tool_result' && ids.includes(b.tool_use_id)), ...missing];
    next.content = [...results, ...next.content.filter(b => !(b.type === 'tool_result'))];
  }
  // a tool_result whose tool_use is gone is invalid too
  for (let i = 0; i < out.length; i++) {
    const m = out[i]; if (m.role !== 'user') continue;
    const prevIds = new Set(i > 0 ? out[i - 1].content.filter(b => b.type === 'tool_use').map(b => b.id) : []);
    m.content = m.content.filter(b => b.type !== 'tool_result' || prevIds.has(b.tool_use_id));
    if (!m.content.length) m.content = [{ type: 'text', text: '(continue)' }];
  }
  return out;
}

// ---- conversation storage, restore points and the agent loop -------------------------
export function createAssistant({ store, dataDir, config = assistantConfig(), scan, fetchImpl = fetch }) {
  const dir = path.join(dataDir, 'assistant'); const cpDir = path.join(dir, 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  const convoFile = id => { if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw Object.assign(new Error('Unknown quote'), { status: 404 }); return path.join(dir, `${id}.json`); };
  const load = id => (fs.existsSync(convoFile(id)) ? JSON.parse(fs.readFileSync(convoFile(id), 'utf8')) : { messages: [], transcript: [], checkpoints: [] });
  const persist = (id, c) => { const tmp = convoFile(id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c)); fs.renameSync(tmp, convoFile(id)); };
  const jobs = new Map(); const running = new Set();

  function publicConvo(id) {
    const c = load(id);
    return { transcript: c.transcript, canUndo: c.checkpoints.length > 0, running: running.has(id), enabled: config.enabled, model: config.model };
  }

  async function runTurn(job, quoteId, text, files, user) {
    const c = load(quoteId);
    const before = store.getQuote(quoteId);
    const cpFile = path.join(cpDir, `${quoteId}-${Date.now()}.json`);
    fs.writeFileSync(cpFile, JSON.stringify(before));
    c.checkpoints.push({ at: new Date().toISOString(), file: path.basename(cpFile), updatedAt: before.updatedAt });
    const blocks = await fileBlocks(files);
    const content = [...blocks, { type: 'text', text: text || 'Please build the quote from the attached brief.' }];
    content[content.length - 1].cache_control = { type: 'ephemeral' };
    // only the latest user message keeps a cache breakpoint (the API allows four)
    for (const m of c.messages) if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
    c.messages.push({ role: 'user', content });
    const entry = { role: 'user', text: text || '', files: files.map(f => f.name), at: new Date().toISOString(), by: user || null };
    c.transcript.push(entry);
    const reply = { role: 'assistant', text: '', steps: [], at: null };
    job.reply = reply;
    const ctx = { q: before, save: async () => { const saved = store.saveQuote({ ...ctx.q, updatedBy: 'assistant' }); ctx.q = saved; job.quoteUpdatedAt = saved.updatedAt; } };
    const tools = makeTools({ store, scan, signal: job.ctl.signal, onProgress: m => { job.progress = m; } });
    const foundations = store.listFoundations();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (job.ctl.signal.aborted) throw Object.assign(new Error('Stopped'), { code: 'cancelled' });
        job.progress = step === 0 ? 'Reading the brief…' : 'Thinking…';
        c.messages = repairMessages(c.messages);
        const resp = await callClaude({ apiKey: config.apiKey, model: config.model, system: systemPrompt(ctx.q, { foundations }), messages: c.messages, tools: TOOLS, fetchImpl, signal: job.ctl.signal });
        c.messages.push({ role: 'assistant', content: resp.content });
        for (const b of resp.content) if (b.type === 'text' && b.text.trim()) reply.text += (reply.text ? '\n\n' : '') + b.text.trim();
        job.usage = { input: (job.usage?.input || 0) + (resp.usage?.input_tokens || 0) + (resp.usage?.cache_read_input_tokens || 0), output: (job.usage?.output || 0) + (resp.usage?.output_tokens || 0) };
        const uses = resp.content.filter(x => x.type === 'tool_use');
        if (!uses.length) break;
        const results = [];
        // a reply cut off at the output limit may hold an incomplete tool request: answer it, never drop it
        const truncated = resp.stop_reason === 'max_tokens';
        for (const b of uses) {
          if (truncated) {
            reply.steps.push({ tool: b.name, summary: 'Reply was cut off; retrying in smaller steps', ok: false });
            results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Your reply was cut off at the output limit, so this call was not run. Repeat it in smaller parts (i.e. fewer lines per set_lines call).', is_error: true });
            continue;
          }
          const fn = tools[b.name];
          job.progress = (TOOLS.find(t => t.name === b.name)?.description || b.name).split('.')[0] + '…';
          try {
            if (!fn) throw new Error(`Unknown tool ${b.name}`);
            const { result, summary } = await fn(b.input || {}, ctx);
            reply.steps.push({ tool: b.name, summary, ok: true });
            results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result) });
          } catch (e) {
            if (e.code === 'cancelled' || job.ctl.signal.aborted) throw e;
            reply.steps.push({ tool: b.name, summary: e.message, ok: false });
            results.push({ type: 'tool_result', tool_use_id: b.id, content: e.message, is_error: true });
          }
        }
        c.messages.push({ role: 'user', content: results });
        if (step === MAX_STEPS - 1) reply.text += '\n\nI stopped after the maximum number of steps. Ask me to continue if anything is left.';
      }
    } catch (e) {
      // keep the conversation valid for the next turn: drop a dangling tool request
      const last = c.messages.at(-1);
      if (last?.role === 'assistant' && last.content.some(b => b.type === 'tool_use')) c.messages.pop();
      reply.error = e.code === 'cancelled' ? 'Stopped. Changes made so far are kept; use Undo to restore the quote.' : e.message;
    }
    reply.at = new Date().toISOString();
    if (!reply.text && !reply.error) reply.text = 'Done.';
    c.transcript.push(reply);
    // conversations must alternate; if the turn ended on a user message (tool results), close it
    if (c.messages.at(-1)?.role === 'user') c.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply.error ? `(Stopped: ${reply.error})` : 'Done.' }] });
    persist(quoteId, c);
    const q = store.getQuote(quoteId);
    if (q.updatedAt !== before.updatedAt) store.saveQuote({ ...q, history: [...(q.history || []), { at: reply.at, kind: 'assistant', by: user || null, steps: reply.steps.length }] });
  }

  return {
    get enabled() { return config.enabled; },
    conversation: publicConvo,
    start(quoteId, { text = '', files = [] } = {}, user = null) {
      if (!config.enabled) throw Object.assign(new Error('The assistant is not connected. Add ANTHROPIC_API_KEY in Render, then redeploy.'), { status: 400 });
      store.getQuote(quoteId); // must exist
      if (running.has(quoteId)) throw Object.assign(new Error('The assistant is already working on this quote.'), { status: 409 });
      if (!String(text).trim() && !files.length) throw Object.assign(new Error('Write a message or attach a brief'), { status: 400 });
      const job = { id: 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quoteId, status: 'running', progress: 'Starting…', ctl: new AbortController(), startedAt: new Date().toISOString() };
      jobs.set(job.id, job); running.add(quoteId);
      runTurn(job, quoteId, String(text), files, user)
        .then(() => { job.status = job.reply?.error ? 'error' : 'done'; })
        .catch(e => { job.status = 'error'; job.error = e.message; })
        .finally(() => { running.delete(quoteId); job.finishedAt = new Date().toISOString(); setTimeout(() => jobs.delete(job.id), 3600e3).unref?.(); });
      return this.job(job.id);
    },
    job(id) {
      const j = jobs.get(id); if (!j) throw Object.assign(new Error('Assistant job not found (the server may have restarted)'), { status: 404 });
      return { id: j.id, quoteId: j.quoteId, status: j.status, progress: j.progress, steps: j.reply?.steps || [], text: j.reply?.text || '', error: j.error || j.reply?.error || null, usage: j.usage || null, quoteUpdatedAt: j.quoteUpdatedAt || null };
    },
    stop(id) { const j = jobs.get(id); if (j) j.ctl.abort(); return this.job(id); },
    undo(quoteId) {
      if (running.has(quoteId)) throw Object.assign(new Error('Wait for the assistant to finish first.'), { status: 409 });
      const c = load(quoteId); const cp = c.checkpoints.pop();
      if (!cp) throw Object.assign(new Error('Nothing to undo'), { status: 400 });
      const snap = JSON.parse(fs.readFileSync(path.join(cpDir, cp.file), 'utf8'));
      const restored = store.saveQuote({ ...snap, history: [...(snap.history || []), { at: new Date().toISOString(), kind: 'assistant_undone' }] });
      c.transcript.push({ role: 'system', text: 'Undid the last assistant turn. The quote is back to how it was before it.', at: new Date().toISOString() });
      c.messages.push({ role: 'user', content: [{ type: 'text', text: '(The user undid your last turn. The quote is back to its earlier state. Call get_quote_state before making further changes.)' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] });
      persist(quoteId, c);
      return restored;
    },
    clear(quoteId) { const c = load(quoteId); persist(quoteId, { messages: [], transcript: [], checkpoints: c.checkpoints }); return publicConvo(quoteId); },
  };
}

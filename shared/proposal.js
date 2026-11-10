// Client proposal renderer. The same HTML is shown in the live preview and printed to PDF by
// headless Chromium, so the preview and the PDF cannot drift apart.
// Excludes internal pattern keys, formulas, working notes, empty sections and hidden items.

import { calculateQuote, describePricing, blockTreatmentCounts } from './pricing.js';
import { summarize, portfolioSummary, CATEGORIES, effective, CATEGORY_BY_ID } from './inventory.js';
import { quoteTypeOf } from './quote.js';
import { fmtMoney, fmtInt, escapeHtml as h, fmtDate, plural } from './format.js';

// Anyday brand (October 2026): pure black, pure white, #A10E15 accent. Headings in MD Lorien,
// body in Inter. Layout follows the "Anyday WebOps for Multibrand Enterprises" deck: running
// header with a red rule, serif headlines, hairline rules and columns, small gem mark bottom right.
export const BRAND = {
  black: '#000000', white: '#FFFFFF', accent: '#A10E15',
  ink: '#000000', muted: '#5C5C5C', rule: '#D6D6D6', wash: '#F5F5F5',
  displayFont: "'MD Lorien'", bodyFont: "'Inter'",
};

export function fontFaceCss({ assetBase = '/assets', lorienUrl = '', inter = true } = {}) {
  const lorien = lorienUrl || (assetBase ? `${assetBase}/fonts/md-lorien-regular.woff2` : '');
  const out = [];
  if (lorien) out.push(`@font-face { font-family: 'MD Lorien'; font-style: normal; font-weight: 400; src: url(${lorien}) format('woff2'); font-display: swap; }`);
  if (inter && assetBase) for (const w of [400, 500, 600, 700]) out.push(`@font-face { font-family: 'Inter'; font-weight: ${w}; src: url(${assetBase}/fonts/inter-latin-${w}-normal.woff2) format('woff2'); font-display: swap; }`);
  return out.join('\n');
}

export function proposalCss({ assetBase = '/assets', lorienUrl = '', markDataUri = '', client = '', project = '' } = {}) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').toUpperCase();
  const B = BRAND;
  const head = `font: 600 6.5pt 'Inter', sans-serif; letter-spacing: 0.1em; color: ${B.black}; vertical-align: top; padding-top: 7pt; border-top: 1pt solid ${B.accent}; margin-top: 0.38in;`;
  return `${fontFaceCss({ assetBase, lorienUrl })}

@page {
  size: Letter; margin: 0.95in 0.7in 0.8in 0.7in;
  @top-left { content: "ANYDAY INC."; ${head} }
  @top-right { content: "${esc(project || client)}"; ${head} text-align: right; }
  @bottom-left { content: "${esc(client)} · Page " counter(page) " of " counter(pages); font: 500 6.5pt 'Inter', sans-serif; letter-spacing: 0.08em; color: ${B.muted}; vertical-align: bottom; padding-bottom: 0.32in; }
  @bottom-right { content: ""; ${markDataUri ? `background: url("${markDataUri}") no-repeat right bottom / 40px 19px;` : ''} width: 1in; margin-bottom: 0.32in; }
}
@page :first { margin: 0; @top-left { content: none; border: 0; margin: 0 } @top-right { content: none; border: 0; margin: 0 } @bottom-left { content: none } @bottom-right { content: none; background: none } }

:root { --black: ${B.black}; --white: ${B.white}; --accent: ${B.accent}; --muted: ${B.muted}; --rule: ${B.rule}; --wash: ${B.wash}; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: var(--white); color: var(--black); font-family: 'Inter', system-ui, sans-serif; font-size: 8.6pt; line-height: 1.5; }
.serif, h1, h2.section, .lead, .total-band .v { font-family: 'MD Lorien', Georgia, 'Times New Roman', serif; font-weight: 400; }
.doc { background: var(--white); }
.screen .doc { max-width: 8.5in; margin: 0 auto; }
.screen .page-body { padding: 0.5in 0.7in 0.8in; }

/* cover: black fading into Anyday red, as on the deck cover */
.cover { position: relative; width: 8.5in; height: 11in; background: linear-gradient(180deg, #000 0%, #000 42%, #3a0306 64%, var(--accent) 100%); color: var(--white); padding: 0.7in; overflow: hidden; break-after: page; display: flex; flex-direction: column; }
.screen .cover { width: 100%; height: auto; min-height: 9.5in; }
.cover-top { display: flex; justify-content: space-between; align-items: flex-start; }
.cover-top img { height: 54px; }
.cover-top .kind { font: 600 6.5pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,.8); }
.cover-mid { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 0.45in; }
.cover .eyebrow { font-family: 'MD Lorien', Georgia, serif; font-size: 28pt; line-height: 1.05; color: rgba(255,255,255,.62); margin-bottom: 10pt; }
.cover h1 { font-size: 46pt; line-height: 1.02; letter-spacing: -0.005em; margin: 0 0 16pt; max-width: 6.8in; text-wrap: balance; }
.cover .subtitle { font-size: 10pt; line-height: 1.5; color: rgba(255,255,255,.85); max-width: 4.6in; }
.cover-meta { display: grid; grid-template-columns: repeat(5, 1fr); border-top: 0.6pt solid rgba(255,255,255,.45); padding-top: 10pt; }
.cover-meta div { padding-right: 10pt; }
.cover-meta .k { font: 600 6pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,.65); }
.cover-meta .v { font-size: 8.6pt; font-weight: 500; margin-top: 3pt; }

h2.section { font-size: 24pt; line-height: 1.1; margin: 0 0 6pt; break-after: avoid; text-wrap: balance; }
.section-label { font: 600 6.5pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); margin: 0 0 6pt; break-after: avoid; }
.section-intro { margin: 0 0 14pt; max-width: 5.6in; color: var(--muted); break-after: avoid; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 24pt; border-bottom: 0.6pt solid var(--black); padding-bottom: 12pt; margin-bottom: 10pt; break-after: avoid; break-inside: avoid; }
.head h2.section { margin: 0; }
.head-note { margin: 0; max-width: 2.7in; font-size: 7.6pt; line-height: 1.45; color: var(--muted); }
h3.sub { font: 600 6.5pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin: 16pt 0 4pt; break-after: avoid; }
.block { margin: 0 0 26pt; }
.newpage { break-before: page; }
p { margin: 0 0 8pt; }
.intro .lead { font-size: 13pt; line-height: 1.4; max-width: 6.2in; margin-bottom: 10pt; }
.intro p:not(.lead) { font-size: 9.2pt; max-width: 6.2in; }

table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tfoot { display: table-row-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { text-align: left; font: 600 6pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); padding: 6pt 8pt 5pt; border-bottom: 0.8pt solid var(--black); }
th.num, td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td { padding: 7pt 8pt; border-bottom: 0.5pt solid var(--rule); vertical-align: top; }
td .name { font-weight: 600; }
td .desc { color: var(--muted); font-size: 7.8pt; margin-top: 1pt; }
td .note { color: var(--accent); font-size: 7.4pt; font-weight: 500; margin-top: 2pt; }
td .blocks { font-size: 7.4pt; color: var(--muted); margin-top: 3pt; }
tr.subtotal td { font-weight: 700; border-top: 0.8pt solid var(--black); border-bottom: 0; }
tr.subtotal.design td { font-weight: 600; border-top: 0.6pt solid var(--black); background: var(--wash); }
tr.grouphead td { font: 600 6pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); padding: 10pt 8pt 4pt; border-bottom: 0.6pt solid var(--black); }
.pending { color: var(--accent); font-weight: 600; }
.muted { color: var(--muted); }

.summary-table td { font-size: 9.6pt; padding: 10pt 8pt; }
.summary-table td .name { font-family: 'MD Lorien', Georgia, serif; font-weight: 400; font-size: 13pt; }
.total-band { margin-top: 12pt; background: linear-gradient(90deg, #000 0%, #000 55%, var(--accent) 100%); color: var(--white); padding: 18pt 20pt; display: flex; justify-content: space-between; align-items: flex-end; break-inside: avoid; }
.total-band .k { font: 600 6.5pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; }
.total-band .v { font-size: 30pt; line-height: 1; text-align: right; }
.total-band .q { font-size: 7.6pt; color: rgba(255,255,255,.75); margin-top: 4pt; }

.snapshot td.cat { width: 46%; }
.snapshot.portfolio { margin-bottom: 14pt; }
.snapshot .src { font-size: 7.4pt; color: var(--muted); margin-top: 8pt; }

ul.list { margin: 0; padding-left: 13pt; }
ul.list li { margin-bottom: 4pt; break-inside: avoid; }
ul.list li::marker { color: var(--accent); }
.terms { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24pt; border-top: 0.8pt solid var(--black); }
.terms > div { padding: 9pt 0; border-bottom: 0.5pt solid var(--rule); }
.terms .k { font: 600 6pt 'Inter'; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 3pt; }

.optional td { padding: 4pt 8pt; }
.optional td .desc { font-size: 7.4pt; }
.appendix table { table-layout: fixed; }
.appendix td { font-size: 7pt; padding: 3pt 6pt; word-break: break-all; }
.appendix th { font-size: 5.6pt; padding: 4pt 6pt; }

.watermark { position: fixed; top: 45%; left: 0; right: 0; text-align: center; transform: rotate(-28deg); font: 700 92pt 'Inter'; letter-spacing: 0.2em; color: rgba(0, 0, 0, 0.045); pointer-events: none; z-index: 0; }
.draft-banner { border-left: 2pt solid var(--accent); background: var(--wash); padding: 7pt 10pt; font-size: 8pt; margin: 0 0 18pt; break-inside: avoid; }
`;
}

// --- helpers -----------------------------------------------------------------
function qtyLabel(l) {
  const p = l.pricing;
  if (p.model === 'included') return 'Included';
  if (l.qty === null || l.qty === undefined || l.qty === '') return '<span class="pending">Quantity needed</span>';
  return h(plural(Number(l.qty), p.qtyUnit, p.qtyUnitPlural));
}
function rateLabel(l) {
  const p = l.pricing;
  if (p.model === 'per_unit' && p.unitPrice === null) return '<span class="pending">Price needed</span>';
  if (p.model === 'per_unit') return `${p.status === 'starting_at' ? 'Starting at ' : ''}${fmtMoney(p.unitPrice)} per ${h(p.qtyUnit)}`;
  if (p.model === 'batched') return `${fmtMoney(p.first.price)} first ${fmtInt(p.first.size)}, ${fmtMoney(p.additional.price)} per added ${fmtInt(p.additional.size)}`;
  if (p.model === 'per_block') return `${fmtMoney(p.price)} per ${fmtInt(p.blockSize)} ${h(p.qtyUnitPlural)}`;
  if (p.model === 'progressive') return 'Volume tiers';
  return 'No charge';
}
function amountLabel(l, { display = true } = {}) {
  const amt = display ? (l.displayAmount ?? l.amount) : l.amount;
  if (l.amount === null || l.amount === undefined) {
    const st = l.result?.status;
    return `<span class="pending">${st === 'qty_needed' ? 'Quantity needed' : 'Price needed'}</span>`;
  }
  return (l.startingAt ? '<span class="muted">from </span>' : '') + fmtMoney(amt);
}
function sectionAmount(sec) {
  if (sec.pending) return `<span class="pending">${fmtMoney(sec.subtotal)} + pending</span>`;
  return (sec.startingAt ? 'from ' : '') + fmtMoney(sec.subtotal);
}

// Deck style section head: label, serif title on the left, short note on the right, black rule under.
function head(label, title, note = '') {
  return `<div class="head"><div><div class="section-label">${label}</div><h2 class="section">${title}</h2></div>${note ? `<p class="head-note">${note}</p>` : ''}</div>`;
}

function lineRow(l, calc, quote, byId) {
  const notes = [];
  if (l.allocatedOut) notes.push(`${fmtMoney(l.allocatedOut)} of this fee is shown under design`);
  if (l.allocatedFrom) notes.push(`Allocated from the ${h(byId[l.allocatedFrom].item.name.toLowerCase())} fee. No additional charge.`);
  if (l.startingAt) notes.push('Starting price, confirmed after detailed scoping');
  let extra = '';
  if (l.item.quantitySource === 'component_design_count' || l.item.quantitySource === 'aaif_redesign_count') {
    const names = (quote.foundation?.components || []).filter(b => b.treatment === 'redesign').map(b => b.name);
    if (names.length) extra = `<div class="blocks">${h(names.join(' · '))}</div>`;
  }
  if (l.pricing.model === 'progressive' && l.result?.breakdown?.length) {
    extra += `<div class="blocks">${l.result.breakdown.map(b => h(b.label)).join(' · ')}</div>`;
  }
  return `<tr>
    <td><div class="name">${h(l.item.name)}</div><div class="desc">${h(l.item.receives || l.item.what || '')}</div>${extra}${notes.map(n => `<div class="note">${n}</div>`).join('')}</td>
    <td class="num">${qtyLabel(l)}</td>
    <td class="num">${rateLabel(l)}</td>
    <td class="num">${amountLabel(l)}</td>
  </tr>`;
}

const HEAD = `<thead><tr><th>Scope</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Investment</th></tr></thead>`;

export function isPortfolio(quote) { return !!quoteTypeOf(quote).sitesStep || (quote.siteGroups || []).length > 1; }

function snapshotHtml(quote, calc) {
  const inv = quote.inventory;
  const portfolio = isPortfolio(quote);
  const pf = portfolioSummary(quote);
  const s = summarize(inv);
  const has = portfolio ? pf.groups.some(g => g.source !== 'none') : s.discovered > 0;
  const L = Object.fromEntries(calc.lines.map(l => [l.id, l]));
  const incQty = id => (L[id]?.state === 'included' ? (L[id].qty ?? null) : 0);
  const row = (label, discovered, included, note = '') => `<tr><td class="cat"><div class="name">${h(label)}</div>${note ? `<div class="desc">${h(note)}</div>` : ''}</td><td class="num">${discovered === null ? '<span class="muted">Not measured</span>' : fmtInt(discovered)}</td><td class="num">${included === null ? '<span class="pending">To confirm</span>' : fmtInt(included)}</td></tr>`;
  const rows = [];
  let portfolioTable = '';
  if (portfolio) {
    const live = quote.portfolio?.existingLiveSites || 0;
    const perSitePages = g => (g.perSite.L1 || 0) + (g.perSite.L2 || 0) + (g.perSite.L3 || 0) + (g.perSite.BULK_STATIC || 0);
    const one = v => (Math.round(v * 10) / 10).toLocaleString('en-US');
    const basis = g => g.source === 'scan' ? (g.exact ? `All ${fmtInt(g.sampled)} reviewed` : `${fmtInt(g.sampled)} sample${g.sampled === 1 ? '' : 's'} reviewed`) : g.source === 'manual' ? 'Typical site figures' : 'To confirm';
    portfolioTable = `<table class="snapshot portfolio"><thead><tr><th>Site type</th><th class="num">Sites</th><th>Basis</th><th class="num">Pages per site</th><th class="num">Records per site</th></tr></thead><tbody>
      ${live ? `<tr><td class="cat"><div class="name">Already live on the platform</div><div class="desc">Volume pricing continues from these sites</div></td><td class="num">${fmtInt(live)}</td><td class="muted">Live</td><td class="num muted">n/a</td><td class="num muted">n/a</td></tr>` : ''}
      ${pf.groups.map(g => `<tr><td class="cat"><div class="name">${h(g.name)}</div></td><td class="num">${fmtInt(g.count)}</td><td>${h(basis(g))}</td><td class="num">${g.source === 'none' ? '<span class="pending">To confirm</span>' : one(perSitePages(g))}</td><td class="num">${g.source === 'none' ? '<span class="pending">To confirm</span>' : one(g.perSite.RECORD || 0)}</td></tr>`).join('')}
      <tr><td class="cat"><div class="name">${live ? 'New sites in this proposal' : 'Total sites'}</div></td><td class="num"><b>${fmtInt(pf.totalSites)}</b></td><td></td><td></td><td></td></tr></tbody></table>`;
  }
  if (!portfolio && has) rows.push(`<tr><td class="cat"><div class="name">URLs discovered</div><div class="desc">Every unique URL found in the site's sitemaps${inv?.source?.type === 'scan' && inv?.coverage?.crawl ? ' or bounded crawl' : ''}</div></td><td class="num">${fmtInt(s.discovered)}</td><td class="num muted">n/a</td></tr>`);
  const discOf = c => !has ? null : (portfolio ? (pf.totals[c] ?? 0) : s.byCategoryAll[c]);
  for (const c of CATEGORIES) {
    if (c.id === 'REVIEW') continue;
    const disc = discOf(c.id);
    const inc = c.itemId ? incQty(c.itemId) : null;
    if (c.id === 'ARCHIVE') { if (has && disc) rows.push(row('Generated archives', disc, 0, 'Tag, category and author routes are regenerated from content, not charged per URL')); continue; }
    if (!disc && !inc) continue;
    rows.push(row(c.label + 's', disc, inc, c.help));
  }
  const byType = portfolio ? pf.recordsByType : s.recordsByType;
  const types = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const typeRows = types.slice(0, 8).map(([t, n]) => `<tr><td class="cat" style="padding-left:20pt"><div class="desc">${h(t)}</div></td><td class="num muted">${fmtInt(n)}</td><td class="num muted">${fmtInt(n)}</td></tr>`);
  if (types.length > 8) { const rest = types.slice(8).reduce((a, [, n]) => a + n, 0); typeRows.push(`<tr><td class="cat" style="padding-left:20pt"><div class="desc">${types.length - 8} other content types</div></td><td class="num muted">${fmtInt(rest)}</td><td class="num muted">${fmtInt(rest)}</td></tr>`); }
  const recIdx = rows.findIndex(r => r.includes('Structured records'));
  if (recIdx >= 0 && typeRows.length) rows.splice(recIdx + 1, 0, ...typeRows);
  // media
  const m = inv?.media || {};
  const mediaIncl = incQty('MIG_MEDIA');
  const discMedia = !portfolio && m.discovered ? (m.discovered.images?.unique ?? 0) + (m.discovered.documents?.unique ?? 0) : null;
  const mediaNote = m.verified ? `Verified from ${m.verified.fileName || 'a CMS media export'}` : (discMedia ? 'Found on scanned pages only; a public scan does not establish the full media library size' : 'Planning allowance; to be verified against a CMS media export');
  if (mediaIncl || discMedia) rows.push(row('Media assets', m.verified ? (m.verified.total ?? null) : discMedia, mediaIncl, mediaNote));
  const red = incQty('MIG_REDIRECTS');
  if (red) rows.push(row('Redirects', null, red, 'Planning allowance; only URLs whose path changes need a redirect'));
  // components
  const rc = calc.lines.find(l => l.item.quantitySource === 'component_design_count' || l.item.quantitySource === 'aaif_redesign_count');
  let compRow = '';
  if (rc && rc.state === 'included') {
    const f = quote.foundation;
    const tc = blockTreatmentCounts(quote);
    if (quote.type === 'new_platform') compRow = `<tr><td class="cat"><div class="name">Components designed</div><div class="desc">Each reusable component is designed once and used across every site${f && tc.redesign ? `, including ${fmtInt(tc.redesign)} redesigned from ${h(f.name)}` : ''}.</div></td><td class="num muted">n/a</td><td class="num">${fmtInt(rc.qty || 0)}</td></tr>`;
    else if (f) compRow = `<tr><td class="cat"><div class="name">Existing ${h(f.name)} components redesigned</div><div class="desc">Counted once, however often a component appears. Other components receive brand application only.</div></td><td class="num">${fmtInt(f.components.length)} in library</td><td class="num">${fmtInt(tc.redesign)}</td></tr>`;
  }
  const sourceLabel = portfolio ? 'Across the portfolio' : 'On the current site';
  const srcText = portfolio
    ? (has ? `Source: ${pf.extrapolated ? 'figures for each site type are extrapolated from the sampled sites in that type' : 'every site was reviewed'}${inv?.source?.date ? `, latest scan ${fmtDate(inv.source.date)}` : ''}. Classifications were reviewed by Anyday and are confirmed during discovery.` : 'Source: quantities entered by Anyday. No site inventory attached yet.')
    : inv?.source
      ? (inv.source.type === 'imported_example'
        ? `Source: dated example inventory from ${fmtDate(inv.source.date)}, not a fresh scan. Page levels and component selections are provisional.`
        : `Source: website scan on ${fmtDate(inv.source.date)}${inv.source.partial ? ' (partial)' : ''}. Classifications were reviewed by Anyday and remain recommendations until discovery confirms them.`)
      : 'Source: quantities entered by Anyday. No website inventory attached.';
  return `${portfolioTable}<table class="snapshot"><thead><tr><th>Content</th><th class="num">${sourceLabel}</th><th class="num">Included in this proposal</th></tr></thead><tbody>${rows.join('')}${compRow}</tbody></table><div class="src">${h(srcText)}</div>`;
}

// A starting point for the introduction, written for the quote type. Anyday edits it.
export function suggestedIntro(quote, calc = calculateQuote(quote)) {
  const client = quote.client?.name || 'The client';
  const f = quote.foundation;
  const pf = portfolioSummary(quote);
  const site = quote.project?.url ? quote.project.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'its website';
  const recTypes = Object.keys(pf.recordsByType).slice(0, 3).map(t => t.toLowerCase());
  const records = recTypes.length ? `${recTypes.join(', ')} and other records` : 'records';
  const designN = calc.lines.find(l => l.item.quantitySource === 'component_design_count' && l.state === 'included')?.qty;
  if (quote.type === 'new_platform') {
    return `${client} needs one platform for ${pf.totalSites > 1 ? `${fmtInt(pf.totalSites)} websites` : 'its website'}. Anyday will build a shared multisite platform${f ? `, starting from ${f.name}` : ''}: a library of reusable components${designN ? ` (${fmtInt(designN)} designed in this proposal)` : ''}, structured content models and brand controls, so every site launches from the same foundation and stays consistent.\n\nAnyday will then roll the sites onto it, migrating their pages, ${records}, media and URLs.${pf.groups.length > 1 ? ` Sites are grouped into ${pf.groups.length} site types, and migration volumes are based on ${pf.groups.some(g => g.source === 'scan') ? 'reviewed samples of each type' : 'typical figures for each type'}.` : ''}`;
  }
  if (quote.type === 'expansion') {
    const live = quote.portfolio?.existingLiveSites || 0;
    return `${client} is adding ${fmtInt(pf.totalSites)} site${pf.totalSites === 1 ? '' : 's'} to the ${f?.name || 'existing'} platform${live ? `, which already runs ${fmtInt(live)} live site${live === 1 ? '' : 's'}` : ''}. No new platform build is needed: each new site reuses the existing components, content models and integrations.\n\nAnyday will configure each site's brand and migrate its pages, ${records}, media and URLs. Site activation continues from the volume already reached.`;
  }
  return `${client} wants to move ${site} onto ${f ? `${f.name}, the platform foundation Anyday built${f.owner ? ` for ${f.owner}` : ''}` : 'an existing Anyday platform foundation'}. This proposal reuses that foundation: its component library, content models and integrations.\n\nAnyday will apply the ${client} brand, redesign the selected components, and migrate the site's pages, ${records}, media and URLs.`;
}

export function derivedAssumptions(quote, calc) {
  const out = [];
  for (const l of calc.lines) if (l.state === 'included' && l.startingAt) out.push(`${l.item.name} is shown at its starting price of ${fmtMoney(l.pricing.unitPrice)} per ${l.pricing.qtyUnit}. The final price is confirmed after detailed scoping.`);
  return out;
}

export function allAssumptions(quote, calc) {
  const dismissed = new Set(quote.proposal?.dismissedAuto || []);
  const list = [...(quote.proposal?.assumptions || []), ...(quote.proposal?.autoAssumptions || []).filter(a => !dismissed.has(a)), ...derivedAssumptions(quote, calc).filter(a => !dismissed.has(a))];
  return [...new Set(list.map(s => s.trim()).filter(Boolean))];
}

export const APPENDIX_MAX_ROWS = 2000;

export function renderProposal(quote, opts = {}) {
  const { mode = 'draft', appendix = quote.proposal?.includeAppendix, assetBase = '/assets', fontCssHref = '', logoUrl = `${assetBase}/anyday-logo-white.png`, markDataUri = '', lorienUrl = '', screen = false, quoteDate } = opts;
  const calc = opts.calc || calculateQuote(quote);
  const final = mode === 'final';
  if (final && !calc.canExportFinal) throw new Error('Final proposal blocked: ' + calc.blockers.map(b => b.message).join('; '));
  const byId = Object.fromEntries(calc.lines.map(l => [l.id, l]));
  const pr = quote.proposal || {};
  const client = quote.client?.name || 'Client';
  const project = quote.project?.name || ({ new_platform: 'Platform implementation and rollout', expansion: 'Platform expansion' }[quote.type] || 'Website implementation');
  const date = quoteDate || quote.issuedAt || quote.updatedAt || new Date().toISOString();
  const visibleSections = calc.sections.filter(s => !s.empty);

  const summaryRows = visibleSections.map(s => `<tr><td><div class="name">${h(s.name)}</div>${s.id === 'base' && s.design.length ? `<div class="desc">Implementation ${fmtMoney(s.implementationSubtotal)} · Design ${fmtMoney(s.designSubtotal)}${s.design.some(d => d.amount === null) ? ' + pending' : ''}</div>` : ''}</td><td class="num">${sectionAmount(s)}</td></tr>`).join('');
  const totalLabel = calc.totalStatus === 'starting_at' ? 'Total investment, starting at' : 'Total investment';
  const totalBand = `<div class="total-band"><div><div class="k">${totalLabel}</div><div class="q">USD · Quote ${h(quote.number || 'draft')}</div></div><div><div class="v">${fmtMoney(calc.total)}${calc.totalStatus === 'pending' ? '<span style="font-size:12pt"> + items pending</span>' : ''}</div></div></div>`;

  const sectionHtml = visibleSections.map(sec => {
    let body = '';
    if (sec.id === 'base') {
      if (sec.implementation.length) body += `<h3 class="sub">Implementation</h3><table>${HEAD}<tbody>${sec.implementation.map(l => lineRow(l, calc, quote, byId)).join('')}<tr class="subtotal design"><td colspan="3">Implementation subtotal</td><td class="num">${sec.implementation.some(l => l.startingAt) ? 'from ' : ''}${fmtMoney(sec.implementationSubtotal)}${sec.implementation.some(l => l.amount === null) ? ' <span class="pending">+ pending</span>' : ''}</td></tr></tbody></table>`;
      if (sec.design.length) body += `<h3 class="sub">Design</h3><table>${HEAD}<tbody>${sec.design.map(l => lineRow(l, calc, quote, byId)).join('')}<tr class="subtotal design"><td colspan="3">Design subtotal${sec.designAllocated ? ` <span class="muted">(includes ${fmtMoney(sec.designAllocated)} allocated from existing fees)</span>` : ''}</td><td class="num">${fmtMoney(sec.designSubtotal)}${sec.design.some(l => l.amount === null) ? ' <span class="pending">+ pending</span>' : ''}</td></tr></tbody></table>`;
      body += `<table style="margin-top:8pt"><tbody><tr class="subtotal"><td>${h(sec.name)} subtotal</td><td class="num">${sectionAmount(sec)}</td></tr></tbody></table>`;
    } else {
      body += `<table>${HEAD}<tbody>${sec.lines.map(l => lineRow(l, calc, quote, byId)).join('')}<tr class="subtotal"><td colspan="3">${h(sec.name)} subtotal</td><td class="num">${sectionAmount(sec)}</td></tr></tbody></table>`;
    }
    return `<div class="block">${head(`Section ${sec.order}`, h(sec.name), h(sec.intro || ''))}${body}</div>`;
  }).join('');

  const increments = calc.additions.map(l => `<tr><td><div class="name">Additional ${h(l.pricing.qtyUnitPlural)}: ${h(l.item.name)}</div><div class="desc">Adds ${h(plural(l.addition.qty, l.pricing.qtyUnit, l.pricing.qtyUnitPlural))} to the ${fmtInt(Number(l.qty))} already included, priced at the applicable volume rate</div></td><td class="num">+${fmtInt(l.addition.qty)}</td><td class="num">${l.addition.amount === null ? '<span class="pending">Price needed</span>' : '+' + fmtMoney(l.addition.amount)}</td></tr>`);
  const opts2 = [];
  for (const s of [...calc.sections].sort((a, b) => a.order - b.order)) {
    const list = calc.optional.filter(o => o.section === s.id);
    if (!list.length) continue;
    opts2.push(`<tr class="grouphead"><td colspan="3">${h(s.name)}</td></tr>`);
    for (const o of list) {
      const est = o.estimate ? (o.estimate.amount === null ? '<span class="pending">Price needed</span>' : `${fmtMoney(o.estimate.amount)}`) : h(o.priceLabel);
      const qtyCell = o.estimate ? h(plural(o.estimate.qty, o.pricing.qtyUnit, o.pricing.qtyUnitPlural)) : '<span class="muted">Per unit</span>';
      const req = o.requires.length ? `<div class="note">Requires ${h(o.requires.map(g => g.join(' or ')).join('; '))}</div>` : '';
      opts2.push(`<tr><td><div class="name">${h(o.item.name)}</div><div class="desc">${h(o.item.receives || o.item.what || '')}</div>${req}</td><td class="num">${qtyCell}</td><td class="num">${est}</td></tr>`);
    }
  }
  const optionalHtml = (increments.length || opts2.length) ? `<div class="block newpage">${head('Not included in the total', 'Optional Additions', 'Available on request. These are not part of the total investment. Volume based additions are priced against the scope already included.')}<table class="optional"><thead><tr><th>Addition</th><th class="num">Quantity</th><th class="num">Price</th></tr></thead><tbody>${increments.join('')}${opts2.join('')}</tbody></table></div>` : '';

  const assumptions = allAssumptions(quote, calc);
  const exclusions = (pr.exclusions || []).map(s => s.trim()).filter(Boolean);
  const termsBits = [];
  if (pr.timeline?.trim()) termsBits.push(`<div><div class="k">Timeline</div><div>${h(pr.timeline)}</div></div>`);
  if (pr.paymentTerms?.trim()) termsBits.push(`<div><div class="k">Payment terms</div><div>${h(pr.paymentTerms)}</div></div>`);
  if (pr.validity?.trim()) termsBits.push(`<div><div class="k">Validity</div><div>${h(pr.validity)}</div></div>`);
  termsBits.push(`<div><div class="k">Currency</div><div>All amounts are in US dollars (USD).</div></div>`);

  const intro = (pr.intro || '').trim();
  const introHtml = intro ? `<div class="block intro">${head('Introduction', 'The project')}${intro.split(/\n{2,}/).map((p, i) => `<p class="${i === 0 ? 'lead' : ''}">${h(p)}</p>`).join('')}</div>` : '';

  let appendixHtml = '';
  if (appendix && quote.inventory?.entries?.length) {
    // Printing a table with tens of thousands of rows takes Chromium several GB of memory, so
    // the PDF lists the first APPENDIX_MAX_ROWS (included URLs first); the CSV has every URL.
    const all = quote.inventory.entries.map(e => ({ e, ef: effective(e) }));
    const order = r => (r.ef.include ? 0 : 1);
    const shown = all.length > APPENDIX_MAX_ROWS ? [...all].sort((a, b) => order(a) - order(b)).slice(0, APPENDIX_MAX_ROWS) : all;
    const rows = shown.map(({ e, ef }) => `<tr><td>${h(e.url)}</td><td>${h(e.findings?.title || '')}</td><td>${h(ef.contentType)}</td><td>${h(CATEGORY_BY_ID[ef.category]?.short || ef.category)}</td><td>${ef.category === 'ARCHIVE' ? (ef.include ? 'Regenerate' : 'No') : (ef.include ? 'Yes' : 'No')}</td></tr>`).join('');
    const intro = all.length > shown.length
      ? `${fmtInt(all.length)} URLs. The first ${fmtInt(shown.length)} are listed here, included URLs first; the complete inventory is provided as a spreadsheet. Classifications are recommendations reviewed by Anyday.`
      : `${fmtInt(all.length)} URLs. Classifications are recommendations reviewed by Anyday.`;
    appendixHtml = `<div class="block newpage appendix">${head('Appendix', 'URL inventory', intro)}<table><thead><tr><th style="width:42%">URL</th><th>Title</th><th>Content type</th><th>Category</th><th>Included</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const draftNote = !final ? `<div class="draft-banner"><b>Draft.</b> ${calc.blockers.length ? `${calc.blockers.length} item${calc.blockers.length === 1 ? '' : 's'} still need a price or quantity before this proposal can be issued.` : 'Ready to issue as a final proposal.'}</div>` : '';
  const css = proposalCss({ assetBase, lorienUrl, markDataUri, client, project });
  const subtitle = quote.project?.url ? h(quote.project.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(client)} · ${h(project)} · Anyday proposal</title>${fontCssHref ? `<link rel="stylesheet" href="${h(fontCssHref)}">` : ''}<style>${css}</style></head>
<body class="${screen ? 'screen' : 'print'}">${!final ? '<div class="watermark">DRAFT</div>' : ''}<div class="doc">
<section class="cover">
  <div class="cover-top"><img src="${h(logoUrl)}" alt="Anyday"></div>
  <div class="cover-mid">
    <div class="eyebrow">Implementation proposal for</div>
    <h1>${h(client)}</h1>
    <div class="subtitle">${h(project)}<br>${subtitle}</div>
  </div>
  <div class="cover-meta">
    <div><div class="k">Quote</div><div class="v">${h(quote.number || 'Draft')}</div></div>
    <div><div class="k">Date</div><div class="v">${h(fmtDate(date))}</div></div>
    <div><div class="k">Currency</div><div class="v">USD</div></div>
    <div><div class="k">Prepared by</div><div class="v">${h(quote.preparedBy || 'Anyday')}</div></div>
    <div><div class="k">Status</div><div class="v">${final ? 'Proposal' : 'Draft'}</div></div>
  </div>
</section>
<div class="page-body">
${draftNote}
${introHtml}
<div class="block">${isPortfolio(quote) ? head('Portfolio scope snapshot', 'What we found, and what is included', 'The sites in scope, and the content across them compared with the scope priced in this proposal.') : head('Website scope snapshot', 'What we found, and what is included', 'The current site compared with the scope priced in this proposal.')}${snapshotHtml(quote, calc)}</div>
<div class="block newpage">${head('Investment', 'Investment summary', 'Implementation is priced on the volume and complexity of design, migration, integrations and functionality required.')}<table class="summary-table"><thead><tr><th>Section</th><th class="num">Investment</th></tr></thead><tbody>${summaryRows}</tbody></table>${totalBand}</div>
${sectionHtml}
<div class="block">${totalBand}</div>
${optionalHtml}
<div class="block newpage">${head('Terms', 'Assumptions and exclusions')}
${assumptions.length ? `<h3 class="sub">Assumptions</h3><ul class="list">${assumptions.map(a => `<li>${h(a)}</li>`).join('')}</ul>` : ''}
${exclusions.length ? `<h3 class="sub">Exclusions</h3><ul class="list">${exclusions.map(a => `<li>${h(a)}</li>`).join('')}</ul>` : ''}
<h3 class="sub">Commercial terms</h3><div class="terms">${termsBits.join('')}</div>
</div>
${appendixHtml}
</div></div></body></html>`;
}

export function proposalReadiness(quote, calc) {
  const notes = [];
  const pr = quote.proposal || {};
  if (!pr.intro?.trim()) notes.push('Project introduction is empty.');
  if (!pr.paymentTerms?.trim()) notes.push('Payment terms are not set and will be omitted.');
  if (!pr.validity?.trim()) notes.push('Validity period is not set and will be omitted.');
  if (!quote.client?.name?.trim()) notes.push('Client name is empty.');
  if (!quote.number) notes.push('Quote number will be assigned on first save.');
  return notes;
}

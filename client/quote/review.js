import { useState, useMemo } from 'preact/hooks';
import { html, Badge, Modal, NumInput, TextInput, toast } from '../ui.js';
import { summarize, effective, groupOf, portfolioSummary, CATEGORIES, CATEGORY_BY_ID, proposeQuantities, applyProposals } from '../../shared/inventory.js';
import { quoteTypeOf } from '../../shared/quote.js';
import { fmtInt, fmtMoney } from '../../shared/format.js';
import { priceForQuantity, pricedFrom, effectivePricing } from '../../shared/pricing.js';

const PAGE = 100;

export function ReviewStep({ api, quote, update, flush }) {
  const inv = quote.inventory || { entries: [] };
  const entries = inv.entries || [];
  const groups = quote.siteGroups?.length ? quote.siteGroups : [{ id: 'main', name: 'Website' }];
  const multi = quoteTypeOf(quote).sitesStep || groups.length > 1;
  const [f, setF] = useState({ q: '', cat: '', inc: '', status: '', review: '', type: '', group: '' });
  const s = useMemo(() => summarize(inv, f.group ? { groupId: f.group, groups } : {}), [inv, f.group]);
  const pf = useMemo(() => portfolioSummary(quote), [quote]);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState(new Set());
  const [open, setOpen] = useState(null);
  const [applying, setApplying] = useState(null);
  const types = useMemo(() => [...new Set(entries.map(e => effective(e).contentType).filter(Boolean))].sort(), [entries]);

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return entries.map((e, i) => ({ e, i, ef: effective(e) })).filter(({ e, ef }) => {
      if (q && !(e.url.toLowerCase().includes(q) || (e.findings?.title || '').toLowerCase().includes(q))) return false;
      if (f.cat && ef.category !== f.cat) return false;
      if (f.inc === 'yes' && !ef.include) return false;
      if (f.inc === 'no' && ef.include) return false;
      if (f.status && (e.status || 'unchanged') !== f.status) return false;
      if (f.review === 'needs' && !ef.needsReview) return false;
      if (f.review === 'reviewed' && !ef.reviewed) return false;
      if (f.review === 'edited' && !ef.edited) return false;
      if (f.type && ef.contentType !== f.type) return false;
      if (f.group && groupOf(e, groups) !== f.group) return false;
      return true;
    });
  }, [entries, f]);
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);

  const patch = (idxs, p) => update(q => {
    const es = [...q.inventory.entries];
    for (const i of idxs) es[i] = { ...es[i], decision: { ...(es[i].decision || {}), ...p } };
    return { ...q, inventory: { ...q.inventory, entries: es } };
  });
  const reset = i => update(q => { const es = [...q.inventory.entries]; es[i] = { ...es[i], decision: {} }; return { ...q, inventory: { ...q.inventory, entries: es } }; });
  const setFilter = (k, v) => { setF({ ...f, [k]: v }); setPage(0); };
  const selIdx = [...sel];

  const applyBtn = html`<button class="btn primary" onClick=${() => setApplying(proposeQuantities(quote))}>Review and apply quantities</button>`;
  const modal = applying ? html`<${ApplyModal} proposal=${applying} quote=${quote} onClose=${() => setApplying(null)} onApply=${rows => { update(q => applyProposals(q, rows)); setApplying(null); toast(`Applied ${rows.filter(r => r.selected).length} quantities`); }} />` : null;
  if (!entries.length) return html`<div class="stack">
    ${multi ? html`<${PortfolioCard} pf=${pf} quote=${quote} action=${pf.groups.some(g => g.source !== 'none') ? applyBtn : null} />` : null}
    <div class="card empty"><h2>No inventory yet</h2><p>${multi ? 'Analyse sample sites, or enter per site figures for each site type in Sites, or enter quantities directly in Scope.' : 'Analyse the website first, or enter quantities directly in Scope.'}</p></div>${modal}</div>`;

  const tile = (k, v, d, onClick, accent) => html`<button class=${'tile' + (accent ? ' accent' : '')} style="text-align:left;cursor:pointer" onClick=${onClick} title=${d}><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></button>`;
  const recTypes = Object.entries(s.recordsByType).sort((a, b) => b[1] - a[1]);
  const m = inv.media || {};

  return html`<div class="stack">
    ${multi ? html`<${PortfolioCard} pf=${pf} quote=${quote} action=${applyBtn} />` : null}
    <div class="card">
      <div class="spread"><h2>${multi ? 'Sample site analysis' : 'Website analysis'}</h2>
        <div class="row"><button class="btn small" onClick=${async () => { await flush(); api.exportCsv(quote); }}>Export URL inventory (CSV)</button>
        ${multi ? null : applyBtn}</div></div>
      ${multi && groups.length > 1 ? html`<div class="row wrap" style="margin-top:6px"><span class="caps muted">Site type</span>${[{ id: '', name: 'All' }, ...groups].map(g => html`<button class=${'chip' + (f.group === g.id ? ' on' : '')} onClick=${() => setFilter('group', g.id)}>${g.name}</button>`)}</div>` : null}
      <p class="small muted">${inv.source?.type === 'imported_example' ? 'Dated example inventory imported from the workbook, not a fresh scan. ' : ''}Automated classifications are recommendations. Your edits are stored separately from the scan findings and survive rescans.</p>
      <div class="tiles" style="margin-top:8px">
        ${tile('Discovered URLs', fmtInt(s.discovered), `${fmtInt(s.included)} included, ${fmtInt(s.excluded)} excluded`, () => setF({ ...f, cat: '', inc: '' }), true)}
        ${tile('Level 1 pages', fmtInt(s.byCategory.L1), CATEGORY_BY_ID.L1.help, () => setFilter('cat', 'L1'))}
        ${tile('Level 2 pages', fmtInt(s.byCategory.L2), CATEGORY_BY_ID.L2.help, () => setFilter('cat', 'L2'))}
        ${tile('Level 3 pages', fmtInt(s.byCategory.L3), CATEGORY_BY_ID.L3.help, () => setFilter('cat', 'L3'))}
        ${tile('Bulk static candidates', fmtInt(s.byCategory.BULK_STATIC), 'Near identical pages migrated in bulk rather than page by page.', () => setFilter('cat', 'BULK_STATIC'))}
        ${tile('Structured records', fmtInt(s.byCategory.RECORD), `${recTypes.length} content types. ${CATEGORY_BY_ID.RECORD.help}`, () => setFilter('cat', 'RECORD'))}
        ${tile('Generated archives', fmtInt(s.byCategoryAll.ARCHIVE), CATEGORY_BY_ID.ARCHIVE.help, () => setFilter('cat', 'ARCHIVE'))}
        ${tile('Reusable templates', inv.templates?.length ? fmtInt(inv.templates.length) : 'n/a', inv.templates?.length ? 'Page structures shared by two or more inspected pages.' : 'Available after a live scan.', () => {})}
        ${tile('Media assets', m.verified ? fmtInt(m.verified.total) : (m.discovered ? fmtInt(m.discovered.images.unique + m.discovered.documents.unique) : 'n/a'), m.verified ? 'Verified CMS export' : (m.discovered ? 'Found on scanned pages only, not the full library' : 'Not measured yet'), () => {})}
        ${tile('Needs review', fmtInt(s.needsReview), 'Low confidence, failed fetch or unclassified.', () => setFilter('review', 'needs'))}
      </div>
      ${recTypes.length ? html`<div class="row wrap" style="margin-top:12px"><span class="caps muted">Records by type</span>${recTypes.slice(0, 14).map(([t, n]) => html`<button class=${'chip' + (f.type === t ? ' on' : '')} onClick=${() => setFilter('type', f.type === t ? '' : t)}>${t} <b>${fmtInt(n)}</b></button>`)}</div>` : null}
      ${inv.templates?.length ? html`<details class="more" style="margin-top:10px"><summary>Likely reusable page templates (${inv.templates.length})</summary>
        <table class="t" style="margin-top:6px"><thead><tr><th>Sample page</th><th>Pages</th><th>Level</th><th>Block types</th></tr></thead><tbody>${inv.templates.slice(0, 30).map(t => html`<tr><td class="url-cell">${t.sample}</td><td class="num">${t.pages}</td><td>${CATEGORY_BY_ID[t.category]?.short}</td><td class="small">${t.blockTypes.join(', ')}</td></tr>`)}</tbody></table></details>` : null}
    </div>

    <div class="card flush">
      <div style="padding:12px 14px" class="stack">
        <div class="row wrap">
          <input class="input" style="max-width:280px" placeholder="Search URL or title" value=${f.q} onInput=${e => setFilter('q', e.target.value)} aria-label="Search inventory" />
          <select class="input" style="width:auto" value=${f.cat} onChange=${e => setFilter('cat', e.target.value)} aria-label="Category"><option value="">All categories</option>${CATEGORIES.map(c => html`<option value=${c.id}>${c.label}</option>`)}</select>
          <select class="input" style="width:auto" value=${f.inc} onChange=${e => setFilter('inc', e.target.value)} aria-label="Included"><option value="">Included and excluded</option><option value="yes">Included</option><option value="no">Excluded</option></select>
          <select class="input" style="width:auto" value=${f.review} onChange=${e => setFilter('review', e.target.value)} aria-label="Review"><option value="">Any review status</option><option value="needs">Needs review</option><option value="reviewed">Reviewed</option><option value="edited">Edited by me</option></select>
          <select class="input" style="width:auto" value=${f.status} onChange=${e => setFilter('status', e.target.value)} aria-label="Scan status"><option value="">Any scan status</option><option value="new">New in latest scan</option><option value="changed">Changed</option><option value="not_seen">Not seen in latest scan</option></select>
          <select class="input" style="width:auto;max-width:200px" value=${f.type} onChange=${e => setFilter('type', e.target.value)} aria-label="Content type"><option value="">Any content type</option>${types.map(t => html`<option value=${t}>${t}</option>`)}</select>
        </div>
        <div class="row wrap small">
          <span><b>${fmtInt(filtered.length)}</b> match${filtered.length === 1 ? '' : 'es'}</span>
          <button class="btn small" onClick=${() => setSel(new Set(filtered.map(r => r.i)))}>Select all ${fmtInt(filtered.length)}</button>
          ${sel.size ? html`<span class="pill-count">${fmtInt(sel.size)}</span> selected
            <select class="input" style="width:auto" value="" onChange=${e => { if (e.target.value) { patch(selIdx, { category: e.target.value }); toast(`${sel.size} URLs set to ${CATEGORY_BY_ID[e.target.value].label}`); } }} aria-label="Bulk category"><option value="">Set category…</option>${CATEGORIES.map(c => html`<option value=${c.id}>${c.label}</option>`)}</select>
            <button class="btn small" onClick=${() => patch(selIdx, { include: true })}>Include</button>
            <button class="btn small" onClick=${() => patch(selIdx, { include: false })}>Exclude</button>
            <button class="btn small" onClick=${() => patch(selIdx, { reviewed: true })}>Mark reviewed</button>
            <${BulkType} onApply=${t => patch(selIdx, { contentType: t })} />
            <button class="btn small ghost" onClick=${() => setSel(new Set())}>Clear</button>` : null}
        </div>
      </div>
      <div class="scroll-x"><table class="t">
        <thead><tr><th style="width:28px"><input type="checkbox" aria-label="Select page" checked=${pageRows.length && pageRows.every(r => sel.has(r.i))} onChange=${e => { const n = new Set(sel); pageRows.forEach(r => e.target.checked ? n.add(r.i) : n.delete(r.i)); setSel(n); }} /></th>
          <th>URL and title</th><th>Content type</th><th>Pricing category</th><th>Included</th><th>Confidence</th><th>Suggested components</th><th></th></tr></thead>
        <tbody>${pageRows.map(({ e, i, ef }) => html`
          <tr class=${sel.has(i) ? 'sel' : ''} key=${e.key || e.url}>
            <td><input type="checkbox" aria-label="Select URL" checked=${sel.has(i)} onChange=${ev => { const n = new Set(sel); ev.target.checked ? n.add(i) : n.delete(i); setSel(n); }} /></td>
            <td style="min-width:260px;max-width:420px"><div class="url-cell"><a href=${e.url} target="_blank" rel="noopener">${e.url.replace(/^https?:\/\/[^/]+/, '') || '/'}</a></div><div class="tiny muted">${e.findings?.title || ''}</div>
              <div class="row wrap" style="gap:4px;margin-top:2px">${e.status === 'new' ? html`<${Badge} kind="accent">New<//>` : null}${e.status === 'changed' ? html`<${Badge} kind="warn">Changed<//>` : null}${e.status === 'not_seen' ? html`<${Badge}>Not seen in latest scan<//>` : null}${ef.edited ? html`<${Badge} kind="info">Edited<//>` : null}</div></td>
            <td class="small">${ef.contentType}${e.decision?.contentType ? html` <span class="tiny muted">(was ${e.findings?.contentType || 'blank'})</span>` : ''}</td>
            <td><select class="input" style="width:auto;padding:4px 6px" value=${ef.category} onChange=${ev => patch([i], { category: ev.target.value })} aria-label="Pricing category">${CATEGORIES.map(c => html`<option value=${c.id}>${c.short}</option>`)}</select>
              ${e.decision?.category && e.decision.category !== e.findings?.category ? html`<div class="tiny muted">Scan: ${CATEGORY_BY_ID[e.findings?.category]?.short || 'n/a'}</div>` : null}</td>
            <td><label class="check"><input type="checkbox" checked=${ef.include} onChange=${ev => patch([i], { include: ev.target.checked })} />${ef.category === 'ARCHIVE' ? 'Regenerate' : (ef.include ? 'Yes' : 'No')}</label></td>
            <td>${ef.reviewed ? html`<${Badge} kind="ok">Reviewed<//>` : ef.needsReview ? html`<${Badge} kind="danger">Needs review<//>` : html`<${Badge} kind=${e.findings?.confidence === 'high' ? 'ok' : ''}>${e.findings?.confidence || 'n/a'}<//>`}</td>
            <td class="tiny">${(ef.blocks || []).join(', ')}</td>
            <td><button class="icon-btn" aria-label="Details" aria-expanded=${open === i} onClick=${() => setOpen(open === i ? null : i)}>${open === i ? '−' : '+'}</button></td>
          </tr>
          ${open === i ? html`<tr><td></td><td colspan="7" style="background:var(--surface-2)"><div class="grid2">
            <div class="small"><div class="caps muted">Scan finding (kept as recorded)</div>
              <div><b>${CATEGORY_BY_ID[e.findings?.category]?.label || 'n/a'}</b> · ${e.findings?.contentType || ''}</div>
              <div>Reason: ${e.findings?.reason}</div><div class="muted">Evidence: ${e.findings?.evidence}</div>
              ${e.findings?.headings ? html`<div class="muted">Headings: ${e.findings.headings}</div>` : null}
              ${e.findings?.fetchError ? html`<div style="color:var(--danger)">Fetch error: ${e.findings.fetchError}</div>` : null}
              ${e.previousFindings ? html`<div class="muted">Previous scan: ${CATEGORY_BY_ID[e.previousFindings.category]?.label} · ${e.previousFindings.reason}</div>` : null}</div>
            <div class="small stack" style="gap:6px"><div class="caps muted">Your decision</div>
              <label class="field"><span>Content type</span><${TextInput} value=${e.decision?.contentType ?? ''} placeholder=${e.findings?.contentType || ''} onChange=${v => patch([i], { contentType: v || undefined })} /></label>
              <label class="field"><span>Note</span><${TextInput} value=${e.decision?.notes ?? ''} onChange=${v => patch([i], { notes: v })} /></label>
              <div class="row"><label class="check"><input type="checkbox" checked=${!!e.decision?.reviewed} onChange=${ev => patch([i], { reviewed: ev.target.checked })} /> Reviewed</label>
              <button class="btn small ghost" onClick=${() => reset(i)}>Reset to scan finding</button></div></div>
          </div></td></tr>` : null}`)}
        </tbody></table></div>
      <div class="spread" style="padding:10px 14px"><span class="small muted">Showing ${fmtInt(Math.min(filtered.length, page * PAGE + 1))} to ${fmtInt(Math.min(filtered.length, (page + 1) * PAGE))} of ${fmtInt(filtered.length)}</span>
        <div class="row"><button class="btn small" disabled=${page === 0} onClick=${() => setPage(page - 1)}>Previous</button><button class="btn small" disabled=${(page + 1) * PAGE >= filtered.length} onClick=${() => setPage(page + 1)}>Next</button></div></div>
    </div>
    ${modal}
  </div>`;
}

// Per site type: sites, sampled sites, per site averages and the extrapolated totals that feed the quote.
export function PortfolioCard({ pf, quote, action }) {
  const cols = [['L1', 'Level 1'], ['L2', 'Level 2'], ['L3', 'Level 3'], ['BULK_STATIC', 'Bulk static'], ['RECORD', 'Records']];
  const one = v => (Math.round(v * 10) / 10).toLocaleString();
  return html`<div class="card">
    <div class="spread"><h2>Portfolio</h2>${action}</div>
    <p class="small muted">${fmtInt(pf.totalSites)} site${pf.totalSites === 1 ? '' : 's'} across ${pf.groups.length} site type${pf.groups.length === 1 ? '' : 's'}.${pf.extrapolated ? ' Totals for partly sampled site types are extrapolated: the average per analysed sample, multiplied by the number of sites.' : ''}${(quote.portfolio?.existingLiveSites || 0) > 0 ? ` ${fmtInt(quote.portfolio.existingLiveSites)} sites are already live.` : ''} Edit site types in <a href=${`#/quote/${quote.id}/sites`}>Sites</a>.</p>
    ${pf.missing.length ? html`<div class="banner warn small">No figures yet for ${pf.missing.join(', ')}. Analyse a sample or enter per site figures in Sites.</div>` : null}
    <div class="scroll-x"><table class="t" style="margin-top:8px"><thead><tr><th>Site type</th><th class="num">Sites</th><th>Basis</th>${cols.map(([, l]) => html`<th class="num">${l}</th>`)}</tr></thead><tbody>
      ${pf.groups.map(g => html`<tr><td><b>${g.name}</b></td><td class="num">${fmtInt(g.count)}</td>
        <td class="small">${g.source === 'scan' ? (g.exact ? `All ${fmtInt(g.sampled)} analysed` : `${fmtInt(g.sampled)} sample${g.sampled === 1 ? '' : 's'} analysed, extrapolated`) : g.source === 'manual' ? 'Per site figures entered' : html`<span style="color:var(--danger)">No figures</span>`}</td>
        ${cols.map(([c]) => html`<td class="num">${fmtInt(g.totals[c])}${!g.exact && g.source !== 'none' ? html`<div class="tiny muted">${one(g.perSite[c])} per site</div>` : null}</td>`)}</tr>`)}
      <tr><td><b>Total</b></td><td class="num"><b>${fmtInt(pf.totalSites)}</b></td><td></td>${cols.map(([c]) => html`<td class="num"><b>${fmtInt(pf.totals[c])}</b></td>`)}</tr>
    </tbody></table></div></div>`;
}

function BulkType({ onApply }) {
  const [v, setV] = useState('');
  return html`<span class="row" style="gap:4px"><input class="input" style="width:150px;padding:4px 8px" placeholder="Content type" value=${v} onInput=${e => setV(e.target.value)} /><button class="btn small" disabled=${!v.trim()} onClick=${() => { onApply(v.trim()); setV(''); }}>Set type</button></span>`;
}

function ApplyModal({ proposal, quote, onClose, onApply }) {
  const [rows, setRows] = useState(proposal.rows);
  const set = (i, p) => setRows(rows.map((r, j) => {
    if (j !== i) return r;
    const n = { ...r, ...p };
    if ('proposed' in p) { // recompute the investment change for an edited quantity
      const item = quote.pricingSnapshot.items.find(x => x.id === r.id);
      const line = quote.lines?.[r.id] || {};
      const prior = Number(line.priorQty) || 0;
      const p = effectivePricing(item, line);
      const pr = prior > 0 ? pricedFrom(p, prior, n.proposed) : priceForQuantity(p, n.proposed);
      n.proposedAmount = pr.status === 'priced' ? pr.amount : null;
      n.change = n.proposedAmount !== null && r.currentAmount !== null ? n.proposedAmount - r.currentAmount : null;
    }
    return n;
  }));
  const chosen = rows.filter(r => r.selected);
  const delta = chosen.reduce((a, r) => a + (r.change ?? 0), 0);
  return html`<${Modal} title="Review and apply quantities" onClose=${onClose} footer=${html`<span class="small muted grow">Investment change from selected rows: <b>${delta >= 0 ? '+' : ''}${fmtMoney(delta)}</b></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!chosen.length} onClick=${() => onApply(rows)}>Apply ${chosen.length} quantit${chosen.length === 1 ? 'y' : 'ies'}</button>`}>
    <p class="small">Proposed quantities come from the included, reviewed inventory. Nothing changes until you apply. Rows you set manually are unticked by default. New content models, components and integrations are never inferred from URL counts; review those in Scope${quote.foundation ? ` against what ${quote.foundation.name} already provides` : ''}.</p>
    <table class="t"><thead><tr><th></th><th>Item</th><th class="num">Current</th><th class="num">Proposed</th><th class="num">Investment change</th><th>Basis</th></tr></thead>
      <tbody>${rows.map((r, i) => html`<tr>
        <td><input type="checkbox" checked=${r.selected} aria-label=${'Apply ' + r.name} onChange=${e => set(i, { selected: e.target.checked })} /></td>
        <td><b>${r.name}</b>${r.manual ? html` <${Badge} kind="info">Set manually<//>` : null}${r.state !== 'included' ? html`<div class="tiny muted">Currently ${r.state}${Number(r.proposed) > 0 ? '; applying includes it' : ''}</div>` : null}</td>
        <td class="num">${r.current === null ? 'n/a' : fmtInt(r.current)}</td>
        <td class="num">${r.editable ? html`<${NumInput} value=${r.proposed} onChange=${v => set(i, { proposed: v ?? 0, selected: true })} />` : fmtInt(r.proposed)}</td>
        <td class="num">${r.change === null ? 'n/a' : `${r.change >= 0 ? '+' : ''}${fmtMoney(r.change)}`}</td>
        <td class="small">${r.basis}${r.note ? html`<div class="tiny muted">${r.note}</div>` : null}</td></tr>`)}</tbody></table>
    <h3 style="margin-top:14px">Assumptions added to the proposal for applied rows</h3>
    <ul class="small" style="padding-left:18px">${chosen.map(r => html`<li>${r.assumption}</li>`)}</ul>
  <//>`;
}

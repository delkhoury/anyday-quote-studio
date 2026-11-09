import { useState, useMemo, useEffect, useRef } from 'preact/hooks';
import { html, Badge, Field, TextInput, ListEditor, toast } from '../ui.js';
import { renderProposal, derivedAssumptions, proposalReadiness, suggestedIntro } from '../../shared/proposal.js';
import { askConfirm } from '../ui.js';
import { fmtMoney } from '../../shared/format.js';
import { schedulePlan } from '../../shared/plan.js';
import { computeMargin } from '../../shared/margin.js';
import { download } from '../api.js';

export function InvestmentStep({ api, quote, update, calc, health, flush, go, admin, library }) {
  const pr = quote.proposal || {};
  const setP = patch => update(q => ({ ...q, proposal: { ...(q.proposal || {}), ...patch } }));
  const [view, setView] = useState('live');
  const [pdfUrl, setPdfUrl] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const htmlDoc = useMemo(() => { try { return renderProposal(quote, { calc, mode: 'draft', screen: true, assetBase: window.__FONT_CSS__ ? null : '/assets', logoUrl: window.__LOGO_WHITE__ || '/assets/anyday-logo-white.png', lorienUrl: window.__LORIEN__ || '', fontCssHref: window.__FONT_CSS__ || '' }); } catch (e) { return `<p>${e.message}</p>`; } }, [quote, calc]);
  const frame = useRef(null);
  useEffect(() => () => pdfUrl && URL.revokeObjectURL(pdfUrl), [pdfUrl]);
  const readiness = proposalReadiness(quote, calc);
  const dismissed = new Set(pr.dismissedAuto || []);
  const autos = [...new Set([...(pr.autoAssumptions || []), ...derivedAssumptions(quote, calc)])];

  async function pdf(mode, open) {
    setErr(null); setBusy(mode);
    try {
      await flush();
      const blob = await api.pdf(quote.id, mode, !!pr.includeAppendix);
      if (open) { setPdfUrl(URL.createObjectURL(blob)); setView('pdf'); }
      else download(`${quote.number}-${mode === 'final' ? 'proposal' : 'draft'}.pdf`, blob, 'application/pdf');
      if (mode === 'final') toast('Final proposal exported');
    } catch (e) { setErr(e.details ? `${e.message} ${[].concat(e.details).join('; ')}` : e.message); }
    finally { setBusy(null); }
  }

  return html`<div class="layout-rail layout-invest">
    <div class="stack">
      <div class="card">
        <h2>Investment</h2>
        ${calc.sections.filter(s => !s.empty).map(s => html`<div class="money-row"><b>${s.order}. ${s.name}</b><b class="num">${fmtMoney(s.subtotal)}${s.pending ? ' + pending' : ''}</b></div>
          ${s.id === 'base' ? html`<div class="money-row sub"><span>Implementation scope</span><span class="num">${fmtMoney(s.implementationSubtotal)}</span></div><div class="money-row sub"><span>Design scope${s.designAllocated ? `, ${fmtMoney(s.designAllocated)} allocated from existing fees` : ''}</span><span class="num">${fmtMoney(s.designSubtotal)}${s.design.some(d => d.amount === null) ? ' + pending' : ''}</span></div>` : null}`)}
        <div class="total-box"><div class="caps" style="opacity:.8">${calc.totalStatus === 'starting_at' ? 'Total investment, starting at' : 'Total investment'} · USD</div><div class="v">${fmtMoney(calc.total)}</div>
          ${calc.totalStatus === 'pending' ? html`<div class="small">+ ${calc.blockers.length} item${calc.blockers.length === 1 ? '' : 's'} pending</div>` : null}</div>
        <div class="tiny muted" style="margin-top:8px">${calc.optional.length + calc.additions.length} optional additions are listed separately and are not part of this total.</div>
        ${calc.blockers.length ? html`<div class="banner danger small" style="margin-top:10px"><b>Final export blocked.</b><ul style="margin:4px 0 0;padding-left:18px">${calc.blockers.map(b => html`<li>${b.message}</li>`)}</ul><a href=${`#/quote/${quote.id}/scope`}>Resolve in Scope →</a></div>` : null}
        ${calc.warnings.length ? html`<div class="banner warn small" style="margin-top:10px"><ul style="margin:0;padding-left:18px">${calc.warnings.map(w => html`<li>${w.message}</li>`)}</ul></div>` : null}
      </div>

      ${admin ? html`<${MarginCard} api=${api} quote=${quote} calc=${calc} library=${library} />` : null}
      <div class="card stack">
        <h2>Export</h2>
        ${!health?.pdf ? html`<div class="banner warn small">${health?.mode === 'prototype' ? 'PDF export needs the Anyday Quote Studio server. The live preview works here.' : 'Chromium was not found on the server, so PDF export is unavailable. See the setup guide.'}</div>` : null}
        <label class="check"><input type="checkbox" checked=${!!pr.includeAppendix} onChange=${e => setP({ includeAppendix: e.target.checked })} /> Include the full URL inventory as an appendix</label>
        <div class="row wrap">
          <button class="btn" disabled=${!health?.pdf || busy} onClick=${() => pdf('draft', true)}>${busy === 'draft' ? 'Rendering…' : 'View PDF pages'}</button>
          <button class="btn" disabled=${!health?.pdf || busy} onClick=${() => pdf('draft', false)}>Download draft PDF</button>
          <button class="btn primary" disabled=${!health?.pdf || busy || !calc.canExportFinal} title=${calc.canExportFinal ? '' : 'Resolve the items marked Price needed or Quantity needed first'} onClick=${() => pdf('final', false)}>${busy === 'final' ? 'Rendering…' : 'Export final PDF'}</button>
        </div>
        <div class="row wrap">
          <button class="btn small" onClick=${async () => { await flush(); api.exportCsv(quote); }}>URL inventory (CSV)</button>
          <button class="btn small" onClick=${() => download(`${quote.number}.json`, quote)}>Quote (JSON)</button>
        </div>
        ${err ? html`<div class="banner danger small">${err}</div>` : null}
        ${readiness.length ? html`<ul class="small muted" style="margin:0;padding-left:18px">${readiness.map(r => html`<li>${r}</li>`)}</ul>` : null}
      </div>

      <div class="card stack">
        <h2>Proposal content</h2>
        <${Field} label="Project introduction"><${TextInput} multiline rows=${7} value=${pr.intro} onChange=${v => setP({ intro: v })} placeholder="What the client wants and how Anyday will deliver it. Blank lines start new paragraphs." /><//>
        <div><button class="btn small" onClick=${async () => { if (!pr.intro?.trim() || await askConfirm('Replace the current introduction with a suggested one for this quote type?', 'Replace')) setP({ intro: suggestedIntro(quote, calc) }); }}>Suggest an introduction</button> <span class="tiny muted">Written from the quote type, foundation and portfolio. Edit it freely.</span></div>
        <${Field} label="Assumptions"><${ListEditor} items=${pr.assumptions || []} onChange=${v => setP({ assumptions: v })} placeholder="Add an assumption" /><//>
        ${autos.length ? html`<div><div class="caps muted" style="margin-bottom:4px">Generated from scope decisions</div>${autos.map(a => html`<label class="check small" style="align-items:flex-start;margin-bottom:4px"><input type="checkbox" checked=${!dismissed.has(a)} onChange=${e => setP({ dismissedAuto: e.target.checked ? [...dismissed].filter(x => x !== a) : [...dismissed, a] })} /><span>${a}</span></label>`)}</div>` : null}
        <${Field} label="Exclusions"><${ListEditor} items=${pr.exclusions || []} onChange=${v => setP({ exclusions: v })} placeholder="Add an exclusion" /><//>
        <${Field} label="Payment terms" hint="Left blank, this section is omitted. Nothing is assumed."><${TextInput} multiline rows=${3} value=${pr.paymentTerms} onChange=${v => setP({ paymentTerms: v })} /><//>
        <${Field} label="Validity period" hint="i.e. Valid for 30 days from the date of issue."><${TextInput} value=${pr.validity} onChange=${v => setP({ validity: v })} /><//>
        <${Field} label="Timeline (optional)" hint="Only shown when entered. No timeline is generated."><${TextInput} multiline rows=${2} value=${pr.timeline} onChange=${v => setP({ timeline: v })} /><//>
      </div>
    </div>
    <div class="stack preview-col">
      <div class="row"><button class=${'btn small' + (view === 'live' ? ' dark' : '')} onClick=${() => setView('live')}>Live preview</button><button class=${'btn small' + (view === 'pdf' ? ' dark' : '')} disabled=${!pdfUrl} onClick=${() => setView('pdf')}>PDF pages</button>
        <span class="tiny muted">${view === 'live' ? 'Same HTML and styles the PDF is printed from. Page headers, footers and page numbers appear in the PDF view.' : 'Rendered by the server exactly as exported (draft).'}</span></div>
      <div class="preview-wrap">${view === 'pdf' && pdfUrl ? html`<iframe title="PDF preview" src=${pdfUrl}></iframe>` : html`<iframe ref=${frame} title="Proposal preview" srcdoc=${htmlDoc} sandbox="allow-same-origin"></iframe>`}</div>
    </div>
  </div>`;
}

// Admin only: anticipated gross margin from the planned hours and the team's cost rates.
function MarginCard({ api, quote, calc, library }) {
  const [team, setTeam] = useState(null);
  const [settings, setSettings] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.team().then(setTeam).catch(() => {}); api.settings().then(setSettings).catch(() => {}); }, []);
  const m = useMemo(() => (team && settings ? computeMargin(calc, schedulePlan(quote, { team, library }), team, settings) : null), [quote, calc, team, settings, library]);
  if (!m) return html`<div class="card"><div class="caps">Admin only</div><div class="small muted">Loading margin…</div></div>`;
  const pct = v => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 1000) / 10}%`);
  const tone = v => (v === null ? '' : v * 100 < (m.target ?? 0) ? 'color:var(--danger)' : 'color:var(--ok)');
  const worst = m.rows.filter(r => r.revenue && r.cost).sort((a, b) => a.margin - b.margin).slice(0, 8);
  return html`<div class="card stack">
    <div class="spread"><div><div class="caps">Admin only</div><h2 style="margin-top:2px">Gross margin</h2></div>
      <div style="text-align:right"><div style=${`font-family:var(--display);font-size:34px;line-height:1;${tone(m.margin)}`}>${pct(m.margin)}</div><div class="tiny muted">${m.target != null ? `target ${m.target}%` : ''}</div></div></div>
    <div class="money-row"><span>Investment${m.pending ? ' (priced items only)' : ''}</span><b class="num">${fmtMoney(m.revenue)}</b></div>
    <div class="money-row"><span>Delivery cost · ${Math.round(m.hours).toLocaleString()} hours</span><b class="num">${fmtMoney(m.cost)}</b></div>
    ${m.internalCost ? html`<div class="money-row sub"><span>of which internal tasks</span><span class="num">${fmtMoney(m.internalCost)}</span></div>` : null}
    <div class="money-row"><span><b>Gross profit</b></span><b class="num">${fmtMoney(m.gp)}</b></div>
    ${m.effectiveRate ? html`<div class="money-row sub"><span>Price per planned hour</span><span class="num">${fmtMoney(m.effectiveRate * 100)}/h</span></div>` : null}
    ${m.bySection.map(s => html`<div class="money-row sub"><span>${s.name}</span><span class="num" style=${tone(s.margin)}>${pct(s.margin)}</span></div>`)}
    ${m.notes.length ? html`<ul class="small" style="margin:0;padding-left:18px;color:var(--warn)">${m.notes.map(n => html`<li>${n}</li>`)}</ul>` : null}
    ${worst.length ? html`<details class="more" open=${open} onToggle=${e => setOpen(e.target.open)}><summary class="small">Lowest margin deliverables</summary>
      <table class="t" style="margin-top:6px"><thead><tr><th>Deliverable</th><th class="num">Price</th><th class="num">Cost</th><th class="num">Margin</th></tr></thead><tbody>
      ${worst.map(r => html`<tr><td class="small">${r.name}</td><td class="num small">${fmtMoney(r.revenue)}</td><td class="num small">${fmtMoney(r.cost)}</td><td class="num small" style=${tone(r.margin)}>${pct(r.margin)}</td></tr>`)}</tbody></table></details>` : null}
    <div class="tiny muted">Cost = planned hours × each person's Clockify cost rate (${m.costCurrency} at ${m.fx} USD). Hours come from the Plan step and the Pricing Library. Change rates and the target under Team.</div>
  </div>`;
}

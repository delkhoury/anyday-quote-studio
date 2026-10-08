import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import { html, Badge, Field, TextInput, Modal, toast, askConfirm } from '../ui.js';
import { calculateQuote } from '../../shared/pricing.js';
import { fmtMoney, fmtDate } from '../../shared/format.js';
import { download } from '../api.js';
import { AnalyseStep } from './analyse.js';
import { ReviewStep } from './review.js';
import { ScopeStep } from './scope.js';
import { InvestmentStep } from './investment.js';
import { SitesStep } from './sites.js';
import { quoteTypeOf, quoteTypes } from '../../shared/quote.js';

// The steps depend on the quote type: portfolios get a Sites step and analyse samples.
export function stepsFor(quote) {
  const t = quoteTypeOf(quote);
  return [
    { id: 'setup', t: 'Setup', s: t.name },
    ...(t.sitesStep ? [{ id: 'sites', t: 'Sites', s: 'Site types, counts, samples' }] : []),
    { id: 'analyse', t: t.sitesStep ? 'Analyse samples' : 'Analyse website', s: 'Sitemaps, pages and media' },
    { id: 'review', t: 'Review', s: t.sitesStep ? 'Inventory and portfolio totals' : 'Confirm classifications' },
    { id: 'scope', t: 'Scope', s: 'Implementation, design, migration' },
    { id: 'investment', t: 'Investment', s: 'Proposal preview and export' },
  ];
}

// Load, edit and autosave one quote.
function useQuote(api, id) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('saved');
  const base = useRef(null); const timer = useRef(null); const latest = useRef(null); const saving = useRef(false);
  useEffect(() => {
    let live = true;
    api.quote(id).then(q => { if (!live) return; base.current = q.updatedAt; latest.current = q; setQuote(q); }).catch(e => live && setError(e.message));
    return () => { live = false; clearTimeout(timer.current); };
  }, [id]);
  const save = useCallback(async () => {
    if (saving.current) { timer.current = setTimeout(save, 300); return; }
    saving.current = true; setStatus('saving');
    const q = latest.current;
    try {
      const saved = await api.saveQuote(q, base.current);
      base.current = saved.updatedAt;
      if (latest.current === q) { latest.current = saved; setQuote(saved); }
      else latest.current = { ...latest.current, number: saved.number, updatedAt: saved.updatedAt };
      setStatus(latest.current === saved ? 'saved' : 'pending');
    } catch (e) {
      setStatus('error'); setError(e.status === 409 ? 'This quote was changed in another window. Reload to see the latest version; your unsaved edits are still on screen.' : e.message);
    } finally { saving.current = false; }
  }, [api]);
  const update = useCallback(fn => {
    const next = typeof fn === 'function' ? fn(latest.current) : fn;
    latest.current = next; setQuote(next); setStatus('pending');
    clearTimeout(timer.current); timer.current = setTimeout(save, 700);
  }, [save]);
  const replace = useCallback(q => { base.current = q.updatedAt; latest.current = q; setQuote(q); setStatus('saved'); }, []);
  const flush = useCallback(async () => { clearTimeout(timer.current); if (status !== 'saved') await save(); }, [save, status]);
  return { quote, update, replace, status, error, setError, flush };
}

export function QuoteEditor({ api, id, step: stepIn = 'setup', health, library, go }) {
  const { quote, update, replace, status, error, setError, flush } = useQuote(api, id);
  const calc = useMemo(() => { if (!quote) return null; try { return calculateQuote(quote); } catch (e) { return { error: e.message }; } }, [quote]);
  if (error && !quote) return html`<div class="banner danger">${error}</div>`;
  if (!quote || !calc) return html`<div class="empty">Loading quote…</div>`;
  const ctx = { api, quote, update, replace, calc, health, library, go, flush };
  const STEPS = stepsFor(quote);
  const step = stepIn === 'details' ? 'setup' : (STEPS.some(x => x.id === stepIn) ? stepIn : 'setup');
  const idx = STEPS.findIndex(s => s.id === step);
  const Step = { setup: SetupStep, sites: SitesStep, analyse: AnalyseStep, review: ReviewStep, scope: ScopeStep, investment: InvestmentStep }[step] || SetupStep;
  return html`
    <div class="page-head">
      <div>
        <div class="eyebrow">${quote.number || 'New quote'}${quote.example ? ' · Example' : ''}</div>
        <h1>${quote.client?.name || 'Untitled client'}</h1>
        <div class="muted" style="margin-top:6px">${quoteTypeOf(quote).name}${quote.foundation ? ` · ${quote.foundation.name}` : ''} · ${quote.project?.name || 'No project name yet'}${quote.project?.url ? html` · <a href=${quote.project.url} target="_blank" rel="noopener">${quote.project.url.replace(/^https?:\/\//, '')}</a>` : ''}</div>
      </div>
      <div class="row wrap">
        <span class="saved" aria-live="polite">${{ saved: 'All changes saved', saving: 'Saving…', pending: 'Unsaved changes', error: 'Not saved' }[status]}</span>
        <button class="btn" onClick=${() => download(`${quote.number || 'quote'}.json`, quote)}>Export quote</button>
        <button class="btn" onClick=${async () => { await flush(); const c = await api.duplicateQuote(quote.id); toast(`Duplicated as ${c.number}`); go(`#/quote/${c.id}/setup`); }}>Duplicate</button>
      </div>
    </div>
    ${error ? html`<div class="banner danger" style="margin-bottom:12px">${error} <button class="btn small" onClick=${() => setError(null)}>Dismiss</button></div>` : null}
    ${calc.error ? html`<div class="banner danger">Calculation error: ${calc.error}</div>` : null}
    ${quote.example ? html`<div class="banner warn" style="margin-bottom:12px"><b>${quote.example.label}.</b> Built from ${quote.example.workbook} (${quote.example.workbookDate}). The inventory is a dated example, not a fresh scan; page levels and component redesign selections are provisional.</div>` : null}
    <nav class="stepper" aria-label="Quote steps" style=${`grid-template-columns:repeat(${STEPS.length},1fr)`}>
      ${STEPS.map((s, i) => html`<a href=${`#/quote/${quote.id}/${s.id}`} class=${i === idx ? 'active' : ''} aria-current=${i === idx ? 'step' : null}><div class="n">${i + 1}</div><div class="t">${s.t}</div><div class="s">${s.s}</div></a>`)}
    </nav>
    ${step === 'investment' ? html`<${Step} ...${ctx} />` : html`<div class="layout-rail"><div class="grow"><${Step} ...${ctx} /></div><${Rail} calc=${calc} quote=${quote} go=${go} /></div>`}
    <div class="spread" style="margin-top:22px">
      ${idx > 0 ? html`<a class="btn" href=${`#/quote/${quote.id}/${STEPS[idx - 1].id}`}>← ${STEPS[idx - 1].t}</a>` : html`<span></span>`}
      ${idx < STEPS.length - 1 ? html`<a class="btn dark" href=${`#/quote/${quote.id}/${STEPS[idx + 1].id}`}>${STEPS[idx + 1].t} →</a>` : null}
    </div>`;
}

export function Rail({ calc, quote, go }) {
  return html`<aside class="rail card" aria-label="Investment summary">
    <h3>Investment</h3>
    ${calc.sections.map(s => html`
      <div class="money-row"><span>${s.name}</span><b class="num">${s.empty ? 'n/a' : fmtMoney(s.subtotal)}${s.pending ? '+' : ''}</b></div>
      ${s.id === 'base' && !s.empty ? html`<div class="money-row sub"><span>Implementation</span><span class="num">${fmtMoney(s.implementationSubtotal)}</span></div>
        <div class="money-row sub"><span>Design${s.designAllocated ? ' (incl. allocated)' : ''}</span><span class="num">${fmtMoney(s.designSubtotal)}${s.design.some(d => d.amount === null) ? '+' : ''}</span></div>` : null}`)}
    <div class="total-box">
      <div class="caps" style="opacity:.8">${calc.totalStatus === 'starting_at' ? 'Total, starting at' : 'Total investment'} · USD</div>
      <div class="v">${fmtMoney(calc.total)}</div>
      ${calc.totalStatus === 'pending' ? html`<div class="small" style="margin-top:6px">Plus ${calc.blockers.length} item${calc.blockers.length === 1 ? '' : 's'} pending</div>` : null}
    </div>
    ${calc.blockers.length ? html`<div style="margin-top:12px"><div class="caps" style="color:var(--danger)">Blocks final export</div>
      <ul class="small" style="padding-left:18px;margin:6px 0">${calc.blockers.slice(0, 8).map(b => html`<li>${b.message}</li>`)}</ul>
      <a class="small" href=${`#/quote/${quote.id}/scope`}>Resolve in Scope →</a></div>` : html`<div class="banner ok small" style="margin-top:12px">Ready for final export</div>`}
    ${calc.warnings.length ? html`<details style="margin-top:10px"><summary class="small" style="cursor:pointer;font-weight:700;color:var(--warn)">${calc.warnings.length} check${calc.warnings.length === 1 ? '' : 's'} to review</summary><ul class="small" style="padding-left:18px">${calc.warnings.map(w => html`<li>${w.message}</li>`)}</ul></details>` : null}
    <div class="tiny muted" style="margin-top:10px">${calc.optional.length} optional additions are listed separately and never count toward the total.</div>
  </aside>`;
}

function SetupStep({ api, quote, update, replace, library, flush }) {
  const [diff, setDiff] = useState(null);
  const [fdiff, setFdiff] = useState(null);
  const [foundations, setFoundations] = useState(null);
  const [pickF, setPickF] = useState('');
  useEffect(() => { api.foundations().then(setFoundations).catch(() => setFoundations([])); }, []);
  const set = (path, v) => update(q => { const n = { ...q }; const [a, b] = path.split('.'); n[a] = b ? { ...(q[a] || {}), [b]: v } : v; return n; });
  const snap = quote.pricingSnapshot;
  const type = quoteTypeOf(quote);
  const libChanged = library && (library.updatedAt !== snap.libraryUpdatedAt || library.version !== snap.libraryVersion);
  const current = quote.foundation && (foundations || []).find(f => f.id === quote.foundation.id);
  const fChanged = current && current.updatedAt !== quote.foundation.updatedAt;
  async function review() { await flush(); setDiff(await api.applyLibrary(quote.id, false)); }
  async function apply() { const r = await api.applyLibrary(quote.id, true); replace(r.quote); setDiff(null); toast('Current library pricing applied to this quote'); }
  async function reviewF(fid) { await flush(); setFdiff({ fid, ...(await api.applyFoundation(quote.id, fid, false)) }); }
  async function applyF() { const r = await api.applyFoundation(quote.id, fdiff.fid, true); replace(r.quote); setFdiff(null); setPickF(''); toast(`Foundation snapshot updated from ${r.quote.foundation.name}`); }
  return html`<div class="stack">
    <div class="card"><h2>Client and project</h2>
      <div class="grid2" style="margin-top:12px">
        <${Field} label="Client"><${TextInput} value=${quote.client?.name} onChange=${v => set('client.name', v)} placeholder="Organisation name" /><//>
        <${Field} label="Parent organisation" hint="The organisation the client belongs to, if any."><${TextInput} value=${quote.client?.parentOrg} onChange=${v => set('client.parentOrg', v)} /><//>
        <${Field} label="Project"><${TextInput} value=${quote.project?.name} onChange=${v => set('project.name', v)} placeholder="Project name" /><//>
        <${Field} label=${type.sitesStep ? 'Main website URL (optional)' : 'Website URL'} hint=${type.sitesStep ? 'Sample sites for each site type are set in Sites.' : 'Used by Analyse website. Subdomains and external sites stay separate unless you include them.'}><${TextInput} value=${quote.project?.url} onChange=${v => set('project.url', v.trim())} placeholder="https://example.org" /><//>
        <${Field} label="Client contact (internal)"><${TextInput} value=${quote.client?.contact} onChange=${v => set('client.contact', v)} placeholder="Name, email" /><//>
        <${Field} label="Prepared by"><${TextInput} value=${quote.preparedBy} onChange=${v => set('preparedBy', v)} /><//>
        <${Field} label="Quote number"><input class="input" value=${quote.number || 'Assigned on save'} disabled /><//>
      </div>
    </div>
    <div class="card"><div class="spread"><h2>Quote type</h2><${Badge} kind="accent">${type.name}<//></div>
      <p class="small">${type.description}</p>
      <${Field} label="Change the type" hint="Changes the steps and the proposal wording. Lines and quantities already chosen are kept; adjust them in Scope.">
        <select class="input" style="max-width:420px" value=${quote.type} onChange=${e => update(q => ({ ...q, type: e.target.value }))}>${quoteTypes(snap).map(t => html`<option value=${t.id} disabled=${t.usesFoundation === 'required' && !quote.foundation}>${t.name}${t.usesFoundation === 'required' && !quote.foundation ? ' (needs a foundation)' : ''}</option>`)}</select><//>
    </div>
    <div class="card"><div class="spread"><h2>Foundation</h2>${quote.foundation ? (fChanged ? html`<${Badge} kind="warn">Foundation has changed<//>` : html`<${Badge} kind="ok">Up to date<//>`) : html`<${Badge}>None<//>`}</div>
      ${quote.foundation ? html`<p class="small">This quote ${quote.type === 'new_platform' ? 'starts from' : 'reuses'} <b>${quote.foundation.name}</b>${quote.foundation.owner ? ` (${quote.foundation.owner})` : ''}: ${quote.foundation.components.length} components, ${(quote.foundation.integrations || []).length} integrations. It keeps its own snapshot taken ${fmtDate(quote.foundation.takenAt)}. Component choices are made in Scope.</p>
        <button class="btn" disabled=${!fChanged} onClick=${() => reviewF(quote.foundation.id)}>Refresh from the current foundation</button>`
        : html`<p class="small">${type.usesFoundation === 'required' ? 'This quote type needs a foundation. Choose one below.' : 'A new platform built from scratch. You can start from an existing foundation if Anyday is reusing one.'}</p>`}
      <div class="row wrap" style="margin-top:10px"><select class="input" style="max-width:360px" value=${pickF} onChange=${e => setPickF(e.target.value)} aria-label="Foundation">
        <option value="">${quote.foundation ? 'Switch to another foundation…' : 'Choose a foundation…'}</option>
        ${(foundations || []).filter(f => !f.archived && f.id !== quote.foundation?.id).map(f => html`<option value=${f.id}>${f.name}</option>`)}</select>
        <button class="btn" disabled=${!pickF} onClick=${() => reviewF(pickF)}>Review</button>
        ${quote.foundation && type.usesFoundation !== 'required' ? html`<button class="btn ghost" onClick=${async () => { if (await askConfirm('Remove the foundation from this quote? Component choices are discarded.', 'Remove foundation')) update(q => ({ ...q, foundation: null })); }}>Remove foundation</button>` : null}</div>
    </div>
    <div class="card"><div class="spread"><h2>Pricing snapshot</h2>${libChanged ? html`<${Badge} kind="warn">Library has changed<//>` : html`<${Badge} kind="ok">Matches library<//>`}</div>
      <p class="small">This quote keeps its own copy of the Pricing Library taken ${fmtDate(snap.takenAt)} (library version ${snap.libraryVersion}). Library edits affect new quotes only. Existing quotes change only when you apply current pricing here. Quote specific overrides are kept.</p>
      <button class="btn" onClick=${review} disabled=${!libChanged}>Review current library pricing</button>
    </div>
    ${quote.provisional?.length ? html`<div class="card"><h3>Provisional notes from the source workbook</h3><ul class="small" style="padding-left:18px;margin:0">${quote.provisional.map(p => html`<li>${p}</li>`)}</ul></div>` : null}
    <details class="card more"><summary>History (${(quote.history || []).length})</summary><ul class="small" style="padding-left:18px">${(quote.history || []).slice().reverse().map(hh => html`<li>${fmtDate(hh.at)}: ${hh.kind.replace(/_/g, ' ')}${hh.changes !== undefined ? ` (${hh.changes} changes)` : ''}${hh.rows ? ` (${hh.rows.length} quantities)` : ''}</li>`)}</ul></details>
    ${diff ? html`<${Modal} title="Apply current library pricing" onClose=${() => setDiff(null)} footer=${html`<button class="btn" onClick=${() => setDiff(null)}>Cancel</button><button class="btn primary" disabled=${!diff.changes.length} onClick=${apply}>Apply to this quote</button>`}>
      <p>Total changes from <b>${fmtMoney(diff.before)}</b> to <b>${fmtMoney(diff.after)}</b> (priced items only). Quantities, states and quote specific overrides are kept.</p>
      ${diff.changes.length ? html`<table class="t"><thead><tr><th>Item</th><th>Change</th><th>Before</th><th>After</th></tr></thead><tbody>${diff.changes.map(c => html`<tr><td>${c.name}</td><td>${c.kind}</td><td class="small">${c.before || ''}</td><td class="small">${c.after || ''}</td></tr>`)}</tbody></table>` : html`<div class="empty">No pricing differences.</div>`}
    <//>` : null}
    ${fdiff ? html`<${Modal} narrow title="Update the foundation snapshot" onClose=${() => setFdiff(null)} footer=${html`<button class="btn" onClick=${() => setFdiff(null)}>Cancel</button><button class="btn primary" onClick=${applyF}>Apply to this quote</button>`}>
      <p>The quote will use ${fdiff.components} components from <b>${(foundations || []).find(f => f.id === fdiff.fid)?.name}</b>. Redesign choices are kept for components with the same id; components added only in this quote are kept.</p>
      <p>Total changes from <b>${fmtMoney(fdiff.before)}</b> to <b>${fmtMoney(fdiff.after)}</b> (priced items only).</p>
    <//>` : null}
  </div>`;
}

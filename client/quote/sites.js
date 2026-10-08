// Sites: the portfolio being priced. Sites are grouped into site types; each type has a count,
// a few sample sites to analyse, or per site figures entered by hand when no sample can be scanned.
import { useState, useMemo } from 'preact/hooks';
import { html, Badge, Field, NumInput, TextInput, toast, askConfirm } from '../ui.js';
import { portfolioSummary, siteKeyOf, groupOf } from '../../shared/inventory.js';
import { parseSiteList, applySiteList } from '../../shared/sitelist.js';
import { fmtInt } from '../../shared/format.js';
import { readFileText } from '../api.js';
import { PortfolioCard } from './review.js';

const MANUAL = [['L1', 'Level 1 pages'], ['L2', 'Level 2 pages'], ['L3', 'Level 3 pages'], ['BULK_STATIC', 'Bulk static pages'], ['RECORD', 'Structured records'], ['ARCHIVE', 'Generated archives']];
const newId = () => 'type_' + Math.random().toString(36).slice(2, 8);

export function SitesStep({ quote, update }) {
  const groups = quote.siteGroups?.length ? quote.siteGroups : [];
  const pf = useMemo(() => portfolioSummary(quote), [quote]);
  const scanned = new Set((quote.inventory?.scans || []).map(s => s.site));
  const entryCount = useMemo(() => { const m = {}; for (const e of quote.inventory?.entries || []) { const g = groupOf(e, groups); m[g] = (m[g] || 0) + 1; } return m; }, [quote.inventory, groups]);
  const [msg, setMsg] = useState(null);
  const setGroups = fn => update(q => ({ ...q, siteGroups: fn(q.siteGroups || []) }));
  const setGroup = (id, patch) => setGroups(gs => gs.map(g => g.id === id ? { ...g, ...patch } : g));
  const live = quote.portfolio?.existingLiveSites || 0;
  const siteList = quote.portfolio?.siteList || [];

  async function removeGroup(g) {
    const n = entryCount[g.id] || 0;
    if (groups.length === 1) return;
    if (!await askConfirm(`Remove the site type ${g.name}?${n ? ` Its ${fmtInt(n)} analysed URLs move to ${groups.find(x => x.id !== g.id).name}.` : ''}`, 'Remove site type')) return;
    update(q => {
      const rest = q.siteGroups.filter(x => x.id !== g.id);
      const entries = (q.inventory?.entries || []).map(e => e.groupId === g.id ? { ...e, groupId: rest[0].id } : e);
      return { ...q, siteGroups: rest, inventory: { ...q.inventory, entries } };
    });
  }
  async function importList(e) {
    const file = e.target.files[0]; if (!file) return; e.target.value = '';
    try {
      const { sites, skipped, columns } = parseSiteList(await readFileText(file));
      if (!sites.length) throw new Error('No sites found. Use a CSV with columns such as name, url, brand and site type.');
      const inUse = new Set(Object.keys(entryCount));
      update(q => ({ ...q, portfolio: { ...(q.portfolio || {}), siteList: sites }, siteGroups: applySiteList(q.siteGroups || [], sites, { inUse }) }));
      setMsg(`${fmtInt(sites.length)} sites imported from ${file.name}${skipped ? ` (${skipped} blank or duplicate rows skipped)` : ''}.${columns.siteType === undefined ? ' No site type column was found, so every site was added to the first site type.' : ''} Samples were picked for site types that had none.`);
    } catch (x) { setMsg(x.message); }
  }

  return html`<div class="stack">
    ${quote.type === 'expansion' ? html`<div class="card"><h2>Sites already live</h2>
      <div class="row wrap"><${Field} label="Live on the platform today" hint="Site activation continues the volume tiers from here, so new sites are priced at the rate the portfolio has already reached.">
        <${NumInput} cls="input" value=${live} onChange=${v => update(q => ({ ...q, portfolio: { ...(q.portfolio || {}), existingLiveSites: v || 0 }, lines: { ...q.lines, MIG_SITE_ACTIVATION: { ...(q.lines?.MIG_SITE_ACTIVATION || { state: 'included' }), priorQty: v || 0 } } }))} /><//></div></div>` : null}

    <div class="card">
      <div class="spread"><h2>Site types</h2>
        <div class="row wrap"><label class="btn">Import site list (CSV)<input type="file" accept=".csv,.tsv,.txt" class="hidden" onChange=${importList} /></label>
          <button class="btn" onClick=${() => setGroups(gs => [...gs, { id: newId(), name: `Site type ${gs.length + 1}`, count: 1, samples: [], manual: null, notes: '' }])}>Add site type</button></div></div>
      <p class="small">Group sites that share a template and similar content. Analyse one or two samples of each type; the quote extrapolates the rest. Where a sample cannot be scanned, enter typical per site figures instead.</p>
      ${msg ? html`<div class="banner info small">${msg}</div>` : null}
    </div>

    ${groups.map(g => {
      const pg = pf.groups.find(x => x.id === g.id);
      return html`<div class="card" key=${g.id}>
        <div class="grid3">
          <${Field} label="Site type"><${TextInput} value=${g.name} onChange=${v => setGroup(g.id, { name: v || g.name })} /><//>
          <${Field} label="Number of sites"><${NumInput} cls="input" value=${g.count} onChange=${v => setGroup(g.id, { count: Math.max(0, Math.round(v || 0)) })} /><//>
          <div class="field"><span>Basis</span><div class="row" style="gap:6px;margin-top:6px">
            ${pg?.source === 'scan' ? html`<${Badge} kind="ok">${fmtInt(pg.sampled)} sample${pg.sampled === 1 ? '' : 's'} analysed<//>` : pg?.source === 'manual' ? html`<${Badge} kind="info">Per site figures<//>` : html`<${Badge} kind="warn">No figures yet<//>`}
            ${groups.length > 1 ? html`<button class="btn small ghost" onClick=${() => removeGroup(g)}>Remove</button>` : null}</div></div>
        </div>
        <div class="grid2" style="margin-top:10px">
          <div><div class="caps muted" style="margin-bottom:6px">Sample sites</div>
            ${(g.samples || []).map((smp, i) => html`<div class="row" style="margin-bottom:6px">
              <${TextInput} value=${smp.url} placeholder="https://" ariaLabel="Sample URL" onChange=${v => setGroup(g.id, { samples: g.samples.map((x, j) => j === i ? { ...x, url: v.trim() } : x) })} />
              ${smp.url && scanned.has(siteKeyOf(smp.url)) ? html`<${Badge} kind="ok">Analysed<//>` : null}
              <button class="icon-btn" aria-label="Remove sample" onClick=${() => setGroup(g.id, { samples: g.samples.filter((_, j) => j !== i) })}>×</button></div>`)}
            <button class="btn small" onClick=${() => setGroup(g.id, { samples: [...(g.samples || []), { url: '' }] })}>Add sample</button>
            <div class="tiny muted" style="margin-top:6px">Analyse samples in the next step. Each scan only replaces that site's own pages.</div></div>
          <div><details class="more" open=${!!g.manual}><summary>Per site figures (when no sample can be analysed)</summary>
            <div class="grid3" style="margin-top:8px">${MANUAL.map(([k, l]) => html`<${Field} label=${l}><${NumInput} cls="input" value=${g.manual?.[k] ?? null} onChange=${v => setGroup(g.id, { manual: { ...(g.manual || {}), [k]: v ?? 0 } })} /><//>`)}</div>
            ${g.manual ? html`<button class="btn small ghost" onClick=${() => setGroup(g.id, { manual: null })}>Clear figures</button>` : null}
            <div class="tiny muted">Analysed samples take precedence over these figures.</div></details>
            <${Field} label="Notes (internal)"><${TextInput} value=${g.notes} onChange=${v => setGroup(g.id, { notes: v })} /><//></div>
        </div>
      </div>`;
    })}

    <${PortfolioCard} pf=${pf} quote=${quote} action=${null} />

    ${siteList.length ? html`<details class="card more"><summary>Imported site list (${fmtInt(siteList.length)} sites)</summary>
      <div class="scroll-x"><table class="t" style="margin-top:8px"><thead><tr><th>Name</th><th>URL</th><th>Brand</th><th>Site type</th></tr></thead><tbody>
        ${siteList.slice(0, 200).map(s => html`<tr><td>${s.name}</td><td class="url-cell small">${s.url}</td><td class="small">${s.brand}</td><td class="small">${s.siteType || groups[0]?.name}</td></tr>`)}
      </tbody></table></div>${siteList.length > 200 ? html`<div class="tiny muted">Showing the first 200.</div>` : null}
      <button class="btn small ghost" style="margin-top:8px" onClick=${() => { update(q => ({ ...q, portfolio: { ...q.portfolio, siteList: [] } })); toast('Site list cleared. Site types and counts are unchanged.'); }}>Clear site list</button></details>` : null}
  </div>`;
}

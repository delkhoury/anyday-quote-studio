// Plan (internal): hours per deliverable by role, who does it, and the timeline that follows.
// Nothing on this screen or in its exports shows prices.
import { useState, useEffect, useMemo } from 'preact/hooks';
import { html, Badge, Field, NumInput, TextInput, Modal, toast } from '../ui.js';
import { ROLES, ROLE_IDS, PHASES, emptyPlan, schedulePlan, weeksLabel, effortAsDefault, effortIsSet } from '../../shared/plan.js';
import { renderPlanDoc } from '../../shared/plan-doc.js';
import { fmtDate } from '../../shared/format.js';
import { download } from '../api.js';

const fmtH = v => (v ? (Math.round(v * 10) / 10).toLocaleString('en-US') : '');
const PHASE_SHADE = { Discovery: '#5C5C5C', Design: '#A10E15', Build: '#000000', Migration: '#6E0A0F', QA: '#8C8C8C', Launch: '#A10E15' };

export function PlanStep({ api, quote, update, library, setLibrary, health, flush }) {
  const [team, setTeam] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { api.team().then(setTeam).catch(e => setErr(e.message)); }, []);
  const plan = quote.plan || emptyPlan();
  const sched = useMemo(() => (team ? schedulePlan(quote, { team, library }) : null), [quote, team, library]);
  if (!team || !sched) return html`<div class="empty">Loading plan…</div>`;

  const people = (team.people || []).filter(p => p.active !== false);
  const byId = Object.fromEntries((team.people || []).map(p => [p.id, p]));
  const setPlan = fn => update(q => ({ ...q, plan: fn(q.plan || emptyPlan()) }));
  const setRow = (r, patch) => setPlan(pl => r.kind === 'extra'
    ? { ...pl, extra: pl.extra.map(x => x.id === r.id ? { ...x, ...patch } : x) }
    : { ...pl, rows: { ...pl.rows, [r.id]: { ...(pl.rows?.[r.id] || {}), ...patch } } });
  const setEffort = (r, kind, role, v) => {
    const base = r.effortSource === 'quote' ? r.effort : { setup: { ...(r.effort?.setup || {}) }, perUnit: { ...(r.effort?.perUnit || {}) } };
    setRow(r, { effort: { ...base, [kind]: { ...(base[kind] || {}), [role]: v } } });
  };
  const toSave = sched.rows.filter(r => r.kind === 'item' && r.effortSource === 'quote' && effortIsSet(r.effort));
  async function saveDefaults(rows) {
    try {
      await flush();
      const lib = await api.library();
      const ids = new Set(rows.map(r => r.id));
      const next = { ...lib, items: lib.items.map(it => ids.has(it.id) ? { ...it, effort: effortAsDefault(rows.find(r => r.id === it.id), it.effort || {}) } : it) };
      const saved = await api.saveLibrary(next, lib.updatedAt);
      setLibrary?.(saved);
      setPlan(pl => { const rs = { ...pl.rows }; for (const id of ids) if (rs[id]) { const { effort, ...rest } = rs[id]; rs[id] = rest; } return { ...pl, rows: rs }; });
      toast(`${rows.length} default${rows.length === 1 ? '' : 's'} saved to the Pricing Library. New quotes start with these hours.`);
    } catch (e) { setErr(e.details ? `${e.message}: ${[].concat(e.details).join(', ')}` : e.message); }
  }
  async function pdf() {
    setBusy('pdf'); setErr(null);
    try { await flush(); download(`${quote.number || 'quote'}-internal-plan.pdf`, await api.planPdf(quote.id), 'application/pdf'); }
    catch (e) { setErr(e.message); } finally { setBusy(null); }
  }
  const W = sched.weeks;
  const assignedNames = r => [...new Set(ROLE_IDS.flatMap(k => (r.assign?.[k] || []).map(id => byId[id]?.name).filter(Boolean)))];
  const onPlan = [...new Set(sched.rows.flatMap(r => ROLE_IDS.flatMap(k => r.assign?.[k] || [])))].filter(id => byId[id]);

  return html`<div class="stack">
    <div class="card">
      <div class="spread"><div><h2>Internal plan</h2><p class="small muted" style="margin:4px 0 0">Hours, people and timeline for each deliverable. No prices appear here or in the internal export, so it can be shared with the delivery team.</p></div>
        <div class="row wrap">
          <button class="btn" onClick=${() => setPreview(true)}>Preview internal plan</button>
          <button class="btn" onClick=${async () => { await flush(); api.exportPlanCsv(quote); }}>CSV</button>
          <button class="btn primary" disabled=${!health?.pdf || busy} title=${health?.pdf ? '' : 'PDF export needs the server'} onClick=${pdf}>${busy === 'pdf' ? 'Rendering…' : 'Download internal plan (PDF)'}</button></div></div>
      <div class="grid4" style="margin-top:12px">
        <div class="tile"><div class="k">Timeline</div><div class="v">${sched.totalDays ? `${W} wk${W === 1 ? '' : 's'}` : 'n/a'}</div><div class="d">${sched.kickoff && sched.endDate ? `${fmtDate(sched.kickoff)} to ${fmtDate(sched.endDate)}` : 'Set a kickoff date for calendar dates'}</div></div>
        <div class="tile"><div class="k">Total hours</div><div class="v">${fmtH(sched.totalHours) || '0'}</div><div class="d">${ROLES.map(r => `${r.short} ${fmtH(sched.totals[r.id]) || 0}`).join(' · ')}</div></div>
        <div class="tile"><div class="k">People</div><div class="v">${onPlan.length}</div><div class="d">${onPlan.map(id => byId[id].name).join(', ') || 'Nobody assigned yet'}</div></div>
        <div class=${'tile' + (sched.hoursNeeded ? ' accent' : '')}><div class="k">Hours needed</div><div class="v">${sched.hoursNeeded}</div><div class="d">${sched.hoursNeeded ? 'Deliverables with no hours yet. Open a row to enter them.' : 'Every deliverable has hours'}</div></div>
      </div>
      <div class="row wrap" style="margin-top:12px">
        <${Field} label="Kickoff date"><input type="date" class="input" style="width:auto" value=${plan.kickoff || ''} onChange=${e => setPlan(pl => ({ ...pl, kickoff: e.target.value }))} /><//>
        <span class="grow"></span>
        ${toSave.length ? html`<button class="btn" onClick=${() => saveDefaults(toSave)}>Save ${toSave.length} as library defaults</button>` : null}
      </div>
      ${err ? html`<div class="banner danger small" style="margin-top:8px">${err}</div>` : null}
      ${!people.length ? html`<div class="banner warn small" style="margin-top:8px">No team yet. Add your people under <a href="#/team">Team</a> to assign work and time it from their weekly hours.</div>` : null}
      ${sched.warnings.length ? html`<details class="more" style="margin-top:8px"><summary class="small">${sched.warnings.length} open item${sched.warnings.length === 1 ? '' : 's'}</summary><ul class="small" style="padding-left:18px">${sched.warnings.map(w => html`<li>${w.message}</li>`)}</ul></details>` : null}
    </div>

    ${sched.totalDays ? html`<div class="card"><h3>Timeline</h3>
      <div class="gantt-ui" style=${`--weeks:${W}`}>
        <div class="g-row g-head"><div class="g-label"></div><div class="g-track">${Array.from({ length: W }, (_, i) => i + 1).filter(w => W <= 26 || (w - 1) % Math.ceil(W / 26) === 0).map(w => html`<span style=${`left:${((w - 1) / W) * 100}%`}>W${w}</span>`)}</div></div>
        ${PHASES.map(ph => { const rs = sched.rows.filter(r => r.phase === ph && r.end > r.start); return rs.length ? html`<div class="g-phase">${ph}</div>${rs.map(r => html`<div class="g-row"><div class="g-label" title=${r.name}>${r.name}</div><div class="g-track"><i title=${`${weeksLabel(r)} · ${fmtH(r.totalHours)}h`} style=${`left:${(r.start / (W * 5)) * 100}%;width:${Math.max(0.8, ((r.end - r.start) / (W * 5)) * 100)}%;background:${PHASE_SHADE[ph]}`}></i></div></div>`)}` : null; })}
      </div></div>` : null}

    ${onPlan.length ? html`<div class="card"><h3>People on this project</h3><p class="small muted" style="margin-top:0">Share of each person's week spent on this project. Lower it when someone is also on other work.</p>
      <div class="row wrap">${onPlan.map(id => { const p = byId[id]; const l = sched.load.find(x => x.id === id); return html`<div class="tile" style="min-width:200px"><div class="k">${ROLES.find(r => r.id === p.role)?.label}</div><div class="v" style="font-size:20px">${p.name}</div>
        <div class="row" style="gap:6px;margin-top:6px"><${NumInput} value=${plan.people?.[id]?.focus ?? 100} ariaLabel=${`Focus for ${p.name}`} onChange=${v => setPlan(pl => ({ ...pl, people: { ...(pl.people || {}), [id]: { focus: Math.max(0, Math.min(100, v ?? 100)) } } }))} /><span class="small">% of ${p.hoursPerWeek}h a week</span></div>
        <div class="d">${l ? `${fmtH(l.total)}h on this project` : ''}</div></div>`; })}</div></div>` : null}

    <div class="card flush">
      <div class="cat-head"><span>Deliverables</span><span>${fmtH(sched.totalHours) || 0} hours</span></div>
      <div class="scroll-x"><table class="t plan-t">
        <thead><tr><th>Deliverable</th>${ROLES.map(r => html`<th class="num">${r.short}</th>`)}<th class="num">Hours</th><th>Assigned</th><th>When</th><th></th></tr></thead>
        <tbody>${PHASES.map(ph => { const rs = sched.rows.filter(r => r.phase === ph); return rs.length ? html`<tr class="ph"><td colspan=${ROLE_IDS.length + 5}>${ph}</td></tr>${rs.map(r => html`
          <tr key=${r.id}>
            <td style="min-width:240px"><b>${r.name}</b>${r.qtyBased ? html`<div class="tiny muted">${r.qty.toLocaleString()} ${r.qty === 1 ? r.unit : r.units}</div>` : null}
              ${r.effortSource === 'quote' && r.kind === 'item' ? html` <${Badge} kind="info" title="Hours entered on this quote">This quote<//>` : null}
              ${r.baseline ? html` <${Badge} kind="warn" title=${r.baseline.basis || ''}>Baseline<//>` : null}</td>
            ${ROLE_IDS.map(k => html`<td class="num">${fmtH(r.hours[k])}</td>`)}
            <td class="num">${r.hoursNeeded ? html`<${Badge} kind="danger">Hours needed<//>` : html`<b>${fmtH(r.totalHours)}</b>`}</td>
            <td class="small">${r.totalHours ? (assignedNames(r).join(', ') || html`<span style="color:var(--danger)">Unassigned</span>`) : ''}</td>
            <td class="small">${weeksLabel(r)}${r.startDate && r.end > r.start ? html`<div class="tiny muted">${fmtDate(r.startDate)}</div>` : null}</td>
            <td><button class="icon-btn" aria-expanded=${open === r.id} aria-label=${(open === r.id ? 'Close ' : 'Edit ') + r.name} onClick=${() => setOpen(open === r.id ? null : r.id)}>${open === r.id ? '−' : '✎'}</button></td></tr>
          ${open === r.id ? html`<tr><td colspan=${ROLE_IDS.length + 5} style="background:var(--surface-2)"><${RowEditor} r=${r} rows=${sched.rows} people=${people} setRow=${setRow} setEffort=${setEffort} saveDefault=${() => saveDefaults([r])} remove=${r.kind === 'extra' ? () => { setPlan(pl => ({ ...pl, extra: pl.extra.filter(x => x.id !== r.id) })); setOpen(null); } : null} /></td></tr>` : null}`)}` : null; })}</tbody>
      </table></div>
      <div style="padding:10px 14px"><button class="btn small" onClick=${() => { const id = 'x_' + Math.random().toString(36).slice(2, 8); setPlan(pl => ({ ...pl, extra: [...(pl.extra || []), { id, name: 'New task', phase: 'Build', effort: { setup: {}, perUnit: {} }, assign: {}, note: '' }] })); setOpen(id); }}>Add internal task</button>
        <span class="tiny muted"> Internal tasks (i.e. discovery workshops, QA, launch) appear only in the plan.</span></div>
    </div>

    <div class="card"><h3>Notes for the team</h3><${TextInput} multiline rows=${4} value=${plan.notes} placeholder="Context the delivery team needs: access, environments, dependencies, risks." onChange=${v => setPlan(pl => ({ ...pl, notes: v }))} ariaLabel="Plan notes" /></div>

    ${preview ? html`<${Modal} title="Internal plan preview" onClose=${() => setPreview(false)} footer=${html`<button class="btn" onClick=${() => setPreview(false)}>Close</button>`}>
      <iframe title="Internal plan" style="width:100%;height:70vh;border:1px solid var(--line);background:#fff" srcdoc=${renderPlanDoc(quote, sched, team, { assetBase: window.__FONT_CSS__ ? null : '/assets', logoUrl: window.__LOGO_DARK__ || '/assets/anyday-logo.png', screen: true })}></iframe><//>` : null}
  </div>`;
}

function RowEditor({ r, rows, people, setRow, setEffort, saveDefault, remove }) {
  const changed = r.kind === 'item' && r.effortSource === 'quote';
  const assign = (role, id, on) => { const cur = r.assign?.[role] || []; setRow(r, { assign: { ...(r.assign || {}), [role]: on ? [...cur, id] : cur.filter(x => x !== id) } }); };
  return html`<div class="grid2" style="padding:6px 2px">
    <div class="stack" style="gap:10px">
      ${r.kind === 'extra' ? html`<${Field} label="Task"><${TextInput} value=${r.name} onChange=${v => setRow(r, { name: v })} /><//>` : null}
      <table class="t"><thead><tr><th>Role</th><th>Fixed hours</th>${r.qtyBased ? html`<th>Hours per ${r.unit}</th><th class="num">× ${r.qty.toLocaleString()}</th>` : null}</tr></thead><tbody>
        ${ROLES.map(role => html`<tr><td class="small">${role.label}</td>
          <td><${NumInput} value=${r.effort?.setup?.[role.id] ?? null} step=${0.25} ariaLabel=${`${role.label} fixed hours for ${r.name}`} onChange=${v => setEffort(r, 'setup', role.id, v)} /></td>
          ${r.qtyBased ? html`<td><${NumInput} value=${r.effort?.perUnit?.[role.id] ?? null} step=${0.25} ariaLabel=${`${role.label} hours per ${r.unit} for ${r.name}`} onChange=${v => setEffort(r, 'perUnit', role.id, v)} /></td><td class="num small">${fmtH(r.hours[role.id]) || '0'}h</td>` : null}</tr>`)}
      </tbody></table>
      ${r.kind === 'item' ? html`<div class="small muted">${r.effortSource === 'library' && r.baseline ? `Hours are a Clockify baseline from the Pricing Library (${r.baseline.confidence || 'low'} confidence). Check them; editing here changes this quote only, and Save as library default makes them the confirmed default.` : r.effortSource === 'library' ? 'Hours come from the Pricing Library defaults. Editing them here changes this quote only.' : r.effortSource === 'quote' ? 'Hours entered on this quote.' : 'No default hours yet. Enter them here, then save them as the default so the next quote starts with them.'}</div>
        <div class="row wrap">${changed ? html`<button class="btn small" onClick=${saveDefault}>Save as library default</button>` : null}
          ${changed && effortIsSet(r.libraryEffort) ? html`<button class="btn small ghost" onClick=${() => setRow(r, { effort: undefined })}>Use library default</button>` : null}</div>` : null}
      ${r.doneWhen ? html`<div class="small"><b>Done when:</b> ${r.doneWhen}</div>` : null}
    </div>
    <div class="stack" style="gap:10px">
      <div><div class="caps muted" style="margin-bottom:6px">Assigned</div>
        ${ROLES.filter(role => r.hours[role.id] > 0).map(role => html`<div style="margin-bottom:8px"><div class="small"><b>${role.label}</b> · ${fmtH(r.hours[role.id])}h</div>
          <div class="row wrap" style="gap:4px 12px;margin-top:4px">${people.filter(p => p.role === role.id).map(p => html`<label class="check small"><input type="checkbox" checked=${(r.assign?.[role.id] || []).includes(p.id)} onChange=${e => assign(role.id, p.id, e.target.checked)} /> ${p.name}</label>`)}
            ${!people.some(p => p.role === role.id) ? html`<span class="tiny muted">No ${role.label.toLowerCase()} on the Team yet.</span>` : null}</div></div>`)}
        ${!ROLES.some(role => r.hours[role.id] > 0) ? html`<div class="tiny muted">Enter hours to assign people.</div>` : null}</div>
      <div class="grid2">
        <${Field} label="Phase"><select class="input" value=${r.phase} onChange=${e => setRow(r, { phase: e.target.value })}>${PHASES.map(ph => html`<option value=${ph}>${ph}</option>`)}</select><//>
        <${Field} label="Starts"><select class="input" value=${r.after || ''} onChange=${e => setRow(r, { after: e.target.value })}>
          <option value="">After the previous phase</option><option value="start">At kickoff</option>
          ${rows.filter(x => x.id !== r.id).map(x => html`<option value=${x.id}>After ${x.name}</option>`)}</select><//>
      </div>
      <${Field} label="Note for the team"><${TextInput} value=${r.note} onChange=${v => setRow(r, { note: v })} /><//>
      ${remove ? html`<div><button class="btn small danger" onClick=${remove}>Remove task</button></div>` : null}
    </div>
  </div>`;
}

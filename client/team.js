// Team: the people who deliver the work. Used by each quote's internal Plan step.
import { useState, useEffect } from 'preact/hooks';
import { html, Badge, NumInput, TextInput, toast, askConfirm } from './ui.js';
import { ROLES } from '../shared/plan.js';

const newId = () => 'p_' + Math.random().toString(36).slice(2, 9);

export function TeamScreen({ api, health, admin }) {
  const [team, setTeam] = useState(null);
  const [orig, setOrig] = useState(null);
  const [errs, setErrs] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState(null);
  const [settings, setSettings] = useState(null);
  useEffect(() => { api.team().then(t => { setTeam(t); setOrig(JSON.stringify(t)); }); if (admin) api.settings().then(setSettings).catch(() => {}); }, []);
  async function sync() {
    if (dirty && !(await askConfirm('You have unsaved changes on this screen. Syncing reloads the team from the server and discards them.', 'Sync anyway'))) return;
    setSyncing(true); setErrs([]);
    try { const r = await api.clockifySync(); setTeam(r.team); setOrig(JSON.stringify(r.team)); setReport(r.report); toast('Team synced from Clockify'); }
    catch (e) { setErrs([e.message]); } finally { setSyncing(false); }
  }
  if (!team) return html`<div class="empty">Loading team…</div>`;
  const dirty = JSON.stringify(team) !== orig;
  const people = team.people;
  const setPerson = (id, patch) => setTeam(t => ({ ...t, people: t.people.map(p => p.id === id ? { ...p, ...patch } : p) }));
  async function save() {
    try { const s = await api.saveTeam(team, JSON.parse(orig).updatedAt); setTeam(s); setOrig(JSON.stringify(s)); setErrs([]); toast('Team saved'); }
    catch (e) { setErrs(e.details || [e.message]); }
  }
  const shown = [...people].sort((a, b) => (a.active === false) - (b.active === false) || ROLES.findIndex(r => r.id === a.role) - ROLES.findIndex(r => r.id === b.role));
  return html`<div class="stack">
    <div class="page-head"><div><div class="eyebrow">Delivery</div><h1>Team</h1>
      <div class="muted small" style="margin-top:6px">The people who deliver the work. Each quote's Plan step assigns them to deliverables and times the work from their weekly hours.</div></div>
      <div class="row wrap">${dirty ? html`<${Badge} kind="warn">Unsaved changes<//>` : null}
        <button class="btn" disabled=${syncing || !health?.clockify} title=${health?.clockify ? 'Names, roles from Clockify groups, weekly capacity, time off' + (admin ? ' and cost rates' : '') : 'Add CLOCKIFY_API_KEY in Render to connect Clockify'} onClick=${sync}>${syncing ? 'Syncing…' : 'Sync from Clockify'}</button>
        <button class="btn" disabled=${!dirty} onClick=${() => setTeam(JSON.parse(orig))}>Discard</button>
        <button class="btn primary" disabled=${!dirty} onClick=${save}>Save team</button></div></div>
    ${!health?.clockify && health?.mode === 'server' ? html`<div class="banner info small">Clockify is not connected yet. Add the <code>CLOCKIFY_API_KEY</code> environment variable in Render to sync the team from Clockify.</div>` : null}
    ${report ? html`<div class="banner ok small">Synced from Clockify: ${report.added.length} added, ${report.updated.length} updated${report.deactivated.length ? `, ${report.deactivated.length} marked inactive (no longer in Clockify)` : ''}.${report.skipped.length ? ` Skipped ${report.skipped.join(', ')}: not in a Designers, Developers, Project Manager or Leads group.` : ''} Roles come from Clockify groups; Design Leads count as designers and Dev Leads as technical leads.</div>` : null}
    ${errs.length ? html`<div class="banner danger small"><b>Fix before saving:</b><ul style="margin:4px 0 0;padding-left:18px">${errs.map(e => html`<li>${e}</li>`)}</ul></div>` : null}
    <div class="grid4">${ROLES.map(r => { const n = people.filter(p => p.role === r.id && p.active !== false); return html`<div class="tile"><div class="k">${r.label}s</div><div class="v">${n.length}</div><div class="d">${n.reduce((a, p) => a + (Number(p.hoursPerWeek) || 0), 0)} hours a week</div></div>`; })}</div>
    <div class="card flush"><div class="scroll-x"><table class="t">
      <thead><tr><th>Name</th><th>Role</th><th>Hours a week</th>${admin ? html`<th>Cost rate</th>` : null}<th>Time off</th><th>Active</th><th></th></tr></thead>
      <tbody>${shown.map(p => html`<tr key=${p.id} style=${p.active === false ? 'opacity:.55' : ''}>
        <td style="min-width:180px"><${TextInput} value=${p.name} ariaLabel="Name" onChange=${v => setPerson(p.id, { name: v })} />
          <div class="row" style="gap:4px;margin-top:4px">${p.clockifyId ? html`<${Badge} title=${(p.groups || []).join(', ')}>Clockify<//>` : null}${p.lead ? html`<${Badge} kind="accent">Lead<//>` : null}</div></td>
        <td><select class="input" style="width:auto" aria-label=${'Role for ' + p.name} value=${p.role} onChange=${e => setPerson(p.id, { role: e.target.value, roleLocked: true })}>${ROLES.map(r => html`<option value=${r.id}>${r.label}</option>`)}</select>
          ${p.roleLocked && p.clockifyId ? html`<div class="tiny muted">Set here, kept on sync</div>` : null}</td>
        <td style="width:120px"><${NumInput} cls="input" value=${p.hoursPerWeek} ariaLabel=${'Hours a week for ' + p.name} onChange=${v => setPerson(p.id, { hoursPerWeek: v ?? 0 })} /><div class="tiny muted">for client work</div></td>
        ${admin ? html`<td style="width:130px"><${NumInput} cls="input" value=${p.costRate ?? null} ariaLabel=${'Cost rate for ' + p.name} step=${0.01} onChange=${v => setPerson(p.id, { costRate: v, costCurrency: p.costCurrency || settings?.costCurrency || 'CAD' })} /><div class="tiny muted">${p.costCurrency || settings?.costCurrency || 'CAD'} an hour</div></td>` : null}
        <td style="min-width:260px">${(p.timeOff || []).map((t, i) => html`<div class="row" style="gap:4px;margin-bottom:4px">
            <input type="date" class="input" style="width:auto" aria-label="Time off from" value=${t.from || ''} onChange=${e => setPerson(p.id, { timeOff: p.timeOff.map((x, j) => j === i ? { ...x, from: e.target.value } : x) })} />
            <span class="tiny">to</span><input type="date" class="input" style="width:auto" aria-label="Time off to" value=${t.to || ''} onChange=${e => setPerson(p.id, { timeOff: p.timeOff.map((x, j) => j === i ? { ...x, to: e.target.value } : x) })} />
            <button class="icon-btn" aria-label="Remove time off" onClick=${() => setPerson(p.id, { timeOff: p.timeOff.filter((_, j) => j !== i) })}>×</button></div>`)}
          <button class="btn small ghost" onClick=${() => setPerson(p.id, { timeOff: [...(p.timeOff || []), { from: '', to: '' }] })}>Add time off</button></td>
        <td><input type="checkbox" aria-label=${'Active: ' + p.name} checked=${p.active !== false} onChange=${e => setPerson(p.id, { active: e.target.checked })} /></td>
        <td><button class="icon-btn" aria-label=${'Remove ' + p.name} onClick=${async () => { if (await askConfirm(`Remove ${p.name || 'this person'}? Quotes that assigned them will show the work as unassigned. To keep them on old plans, untick Active instead.`, 'Remove')) setTeam(t => ({ ...t, people: t.people.filter(x => x.id !== p.id) })); }}>×</button></td>
      </tr>`)}
      ${!people.length ? html`<tr><td colspan=${admin ? 7 : 6} class="empty">No one yet. Add your designers, developers, project managers and technical leads.</td></tr>` : null}</tbody></table></div>
      <div style="padding:10px 14px" class="row wrap">${ROLES.map(r => html`<button class="btn small" onClick=${() => setTeam(t => ({ ...t, people: [...t.people, { id: newId(), name: `New ${r.label.toLowerCase()}`, role: r.id, hoursPerWeek: 32, timeOff: [], active: true }] }))}>Add ${r.label.toLowerCase()}</button>`)}</div></div>
    <div class="tiny muted">Hours a week is the time each person has for client delivery. On each quote you can also set how much of that week goes to the project.</div>
    ${admin && settings ? html`<${CostSettings} api=${api} settings=${settings} onSaved=${setSettings} />` : null}
  </div>`;
}

// Admin only: how Clockify cost rates convert to the quote currency, and the margin target.
function CostSettings({ api, settings, onSaved }) {
  const [s, setS] = useState(settings);
  const [err, setErr] = useState(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  return html`<div class="card"><div class="spread"><div><div class="caps">Admin only</div><h2 style="margin-top:2px">Costs and margin</h2></div>
      <button class="btn primary" disabled=${!dirty} onClick=${async () => { try { onSaved(await api.saveSettings(s)); setErr(null); toast('Cost settings saved'); } catch (e) { setErr(e.message); } }}>Save</button></div>
    <p class="small muted">Cost rates are visible to admins only. Quotes are priced in USD, so cost rates are converted before the margin is worked out.</p>
    <div class="grid3">
      <label class="field"><span>Cost rate currency</span><input class="input" value=${s.costCurrency} maxlength="3" onInput=${e => setS({ ...s, costCurrency: e.target.value.toUpperCase() })} /></label>
      <label class="field"><span>1 ${s.costCurrency} in USD</span><${NumInput} cls="input" value=${s.costToQuoteRate} step=${0.0001} ariaLabel="Exchange rate" onChange=${v => setS({ ...s, costToQuoteRate: v })} /><div class="tiny muted" style="margin-top:4px">About 0.72 in early November 2026. Update it when the rate moves.</div></label>
      <label class="field"><span>Target gross margin %</span><${NumInput} cls="input" value=${s.targetMargin} ariaLabel="Target margin" onChange=${v => setS({ ...s, targetMargin: v })} /></label>
    </div>${err ? html`<div class="banner danger small" style="margin-top:8px">${err}</div>` : null}</div>`;
}

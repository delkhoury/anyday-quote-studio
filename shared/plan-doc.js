// Internal delivery plan document (HTML, printed to PDF by the server). Built only from the
// schedule, the team and the quote's names: no prices, rates, totals or client proposal copy.
import { ROLES, ROLE_IDS, PHASES, weeksLabel } from './plan.js';
import { fontFaceCss, BRAND } from './proposal.js';
import { escapeHtml as h, fmtDate } from './format.js';

const fmtH = v => (v ? (Math.round(v * 10) / 10).toLocaleString('en-US') : '');
const PHASE_SHADE = { Discovery: '#5C5C5C', Design: '#A10E15', Build: '#000000', Migration: '#6E0A0F', QA: '#8C8C8C', Launch: '#A10E15' };

export function renderPlanDoc(quote, sched, team, { assetBase = '/assets', markDataUri = '', logoUrl = `${assetBase}/anyday-logo.png`, screen = false } = {}) {
  const people = Object.fromEntries((team?.people || []).map(p => [p.id, p]));
  const roleLabel = id => ROLES.find(r => r.id === id)?.label || id;
  const client = quote.client?.name || 'Untitled client';
  const project = quote.project?.name || 'Delivery plan';
  const B = BRAND;
  const span = sched.kickoff && sched.endDate ? `${fmtDate(sched.kickoff)} to ${fmtDate(sched.endDate)}` : `${sched.weeks} week${sched.weeks === 1 ? '' : 's'} from kickoff`;
  const assigned = r => [...new Set(ROLE_IDS.flatMap(k => (r.assign?.[k] || []).map(id => people[id]?.name).filter(Boolean)))].join(', ') || '<span class="flag">Unassigned</span>';
  const when = r => (r.end > r.start ? `${weeksLabel(r)}${r.startDate ? `<div class="sub">${h(fmtDate(r.startDate))} to ${h(fmtDate(r.endDate))}</div>` : ''}` : '<span class="muted">Not scheduled</span>');

  // timeline: one bar per deliverable across the project's weeks
  const W = sched.weeks;
  const tick = Math.max(1, Math.ceil(W / 26));
  const ticks = Array.from({ length: Math.ceil(W / tick) }, (_, i) => i * tick + 1);
  const gantt = `<div class="gantt">
    <div class="g-head"><div class="g-label"></div><div class="g-track">${ticks.map(w => `<span style="left:${((w - 1) / W) * 100}%">W${w}</span>`).join('')}</div></div>
    ${PHASES.map(ph => {
      const rs = sched.rows.filter(r => r.phase === ph && r.end > r.start);
      if (!rs.length) return '';
      return `<div class="g-phase">${h(ph)}</div>` + rs.map(r => `<div class="g-row"><div class="g-label">${h(r.name)}</div><div class="g-track"><i style="left:${(r.start / (W * 5)) * 100}%;width:${Math.max(0.6, ((r.end - r.start) / (W * 5)) * 100)}%;background:${PHASE_SHADE[ph]}"></i></div></div>`).join('');
    }).join('')}
  </div>`;

  const phaseRows = sched.phases.map(p => `<tr><td><b>${h(p.name)}</b></td><td>${p.startWeek === p.endWeek ? `Week ${p.startWeek}` : `Weeks ${p.startWeek} to ${p.endWeek}`}</td><td>${p.endDate ? h(fmtDate(p.endDate)) : '<span class="muted">Set a kickoff date</span>'}</td></tr>`).join('');

  const delivRows = PHASES.map(ph => {
    const rs = sched.rows.filter(r => r.phase === ph);
    if (!rs.length) return '';
    return `<tr class="ph"><td colspan="${5 + ROLE_IDS.length}">${h(ph)}</td></tr>` + rs.map(r => `<tr>
      <td><div class="name">${h(r.name)}</div>${r.doneWhen ? `<div class="sub">Done when: ${h(r.doneWhen)}</div>` : ''}${r.note ? `<div class="sub">${h(r.note)}</div>` : ''}</td>
      <td class="num">${r.qtyBased ? `${r.qty.toLocaleString('en-US')} <span class="sub">${h(r.qty === 1 ? r.unit : r.units)}</span>` : ''}</td>
      ${ROLE_IDS.map(k => `<td class="num">${fmtH(r.hours[k])}</td>`).join('')}
      <td class="num">${r.hoursNeeded ? '<span class="flag">Hours needed</span>' : `<b>${fmtH(r.totalHours)}</b>`}</td>
      <td>${r.totalHours ? assigned(r) : ''}</td><td>${when(r)}</td></tr>`).join('');
  }).join('');

  // weekly load per person, in chunks so long projects stay readable
  const CH = 13;
  const loadTables = [];
  for (let s = 0; s < W; s += CH) {
    const cols = Array.from({ length: Math.min(CH, W - s) }, (_, i) => s + i);
    loadTables.push(`<table class="load"><thead><tr><th>Person</th>${cols.map(c => `<th class="num">W${c + 1}</th>`).join('')}</tr></thead><tbody>
      ${sched.load.map(p => `<tr><td><b>${h(p.name)}</b><div class="sub">${h(roleLabel(p.role))} · ${fmtH(p.capacity)}h a week</div></td>${cols.map(c => { const v = p.weeks[c] || 0; const pct = p.capacity ? v / p.capacity : 0; return `<td class="num"><span class="cell" style="background:rgba(161,14,21,${Math.min(0.85, pct * 0.6).toFixed(2)});color:${pct > 0.9 ? '#fff' : '#000'}">${v ? fmtH(v) : ''}</span></td>`; }).join('')}</tr>`).join('')}
    </tbody></table>`);
  }

  const team_ = sched.load.length ? `<table class="team"><thead><tr><th>Person</th><th>Role</th><th class="num">Hours on this project</th><th class="num">Hours a week here</th></tr></thead><tbody>${sched.load.map(p => `<tr><td><b>${h(p.name)}</b></td><td>${h(roleLabel(p.role))}</td><td class="num">${fmtH(p.total)}</td><td class="num">${fmtH(p.capacity)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nobody is assigned yet.</p>';
  const open = sched.warnings.filter(w => w.kind !== 'time_off');
  const notes = (quote.plan?.notes || '').trim();

  const css = `${fontFaceCss({ assetBase })}
@page { size: Letter landscape; margin: 0.7in 0.6in 0.65in;
  @top-left { content: "ANYDAY INC. · INTERNAL DELIVERY PLAN"; font: 600 6.5pt 'Inter', sans-serif; letter-spacing: .1em; padding-top: 6pt; border-top: 1pt solid ${B.accent}; margin-top: .3in; vertical-align: top; }
  @top-right { content: "${h(client).toUpperCase()}"; font: 600 6.5pt 'Inter', sans-serif; letter-spacing: .1em; padding-top: 6pt; border-top: 1pt solid ${B.accent}; margin-top: .3in; vertical-align: top; text-align: right; }
  @bottom-left { content: "Internal. Not for clients · Page " counter(page) " of " counter(pages); font: 500 6.5pt 'Inter', sans-serif; color: ${B.muted}; padding-bottom: .25in; vertical-align: bottom; }
  @bottom-right { content: ""; ${markDataUri ? `background: url("${markDataUri}") no-repeat right bottom / 40px 19px;` : ''} width: 1in; margin-bottom: .25in; } }
* { box-sizing: border-box; } html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 8.4pt/1.45 'Inter', system-ui, sans-serif; color: #000; background: #fff; }
.screen body, body.screen { padding: 0.4in 0.5in; }
h1, h2 { font-family: 'MD Lorien', Georgia, serif; font-weight: 400; margin: 0; }
h1 { font-size: 34pt; line-height: 1.02; } h2 { font-size: 19pt; margin: 0 0 8pt; }
.eyebrow { font: 700 6.8pt 'Inter'; letter-spacing: .14em; text-transform: uppercase; color: ${B.accent}; margin-bottom: 6pt; }
.head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1pt solid #000; padding-bottom: 14pt; margin-bottom: 14pt; }
.head img { height: 46px; }
.meta { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; border-top: 1pt solid #000; border-bottom: 1pt solid ${B.rule}; margin: 0 0 18pt; }
.meta div { padding: 7pt 8pt 8pt 0; } .meta .k { font: 700 6pt 'Inter'; letter-spacing: .12em; text-transform: uppercase; color: ${B.muted}; } .meta .v { font-size: 10pt; font-weight: 600; margin-top: 2pt; }
.block { margin: 0 0 20pt; } .newpage { break-before: page; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24pt; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; font: 700 6.2pt 'Inter'; letter-spacing: .12em; text-transform: uppercase; padding: 5pt 6pt; border-bottom: 1pt solid #000; }
td { padding: 5pt 6pt; border-bottom: .5pt solid ${B.rule}; vertical-align: top; } tr { break-inside: avoid; }
.num { text-align: right; white-space: nowrap; } .name { font-weight: 600; } .sub { font-size: 7pt; color: ${B.muted}; }
tr.ph td { font: 700 6.6pt 'Inter'; letter-spacing: .12em; text-transform: uppercase; color: ${B.accent}; padding-top: 10pt; border-bottom: 1pt solid ${B.accent}; }
.flag { color: ${B.accent}; font-weight: 700; } .muted { color: ${B.muted}; }
.gantt { border-top: 1pt solid #000; } .g-head, .g-row { display: grid; grid-template-columns: 2.6in 1fr; align-items: center; }
.g-head { height: 16pt; border-bottom: .5pt solid ${B.rule}; } .g-head .g-track span { position: absolute; top: 3pt; font-size: 6pt; color: ${B.muted}; }
.g-row { height: 13pt; border-bottom: .5pt solid #eee; break-inside: avoid; } .g-label { font-size: 7.2pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8pt; }
.g-track { position: relative; height: 100%; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(${100 / Math.max(1, W)}% - .5pt), #eee calc(${100 / Math.max(1, W)}% - .5pt), #eee ${100 / Math.max(1, W)}%); }
.g-track i { position: absolute; top: 3pt; bottom: 3pt; border-radius: 1pt; }
.g-phase { font: 700 6.4pt 'Inter'; letter-spacing: .12em; text-transform: uppercase; color: ${B.accent}; padding: 6pt 0 2pt; break-after: avoid; }
.load td, .load th { padding: 3pt 4pt; } .load { margin-bottom: 12pt; } .cell { display: block; padding: 2pt 3pt; border-radius: 1pt; min-height: 12pt; }
.list { margin: 0; padding-left: 14pt; } .list li { margin: 0 0 3pt; }
.totals { display: grid; grid-template-columns: repeat(${ROLE_IDS.length + 1}, 1fr); border: 1pt solid #000; margin-bottom: 18pt; }
.totals > div { padding: 8pt 10pt; border-right: .5pt solid ${B.rule}; } .totals > div:last-child { border-right: 0; background: #000; color: #fff; }
.totals .k { font: 700 6pt 'Inter'; letter-spacing: .12em; text-transform: uppercase; opacity: .7; } .totals .v { font-family: 'MD Lorien', Georgia, serif; font-size: 20pt; line-height: 1.1; }`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(client)} · Internal delivery plan</title><style>${css}</style></head><body class="${screen ? 'screen' : ''}">
<div class="head"><div><div class="eyebrow">Internal delivery plan · Not for clients</div><h1>${h(client)}</h1><div style="margin-top:6pt;font-size:10pt">${h(project)}</div></div><img src="${h(logoUrl)}" alt="Anyday"></div>
<div class="meta">
  <div><div class="k">Quote</div><div class="v">${h(quote.number || 'Draft')}</div></div>
  <div><div class="k">Timeline</div><div class="v">${h(span)}</div></div>
  <div><div class="k">Kickoff</div><div class="v">${sched.kickoff ? h(fmtDate(sched.kickoff)) : 'To be set'}</div></div>
  <div><div class="k">People</div><div class="v">${sched.load.length}</div></div>
  <div><div class="k">Plan updated</div><div class="v">${h(fmtDate(quote.updatedAt || new Date().toISOString()))}</div></div>
</div>
<div class="totals">${ROLES.map(r => `<div><div class="k">${h(r.label)}</div><div class="v">${fmtH(sched.totals[r.id]) || '0'}h</div></div>`).join('')}<div><div class="k">Total hours</div><div class="v">${fmtH(sched.totalHours) || '0'}h</div></div></div>
${open.length ? `<div class="block"><h2>Open items</h2><ul class="list">${open.map(w => `<li>${h(w.message)}</li>`).join('')}</ul></div>` : ''}
<div class="block cols"><div><h2>Milestones</h2><table><thead><tr><th>Phase</th><th>When</th><th>Ends</th></tr></thead><tbody>${phaseRows || '<tr><td colspan="3" class="muted">No scheduled work yet.</td></tr>'}</tbody></table></div>
<div><h2>Team</h2>${team_}</div></div>
<div class="block newpage"><h2>Timeline</h2>${gantt}</div>
<div class="block newpage"><h2>Deliverables</h2><table><thead><tr><th>Deliverable</th><th class="num">Quantity</th>${ROLES.map(r => `<th class="num">${h(r.short)}</th>`).join('')}<th class="num">Hours</th><th>Assigned</th><th>When</th></tr></thead><tbody>${delivRows}</tbody></table></div>
${sched.load.length ? `<div class="block newpage"><h2>Hours per person per week</h2>${loadTables.join('')}</div>` : ''}
${notes ? `<div class="block"><h2>Notes</h2>${notes.split(/\n{2,}/).map(p => `<p>${h(p)}</p>`).join('')}</div>` : ''}
</body></html>`;
}

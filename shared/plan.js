// Internal delivery plan: hours per deliverable by role, who does the work, and the timeline
// that follows from their weekly capacity. Reads quantities from the quote but never prices,
// so everything here can be shared with the delivery team.
import { calculateQuote } from './pricing.js';

export const ROLES = [
  { id: 'design', label: 'Designer', short: 'Design' },
  { id: 'dev', label: 'Developer', short: 'Dev' },
  { id: 'pm', label: 'Project manager', short: 'PM' },
  { id: 'lead', label: 'Technical lead', short: 'Lead' },
];
export const ROLE_IDS = ROLES.map(r => r.id);
export const PHASES = ['Discovery', 'Design', 'Build', 'Migration', 'QA', 'Launch'];
export const DEFAULT_HOURS_PER_WEEK = 32; // used for work with nobody assigned yet
const DAYS_PER_WEEK = 5;
const MAX_DAYS = 5 * 260; // five working years: anything longer means capacity is missing

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (v === '' || v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? Number(v) : null)));
const emptyRoles = () => Object.fromEntries(ROLE_IDS.map(r => [r, null]));

export function emptyTeam() { return { schemaVersion: 1, people: [], updatedAt: new Date().toISOString() }; }

export function defaultPhase(item) {
  if (item.isDesign) return 'Design';
  if (item.section === 'migration') return 'Migration';
  return 'Build';
}

// Hours for a quantity from an effort record { setup: {role: h}, perUnit: {role: h} }.
export function hoursFor(effort, qty) {
  const out = {};
  let defined = false;
  const q = Math.max(0, Number(qty) || 0);
  for (const r of ROLE_IDS) {
    const s = num(effort?.setup?.[r]); const u = num(effort?.perUnit?.[r]);
    if (s !== null || u !== null) defined = true;
    out[r] = (s || 0) + (u || 0) * q;
  }
  return { hours: out, defined };
}

export function effortIsSet(effort) {
  return !!effort && ROLE_IDS.some(r => num(effort.setup?.[r]) !== null || num(effort.perUnit?.[r]) !== null);
}

// Default internal plan section of a quote.
export function emptyPlan() {
  return {
    kickoff: '', // ISO date; blank means the plan reads in relative weeks
    rows: {},    // itemId -> { effort?, phase?, after?, assign: {role: [personId]}, note }
    extra: [
      { id: 'x_discovery', name: 'Discovery and kickoff', phase: 'Discovery', effort: { setup: emptyRoles(), perUnit: {} }, assign: {}, note: '' },
      { id: 'x_qa', name: 'QA and client review', phase: 'QA', effort: { setup: emptyRoles(), perUnit: {} }, assign: {}, note: '' },
      { id: 'x_launch', name: 'Launch', phase: 'Launch', effort: { setup: emptyRoles(), perUnit: {} }, assign: {}, note: '' },
    ],
    people: {},  // personId -> { focus: 0..100 } share of the person's week on this project
    notes: '',
  };
}

// The deliverables in the plan, in delivery order. `library` (optional) supplies the current
// default effort, so hours the PM saved as defaults reach every quote that has no override.
export function planRows(quote, { library = null, calc = null } = {}) {
  const c = calc || calculateQuote(quote);
  const plan = quote.plan || emptyPlan();
  const libById = Object.fromEntries((library?.items || []).map(i => [i.id, i]));
  const rows = [];
  for (const l of c.lines) {
    if (l.state !== 'included') continue;
    const item = l.item;
    const lib = libById[item.id];
    const saved = plan.rows?.[item.id] || {};
    const libEffort = lib?.effort || item.effort || null;
    const effort = saved.effort && effortIsSet(saved.effort) ? saved.effort : libEffort;
    const qtyBased = item.pricing.model !== 'included';
    const qty = qtyBased ? (Number(l.qty) || 0) : 1;
    const { hours, defined } = hoursFor(effort, qty);
    rows.push({
      id: item.id, kind: 'item',
      name: lib?.effort?.internalName || item.effort?.internalName || item.name,
      doneWhen: lib?.effort?.doneWhen || item.effort?.doneWhen || '',
      unit: item.pricing.qtyUnit, units: item.pricing.qtyUnitPlural, qty, qtyBased,
      phase: saved.phase || lib?.effort?.phase || item.effort?.phase || defaultPhase(item),
      after: saved.after || '',
      effort: effort || { setup: emptyRoles(), perUnit: emptyRoles() },
      effortSource: saved.effort && effortIsSet(saved.effort) ? 'quote' : (effortIsSet(libEffort) ? 'library' : 'none'),
      libraryEffort: libEffort,
      hours, hoursNeeded: !defined,
      assign: saved.assign || {}, note: saved.note || '',
    });
  }
  for (const x of plan.extra || []) {
    const { hours } = hoursFor(x.effort, 1);
    rows.push({ id: x.id, kind: 'extra', name: x.name, doneWhen: x.doneWhen || '', unit: '', units: '', qty: 1, qtyBased: false, phase: x.phase || 'Build', after: x.after || '', effort: x.effort || { setup: emptyRoles(), perUnit: {} }, effortSource: 'quote', hours, hoursNeeded: false, assign: x.assign || {}, note: x.note || '' });
  }
  const order = p => { const i = PHASES.indexOf(p); return i < 0 ? PHASES.length : i; };
  return rows.map((r, i) => ({ ...r, i })).sort((a, b) => order(a.phase) - order(b.phase) || a.i - b.i);
}

// ---- calendar helpers (working days, Monday to Friday) ---------------------
export function addWorkdays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  let n = days;
  while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n--; }
  return d.toISOString().slice(0, 10);
}
const inTimeOff = (person, iso) => (person.timeOff || []).some(t => t.from && iso >= t.from && iso <= (t.to || t.from));

// Schedule every row. Work is placed day by day: each assignee spends at most their daily
// capacity (hours per week / 5 × project focus) and is never double booked across rows.
// Rows start when the previous phase finishes, or after a chosen row, or at project start.
export function schedulePlan(quote, { team = null, library = null, calc = null } = {}) {
  const plan = quote.plan || emptyPlan();
  const rows = planRows(quote, { library, calc });
  const people = Object.fromEntries((team?.people || []).filter(p => p.active !== false).map(p => [p.id, p]));
  const kickoff = /^\d{4}-\d{2}-\d{2}$/.test(plan.kickoff || '') ? plan.kickoff : '';
  const dateOf = day => (kickoff ? addWorkdays(kickoff, day) : null);
  const used = {}; // personId -> day -> hours used
  const daily = id => {
    const p = people[id]; if (!p) return 0;
    const focus = Math.max(0, Math.min(100, num(plan.people?.[id]?.focus) ?? 100)) / 100;
    return (Math.max(0, num(p.hoursPerWeek) || 0) / DAYS_PER_WEEK) * focus;
  };
  const free = (id, day) => {
    if (kickoff && inTimeOff(people[id], dateOf(day))) return 0;
    return Math.max(0, daily(id) - (used[id]?.[day] || 0));
  };
  const warnings = [];
  const ends = {}; const phaseEnd = {};
  const out = [];
  for (const r of rows) {
    // earliest start
    let start = 0;
    if (r.after && r.after !== 'start' && ends[r.after] !== undefined) start = ends[r.after];
    else if (r.after !== 'start') {
      const pi = PHASES.indexOf(r.phase);
      for (let k = pi - 1; k >= 0; k--) if (phaseEnd[PHASES[k]] !== undefined) { start = phaseEnd[PHASES[k]]; break; }
    }
    const totalHours = ROLE_IDS.reduce((a, k) => a + (r.hours[k] || 0), 0);
    if (totalHours <= 0) { out.push({ ...r, start, end: start, totalHours: 0, people: [], unassigned: [] }); ends[r.id] = start; continue; }
    // work items: one per (role, assignee) share, or a placeholder when nobody is assigned
    const tasks = []; const unassigned = []; const assignedPeople = new Set();
    for (const role of ROLE_IDS) {
      const h = r.hours[role] || 0; if (h <= 0) continue;
      const ids = (r.assign?.[role] || []).filter(id => people[id]);
      if (!ids.length) { unassigned.push(role); tasks.push({ role, person: null, left: h }); continue; }
      for (const id of ids) { tasks.push({ role, person: id, left: h / ids.length }); assignedPeople.add(id); }
    }
    let day = start; let end = start; let guard = 0;
    while (tasks.some(t => t.left > 1e-6) && guard < MAX_DAYS) {
      for (const t of tasks) {
        if (t.left <= 1e-6) continue;
        const cap = t.person ? free(t.person, day) : DEFAULT_HOURS_PER_WEEK / DAYS_PER_WEEK;
        const take = Math.min(cap, t.left);
        if (take > 0) {
          t.left -= take;
          if (t.person) { used[t.person] = used[t.person] || {}; used[t.person][day] = (used[t.person][day] || 0) + take; }
          end = day + 1;
        }
      }
      day++; guard++;
    }
    if (guard >= MAX_DAYS) warnings.push({ id: r.id, kind: 'capacity', message: `${r.name}: the people assigned have no available hours, so it cannot be scheduled. Check their hours per week and focus.` });
    if (unassigned.length) warnings.push({ id: r.id, kind: 'unassigned', message: `${r.name}: no ${unassigned.map(x => ROLES.find(y => y.id === x).label.toLowerCase()).join(' or ')} assigned. Timed as one person at ${DEFAULT_HOURS_PER_WEEK} hours a week.` });
    if (r.hoursNeeded) warnings.push({ id: r.id, kind: 'hours_needed', message: `${r.name}: hours needed.` });
    out.push({ ...r, start, end, totalHours, people: [...assignedPeople], unassigned });
    ends[r.id] = end;
    phaseEnd[r.phase] = Math.max(phaseEnd[r.phase] ?? 0, end);
  }
  for (const r of out) if (r.hoursNeeded && r.totalHours === 0 && !warnings.some(w => w.id === r.id && w.kind === 'hours_needed')) warnings.push({ id: r.id, kind: 'hours_needed', message: `${r.name}: hours needed.` });
  if (!kickoff && Object.values(people).some(p => (p.timeOff || []).length)) warnings.push({ kind: 'time_off', message: 'Time off is applied once a kickoff date is set.' });

  const totalDays = out.reduce((a, r) => Math.max(a, r.end), 0);
  const weeks = Math.max(1, Math.ceil(totalDays / DAYS_PER_WEEK));
  const weekOf = day => Math.floor(day / DAYS_PER_WEEK) + 1;
  const phases = PHASES.map(name => {
    const rs = out.filter(r => r.phase === name && r.end > r.start);
    if (!rs.length) return null;
    const s = Math.min(...rs.map(r => r.start)); const e = Math.max(...rs.map(r => r.end));
    return { name, start: s, end: e, startWeek: weekOf(s), endWeek: weekOf(Math.max(s, e - 1)), endDate: dateOf(Math.max(0, e - 1)) };
  }).filter(Boolean);
  const load = Object.keys(used).map(id => {
    const w = Array(weeks).fill(0);
    for (const [d, h] of Object.entries(used[id])) w[Math.floor(d / DAYS_PER_WEEK)] += h;
    return { id, name: people[id].name, role: people[id].role, weeks: w.map(x => Math.round(x * 10) / 10), total: Math.round(w.reduce((a, b) => a + b, 0) * 10) / 10, capacity: Math.round(daily(id) * DAYS_PER_WEEK * 10) / 10 };
  }).sort((a, b) => ROLE_IDS.indexOf(a.role) - ROLE_IDS.indexOf(b.role) || a.name.localeCompare(b.name));
  const totals = Object.fromEntries(ROLE_IDS.map(k => [k, Math.round(out.reduce((a, r) => a + (r.hours[k] || 0), 0) * 10) / 10]));
  return {
    rows: out.map(r => ({ ...r, startWeek: weekOf(r.start), endWeek: weekOf(Math.max(r.start, r.end - 1)), startDate: dateOf(r.start), endDate: r.end > r.start ? dateOf(r.end - 1) : null })),
    phases, weeks, totalDays, totals, totalHours: Object.values(totals).reduce((a, b) => a + b, 0),
    load, warnings, kickoff, endDate: totalDays ? dateOf(totalDays - 1) : null,
    hoursNeeded: out.filter(r => r.hoursNeeded).length,
  };
}

export function weeksLabel(r) {
  if (r.end <= r.start) return '';
  return r.startWeek === r.endWeek ? `Week ${r.startWeek}` : `Weeks ${r.startWeek} to ${r.endWeek}`;
}

// Turn a row's hours into library defaults: per unit hours for quantity based items, a fixed
// amount otherwise. Returns the effort record to store on the library item.
export function effortAsDefault(row, existing = {}) {
  return {
    ...existing,
    internalName: existing.internalName || '',
    doneWhen: existing.doneWhen || '',
    phase: existing.phase || '',
    setup: { ...emptyRoles(), ...(row.effort?.setup || {}) },
    perUnit: { ...emptyRoles(), ...(row.effort?.perUnit || {}) },
  };
}

export function planCsv(quote, sched, team) {
  const people = Object.fromEntries((team?.people || []).map(p => [p.id, p]));
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Phase', 'Deliverable', 'Quantity', 'Unit', ...ROLES.map(r => `${r.short} hours`), 'Total hours', 'Assigned', 'Start week', 'End week', 'Start date', 'End date', 'Done when', 'Notes'];
  const lines = [head];
  for (const r of sched.rows) {
    const assigned = ROLE_IDS.flatMap(k => (r.assign?.[k] || []).map(id => people[id]?.name).filter(Boolean));
    lines.push([r.phase, r.name, r.qtyBased ? r.qty : '', r.qtyBased ? r.units : '', ...ROLE_IDS.map(k => r.hours[k] ? Math.round(r.hours[k] * 10) / 10 : ''), r.hoursNeeded ? 'Hours needed' : Math.round(r.totalHours * 10) / 10, [...new Set(assigned)].join('; '), r.end > r.start ? r.startWeek : '', r.end > r.start ? r.endWeek : '', r.startDate || '', r.endDate || '', r.doneWhen, r.note]);
  }
  return lines.map(l => l.map(esc).join(',')).join('\n') + '\n';
}

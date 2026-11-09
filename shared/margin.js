// Gross profit margin (admin only): quote revenue against the cost of the planned hours.
// Cost = hours by role × the assigned person's cost rate (Clockify), converted to the quote
// currency. Work with nobody assigned is costed at the average rate for that role.
import { ROLE_IDS } from './plan.js';

export const DEFAULT_SETTINGS = { costCurrency: 'CAD', costToQuoteRate: 0.72, targetMargin: 50 };

export function roleAverages(team) {
  const out = {};
  for (const r of ROLE_IDS) {
    const rates = (team?.people || []).filter(p => p.active !== false && p.role === r && Number(p.costRate) > 0).map(p => Number(p.costRate));
    out[r] = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  }
  const all = (team?.people || []).filter(p => p.active !== false && Number(p.costRate) > 0).map(p => Number(p.costRate));
  out.any = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
  return out;
}

// sched: schedulePlan(...) result; calc: calculateQuote(quote). Money in cents (quote currency).
export function computeMargin(calc, sched, team, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const fx = Number(s.costToQuoteRate) || 1;
  const people = Object.fromEntries((team?.people || []).map(p => [p.id, p]));
  const avg = roleAverages(team);
  const lineAmount = Object.fromEntries(calc.lines.filter(l => l.state === 'included').map(l => [l.id, l.allocated ? 0 : (l.amount ?? null)]));
  const notes = new Set();
  let costedAtAverage = 0; let uncostedHours = 0;
  const rows = sched.rows.map(r => {
    let cost = 0; let hours = 0;
    for (const role of ROLE_IDS) {
      const h = r.hours[role] || 0; if (h <= 0) continue;
      hours += h;
      const ids = (r.assign?.[role] || []).filter(id => people[id]);
      const rates = ids.map(id => Number(people[id].costRate) || null);
      let rate;
      if (ids.length && rates.every(x => x)) rate = rates.reduce((a, b) => a + b, 0) / rates.length;
      else { rate = avg[role] ?? avg.any; costedAtAverage += h; }
      if (!rate) { uncostedHours += h; continue; }
      cost += h * rate * fx * 100; // cents
    }
    const revenue = r.kind === 'item' ? lineAmount[r.id] ?? null : null;
    return { id: r.id, name: r.name, kind: r.kind, phase: r.phase, hours, cost: Math.round(cost), revenue, hoursNeeded: r.hoursNeeded,
      margin: revenue ? (revenue - cost) / revenue : null };
  });
  if (costedAtAverage) notes.add(`${round1(costedAtAverage)} hours have nobody assigned (or no cost rate) and are costed at the role's average rate.`);
  if (uncostedHours) notes.add(`${round1(uncostedHours)} hours could not be costed: no cost rates on the Team yet.`);
  const missing = rows.filter(r => r.hoursNeeded && r.kind === 'item');
  if (missing.length) notes.add(`${missing.length} deliverable${missing.length === 1 ? ' has' : 's have'} no hours, so ${missing.length === 1 ? 'its' : 'their'} cost is missing and the margin reads high.`);
  const baselineHours = sched.rows.filter(r => r.baseline).reduce((a, r) => a + ROLE_IDS.reduce((x, k) => x + (r.hours[k] || 0), 0), 0);
  const allHours = sched.rows.reduce((a, r) => a + ROLE_IDS.reduce((x, k) => x + (r.hours[k] || 0), 0), 0);
  const baselineShare = allHours ? baselineHours / allHours : 0;
  if (baselineShare > 0.2) notes.add(`${Math.round(baselineShare * 100)}% of planned hours are Clockify baselines. Logged tasks are often only part of a deliverable, so baselines tend to run low and this margin reads optimistic until the PM confirms the hours.`);
  const revenue = calc.total;
  const cost = rows.reduce((a, r) => a + r.cost, 0);
  const gp = revenue - cost;
  const bySection = calc.sections.filter(x => !x.empty).map(sec => {
    const ids = new Set(sec.lines.map(l => l.id));
    const c = rows.filter(r => ids.has(r.id)).reduce((a, r) => a + r.cost, 0);
    return { id: sec.id, name: sec.name, revenue: sec.subtotal, cost: c, margin: sec.subtotal ? (sec.subtotal - c) / sec.subtotal : null };
  });
  const internal = rows.filter(r => r.kind === 'extra').reduce((a, r) => a + r.cost, 0);
  return {
    revenue, cost, gp, margin: revenue ? gp / revenue : null, internalCost: internal,
    hours: rows.reduce((a, r) => a + r.hours, 0), rows, bySection, notes: [...notes],
    target: Number(s.targetMargin) || null, belowTarget: revenue && s.targetMargin != null ? gp / revenue * 100 < Number(s.targetMargin) : false,
    fx, costCurrency: s.costCurrency, pending: calc.totalStatus === 'pending', baselineShare,
    effectiveRate: allHours ? Math.round((calc.total / 100) / allHours) : null,
  };
}
const round1 = v => Math.round(v * 10) / 10;

// Internal delivery plan: hours, scheduling against capacity, and a price free export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newQuote } from '../shared/quote.js';
import { schedulePlan, planRows, planCsv, hoursFor, effortAsDefault, addWorkdays } from '../shared/plan.js';
import { renderPlanDoc } from '../shared/plan-doc.js';
import { calculateQuote } from '../shared/pricing.js';

const library = JSON.parse(fs.readFileSync(new URL('../shared/library-default.json', import.meta.url)));
const pytorch = JSON.parse(fs.readFileSync(new URL('../seed/quotes/example-pytorch.json', import.meta.url)));
const team = { people: [
  { id: 'des', name: 'Priya', role: 'design', hoursPerWeek: 40 },
  { id: 'dev1', name: 'Marco', role: 'dev', hoursPerWeek: 40 },
  { id: 'dev2', name: 'Sam', role: 'dev', hoursPerWeek: 40 },
  { id: 'pm', name: 'Jo', role: 'pm', hoursPerWeek: 20, timeOff: [{ from: '2026-12-01', to: '2026-12-05' }] },
] };

const simple = () => {
  const q = newQuote(library, null, { type: 'new_platform', client: 'Acme' });
  q.lines = { DESIGN_COMPONENTS: { state: 'included' }, BASE_STD_COMPONENT: { state: 'included', qty: 10 }, MIG_L1_PAGE: { state: 'included', qty: 40 } };
  q.plan.extra = [];
  return q;
};

test('hours: setup plus hours per unit by role; missing effort is flagged as hours needed', () => {
  assert.deepEqual(hoursFor({ setup: { dev: 4 }, perUnit: { dev: 2, pm: 0.5 } }, 10).hours, { design: 0, dev: 24, pm: 5, lead: 0 });
  const rows = planRows(simple());
  assert.ok(rows.every(r => r.hoursNeeded), 'library has no hours yet, so every deliverable needs hours');
  const sched = schedulePlan(simple());
  assert.equal(sched.hoursNeeded, 3);
  assert.ok(sched.warnings.some(w => w.kind === 'hours_needed'));
});

test('scheduling: phases run in order, capacity sets the duration, a second developer halves it', () => {
  const q = simple();
  q.plan.rows.DESIGN_COMPONENTS = { effort: { perUnit: { design: 8 } }, assign: { design: ['des'] } };   // 10 × 8h = 80h = 2 weeks at 40h
  q.plan.rows.BASE_STD_COMPONENT = { effort: { perUnit: { dev: 8 } }, assign: { dev: ['dev1'] } };       // 80h = 2 weeks
  q.plan.rows.MIG_L1_PAGE = { effort: { perUnit: { dev: 2 } }, assign: { dev: ['dev1'] } };               // 80h = 2 weeks
  let s = schedulePlan(q, { team });
  const r = Object.fromEntries(s.rows.map(x => [x.id, x]));
  assert.equal(r.DESIGN_COMPONENTS.start, 0); assert.equal(r.DESIGN_COMPONENTS.end, 10);
  assert.equal(r.BASE_STD_COMPONENT.start, 10, 'build waits for design');
  assert.equal(r.MIG_L1_PAGE.start, 20, 'migration waits for build');
  assert.equal(s.weeks, 6);
  assert.deepEqual(s.phases.map(p => p.name), ['Design', 'Build', 'Migration']);
  q.plan.rows.MIG_L1_PAGE.assign = { dev: ['dev1', 'dev2'] };
  s = schedulePlan(q, { team });
  assert.equal(s.rows.find(x => x.id === 'MIG_L1_PAGE').end, 25, 'two developers: one week');
  // focus: Marco at 50% on this project doubles his build time
  q.plan.people = { dev1: { focus: 50 } };
  s = schedulePlan(q, { team });
  assert.equal(s.rows.find(x => x.id === 'BASE_STD_COMPONENT').end, 30);
  // nobody is ever booked past their capacity
  for (const p of s.load) assert.ok(p.weeks.every(w => w <= p.capacity + 1e-6), `${p.name} over capacity`);
});

test('scheduling: parallel rows share people, unassigned work is flagged, time off applies with a kickoff date', () => {
  const q = simple();
  q.plan.rows.BASE_STD_COMPONENT = { effort: { perUnit: { dev: 4 } }, assign: { dev: ['dev1'] } };  // 40h
  q.plan.rows.MIG_L1_PAGE = { phase: 'Build', effort: { perUnit: { dev: 1 } }, assign: { dev: ['dev1'] } }; // 40h, same person, same phase
  q.plan.rows.DESIGN_COMPONENTS = { effort: { perUnit: { design: 1 } } };
  const s = schedulePlan(q, { team });
  const r = Object.fromEntries(s.rows.map(x => [x.id, x]));
  assert.equal(r.MIG_L1_PAGE.end, r.BASE_STD_COMPONENT.end + 5, 'the same developer cannot do both at once');
  assert.ok(s.warnings.some(w => w.kind === 'unassigned' && w.id === 'DESIGN_COMPONENTS'));
  const t = simple(); t.plan.extra = []; t.lines = { BASE_STD_COMPONENT: { state: 'included', qty: 1 } };
  t.plan.rows.BASE_STD_COMPONENT = { effort: { setup: { pm: 20 } }, assign: { pm: ['pm'] } }; // 20h at 4h/day = 5 days
  t.plan.kickoff = '2026-11-30'; // Monday; Jo is away Tue to Fri that week
  const st = schedulePlan(t, { team });
  assert.equal(st.rows[0].end, 9, 'four days of time off push the work out');
  assert.equal(addWorkdays('2026-11-27', 1), '2026-11-30');
  assert.equal(st.rows[0].startDate, '2026-11-30');
});

test('saving hours as defaults: the next quote picks them up from the library', () => {
  const q = simple();
  q.plan.rows.MIG_L1_PAGE = { effort: { perUnit: { dev: 3, pm: 0.5 } } };
  const row = planRows(q).find(r => r.id === 'MIG_L1_PAGE');
  const lib = JSON.parse(JSON.stringify(library));
  lib.items.find(i => i.id === 'MIG_L1_PAGE').effort = effortAsDefault(row);
  const q2 = simple(); q2.lines.MIG_L1_PAGE.qty = 10;
  const r2 = planRows(q2, { library: lib }).find(r => r.id === 'MIG_L1_PAGE');
  assert.equal(r2.effortSource, 'library'); assert.equal(r2.hours.dev, 30); assert.equal(r2.hours.pm, 5); assert.equal(r2.hoursNeeded, false);
});

test('internal plan export contains no prices or client proposal copy', () => {
  const q = JSON.parse(JSON.stringify(pytorch));
  q.plan = { kickoff: '2026-11-16', rows: {}, extra: [], people: {}, notes: 'Use the AAIF staging dataset.' };
  for (const l of calculateQuote(q).lines.filter(l => l.state === 'included')) q.plan.rows[l.id] = { effort: { setup: { dev: 6, pm: 1 } }, assign: { dev: ['dev1'], pm: ['pm'] } };
  const sched = schedulePlan(q, { team });
  const html = renderPlanDoc(q, sched, team);
  const body = html.replace(/<style>[\s\S]*?<\/style>/, '');
  assert.ok(!/\$\s?\d/.test(body), 'no dollar amounts');
  for (const word of ['Investment', 'Rate', 'Optional Additions', 'Payment terms', 'Total investment']) assert.ok(!body.includes(word), `no "${word}"`);
  for (const l of calculateQuote(q).lines.filter(l => l.state === 'included' && l.item.receives)) assert.ok(!body.includes(l.item.receives), 'no client facing "what you receive" copy');
  assert.match(body, /Internal delivery plan/); assert.match(body, /Marco/); assert.match(body, /Use the AAIF staging dataset/);
  const csv = planCsv(q, sched, team);
  assert.ok(!/\$/.test(csv)); assert.match(csv.split('\n')[0], /^Phase,Deliverable,Quantity/);
  assert.equal(csv.trim().split('\n').length, sched.rows.length + 1);
});

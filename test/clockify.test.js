// Clockify team sync, hour baselines from logged time, and admin only gross margin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { mergeTeam, hoursPerWeekFrom, costRateFrom } from '../server/clockify.js';
import { roleFromGroups, entriesFromCsv, entriesFromReport, computeBaselines, applyBaselines, splitCategories, durationHours } from '../shared/baselines.js';
import { computeMargin } from '../shared/margin.js';
import { schedulePlan } from '../shared/plan.js';
import { calculateQuote } from '../shared/pricing.js';
import { newQuote } from '../shared/quote.js';

const library = JSON.parse(fs.readFileSync(new URL('../shared/library-default.json', import.meta.url)));

// a small fake Clockify workspace
const WS = 'ws1';
const users = [
  { id: 'u1', name: 'Best', status: 'ACTIVE', memberships: [{ membershipType: 'WORKSPACE', targetId: WS, costRate: { amount: 6500, currency: 'CAD' } }] },
  { id: 'u2', name: 'Prince', status: 'ACTIVE', memberships: [{ membershipType: 'WORKSPACE', targetId: WS, costRate: { amount: 6500, currency: 'CAD' } }] },
  { id: 'u3', name: 'Stephen', status: 'ACTIVE', memberships: [{ membershipType: 'WORKSPACE', targetId: WS, costRate: { amount: 4500, currency: 'CAD' } }] },
  { id: 'u4', name: 'MJ', status: 'ACTIVE', memberships: [{ membershipType: 'WORKSPACE', targetId: WS, costRate: { amount: 3000, currency: 'CAD' } }] },
  { id: 'u5', name: 'Owner', status: 'ACTIVE', memberships: [] },
];
const groups = [
  { id: 'g1', name: 'Designers', userIds: ['u1'] }, { id: 'g2', name: 'Design Leads', userIds: ['u1'] },
  { id: 'g3', name: 'Developers', userIds: ['u2', 'u3'] }, { id: 'g4', name: 'Midday', userIds: ['u2'] }, { id: 'g5', name: 'Dev Leads', userIds: ['u2'] },
  { id: 'g6', name: 'Project Manager', userIds: ['u4'] },
];
const profiles = { u1: { workCapacity: 'PT8H', workingDays: '["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"]' }, u2: { workCapacity: 'PT7H30M', workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'] }, u3: { workCapacity: 'PT6H' }, u4: {} };
const timeOff = [{ userId: 'u3', status: { statusType: 'APPROVED' }, timeOffPeriod: { period: { start: '2026-12-21T00:00:00Z', end: '2026-12-31T00:00:00Z' } } }];
const entry = (desc, user, hours, project = 'Acme Site', client = 'Acme', cat = 'Frontend Components & Design System') => ({ description: desc, userId: user, userName: users.find(u => u.id === user).name, projectName: project, clientName: client, timeInterval: { duration: hours * 3600, start: '2026-06-01T10:00:00Z' }, customFields: [{ name: 'Task Category', value: cat }] });
const report = [];
for (let i = 0; i < 12; i++) report.push(entry(`Build hero component ${i}`, 'u3', 4), entry(`Hero component design ${i}`, 'u1', 2, 'Acme Site', 'Acme', 'Design & Prototyping'));
for (let i = 0; i < 10; i++) report.push(entry(`Fix component bug ${i}`, 'u3', 0.5, 'Acme Site', 'Acme', 'QA, Feedback & Remediation'));
for (let i = 0; i < 8; i++) report.push(entry(`Develop about page ${i}`, 'u3', 2, 'Acme Site', 'Acme', 'Site Buildout & CMS Integration'));
report.push(entry('Weekly Project Management', 'u4', 6, 'Acme Site', 'Acme', 'Program Management & Collaboration'));

function fakeClockify() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    assert.equal(opts.headers['X-Api-Key'], 'test-key');
    const u = new URL(url); const p = u.pathname; const page = Number(u.searchParams.get('page') || JSON.parse(opts.body || '{}').page || JSON.parse(opts.body || '{}').detailedFilter?.page || 1);
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (p === '/api/v1/user') return ok({ activeWorkspace: WS });
    if (p === `/api/v1/workspaces/${WS}/users`) return ok(page === 1 ? users : []);
    if (p === `/api/v1/workspaces/${WS}/user-groups`) return ok(page === 1 ? groups : []);
    if (p.startsWith(`/api/v1/workspaces/${WS}/member-profile/`)) return ok(profiles[p.split('/').pop()] || {});
    if (p === `/api/v1/workspaces/${WS}/time-off/requests`) return ok({ count: 1, requests: page === 1 ? timeOff : [] });
    if (p === `/api/v1/workspaces/${WS}/custom-fields`) return ok([]);
    if (p === `/v1/workspaces/${WS}/reports/detailed`) return ok({ timeentries: page === 1 ? report : [] });
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
  return { fetchImpl, calls };
}

test('roles from Clockify groups: leads win, design leads stay designers with a lead flag', () => {
  assert.deepEqual(roleFromGroups(['Designers', 'Design Leads']), { role: 'design', lead: true });
  assert.deepEqual(roleFromGroups(['Developers', 'Midday', 'Dev Leads']), { role: 'lead', lead: true });
  assert.deepEqual(roleFromGroups(['Developers', 'Midday']), { role: 'dev', lead: false });
  assert.deepEqual(roleFromGroups(['Project Manager']), { role: 'pm', lead: false });
  assert.equal(roleFromGroups(['Midday']), null);
  assert.equal(hoursPerWeekFrom(profiles.u2), 30);
  assert.equal(hoursPerWeekFrom(profiles.u3), 30);
  assert.deepEqual(costRateFrom(users[0], WS), { amount: 65, currency: 'CAD' });
  assert.deepEqual(splitCategories('QA, Feedback & Remediation, Frontend Components & Design System'), ['QA, Feedback & Remediation', 'Frontend Components & Design System']);
  assert.equal(durationHours('PT1H30M'), 1.5); assert.equal(durationHours(5400), 1.5);
});

test('team merge: adds people, keeps hand set roles and manual time off, deactivates leavers', () => {
  const current = { people: [
    { id: 'p1', name: 'Stephen', role: 'lead', roleLocked: true, hoursPerWeek: 40, timeOff: [{ from: '2026-11-20', to: '2026-11-21' }] },
    { id: 'p9', name: 'Gone', clockifyId: 'u9', role: 'dev', hoursPerWeek: 40 },
  ] };
  const { team, report: r } = mergeTeam(current, { users, groups, profiles, timeOff, ws: WS });
  const by = Object.fromEntries(team.people.map(p => [p.name, p]));
  assert.equal(by.Best.role, 'design'); assert.equal(by.Best.lead, true); assert.equal(by.Best.hoursPerWeek, 40); assert.equal(by.Best.costRate, 65);
  assert.equal(by.Prince.role, 'lead');
  assert.equal(by.Stephen.role, 'lead', 'hand set role kept'); assert.equal(by.Stephen.clockifyId, 'u3'); assert.equal(by.Stephen.costRate, 45);
  assert.equal(by.Stephen.timeOff.length, 2, 'manual time off kept, Clockify time off added');
  assert.equal(by.MJ.role, 'pm');
  assert.equal(by.Gone.active, false); assert.deepEqual(r.skipped, ['Owner']);
});

test('baselines: build work excludes fixes, never overwrites hours a person set', () => {
  const entries = entriesFromReport(report, { roleOfUserId: id => roleFromGroups(groups.filter(g => g.userIds.includes(id)).map(g => g.name)) });
  const { proposals, summary } = computeBaselines(entries, library);
  const p = Object.fromEntries(proposals.map(x => [x.id, x]));
  assert.equal(p.BASE_STD_COMPONENT.effort.perUnit.dev, 4, 'four hours per component, the 0.5h fixes are excluded');
  assert.equal(p.DESIGN_COMPONENTS.effort.perUnit.design, 2);
  assert.ok(p.BASE_STD_COMPONENT.effort.perUnit.pm > 0, 'project management share added');
  assert.match(p.BASE_STD_COMPONENT.basis, /Median of developer hours per component task: 4h across 12 tasks/);
  assert.equal(p.MIG_STRUCTURED_RECORDS.method, 'assumption');
  assert.ok(summary.entries > 0);
  const lib = JSON.parse(JSON.stringify(library));
  lib.items.find(i => i.id === 'BASE_STD_COMPONENT').effort = { setup: {}, perUnit: { dev: 6 }, source: 'pm' };
  const { library: out, applied, skipped } = applyBaselines(lib, proposals);
  assert.ok(skipped.includes('BASE_STD_COMPONENT')); assert.equal(out.items.find(i => i.id === 'BASE_STD_COMPONENT').effort.perUnit.dev, 6);
  const dc = out.items.find(i => i.id === 'DESIGN_COMPONENTS').effort;
  assert.equal(dc.source, 'baseline'); assert.equal(dc.baseline.samples, 12); assert.ok(applied.includes('DESIGN_COMPONENTS'));
  // a later refresh may replace an earlier baseline
  assert.ok(applyBaselines(out, proposals).applied.includes('DESIGN_COMPONENTS'));
});

test('baselines from the Clockify CSV export format', () => {
  const head = '"Project","Client","Description","Task","User","Group","Email","Tags","Duration (decimal)","Cost Rate (CAD)","Task Category","Start Date"';
  const rows = Array.from({ length: 6 }, (_, i) => `"Site","Acme","Build card component ${i}","","Stephen","Developers","s@x","","3.00","45.00","Frontend Components & Design System","06/01/2026"`);
  const es = entriesFromCsv([head, ...rows].join('\n'));
  assert.equal(es.length, 6); assert.equal(es[0].role, 'dev'); assert.equal(es[0].hours, 3);
  assert.equal(computeBaselines(es, library).proposals.find(p => p.id === 'BASE_STD_COMPONENT').effort.perUnit.dev, 3);
  assert.throws(() => entriesFromCsv('a,b\n1,2'), /Clockify detailed report/);
});

test('gross margin: assigned people at their rate, unassigned at the role average, converted to USD', () => {
  const q = newQuote(library, null, { type: 'new_platform', client: 'Acme' });
  q.lines = { BASE_STD_COMPONENT: { state: 'included', qty: 10 } }; // 10 × $2,500 = $25,000
  q.plan.extra = [];
  q.plan.rows.BASE_STD_COMPONENT = { effort: { perUnit: { dev: 10, design: 2 } }, assign: { dev: ['d1'] } };
  const team = { people: [{ id: 'd1', name: 'Dev', role: 'dev', hoursPerWeek: 40, costRate: 50 }, { id: 'x1', name: 'Des A', role: 'design', hoursPerWeek: 40, costRate: 40 }, { id: 'x2', name: 'Des B', role: 'design', hoursPerWeek: 40, costRate: 60 }] };
  const calc = calculateQuote(q);
  const m = computeMargin(calc, schedulePlan(q, { team }), team, { costToQuoteRate: 0.7, targetMargin: 60 });
  // dev 100h × 50 CAD + design 20h × 50 CAD average = 6,000 CAD = 4,200 USD
  assert.equal(m.revenue, 2500000); assert.equal(m.cost, 420000); assert.equal(m.gp, 2080000);
  assert.equal(Math.round(m.margin * 1000), 832);
  assert.equal(m.belowTarget, false);
  assert.ok(m.notes.some(n => /average rate/.test(n)));
  assert.equal(m.rows[0].revenue, 2500000);
});

test('server: Clockify sync and baselines through the API; costs hidden from non admins', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ck-'));
  const { fetchImpl, calls } = fakeClockify();
  const app = createApp({ dataDir, clockify: { apiKey: 'test-key', workspaceId: '', enabled: true }, clockifyFetch: fetchImpl });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await api('GET', '/api/health')).body.clockify, true);
    const s = (await api('POST', '/api/team/clockify-sync')).body;
    assert.equal(s.team.people.length, 4); assert.deepEqual(s.report.skipped, ['Owner']);
    assert.equal(s.team.people.find(p => p.name === 'Prince').costRate, 65, 'admin (no sign-in configured) sees cost rates');
    assert.ok(calls.some(c => c.includes('/time-off/requests')));
    const b = (await api('POST', '/api/library/baselines', { source: 'clockify', months: 12 })).body;
    assert.ok(b.proposals.find(p => p.id === 'BASE_STD_COMPONENT'));
    assert.equal((await api('PUT', '/api/settings', { costCurrency: 'CAD', costToQuoteRate: 0.72, targetMargin: 50 })).status, 200);
    assert.equal((await api('PUT', '/api/settings', { costToQuoteRate: -1 })).status, 400);
    const m = (await api('GET', '/api/quotes/example-pytorch/margin')).body;
    assert.equal(m.revenue, 9125000); assert.ok(Array.isArray(m.rows));
  } finally { srv.close(); }
  // without a key the sync explains what to do
  const app2 = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ck2-')), clockify: { enabled: false } });
  const srv2 = await new Promise(r => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${srv2.address().port}/api/team/clockify-sync`, { method: 'POST' });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /CLOCKIFY_API_KEY/);
  } finally { srv2.close(); }
});

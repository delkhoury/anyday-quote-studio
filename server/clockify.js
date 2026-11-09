// Clockify: team members (groups, weekly capacity, time off, cost rates) and logged time for
// hour baselines. Reads only. The API key lives in the CLOCKIFY_API_KEY environment variable.
import { roleFromGroups, entriesFromReport } from '../shared/baselines.js';

export function clockifyConfig(env = process.env) {
  return { apiKey: env.CLOCKIFY_API_KEY || '', workspaceId: env.CLOCKIFY_WORKSPACE_ID || '', enabled: !!env.CLOCKIFY_API_KEY };
}

export function clockifyClient({ apiKey, workspaceId = '', fetchImpl = fetch, base = 'https://api.clockify.me/api/v1', reportsBase = 'https://reports.api.clockify.me/v1' }) {
  const call = async (url, opts = {}) => {
    const res = await fetchImpl(url, { ...opts, headers: { 'X-Api-Key': apiKey, 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = res.status === 401 || res.status === 403 ? 'Clockify refused the API key. Check CLOCKIFY_API_KEY in Render.' : `Clockify request failed (${res.status}) ${text.slice(0, 200)}`;
      throw Object.assign(new Error(msg), { status: 502 });
    }
    return res.json();
  };
  const get = p => call(base + p);
  const post = (p, body, b = base) => call(b + p, { method: 'POST', body: JSON.stringify(body) });
  let ws = workspaceId;
  const workspace = async () => (ws = ws || (await get('/user')).activeWorkspace);
  async function pages(fn, size = 200, max = 50) {
    const out = [];
    for (let page = 1; page <= max; page++) { const batch = await fn(page, size); out.push(...batch); if (batch.length < size) break; }
    return out;
  }
  return {
    workspace,
    users: async () => { const w = await workspace(); return pages((page, size) => get(`/workspaces/${w}/users?status=ACTIVE&memberships=WORKSPACE&include-roles=false&page=${page}&page-size=${size}`)); },
    groups: async () => { const w = await workspace(); return pages((page, size) => get(`/workspaces/${w}/user-groups?page=${page}&page-size=${size}`)); },
    profile: async uid => { const w = await workspace(); return get(`/workspaces/${w}/member-profile/${uid}`).catch(() => null); },
    timeOff: async (start, end) => {
      const w = await workspace();
      return pages(async (page, size) => { const r = await post(`/workspaces/${w}/time-off/requests`, { start, end, statuses: ['APPROVED'], page, pageSize: size }).catch(() => ({ requests: [] })); return r.requests || (Array.isArray(r) ? r : []); }, 200, 10);
    },
    customFields: async () => { const w = await workspace(); return get(`/workspaces/${w}/custom-fields`).catch(() => []); },
    detailed: async (from, to) => {
      const w = await workspace();
      return pages(async (page, size) => {
        const r = await post(`/workspaces/${w}/reports/detailed`, { dateRangeStart: from, dateRangeEnd: to, detailedFilter: { page, pageSize: size }, exportType: 'JSON' }, reportsBase);
        return r.timeentries || r.timeEntries || [];
      }, 1000, 100);
    },
  };
}

export function hoursPerWeekFrom(profile) {
  if (!profile?.workCapacity) return null;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/.exec(profile.workCapacity);
  const perDay = m ? Number(m[1] || 0) + Number(m[2] || 0) / 60 : 0;
  let days = profile.workingDays;
  if (typeof days === 'string') { try { days = JSON.parse(days); } catch { days = days.split(/[,\s]+/); } }
  const n = Array.isArray(days) && days.length ? days.length : 5;
  return perDay ? Math.round(perDay * n * 10) / 10 : null;
}

export function costRateFrom(user, ws) {
  const ms = user.memberships || [];
  const m = ms.find(x => x.membershipType === 'WORKSPACE' && (!ws || x.targetId === ws)) || ms.find(x => x.costRate) || null;
  const cr = m?.costRate || user.costRate || null;
  if (!cr || cr.amount == null) return null;
  return { amount: Math.round(Number(cr.amount)) / 100, currency: cr.currency || null };
}

// Merge Clockify into the studio team. People are matched by Clockify id, then by name.
// Roles come from groups unless someone set the role by hand (roleLocked). People who left
// Clockify are kept but marked inactive, so old plans still read.
export function mergeTeam(current, { users, groups, profiles = {}, timeOff = [], ws = '' }) {
  const groupsOf = id => groups.filter(g => (g.userIds || []).includes(id)).map(g => g.name);
  const people = (current?.people || []).map(p => ({ ...p }));
  const byCk = new Map(people.filter(p => p.clockifyId).map(p => [p.clockifyId, p]));
  const byName = new Map(people.map(p => [String(p.name).trim().toLowerCase(), p]));
  const report = { added: [], updated: [], deactivated: [], skipped: [] };
  const seen = new Set();
  for (const u of users) {
    const names = groupsOf(u.id);
    const mapped = roleFromGroups(names);
    const existing = byCk.get(u.id) || byName.get(String(u.name).trim().toLowerCase());
    if (!mapped && !existing) { report.skipped.push(u.name); continue; }
    seen.add(u.id);
    const cr = costRateFrom(u, ws);
    const hpw = hoursPerWeekFrom(profiles[u.id]);
    const off = timeOff.filter(t => (t.userId || t.user?.id) === u.id).map(t => {
      const p = t.timeOffPeriod?.period || t.period || {};
      return { from: String(p.start || '').slice(0, 10), to: String(p.end || p.start || '').slice(0, 10), source: 'clockify' };
    }).filter(t => t.from);
    const fields = {
      clockifyId: u.id, name: u.name || existing?.name, groups: names,
      ...(existing?.roleLocked ? {} : mapped ? { role: mapped.role, lead: mapped.lead } : {}),
      ...(hpw != null ? { hoursPerWeek: hpw } : {}),
      ...(cr ? { costRate: cr.amount, costCurrency: cr.currency } : {}),
      timeOff: [...(existing?.timeOff || []).filter(t => t.source !== 'clockify'), ...off],
      active: true, syncedAt: new Date().toISOString(),
    };
    if (existing) { Object.assign(existing, fields); report.updated.push(existing.name); }
    else { const p = { id: 'ck_' + u.id, hoursPerWeek: 32, role: mapped.role, ...fields }; people.push(p); report.added.push(p.name); }
  }
  for (const p of people) if (p.clockifyId && !seen.has(p.clockifyId) && p.active !== false) { p.active = false; report.deactivated.push(p.name); }
  return { team: { ...current, people }, report };
}

export async function syncTeamFromClockify(client, current) {
  const ws = await client.workspace();
  const [users, groups] = await Promise.all([client.users(), client.groups()]);
  const profiles = {};
  for (const u of users) profiles[u.id] = await client.profile(u.id);
  const now = new Date(); const start = new Date(now.getTime() - 30 * 864e5).toISOString(); const end = new Date(now.getTime() + 365 * 864e5).toISOString();
  const timeOff = await client.timeOff(start, end).catch(() => []);
  return mergeTeam(current, { users, groups, profiles, timeOff, ws });
}

export async function entriesFromClockify(client, { months = 12, team = null } = {}) {
  const to = new Date(); const from = new Date(to.getTime() - months * 30.5 * 864e5);
  const iso = d => d.toISOString().replace('Z', '');
  const [rows, fields, groups] = await Promise.all([client.detailed(iso(from), iso(to)), client.customFields(), client.groups()]);
  const names = Object.fromEntries((fields || []).map(f => [f.id, f.name]));
  const byCk = Object.fromEntries((team?.people || []).filter(p => p.clockifyId).map(p => [p.clockifyId, p]));
  const roleOfUserId = id => (byCk[id] ? { role: byCk[id].role } : roleFromGroups(groups.filter(g => (g.userIds || []).includes(id)).map(g => g.name)));
  return entriesFromReport(rows, { roleOfUserId, customFieldNames: names });
}

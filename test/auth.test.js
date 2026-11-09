import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { sign, verify, isAllowed, authConfig } from '../server/auth.js';

const SECRET = 'x'.repeat(48);
const cfg = { ...authConfig({ GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', SESSION_SECRET: SECRET, ALLOWED_DOMAIN: 'anyday.inc', ALLOWED_EMAILS: 'guest@partner.com', ADMIN_EMAILS: 'boss@anyday.inc', PUBLIC_URL: '' }) };
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

test('session tokens are signed and expire', () => {
  const t = sign({ email: 'a@anyday.inc', exp: Date.now() + 1000 }, SECRET);
  assert.equal(verify(t, SECRET).email, 'a@anyday.inc');
  assert.equal(verify(t, 'y'.repeat(48)), null);
  const [body, mac] = t.split('.');
  const forged = b64u({ email: 'evil@x.com', exp: Date.now() + 1000 }) + '.' + mac;
  assert.equal(verify(forged, SECRET), null);
  assert.equal(verify(sign({ email: 'a', exp: Date.now() - 1 }, SECRET), SECRET), null);
  void body;
});

test('only verified anyday.inc Workspace accounts and listed guests are allowed', () => {
  assert.equal(isAllowed({ email: 'danny@anyday.inc', email_verified: true, hd: 'anyday.inc' }, cfg).ok, true);
  assert.equal(isAllowed({ email: 'danny@anyday.inc', email_verified: true }, cfg).ok, false); // no hd: not a Workspace account
  assert.equal(isAllowed({ email: 'someone@gmail.com', email_verified: true }, cfg).ok, false);
  assert.equal(isAllowed({ email: 'x@anyday.inc.evil.com', email_verified: true, hd: 'anyday.inc' }, cfg).ok, false);
  assert.equal(isAllowed({ email: 'danny@anyday.inc', email_verified: false, hd: 'anyday.inc' }, cfg).ok, false);
  assert.equal(isAllowed({ email: 'guest@partner.com', email_verified: true }, cfg).ok, true);
});

async function withApp(claimsFor, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-auth-'));
  let lastNonce = null;
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(opts.body);
    assert.ok(body.get('code_verifier'), 'PKCE verifier sent');
    const claims = { iss: 'https://accounts.google.com', aud: cfg.clientId, nonce: lastNonce, exp: Math.floor(Date.now() / 1000) + 300, ...claimsFor(body.get('code')) };
    return { ok: true, json: async () => ({ id_token: `h.${b64u(claims)}.s` }) };
  };
  const app = createApp({ dataDir, auth: cfg, fetchImpl });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const signIn = async code => {
    const r1 = await fetch(base + '/auth/google', { redirect: 'manual' });
    const loc = new URL(r1.headers.get('location'));
    assert.equal(loc.hostname, 'accounts.google.com');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('hd'), null); // guests are allowed in this config, so Google is not told to hide other accounts
    lastNonce = loc.searchParams.get('nonce');
    const flow = r1.headers.getSetCookie().find(c => c.startsWith('aqs_oauth=')).split(';')[0];
    const r2 = await fetch(`${base}/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: flow } });
    const sess = r2.headers.getSetCookie().find(c => c.startsWith('aqs_session='));
    return { r2, cookie: sess && !sess.startsWith('aqs_session=;') ? sess.split(';')[0] : null };
  };
  try { await fn({ base, signIn }); } finally { srv.close(); }
}

test('full sign-in flow protects the app and the API', async () => {
  await withApp(code => code === 'staff' ? { email: 'danny@anyday.inc', email_verified: true, hd: 'anyday.inc', name: 'Danny' } : { email: 'x@gmail.com', email_verified: true }, async ({ base, signIn }) => {
    // signed out
    assert.equal((await fetch(base + '/api/quotes')).status, 401);
    const home = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(home.status, 302); assert.equal(home.headers.get('location'), '/auth/login');
    assert.equal((await fetch(base + '/auth/login')).status, 200);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/assets/anyday-logo-white.png')).status, 200);
    assert.equal((await fetch(base + '/app.js', { redirect: 'manual' })).status, 302);
    // outsider rejected
    const bad = await signIn('outsider');
    assert.equal(bad.cookie, null);
    assert.match(decodeURIComponent(bad.r2.headers.get('location')), /Only anyday\.inc Google accounts/);
    // staff accepted
    const ok = await signIn('staff');
    assert.ok(ok.cookie);
    const me = await (await fetch(base + '/api/me', { headers: { cookie: ok.cookie } })).json();
    assert.equal(me.user.email, 'danny@anyday.inc');
    const list = await fetch(base + '/api/quotes', { headers: { cookie: ok.cookie } });
    assert.equal(list.status, 200);
    // edits are stamped with the signed-in user
    const q = await (await fetch(base + '/api/quotes', { method: 'POST', headers: { cookie: ok.cookie, 'content-type': 'application/json' }, body: '{"client":"Stamp"}' })).json();
    assert.equal(q.createdBy, 'danny@anyday.inc'); assert.equal(q.preparedBy, 'Danny');
    const saved = await (await fetch(`${base}/api/quotes/${q.id}`, { method: 'PUT', headers: { cookie: ok.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ quote: q }) })).json();
    assert.equal(saved.updatedBy, 'danny@anyday.inc');
    // cross-site writes blocked even with a valid session
    const x = await fetch(base + '/api/quotes', { method: 'POST', headers: { cookie: ok.cookie, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(x.status, 403);
    // stale or tampered OAuth state is refused
    const r = await fetch(`${base}/auth/callback?code=staff&state=forged`, { redirect: 'manual' });
    assert.match(decodeURIComponent(r.headers.get('location')), /expired/);
    // sign out clears the session
    const out = await fetch(base + '/auth/logout', { method: 'POST', headers: { cookie: ok.cookie } });
    assert.ok(out.headers.getSetCookie().some(c => c.startsWith('aqs_session=;') && /Max-Age=0/.test(c)));
  });
});

test('a public deployment cannot start without sign-in configured', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['server/index.js'], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), env: { ...process.env, HOST: '0.0.0.0', PORT: '0', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-x-')) }, timeout: 10000, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start/);
});

test('cost rates and margins are visible to admins only', async () => {
  const claims = code => ({ email: code === 'boss' ? 'boss@anyday.inc' : 'pm@anyday.inc', email_verified: true, hd: 'anyday.inc', name: code });
  await withApp(claims, async ({ base, signIn }) => {
    const boss = (await signIn('boss')).cookie; const pm = (await signIn('pm')).cookie;
    const call = (cookie, m, p, b) => fetch(base + p, { method: m, headers: { cookie, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    assert.equal((await (await call(boss, 'GET', '/api/me')).json()).admin, true);
    assert.equal((await (await call(pm, 'GET', '/api/me')).json()).admin, false);
    const t0 = await (await call(boss, 'GET', '/api/team')).json();
    const saved = await (await call(boss, 'PUT', '/api/team', { team: { people: [{ id: 'a', name: 'Ana', role: 'dev', hoursPerWeek: 40, costRate: 55, costCurrency: 'CAD' }] }, baseUpdatedAt: t0.updatedAt })).json();
    assert.equal(saved.people[0].costRate, 55);
    const seen = await (await call(pm, 'GET', '/api/team')).json();
    assert.equal(seen.people[0].costRate, undefined, 'PM does not receive cost rates');
    // a PM editing the team keeps the cost rates they cannot see
    await call(pm, 'PUT', '/api/team', { team: { people: [{ ...seen.people[0], hoursPerWeek: 30 }] } });
    const after = await (await call(boss, 'GET', '/api/team')).json();
    assert.equal(after.people[0].hoursPerWeek, 30); assert.equal(after.people[0].costRate, 55);
    assert.equal((await call(pm, 'GET', '/api/settings')).status, 403);
    assert.equal((await call(pm, 'GET', '/api/quotes/example-pytorch/margin')).status, 403);
    assert.equal((await call(boss, 'GET', '/api/quotes/example-pytorch/margin')).status, 200);
  });
});

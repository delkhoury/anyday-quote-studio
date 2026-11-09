// Google sign-in for Anyday staff.
// Server side OAuth 2.0 authorization code flow with PKCE, state and nonce. The ID token is taken
// directly from Google's token endpoint over TLS (Google documents this as sufficient without a
// separate signature check). Access is limited to verified accounts in ALLOWED_DOMAIN (Google
// Workspace "hd" claim) plus any addresses listed in ALLOWED_EMAILS.
// Sessions are HMAC signed cookies: no session store needed, and they survive restarts.

import crypto from 'node:crypto';

const COOKIE = 'aqs_session';
const FLOW_COOKIE = 'aqs_oauth';
const SESSION_DAYS = 7;

const b64u = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function authConfig(env = process.env) {
  const enabled = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return {
    enabled,
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    secret: env.SESSION_SECRET || '',
    domain: (env.ALLOWED_DOMAIN || 'anyday.inc').toLowerCase(),
    emails: (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    admins: (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    secureCookies: (env.PUBLIC_URL || '').startsWith('https://'),
  };
}

// Admins see cost rates and margins. Without sign-in (local use) everyone is an admin.
export function isAdmin(user, cfg) {
  if (!cfg.enabled) return true;
  return !!user?.email && (cfg.admins || []).includes(String(user.email).toLowerCase());
}

export function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verify(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac || ''); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(fromB64u(body).toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

export function isAllowed(claims, cfg) {
  const email = String(claims.email || '').toLowerCase();
  if (!email || claims.email_verified !== true) return { ok: false, reason: 'Your Google account email is not verified.' };
  if (cfg.emails.includes(email)) return { ok: true, email };
  const hd = String(claims.hd || '').toLowerCase();
  if (cfg.domain && hd === cfg.domain && email.endsWith('@' + cfg.domain)) return { ok: true, email };
  return { ok: false, reason: `Only ${cfg.domain} Google accounts can use Anyday Quote Studio. You signed in as ${email}.` };
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, secure, path = '/' }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

export function currentUser(req, cfg) {
  if (!cfg.enabled) return null;
  return verify(cookies(req)[COOKIE], cfg.secret);
}

// Mounts /auth/* routes and returns a middleware that protects everything else.
export function installAuth(app, { cfg = authConfig(), loginPage, fetchImpl = fetch } = {}) {
  if (!cfg.enabled) {
    app.get('/api/me', (req, res) => res.json({ user: null, auth: false, admin: true }));
    return (req, res, next) => next();
  }
  if (!cfg.secret || cfg.secret.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 random characters when Google sign-in is enabled.');
  const redirectUri = req => `${cfg.publicUrl || `${req.protocol}://${req.get('host')}`}/auth/callback`;

  app.get('/auth/login', (req, res) => {
    const error = typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : '';
    res.type('html').send(loginPage({ error }));
  });

  app.get('/auth/google', (req, res) => {
    const state = b64u(crypto.randomBytes(24));
    const nonce = b64u(crypto.randomBytes(24));
    const verifier = b64u(crypto.randomBytes(48));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/';
    setCookie(res, FLOW_COOKIE, sign({ state, nonce, verifier, next, exp: Date.now() + 10 * 60 * 1000 }, cfg.secret), { maxAge: 600, secure: cfg.secureCookies, path: '/auth' });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri(req), response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      ...(cfg.domain && !cfg.emails.length ? { hd: cfg.domain } : {}),
    }).toString();
    res.redirect(u.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const fail = msg => res.redirect('/auth/login?error=' + encodeURIComponent(msg));
    try {
      const flow = verify(cookies(req)[FLOW_COOKIE], cfg.secret);
      setCookie(res, FLOW_COOKIE, '', { maxAge: 0, secure: cfg.secureCookies, path: '/auth' });
      if (req.query.error) return fail('Google sign-in was cancelled.');
      if (!flow || flow.state !== req.query.state || typeof req.query.code !== 'string') return fail('Your sign-in link expired. Please try again.');
      const tr = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: req.query.code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri(req), grant_type: 'authorization_code', code_verifier: flow.verifier }),
      });
      const tok = await tr.json();
      if (!tr.ok || !tok.id_token) return fail('Google did not confirm the sign-in. Please try again.');
      const claims = JSON.parse(fromB64u(tok.id_token.split('.')[1]).toString('utf8'));
      if (claims.aud !== cfg.clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.nonce !== flow.nonce || (claims.exp * 1000) < Date.now()) return fail('The sign-in response could not be verified.');
      const ok = isAllowed(claims, cfg);
      if (!ok.ok) return fail(ok.reason);
      setCookie(res, COOKIE, sign({ email: ok.email, name: claims.name || ok.email, picture: claims.picture || '', exp: Date.now() + SESSION_DAYS * 864e5 }, cfg.secret), { maxAge: SESSION_DAYS * 86400, secure: cfg.secureCookies });
      res.redirect(flow.next || '/');
    } catch (e) {
      console.error('auth callback', e);
      fail('Sign-in failed. Please try again.');
    }
  });

  app.post('/auth/logout', (req, res) => { setCookie(res, COOKIE, '', { maxAge: 0, secure: cfg.secureCookies }); res.json({ ok: true }); });
  app.get('/auth/logout', (req, res) => { setCookie(res, COOKIE, '', { maxAge: 0, secure: cfg.secureCookies }); res.redirect('/auth/login'); });
  app.get('/api/me', (req, res) => { const u = currentUser(req, cfg); if (!u) return res.status(401).json({ error: 'Sign in required' }); res.json({ user: { email: u.email, name: u.name, picture: u.picture }, auth: true, admin: isAdmin(u, cfg) }); });

  const PUBLIC = [/^\/auth\//, /^\/api\/health$/, /^\/favicon\.ico$/, /^\/assets\/(fonts\/|anyday-logo-white\.png$|anyday-mark\.png$|favicon-\d+\.png$|apple-touch-icon\.png$)/];
  return (req, res, next) => {
    if (PUBLIC.some(re => re.test(req.path))) return next();
    const u = currentUser(req, cfg);
    if (u) {
      // state changing requests must come from this site
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.get('origin');
        const expected = cfg.publicUrl || `${req.protocol}://${req.get('host')}`;
        if (origin && origin !== expected) return res.status(403).json({ error: 'Request blocked: it did not come from Anyday Quote Studio.' });
      }
      req.user = u;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required', code: 'auth' });
    res.redirect('/auth/login');
  };
}

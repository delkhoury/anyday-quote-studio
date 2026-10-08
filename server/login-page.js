// Branded sign-in page (black into Anyday red, as on the deck cover).
import { escapeHtml as h } from '../shared/format.js';

export function loginPage({ error = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Anyday Quote Studio</title><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/assets/favicon-192.png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<style>
@font-face { font-family: 'MD Lorien'; src: url(/assets/fonts/md-lorien-regular.woff2) format('woff2'); font-display: swap; }
@font-face { font-family: 'Inter'; font-weight: 400; src: url(/assets/fonts/inter-latin-400-normal.woff2) format('woff2'); font-display: swap; }
@font-face { font-family: 'Inter'; font-weight: 600; src: url(/assets/fonts/inter-latin-600-normal.woff2) format('woff2'); font-display: swap; }
:root { --red: #A10E15; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: linear-gradient(180deg, #000 0%, #000 45%, #3a0306 70%, var(--red) 100%); color: #fff; font-family: Inter, system-ui, sans-serif; display: flex; flex-direction: column; padding: 32px max(16px, 6vw); }
header img { height: 64px; }
main { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; max-width: 640px; padding-bottom: 6vh; }
.eyebrow { font-family: 'MD Lorien', Georgia, serif; font-size: clamp(22px, 3.2vw, 34px); color: rgba(255,255,255,.6); margin: 0 0 6px; }
h1 { font-family: 'MD Lorien', Georgia, serif; font-weight: 400; font-size: clamp(38px, 6vw, 64px); line-height: 1.02; margin: 0 0 28px; }
.btn { display: inline-flex; align-items: center; gap: 12px; background: #fff; color: #000; text-decoration: none; font-weight: 600; font-size: 15px; padding: 13px 20px; border-radius: 2px; }
.btn:hover { background: #f1f1f1; }
.btn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.note { margin-top: 16px; font-size: 13px; color: rgba(255,255,255,.7); }
.error { margin: 0 0 20px; padding: 10px 14px; border-left: 2px solid #fff; background: rgba(0,0,0,.35); font-size: 14px; }
footer { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: rgba(255,255,255,.65); border-top: 1px solid rgba(255,255,255,.35); padding-top: 12px; }
</style></head><body>
<header><img src="/assets/anyday-logo-white.png" alt="Anyday"></header>
<main>
  <p class="eyebrow">Anyday WebOps</p>
  <h1>Quote Studio</h1>
  ${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}
  <div><a class="btn" href="/auth/google${'' /* next is kept by the redirect */}">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
    Sign in with Google</a></div>
  <p class="note">Use your anyday.inc Google account.</p>
</main>
<footer>Anyday Inc. · Internal tool</footer>
</body></html>`;
}

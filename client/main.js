import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html, Toaster, Modal, Field, Badge, toast, askConfirm, Dialogs } from './ui.js';
import { ServerApi, MemoryApi, download, readFileText } from './api.js';
import { QuoteEditor } from './quote/editor.js';
import { LibraryScreen } from './library.js';
import { fmtMoney, fmtDate } from '../shared/format.js';
import './styles.css';

function useHash() {
  const [h, setH] = useState(location.hash || '#/quotes');
  useEffect(() => { const f = () => setH(location.hash || '#/quotes'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h;
}
const go = h => { location.hash = h; window.scrollTo(0, 0); };

function App({ api, health, user }) {
  const hash = useHash();
  const [library, setLibrary] = useState(null);
  useEffect(() => { api.library().then(setLibrary); }, []);
  const parts = hash.replace(/^#\/?/, '').split('/');
  const route = parts[0] || 'quotes';
  return html`
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="#/quotes"><img src=${window.__MARK_URL__ || '/assets/anyday-mark.png'} alt="" /><span class="word">ANYDAY</span><span class="app">Quote Studio</span></a>
      <nav class="nav" aria-label="Main"><a href="#/quotes" class=${route === 'quotes' || route === 'quote' ? 'active' : ''}>Quotes</a><a href="#/library" class=${route === 'library' ? 'active' : ''}>Pricing Library</a></nav>
      <div class="right">${health.mode === 'prototype' ? html`<${Badge} kind="warn" title="No server: data is in memory only">Prototype · in memory<//>` : html`<${Badge} kind="ok">Server · saved to disk<//>`}
        ${user ? html`<span class="user small" title=${user.email}>${user.name || user.email}</span><button class="btn small" onClick=${() => api.logout()}>Sign out</button>` : null}
        <button class="btn small" aria-label="Toggle light and dark theme" onClick=${() => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; }}>Theme</button></div>
    </div></header>
    <main class="main">
      ${health.mode === 'prototype' ? html`<div class="banner warn" style="margin-bottom:16px"><b>Interface prototype.</b> Quotes and library edits live in this browser tab only and are lost on reload, so use Export to keep them and Import to bring them back. Website scanning and PDF export need the deployable Anyday Quote Studio server; they are disabled here rather than simulated.</div>` : null}
      ${route === 'library' ? html`<${LibraryScreen} api=${api} onSaved=${setLibrary} />`
        : route === 'quote' && parts[1] ? html`<${QuoteEditor} key=${parts[1]} api=${api} id=${parts[1]} step=${parts[2] || 'details'} health=${health} library=${library} go=${go} />`
        : html`<${QuotesScreen} api=${api} />`}
    </main>
    <${Toaster} /><${Dialogs} />`;
}

function QuotesScreen({ api }) {
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const load = () => api.quotes().then(setList).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  async function importFile(e) {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try { const q = await api.importQuote(JSON.parse(await readFileText(f))); toast(`Imported ${q.number}`); go(`#/quote/${q.id}/details`); }
    catch (x) { setErr(x.details ? `${x.message}: ${[].concat(x.details).join(', ')}` : x.message); }
  }
  return html`<div class="stack">
    <div class="page-head"><div><div class="eyebrow">Anyday WebOps</div><h1>Quotes</h1></div>
      <div class="row"><label class="btn">Import quote<input type="file" accept=".json" class="hidden" onChange=${importFile} /></label><button class="btn primary" onClick=${() => setCreating(true)}>New quote</button></div></div>
    ${err ? html`<div class="banner danger">${err}</div>` : null}
    ${!list ? html`<div class="empty">Loading…</div>` : !list.length ? html`<div class="card empty"><h2>No quotes yet</h2><p>Create a quote to analyse a website and assemble an implementation proposal.</p></div>` : html`
    <div class="card flush"><div class="scroll-x"><table class="t">
      <thead><tr><th>Quote</th><th>Client and project</th><th class="num">Investment</th><th>Status</th><th>Updated</th><th></th></tr></thead>
      <tbody>${list.map(q => html`<tr>
        <td><a href=${`#/quote/${q.id}/details`}><b>${q.number}</b></a>${q.example ? html`<div class="tiny muted">${q.example}</div>` : null}</td>
        <td><b>${q.client || 'Untitled client'}</b><div class="small muted">${q.project || ''}${q.urls ? ` · ${q.urls.toLocaleString()} URLs` : ''}</div></td>
        <td class="num">${q.total === null ? 'n/a' : html`<b>${q.totalStatus === 'starting_at' ? 'from ' : ''}${fmtMoney(q.total)}</b>${q.totalStatus === 'pending' ? html`<div class="tiny muted">+ pending items</div>` : null}`}</td>
        <td>${q.issuedAt ? html`<${Badge} kind="ok">Issued<//>` : q.blockers ? html`<${Badge} kind="danger">${q.blockers} to resolve<//>` : html`<${Badge} kind="accent">Ready<//>`}<div class="tiny muted">Library ${q.libraryVersion}</div></td>
        <td class="small">${fmtDate(q.updatedAt)}</td>
        <td><div class="row" style="justify-content:flex-end">
          <a class="btn small" href=${`#/quote/${q.id}/details`}>Open</a>
          <button class="btn small" onClick=${async () => { const c = await api.duplicateQuote(q.id); toast(`Duplicated as ${c.number}`); load(); }}>Duplicate</button>
          <button class="btn small" onClick=${async () => download(`${q.number}.json`, await api.quote(q.id))}>Export</button>
          <button class="btn small danger" onClick=${async () => { if (await askConfirm(`Delete ${q.number}? ${api.mode === 'server' ? 'It is moved to the trash folder on the server.' : 'This cannot be undone in the prototype.'}`, 'Delete quote')) { await api.deleteQuote(q.id); load(); } }}>Delete</button></div></td>
      </tr>`)}</tbody></table></div></div>`}
    ${creating ? html`<${NewQuote} api=${api} onClose=${() => setCreating(false)} />` : null}
  </div>`;
}

function NewQuote({ api, onClose }) {
  const [f, setF] = useState({ client: '', project: '', url: '' });
  const [err, setErr] = useState(null);
  const valid = f.client.trim() && (!f.url || /^https?:\/\/[^\s/]+\.[^\s]+/.test(f.url.trim()));
  async function create() {
    try { const q = await api.createQuote({ client: f.client.trim(), project: f.project.trim(), url: f.url.trim() }); onClose(); go(`#/quote/${q.id}/${f.url ? 'analyse' : 'details'}`); }
    catch (e) { setErr(e.message); }
  }
  return html`<${Modal} narrow title="New quote" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!valid} onClick=${create}>Create quote</button>`}>
    <div class="stack">
      <${Field} label="Client"><input class="input" autofocus value=${f.client} onInput=${e => setF({ ...f, client: e.target.value })} placeholder="Organisation name" /><//>
      <${Field} label="Project"><input class="input" value=${f.project} onInput=${e => setF({ ...f, project: e.target.value })} placeholder="i.e. Website on the AAIF foundation" /><//>
      <${Field} label="Website URL" hint="Optional now. Needed to analyse the website."><input class="input" value=${f.url} onInput=${e => setF({ ...f, url: e.target.value })} placeholder="https://example.org" /><//>
      <div class="tiny muted">The quote takes a pricing snapshot from the current Pricing Library. Nothing is selected for redesign by default and no core platform build is included.</div>
      ${err ? html`<div class="banner danger">${err}</div>` : null}
    </div><//>`;
}

async function boot() {
  const root = document.getElementById('app');
  let api, health, user = null;
  if (window.__SEED__) { api = new MemoryApi(window.__SEED__); health = await api.health(); }
  else {
    try { api = new ServerApi(); health = await api.health(); if (health.auth) user = (await api.me()).user; }
    catch { root.innerHTML = '<div class="main"><div class="banner danger">The Anyday Quote Studio server is not reachable. Start it with <code>npm start</code>.</div></div>'; return; }
  }
  root.innerHTML = '';
  render(html`<${App} api=${api} health=${health} user=${user} />`, root);
}
boot();

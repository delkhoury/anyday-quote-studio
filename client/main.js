import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html, Toaster, Modal, Field, Badge, toast, askConfirm, Dialogs } from './ui.js';
import { ServerApi, MemoryApi, download, readFileText } from './api.js';
import { QuoteEditor } from './quote/editor.js';
import { LibraryScreen } from './library.js';
import { FoundationsScreen, FoundationEditor } from './foundations.js';
import { TeamScreen } from './team.js';
import { quoteTypes } from '../shared/quote.js';
import { fmtMoney, fmtDate } from '../shared/format.js';
import './styles.css';

function useHash() {
  const [h, setH] = useState(location.hash || '#/quotes');
  useEffect(() => { const f = () => setH(location.hash || '#/quotes'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h;
}
const go = h => { location.hash = h; window.scrollTo(0, 0); };

function App({ api, health, user, admin }) {
  const hash = useHash();
  const [library, setLibrary] = useState(null);
  useEffect(() => { api.library().then(setLibrary); }, []);
  const parts = hash.replace(/^#\/?/, '').split('/');
  const route = parts[0] || 'quotes';
  return html`
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="#/quotes"><img src=${window.__MARK_URL__ || '/assets/anyday-mark.png'} alt="" /><span class="word">ANYDAY</span><span class="app">Quote Studio</span></a>
      <nav class="nav" aria-label="Main"><a href="#/quotes" class=${route === 'quotes' || route === 'quote' ? 'active' : ''}>Quotes</a><a href="#/library" class=${route === 'library' ? 'active' : ''}>Pricing Library</a><a href="#/foundations" class=${route === 'foundations' || route === 'foundation' ? 'active' : ''}>Foundations</a><a href="#/team" class=${route === 'team' ? 'active' : ''}>Team</a></nav>
      <div class="right">${health.mode === 'prototype' ? html`<${Badge} kind="warn" title="No server: data is in memory only">Prototype · in memory<//>` : html`<${Badge} kind="ok">Server · saved to disk<//>`}
        ${user ? html`<span class="user small" title=${user.email}>${user.name || user.email}</span><button class="btn small" onClick=${() => api.logout()}>Sign out</button>` : null}
        <button class="btn small" aria-label="Toggle light and dark theme" onClick=${() => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; }}>Theme</button></div>
    </div></header>
    <main class="main">
      ${health.mode === 'prototype' ? html`<div class="banner warn" style="margin-bottom:16px"><b>Interface prototype.</b> Quotes and library edits live in this browser tab only and are lost on reload, so use Export to keep them and Import to bring them back. Website scanning and PDF export need the deployable Anyday Quote Studio server; they are disabled here rather than simulated.</div>` : null}
      ${route === 'library' ? html`<${LibraryScreen} api=${api} onSaved=${setLibrary} health=${health} admin=${admin} />`
        : route === 'foundations' ? html`<${FoundationsScreen} api=${api} go=${go} />`
        : route === 'team' ? html`<${TeamScreen} api=${api} health=${health} admin=${admin} />`
        : route === 'foundation' && parts[1] ? html`<${FoundationEditor} key=${parts[1]} api=${api} id=${parts[1]} library=${library} go=${go} />`
        : route === 'quote' && parts[1] ? html`<${QuoteEditor} key=${parts[1]} api=${api} id=${parts[1]} step=${parts[2] || 'setup'} health=${health} library=${library} setLibrary=${setLibrary} admin=${admin} go=${go} />`
        : html`<${QuotesScreen} api=${api} library=${library} />`}
    </main>
    <${Toaster} /><${Dialogs} />`;
}

function QuotesScreen({ api, library }) {
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const load = () => api.quotes().then(setList).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  async function importFile(e) {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try { const q = await api.importQuote(JSON.parse(await readFileText(f))); toast(`Imported ${q.number}`); go(`#/quote/${q.id}/setup`); }
    catch (x) { setErr(x.details ? `${x.message}: ${[].concat(x.details).join(', ')}` : x.message); }
  }
  return html`<div class="stack">
    <div class="page-head"><div><div class="eyebrow">Anyday WebOps</div><h1>Quotes</h1></div>
      <div class="row"><label class="btn">Import quote<input type="file" accept=".json" class="hidden" onChange=${importFile} /></label><button class="btn primary" onClick=${() => setCreating(true)}>New quote</button></div></div>
    ${err ? html`<div class="banner danger">${err}</div>` : null}
    ${!list ? html`<div class="empty">Loading…</div>` : !list.length ? html`<div class="card empty"><h2>No quotes yet</h2><p>Create a quote to price a new platform, a site on an existing foundation, or an expansion.</p></div>` : html`
    <div class="card flush"><div class="scroll-x"><table class="t">
      <thead><tr><th>Quote</th><th>Client and project</th><th>Type</th><th class="num">Investment</th><th>Status</th><th>Updated</th><th></th></tr></thead>
      <tbody>${list.map(q => html`<tr>
        <td><a href=${`#/quote/${q.id}/setup`}><b>${q.number}</b></a>${q.example ? html`<div class="tiny muted">${q.example}</div>` : null}</td>
        <td><b>${q.client || 'Untitled client'}</b><div class="small muted">${q.project || ''}${q.urls ? ` · ${q.urls.toLocaleString()} URLs` : ''}</div></td>
        <td class="small">${q.typeName || ''}${q.foundation ? html`<div class="tiny muted">on ${q.foundation}</div>` : null}${q.sites > 1 ? html`<div class="tiny muted">${q.sites.toLocaleString()} sites</div>` : null}</td>
        <td class="num">${q.total === null ? 'n/a' : html`<b>${q.totalStatus === 'starting_at' ? 'from ' : ''}${fmtMoney(q.total)}</b>${q.totalStatus === 'pending' ? html`<div class="tiny muted">+ pending items</div>` : null}`}</td>
        <td>${q.issuedAt ? html`<${Badge} kind="ok">Issued<//>` : q.blockers ? html`<${Badge} kind="danger">${q.blockers} to resolve<//>` : html`<${Badge} kind="accent">Ready<//>`}<div class="tiny muted">Library ${q.libraryVersion}</div></td>
        <td class="small">${fmtDate(q.updatedAt)}</td>
        <td><div class="row" style="justify-content:flex-end">
          <a class="btn small" href=${`#/quote/${q.id}/setup`}>Open</a>
          <button class="btn small" onClick=${async () => { const c = await api.duplicateQuote(q.id); toast(`Duplicated as ${c.number}`); load(); }}>Duplicate</button>
          <button class="btn small" onClick=${async () => download(`${q.number}.json`, await api.quote(q.id))}>Export</button>
          <button class="btn small danger" onClick=${async () => { if (await askConfirm(`Delete ${q.number}? ${api.mode === 'server' ? 'It is moved to the trash folder on the server.' : 'This cannot be undone in the prototype.'}`, 'Delete quote')) { await api.deleteQuote(q.id); load(); } }}>Delete</button></div></td>
      </tr>`)}</tbody></table></div></div>`}
    ${creating ? html`<${NewQuote} api=${api} library=${library} onClose=${() => setCreating(false)} />` : null}
  </div>`;
}

function NewQuote({ api, library, onClose }) {
  const types = quoteTypes(library);
  const [f, setF] = useState({ type: 'new_platform', client: '', project: '', url: '', foundationId: '', parentOrg: '', existingLiveSites: '' });
  const [foundations, setFoundations] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.foundations().then(l => setFoundations(l.filter(x => !x.archived))); }, []);
  const type = types.find(t => t.id === f.type) || types[0];
  const needsF = type.usesFoundation === 'required';
  const urlOk = !f.url || /^https?:\/\/[^\s/]+\.[^\s]+/.test(f.url.trim());
  const valid = f.client.trim() && urlOk && (!needsF || f.foundationId) && (f.type !== 'expansion' || f.existingLiveSites !== '');
  const pickF = id => { const fd = (foundations || []).find(x => x.id === id); setF({ ...f, foundationId: id, parentOrg: f.parentOrg || fd?.owner || '' }); };
  async function create() {
    try {
      const q = await api.createQuote({ type: f.type, client: f.client.trim(), project: f.project.trim(), url: f.url.trim(), foundationId: f.foundationId || null, parentOrg: f.parentOrg.trim(), existingLiveSites: Number(f.existingLiveSites) || 0 });
      onClose(); go(`#/quote/${q.id}/${type.sitesStep ? 'sites' : (f.url ? 'analyse' : 'setup')}`);
    } catch (e) { setErr(e.message); }
  }
  return html`<${Modal} title="New quote" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!valid} onClick=${create}>Create quote</button>`}>
    <div class="stack">
      <div><div class="caps" style="margin-bottom:8px">What are we pricing?</div>
        <div class="type-cards" role="radiogroup" aria-label="Quote type">${types.map(t => html`<button type="button" role="radio" aria-checked=${f.type === t.id} class=${'type-card' + (f.type === t.id ? ' on' : '')} onClick=${() => setF({ ...f, type: t.id })}>
          <b>${t.name}</b><span class="small muted">${t.description}</span></button>`)}</div></div>
      <div class="grid2">
        <${Field} label="Client"><input class="input" value=${f.client} onInput=${e => setF({ ...f, client: e.target.value })} placeholder="Organisation name" /><//>
        <${Field} label=${f.type === 'foundation_site' ? 'Parent organisation' : 'Parent organisation (optional)'} hint="The organisation the client belongs to, if any."><input class="input" value=${f.parentOrg} onInput=${e => setF({ ...f, parentOrg: e.target.value })} /><//>
      </div>
      <${Field} label="Project"><input class="input" value=${f.project} onInput=${e => setF({ ...f, project: e.target.value })} placeholder=${f.type === 'new_platform' ? 'i.e. Clinic network platform and rollout' : f.type === 'expansion' ? 'i.e. Phase 2 rollout' : 'i.e. Website on the shared platform'} /><//>
      <div class="grid2">
        <${Field} label=${needsF ? 'Foundation' : 'Start from a foundation (optional)'} hint=${needsF ? 'The platform this work builds on. Manage these under Foundations.' : 'Leave empty to price a platform built from scratch.'}>
          <select class="input" value=${f.foundationId} onChange=${e => pickF(e.target.value)}>
            <option value="">${needsF ? 'Choose a foundation' : 'None, build from scratch'}</option>
            ${(foundations || []).map(x => html`<option value=${x.id}>${x.name}${x.owner ? ` (${x.owner})` : ''}</option>`)}</select>
          ${needsF && foundations && !foundations.length ? html`<div class="tiny" style="color:var(--danger);margin-top:4px">No foundations yet. <a href="#/foundations" onClick=${onClose}>Add one first.</a></div>` : null}<//>
        ${f.type === 'expansion' ? html`<${Field} label="Sites already live" hint="Site activation pricing continues from this volume tier."><input class="input" inputmode="numeric" value=${f.existingLiveSites} onInput=${e => setF({ ...f, existingLiveSites: e.target.value.replace(/[^0-9]/g, '') })} /><//>`
          : html`<${Field} label=${type.sitesStep ? 'Sample website URL (optional)' : 'Website URL'} hint=${type.sitesStep ? 'Add the rest of the portfolio in the Sites step.' : 'Optional now. Needed to analyse the website.'}><input class="input" value=${f.url} onInput=${e => setF({ ...f, url: e.target.value })} placeholder="https://example.org" />${!urlOk ? html`<div class="tiny" style="color:var(--danger)">Enter a full address starting with https://</div>` : null}<//>`}
      </div>
      <div class="tiny muted">The quote takes a pricing snapshot from the current Pricing Library${f.foundationId ? ' and a snapshot of the chosen foundation' : ''}, and starts from the ${type.name.toLowerCase()} presets. Every line stays editable.</div>
      ${err ? html`<div class="banner danger">${err}</div>` : null}
    </div><//>`;
}

async function boot() {
  const root = document.getElementById('app');
  let api, health, user = null, admin = true;
  if (window.__SEED__) { api = new MemoryApi(window.__SEED__); health = await api.health(); }
  else {
    try { api = new ServerApi(); health = await api.health(); if (health.auth) { const me = await api.me(); user = me.user; admin = !!me.admin; } }
    catch { root.innerHTML = '<div class="main"><div class="banner danger">The Anyday Quote Studio server is not reachable. Start it with <code>npm start</code>.</div></div>'; return; }
  }
  root.innerHTML = '';
  render(html`<${App} api=${api} health=${health} user=${user} admin=${admin} />`, root);
}
boot();

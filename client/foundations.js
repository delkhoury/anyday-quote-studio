// Foundations: reusable platforms Anyday has built (component library, content models,
// integrations and the capabilities they already provide). A quote takes a snapshot of one.
import { useState, useEffect } from 'preact/hooks';
import { html, Badge, Field, NumInput, TextInput, Modal, toast, askConfirm } from './ui.js';
import { blockLabel } from '../shared/quote.js';
import { fmtDate } from '../shared/format.js';
import { download, readFileText } from './api.js';

const TABS = [
  { id: 'components', label: 'Components' },
  { id: 'models', label: 'Content models' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'capabilities', label: 'Capabilities provided' },
  { id: 'notes', label: 'Notes' },
];
const slugId = s => String(s || '').trim().replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => c ? c.toUpperCase() : '').replace(/^./, c => c.toLowerCase());

export function FoundationsScreen({ api, go }) {
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const load = () => api.foundations().then(setList);
  useEffect(() => { load(); }, []);
  const shown = (list || []).filter(f => showArchived || !f.archived);
  return html`<div class="stack">
    <div class="page-head"><div><div class="eyebrow">Configuration</div><h1>Foundations</h1>
      <div class="muted small" style="margin-top:6px">Platforms Anyday has already built. A quote for a new site or an expansion reuses one: its components, content models and integrations.</div></div>
      <div class="row"><label class="check small"><input type="checkbox" checked=${showArchived} onChange=${e => setShowArchived(e.target.checked)} /> Show archived</label>
        <label class="btn">Import<input type="file" accept=".json" class="hidden" onChange=${async e => {
          const file = e.target.files[0]; if (!file) return; e.target.value = '';
          try { const obj = JSON.parse(await readFileText(file)); const f = await api.createFoundation({ name: obj.name || file.name.replace(/\.json$/, '') }); await api.saveFoundation({ ...obj, id: f.id, archived: false }); toast(`Imported ${obj.name || f.name}`); go(`#/foundation/${f.id}`); }
          catch (x) { toast('Could not import: ' + x.message); }
        }} /></label>
        <button class="btn primary" onClick=${() => setCreating(true)}>New foundation</button></div></div>
    ${!list ? html`<div class="empty">Loading…</div>` : !shown.length ? html`<div class="card empty"><h2>No foundations yet</h2><p>Add the platforms Anyday has built so new sites can be quoted on top of them.</p></div>` : html`
    <div class="folder-grid">${shown.map(f => html`<a class="folder" href=${`#/foundation/${f.id}`}>
      <div class="folder-tab"></div>
      <div class="folder-body">
        <div class="caps">${f.owner || 'Foundation'}</div>
        <h2>${f.name}</h2>
        ${f.description ? html`<p class="small muted clamp2">${f.description}</p>` : null}
        <div class="row wrap tiny" style="gap:10px;margin-top:auto">
          <span><b>${f.components.length}</b>${f.expectedComponents ? ` of ${f.expectedComponents}` : ''} components</span>
          <span><b>${(f.contentModels || []).length}</b> content models</span>
          <span><b>${(f.integrations || []).length}</b> integrations</span>
        </div>
        <div class="row" style="gap:6px;margin-top:8px">${f.archived ? html`<${Badge}>Archived<//>` : null}${!f.complete ? html`<${Badge} kind="warn">Incomplete<//>` : html`<${Badge} kind="ok">Complete<//>`}<span class="tiny muted">Updated ${fmtDate(f.updatedAt)}</span></div>
      </div></a>`)}</div>`}
    ${creating ? html`<${NewFoundation} api=${api} onClose=${() => setCreating(false)} onMade=${f => { setCreating(false); go(`#/foundation/${f.id}`); }} />` : null}
  </div>`;
}

function NewFoundation({ api, onClose, onMade }) {
  const [f, setF] = useState({ name: '', owner: '', description: '' });
  const [err, setErr] = useState(null);
  return html`<${Modal} narrow title="New foundation" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!f.name.trim()} onClick=${async () => { try { onMade(await api.createFoundation({ ...f, name: f.name.trim() })); } catch (e) { setErr(e.message); } }}>Create foundation</button>`}>
    <div class="stack">
      <${Field} label="Name"><input class="input" autofocus value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} placeholder="i.e. Acme Health clinic platform" /><//>
      <${Field} label="Owner" hint="The parent organisation the platform was built for."><input class="input" value=${f.owner} onInput=${e => setF({ ...f, owner: e.target.value })} /><//>
      <${Field} label="Description"><textarea class="input" rows="3" value=${f.description} onInput=${e => setF({ ...f, description: e.target.value })}></textarea><//>
      ${err ? html`<div class="banner danger">${err}</div>` : null}
    </div><//>`;
}

export function FoundationEditor({ api, id, library, go }) {
  const [f, setF] = useState(null);
  const [orig, setOrig] = useState(null);
  const [tab, setTab] = useState('components');
  const [errs, setErrs] = useState([]);
  const [missing, setMissing] = useState(false);
  useEffect(() => { api.foundation(id).then(x => { setF(x); setOrig(JSON.stringify(x)); }).catch(() => setMissing(true)); }, [id]);
  if (missing) return html`<div class="card empty"><h2>Foundation not found</h2><a class="btn" href="#/foundations">Back to Foundations</a></div>`;
  if (!f) return html`<div class="empty">Loading foundation…</div>`;
  const dirty = JSON.stringify(f) !== orig;
  const set = patch => setF(x => ({ ...x, ...patch }));
  async function save(next = f) {
    try { const s = await api.saveFoundation(next, JSON.parse(orig).updatedAt); setF(s); setOrig(JSON.stringify(s)); setErrs([]); toast('Foundation saved. New quotes use it; existing quotes keep their snapshot until you apply it.'); }
    catch (e) { setErrs(e.details || [e.message]); }
  }
  return html`<div class="stack">
    <div class="crumbs small"><a href="#/foundations">Foundations</a> / ${f.name}</div>
    <div class="page-head"><div style="flex:1;min-width:280px"><div class="eyebrow">${f.owner || 'Foundation'}</div><h1>${f.name}</h1>
      <div class="muted small" style="margin-top:6px">Updated ${fmtDate(f.updatedAt)}${f.archived ? ' · archived' : ''}</div></div>
      <div class="row wrap">
        ${dirty ? html`<${Badge} kind="warn">Unsaved changes<//>` : null}
        <button class="btn" onClick=${() => download(`foundation-${f.id}.json`, f)}>Export</button>
        <button class="btn" onClick=${async () => { const c = await api.duplicateFoundation(f.id); toast(`Duplicated as ${c.name}`); go(`#/foundation/${c.id}`); }}>Duplicate</button>
        <button class="btn" onClick=${async () => { if (f.archived || await askConfirm(`Archive ${f.name}? It stays available to quotes that already use it but is no longer offered for new quotes.`, 'Archive')) save({ ...f, archived: !f.archived }); }}>${f.archived ? 'Restore' : 'Archive'}</button>
        <button class="btn" disabled=${!dirty} onClick=${() => setF(JSON.parse(orig))}>Discard</button>
        <button class="btn primary" disabled=${!dirty} onClick=${() => save()}>Save foundation</button>
      </div></div>
    ${errs.length ? html`<div class="banner danger small"><b>Fix before saving:</b><ul style="margin:4px 0 0;padding-left:18px">${errs.map(e => html`<li>${e}</li>`)}</ul></div>` : null}
    <div class="card"><div class="grid3">
      <${Field} label="Name"><${TextInput} value=${f.name} onChange=${v => set({ name: v })} /><//>
      <${Field} label="Owner"><${TextInput} value=${f.owner} onChange=${v => set({ owner: v })} /><//>
      <${Field} label="Source of this information"><${TextInput} value=${f.source} onChange=${v => set({ source: v })} /><//>
    </div><${Field} label="Description"><${TextInput} multiline rows=${2} value=${f.description} onChange=${v => set({ description: v })} /><//></div>
    <div class="tabs" role="tablist">${TABS.map(t => html`<button role="tab" aria-selected=${tab === t.id} class=${'tab' + (tab === t.id ? ' on' : '')} onClick=${() => setTab(t.id)}>${t.label}<span class="tab-count">${t.id === 'components' ? f.components.length : t.id === 'models' ? (f.contentModels || []).length : t.id === 'integrations' ? (f.integrations || []).length : t.id === 'capabilities' ? (f.providedCapabilities || []).length : ''}</span></button>`)}</div>
    ${tab === 'components' ? html`<${ComponentsTab} f=${f} set=${set} />` : null}
    ${tab === 'models' ? html`<${ModelsTab} f=${f} set=${set} />` : null}
    ${tab === 'integrations' ? html`<${IntegrationsTab} f=${f} set=${set} />` : null}
    ${tab === 'capabilities' ? html`<${CapabilitiesTab} f=${f} set=${set} library=${library} />` : null}
    ${tab === 'notes' ? html`<div class="card"><h2>Notes</h2><p class="small">Internal notes about the platform: where its documentation lives, known limits, who to ask.</p><${TextInput} multiline rows=${10} value=${f.notes} onChange=${v => set({ notes: v })} ariaLabel="Notes" /></div>` : null}
  </div>`;
}

function parseList(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    const obj = JSON.parse(t);
    return [].concat(obj.components || obj.blocks || obj).map(b => typeof b === 'string' ? { id: b } : b);
  }
  return t.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(s => /\s/.test(s) ? { id: slugId(s), name: s } : { id: s });
}

function ComponentsTab({ f, set }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState(null);
  const comps = f.components;
  const upd = (i, patch) => set({ components: comps.map((c, j) => j === i ? { ...c, ...patch } : c) });
  function add() {
    try {
      const have = new Set(comps.map(c => c.id));
      const added = parseList(text).filter(b => b.id && !have.has(b.id) && (have.add(b.id), true)).map(b => ({ id: b.id, name: b.name || blockLabel(b.id), kind: b.kind || '', description: b.description || '', documented: true }));
      set({ components: [...comps, ...added], complete: f.expectedComponents ? comps.length + added.length >= f.expectedComponents : f.complete });
      setText(''); setMsg(`${added.length} component${added.length === 1 ? '' : 's'} added (${comps.length + added.length} total). Save to keep them.`);
    } catch (e) { setMsg('Could not read that list: ' + e.message); }
  }
  return html`<div class="stack">
    <div class="card">
      <div class="row wrap" style="justify-content:space-between"><h2 style="margin:0">Component library</h2>
        <div class="row wrap"><label class="check small"><input type="checkbox" checked=${!!f.complete} onChange=${e => set({ complete: e.target.checked })} /> Library is complete</label>
          <label class="field" style="display:flex;gap:6px;align-items:center;margin:0"><span style="margin:0">Expected components</span><${NumInput} value=${f.expectedComponents} onChange=${v => set({ expectedComponents: v })} /></label></div></div>
      ${!f.complete && f.expectedComponents ? html`<div class="banner warn small" style="margin-top:10px">${comps.length} of ${f.expectedComponents} components loaded. Add the rest below to complete the library.</div>` : null}
      ${comps.length ? html`<div class="scroll-x" style="margin-top:10px"><table class="t"><thead><tr><th>Name</th><th>Kind</th><th>Description</th><th></th></tr></thead><tbody>
        ${comps.map((c, i) => html`<tr key=${c.id}><td style="min-width:200px"><${TextInput} value=${c.name} ariaLabel="Component name" onChange=${v => upd(i, { name: v })} /><div class="tiny muted">${c.id}</div></td>
          <td style="width:140px"><${TextInput} value=${c.kind || ''} placeholder="i.e. block" ariaLabel="Component kind" onChange=${v => upd(i, { kind: v })} /></td>
          <td><${TextInput} value=${c.description || ''} ariaLabel="Component description" onChange=${v => upd(i, { description: v })} /></td>
          <td><button class="icon-btn" aria-label=${'Remove ' + c.name} onClick=${() => set({ components: comps.filter((_, j) => j !== i) })}>×</button></td></tr>`)}
      </tbody></table></div>` : html`<p class="small muted">No components yet.</p>`}
    </div>
    <div class="card"><h2>Add components</h2>
      <${Field} label="Paste a list" hint="One per line or comma separated (ids or names), or JSON [{id, name, kind, description}]."><textarea class="input" rows="4" value=${text} onInput=${e => setText(e.target.value)}></textarea><//>
      <div class="row" style="margin-top:8px"><button class="btn" disabled=${!text.trim()} onClick=${add}>Add to library</button>${msg ? html`<span class="small">${msg}</span>` : null}</div></div>
  </div>`;
}

function ModelsTab({ f, set }) {
  const models = f.contentModels || [];
  const upd = (i, patch) => set({ contentModels: models.map((m, j) => j === i ? { ...m, ...patch } : m) });
  return html`<div class="card"><h2>Content models</h2>
    <p class="small">The structured content types the platform already has (articles, events, people…). Migrating records into an existing model needs no new model build.</p>
    ${models.length ? html`<div class="scroll-x"><table class="t"><thead><tr><th>Name</th><th>Fields and notes</th><th></th></tr></thead><tbody>
      ${models.map((m, i) => html`<tr><td style="min-width:200px"><${TextInput} value=${m.name} ariaLabel="Content model name" onChange=${v => upd(i, { name: v })} /><div class="tiny muted">${m.id}</div></td>
        <td><${TextInput} value=${m.description || ''} ariaLabel="Content model fields" onChange=${v => upd(i, { description: v })} /></td>
        <td><button class="icon-btn" aria-label="Remove" onClick=${() => set({ contentModels: models.filter((_, j) => j !== i) })}>×</button></td></tr>`)}
    </tbody></table></div>` : html`<p class="small muted">No content models recorded yet.</p>`}
    <button class="btn small" style="margin-top:8px" onClick=${() => set({ contentModels: [...models, { id: 'model_' + Date.now().toString(36), name: 'New content model', description: '' }] })}>Add content model</button></div>`;
}

function IntegrationsTab({ f, set }) {
  const ints = f.integrations || [];
  const upd = (i, patch) => set({ integrations: ints.map((x, j) => j === i ? { ...x, ...patch } : x) });
  return html`<div class="card"><h2>Existing integrations</h2>
    <p class="small">Connectors the platform already runs. When a quote's requirement is met by one of these, it is priced as configuration, not a new build.</p>
    ${ints.length ? html`<div class="scroll-x"><table class="t"><thead><tr><th>Name</th><th>Confirmed</th><th>Source</th><th></th></tr></thead><tbody>
      ${ints.map((x, i) => html`<tr><td style="min-width:220px"><${TextInput} value=${x.name} ariaLabel="Integration name" onChange=${v => upd(i, { name: v })} /></td>
        <td><input type="checkbox" checked=${!!x.confirmed} aria-label=${'Confirmed: ' + x.name} onChange=${e => upd(i, { confirmed: e.target.checked })} /></td>
        <td><${TextInput} value=${x.source || ''} ariaLabel="Source" onChange=${v => upd(i, { source: v })} /></td>
        <td><button class="icon-btn" aria-label="Remove" onClick=${() => set({ integrations: ints.filter((_, j) => j !== i) })}>×</button></td></tr>`)}
    </tbody></table></div>` : html`<p class="small muted">No integrations recorded yet.</p>`}
    <button class="btn small" style="margin-top:8px" onClick=${() => set({ integrations: [...ints, { id: 'integration_' + Date.now().toString(36), name: 'New integration', confirmed: false, source: 'Added in Quote Studio' }] })}>Add integration</button></div>`;
}

function CapabilitiesTab({ f, set, library }) {
  const caps = f.providedCapabilities || [];
  if (!library) return html`<div class="empty">Loading library…</div>`;
  return html`<div class="card"><h2>Capabilities the foundation already provides</h2>
    <p class="small">Pricing items that depend on these will not ask for the prerequisite to be charged again on quotes built on this foundation.</p>
    <div class="blocks-grid">${library.items.filter(i => i.section === 'base' && !i.isDesign).map(it => html`<label class="check small"><input type="checkbox" checked=${caps.includes(it.id)} onChange=${e => set({ providedCapabilities: e.target.checked ? [...caps, it.id] : caps.filter(x => x !== it.id) })} /> ${it.name}</label>`)}</div></div>`;
}

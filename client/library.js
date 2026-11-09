import { useState, useEffect, useMemo } from 'preact/hooks';
import { html, Badge, Field, NumInput, TextInput, Modal, Seg, toast, askConfirm } from './ui.js';
import { describePricing } from '../shared/pricing.js';
import { validateLibraryShape, quoteTypes } from '../shared/quote.js';
import { ROLES, PHASES, defaultPhase, effortIsSet } from '../shared/plan.js';
import { applyBaselines } from '../shared/baselines.js';
import { fmtDate, toCents, centsToInput, fmtMoney } from '../shared/format.js';
import { download, readFileText } from './api.js';

const MODELS = [
  { value: 'per_unit', label: 'Quantity × unit price' },
  { value: 'batched', label: 'First batch + additional batches' },
  { value: 'progressive', label: 'Progressive volume tiers' },
  { value: 'per_block', label: 'Per block of N units' },
  { value: 'included', label: 'Included at no charge' },
];

export function LibraryScreen({ api, onSaved, health, admin }) {
  const [lib, setLib] = useState(null);
  const [orig, setOrig] = useState(null);
  const [tab, setTab] = useState('items');
  const [sec, setSec] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [baselines, setBaselines] = useState(false);
  const [errs, setErrs] = useState([]);
  useEffect(() => { api.library().then(l => { setLib(l); setOrig(JSON.stringify(l)); }); }, []);
  const dirty = lib && JSON.stringify(lib) !== orig;
  const live = useMemo(() => lib ? validateLibraryShape(lib) : [], [lib]);
  if (!lib) return html`<div class="empty">Loading library…</div>`;

  const setItem = (id, patch) => setLib(l => ({ ...l, items: l.items.map(i => i.id === id ? { ...i, ...patch } : i) }));
  const setPricing = (id, patch) => setLib(l => ({ ...l, items: l.items.map(i => i.id === id ? { ...i, pricing: { ...i.pricing, ...patch } } : i) }));
  async function save() {
    if (live.length) { setErrs(live); return; }
    try { const s = await api.saveLibrary(lib, JSON.parse(orig).updatedAt); setLib(s); setOrig(JSON.stringify(s)); setErrs([]); toast('Library saved. New quotes use these prices.'); onSaved?.(s); }
    catch (e) { setErrs(e.details || [e.message]); }
  }
  async function importFile(e) {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try {
      const obj = JSON.parse(await readFileText(f));
      const errors = validateLibraryShape(obj); if (errors.length) { setErrs(errors); return; }
      setLib({ ...obj, updatedAt: lib.updatedAt }); toast('Library loaded. Review, then save to apply.');
    } catch (x) { setErrs([x.message]); }
  }
  const items = lib.items.filter(i => (sec === 'all' || i.section === sec) && (!q || (i.name + i.id + (i.what || '')).toLowerCase().includes(q.toLowerCase())));
  const secName = id => lib.sections.find(s => s.id === id)?.name || id;

  return html`<div class="stack">
    <div class="page-head"><div><div class="eyebrow">Configuration</div><h1>Pricing Library</h1>
      <div class="muted small" style="margin-top:6px">${lib.name} · version <b>${lib.version}</b> · saved ${fmtDate(lib.updatedAt)} · prices in ${lib.currency}. Source: ${lib.source?.workbook || 'imported'}.</div></div>
      <div class="row wrap">
        ${dirty ? html`<${Badge} kind="warn">Unsaved changes<//>` : null}
        <button class="btn" onClick=${() => setBaselines(true)}>Hours from Clockify</button>
        <label class="btn">Import<input type="file" accept=".json" class="hidden" onChange=${importFile} /></label>
        <button class="btn" onClick=${() => download(`anyday-pricing-library-${lib.version}.json`, lib)}>Export</button>
        <button class="btn" disabled=${!dirty} onClick=${() => setLib(JSON.parse(orig))}>Discard</button>
        <button class="btn primary" disabled=${!dirty} onClick=${save}>Save library</button>
      </div></div>
    <div class="banner info small">Changing the library affects new quotes. Each saved quote keeps its own pricing snapshot until you choose to apply current library pricing to it. All calculations read this configuration; nothing is hard coded in the interface.</div>
    ${errs.length || live.length ? html`<div class="banner danger small"><b>Fix before saving:</b><ul style="margin:4px 0 0;padding-left:18px">${[...new Set([...errs, ...live])].map(e => html`<li>${e}</li>`)}</ul></div>` : null}
    <div class="row wrap">
      <button class=${'btn' + (tab === 'items' ? ' dark' : '')} onClick=${() => setTab('items')}>Pricing items</button>
      <button class=${'btn' + (tab === 'sections' ? ' dark' : '')} onClick=${() => setTab('sections')}>Sections and mapping</button>
      <button class=${'btn' + (tab === 'types' ? ' dark' : '')} onClick=${() => setTab('types')}>Quote type presets</button>
    </div>

    ${tab === 'items' ? html`<div class="card" style="padding:12px 14px"><div class="row wrap">
        <${Seg} value=${sec} options=${[{ value: 'all', label: 'All' }, ...lib.sections.map(s => ({ value: s.id, label: s.name }))]} onChange=${setSec} />
        <input class="input" style="max-width:260px" placeholder="Search" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Search library" />
        <span class="grow"></span>
        <label class="field" style="display:flex;gap:6px;align-items:center"><span style="margin:0">Version</span><${TextInput} cls="input" value=${lib.version} onChange=${v => setLib({ ...lib, version: v })} /></label>
        <button class="btn" onClick=${() => setAdding(true)}>Add item</button></div></div>
      <div class="card flush"><div class="scroll-x"><table class="t">
        <thead><tr><th>Item</th><th>Section</th><th>Pricing</th><th>Status</th><th>Hours</th><th>Optional</th><th></th></tr></thead>
        <tbody>${items.map(i => html`
          <tr key=${i.id}><td><b>${i.name}</b>${i.isDesign ? html` <${Badge} kind="accent">Design<//>` : null}<div class="tiny muted">${i.id}${i.keys?.length > 1 ? ` · combines ${i.keys.join(', ')}` : ''}</div></td>
            <td class="small">${secName(i.section)}${i.section === 'base' ? html`<div class="tiny muted">${i.isDesign ? 'Design' : 'Implementation'}</div>` : null}${i.phase && ((i.phase === 'Migration' && i.section === 'extensions')) ? html`<div class="tiny muted">Phase says Migration; mapped by calculator tab</div>` : null}</td>
            <td class="small" style="max-width:360px">${describePricing(i.pricing)}</td>
            <td>${i.pricing.status === 'starting_at' ? html`<${Badge} kind="warn">Starting at<//>` : i.pricing.status === 'unpriced' ? html`<${Badge} kind="danger">Price needed<//>` : html`<${Badge} kind="ok">Confirmed<//>`}</td>
            <td>${effortBadge(i.effort)}</td>
            <td><input type="checkbox" checked=${i.optionalAvailable !== false} aria-label=${'Available as optional addition: ' + i.name} onChange=${e => setItem(i.id, { optionalAvailable: e.target.checked })} /></td>
            <td><button class="icon-btn" aria-label=${'Edit ' + i.name} aria-expanded=${open === i.id} onClick=${() => setOpen(open === i.id ? null : i.id)}>${open === i.id ? '−' : '✎'}</button></td></tr>
          ${open === i.id ? html`<tr><td colspan="7" style="background:var(--surface-2)"><${ItemEditor} item=${i} lib=${lib} setItem=${setItem} setPricing=${setPricing} remove=${async () => { if (await askConfirm(`Remove ${i.name} from the library? Existing quotes keep their own copy.`, 'Remove item')) { setLib(l => ({ ...l, items: l.items.filter(x => x.id !== i.id) })); setOpen(null); } }} /></td></tr>` : null}`)}
        </tbody></table></div></div>` : null}

    ${tab === 'sections' ? html`<div class="card"><h2>Proposal sections</h2>
      <p class="small">The proposal always uses these three sections. Items are mapped from the original calculator tabs, not the library Phase field, because some configuration items marked Migration belong under Platform Extensions. Change an item's section here or in its editor.</p>
      <div class="grid3">${lib.sections.map((s, idx) => html`<div class="card" style="background:var(--surface-2)"><div class="caps">Section ${s.order}</div><h2>${s.name}</h2><div class="tiny muted">Source: ${s.sourceTab}</div>
        <${Field} label="Client facing introduction"><${TextInput} multiline rows=${3} value=${s.intro} onChange=${v => setLib(l => ({ ...l, sections: l.sections.map((x, j) => j === idx ? { ...x, intro: v } : x) }))} /><//>
        <div class="small" style="margin-top:8px">${lib.items.filter(i => i.section === s.id).length} items</div></div>`)}</div>
      <table class="t" style="margin-top:14px"><thead><tr><th>Item</th><th>Library phase</th><th>Proposal section</th></tr></thead><tbody>
        ${lib.items.map(i => html`<tr><td>${i.name}<div class="tiny muted">${i.id}</div></td><td class="small">${i.phase}</td><td><select class="input" style="width:auto" value=${i.section} onChange=${e => setItem(i.id, { section: e.target.value })} aria-label=${'Section for ' + i.name}>${lib.sections.map(s => html`<option value=${s.id}>${s.name}</option>`)}</select></td></tr>`)}
      </tbody></table></div>` : null}

    ${tab === 'types' ? html`<${PresetsEditor} lib=${lib} setItem=${setItem} />` : null}
    ${baselines ? html`<${BaselinesModal} api=${api} health=${health} lib=${lib} onClose=${() => setBaselines(false)} onApply=${next => { setLib(next); setBaselines(false); toast('Baselines added. Review, then Save library.'); }} />` : null}
    ${adding ? html`<${AddItem} lib=${lib} onClose=${() => setAdding(false)} onAdd=${it => { setLib(l => ({ ...l, items: [...l.items, it] })); setAdding(false); setOpen(it.id); }} />` : null}
  </div>`;
}

function money(v, set, aria) { return html`<span class="row" style="gap:4px"><span>$</span><${NumInput} cls="input money" value=${v == null ? null : v / 100} ariaLabel=${aria} onChange=${x => set(x === null ? null : toCents(x))} /></span>`; }

function ItemEditor({ item: i, lib, setItem, setPricing, remove }) {
  const p = i.pricing;
  const changeModel = m => {
    const base = { model: m, status: p.status === 'unpriced' && m !== 'per_unit' ? 'confirmed' : p.status, qtyUnit: p.qtyUnit, qtyUnitPlural: p.qtyUnitPlural, sourceUnit: p.sourceUnit };
    const add = { per_unit: { unitPrice: p.unitPrice ?? null }, batched: { first: p.first || { key: i.id + '_FIRST', size: 500, price: 0 }, additional: p.additional || { key: i.id + '_ADD', size: 500, price: 0 } }, progressive: { tiers: p.tiers || [{ key: i.id + '_T1', label: 'Units 1 to 10', upTo: 10, price: 0 }, { key: i.id + '_T2', label: 'Units 11 plus', upTo: null, price: 0 }] }, per_block: { blockSize: p.blockSize || 500, price: p.price || 0 }, included: {} }[m];
    setItem(i.id, { pricing: { ...base, ...add } });
  };
  const all = lib.items.filter(x => x.id !== i.id);
  return html`<div class="grid2" style="padding:6px 2px">
    <div class="stack" style="gap:10px">
      <${Field} label="Name"><${TextInput} value=${i.name} onChange=${v => setItem(i.id, { name: v })} /><//>
      <${Field} label="What it means (plain language)"><${TextInput} multiline rows=${2} value=${i.what} onChange=${v => setItem(i.id, { what: v })} /><//>
      <${Field} label="What the client receives"><${TextInput} multiline rows=${2} value=${i.receives} onChange=${v => setItem(i.id, { receives: v })} /><//>
      <div class="grid2">
        <${Field} label="Proposal section"><select class="input" value=${i.section} onChange=${e => setItem(i.id, { section: e.target.value })}>${lib.sections.map(s => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
        <${Field} label="Design item"><label class="check"><input type="checkbox" checked=${!!i.isDesign} onChange=${e => setItem(i.id, { isDesign: e.target.checked, subsection: e.target.checked ? 'design' : 'implementation', section: e.target.checked ? 'base' : i.section })} /> Shown in the design scope</label><//>
        <${Field} label="Category"><${TextInput} value=${i.category} onChange=${v => setItem(i.id, { category: v })} /><//>
        <${Field} label="Subcategory"><${TextInput} value=${i.subcategory} onChange=${v => setItem(i.id, { subcategory: v })} /><//>
      </div>
      <${Field} label="Dependencies" hint="Each group needs at least one of its items included, or provided by the foundation the quote builds on.">
        ${(i.dependsOn || []).map((g, gi) => html`<div class="row" style="margin-bottom:4px"><select multiple class="input" style="height:74px" aria-label="Dependency group" onChange=${e => { const sel = [...e.target.selectedOptions].map(o => o.value); const d = [...i.dependsOn]; d[gi] = sel; setItem(i.id, { dependsOn: d.filter(x => x.length) }); }}>${all.map(x => html`<option value=${x.id} selected=${g.includes(x.id)}>${x.name}</option>`)}</select><button class="icon-btn" aria-label="Remove group" onClick=${() => setItem(i.id, { dependsOn: i.dependsOn.filter((_, j) => j !== gi) })}>×</button></div>`)}
        <button class="btn small" onClick=${() => setItem(i.id, { dependsOn: [...(i.dependsOn || []), []] })}>Add dependency group</button><//>
      <${Field} label="Included work and notes (internal)"><${TextInput} multiline rows=${2} value=${i.sourceNotes} onChange=${v => setItem(i.id, { sourceNotes: v })} /><//>
      <${EffortEditor} i=${i} setItem=${setItem} />
      <label class="check"><input type="checkbox" checked=${i.optionalAvailable !== false} onChange=${e => setItem(i.id, { optionalAvailable: e.target.checked })} /> Available as an optional addition</label>
    </div>
    <div class="stack" style="gap:10px">
      <${Field} label="Pricing model"><select class="input" value=${p.model} onChange=${e => changeModel(e.target.value)}>${MODELS.map(m => html`<option value=${m.value}>${m.label}</option>`)}</select><//>
      ${p.model === 'per_unit' ? html`<div class="grid2"><${Field} label="Unit price (USD)">${money(p.unitPrice, v => setPricing(i.id, { unitPrice: v, status: v == null ? 'unpriced' : (p.status === 'unpriced' ? 'confirmed' : p.status) }), 'Unit price')}<//>
        <${Field} label="Price status"><select class="input" value=${p.status} onChange=${e => setPricing(i.id, { status: e.target.value })}><option value="confirmed">Confirmed</option><option value="starting_at">Starting at</option><option value="unpriced">Price needed</option></select><//></div>` : null}
      ${p.model === 'batched' ? html`<div class="grid2">
        <${Field} label="First batch size"><${NumInput} cls="input" value=${p.first.size} onChange=${v => setPricing(i.id, { first: { ...p.first, size: v } })} /><//>
        <${Field} label="First batch price">${money(p.first.price, v => setPricing(i.id, { first: { ...p.first, price: v } }), 'First batch price')}<//>
        <${Field} label="Additional batch size"><${NumInput} cls="input" value=${p.additional.size} onChange=${v => setPricing(i.id, { additional: { ...p.additional, size: v } })} /><//>
        <${Field} label="Additional batch price">${money(p.additional.price, v => setPricing(i.id, { additional: { ...p.additional, price: v } }), 'Additional batch price')}<//></div>
        <div class="tiny muted">A quantity of zero is never charged a first batch.</div>` : null}
      ${p.model === 'per_block' ? html`<div class="grid2"><${Field} label="Units per block"><${NumInput} cls="input" value=${p.blockSize} onChange=${v => setPricing(i.id, { blockSize: v })} /><//><${Field} label="Price per block">${money(p.price, v => setPricing(i.id, { price: v }), 'Price per block')}<//></div>` : null}
      ${p.model === 'progressive' ? html`<div><table class="t"><thead><tr><th>Tier</th><th>Up to</th><th>Price each</th><th></th></tr></thead><tbody>
        ${p.tiers.map((t, ti) => html`<tr><td><${TextInput} value=${t.label} onChange=${v => setPricing(i.id, { tiers: p.tiers.map((x, j) => j === ti ? { ...x, label: v } : x) })} /></td>
          <td>${ti === p.tiers.length - 1 ? html`<span class="small muted">No limit</span>` : html`<${NumInput} value=${t.upTo} onChange=${v => setPricing(i.id, { tiers: p.tiers.map((x, j) => j === ti ? { ...x, upTo: v } : x) })} />`}</td>
          <td>${money(t.price, v => setPricing(i.id, { tiers: p.tiers.map((x, j) => j === ti ? { ...x, price: v } : x) }), 'Tier price')}</td>
          <td>${p.tiers.length > 1 ? html`<button class="icon-btn" aria-label="Remove tier" onClick=${() => { const tiers = p.tiers.filter((_, j) => j !== ti); tiers[tiers.length - 1] = { ...tiers[tiers.length - 1], upTo: null }; setPricing(i.id, { tiers }); }}>×</button>` : null}</td></tr>`)}
        </tbody></table><button class="btn small" style="margin-top:6px" onClick=${() => { const tiers = [...p.tiers]; const last = tiers[tiers.length - 1]; const prev = tiers.length > 1 ? tiers[tiers.length - 2].upTo : 0; tiers[tiers.length - 1] = { ...last, upTo: (prev || 0) + 10 }; tiers.push({ key: i.id + '_T' + (tiers.length + 1), label: 'Next tier', upTo: null, price: last.price }); setPricing(i.id, { tiers }); }}>Add tier</button></div>` : null}
      <div class="grid2">
        <${Field} label="Quantity unit"><${TextInput} value=${p.qtyUnit} onChange=${v => setPricing(i.id, { qtyUnit: v })} /><//>
        <${Field} label="Plural"><${TextInput} value=${p.qtyUnitPlural} onChange=${v => setPricing(i.id, { qtyUnitPlural: v })} /><//>
      </div>
      <div class="banner info small"><b>How it reads:</b> ${describePricing(p)}${p.sourceUnit ? html`<div class="tiny muted">Source library unit: ${p.sourceUnit}</div>` : null}</div>
      <div class="tiny muted">Pattern keys: ${(i.keys || [i.id]).join(', ')}</div>
      <div><button class="btn small danger" onClick=${remove}>Remove item</button></div>
    </div>
  </div>`;
}

function AddItem({ lib, onClose, onAdd }) {
  const [f, setF] = useState({ id: '', name: '', section: 'base', isDesign: false, model: 'per_unit', price: '', unit: 'item' });
  const idOk = /^[A-Z][A-Z0-9_]{2,60}$/.test(f.id) && !lib.items.some(i => i.id === f.id);
  return html`<${Modal} narrow title="Add pricing item" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!idOk || !f.name.trim()} onClick=${() => {
    const price = f.price === '' ? null : toCents(f.price);
    onAdd({ id: f.id, keys: [f.id], name: f.name.trim(), what: '', receives: '', sourceNotes: 'Added in Quote Studio', phase: f.section === 'base' ? 'Base' : 'Migration', category: f.isDesign ? 'Design + Experience' : 'Custom', subcategory: f.isDesign ? 'Design' : 'Custom', section: f.isDesign ? 'base' : f.section, subsection: f.isDesign ? 'design' : 'implementation',
      pricing: f.model === 'included' ? { model: 'included', status: 'confirmed', qtyUnit: f.unit, qtyUnitPlural: f.unit + 's' } : { model: 'per_unit', unitPrice: price, status: price == null ? 'unpriced' : 'confirmed', qtyUnit: f.unit, qtyUnitPlural: f.unit + 's', sourceUnit: 'each' },
      dependsOn: [], optionalAvailable: true, isDesign: f.isDesign });
  }}>Add item</button>`}>
    <div class="stack">
      <${Field} label="Pattern key" hint="Upper case letters, digits and underscores, i.e. DESIGN_ICONOGRAPHY"><input class="input" value=${f.id} onInput=${e => setF({ ...f, id: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />${f.id && !idOk ? html`<div class="tiny" style="color:var(--danger)">Key must be unique and at least 3 characters.</div>` : null}<//>
      <${Field} label="Name"><input class="input" value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} /><//>
      <label class="check"><input type="checkbox" checked=${f.isDesign} onChange=${e => setF({ ...f, isDesign: e.target.checked })} /> Design item (shown in WebOps Base + Design, design scope)</label>
      ${!f.isDesign ? html`<${Field} label="Section"><select class="input" value=${f.section} onChange=${e => setF({ ...f, section: e.target.value })}>${lib.sections.map(s => html`<option value=${s.id}>${s.name}</option>`)}</select><//>` : null}
      <div class="grid2"><${Field} label="Unit price (blank = price needed)"><input class="input" value=${f.price} onInput=${e => setF({ ...f, price: e.target.value })} /><//><${Field} label="Unit"><input class="input" value=${f.unit} onInput=${e => setF({ ...f, unit: e.target.value })} /><//></div>
      <div class="tiny muted">You can switch to batch, tier or block pricing in the item editor after adding.</div>
    </div><//>`;
}

// Effort: internal only. Default hours by role, used by each quote's Plan step. Never shown to clients.
function EffortEditor({ i, setItem }) {
  const e = i.effort || {};
  const set = patch => setItem(i.id, { effort: { ...e, ...patch } });
  const setHours = patch => { const { baseline, ...rest } = e; setItem(i.id, { effort: { ...rest, ...patch, source: 'manual' } }); };
  const setH = (kind, role, v) => setHours({ [kind]: { ...(e[kind] || {}), [role]: v } });
  const unit = i.pricing.qtyUnit || 'unit';
  const qtyBased = i.pricing.model !== 'included';
  return html`<div class="card" style="background:var(--surface);margin-top:4px">
    <div class="spread"><div class="caps">Effort (internal)</div>${effortBadge(e)}</div>
    ${e.source === 'baseline' && e.baseline ? html`<div class="banner info tiny" style="margin-top:6px"><b>Baseline from Clockify</b> (${e.baseline.confidence} confidence${e.baseline.samples ? `, ${e.baseline.samples} samples` : ''}). ${e.baseline.basis} Editing an hour makes these your own hours, and later Clockify refreshes leave them alone.</div>` : null}
    <p class="tiny muted" style="margin:4px 0 8px">Default hours for the Plan step. Project managers can also fill these in from a quote and save them as defaults. Never shown to clients.</p>
    <div class="grid2"><${Field} label="Internal name"><${TextInput} value=${e.internalName || ''} placeholder=${i.name} onChange=${v => set({ internalName: v })} /><//>
      <${Field} label="Phase"><select class="input" value=${e.phase || ''} onChange=${ev => set({ phase: ev.target.value })}><option value="">${defaultPhase(i)} (default)</option>${PHASES.map(ph => html`<option value=${ph}>${ph}</option>`)}</select><//></div>
    <${Field} label="Done when"><${TextInput} value=${e.doneWhen || ''} placeholder="i.e. Approved in Figma and built in Storybook" onChange=${v => set({ doneWhen: v })} /><//>
    <table class="t" style="margin-top:8px"><thead><tr><th>Role</th><th>Fixed hours</th>${qtyBased ? html`<th>Hours per ${unit}</th>` : null}</tr></thead><tbody>
      ${ROLES.map(r => html`<tr><td class="small">${r.label}</td>
        <td><${NumInput} value=${e.setup?.[r.id] ?? null} ariaLabel=${`${r.label} fixed hours`} step=${0.25} onChange=${v => setH('setup', r.id, v)} /></td>
        ${qtyBased ? html`<td><${NumInput} value=${e.perUnit?.[r.id] ?? null} ariaLabel=${`${r.label} hours per ${unit}`} step=${0.25} onChange=${v => setH('perUnit', r.id, v)} /></td>` : null}</tr>`)}
    </tbody></table></div>`;
}

export function effortBadge(e) {
  if (!effortIsSet(e)) return html`<${Badge}>Hours needed<//>`;
  if (e.source === 'baseline') return html`<${Badge} kind="warn" title=${e.baseline?.basis || ''}>Baseline${e.baseline?.confidence ? ` · ${e.baseline.confidence}` : ''}<//>`;
  return html`<${Badge} kind="ok">Set<//>`;
}

// Hours from Clockify: proposals from logged time, reviewed before anything changes.
function BaselinesModal({ api, health, lib, onClose, onApply }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [open, setOpen] = useState(null);
  const byId = Object.fromEntries(lib.items.map(i => [i.id, i]));
  const ownHours = it => effortIsSet(it?.effort) && it.effort.source !== 'baseline';
  const load = async body => {
    setBusy(true); setErr(null);
    try { const r = await api.baselines(body); setRes(r); setSel(new Set(r.proposals.filter(p => !ownHours(byId[p.id])).map(p => p.id))); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const fromCsv = async e => { const f = e.target.files[0]; if (!f) return; e.target.value = ''; load({ source: 'csv', csv: await readFileText(f) }); };
  const fmtH = v => (v ? (Math.round(v * 100) / 100).toString() : '');
  const unitPrice = it => (it?.pricing?.model === 'per_unit' && it.pricing.unitPrice ? it.pricing.unitPrice : null);
  const hoursOf = p => ROLES.reduce((a, r) => a + (p.effort.perUnit?.[r.id] || 0) + (p.effort.setup?.[r.id] || 0), 0);
  return html`<${Modal} title="Hours from Clockify" onClose=${onClose} footer=${res ? html`<span class="small muted grow">${sel.size} of ${res.proposals.length} selected. Hours someone set are never replaced.</span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!sel.size} onClick=${() => { const { library } = applyBaselines(lib, res.proposals, { ids: [...sel] }); onApply(library); }}>Add ${sel.size} baseline${sel.size === 1 ? '' : 's'}</button>` : html`<button class="btn" onClick=${onClose}>Close</button>`}>
    ${!res ? html`<div class="stack">
      <p class="small">Proposes default hours for each deliverable from the time your team has logged. Clockify entries have no quantities, so these are best guesstimates: each one says how it was worked out and how many tasks or projects it rests on. Nothing changes until you add them and save the library.</p>
      <div class="row wrap">
        <button class="btn primary" disabled=${busy || !health?.clockify} title=${health?.clockify ? '' : 'Add CLOCKIFY_API_KEY in Render to read Clockify directly'} onClick=${() => load({ source: 'clockify', months: 12 })}>${busy ? 'Reading Clockify…' : 'Read the last 12 months from Clockify'}</button>
        <label class="btn">Upload a Clockify CSV export<input type="file" accept=".csv" class="hidden" onChange=${fromCsv} /></label></div>
      <div class="tiny muted">CSV: Clockify → Reports → Detailed → Export → CSV. Roles come from the Group column, or from the Team when names match.</div>
      ${err ? html`<div class="banner danger small">${err}</div>` : null}</div>` : html`<div class="stack">
      <div class="banner info small">${res.summary.entries.toLocaleString()} client time entries, ${res.summary.hours.toLocaleString()} hours, ${res.summary.people} people, ${res.summary.projects} projects. ${res.summary.categorised}% of hours have a Task Category. Project management added at ${res.summary.pmShare}% of hours. Implied rate is the unit price divided by the baseline hours: a very high rate usually means the baseline is too low.</div>
      <div class="scroll-x"><table class="t"><thead><tr><th><input type="checkbox" aria-label="Select all" checked=${sel.size === res.proposals.length} onChange=${e => setSel(new Set(e.target.checked ? res.proposals.map(p => p.id) : []))} /></th><th>Deliverable</th>${ROLES.map(r => html`<th class="num">${r.short}</th>`)}<th>Per</th><th>Evidence</th><th class="num">Implied rate</th><th>Now</th></tr></thead><tbody>
        ${res.proposals.map(p => { const it = byId[p.id]; const per = p.effort.perUnit ? it?.pricing?.qtyUnit : 'fixed'; const up = unitPrice(it); const h = hoursOf(p); return html`<tr key=${p.id}>
          <td><input type="checkbox" aria-label=${'Use baseline for ' + (it?.name || p.id)} checked=${sel.has(p.id)} onChange=${e => { const n = new Set(sel); e.target.checked ? n.add(p.id) : n.delete(p.id); setSel(n); }} /></td>
          <td><b>${it?.name || p.id}</b><div><button class="btn small ghost" style="padding:0" onClick=${() => setOpen(open === p.id ? null : p.id)}>${open === p.id ? 'Hide basis' : 'Basis'}</button></div>${open === p.id ? html`<div class="tiny muted" style="max-width:420px">${p.basis}</div>` : null}</td>
          ${ROLES.map(r => html`<td class="num">${fmtH((p.effort.perUnit || p.effort.setup || {})[r.id])}</td>`)}
          <td class="small">${per}</td>
          <td><${Badge} kind=${p.method === 'clockify' ? (p.confidence === 'medium' ? 'ok' : 'warn') : ''}>${p.method === 'clockify' ? `${p.confidence} · ${p.samples}` : p.method}<//></td>
          <td class="num small">${up && h ? `${fmtMoney(Math.round(up / h))}/h` : ''}</td>
          <td>${effortBadge(it?.effort)}</td></tr>`; })}
      </tbody></table></div>
      ${res.summary.missing?.length ? html`<div class="tiny muted">No evidence for: ${res.summary.missing.map(id => byId[id]?.name || id).join(', ')}. These stay Hours needed.</div>` : null}</div>`}
  <//>`;
}

// What each quote type starts with. Presets only shape a new quote; Anyday edits every line afterwards.
const PRESET_STATES = [{ value: '', label: 'Library default' }, { value: 'included', label: 'Included' }, { value: 'optional', label: 'Optional' }, { value: 'hidden', label: 'Hidden' }];
function PresetsEditor({ lib, setItem }) {
  const types = quoteTypes(lib);
  const [sec, setSec] = useState('all');
  const set = (it, type, patch) => {
    const cur = { ...(it.presets?.[type] || {}), ...patch };
    const presets = { ...(it.presets || {}) };
    if (!cur.state) delete presets[type]; else { if (cur.state !== 'included' || cur.qty === null || cur.qty === undefined) delete cur.qty; presets[type] = cur; }
    setItem(it.id, { presets });
  };
  const items = lib.items.filter(i => sec === 'all' || i.section === sec);
  return html`<div class="stack">
    <div class="card"><h2>Quote type presets</h2>
      <p class="small">When someone starts a quote, its type decides which lines begin included, optional or hidden, and with what starting quantity. Leave a quantity blank to have it filled from the website analysis. Existing quotes are never changed.</p>
      <div class="grid3">${types.map(t => html`<div class="card" style="background:var(--surface-2)"><div class="caps">${t.usesFoundation === 'required' ? 'Needs a foundation' : 'Foundation optional'}</div><h2 style="font-size:20px">${t.name}</h2><p class="small" style="margin:0">${t.description}</p>
        <div class="tiny muted" style="margin-top:8px">${lib.items.filter(i => i.presets?.[t.id]?.state === 'included').length} lines start included</div></div>`)}</div></div>
    <div class="card" style="padding:12px 14px"><${Seg} value=${sec} options=${[{ value: 'all', label: 'All' }, ...lib.sections.map(s => ({ value: s.id, label: s.name }))]} onChange=${setSec} /></div>
    <div class="card flush"><div class="scroll-x"><table class="t">
      <thead><tr><th>Item</th>${types.map(t => html`<th>${t.name}</th>`)}</tr></thead>
      <tbody>${items.map(it => html`<tr key=${it.id}><td><b>${it.name}</b><div class="tiny muted">${it.id}</div></td>
        ${types.map(t => { const p = it.presets?.[t.id] || {}; return html`<td><div class="row" style="gap:6px;flex-wrap:nowrap">
          <select class="input" style="width:auto" aria-label=${`${t.name}: ${it.name}`} value=${p.state || ''} onChange=${e => set(it, t.id, { state: e.target.value })}>${PRESET_STATES.map(o => html`<option value=${o.value}>${o.label}</option>`)}</select>
          ${p.state === 'included' && it.pricing.model !== 'included' ? html`<${NumInput} cls="input" value=${p.qty ?? null} ariaLabel=${`Starting quantity, ${t.name}: ${it.name}`} onChange=${v => set(it, t.id, { qty: v })} />` : null}</div></td>`; })}</tr>`)}</tbody>
    </table></div></div>
  </div>`;
}
void fmtMoney; void centsToInput;

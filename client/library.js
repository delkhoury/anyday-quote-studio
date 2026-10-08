import { useState, useEffect, useMemo } from 'preact/hooks';
import { html, Badge, Field, NumInput, TextInput, Modal, Seg, toast, askConfirm } from './ui.js';
import { describePricing } from '../shared/pricing.js';
import { validateLibraryShape, blockLabel } from '../shared/quote.js';
import { fmtDate, toCents, centsToInput, fmtMoney } from '../shared/format.js';
import { download, readFileText } from './api.js';

const MODELS = [
  { value: 'per_unit', label: 'Quantity × unit price' },
  { value: 'batched', label: 'First batch + additional batches' },
  { value: 'progressive', label: 'Progressive volume tiers' },
  { value: 'per_block', label: 'Per block of N units' },
  { value: 'included', label: 'Included at no charge' },
];

export function LibraryScreen({ api, onSaved }) {
  const [lib, setLib] = useState(null);
  const [orig, setOrig] = useState(null);
  const [cat, setCat] = useState(null);
  const [tab, setTab] = useState('items');
  const [sec, setSec] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [errs, setErrs] = useState([]);
  useEffect(() => { api.library().then(l => { setLib(l); setOrig(JSON.stringify(l)); }); api.catalogue().then(setCat); }, []);
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
      <button class=${'btn' + (tab === 'aaif' ? ' dark' : '')} onClick=${() => setTab('aaif')}>AAIF foundation</button>
    </div>

    ${tab === 'items' ? html`<div class="card" style="padding:12px 14px"><div class="row wrap">
        <${Seg} value=${sec} options=${[{ value: 'all', label: 'All' }, ...lib.sections.map(s => ({ value: s.id, label: s.name }))]} onChange=${setSec} />
        <input class="input" style="max-width:260px" placeholder="Search" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Search library" />
        <span class="grow"></span>
        <label class="field" style="display:flex;gap:6px;align-items:center"><span style="margin:0">Version</span><${TextInput} cls="input" value=${lib.version} onChange=${v => setLib({ ...lib, version: v })} /></label>
        <button class="btn" onClick=${() => setAdding(true)}>Add item</button></div></div>
      <div class="card flush"><div class="scroll-x"><table class="t">
        <thead><tr><th>Item</th><th>Section</th><th>Pricing</th><th>Status</th><th>Optional</th><th></th></tr></thead>
        <tbody>${items.map(i => html`
          <tr key=${i.id}><td><b>${i.name}</b>${i.isDesign ? html` <${Badge} kind="accent">Design<//>` : null}<div class="tiny muted">${i.id}${i.keys?.length > 1 ? ` · combines ${i.keys.join(', ')}` : ''}</div></td>
            <td class="small">${secName(i.section)}${i.section === 'base' ? html`<div class="tiny muted">${i.isDesign ? 'Design' : 'Implementation'}</div>` : null}${i.phase && ((i.phase === 'Migration' && i.section === 'extensions')) ? html`<div class="tiny muted">Phase says Migration; mapped by calculator tab</div>` : null}</td>
            <td class="small" style="max-width:360px">${describePricing(i.pricing)}</td>
            <td>${i.pricing.status === 'starting_at' ? html`<${Badge} kind="warn">Starting at<//>` : i.pricing.status === 'unpriced' ? html`<${Badge} kind="danger">Price needed<//>` : html`<${Badge} kind="ok">Confirmed<//>`}</td>
            <td><input type="checkbox" checked=${i.optionalAvailable !== false} aria-label=${'Available as optional addition: ' + i.name} onChange=${e => setItem(i.id, { optionalAvailable: e.target.checked })} /></td>
            <td><button class="icon-btn" aria-label=${'Edit ' + i.name} aria-expanded=${open === i.id} onClick=${() => setOpen(open === i.id ? null : i.id)}>${open === i.id ? '−' : '✎'}</button></td></tr>
          ${open === i.id ? html`<tr><td colspan="6" style="background:var(--surface-2)"><${ItemEditor} item=${i} lib=${lib} setItem=${setItem} setPricing=${setPricing} remove=${async () => { if (await askConfirm(`Remove ${i.name} from the library? Existing quotes keep their own copy.`, 'Remove item')) { setLib(l => ({ ...l, items: l.items.filter(x => x.id !== i.id) })); setOpen(null); } }} /></td></tr>` : null}`)}
        </tbody></table></div></div>` : null}

    ${tab === 'sections' ? html`<div class="card"><h2>Proposal sections</h2>
      <p class="small">The proposal always uses these three sections. Items are mapped from the original calculator tabs, not the library Phase field, because some configuration items marked Migration belong under Platform Extensions. Change an item's section here or in its editor.</p>
      <div class="grid3">${lib.sections.map((s, idx) => html`<div class="card" style="background:var(--surface-2)"><div class="caps">Section ${s.order}</div><h2>${s.name}</h2><div class="tiny muted">Source: ${s.sourceTab}</div>
        <${Field} label="Client facing introduction"><${TextInput} multiline rows=${3} value=${s.intro} onChange=${v => setLib(l => ({ ...l, sections: l.sections.map((x, j) => j === idx ? { ...x, intro: v } : x) }))} /><//>
        <div class="small" style="margin-top:8px">${lib.items.filter(i => i.section === s.id).length} items</div></div>`)}</div>
      <table class="t" style="margin-top:14px"><thead><tr><th>Item</th><th>Library phase</th><th>Proposal section</th></tr></thead><tbody>
        ${lib.items.map(i => html`<tr><td>${i.name}<div class="tiny muted">${i.id}</div></td><td class="small">${i.phase}</td><td><select class="input" style="width:auto" value=${i.section} onChange=${e => setItem(i.id, { section: e.target.value })} aria-label=${'Section for ' + i.name}>${lib.sections.map(s => html`<option value=${s.id}>${s.name}</option>`)}</select></td></tr>`)}
      </tbody></table></div>` : null}

    ${tab === 'aaif' && cat ? html`<${CatalogueEditor} api=${api} cat=${cat} setCat=${setCat} lib=${lib} />` : null}
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
      <${Field} label="Dependencies" hint="Each group needs at least one of its items included, or provided by the AAIF foundation.">
        ${(i.dependsOn || []).map((g, gi) => html`<div class="row" style="margin-bottom:4px"><select multiple class="input" style="height:74px" aria-label="Dependency group" onChange=${e => { const sel = [...e.target.selectedOptions].map(o => o.value); const d = [...i.dependsOn]; d[gi] = sel; setItem(i.id, { dependsOn: d.filter(x => x.length) }); }}>${all.map(x => html`<option value=${x.id} selected=${g.includes(x.id)}>${x.name}</option>`)}</select><button class="icon-btn" aria-label="Remove group" onClick=${() => setItem(i.id, { dependsOn: i.dependsOn.filter((_, j) => j !== gi) })}>×</button></div>`)}
        <button class="btn small" onClick=${() => setItem(i.id, { dependsOn: [...(i.dependsOn || []), []] })}>Add dependency group</button><//>
      <${Field} label="Included work and notes (internal)"><${TextInput} multiline rows=${2} value=${i.sourceNotes} onChange=${v => setItem(i.id, { sourceNotes: v })} /><//>
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

function CatalogueEditor({ api, cat, setCat, lib }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState(null);
  async function save(next) { const s = await api.saveCatalogue(next); setCat(s); toast('AAIF catalogue saved. New quotes use it.'); }
  function importList() {
    let added = [];
    try {
      const t = text.trim();
      const incoming = t.startsWith('[') || t.startsWith('{') ? [].concat(JSON.parse(t).blocks || JSON.parse(t)).map(b => typeof b === 'string' ? { id: b } : b) : t.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(id => ({ id }));
      const have = new Set(cat.blocks.map(b => b.id));
      added = incoming.filter(b => b.id && !have.has(b.id)).map(b => ({ id: b.id, name: b.name || blockLabel(b.id), documented: true }));
      const next = { ...cat, blocks: [...cat.blocks, ...added], complete: cat.blocks.length + added.length >= (cat.expectedCount || 39) };
      save(next); setText(''); setMsg(`${added.length} blocks added (${next.blocks.length} total).`);
    } catch (e) { setMsg('Could not read that list: ' + e.message); }
  }
  return html`<div class="stack">
    <div class="card"><h2>AAIF block catalogue</h2>
      <p class="small">${cat.source}</p>
      ${!cat.complete ? html`<div class="banner warn small">${cat.blocks.length} of ${cat.expectedCount} documented blocks loaded. Paste the full AAIF block list below to complete it.</div>` : html`<div class="banner ok small">Catalogue marked complete (${cat.blocks.length} blocks).</div>`}
      <div class="blocks-grid" style="margin-top:10px">${cat.blocks.map((b, i) => html`<div class="block-row inline"><div class="grow"><${TextInput} value=${b.name} onChange=${v => save({ ...cat, blocks: cat.blocks.map((x, j) => j === i ? { ...x, name: v } : x) })} /><div class="tiny muted">${b.id}</div></div><button class="icon-btn" aria-label="Remove block" onClick=${() => save({ ...cat, blocks: cat.blocks.filter((_, j) => j !== i) })}>×</button></div>`)}</div>
      <${Field} label="Add blocks" hint="One id per line, comma separated, or JSON [{id, name}]"><textarea class="input" rows="4" value=${text} onInput=${e => setText(e.target.value)}></textarea><//>
      <div class="row" style="margin-top:8px"><button class="btn" disabled=${!text.trim()} onClick=${importList}>Add to catalogue</button>
        <label class="check small"><input type="checkbox" checked=${cat.complete} onChange=${e => save({ ...cat, complete: e.target.checked })} /> Catalogue is complete</label>
        <label class="field" style="display:flex;gap:6px;align-items:center"><span style="margin:0">Expected blocks</span><${NumInput} value=${cat.expectedCount} onChange=${v => save({ ...cat, expectedCount: v })} /></label></div>
      ${msg ? html`<div class="small" style="margin-top:6px">${msg}</div>` : null}
    </div>
    <div class="card"><h2>Existing integrations</h2>
      <table class="t"><thead><tr><th>Name</th><th>Confirmed</th><th>Source</th><th></th></tr></thead><tbody>
        ${cat.integrations.map((x, i) => html`<tr><td><${TextInput} value=${x.name} onChange=${v => save({ ...cat, integrations: cat.integrations.map((y, j) => j === i ? { ...y, name: v } : y) })} /></td>
          <td><input type="checkbox" checked=${!!x.confirmed} onChange=${e => save({ ...cat, integrations: cat.integrations.map((y, j) => j === i ? { ...y, confirmed: e.target.checked } : y) })} /></td><td class="small">${x.source}</td>
          <td><button class="icon-btn" aria-label="Remove" onClick=${() => save({ ...cat, integrations: cat.integrations.filter((_, j) => j !== i) })}>×</button></td></tr>`)}
      </tbody></table>
      <button class="btn small" style="margin-top:8px" onClick=${() => save({ ...cat, integrations: [...cat.integrations, { id: 'integration_' + Date.now(), name: 'New integration', confirmed: false, source: 'Added in Quote Studio' }] })}>Add integration</button></div>
    <div class="card"><h2>Capabilities the foundation provides by default</h2>
      <p class="small">Applied to new quotes. Items that depend on these will not ask for the prerequisite to be charged again.</p>
      <div class="blocks-grid">${lib.items.filter(i => i.section === 'base' && !i.isDesign).map(it => html`<label class="check small"><input type="checkbox" checked=${(cat.providedCapabilities || []).includes(it.id)} onChange=${e => save({ ...cat, providedCapabilities: e.target.checked ? [...(cat.providedCapabilities || []), it.id] : (cat.providedCapabilities || []).filter(x => x !== it.id) })} /> ${it.name}</label>`)}</div></div>
  </div>`;
}
void fmtMoney; void centsToInput;

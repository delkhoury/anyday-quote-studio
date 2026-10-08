import { useState, useMemo } from 'preact/hooks';
import { html, Badge, Seg, NumInput, TextInput, Field, toast } from '../ui.js';
import { describePricing, effectivePricing, priceForQuantity, incrementalPrice, blockTreatmentCounts, quantityFor, lineFor } from '../../shared/pricing.js';
import { fmtMoney, fmtInt, toCents, centsToInput, plural } from '../../shared/format.js';
import { blockLabel } from '../../shared/quote.js';

const STATE_OPTS = [{ value: 'included', label: 'Included', title: 'Counts toward the investment' }, { value: 'optional', label: 'Optional', title: 'Listed as an optional addition, never in the total' }, { value: 'hidden', label: 'Hidden', title: 'Not shown to the client' }];
const TREATMENTS = [
  { value: 'brand', label: 'Brand', title: 'Apply branding only, using existing controls' },
  { value: 'redesign', label: 'Redesign', title: 'Visual redesign; schema and behaviour unchanged' },
  { value: 'extend', label: 'Extend', title: 'Needs new fields, filters or functionality: separate development scope' },
  { value: 'new', label: 'New', title: 'A new block or capability: priced as a reusable component' },
  { value: 'not_used', label: 'Not used', title: 'Not used on this site' },
];

export function ScopeStep({ quote, update, calc }) {
  const [sec, setSec] = useState('base');
  const [filter, setFilter] = useState('included');
  const [q, setQ] = useState('');
  const sections = [...quote.pricingSnapshot.sections].sort((a, b) => a.order - b.order);
  const byId = Object.fromEntries(calc.lines.map(l => [l.id, l]));
  const setLine = (id, patch) => update(qq => ({ ...qq, lines: { ...qq.lines, [id]: { ...lineFor(qq, qq.pricingSnapshot.items.find(i => i.id === id)), ...(qq.lines?.[id] || {}), ...patch } } }));
  const lines = calc.lines.filter(l => l.section === sec);
  const counts = { included: 0, optional: 0, hidden: 0 };
  for (const l of lines) counts[l.state]++;
  const match = l => (filter === 'all' || l.state === filter) && (!q || (l.item.name + ' ' + l.item.what).toLowerCase().includes(q.toLowerCase()));
  const secCalc = calc.sections.find(s => s.id === sec);
  const impl = lines.filter(l => !l.isDesign && match(l));
  const design = lines.filter(l => l.isDesign && match(l));
  const hideAll = list => update(qq => { const L = { ...qq.lines }; for (const l of list) if (l.state === 'optional') L[l.id] = { ...(L[l.id] || {}), state: 'hidden' }; return { ...qq, lines: L }; });

  return html`<div class="stack">
    <div class="row wrap" role="tablist">${sections.map(s => { const c = calc.sections.find(x => x.id === s.id); return html`<button role="tab" aria-selected=${sec === s.id} class=${'btn' + (sec === s.id ? ' dark' : '')} onClick=${() => setSec(s.id)}>${s.order}. ${s.name} <span class="small" style="opacity:.8">${c.empty ? '' : fmtMoney(c.subtotal) + (c.pending ? '+' : '')}</span></button>`; })}</div>
    <div class="card" style="padding:12px 14px"><div class="row wrap">
      ${['included', 'optional', 'hidden', 'all'].map(k => html`<button class=${'chip' + (filter === k ? ' on' : '')} onClick=${() => setFilter(k)}>${k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)} ${k !== 'all' ? html`<b>${counts[k]}</b>` : ''}</button>`)}
      <input class="input" style="max-width:240px" placeholder="Search items" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Search items" />
      <span class="grow"></span>
      ${filter === 'optional' && counts.optional ? html`<button class="btn small" onClick=${() => { hideAll(lines.filter(match)); toast('Optional items in this view hidden'); }}>Hide all shown optional items</button>` : null}
    </div><p class="tiny muted" style="margin:6px 0 0">${secCalc.intro} Unselected items default to optional additions. Hide anything irrelevant or incompatible so it stays out of the proposal.</p></div>

    ${sec === 'base' && quote.foundation ? html`<${FoundationPanel} quote=${quote} update=${update} />` : null}
    ${sec === 'base' && !quote.foundation && quote.type === 'new_platform' ? html`<div class="banner info small">A new platform built from scratch. Component design counts every reusable component included below, so set the component quantities first.</div>` : null}

    ${impl.length ? html`<div class="card flush"><div class="cat-head"><span>${sec === 'base' ? 'Implementation' : secCalc.name}</span><span>${fmtMoney(secCalc.implementationSubtotal)}</span></div>
      ${groupBy(impl, l => l.item.subcategory).map(([sub, ls]) => html`<div class="subcat-head">${sub}</div>${ls.map(l => html`<${ItemRow} key=${l.id} l=${l} quote=${quote} setLine=${setLine} byId=${byId} />`)}`)}</div>` : null}
    ${sec === 'base' && (design.length || filter === 'included') ? html`<div class="card flush"><div class="cat-head"><span>Design</span><span>${fmtMoney(secCalc.designSubtotal)}${secCalc.design.some(d => d.amount === null) ? ' + pending' : ''}</span></div>
      <div class="small" style="padding:8px 14px">Design rates are not established in the source workbooks, so these stay unpriced until you enter a rate. Choose whether each amount is an additional charge or an allocation from an existing bundled fee (which changes the breakdown without increasing the total).</div>
      ${design.map(l => html`<${ItemRow} key=${l.id} l=${l} quote=${quote} setLine=${setLine} byId=${byId} />`)}
      ${!design.length ? html`<div class="empty small">No design items in this view.</div>` : null}</div>` : null}
    ${!impl.length && !design.length ? html`<div class="card empty">No ${filter === 'all' ? '' : filter} items${q ? ' match your search' : ''} in this section.</div>` : null}
  </div>`;
}

function groupBy(arr, fn) { const m = new Map(); for (const a of arr) { const k = fn(a) || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k).push(a); } return [...m.entries()]; }

function ItemRow({ l, quote, setLine, byId }) {
  const [open, setOpen] = useState(false);
  const p = l.pricing; const item = l.item; const line = l.line;
  const linked = item.quantitySource === 'component_design_count' || item.quantitySource === 'aaif_redesign_count';
  const linkedHelp = quote.type === 'new_platform'
    ? `Counts the reusable components included in Implementation${quote.foundation ? `, plus ${quote.foundation.name} components marked Redesign` : ''}.`
    : `Counts each unique ${quote.foundation?.name || 'foundation'} component marked Redesign once, however often it appears. Choose components in the panel above.`;
  const amountCell = () => {
    if (l.state !== 'included') return html`<span class="small muted">${l.state === 'optional' ? shortLabel(p) : 'Hidden'}</span>`;
    if (l.amount === null) return html`<${Badge} kind="danger">${l.result.status === 'qty_needed' ? 'Quantity needed' : 'Price needed'}<//>`;
    return html`<b>${l.startingAt ? 'from ' : ''}${fmtMoney(l.displayAmount ?? l.amount)}</b>`;
  };
  const badges = [];
  if (p.status === 'starting_at') badges.push(html`<${Badge} kind="warn" title="Starting price until confirmed">Starting at<//>`);
  if (p.priceSource === 'override') badges.push(html`<${Badge} kind="info" title=${line.override?.reason || ''}>Quote override<//>`);
  if (p.priceSource === 'confirmed') badges.push(html`<${Badge} kind="ok">Price confirmed<//>`);
  if (p.status === 'unpriced' && l.state === 'included') badges.push(html`<${Badge} kind="danger">Price needed<//>`);
  if (line.provisional || line.qtySource === 'example') badges.push(html`<${Badge}>Provisional<//>`);
  if (line.qtySource === 'inventory') badges.push(html`<${Badge} kind="info">From inventory<//>`);
  if (l.prior) badges.push(html`<${Badge} kind="info" title="Volume pricing continues from the sites already live">Continues from ${fmtInt(l.prior)} live<//>`);
  if (l.allocated) badges.push(html`<${Badge} kind="accent">Allocated<//>`);
  if (l.allocatedOut) badges.push(html`<${Badge} title="Part of this fee is shown under design">${fmtMoney(l.allocatedOut)} shown as design<//>`);
  return html`<div class=${'item state-' + l.state}>
    <div class="item-main">
      <div><div class="name">${item.name} ${badges}</div><div class="sub">${item.what}</div></div>
      <${Seg} value=${l.state} options=${STATE_OPTS} size="small" onChange=${v => setLine(l.id, { state: v })} />
      <div class="row" style="justify-content:flex-end;gap:6px">
        ${p.model === 'included' ? html`<span class="small muted">Included</span>`
          : linked ? html`<span class="small" title=${linkedHelp}>${plural(l.qty || 0, p.qtyUnit, p.qtyUnitPlural)}</span>`
          : l.state === 'included' ? html`<${NumInput} value=${line.qty} ariaLabel=${'Quantity for ' + item.name} placeholder="Qty" onChange=${v => setLine(l.id, { qty: v, qtySource: 'manual' })} /><span class="tiny muted">${p.qtyUnitPlural}</span>`
          : l.state === 'optional' ? html`<${NumInput} value=${line.optionalQty} ariaLabel=${'Quantity for optional estimate of ' + item.name} placeholder="Est. qty" onChange=${v => setLine(l.id, { optionalQty: v })} />` : null}
      </div>
      <div class="num">${amountCell()}</div>
      <button class="icon-btn" aria-expanded=${open} aria-label=${(open ? 'Hide' : 'Show') + ' details for ' + item.name} onClick=${() => setOpen(!open)}>${open ? '−' : '+'}</button>
    </div>
    ${open ? html`<div class="item-detail">
      <dl class="explain">
        <dt>What it means</dt><dd>${item.what}</dd>
        <dt>What the client receives</dt><dd>${item.receives}</dd>
        <dt>How it is priced</dt><dd>${describePricing(p)}${p.status === 'starting_at' ? ' A starting price stays distinct from a confirmed price until you confirm it below.' : ''}</dd>
        ${l.result?.breakdown?.length ? html`<dt>This quote</dt><dd>${l.result.breakdown.map(b => html`<div class="small">${b.label}: <b>${fmtMoney(b.amount)}</b></div>`)}</dd>` : null}
        ${item.dependsOn?.length ? html`<dt>Normally requires</dt><dd class="small">${item.dependsOn.map(g => g.map(id => byId[id]?.item.name || id).join(' or ')).join('; ')}. A prerequisite already included, or provided by the foundation, is never charged twice.</dd>` : null}
        ${linked ? html`<dt>Quantity</dt><dd class="small">${linkedHelp}</dd>` : null}
      </dl>
      <div class="stack" style="gap:10px">
        ${p.status === 'starting_at' || item.pricing.status === 'starting_at' ? html`<${Field} label="Confirmed price (this quote)" hint="Replaces the starting price for this quote only."><div class="row"><span>$</span><${NumInput} cls="input money" value=${line.confirmedPrice != null ? line.confirmedPrice / 100 : null} onChange=${v => setLine(l.id, { confirmedPrice: v === null ? undefined : toCents(v) })} /><span class="tiny muted">per ${p.qtyUnit}</span></div><//>` : null}
        <${OverrideEditor} l=${l} setLine=${setLine} />
        ${l.isDesign && l.state === 'included' ? html`<${Field} label="Design amount is">
          <${Seg} value=${line.design?.mode || 'additional'} options=${[{ value: 'additional', label: 'An additional charge' }, { value: 'allocated', label: 'Allocated from an existing fee' }]} onChange=${v => setLine(l.id, { design: { ...(line.design || {}), mode: v } })} />
          ${line.design?.mode === 'allocated' ? html`<select class="input" style="margin-top:8px" value=${line.design?.from || ''} onChange=${e => setLine(l.id, { design: { ...line.design, from: e.target.value } })} aria-label="Allocate from"><option value="">Choose the included item whose fee already covers this design…</option>${Object.values(byId).filter(x => x.state === 'included' && !x.isDesign && (x.amount ?? 0) > 0).map(x => html`<option value=${x.id}>${x.item.name} (${fmtMoney(x.amount)})</option>`)}</select>
            <div class="tiny muted" style="margin-top:4px">The design line shows its amount; the source item shows the remainder. The total does not change.</div>` : null}<//>` : null}
        ${l.state === 'included' && ['batched', 'progressive', 'per_block', 'per_unit'].includes(p.model) && !linked && !l.isDesign ? html`<${Field} label="Offer more as an optional addition" hint="Priced as the change against the quantity already included (volume tiers aware). Never in the total.">
          <div class="row"><${NumInput} value=${line.addition?.qty} placeholder="+ qty" onChange=${v => setLine(l.id, { addition: v ? { qty: v } : undefined })} />
          ${l.addition ? html`<span class="small">+${fmtInt(l.addition.qty)} ${p.qtyUnitPlural}: <b>${l.addition.amount === null ? 'price needed' : '+' + fmtMoney(l.addition.amount)}</b></span>` : null}</div><//>` : null}
        ${l.state === 'optional' && line.optionalQty ? html`<div class="small">Estimate for ${fmtInt(line.optionalQty)} ${p.qtyUnitPlural}: <b>${(() => { const r = priceForQuantity(p, line.optionalQty); return r.status === 'priced' ? fmtMoney(r.amount) : 'price needed'; })()}</b> (shown in Optional Additions)</div>` : null}
        ${l.state === 'hidden' ? html`<${Field} label="Why hidden (internal)"><${TextInput} value=${line.hiddenReason} onChange=${v => setLine(l.id, { hiddenReason: v })} /><//>` : null}
        ${line.sourceComment ? html`<div class="tiny muted">Workbook note: ${line.sourceComment}</div>` : null}
      </div>
    </div>` : null}
  </div>`;
}

function shortLabel(p) {
  if (p.model === 'per_unit') return p.unitPrice == null ? 'Price needed' : `${p.status === 'starting_at' ? 'from ' : ''}${fmtMoney(p.unitPrice)}/${p.qtyUnit}`;
  if (p.model === 'batched') return `${fmtMoney(p.first.price)} first ${fmtInt(p.first.size)}`;
  if (p.model === 'per_block') return `${fmtMoney(p.price)}/${fmtInt(p.blockSize)}`;
  if (p.model === 'progressive') return `from ${fmtMoney(p.tiers.at(-1).price)}/${p.qtyUnit}`;
  return 'Included';
}

function OverrideEditor({ l, setLine }) {
  const base = l.item.pricing; const ov = l.line.override || {};
  const setOv = patch => { const next = { ...ov, ...patch }; for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k]; setLine(l.id, { override: Object.keys(next).filter(k => k !== 'reason').length ? next : undefined }); };
  const money = (label, key, libVal) => html`<div class="row small"><span style="min-width:150px">${label}</span><span>$</span><${NumInput} cls="input money" value=${ov[key] != null ? ov[key] / 100 : null} placeholder=${libVal == null ? 'not set' : centsToInput(libVal)} onChange=${v => setOv({ [key]: v === null ? undefined : toCents(v) })} /></div>`;
  if (base.model === 'included') return null;
  return html`<details class="more" open=${!!l.line.override || base.status === 'unpriced'}><summary>${base.status === 'unpriced' ? 'Set a price for this quote' : 'Quote specific price override'}</summary>
    <div class="stack" style="gap:6px;margin-top:8px">
      ${base.model === 'per_unit' ? money(`Price per ${base.qtyUnit}`, 'unitPrice', base.unitPrice) : null}
      ${base.model === 'per_block' ? money(`Per ${fmtInt(base.blockSize)} ${base.qtyUnitPlural}`, 'price', base.price) : null}
      ${base.model === 'batched' ? html`${money(`First ${fmtInt(base.first.size)}`, 'firstPrice', base.first.price)}${money(`Each additional ${fmtInt(base.additional.size)}`, 'additionalPrice', base.additional.price)}` : null}
      ${base.model === 'progressive' ? base.tiers.map((t, i) => html`<div class="row small"><span style="min-width:150px">${t.label}</span><span>$</span><${NumInput} cls="input money" value=${ov.tierPrices?.[i] != null ? ov.tierPrices[i] / 100 : null} placeholder=${centsToInput(t.price)} onChange=${v => { const arr = [...(ov.tierPrices || base.tiers.map(() => null))]; arr[i] = v === null ? null : toCents(v); setOv({ tierPrices: arr.some(x => x != null) ? arr : undefined }); }} /></div>`) : null}
      ${l.line.override ? html`<${TextInput} value=${ov.reason} placeholder="Reason (internal)" onChange=${v => setLine(l.id, { override: { ...ov, reason: v } })} />` : null}
      <div class="tiny muted">Applies to this quote only. The Pricing Library is unchanged.</div>
    </div></details>`;
}

function FoundationPanel({ quote, update }) {
  const f = quote.foundation;
  const c = blockTreatmentCounts(quote);
  const [paste, setPaste] = useState('');
  const setF = fn => update(q => ({ ...q, foundation: fn(q.foundation) }));
  const setComp = (id, patch) => setF(x => ({ ...x, components: x.components.map(b => b.id === id ? { ...b, ...patch } : b) }));
  const setInteg = (i, patch) => setF(x => ({ ...x, integrations: x.integrations.map((y, j) => j === i ? { ...y, ...patch } : y) }));
  const caps = f.providedCapabilities || [];
  const baseItems = quote.pricingSnapshot.items.filter(i => i.section === 'base' && !i.isDesign);
  const redesigned = f.components.filter(b => b.treatment === 'redesign');
  const newPlatform = quote.type === 'new_platform';
  function addComponents() {
    const ids = paste.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    setF(x => { const have = new Set(x.components.map(b => b.id)); const add = ids.filter(id => !have.has(id)).map(id => ({ id, name: blockLabel(id), treatment: 'new', note: '', addedInQuote: true })); return { ...x, components: [...x.components, ...add] }; });
    setPaste(''); toast('Components added to this quote only');
  }
  return html`<div class="card">
    <div class="spread"><h2>${newPlatform ? `Starting from ${f.name}` : `Reusing ${f.name}`}</h2><span class="tiny muted">Foundation snapshot ${(f.takenAt || '').slice(0, 10)}${f.owner ? ` · ${f.owner}` : ''}</span></div>
    ${!f.complete && f.expectedComponents ? html`<div class="banner warn small" style="margin:8px 0">The foundation documents ${f.expectedComponents} components, but only ${f.components.length} are recorded. Complete the list under Foundations, then refresh the snapshot in Setup.</div>` : null}
    <p class="small">Choose what happens to each existing component. <b>Brand</b> applies branding with existing controls. <b>Redesign</b> is a visual redesign that keeps the component's schema and behaviour. <b>Extend</b> and <b>New</b> need separately identified development scope. Nothing is redesigned by default.</p>
    <div class="row wrap" style="margin:8px 0">${TREATMENTS.map(t => html`<${Badge} kind=${t.value === 'redesign' ? 'accent' : ''}>${t.label}: ${c[t.value] || 0}<//>`)}<span class="grow"></span>
      <button class="btn small" onClick=${() => setF(x => ({ ...x, components: x.components.map(b => ({ ...b, treatment: 'brand' })) }))}>Reset all to Brand</button></div>
    <div class="small" style="margin-bottom:8px"><b>${redesigned.length} selected for redesign:</b> ${redesigned.map(b => b.name).join(', ') || 'none'}</div>
    <details class="more"><summary>Choose components (${f.components.length} in the foundation, ${redesigned.length} marked Redesign)</summary>
    <div class="blocks-grid" style="margin-top:10px">${f.components.map(b => html`<div class=${'block-row' + (b.treatment === 'redesign' ? ' redesign' : '')}><div class="small"><b>${b.name}</b>${b.addedInQuote ? html` <${Badge}>This quote<//>` : null}<div class="tiny muted">${b.id}</div></div><${Seg} size="small" value=${b.treatment} options=${TREATMENTS} onChange=${v => setComp(b.id, { treatment: v })} /></div>`)}</div>
    <div class="row" style="margin-top:10px"><input class="input" placeholder="Add component ids for this quote, comma separated" value=${paste} onInput=${e => setPaste(e.target.value)} /><button class="btn small" disabled=${!paste.trim()} onClick=${addComponents}>Add components</button></div></details>

    ${f.integrations.length ? html`<h3 style="margin-top:18px">Existing integrations</h3>
    <p class="small">Existing connectors need configuration and compatibility review. When an existing connector meets the requirement, price it as configuration (i.e. Existing API integration setup), never as a new connector build.</p>
    <div class="scroll-x"><table class="t"><thead><tr><th>Integration</th><th>Existing connector meets the requirement?</th><th>Priced as</th></tr></thead><tbody>
      ${f.integrations.map((x, i) => html`<tr><td><b>${x.name}</b>${x.confirmed === false ? html` <${Badge} kind="warn">Unconfirmed<//>` : null}<div class="tiny muted">${x.source || ''}</div></td>
        <td><${Seg} size="small" value=${x.existingMeetsRequirement === true ? 'yes' : x.existingMeetsRequirement === false ? 'no' : 'unknown'} options=${[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unknown', label: 'Not reviewed' }]} onChange=${v => setInteg(i, { existingMeetsRequirement: v === 'yes' ? true : v === 'no' ? false : null })} /></td>
        <td><select class="input" style="width:auto" value=${x.pricedAs || ''} onChange=${e => setInteg(i, { pricedAs: e.target.value || null })} aria-label="Priced as"><option value="">Not priced separately</option>${quote.pricingSnapshot.items.filter(it => it.category === 'Integrations').map(it => html`<option value=${it.id}>${it.name}</option>`)}</select></td></tr>`)}
    </tbody></table></div>` : null}

    <details class="more" style="margin-top:14px"><summary>Capabilities already provided by ${f.name} (${caps.length})</summary>
      <p class="small">Tick capabilities the foundation already provides. Items that depend on them will not ask for the prerequisite to be charged again. This changes this quote only; edit the foundation itself under Foundations.</p>
      <div class="blocks-grid">${baseItems.map(it => html`<label class="check small"><input type="checkbox" checked=${caps.includes(it.id)} onChange=${e => setF(x => ({ ...x, providedCapabilities: e.target.checked ? [...caps, it.id] : caps.filter(y => y !== it.id) }))} /> ${it.name}</label>`)}</div>
    </details>
  </div>`;
}
export { quantityFor, effectivePricing, incrementalPrice };

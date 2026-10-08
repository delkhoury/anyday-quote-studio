import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
export const html = htm.bind(h);

let toastSetter = null;
export function toast(msg) { toastSetter?.(msg); }
export function Toaster() {
  const [msg, setMsg] = useState(null);
  useEffect(() => { toastSetter = m => { setMsg(m); clearTimeout(Toaster.t); Toaster.t = setTimeout(() => setMsg(null), 2600); }; return () => { toastSetter = null; }; }, []);
  return msg ? html`<div class="toast" role="status">${msg}</div>` : null;
}

export function Modal({ title, onClose, children, footer, narrow }) {
  useEffect(() => { const k = e => e.key === 'Escape' && onClose?.(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return html`<div class="modal-back" onClick=${e => e.target === e.currentTarget && onClose?.()}>
    <div class=${'modal' + (narrow ? ' narrow' : '')} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}>×</button></div>
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-foot">${footer}</div>` : null}
    </div></div>`;
}

export function Seg({ value, options, onChange, size }) {
  return html`<div class="seg" role="group">${options.map(o => html`<button type="button" class=${(value === o.value ? 'on' : '') + (o.value === 'included' ? ' inc' : '')} aria-pressed=${value === o.value} title=${o.title || ''} onClick=${() => onChange(o.value)} style=${size === 'small' ? 'padding:3px 8px;font-size:11.5px' : ''}>${o.label}</button>`)}</div>`;
}

export function Field({ label, children, hint }) {
  return html`<label class="field"><span>${label}</span>${children}${hint ? html`<div class="tiny muted" style="margin-top:4px">${hint}</div>` : null}</label>`;
}

// Re-sync local input state only when the incoming value really changes. (A plain useEffect also
// fires once after mount, after paint, and would wipe anything typed in that first frame.)
function useSyncFromProp(value, sync) {
  const prev = useRef(value);
  useEffect(() => { if (prev.current !== value) { prev.current = value; sync(); } }, [value]);
}

// number input that keeps a local string while typing
export function NumInput({ value, onChange, cls = 'input qty', placeholder = '', min = 0, step = 1, disabled, ariaLabel }) {
  const [s, setS] = useState(value === null || value === undefined ? '' : String(value));
  useSyncFromProp(value, () => setS(value === null || value === undefined ? '' : String(value)));
  // commit from the element itself (never from possibly stale component state)
  const commit = el => {
    const t = String(el.value).trim(); setS(t);
    if (t === '') { if (value !== null && value !== undefined) onChange(null); return; }
    const n = Number(t.replace(/[,$\s]/g, ''));
    if (Number.isFinite(n) && n >= min) { const v = step === 1 ? Math.round(n * 100) / 100 : n; if (v !== value) onChange(v); }
    else setS(value ?? '');
  };
  return html`<input class=${cls} inputmode="decimal" value=${s} placeholder=${placeholder} disabled=${disabled} aria-label=${ariaLabel}
    onInput=${e => setS(e.target.value)} onChange=${e => commit(e.currentTarget)} onBlur=${e => commit(e.currentTarget)}
    onKeyDown=${e => { if (e.key === 'Enter') commit(e.currentTarget); }} />`;
}

export function TextInput({ value, onChange, cls = 'input', placeholder = '', multiline, rows = 4, ariaLabel }) {
  const [s, setS] = useState(value ?? '');
  useSyncFromProp(value, () => setS(value ?? ''));
  if (multiline) return html`<textarea class=${cls} rows=${rows} placeholder=${placeholder} aria-label=${ariaLabel} value=${s} onInput=${e => setS(e.target.value)} onBlur=${e => { const v = e.currentTarget.value; setS(v); if (v !== (value ?? '')) onChange(v); }}></textarea>`;
  const commit = el => { const v = el.value; setS(v); if (v !== (value ?? '')) onChange(v); };
  return html`<input class=${cls} placeholder=${placeholder} aria-label=${ariaLabel} value=${s} onInput=${e => setS(e.target.value)} onChange=${e => commit(e.currentTarget)} onBlur=${e => commit(e.currentTarget)} onKeyDown=${e => { if (e.key === 'Enter') commit(e.currentTarget); }} />`;
}

export function Badge({ kind = '', children, title }) { return html`<span class=${'badge ' + kind} title=${title || ''}>${children}</span>`; }

export function ListEditor({ items, onChange, placeholder = 'Add a line', ariaLabel }) {
  const [draft, setDraft] = useState('');
  return html`<div class="stack" style="gap:6px">
    ${items.map((it, i) => html`<div class="row" key=${i + it}>
      <${TextInput} value=${it} ariaLabel=${ariaLabel} onChange=${v => { const n = [...items]; n[i] = v; onChange(n.filter(x => x.trim())); }} />
      <button class="icon-btn" aria-label="Remove" onClick=${() => onChange(items.filter((_, j) => j !== i))}>×</button></div>`)}
    <div class="row"><input class="input" placeholder=${placeholder} value=${draft} onInput=${e => setDraft(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && draft.trim()) { onChange([...items, draft.trim()]); setDraft(''); } }} />
      <button class="btn small" disabled=${!draft.trim()} onClick=${() => { onChange([...items, draft.trim()]); setDraft(''); }}>Add</button></div>
  </div>`;
}

// In-page confirmation (window.confirm is unavailable in some embedded viewers).
let confirmSetter = null;
export function askConfirm(message, action = 'Confirm') { return new Promise(res => confirmSetter ? confirmSetter({ message, action, res }) : res(window.confirm(message))); }
let exportSetter = null;
if (typeof window !== 'undefined') window.__showExport = (name, text) => exportSetter?.({ name, text });
export function Dialogs() {
  const [c, setC] = useState(null);
  const [x, setX] = useState(null);
  useEffect(() => { confirmSetter = setC; exportSetter = setX; return () => { confirmSetter = null; exportSetter = null; }; }, []);
  const done = v => { c.res(v); setC(null); };
  async function copy(t, el) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { el?.select(); toast('Select the text and copy it'); } }
  return html`${c ? html`<${Modal} narrow title="Please confirm" onClose=${() => done(false)} footer=${html`<button class="btn" onClick=${() => done(false)}>Cancel</button><button class="btn danger" onClick=${() => done(true)}>${c.action}</button>`}><p>${c.message}</p><//>` : null}
  ${x ? html`<${Modal} title=${'Export ' + x.name} onClose=${() => setX(null)} footer=${html`<button class="btn" onClick=${() => setX(null)}>Close</button><button class="btn primary" onClick=${e => copy(x.text, e.currentTarget.closest('.modal').querySelector('textarea'))}>Copy to clipboard</button>`}>
    <p class="small">This prototype cannot save files. Copy the text and save it as <b>${x.name}</b>. Paste it back with Import to restore it.</p>
    <textarea class="input" style="min-height:300px;font-family:ui-monospace,monospace;font-size:12px" readonly id="export-text">${x.text.length > 2000000 ? x.text.slice(0, 2000000) : x.text}</textarea><//>` : null}`;
}

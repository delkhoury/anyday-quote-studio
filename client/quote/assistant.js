// Quote assistant panel: chat with Claude about the quote, attach a brief, watch it build.
// Changes apply to the quote directly; every turn can be undone.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Badge, toast, askConfirm } from '../ui.js';

const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,application/pdf';
const readB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });

// minimal formatting: paragraphs, bullet lines, **bold**
function Rich({ text }) {
  const blocks = String(text || '').split(/\n{2,}/);
  const inline = s => s.split(/(\*\*[^*]+\*\*)/g).map(p => (p.startsWith('**') && p.endsWith('**') ? html`<b>${p.slice(2, -2)}</b>` : p));
  return html`${blocks.map(b => {
    const lines = b.split('\n');
    const isBullet = l => /^\s*([-*•]|\d+\.)\s+/.test(l);
    const first = lines.findIndex(isBullet);
    const lead = first < 0 ? lines : lines.slice(0, first);
    const items = first < 0 ? [] : lines.slice(first).filter(isBullet);
    return html`${lead.length ? html`<p>${lead.map((l, i) => html`${i ? html`<br />` : null}${inline(l)}`)}</p>` : null}${items.length ? html`<ul>${items.map(l => html`<li>${inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>`)}</ul>` : null}`;
  })}`;
}

function Steps({ steps }) {
  if (!steps?.length) return null;
  return html`<ul class="ai-steps">${steps.map(s => html`<li class=${s.ok ? 'ok' : 'err'}><span aria-hidden="true">${s.ok ? '✓' : '!'}</span>${s.summary}</li>`)}</ul>`;
}

export function AssistantPanel({ api, quote, replace, flush, health, onClose }) {
  const [convo, setConvo] = useState(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [job, setJob] = useState(null);
  const [err, setErr] = useState(null);
  const poll = useRef(null); const seen = useRef(null); const end = useRef(null);
  const enabled = health?.assistant && api.mode === 'server';

  const load = () => api.assistant(quote.id).then(setConvo).catch(e => setErr(e.message));
  useEffect(() => { load(); return () => clearTimeout(poll.current); }, [quote.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [convo, job?.steps?.length, job?.text]);

  async function refreshQuote() { try { replace(await api.quote(quote.id)); } catch { /* keep the current view */ } }
  function tick(id) {
    clearTimeout(poll.current);
    poll.current = setTimeout(async () => {
      try {
        const j = await api.assistantJob(id); setJob(j);
        if (j.quoteUpdatedAt && j.quoteUpdatedAt !== seen.current) { seen.current = j.quoteUpdatedAt; refreshQuote(); }
        if (j.status === 'running') tick(id);
        else { await refreshQuote(); await load(); setJob(null); if (j.status === 'done') toast('The assistant updated the quote'); }
      } catch (e) { setErr(e.message); setJob(null); }
    }, 1000);
  }
  async function send() {
    if (!text.trim() && !files.length) return;
    setErr(null);
    try {
      await flush();
      const payload = await Promise.all(files.map(async f => ({ name: f.name, type: f.type, data: await readB64(f) })));
      const j = await api.askAssistant(quote.id, { text: text.trim(), files: payload });
      setConvo(c => ({ ...c, transcript: [...(c?.transcript || []), { role: 'user', text: text.trim(), files: files.map(f => f.name), at: new Date().toISOString() }] }));
      setText(''); setFiles([]); setJob(j); seen.current = null; tick(j.id);
    } catch (e) { setErr(e.message); }
  }
  async function undo() {
    if (!(await askConfirm('Undo the assistant\'s last turn? The quote goes back to exactly how it was before that turn, including any edits you made since.', 'Undo turn'))) return;
    try { replace(await api.undoAssistant(quote.id)); await load(); toast('Last assistant turn undone'); } catch (e) { setErr(e.message); }
  }
  function addFiles(list) {
    const next = [...files];
    for (const f of list) { if (f.size > 15 * 1024 * 1024) { setErr(`${f.name} is larger than 15 MB`); continue; } next.push(f); }
    setFiles(next.slice(0, 5));
  }
  const busy = !!job;
  const transcript = convo?.transcript || [];
  const empty = !transcript.length && !busy;

  return html`<aside class="ai-panel" aria-label="Quote assistant" onDragOver=${e => e.preventDefault()} onDrop=${e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); }}>
    <div class="ai-head">
      <div><div class="caps" style="color:var(--accent)">Quote assistant</div><div class="tiny muted">${convo?.model ? `Claude · ${convo.model}` : 'Claude'} · changes apply to the quote</div></div>
      <div class="row" style="gap:6px">
        ${convo?.canUndo ? html`<button class="btn small" disabled=${busy} onClick=${undo} title="Restore the quote to before the last assistant turn">Undo last turn</button>` : null}
        <button class="icon-btn" aria-label="Close assistant" onClick=${onClose}>×</button></div>
    </div>
    <div class="ai-body">
      ${!enabled ? html`<div class="banner warn small">${api.mode !== 'server' ? 'The assistant needs the Anyday Quote Studio server. It is not available in this prototype.' : html`The assistant is not connected yet. Add <code>ANTHROPIC_API_KEY</code> in Render (Environment), save, and it is ready after the redeploy.`}</div>` : null}
      ${empty && enabled ? html`<div class="ai-empty">
        <h3>Give me the brief</h3>
        <p class="small">Attach a PDF, Word document or notes, or describe the project. I will set up the quote, analyse the websites, choose every deliverable with quantities and reasons, write the proposal and add first pass Plan hours. You can undo any turn.</p>
        <div class="stack" style="gap:6px">${['Build this quote from the attached brief.', 'A 600 clinic dental network wants one platform. Main site is example.com; 40 clinics have their own site. Quote it.', 'Check the quote for gaps and anything charged twice.'].map(s => html`<button class="chip" style="text-align:left" onClick=${() => setText(s)}>${s}</button>`)}</div></div>` : null}
      ${transcript.map((m, i) => m.role === 'user'
        ? html`<div class="ai-msg user" key=${i}>${m.files?.length ? html`<div class="row wrap" style="gap:4px;margin-bottom:4px">${m.files.map(f => html`<span class="ai-file">${f}</span>`)}</div>` : null}${m.text ? html`<${Rich} text=${m.text} />` : null}</div>`
        : m.role === 'system' ? html`<div class="ai-note tiny" key=${i}>${m.text}</div>`
        : html`<div class="ai-msg bot" key=${i}><${Steps} steps=${m.steps} />${m.text ? html`<${Rich} text=${m.text} />` : null}${m.error ? html`<div class="banner danger tiny" style="margin-top:6px">${m.error}</div>` : null}</div>`)}
      ${busy ? html`<div class="ai-msg bot"><${Steps} steps=${job.steps} />${job.text ? html`<${Rich} text=${job.text} />` : null}
        <div class="ai-working"><span class="ai-dot"></span>${job.progress || 'Working…'}</div>
        <button class="btn small ghost" onClick=${async () => setJob(await api.stopAssistant(job.id))}>Stop</button></div>` : null}
      <div ref=${end}></div>
    </div>
    <div class="ai-compose">
      ${err ? html`<div class="banner danger tiny" style="margin-bottom:6px">${err} <button class="btn small ghost" onClick=${() => setErr(null)}>Dismiss</button></div>` : null}
      ${files.length ? html`<div class="row wrap" style="gap:4px;margin-bottom:6px">${files.map((f, i) => html`<span class="ai-file">${f.name}<button class="icon-btn" aria-label=${'Remove ' + f.name} onClick=${() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>`)}</div>` : null}
      <textarea class="input" rows="3" placeholder=${busy ? 'Working on the quote…' : 'Describe the project or ask for a change. Ctrl or Cmd + Enter sends.'} value=${text} disabled=${!enabled} onInput=${e => setText(e.target.value)}
        onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!busy) send(); } }}></textarea>
      <div class="row" style="margin-top:6px">
        <label class=${'btn small' + (!enabled ? ' disabled' : '')}>Attach brief<input type="file" multiple accept=${ACCEPT} class="hidden" disabled=${!enabled} onChange=${e => { addFiles([...e.target.files]); e.target.value = ''; }} /></label>
        <span class="tiny muted grow">PDF, Word, text or images · up to 15 MB each</span>
        <button class="btn primary small" disabled=${!enabled || busy || (!text.trim() && !files.length)} onClick=${send}>Send</button></div>
      ${transcript.length && !busy ? html`<button class="btn small ghost" style="margin-top:4px" onClick=${async () => { if (await askConfirm('Clear the conversation? The quote is not changed, and Undo stays available.', 'Clear')) setConvo(await api.clearAssistant(quote.id)); }}>Clear conversation</button>` : null}
    </div>
  </aside>`;
}

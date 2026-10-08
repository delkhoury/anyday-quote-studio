import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Badge, Field, NumInput, TextInput, toast } from '../ui.js';
import { summarize } from '../../shared/inventory.js';
import { parseCmsExport } from '../../shared/media.js';
import { fmtInt, fmtDate } from '../../shared/format.js';
import { readFileText } from '../api.js';

export function AnalyseStep({ api, quote, update, replace, health, flush, go }) {
  const [opts, setOpts] = useState({ maxPagesInspect: 150, includeHosts: '', crawlIfNoSitemap: false });
  const [job, setJob] = useState(null);
  const [err, setErr] = useState(null);
  const [acceptPartial, setAcceptPartial] = useState(false);
  const poll = useRef(null);
  const canScan = health?.scanner;
  const inv = quote.inventory || {};
  const s = summarize(inv);

  useEffect(() => () => clearTimeout(poll.current), []);
  async function start(extra = {}) {
    setErr(null); setAcceptPartial(false);
    if (!quote.project?.url) { setErr('Enter the website URL in step 1 first.'); return; }
    try {
      await flush();
      const j = await api.startScan({ quoteId: quote.id, url: quote.project.url, includeHosts: opts.includeHosts.split(/[\s,]+/).filter(Boolean), crawlIfNoSitemap: opts.crawlIfNoSitemap, limits: { maxPagesInspect: opts.maxPagesInspect }, ...extra });
      setJob(j); tick(j.id);
    } catch (e) { setErr(e.message); }
  }
  function tick(id) {
    clearTimeout(poll.current);
    poll.current = setTimeout(async () => {
      try { const j = await api.scan(id); setJob(j); if (['queued', 'running'].includes(j.status)) tick(id); }
      catch (e) { setErr(e.message); }
    }, 900);
  }
  async function merge() {
    try {
      await flush();
      const q = await api.mergeScan(quote.id, job.result.id, acceptPartial);
      replace(q); toast('Scan merged. Your earlier decisions were kept.'); go(`#/quote/${quote.id}/review`);
    } catch (e) { setErr(e.message); }
  }
  const r = job?.result; const cov = r?.coverage;
  const pct = job?.progress?.pagesPlanned ? Math.round(100 * (job.progress.pagesInspected || 0) / job.progress.pagesPlanned) : (job?.status === 'running' ? 8 : 0);

  return html`<div class="stack">
    <div class="card">
      <div class="spread"><h2>Analyse website</h2>${!canScan ? html`<${Badge} kind="warn">Server required<//>` : null}</div>
      ${!canScan ? html`<div class="banner warn" style="margin-top:10px">This is the in-browser prototype. It cannot fetch external websites, so live analysis is unavailable here. Run the Anyday Quote Studio server to scan sites. Nothing on this screen is simulated.</div>` : null}
      <p class="small">Reads robots.txt for declared sitemaps, checks common sitemap locations, follows nested and compressed sitemap indexes, deduplicates URLs, then inspects a bounded set of pages: every standalone page first, then representatives of each repeatable URL group. Respects robots.txt and crawl delay, refuses private network destinations including unsafe redirects, and runs one site at a time.</p>
      <div class="grid3" style="margin-top:10px">
        <${Field} label="Website"><input class="input" value=${quote.project?.url || ''} disabled /><//>
        <${Field} label="Pages to inspect" hint="Upper bound for HTML inspection (1 to 600). Sitemap URLs are all collected regardless."><${NumInput} cls="input" value=${opts.maxPagesInspect} onChange=${v => setOpts({ ...opts, maxPagesInspect: Math.max(1, Math.min(600, v || 150)) })} /><//>
        <${Field} label="Also include hosts" hint="Comma separated. Subdomains and other hosts are kept separate unless listed here."><${TextInput} value=${opts.includeHosts} onChange=${v => setOpts({ ...opts, includeHosts: v })} placeholder="i.e. docs.example.org" /><//>
      </div>
      <div class="row wrap" style="margin-top:12px">
        <label class="check"><input type="checkbox" checked=${opts.crawlIfNoSitemap} onChange=${e => setOpts({ ...opts, crawlIfNoSitemap: e.target.checked })} /> If no sitemap exists, run a bounded crawl (up to 300 pages, depth 3)</label>
        <span class="grow"></span>
        ${job && ['queued', 'running'].includes(job.status) ? html`<button class="btn danger" onClick=${async () => setJob(await api.cancelScan(job.id))}>Cancel scan</button>` : null}
        <button class="btn primary" disabled=${!canScan || (job && ['queued', 'running'].includes(job.status))} onClick=${() => start()}>Analyse website</button>
      </div>
      ${err ? html`<div class="banner danger" style="margin-top:10px">${err}</div>` : null}
    </div>

    ${job ? html`<div class="card">
      <div class="spread"><h3>Scan ${job.status === 'running' ? 'in progress' : job.status.replace('_', ' ')}</h3><span class="tiny muted">${job.params.url}</span></div>
      ${['queued', 'running'].includes(job.status) ? html`<div class="progress" style="margin:8px 0"><div style=${`width:${pct}%`}></div></div>` : null}
      <div class="small"><b>${job.progress?.message || ''}</b></div>
      <div class="log" style="margin-top:8px">${(job.recent || []).map(p => `${p.at?.slice(11, 19) || ''}  ${p.message}`).join('\n')}</div>
      ${job.status === 'failed' ? html`<div class="banner danger" style="margin-top:10px">Scan failed: ${job.error}. Your existing quote and inventory are unchanged.</div>` : null}
      ${job.status === 'cancelled' ? html`<div class="banner info" style="margin-top:10px">Scan cancelled. Nothing was changed.</div>` : null}
      ${job.status === 'no_sitemap' ? html`<div class="banner warn" style="margin-top:10px">No sitemap was found at robots.txt or the common locations. You can run a bounded crawl from the homepage. Its coverage is limited and will be labelled as such.
        <div style="margin-top:8px"><button class="btn small" onClick=${() => start({ crawlIfNoSitemap: true })}>Run bounded crawl</button></div></div>` : null}
      ${r && job.status === 'done' ? html`<${Coverage} r=${r} cov=${cov} />
        <div class="row wrap" style="margin-top:14px">
          ${r.partial ? html`<label class="check"><input type="checkbox" checked=${acceptPartial} onChange=${e => setAcceptPartial(e.target.checked)} /> I understand this scan is partial and want to merge what it found</label>` : null}
          <span class="grow"></span>
          <button class="btn primary" disabled=${!r.urls || (r.partial && !acceptPartial)} onClick=${merge}>Merge ${fmtInt(r.urls)} URLs into the inventory</button>
        </div>
        <div class="tiny muted" style="margin-top:6px">Merging keeps every classification you have already edited, marks new and changed URLs, and keeps URLs that were not seen this time. Quote quantities are not touched until you use Review and apply quantities.</div>` : null}
    </div>` : null}

    <div class="card"><h3>Current inventory</h3>
      ${inv.source ? html`<p class="small" style="margin:0"><b>${inv.source.label}</b> · ${fmtDate(inv.source.date)}${inv.source.type === 'imported_example' ? ' · dated example, not a fresh scan' : ''}${inv.source.partial ? ' · partial scan' : ''}</p>
        <p class="small muted">${fmtInt(s.discovered)} URLs · ${fmtInt(s.needsReview)} need review · ${fmtInt(s.edited)} edited by you${s.statusCounts.new || s.statusCounts.changed ? ` · ${s.statusCounts.new} new, ${s.statusCounts.changed} changed, ${s.statusCounts.not_seen} not seen in the latest scan` : ''}</p>
        ${inv.source.note ? html`<p class="small muted">${inv.source.note}</p>` : null}`
      : html`<p class="small muted" style="margin:0">No inventory yet. Analyse the website or enter quantities directly in Select scope.</p>`}
      ${(inv.scans || []).length ? html`<details class="more" style="margin-top:6px"><summary>Scan history (${inv.scans.length})</summary><ul class="small" style="padding-left:18px">${inv.scans.slice().reverse().map(sc => html`<li>${fmtDate(sc.finishedAt)} · ${sc.coverage?.urlsDiscovered ?? '?'} URLs · ${sc.coverage?.pagesInspected ?? '?'} pages inspected${sc.partial ? ' · partial' : ''}</li>`)}</ul></details>` : null}
    </div>

    <${MediaPanel} quote=${quote} update=${update} />
  </div>`;
}

function Coverage({ r, cov }) {
  const ext = Object.entries(cov.urlsOutOfScope || {});
  return html`<div style="margin-top:12px">
    ${r.partial ? html`<div class="banner warn">Partial results. ${cov.limitedBy.join('. ')}${r.failureCount ? ` ${r.failureCount} request${r.failureCount === 1 ? '' : 's'} failed.` : ''}</div>` : html`<div class="banner ok">Scan complete.</div>`}
    <div class="grid4" style="margin-top:10px">
      <div class="tile"><div class="k">Source</div><div class="v" style="font-size:22px">${cov.mode === 'crawl' ? 'Bounded crawl' : 'Sitemaps'}</div><div class="d">${cov.mode === 'crawl' ? cov.crawl?.note : `Found via ${cov.seedSource}`}</div></div>
      <div class="tile"><div class="k">Sitemap files</div><div class="v">${fmtInt(cov.sitemapFiles)}</div><div class="d">${cov.sitemapFilesFailed} failed</div></div>
      <div class="tile"><div class="k">URLs discovered</div><div class="v">${fmtInt(cov.urlsDiscovered)}</div><div class="d">${cov.disallowedByRobots} disallowed by robots.txt</div></div>
      <div class="tile"><div class="k">Pages inspected</div><div class="v">${fmtInt(cov.pagesInspected)}</div><div class="d">${cov.pagesFailed} failed · coverage ${cov.urlsDiscovered ? Math.round(100 * cov.pagesInspected / cov.urlsDiscovered) : 0}% of URLs</div></div>
    </div>
    ${ext.length ? html`<div class="banner info small" style="margin-top:10px">Kept separate (not in scope): ${ext.map(([hst, n]) => `${hst} (${n})`).join(', ')}. Add a host under "Also include hosts" and rescan to include it.</div>` : null}
    ${r.failures?.length ? html`<details class="more" style="margin-top:8px"><summary>Failures (${r.failureCount})</summary><ul class="small" style="padding-left:18px">${r.failures.map(f => html`<li><span class="url-cell">${f.url}</span>: ${f.error}</li>`)}</ul></details>` : null}
    <details class="more" style="margin-top:8px"><summary>Sitemap files (${r.sitemaps.length})</summary><ul class="small" style="padding-left:18px">${r.sitemaps.map(f => html`<li><span class="url-cell">${f.url}</span> · ${f.type || 'unreadable'}${f.type ? ` · ${f.count} entr${f.count === 1 ? 'y' : 'ies'}` : ''}${f.error ? html` · <span style="color:var(--danger)">${f.error}</span>` : ''}</li>`)}</ul></details>
    <div class="tiny muted" style="margin-top:6px">Limits: ${r.coverage.userAgent}. Crawl delay ${cov.crawlDelayMs}ms.</div>
  </div>`;
}

export function MediaPanel({ quote, update }) {
  const m = quote.inventory?.media || {};
  const line = quote.lines?.MIG_MEDIA || {};
  const [err, setErr] = useState(null);
  async function onFile(e) {
    const f = e.target.files[0]; if (!f) return;
    try {
      const res = parseCmsExport(await readFileText(f), f.name);
      if (!res.total) throw new Error('No media assets found in that file. Use a CSV with a url or filename column, or a WordPress or Sanity media export.');
      update(q => ({ ...q, inventory: { ...(q.inventory || {}), media: { ...(q.inventory?.media || {}), verified: { ...res, migrateTotal: res.images + res.documents + res.video + res.audio + res.other } } } }));
      setErr(null); toast(`Imported ${fmtInt(res.total)} verified assets`);
    } catch (x) { setErr(x.message); }
    e.target.value = '';
  }
  const d = m.discovered;
  return html`<div class="card"><h2>Media inventory</h2>
    <p class="small">Four separate numbers. A public scan does not establish the size of the media library; only a CMS export does. Your migration allowance is what the quote charges.</p>
    <div class="grid4">
      <div class="tile"><div class="k">Found on scanned pages</div><div class="v">${d ? fmtInt(d.images.unique + d.documents.unique) : 'n/a'}</div><div class="d">${d ? `${fmtInt(d.images.unique)} images (${fmtInt(d.images.variantsCollapsed)} responsive or transformed copies collapsed), ${fmtInt(d.documents.unique)} documents, ${fmtInt(d.videos.externalReferences)} external video references (not files). ${d.label}` : 'No scan yet'}</div></div>
      <div class="tile"><div class="k">Image sitemap entries</div><div class="v">${m.imageSitemap ? fmtInt(m.imageSitemap.unique) : 'n/a'}</div><div class="d">${m.imageSitemap ? m.imageSitemap.label : 'None declared or no scan yet'}</div></div>
      <div class="tile"><div class="k">Verified CMS library</div><div class="v">${m.verified ? fmtInt(m.verified.total) : 'n/a'}</div><div class="d">${m.verified ? `${fmtInt(m.verified.images)} images, ${fmtInt(m.verified.documents)} documents, ${fmtInt(m.verified.video + m.verified.audio)} audio/video, ${fmtInt(m.verified.other)} other · ${m.verified.fileName} · ${m.verified.duplicatesCollapsed} duplicates collapsed` : 'Import a CMS media export to verify'}</div>
        <label class="btn small" style="margin-top:8px">Import CMS export<input type="file" accept=".csv,.json,.ndjson,.txt" class="hidden" onChange=${onFile} /></label>
        ${m.verified ? html` <button class="btn small ghost" onClick=${() => update(q => ({ ...q, inventory: { ...q.inventory, media: { ...q.inventory.media, verified: null } } }))}>Remove</button>` : null}</div>
      <div class="tile accent"><div class="k">Your migration allowance</div><div class="v">${line.state === 'included' && Number.isFinite(line.qty) ? fmtInt(line.qty) : 'n/a'}</div><div class="d">${line.state === 'included' ? 'Charged in Migration. Edit in Select scope.' : 'Media migration is not included yet.'}</div></div>
    </div>
    ${err ? html`<div class="banner danger" style="margin-top:8px">${err}</div>` : null}
  </div>`;
}

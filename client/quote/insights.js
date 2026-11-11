// Site insights: what the scan learned beyond URLs. CMS and exact counts, integrations,
// languages, page templates and distinct components.
import { html, Badge } from '../ui.js';
import { siteInsights } from '../../shared/inventory.js';
import { fmtInt } from '../../shared/format.js';

export function InsightsCard({ quote, compact = false }) {
  const si = siteInsights(quote);
  if (!si) return null;
  const ex = si.exact;
  const cats = {};
  for (const i of si.integrations) (cats[i.categoryName || i.category] = cats[i.categoryName || i.category] || []).push(i.name);
  const multi = si.sites.length > 1;
  const tile = (k, v, d) => html`<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  return html`<div class="card">
    <div class="spread"><h2>Site insights</h2><span class="tiny muted">${multi ? `${si.sites.length} scanned sites` : `${fmtInt(si.sites[0].pagesInspected || 0)} pages inspected`}</span></div>
    <p class="small muted">Found in page markup and, where the CMS publishes them, exact counts from the CMS. Apply quantities on Review picks these up${['new_site', 'new_platform'].includes(quote.type) ? ', including templates and components for the build' : ''}.</p>
    <div class="insight-grid" style="margin-top:8px">
      ${tile('Platform', si.cms.length ? si.cms.map(c => c.name).join(', ') : 'Unknown', si.cms[0] ? `Confidence ${si.cms[0].confidence}${multi ? `, ${si.cms[0].sites.length} site${si.cms[0].sites.length === 1 ? '' : 's'}` : ''}` : 'No CMS markers found')}
      ${tile('Exact CMS counts', ex ? fmtInt(ex.records.total + ex.pages.total) : 'Not available', ex ? `${fmtInt(ex.pages.total)} pages, ${fmtInt(ex.records.total)} records, ${fmtInt(ex.media.total)} media files${ex.records.extrapolated ? ', extrapolated' : ''}` : 'The CMS does not publish counts. Volumes come from the sitemaps.')}
      ${tile('Page templates', fmtInt(si.templates.count || 0), `${fmtInt(si.templates.advanced || 0)} advanced. Layouts shared by two or more pages`)}
      ${tile('Distinct components', fmtInt(si.components.count || 0), `${fmtInt(si.components.standard || 0)} static, ${fmtInt(si.components.interactive || 0)} interactive section patterns`)}
      ${tile('Languages', fmtInt(si.languages.count || 1), (si.languages.codes || []).join(', ') || 'One language')}
      ${tile('Integrations', fmtInt(si.integrations.length), Object.keys(cats).slice(0, 3).join(', ') || 'None found in page scripts')}
    </div>
    ${!compact && si.integrations.length ? html`<div style="margin-top:12px"><div class="caps" style="margin-bottom:6px">Integrations found</div>
      <div class="stack" style="gap:4px">${Object.entries(cats).map(([c, names]) => html`<div class="row wrap small" style="gap:6px"><span class="muted" style="min-width:190px">${c}</span><span class="chips">${names.map(n => html`<${Badge}>${n}<//>`)}</span></div>`)}</div></div>` : null}
    ${!compact && ex?.types?.length ? html`<details class="more" style="margin-top:10px"><summary class="small">Content types reported by the CMS</summary>
      <table class="t" style="margin-top:6px"><thead><tr><th>Type</th><th class="num">Published</th></tr></thead><tbody>${ex.types.map(t => html`<tr><td>${t.name} <span class="tiny muted">${t.slug}</span></td><td class="num">${t.total == null ? '?' : fmtInt(t.total)}</td></tr>`)}
      ${(ex.taxonomies || []).map(t => html`<tr><td class="muted">${t.name} (taxonomy, regenerated)</td><td class="num muted">${t.total == null ? '?' : fmtInt(t.total)}</td></tr>`)}</tbody></table></details>` : null}
    ${!compact && si.components.list?.length ? html`<details class="more" style="margin-top:6px"><summary class="small">Component patterns${si.components.site && multi ? ` (${si.components.site})` : ''}</summary>
      <div class="chips" style="margin-top:6px">${si.components.list.map(c => html`<${Badge} kind=${c.interactive ? 'accent' : ''} title=${`${c.pages} page${c.pages === 1 ? '' : 's'}`}>${c.type}${c.flags.length ? ` · ${c.flags.join(', ')}` : ''}<//>`)}</div>
      <div class="tiny muted" style="margin-top:4px">Same section type and shape counted once. An estimate to check against the brief.</div></details>` : null}
  </div>`;
}

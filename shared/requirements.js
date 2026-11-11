// Requirements from the brief: each one is traced to the deliverables that answer it, so the
// proposal can show the client their own words next to what is priced, and gaps stand out.
export const REQ_STATUSES = [
  { id: 'auto', label: 'From linked lines' },
  { id: 'excluded', label: 'Out of scope' },
  { id: 'discovery', label: 'Confirmed in discovery' },
];

export const newReqId = () => 'r_' + Math.random().toString(36).slice(2, 9);

export function cleanRequirement(r, itemIds) {
  return {
    id: r.id || newReqId(),
    text: String(r.text || '').trim().slice(0, 400),
    lines: [...new Set((r.lines || []).filter(id => itemIds.has(id)))],
    status: REQ_STATUSES.some(s => s.id === r.status) ? r.status : 'auto',
    note: String(r.note || '').trim().slice(0, 400),
    source: r.source || 'manual',
  };
}

// covered: a linked line is included. optional: only offered as an optional addition.
// uncovered: nothing priced answers it. excluded and discovery are explicit decisions.
export function requirementCoverage(quote, calc) {
  const state = Object.fromEntries((calc?.lines || []).map(l => [l.id, l.state]));
  const name = Object.fromEntries((quote.pricingSnapshot?.items || []).map(i => [i.id, i.name]));
  return (quote.requirements || []).filter(r => r?.text).map(r0 => {
    const r = { ...r0, lines: r0.lines || [] };
    const inc = r.lines.filter(id => state[id] === 'included');
    const opt = r.lines.filter(id => state[id] === 'optional');
    const coverage = r.status === 'excluded' ? 'excluded' : r.status === 'discovery' ? 'discovery' : inc.length ? 'covered' : opt.length ? 'optional' : 'uncovered';
    return { ...r, coverage, included: inc.map(id => name[id] || id), optional: opt.map(id => name[id] || id) };
  });
}

export const COVERAGE_LABEL = { covered: 'Included', optional: 'Optional addition', uncovered: 'Not covered', excluded: 'Out of scope', discovery: 'Confirmed in discovery' };

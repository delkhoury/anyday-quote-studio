// Quote assistant: the agent loop, its tools, attachments and undo, against a scripted Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fileBlocks, systemPrompt, TOOLS } from '../server/assistant.js';
import { startFixture } from './fixture-site.js';

process.env.SCANNER_ALLOW_PRIVATE_HOSTS = '127.0.0.1';

// A stand in for the Claude Messages API that plays a fixed script and checks every request.
function fakeClaude(script) {
  const requests = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(opts.headers['x-api-key'], 'sk-test'); assert.equal(opts.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(opts.body);
    requests.push(body);
    assert.equal(body.model, 'claude-test'); assert.ok(body.tools.length >= 10);
    // roles alternate, start with the user, and every tool_use is answered right after
    body.messages.forEach((m, k) => {
      assert.equal(m.role, k % 2 === 0 ? 'user' : 'assistant', `message ${k} role`);
      const uses = Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use') : [];
      if (uses.length && k + 1 < body.messages.length) {
        const ids = body.messages[k + 1].content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id);
        for (const u of uses) assert.ok(ids.includes(u.id), 'tool_use answered');
      }
    });
    const step = typeof script[i] === 'function' ? script[i](body) : script[i];
    i++;
    if (!step) return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Nothing left to do.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) };
    const content = step.tools ? [...(step.text ? [{ type: 'text', text: step.text }] : []), ...step.tools.map((t, n) => ({ type: 'tool_use', id: `tu_${i}_${n}`, name: t[0], input: t[1] }))] : [{ type: 'text', text: step.text }];
    return { ok: true, status: 200, json: async () => ({ content, stop_reason: step.tools ? 'tool_use' : 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } }) };
  };
  return { fetchImpl, requests };
}

async function waitJob(api, id) {
  for (let k = 0; k < 600; k++) { const j = (await api('GET', `/api/assistant/jobs/${id}`)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('job did not finish');
}

test('prompt and attachments: catalogue in the system prompt, PDF as a document, Word and text as text', async () => {
  const q = JSON.parse(fs.readFileSync(new URL('../seed/quotes/example-pytorch.json', import.meta.url)));
  const sys = systemPrompt(q, { foundations: [{ id: 'aaif', name: 'AAIF', owner: 'LF', components: [1, 2], complete: false, description: '' }] });
  assert.match(sys, /BASE_STD_COMPONENT \| Standard reusable component/); assert.match(sys, /- aaif: AAIF \(LF\)/);
  assert.ok(TOOLS.every(t => t.name && t.input_schema?.type === 'object'));
  const pdf = Buffer.from('%PDF-1.4 brief').toString('base64');
  const blocks = await fileBlocks([{ name: 'brief.pdf', type: 'application/pdf', data: pdf }, { name: 'notes.md', type: 'text/markdown', data: Buffer.from('# 600 clinics').toString('base64') }]);
  assert.equal(blocks[0].type, 'document'); assert.equal(blocks[0].source.media_type, 'application/pdf');
  assert.match(blocks[1].text, /600 clinics/);
  await assert.rejects(fileBlocks([{ name: 'x.exe', type: 'application/x-msdownload', data: 'AA==' }]), /use PDF, Word/);
});

test('assistant builds a quote end to end, applies changes directly, and a turn can be undone', async () => {
  const { server, base: site } = await startFixture();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ai-'));
  const script = [
    { tools: [['get_quote_state', {}]] },
    { text: 'Setting up the project.', tools: [['set_project_details', { client: 'Acme Health', parentOrg: 'Acme Group', project: 'Clinic network platform', url: site, type: 'new_platform' }]] },
    { tools: [['set_site_types', { siteTypes: [{ name: 'Clinic', count: 600, samples: [site] }, { name: 'Regional hub', count: 4, perSite: { L1: 3, L2: 10, L3: 20, RECORD: 40 } }] }]] },
    { tools: [['analyse_website', { url: site, siteType: 'Clinic', maxPages: 40 }]] },
    { tools: [['apply_inventory_quantities', {}]] },
    { tools: [['set_lines', { lines: [
      { id: 'BASE_CORE_PLATFORM', state: 'included', qty: 1, reason: 'Brief asks for one shared platform for every clinic', clientText: 'One shared platform, so all 600 clinics launch from the same build.' },
      { id: 'BASE_STD_COMPONENT', state: 'included', qty: 14, reason: 'Fourteen section types counted in the brief' },
      { id: 'BASE_SITE_SEARCH', state: 'optional', reason: 'Not requested; offered' },
      { id: 'BASE_FULL_COMMERCE', state: 'hidden' },
      { id: 'NOT_AN_ITEM', state: 'included', qty: 2 },
    ] }]] },
    { tools: [['set_requirements', { requirements: [{ text: 'One platform for every clinic', lines: ['BASE_CORE_PLATFORM'] }, { text: 'Site search', lines: ['BASE_SITE_SEARCH'] }, { text: 'Online booking through Zenoti', lines: [] }, { text: 'Photography', status: 'excluded', note: 'Client supplies photos' }] }]] },
    { tools: [['write_proposal', { intro: 'Acme Health needs one platform for 604 sites.', assumptions: ['Clinic page counts come from the reviewed sample site.'], exclusions: ['Photography.'] }], ['set_plan_hours', { rows: [{ id: 'BASE_STD_COMPONENT', perUnit: { dev: 6, design: 2 }, phase: 'Build' }] }]] },
    { tools: [['get_pricing_summary', {}]] },
    body => { const last = body.messages.at(-1).content[0]; assert.equal(last.type, 'tool_result'); const s = JSON.parse(last.content); assert.ok(s.total > 0); return { text: `Built the quote. Total ${s.total} USD. Open question: how many clinics have their own domain?` }; },
    // second turn
    { text: 'Raised it to 16 components.', tools: [['set_lines', { lines: [{ id: 'BASE_STD_COMPONENT', state: 'included', qty: 16, reason: 'Two more from the follow up' }] }]] },
    { text: 'Done.' },
  ];
  const { fetchImpl, requests } = fakeClaude(script);
  const app = createApp({ dataDir, scanOptions: { limits: { minDelayMs: 0, maxPagesInspect: 40 } }, assistant: { enabled: true, apiKey: 'sk-test', model: 'claude-test' }, assistantFetch: fetchImpl });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await api('GET', '/api/health')).body.assistant, true);
    const q0 = (await api('POST', '/api/quotes', { client: '' })).body;
    const brief = Buffer.from('%PDF-1.4 Acme Health brief: 600 clinic sites and 4 regional hubs').toString('base64');
    const job = (await api('POST', `/api/quotes/${q0.id}/assistant`, { text: 'Quote this brief', files: [{ name: 'acme-brief.pdf', type: 'application/pdf', data: brief }] })).body;
    assert.equal((await api('POST', `/api/quotes/${q0.id}/assistant`, { text: 'again' })).status, 409, 'one turn at a time per quote');
    const done = await waitJob(api, job.id);
    assert.equal(done.status, 'done', done.error || '');
    assert.match(done.text, /Open question/);
    assert.ok(done.steps.find(s => s.tool === 'analyse_website' && s.ok), 'website analysed');
    assert.ok(done.steps.find(s => s.tool === 'set_lines').ok, 'set_lines ran');
    // the scan result told Claude about the site: CMS, exact counts, integrations, languages
    const scanReply = requests.map(r => r.messages.at(-1).content?.[0]).find(b => b?.type === 'tool_result' && /"insights"/.test(b.content));
    const insights = JSON.parse(scanReply.content).insights;
    assert.match(insights.cms[0], /WordPress/); assert.equal(insights.exactCounts.media, 312);
    assert.ok(insights.integrations.some(x => /HubSpot/.test(x))); assert.equal(insights.languages.count, 2);
    const reqReply = requests.map(r => r.messages.at(-1).content?.[0]).find(b => b?.type === 'tool_result' && /uncovered/.test(b.content));
    assert.deepEqual(JSON.parse(reqReply.content).uncovered, ['Online booking through Zenoti']);
    // the first request carried the brief as a PDF document
    assert.equal(requests[0].messages[0].content[0].type, 'document');
    assert.match(requests[0].system[0].text, /Pricing Library catalogue/);
    const q = (await api('GET', `/api/quotes/${q0.id}`)).body;
    assert.equal(q.client.name, 'Acme Health'); assert.equal(q.client.parentOrg, 'Acme Group'); assert.equal(q.type, 'new_platform');
    assert.equal(q.siteGroups.length, 2); assert.equal(q.siteGroups[0].count, 600);
    assert.ok(q.inventory.entries.length > 20 && q.inventory.entries.every(e => e.groupId === q.siteGroups[0].id), 'scan merged into the Clinic site type');
    assert.equal(q.lines.MIG_SITE_ACTIVATION.qty, 604, 'site activation from site types');
    assert.equal(q.lines.BASE_STD_COMPONENT.qty, 14); assert.equal(q.lines.BASE_STD_COMPONENT.aiNote, 'Fourteen section types counted in the brief');
    assert.equal(q.lines.BASE_SITE_SEARCH.state, 'optional'); assert.equal(q.lines.BASE_FULL_COMMERCE.state, 'hidden');
    assert.equal(q.lines.NOT_AN_ITEM, undefined, 'unknown ids are rejected');
    assert.equal(q.lines.BASE_CORE_PLATFORM.clientNote, 'One shared platform, so all 600 clinics launch from the same build.');
    assert.equal(q.requirements.length, 4);
    const { requirementCoverage } = await import('../shared/requirements.js');
    const { calculateQuote } = await import('../shared/pricing.js');
    const { renderProposal } = await import('../shared/proposal.js');
    assert.deepEqual(requirementCoverage(q, calculateQuote(q)).map(r => r.coverage), ['covered', 'optional', 'uncovered', 'excluded']);
    const doc = renderProposal(q);
    assert.match(doc, /How this proposal answers the brief/); assert.match(doc, /One shared platform, so all 600 clinics/);
    assert.ok(!doc.includes('Online booking through Zenoti'), 'uncovered requirements stay out of the proposal');
    assert.equal(q.proposal.intro, 'Acme Health needs one platform for 604 sites.');
    assert.equal(q.plan.rows.BASE_STD_COMPONENT.effort.perUnit.dev, 6);
    assert.ok(q.history.some(h => h.kind === 'assistant'));
    // the unknown id came back to Claude as an error inside the tool result
    const setLinesResult = requests.find(r => r.messages.at(-1).content?.[0]?.type === 'tool_result' && /Unknown item NOT_AN_ITEM/.test(r.messages.at(-1).content[0].content));
    assert.ok(setLinesResult);
    // transcript
    const convo = (await api('GET', `/api/quotes/${q0.id}/assistant`)).body;
    assert.equal(convo.transcript.length, 2); assert.deepEqual(convo.transcript[0].files, ['acme-brief.pdf']); assert.ok(convo.canUndo);
    // second turn continues the same conversation
    const j2 = await waitJob(api, (await api('POST', `/api/quotes/${q0.id}/assistant`, { text: 'They added two more sections' })).body.id);
    assert.equal(j2.status, 'done');
    assert.equal((await api('GET', `/api/quotes/${q0.id}`)).body.lines.BASE_STD_COMPONENT.qty, 16);
    // undo the second turn, then the first
    let r = (await api('POST', `/api/quotes/${q0.id}/assistant/undo`)).body;
    assert.equal(r.lines.BASE_STD_COMPONENT.qty, 14);
    r = (await api('POST', `/api/quotes/${q0.id}/assistant/undo`)).body;
    assert.equal(r.client.name, ''); assert.equal(r.inventory.entries.length, 0, 'back to the empty quote');
    assert.equal((await api('POST', `/api/quotes/${q0.id}/assistant/undo`)).status, 400);
  } finally { srv.close(); server.close(); }
});

test('assistant explains missing key and API errors without breaking the conversation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ai2-'));
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? { ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) } : { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Hello again.' }], stop_reason: 'end_turn' }) }; };
  const app = createApp({ dataDir, assistant: { enabled: true, apiKey: 'sk-test', model: 'claude-test' }, assistantFetch: fetchImpl });
  const off = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ai3-')), assistant: { enabled: false } });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const srv2 = await new Promise(r => { const s = off.listen(0, '127.0.0.1', () => r(s)); });
  const call = (port, m, p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
  const P = srv.address().port; const P2 = srv2.address().port;
  try {
    const r0 = await call(P2, 'POST', '/api/quotes/example-pytorch/assistant', { text: 'hi' });
    assert.equal(r0.status, 400); assert.match(r0.body.error, /ANTHROPIC_API_KEY/);
    const j = (await call(P, 'POST', '/api/quotes/example-pytorch/assistant', { text: 'hi' })).body;
    let s; for (let k = 0; k < 50; k++) { s = (await call(P, 'GET', `/api/assistant/jobs/${j.id}`)).body; if (s.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(s.status, 'error'); assert.match(s.error, /refused the key/);
    const j2 = (await call(P, 'POST', '/api/quotes/example-pytorch/assistant', { text: 'hi again' })).body;
    for (let k = 0; k < 50; k++) { s = (await call(P, 'GET', `/api/assistant/jobs/${j2.id}`)).body; if (s.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(s.status, 'done'); assert.equal(s.text, 'Hello again.');
  } finally { srv.close(); srv2.close(); }
});

test('conversation repair: unanswered tool calls, merged roles and orphan results are fixed', async () => {
  const { repairMessages } = await import('../server/assistant.js');
  // the exact shape that broke: a tool request saved without its results, then more user turns
  const broken = [
    { role: 'user', content: [{ type: 'text', text: 'Build it' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'On it' }, { type: 'tool_use', id: 'a', name: 'set_lines', input: {} }, { type: 'tool_use', id: 'b', name: 'write_proposal', input: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'media qty is 0?' }] },
    { role: 'assistant', content: [{ type: 'text', text: '(Stopped: error)' }] },
    { role: 'user', content: [{ type: 'text', text: 'media qty is 0?' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'zzz', content: 'orphan' }, { type: 'text', text: 'again' }] },
  ];
  const fixed = repairMessages(broken);
  fixed.forEach((m, i) => assert.equal(m.role, i % 2 ? 'assistant' : 'user'));
  assert.deepEqual(fixed[2].content.slice(0, 2).map(b => b.tool_use_id), ['a', 'b'], 'missing results added first');
  assert.ok(fixed[2].content[0].is_error);
  assert.equal(fixed.at(-1).content.filter(b => b.type === 'tool_result').length, 0, 'orphan result removed');
  assert.equal(fixed.at(-1).content.length, 2, 'consecutive user messages merged');
  // thinking from earlier turns is dropped (its signature is bound to an older system prompt);
  // thinking inside the current turn is kept, as the API requires during tool use
  const withThinking = repairMessages([
    { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'old', signature: 's1' }, { type: 'text', text: 'Done.' }] },
    { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'now', signature: 's2' }, { type: 'tool_use', id: 't', name: 'get_quote_state', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{}' }] },
  ]);
  assert.deepEqual(withThinking[1].content.map(b => b.type), ['text']);
  assert.deepEqual(withThinking[3].content.map(b => b.type), ['thinking', 'tool_use']);
  const onlyThinking = repairMessages([{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }, { role: 'user', content: [{ type: 'text', text: 'b' }] }]);
  assert.equal(onlyThinking[1].content[0].type, 'text');
});

test('a reply cut off at the output limit is answered and the conversation keeps working', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ai4-'));
  const script = [
    { tools: [['set_lines', { lines: [{ id: 'BASE_STD_COMPONENT', state: 'included', qty: 3 }] }]], stop: 'max_tokens' },
    { tools: [['set_lines', { lines: [{ id: 'BASE_STD_COMPONENT', state: 'included', qty: 5, reason: 'retry' }] }]] },
    { text: 'Done in two steps.' },
    { text: 'Second turn works.' },
  ];
  let i = 0; const seen = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); seen.push(body);
    body.messages.forEach((m, k) => assert.equal(m.role, k % 2 ? 'assistant' : 'user'));
    for (let k = 0; k < body.messages.length; k++) {
      const uses = body.messages[k].content.filter?.(b => b.type === 'tool_use') || [];
      if (uses.length) { const ids = body.messages[k + 1].content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id); uses.forEach(u => assert.ok(ids.includes(u.id))); }
    }
    const st = script[i++] || { text: 'ok' };
    const content = st.tools ? st.tools.map((t, n) => ({ type: 'tool_use', id: `t${i}_${n}`, name: t[0], input: t[1] })) : [{ type: 'text', text: st.text }];
    return { ok: true, status: 200, json: async () => ({ content, stop_reason: st.stop || (st.tools ? 'tool_use' : 'end_turn') }) };
  };
  const app = createApp({ dataDir, assistant: { enabled: true, apiKey: 'sk-test', model: 'claude-test' }, assistantFetch: fetchImpl });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (m, p, b) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  const wait = async id => { for (let k = 0; k < 100; k++) { const j = await call('GET', `/api/assistant/jobs/${id}`); if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 50)); } };
  try {
    const j = await wait((await call('POST', '/api/quotes/example-pytorch/assistant', { text: 'add components' })).id);
    assert.equal(j.status, 'done'); assert.equal(j.text, 'Done in two steps.');
    assert.ok(j.steps.some(s => !s.ok && /cut off/.test(s.summary)));
    assert.equal((await call('GET', '/api/quotes/example-pytorch')).lines.BASE_STD_COMPONENT.qty, 5, 'the cut off call was not applied; the retry was');
    const j2 = await wait((await call('POST', '/api/quotes/example-pytorch/assistant', { text: 'and now?' })).id);
    assert.equal(j2.text, 'Second turn works.');
  } finally { srv.close(); }
});

test('media allowance is estimated from the scan when no CMS export is verified', async () => {
  const { proposeQuantities, mediaEstimate } = await import('../shared/inventory.js');
  const q = JSON.parse(fs.readFileSync(new URL('../seed/quotes/example-pytorch.json', import.meta.url)));
  delete q.lines.MIG_MEDIA;
  q.inventory.media = { discovered: { pagesInspected: 50, images: { unique: 180 }, documents: { unique: 20 } }, imageSitemap: { unique: 90 }, bySite: { 'pytorch.org': {} } };
  const row = proposeQuantities(q).rows.find(r => r.id === 'MIG_MEDIA');
  const urls = proposeQuantities(q).portfolio.migratableUrls;
  assert.equal(row.proposed, Math.round(4 * urls)); assert.equal(row.selected, true);
  assert.match(row.basis, /200 unique images and documents on 50 inspected pages/);
  q.inventory.media.verified = { total: 1234, migrateTotal: 1200, fileName: 'media.csv' };
  assert.equal(proposeQuantities(q).rows.find(r => r.id === 'MIG_MEDIA').proposed, 1200, 'a verified export wins');
  assert.equal(mediaEstimate({}, { migratableUrls: 10 }), null);
});

test('a rejected thinking signature is stripped and retried once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-ai5-'));
  const convo = { messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'bad' }, { type: 'text', text: 'Hello' }] },
  ], transcript: [], checkpoints: [] };
  fs.mkdirSync(path.join(dataDir, 'assistant'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'assistant', 'example-pytorch.json'), JSON.stringify(convo));
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    const hasThinking = body.messages.some(m => m.content.some?.(b => b.type === 'thinking'));
    assert.equal(hasThinking, false, 'thinking from an earlier turn is not sent');
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Works.' }], stop_reason: 'end_turn' }) };
  };
  const app = createApp({ dataDir, assistant: { enabled: true, apiKey: 'sk-test', model: 'claude-test' }, assistantFetch: fetchImpl });
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (m, p, b) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  try {
    const j0 = await call('POST', '/api/quotes/example-pytorch/assistant', { text: 'media?' });
    let j; for (let k = 0; k < 100; k++) { j = await call('GET', `/api/assistant/jobs/${j0.id}`); if (j.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(j.status, 'done'); assert.equal(j.text, 'Works.'); assert.equal(calls, 1);
  } finally { srv.close(); }
});

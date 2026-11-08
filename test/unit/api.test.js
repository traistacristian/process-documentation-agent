// API-level tests: capture pairing and ingestion, controls, RBAC, approval gates, publishing,
// conflict detection and retention. Uses the local repository in a temp directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { applyRetention } from '../../server/retention.js';
import { v1Events } from './helpers.js';

let srv; let base; let dir; let app; let cfg;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const call = async (method, p, body, user = 'admin', headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': user, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};
const waitDraft = async (id) => { for (let i = 0; i < 50; i++) { const d = (await call('GET', `/api/drafts/${id}`)).body; if (d.status !== 'generating') return d; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-api-'));
  cfg = loadConfig({ dataDir: dir, ai: { provider: 'rules' } });
  cfg.repository.local.path = path.join(dir, 'repository');
  app = createApp(cfg);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function recordAndGenerate(user = 'alex', extra = {}) {
  const s = (await call('POST', '/api/sessions', { mode: 'new', title: 'Grant helpdesk permissions', fileName: 'Grant helpdesk permissions', consent: true, ...extra }, user)).body;
  const pair = await call('POST', '/api/capture/pair', { code: s.pairing.code, client: { type: 'browser-extension' } }, null);
  assert.equal(pair.status, 200);
  const h = { authorization: `Bearer ${pair.body.captureToken}`, 'x-session-id': s.id };
  const shot = await call('POST', '/api/capture/screenshots', { data: PNG }, null, h);
  const events = v1Events().filter((e) => e.type !== 'start').map((e) => ({ ...e, seq: undefined, screenshotId: e.screenshotId ? shot.body.id : undefined, clientId: `c${e.seq}` }));
  const r = await call('POST', '/api/capture/events', { events }, null, h);
  assert.equal(r.body.accepted, events.length);
  return { s, h, events };
}

test('consent, the title and the name in SharePoint are required', async () => {
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', consent: true })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: 'x', consent: true, fileName: ' / ' })).status, 400, 'the name in SharePoint is mandatory');
});

test('capture: pairing, idempotent retries, pause drops events, stop revokes the capture token', async () => {
  const { s, h, events } = await recordAndGenerate();
  const again = await call('POST', '/api/capture/events', { events: events.slice(0, 3) }, null, h);
  assert.equal(again.body.accepted, 0, 'retried events with the same clientId are not duplicated');
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'pause' }, 'alex');
  const paused = await call('POST', '/api/capture/events', { events: [{ type: 'click', element: { name: 'Hidden' } }] }, null, h);
  assert.equal(paused.body.accepted, 0);
  assert.equal(paused.body.status, 'paused');
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'resume' }, 'alex');
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, 'alex');
  assert.equal((await call('POST', '/api/capture/events', { events: [] }, null, h)).status, 401);
  assert.equal((await call('GET', '/api/capture/state', null, null, { authorization: 'Bearer wrong', 'x-session-id': s.id })).status, 401);
  const view = (await call('GET', `/api/sessions/${s.id}`, null, 'sam')).body;
  assert.ok(!('captureTokenHash' in view));
  assert.equal((await call('GET', `/api/sessions/${s.id}`, null, 'admin')).status, 200);
});

test('full new-process workflow with approval gates, RBAC and publishing', async () => {
  const { s } = await recordAndGenerate();
  assert.equal((await call('POST', `/api/sessions/${s.id}/generate`, {}, 'alex')).status, 409, 'cannot generate while recording');
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, 'alex');
  const g = await call('POST', `/api/sessions/${s.id}/generate`, {}, 'alex');
  assert.equal(g.status, 202);
  let d = await waitDraft(g.body.id);
  assert.equal(d.status, 'draft');
  assert.equal(d.engine, 'rules');
  assert.ok(d.blockers.length);
  assert.equal((await call('POST', `/api/drafts/${d.id}/approve`, {}, 'alex')).status, 403, 'contributors cannot approve');
  assert.equal((await call('POST', `/api/drafts/${d.id}/approve`, {}, 'sam')).status, 422, 'open clarifications block approval');
  assert.equal((await call('GET', `/api/drafts/${d.id}`, null, 'admin')).status, 200);

  const purpose = d.clarifications.find((c) => c.section === 'purpose');
  d = (await call('PUT', `/api/drafts/${d.id}`, { clarifications: [{ id: purpose.id, status: 'answered', answer: 'Give helpdesk staff least-privilege admin rights.' }] }, 'alex')).body;
  assert.equal(d.doc.purpose, 'Give helpdesk staff least-privilege admin rights.');
  d = (await call('PUT', `/api/drafts/${d.id}`, { clarifications: d.clarifications.filter((c) => c.status === 'open').map((c) => ({ id: c.id, status: 'dismissed' })) }, 'alex')).body;
  assert.deepEqual(d.blockers, []);
  assert.equal((await call('POST', `/api/drafts/${d.id}/publish`, {}, 'sam')).status, 409, 'unapproved drafts cannot be published');
  const stale = await call('PUT', `/api/drafts/${d.id}`, { baseUpdatedAt: 1, doc: d.doc }, 'alex');
  assert.equal(stale.status, 409, 'concurrent edit detected');

  d = (await call('POST', `/api/drafts/${d.id}/approve`, { summary: 'First version' }, 'sam')).body;
  assert.equal(d.status, 'approved');
  assert.equal(d.approvedDoc.info.version, '1.0');
  assert.equal(d.approvedDoc.info.approver, 'Sam Rivera');
  d = (await call('POST', `/api/drafts/${d.id}/publish`, {}, 'sam')).body;
  assert.equal(d.status, 'published');
  assert.ok(fs.existsSync(path.join(d.published.location, 'document.docx')));
  assert.equal(fs.existsSync(path.join(dir, 'sessions', `${s.id}.events.jsonl`)), false, 'raw events purged after publishing');
  const list = (await call('GET', '/api/processes?q=helpdesk')).body;
  assert.equal(list.length, 1);
  const dups = (await call('GET', '/api/processes/duplicates?title=Grant%20helpdesk%20permission')).body;
  assert.equal(dups.length, 1, 'duplicate warning for a similar title');
  const dash = (await call('GET', '/api/dashboard')).body;
  assert.equal(dash.totals.processes, 1);
  const audit = (await call('GET', '/api/admin/audit')).body.map((a) => a.action);
  for (const a of ['session.started', 'capture.paired', 'draft.generated', 'draft.approved', 'draft.published']) assert.ok(audit.includes(a), a);
  assert.equal((await call('GET', '/api/admin/audit', null, 'sam')).status, 403);
});

test('update workflow detects a conflicting publish and never overwrites', async () => {
  const pid = (await call('GET', '/api/processes')).body[0].processId;
  const mk = async () => {
    const s = (await call('POST', '/api/sessions', { mode: 'update', processId: pid, consent: true }, 'sam')).body;
    await call('POST', `/api/sessions/${s.id}/notes`, { kind: 'mark', text: 'Verify the result' }, 'sam');
    await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, 'sam');
    const d = await waitDraft((await call('POST', `/api/sessions/${s.id}/generate`, {}, 'sam')).body.id);
    const decisions = Object.fromEntries([...d.comparison.changes.filter((c) => c.kind !== 'unchanged' && c.role !== 'destination'), ...d.comparison.sectionChanges].map((c) => [c.id, 'reject']));
    let x = (await call('PUT', `/api/drafts/${d.id}`, { decisions, clarifications: d.clarifications.map((c) => ({ id: c.id, status: 'dismissed' })) }, 'sam')).body;
    for (const st of x.doc.steps) st.warnings = [];
    x = (await call('PUT', `/api/drafts/${d.id}`, { doc: x.doc }, 'sam')).body;
    assert.deepEqual(x.blockers, []);
    return (await call('POST', `/api/drafts/${d.id}/approve`, {}, 'sam')).body;
  };
  const a = await mk(); const b = await mk();
  assert.equal(a.approvedDoc.info.version, '1.1');
  assert.equal(a.approvedDoc.steps.length, (await call('GET', `/api/processes/${pid}`)).body.doc.steps.length, 'all changes rejected: approved steps unchanged');
  assert.equal((await call('POST', `/api/drafts/${a.id}/publish`, {}, 'sam')).status, 200);
  const conflict = await call('POST', `/api/drafts/${b.id}/publish`, {}, 'sam');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CONFLICT');
  assert.equal((await call('GET', `/api/processes/${pid}`)).body.versions.length, 2);
});

test('separation of duties can be enforced', async () => {
  cfg.auth.requireSeparateApprover = true;
  const { s } = await recordAndGenerate('sam');
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, 'sam');
  let d = await waitDraft((await call('POST', `/api/sessions/${s.id}/generate`, {}, 'sam')).body.id);
  d = (await call('PUT', `/api/drafts/${d.id}`, { clarifications: d.clarifications.map((c) => ({ id: c.id, status: 'dismissed' })) }, 'sam')).body;
  assert.equal((await call('POST', `/api/drafts/${d.id}/approve`, {}, 'sam')).status, 403);
  assert.equal((await call('POST', `/api/drafts/${d.id}/approve`, {}, 'admin')).status, 200);
  cfg.auth.requireSeparateApprover = false;
});

test('retention stops abandoned recordings and purges old raw capture data', async () => {
  const { s } = await recordAndGenerate();
  const { store, audit } = app.locals;
  const later = Date.now() + 100 * 86400_000;
  const r = applyRetention({ cfg, store, audit, now: later });
  assert.ok(r.abandoned.includes(s.id));
  const r2 = applyRetention({ cfg, store, audit, now: later + 30 * 86400_000 });
  assert.ok(r2.purgedSessions.includes(s.id));
  assert.equal(store.readEvents(s.id).length, 0);
});

test('admin can change categories; non-admins cannot', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { categories: ['A'] }, 'sam')).status, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { categories: ['Microsoft 365', 'Security Operations'] })).status, 200);
  assert.deepEqual((await call('GET', '/api/config')).body.categories, ['Microsoft 365', 'Security Operations']);
});

test('drafts and recordings can be deleted one by one by their owner or an Admin', async () => {
  const { s } = await recordAndGenerate();
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`, null, 'alex')).status, 409, 'an active recording must be stopped first');
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, 'alex');
  const g = await call('POST', `/api/sessions/${s.id}/generate`, {}, 'alex');
  const d = await waitDraft(g.body.id);
  const shots = d.doc.steps.flatMap((st) => st.screenshotIds);
  assert.equal((await call('DELETE', `/api/drafts/${d.id}`, null, 'sam')).status, 403, 'an approver who did not create it cannot delete it');
  // Deleting the recording keeps the screenshots the draft still shows.
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`, null, 'alex')).status, 200);
  assert.equal((await call('GET', `/api/sessions/${s.id}`, null, 'alex')).status, 404);
  if (shots.length) assert.equal((await fetch(`${base}/api/drafts/${d.id}/screenshots/${shots[0]}`, { headers: { 'x-dev-user': 'alex' } })).status, 200);
  assert.equal((await call('DELETE', `/api/drafts/${d.id}`, null, 'alex')).status, 200);
  assert.equal((await call('GET', `/api/drafts/${d.id}`, null, 'alex')).status, 404);
  const log = (await call('GET', '/api/admin/audit', null, 'admin')).body.map((e) => e.action);
  assert.ok(log.includes('session.deleted') && log.includes('draft.deleted'));
});

test('the author describes each step during recording; the text lands in the document and can be changed', async () => {
  const { s } = await recordAndGenerate();
  const steps = (await call('GET', `/api/sessions/${s.id}/steps`, null, 'alex')).body;
  assert.equal(steps.length, 2);
  assert.match(steps[1].suggested, /Click "Save"/, 'an automatic description is proposed from what was recognised');
  assert.equal(steps[1].description, '');
  assert.equal((await call('PUT', `/api/sessions/${s.id}/step-descriptions`, { seq: steps[0].firstSeq, text: 'Find the user' }, 'sam')).status, 403, 'only the recorder describes steps');
  await call('PUT', `/api/sessions/${s.id}/step-descriptions`, { seq: steps[0].firstSeq, text: 'Find the user' }, 'alex');
  await call('PUT', `/api/sessions/${s.id}/step-descriptions`, { seq: steps[0].firstSeq, text: 'Find the user who asked for access' }, 'alex');
  await call('PUT', `/api/sessions/${s.id}/step-descriptions`, { seq: steps[1].firstSeq, text: 'Give the helpdesk role' }, 'alex');
  const again = (await call('GET', `/api/sessions/${s.id}/steps`, null, 'alex')).body;
  assert.deepEqual(again.map((x) => x.description), ['Find the user who asked for access', 'Give the helpdesk role']);
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, 'alex');
  const d = await waitDraft((await call('POST', `/api/sessions/${s.id}/generate`, {}, 'alex')).body.id);
  assert.deepEqual(d.doc.steps.map((x) => x.description), ['Find the user who asked for access', 'Give the helpdesk role']);
  assert.ok(d.doc.steps[0].instructions.length > 1, 'recorded instructions are kept');
});

test('with Claude configured, finished steps get an AI description that the author only corrects', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-ai-'));
  const c2 = loadConfig({ dataDir: d2, ai: { provider: 'anthropic' } });
  c2.repository.local.path = path.join(d2, 'repository');
  const calls = []; let protectedShots = 0;
  const { generateWithRules } = await import('../../server/engine/generate-rules.js');
  const a2 = createApp(c2, {
    describeStepWithClaude: async ({ step, screenshot }) => { calls.push({ step: step.number, hasShot: Boolean(screenshot) }); return `AI: step ${step.number}`; },
    generateWithClaude: (input) => generateWithRules(input),
    protectScreenshot: async () => { protectedShots++; return { count: 1, kinds: ['name'] }; },
  });
  const s2 = http.createServer(a2); await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const c = async (method, p, body, user = 'alex', headers = {}) => { const r = await fetch(b2 + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': user, ...headers }, body: body ? JSON.stringify(body) : undefined }); return r.headers.get('content-type')?.includes('json') ? r.json() : null; };
  try {
    const s = await c('POST', '/api/sessions', { mode: 'new', title: 'Grant helpdesk permissions', fileName: 'Helpdesk permissions', consent: true });
    const pair = await c('POST', '/api/capture/pair', { code: s.pairing.code, client: { type: 'browser-extension' } }, null);
    const h = { authorization: `Bearer ${pair.captureToken}`, 'x-session-id': s.id };
    const shot = await c('POST', '/api/capture/screenshots', { data: PNG }, null, h);
    await c('POST', '/api/capture/events', { events: v1Events().filter((e) => e.type !== 'start').map((e) => ({ ...e, seq: undefined, screenshotId: e.screenshotId ? shot.id : undefined, clientId: `c${e.seq}` })) }, null, h);
    let steps = await c('GET', `/api/sessions/${s.id}/steps`);
    assert.equal(steps[0].aiPending, true, 'a finished step is sent to the AI');
    assert.equal(steps[1].aiPending, false, 'the current step waits until it is finished');
    await new Promise((r) => setTimeout(r, 50));
    steps = await c('GET', `/api/sessions/${s.id}/steps`);
    assert.equal(steps[0].suggested, 'AI: step 1');
    assert.equal(steps[0].suggestedBy, 'ai');
    await c('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
    await c('GET', `/api/sessions/${s.id}/steps`);
    await new Promise((r) => setTimeout(r, 50));
    steps = await c('GET', `/api/sessions/${s.id}/steps`);
    assert.equal(steps[1].suggested, 'AI: step 2', 'after stop the last step is described too');
    assert.equal(calls.length, 2, 'each step is described once');
    assert.equal(protectedShots, 1, 'every screenshot is checked for personal data');
    await c('PUT', `/api/sessions/${s.id}/step-descriptions`, { seq: steps[1].firstSeq, text: 'Give the helpdesk role' });
    const gen = await c('POST', `/api/sessions/${s.id}/generate`, {});
    let d; for (let i = 0; i < 50; i++) { d = await c('GET', `/api/drafts/${gen.id}`); if (d.status !== 'generating') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.deepEqual(d.doc.steps.map((x) => x.description), ['AI: step 1', 'Give the helpdesk role'], 'the author correction wins over the AI text');
  } finally { s2.close(); fs.rmSync(d2, { recursive: true, force: true }); }
});

test('scripts need the AI and the Contributor role', async () => {
  assert.equal((await call('POST', '/api/processes/PRC-2026-000000/script', {}, 'alex')).status, 409);
});

test('flows need the AI too', async () => {
  assert.equal((await call('POST', '/api/processes/PRC-2026-000000/flow', {}, 'alex')).status, 409);
});

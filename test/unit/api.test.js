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
import { generateWithRules } from '../../server/engine/generate-rules.js';

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
  const s = (await call('POST', '/api/sessions', { mode: 'new', title: 'Grant helpdesk permissions', consent: true, ...extra }, user)).body;
  const pair = await call('POST', '/api/capture/pair', { code: s.pairing.code, client: { type: 'browser-extension' } }, null);
  assert.equal(pair.status, 200);
  const h = { authorization: `Bearer ${pair.body.captureToken}`, 'x-session-id': s.id };
  const shot = await call('POST', '/api/capture/screenshots', { data: PNG }, null, h);
  const events = v1Events().filter((e) => e.type !== 'start').map((e) => ({ ...e, seq: undefined, screenshotId: e.screenshotId ? shot.body.id : undefined, clientId: `c${e.seq}` }));
  const r = await call('POST', '/api/capture/events', { events }, null, h);
  assert.equal(r.body.accepted, events.length);
  return { s, h, events };
}

test('consent and a usable process name are required', async () => {
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', consent: true })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: ' / ', consent: true })).status, 400, 'the process name must be usable as a SharePoint name');
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

test('an admin can add sample processes once; they count towards the time-saved estimate', async () => {
  assert.equal((await call('POST', '/api/admin/samples', {}, 'sam')).status, 403);
  const before = (await call('GET', '/api/dashboard')).body.totals;
  const r = await call('POST', '/api/admin/samples', {});
  assert.equal(r.status, 200); assert.equal(r.body.added.length, 4);
  assert.equal((await call('POST', '/api/admin/samples', {})).body.added.length, 0);
  const after = (await call('GET', '/api/dashboard')).body.totals;
  assert.equal(after.processes, before.processes + 4);
  assert.ok(after.hoursSaved > before.hoursSaved);
  const one = (await call('GET', `/api/processes/${r.body.added[0].processId}`)).body;
  assert.equal(one.doc.info.category, 'Sample'); assert.ok(one.doc.steps.length >= 4);
});

test('testers: admin only, not available in the demo mode, group ids are validated', async () => {
  assert.equal((await call('GET', '/api/admin/testers', null, 'sam')).status, 403);
  const t = (await call('GET', '/api/admin/testers')).body;
  assert.equal(t.available, false); assert.deepEqual(t.people, []);
  assert.equal((await call('POST', '/api/admin/testers', { email: 'a@b.example', role: 'Contributor' })).status, 409);
  assert.equal((await call('PUT', '/api/admin/settings', { invitations: { groups: { Contributor: 'not-a-guid' } } })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { invitations: { groups: { Contributor: '11111111-1111-1111-1111-111111111111', Approver: '', Admin: '' } } })).status, 200);
  assert.equal((await call('GET', '/api/admin/testers')).body.groups.Contributor, '11111111-1111-1111-1111-111111111111');
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
    const s = await c('POST', '/api/sessions', { mode: 'new', title: 'Grant helpdesk permissions', consent: true });
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

test('meetings: audio and screenshots are recorded, transcribed and turned into suggestions the reviewer decides on', async () => {
  // Without Azure AI Speech the feature is off.
  const { s: s0 } = await recordAndGenerate();
  await call('POST', `/api/sessions/${s0.id}/control`, { action: 'stop' }, 'alex');
  const d0 = await waitDraft((await call('POST', `/api/sessions/${s0.id}/generate`, {}, 'alex')).body.id);
  assert.equal((await call('POST', `/api/drafts/${d0.id}/meetings`, { consent: true }, 'alex')).status, 409);
  assert.equal((await call('GET', '/api/config')).body.meetings, false);

  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-mtg-'));
  const c3 = loadConfig({ dataDir: d3, ai: { provider: 'rules' } }); c3.repository.local.path = path.join(d3, 'repository');
  let heardBytes = 0;
  const a3 = createApp(c3, {
    protectScreenshot: async () => ({ count: 0, kinds: [] }),
    transcribeAudio: async ({ path: p }) => { heardBytes = fs.statSync(p).size; return [{ ms: 5000, durationMs: 3000, speaker: 1, text: 'You need the User Administrator role for this.' }, { ms: 61000, durationMs: 4000, speaker: 2, text: 'Afterwards always check the audit log. And nobody knows how we remove licences from leavers.' }]; },
    findMeetingSuggestions: async ({ clarifications, transcript }) => {
      assert.equal(transcript.length, 2);
      const perm = clarifications.find((c) => c.section === 'prerequisites');
      return [
        { kind: 'answer', clarificationId: perm.id, stepNumber: null, title: null, text: 'User Administrator role', instructions: [], quote: 'You need the User Administrator role', atSeconds: 5 },
        { kind: 'step', clarificationId: null, stepNumber: 2, title: 'Check the audit log', text: 'Confirm the change in the audit log.', instructions: ['Open the audit log.', 'Search for the user.'], quote: 'Afterwards always check the audit log', atSeconds: 61 },
        { kind: 'topic', clarificationId: null, stepNumber: null, title: 'Remove licences from leavers', text: 'Nobody in the meeting knew the procedure.', instructions: [], quote: 'nobody knows how we remove licences', atSeconds: 64 },
      ];
    },
  });
  const s3 = http.createServer(a3); await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const c = async (method, p, body, user = 'alex', headers = {}) => { const r = await fetch(b3 + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': user, ...headers }, body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; };
  try {
    assert.equal((await c('GET', '/api/config')).body.meetings, true);
    const s = (await c('POST', '/api/sessions', { mode: 'new', title: 'Grant helpdesk permissions', consent: true })).body;
    const pair = (await c('POST', '/api/capture/pair', { code: s.pairing.code, client: { type: 'browser-extension' } }, null)).body;
    const h = { authorization: `Bearer ${pair.captureToken}`, 'x-session-id': s.id };
    await c('POST', '/api/capture/events', { events: v1Events().filter((e) => e.type !== 'start').map((e) => ({ ...e, seq: undefined, screenshotId: undefined, clientId: `c${e.seq}` })) }, null, h);
    await c('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
    const g = (await c('POST', `/api/sessions/${s.id}/generate`, {})).body;
    let d; for (let i = 0; i < 50; i++) { d = (await c('GET', `/api/drafts/${g.id}`)).body; if (d.status !== 'generating') break; await new Promise((r) => setTimeout(r, 50)); }
    const stepsBefore = d.doc.steps.length;

    assert.equal((await c('POST', `/api/drafts/${d.id}/meetings`, {})).status, 400, 'consent is required');
    const m = (await c('POST', `/api/drafts/${d.id}/meetings`, { consent: true })).body;
    assert.equal(m.status, 'recording');
    assert.equal((await c('POST', `/api/drafts/${d.id}/meetings`, { consent: true })).status, 409, 'one meeting at a time');
    await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/audio`, Buffer.from('chunk-1'), 'alex', { 'content-type': 'application/octet-stream' });
    await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/audio`, Buffer.from('chunk-2'), 'alex', { 'content-type': 'application/octet-stream' });
    const f1 = (await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/frames`, { data: PNG, atMs: 2000 })).body;
    const f2 = (await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/frames`, { data: PNG, atMs: 63000 })).body;
    assert.equal((await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/stop`)).body.status, 'transcribing');
    let mt; for (let i = 0; i < 50; i++) { d = (await c('GET', `/api/drafts/${d.id}`)).body; mt = d.meetings[0]; if (['done', 'failed'].includes(mt.status)) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(mt.status, 'done', mt.error);
    assert.equal(heardBytes, 14, 'both audio chunks were joined');
    assert.equal(mt.transcript, undefined, 'the transcript is not sent to the browser');
    assert.ok(!fs.existsSync(path.join(d3, 'meetings', `${m.id}.webm`)), 'audio is deleted after transcription');
    const [ans, step, topic] = mt.suggestions;
    assert.equal(step.screenshotId, f2.id, 'the screenshot closest to the moment is attached');
    assert.equal(ans.screenshotId, null); assert.equal(topic.screenshotId, null);
    assert.ok(f1.id);

    d = (await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/suggestions/${ans.id}`, { action: 'accept' })).body;
    assert.equal(d.clarifications.find((x) => x.id === ans.clarificationId).status, 'answered');
    assert.ok(d.doc.prerequisites.permissions.join(' ').includes('User Administrator'));
    d = (await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/suggestions/${step.id}`, { action: 'accept' })).body;
    assert.equal(d.doc.steps.length, stepsBefore + 1);
    assert.equal(d.doc.steps[2].title, 'Check the audit log'); assert.equal(d.doc.steps[2].number, 3);
    assert.deepEqual(d.doc.steps[2].screenshotIds, [f2.id]);
    d = (await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/suggestions/${topic.id}`, { action: 'reject' })).body;
    assert.deepEqual(d.meetings[0].suggestions.map((x) => x.status), ['accepted', 'accepted', 'rejected']);
    assert.equal((await c('POST', `/api/drafts/${d.id}/meetings/${m.id}/suggestions/${topic.id}`, { action: 'accept' })).status, 404, 'decided once');
    assert.equal((await c('GET', `/api/drafts/${d.id}/screenshots/${f2.id}`)).status, 200, 'meeting screenshots are served like recorded ones');
  } finally { s3.close(); fs.rmSync(d3, { recursive: true, force: true }); }
});

test('Teams: a meeting transcript is analysed and turned into an update draft and a new draft', async () => {
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-teams-'));
  const c4 = loadConfig({ dataDir: d4, ai: { provider: 'rules' } }); c4.repository.local.path = path.join(d4, 'repository');
  let seenLibrary = null; const tokens = [];
  const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:09.000\n<v Dana>When you reset a password, also check the sign-in log afterwards. The password is Secret123!\n\n00:01:10.000 --> 00:01:20.000\n<v Sam>For guest accounts we open Entra, External Identities, and resend the invitation.\n';
  const a4 = createApp(c4, {
    teamsGraph: {
      findMeeting: async (tok, q) => { tokens.push(tok); assert.ok(q.joinUrl || q.chatId); return { id: 'MSo-m1', subject: 'Service desk walkthrough', startDateTime: '2026-11-10T09:00:00Z' }; },
      transcripts: async () => [{ id: 't1', createdDateTime: '2026-11-10T10:00:00Z' }],
      content: async () => vtt,
    },
    planFromTranscript: async ({ library, transcript }) => {
      seenLibrary = library;
      const reset = library.find((p) => /password/i.test(p.title));
      assert.ok(!transcript.map((l) => l.text).join(' ').includes('Secret123!'), 'secrets are masked before the AI sees them');
      return { summary: 'Password resets and guest invitations.', items: [
        { action: 'update', processId: reset.processId, title: reset.title, reason: 'Adds a check of the sign-in log.', quote: 'also check the sign-in log', atSeconds: 5 },
        { action: 'new', processId: null, title: 'Resend a guest invitation', reason: 'The steps were explained.', quote: 'resend the invitation', atSeconds: 70 },
        { action: 'topic', processId: null, title: 'Remove guest accounts', reason: 'Nobody knew.', quote: '', atSeconds: 75 },
      ] };
    },
    findMeetingSuggestions: async ({ transcript }) => [{ kind: 'note', clarificationId: null, stepNumber: 5, title: null, text: 'Check the sign-in log after the reset.', instructions: [], quote: 'also check the sign-in log', atSeconds: transcript[0].ms / 1000 }],
  });
  const s4 = http.createServer(a4); await new Promise((r) => s4.listen(0, '127.0.0.1', r));
  const b4 = `http://127.0.0.1:${s4.address().port}`;
  const c = async (method, p, body, user = 'alex') => { const r = await fetch(b4 + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; };
  try {
    assert.equal((await c('GET', '/api/config')).body.teams, true);
    assert.ok((await c('POST', '/api/admin/samples', {}, 'admin')).status < 300);
    assert.equal((await c('GET', '/api/teams/meeting?joinUrl=https://evil.example/x')).status, 400);
    const m = (await c('GET', `/api/teams/meeting?joinUrl=${encodeURIComponent('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0')}`)).body;
    assert.equal(m.subject, 'Service desk walkthrough'); assert.equal(m.transcripts.length, 1);
    const imp = await c('POST', '/api/teams/imports', { meetingId: m.id, transcriptId: m.transcripts[0].id, subject: m.subject, startDateTime: m.startDateTime });
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    const x = imp.body;
    assert.equal(x.transcript, undefined, 'the transcript is not sent to the browser');
    assert.equal(x.transcriptLines, 2);
    assert.ok(seenLibrary.length >= 4);
    assert.equal(x.items.length, 3);
    assert.equal((await c('GET', `/api/teams/imports/${x.id}`, null, 'sam')).status, 404, 'only the importer sees it');

    // Update an existing document: a draft based on the published version, with the meeting's suggestions.
    let r = (await c('POST', `/api/teams/imports/${x.id}/items/1`, { action: 'draft' })).body;
    const upd = r.items[0].draftId; assert.ok(upd);
    let d; for (let i = 0; i < 50; i++) { d = (await c('GET', `/api/drafts/${upd}`)).body; if (d.meetings[0].status === 'done') break; await new Promise((res) => setTimeout(res, 50)); }
    assert.equal(d.mode, 'update'); assert.ok(d.baseRef.processId);
    assert.equal(d.meetings[0].source, 'teams'); assert.equal(d.meetings[0].suggestions.length, 1);
    d = (await c('POST', `/api/drafts/${upd}/meetings/${d.meetings[0].id}/suggestions/${d.meetings[0].suggestions[0].id}`, { action: 'accept' })).body;
    assert.ok(d.doc.steps[4].notes.includes('Check the sign-in log after the reset.'));
    assert.equal(d.pending.length, 0, 'accepting the suggestion is the decision');
    assert.ok(d.mergedDoc.steps[4].notes.includes('Check the sign-in log after the reset.'), 'the accepted note survives the merge with the published version');
    // Asking again returns the same draft.
    assert.equal((await c('POST', `/api/teams/imports/${x.id}/items/1`, { action: 'draft' })).body.items[0].draftId, upd);

    // New document: drafted from the transcript.
    r = (await c('POST', `/api/teams/imports/${x.id}/items/2`, { action: 'draft' })).body;
    let n; for (let i = 0; i < 50; i++) { n = (await c('GET', `/api/drafts/${r.items[1].draftId}`)).body; if (n.status !== 'generating') break; await new Promise((res) => setTimeout(res, 50)); }
    assert.equal(n.mode, 'new'); assert.equal(n.status, 'draft', n.error);
    assert.equal(n.doc.info.title, 'Resend a guest invitation');

    r = (await c('POST', `/api/teams/imports/${x.id}/items/3`, { action: 'dismiss' })).body;
    assert.equal(r.items[2].status, 'dismissed');
    assert.equal((await c('GET', '/api/teams/imports')).body.length, 1);
    assert.equal((await c('GET', '/api/admin/teams/package', null, 'alex')).status, 403);
    assert.equal((await c('DELETE', `/api/teams/imports/${x.id}`)).status, 200);
  } finally { s4.close(); fs.rmSync(d4, { recursive: true, force: true }); }
});

test('AI per category: nothing from a switched-off category reaches the AI', async () => {
  const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-aipol-'));
  const c5 = loadConfig({ dataDir: d5, ai: { provider: 'anthropic' } }); c5.repository.local.path = path.join(d5, 'repository');
  const used = { generate: 0, blur: 0, locate: 0, meeting: 0, plan: null };
  const a5 = createApp(c5, {
    generateWithClaude: async (input) => { used.generate++; const r = generateWithRules(input); return { ...r, engine: 'claude:test' }; },
    protectScreenshot: async () => { used.blur++; return { count: 0, kinds: [] }; },
    locateMarks: async () => { used.locate++; return []; },
    describeStepWithClaude: async () => 'x',
    translateDoc: async ({ doc }) => doc,
    transcribeAudio: async () => [],
    findMeetingSuggestions: async () => { used.meeting++; return []; },
    teamsGraph: { findMeeting: async () => ({ id: 'm', subject: 's' }), transcripts: async () => [{ id: 't' }], content: async () => 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>We reset the firewall rule.\n' },
    planFromTranscript: async ({ library }) => { used.plan = library; return { summary: '', items: [] }; },
  });
  const s5 = http.createServer(a5); await new Promise((r) => s5.listen(0, '127.0.0.1', r));
  const b5 = `http://127.0.0.1:${s5.address().port}`;
  const c = async (method, p, body, user = 'admin') => { const r = await fetch(b5 + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; };
  const record = async (category) => {
    const s = (await c('POST', '/api/sessions', { mode: 'new', title: `Change ${category}`, category, consent: true })).body;
    const pair = (await c('POST', '/api/capture/pair', { code: s.pairing.code, client: { type: 'browser-extension' } }, null)).body;
    const h = { authorization: `Bearer ${pair.captureToken}`, 'x-session-id': s.id, 'content-type': 'application/json' };
    const shot = await (await fetch(`${b5}/api/capture/screenshots`, { method: 'POST', headers: h, body: JSON.stringify({ data: PNG }) })).json();
    await fetch(`${b5}/api/capture/events`, { method: 'POST', headers: h, body: JSON.stringify({ events: v1Events().filter((e) => e.type !== 'start').map((e) => ({ ...e, seq: undefined, screenshotId: e.screenshotId ? shot.id : undefined, clientId: `c${e.seq}` })) }) });
    await c('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
    const g = (await c('POST', `/api/sessions/${s.id}/generate`, {})).body;
    let d; for (let i = 0; i < 80; i++) { d = (await c('GET', `/api/drafts/${g.id}`)).body; if (d.status !== 'generating') break; await new Promise((r) => setTimeout(r, 50)); }
    return d;
  };
  try {
    assert.equal((await c('PUT', '/api/admin/settings', { aiPolicy: { offCategories: 'Security' } })).status, 400);
    assert.equal((await c('PUT', '/api/admin/settings', { aiPolicy: { offCategories: ['Security', ' Security '] } })).status, 200);
    assert.deepEqual((await c('GET', '/api/admin/settings')).body.aiPolicy.offCategories, ['Security']);
    assert.deepEqual((await c('GET', '/api/config')).body.aiOffCategories, ['Security']);
    assert.equal((await c('PUT', '/api/admin/settings', { aiPolicy: { offCategories: ['Security'] } }, 'alex')).status, 403);

    const off = await record('Security');
    assert.equal(off.status, 'draft', off.error);
    assert.equal(off.engine, 'rules'); assert.equal(used.generate, 0); assert.equal(used.blur, 0); assert.equal(used.locate, 0);
    const st = off.doc.steps.find((x) => x.screenshotIds.length);
    assert.equal((await c('POST', `/api/drafts/${off.id}/locate-marks`, { shotId: st.screenshotIds[0], instructions: ['Click'] })).body.code, 'AI_OFF');
    assert.equal((await c('POST', `/api/drafts/${off.id}/meetings`, { consent: true })).body.code, 'AI_OFF');

    const on = await record('Identity & access');
    assert.equal(on.engine, 'claude:test'); assert.equal(used.generate, 1); assert.ok(used.blur >= 1);

    // Published documents of a switched-off category: a Teams meeting neither sends them to the AI nor updates them with it.
    await c('POST', '/api/admin/samples', {});
    await c('PUT', '/api/admin/settings', { aiPolicy: { offCategories: ['Security', 'Sample'] } });
    const sample = (await c('GET', '/api/processes')).body.find((p) => p.category === 'Sample');
    const imp = (await c('POST', '/api/teams/imports', { meetingId: 'm', transcriptId: 't' })).body;
    assert.ok(used.plan.every((p) => p.category !== 'Sample'), 'switched-off documents are not sent to the AI');
    assert.equal((await c('POST', `/api/processes/${sample.processId}/script`, {})).body.code, 'AI_OFF');
    assert.ok(imp.id);
    assert.equal(used.meeting, 0);
  } finally { s5.close(); fs.rmSync(d5, { recursive: true, force: true }); }
});

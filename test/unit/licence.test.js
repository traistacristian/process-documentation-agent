// Licence rules of the multi-tenant deployment: trial end and suspension make the app read-only,
// seats per month, and the monthly AI quota (drafting falls back to the rule-based engine).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../../server/config.js';
import { createSaaSApp } from '../../server/saas.js';
import { TenantRegistry } from '../../server/tenants.js';
import { evaluate, limits, trialDays, MAX_TRIAL_DAYS } from '../../server/licence.js';

const T = '66666666-6666-4666-8666-666666666666';
const API = 'aaaaaaaa-0000-4000-8000-000000000001';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const oid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tok = (n, roles = ['ProcessDoc.Admin']) => `t.${Buffer.from(JSON.stringify({ tid: T, oid: oid(n), name: `U${n}`, roles })).toString('base64url')}`;
const fakeVerify = async (t) => JSON.parse(Buffer.from(t.slice(2), 'base64url').toString());

let srv; let base; let dir; let registry; let aiDrafts = 0;
const call = async (method, p, body, token, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-lic-'));
  // An AI engine that is "configured" (fake generator), so the quota decides.
  const cfg = loadConfig({ dataDir: dir, multiTenant: true, ai: { provider: 'anthropic' }, auth: { mode: 'entra', entra: { apiClientId: API, spaClientId: 'spa' } } });
  process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
  registry = new TenantRegistry(dir);
  registry.upsert(T, { name: 'Lic', status: 'active', plan: 'team', seats: 2, aiGenerations: 1 });
  const generateWithClaude = async (input) => { aiDrafts++; const { generateWithRules } = await import('../../server/engine/generate-rules.js'); return { ...generateWithRules(input), engine: 'claude' }; };
  const app = createSaaSApp(cfg, { registry, verifyToken: fakeVerify, federated: {}, tenantDeps: () => ({ generateWithClaude, describeStepWithClaude: async () => '', protectScreenshot: async () => ({ count: 0 }) }) });
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function recordAndGenerate(n = 1) {
  const s = (await call('POST', '/api/sessions', { mode: 'new', title: `Process ${Math.random()}`, consent: true }, tok(n))).body;
  const pair = await call('POST', '/api/capture/pair', { code: s.pairing.code });
  const h = { authorization: `Bearer ${pair.body.captureToken}`, 'x-session-id': s.id };
  await call('POST', '/api/capture/events', { events: [{ type: 'click', ts: Date.now(), clientId: 'c1', url: 'https://portal.example/u', pageTitle: 'Users', element: { role: 'button', name: 'Save' } }] }, null, h);
  await call('POST', `/api/sessions/${s.id}/control`, { action: 'stop' }, tok(n));
  const g = await call('POST', `/api/sessions/${s.id}/generate`, {}, tok(n));
  assert.equal(g.status, 202);
  for (let i = 0; i < 100; i++) { const d = (await call('GET', `/api/drafts/${g.body.id}`, null, tok(n))).body; if (d.status !== 'generating') return { s, d, h }; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timeout');
}

test('rules: trials last at most 5 days and have 1 seat; plans give defaults, the record overrides them', () => {
  assert.equal(MAX_TRIAL_DAYS, 5);
  assert.equal(trialDays({ saas: { trialDays: 30 } }), 5);
  assert.equal(trialDays({ saas: { trialDays: 3 } }), 3);
  assert.equal(limits({}, { status: 'trial', plan: 'trial' }).seats, 1);
  assert.deepEqual(limits({}, { plan: 'team' }), { seats: 10, aiGenerations: 200 });
  assert.equal(limits({}, { plan: 'team', seats: 3 }).seats, 3);
  assert.equal(limits({}, { plan: 'team', seats: null }).seats, 10);
  assert.equal(evaluate({}, { status: 'trial', trialEndsAt: Date.now() - 1 }).reason, 'trial_ended');
  assert.equal(evaluate({}, { status: 'trial', trialEndsAt: Date.now() + 1000 }).readOnly, false);
  assert.equal(evaluate({}, { status: 'suspended' }).reason, 'suspended');
});

test('AI quota: over the monthly quota, documents are drafted by the rule-based engine', async () => {
  const first = await recordAndGenerate();
  assert.equal(first.d.engine, 'claude');
  assert.equal(aiDrafts, 1);
  const second = await recordAndGenerate();
  assert.equal(second.d.status === 'failed' ? 'failed' : second.d.engine, 'rules');
  assert.equal(aiDrafts, 1);
  const sub = (await call('GET', '/api/subscription', null, tok(1))).body;
  assert.equal(sub.aiUsed, 1); assert.equal(sub.aiGenerations, 1);
});

test('seats: a third person in the month is refused; people already counted keep access', async () => {
  assert.equal((await call('GET', '/api/me', null, tok(2, ['ProcessDoc.Contributor']))).status, 200);
  const third = await call('GET', '/api/me', null, tok(3, ['ProcessDoc.Contributor']));
  assert.equal(third.status, 402); assert.equal(third.body.code, 'SEAT_LIMIT');
  assert.equal((await call('GET', '/api/me', null, tok(1))).status, 200);
  assert.equal((await call('GET', '/api/subscription', null, tok(1))).body.seatsUsed, 2);
});

test('suspended or trial ended: read, download and delete work; recording, capture and changes do not', async () => {
  const { s, h } = await recordAndGenerate();
  const s2 = (await call('POST', '/api/sessions', { mode: 'new', title: 'Still recording', consent: true }, tok(1))).body;
  for (const patch of [{ status: 'suspended' }, { status: 'trial', trialEndsAt: Date.now() - 1000 }]) {
    registry.upsert(T, patch);
    const code = patch.status === 'suspended' ? 'SUBSCRIPTION_SUSPENDED' : 'TRIAL_ENDED';
    assert.equal((await call('GET', '/api/sessions', null, tok(1))).status, 200);
    assert.equal((await call('GET', '/api/config', null, tok(1))).body.tenant.licence.reason, patch.status === 'suspended' ? 'suspended' : 'trial_ended');
    const blocked = await call('POST', '/api/sessions', { mode: 'new', title: 'x', consent: true }, tok(1));
    assert.equal(blocked.status, 402); assert.equal(blocked.body.code, code);
    assert.equal((await call('POST', '/api/capture/pair', { code: s2.pairing.code })).status, 402);
    assert.equal((await call('POST', '/api/capture/events', { events: [] }, null, h)).status, 402);
    assert.equal((await call('GET', '/api/subscription', null, tok(1))).body.readOnly, true);
  }
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`, null, tok(1))).status, 200);
  registry.upsert(T, { status: 'active', trialEndsAt: null });
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: 'Back', consent: true }, tok(1))).status, 201);
});

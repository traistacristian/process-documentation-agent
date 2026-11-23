// Multi-tenant deployment: token validation for any tenant, the tenant registry, routing of capture
// clients, and isolation between two customer organisations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { loadConfig } from '../../server/config.js';
import { createSaaSApp } from '../../server/saas.js';
import { createEntraVerifier } from '../../server/auth.js';
import { TenantRegistry } from '../../server/tenants.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333'; // consented, never registered
const D = '44444444-4444-4444-8444-444444444444'; // subscription cancelled
const API = 'aaaaaaaa-0000-4000-8000-000000000001';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Test tokens: "<tenant>|<user>|<roles>". The real verifier is tested separately below.
const ROLE = { admin: ['ProcessDoc.Admin'], contributor: ['ProcessDoc.Contributor'] };
const tok = (tid, oid = 'admin', role = 'admin') => `${tid}|${oid}-${tid.slice(0, 4)}|${role}`;
const fakeVerify = async (t) => {
  const [tid, oid, role] = t.split('|');
  if (!tid || !oid) throw new Error('bad token');
  return { tid, oid, name: oid, preferred_username: `${oid}@example.com`, roles: ROLE[role] || [] };
};

let srv; let base; let dir; let app;
const call = async (method, p, body, token, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-saas-'));
  const cfg = loadConfig({ dataDir: dir, multiTenant: true, ai: { provider: 'rules' }, auth: { mode: 'entra', entra: { apiClientId: API, spaClientId: 'spa-client', apiScope: `api://${API}/access_as_user` } } });
  const registry = new TenantRegistry(dir);
  registry.upsert(A, { name: 'Alpha GmbH', status: 'active' });
  registry.upsert(B, { name: 'Beta SRL', status: 'trial' });
  registry.upsert(D, { name: 'Gone Ltd', status: 'cancelled' });
  app = createSaaSApp(cfg, { registry, verifyToken: fakeVerify });
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function record(tid, title = 'Reset a password') {
  const s = (await call('POST', '/api/sessions', { mode: 'new', title, consent: true }, tok(tid))).body;
  const pair = await call('POST', '/api/capture/pair', { code: s.pairing.code, client: { type: 'browser-extension' } });
  assert.equal(pair.status, 200);
  const h = { authorization: `Bearer ${pair.body.captureToken}`, 'x-session-id': s.id };
  const shot = await call('POST', '/api/capture/screenshots', { data: PNG }, null, h);
  assert.equal(shot.status, 200);
  const ev = await call('POST', '/api/capture/events', { events: [{ type: 'click', ts: Date.now(), clientId: 'c1', url: 'https://portal.example/users', pageTitle: 'Users', element: { role: 'button', name: 'Reset password' }, screenshotId: shot.body.id }] }, null, h);
  assert.equal(ev.status, 200);
  return { session: s, captureHeaders: h, shotId: shot.body.id };
}

test('sign-in: no token, unknown tenant and cancelled tenant are refused', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', null, 'garbage')).status, 401);
  const c = await call('GET', '/api/me', null, tok(C));
  assert.equal(c.status, 403); assert.equal(c.body.code, 'TENANT_NOT_ONBOARDED');
  const d = await call('GET', '/api/me', null, tok(D));
  assert.equal(d.status, 403); assert.equal(d.body.code, 'SUBSCRIPTION_ENDED');
  const a = await call('GET', '/api/me', null, tok(A));
  assert.equal(a.status, 200); assert.equal(a.body.tenantId, A); assert.deepEqual(a.body.roles, ['Admin']);
});

test('config: sign-in information before sign-in, the tenant settings after', async () => {
  const anon = (await call('GET', '/api/config')).body;
  assert.equal(anon.multiTenant, true);
  assert.equal(anon.entra.tenantId, 'organizations');
  assert.equal(anon.tenant, undefined);
  const a = (await call('GET', '/api/config', null, tok(A))).body;
  assert.equal(a.tenant.status, 'ready'); assert.equal(a.tenant.name, 'Alpha GmbH');
  assert.equal(a.entra.tenantId, 'organizations');
  assert.ok(Array.isArray(a.categories));
  assert.equal((await call('GET', '/api/config', null, tok(C))).body.tenant.status, 'not_onboarded');
  assert.equal((await call('GET', '/api/config', null, tok(D))).body.tenant.status, 'ended');
});

test('isolation: one tenant never sees or changes the other tenant\'s data', async () => {
  const { session, captureHeaders, shotId } = await record(A, 'Alpha secret process');
  // Tenant A sees its recording.
  const mine = await call('GET', '/api/sessions', null, tok(A));
  assert.ok(mine.body.some((s) => s.id === session.id));
  // Tenant B (even its Admin) does not: list, read, screenshot, delete, generate.
  assert.equal((await call('GET', '/api/sessions', null, tok(B))).body.length, 0);
  assert.equal((await call('GET', `/api/sessions/${session.id}`, null, tok(B))).status, 404);
  assert.equal((await call('GET', `/api/sessions/${session.id}/screenshots/${shotId}`, null, tok(B))).status, 404);
  assert.equal((await call('DELETE', `/api/sessions/${session.id}`, null, tok(B))).status, 404);
  assert.equal((await call('POST', `/api/sessions/${session.id}/generate`, {}, tok(B))).status, 404);
  // Audit logs are separate.
  const auditB = (await call('GET', '/api/admin/audit', null, tok(B))).body;
  assert.ok(!JSON.stringify(auditB).includes('Alpha secret process'));
  assert.ok(JSON.stringify((await call('GET', '/api/admin/audit', null, tok(A))).body).includes('Alpha secret process'));
  // On disk everything of A sits under A's folder, nothing under B's.
  const tenantsDir = path.join(dir, 'tenants');
  const filesOf = (t) => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : out.push(path.join(d, f.name)); }; walk(path.join(tenantsDir, t)); return out; };
  assert.ok(filesOf(A).some((f) => f.includes(session.id)));
  assert.ok(!filesOf(B).some((f) => fs.readFileSync(f, 'utf8').includes('Alpha secret process')));
  // A's capture token is only valid for A's session.
  const { session: sb } = await record(B, 'Beta process');
  const crossed = await call('POST', '/api/capture/events', { events: [{ type: 'click', ts: Date.now(), clientId: 'x1' }] }, null, { ...captureHeaders, 'x-session-id': sb.id });
  assert.equal(crossed.status, 401);
  // A session id that no tenant issued is refused before any tenant is involved.
  assert.equal((await call('GET', '/api/capture/state', null, null, { ...captureHeaders, 'x-session-id': 'ses_00000000deadbeef' })).status, 401);
});

test('settings are per tenant', async () => {
  const put = await call('PUT', '/api/admin/settings', { categories: ['Alpha only'] }, tok(A));
  assert.equal(put.status, 200);
  assert.deepEqual((await call('GET', '/api/config', null, tok(A))).body.categories, ['Alpha only']);
  assert.notDeepEqual((await call('GET', '/api/config', null, tok(B))).body.categories, ['Alpha only']);
});

test('roles still apply inside a tenant', async () => {
  const r = await call('GET', '/api/admin/settings', null, tok(A, 'alex', 'contributor'));
  assert.equal(r.status, 403);
});

test('a cancelled subscription stops capture clients too', async () => {
  const registry = app.locals.registry;
  const { session, captureHeaders } = await record(B, 'Will be cancelled');
  registry.upsert(B, { status: 'cancelled' });
  try {
    assert.equal((await call('GET', '/api/capture/state', null, null, captureHeaders)).status, 401);
    assert.equal((await call('GET', '/api/sessions', null, tok(B))).status, 403);
    assert.equal((await call('POST', '/api/capture/pair', { code: session.pairing.code })).status, 404);
  } finally { registry.upsert(B, { status: 'trial' }); }
});

test('testers / guest invitations are not offered in the multi-tenant deployment', async () => {
  const r = await call('GET', '/api/admin/testers', null, tok(A));
  assert.equal(r.status === 200 ? r.body.available : false, false);
});

test('pairing: wrong codes are limited per client address', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('POST', '/api/capture/pair', { code: '000000' });
  assert.equal(last.status, 429);
});

test('registry: ids are validated and normalised, pairing codes are unique', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-reg-'));
  try {
    const r = new TenantRegistry(d);
    assert.throws(() => r.upsert('not-a-guid'), /GUID/);
    assert.throws(() => r.upsert(A, { status: 'free' }), /Status/);
    r.upsert(A.toUpperCase(), { name: 'X' });
    assert.equal(r.get(A).name, 'X');
    const codes = new Set();
    for (let i = 0; i < 300; i++) codes.add(r.issuePairingCode(i % 2 ? A : A, `ses_${String(i).padStart(16, '0')}`, Date.now() + 60_000));
    assert.equal(codes.size, 300);
    assert.equal(new TenantRegistry(d).tenantForSession('ses_0000000000000007'), A);
    assert.equal(r.tenantForCode('123'), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('token verifier: any tenant, but the issuer must be the token\'s own tenant', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const verify = createEntraVerifier({ apiClientId: API, jwks: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const ok = await verify(await sign({ tid: A, oid: 'u1', aud: API, iss: `https://login.microsoftonline.com/${A}/v2.0`, roles: ['ProcessDoc.Admin'] }));
  assert.equal(ok.tid, A);
  await assert.rejects(verify(await sign({ tid: A, oid: 'u1', aud: API, iss: `https://login.microsoftonline.com/${B}/v2.0` })), /issuer/);
  await assert.rejects(verify(await sign({ oid: 'u1', aud: API, iss: 'https://login.microsoftonline.com/common/v2.0' })), /tenant/);
  await assert.rejects(verify(await sign({ tid: A, oid: 'u1', aud: 'someone-else', iss: `https://login.microsoftonline.com/${A}/v2.0` })), /not for this API/);
  // Single-organisation mode keeps rejecting every other tenant.
  const single = createEntraVerifier({ tenantId: A, apiClientId: API, jwks: createLocalJWKSet({ keys: [jwk] }) });
  await assert.rejects(single(await sign({ tid: B, oid: 'u1', aud: API, iss: `https://login.microsoftonline.com/${B}/v2.0` })));
});

// Multi-tenant onboarding: admin consent redirects, sign-up by a directory administrator, roles from
// the tenant record, and connecting a customer's SharePoint site (Graph mocked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../../server/config.js';
import { createSaaSApp } from '../../server/saas.js';
import { TenantRegistry } from '../../server/tenants.js';
import { createSharePointConnector } from '../../server/onboarding.js';

const A = '11111111-1111-4111-8111-111111111111';
const N = '55555555-5555-4555-8555-555555555555'; // new customer
const API = 'aaaaaaaa-0000-4000-8000-000000000001';
const SPA = 'bbbbbbbb-0000-4000-8000-000000000002';
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const oid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Test tokens: JSON claims. The real verifier is tested in saas.test.js.
const tok = (claims) => `t.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
const fakeVerify = async (t) => JSON.parse(Buffer.from(t.slice(2), 'base64url').toString());
const user = (tid, n, extra = {}) => tok({ tid, oid: oid(n), name: `User ${n}`, preferred_username: `u${n}@customer.example`, roles: [], ...extra });

let srv; let base; let dir; let app; let connectCalls = [];
const call = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, location: r.headers.get('location'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-onb-'));
  const cfg = loadConfig({ dataDir: dir, multiTenant: true, publicUrl: 'https://doku.example', ai: { provider: 'rules' }, auth: { mode: 'entra', entra: { apiClientId: API, spaClientId: SPA } } });
  const registry = new TenantRegistry(dir);
  registry.upsert(A, { name: 'Alpha', status: 'active', admins: [oid(1)], defaultRole: 'Contributor' });
  const sharepointConnector = { connect: async (x) => { connectCalls.push(x); return { repository: { mode: 'sharepoint', connectedAt: 1, sharepoint: { auth: 'federated', siteUrl: x.siteUrl, libraryName: x.libraryName, rootFolder: x.rootFolder } }, site: { id: 's1', name: 'IT Ops' } }; } };
  app = createSaaSApp(cfg, { registry, verifyToken: fakeVerify, sharepointConnector, federated: {} });
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('admin consent: API app first, then the web app, then back to setup', async () => {
  const r1 = await call('GET', '/api/onboarding/consent');
  assert.equal(r1.status, 302);
  const u1 = new URL(r1.location);
  assert.equal(u1.origin + u1.pathname, 'https://login.microsoftonline.com/organizations/adminconsent');
  assert.equal(u1.searchParams.get('client_id'), API);
  assert.equal(u1.searchParams.get('redirect_uri'), 'https://doku.example/api/onboarding/consent-callback');
  const r2 = await call('GET', `/api/onboarding/consent-callback?admin_consent=True&tenant=${N}&state=api`);
  assert.equal(new URL(r2.location).searchParams.get('client_id'), SPA);
  assert.equal((await call('GET', `/api/onboarding/consent-callback?admin_consent=True&tenant=${N}&state=spa`)).location, '/#/setup');
  assert.match((await call('GET', '/api/onboarding/consent-callback?error=access_denied&state=api')).location, /#\/signup\?consent_error=access_denied/);
});

test('sign-up: only a directory administrator starts the trial: 5 days, 1 seat, only that admin', async () => {
  const cfgBefore = (await call('GET', '/api/config', null, user(N, 9))).body;
  assert.equal(cfgBefore.tenant.status, 'not_onboarded');
  assert.equal(cfgBefore.tenant.canSignUp, false);
  const denied = await call('POST', '/api/onboarding/start', { name: 'New Co' }, user(N, 9));
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'NOT_DIRECTORY_ADMIN');

  const adminTok = user(N, 2, { wids: [GLOBAL_ADMIN] });
  assert.equal((await call('GET', '/api/config', null, adminTok)).body.tenant.canSignUp, true);
  const started = await call('POST', '/api/onboarding/start', { name: 'New Co' }, adminTok);
  assert.equal(started.status, 201);
  assert.equal(started.body.status, 'trial'); assert.equal(started.body.name, 'New Co');
  const days = (started.body.trialEndsAt - Date.now()) / 86400_000;
  assert.ok(days > 4.9 && days <= 5, `trial lasts ${days} days`);
  assert.deepEqual(started.body.admins, [oid(2)]);
  assert.equal(started.body.defaultRole, '');
  // Again: no second record, same tenant.
  assert.equal((await call('POST', '/api/onboarding/start', { name: 'Other' }, adminTok)).body.name, 'New Co');

  assert.deepEqual((await call('GET', '/api/me', null, adminTok)).body.roles, ['Admin']);
  const cfg = (await call('GET', '/api/config', null, adminTok)).body;
  assert.equal(cfg.tenant.status, 'ready'); assert.equal(cfg.tenant.subscription, 'trial'); assert.equal(cfg.tenant.sharepoint, false);
  assert.equal(cfg.tenant.licence.readOnly, false);
  // The one seat is the admin's: a colleague is refused, even with an Entra app role.
  assert.equal((await call('GET', '/api/config', null, user(N, 9))).body.tenant.status, 'no_seat');
  const other = await call('GET', '/api/me', null, user(N, 9, { roles: ['ProcessDoc.Contributor'] }));
  assert.equal(other.status, 402); assert.equal(other.body.code, 'SEAT_LIMIT');
  const sub = (await call('GET', '/api/subscription', null, adminTok)).body;
  assert.equal(sub.plan, 'trial'); assert.equal(sub.seats, 1); assert.equal(sub.seatsUsed, 1);
});

test('setup: default role and admins are changed by Admins only', async () => {
  assert.equal((await call('GET', '/api/onboarding', null, user(A, 5))).status, 403);
  const r = await call('PUT', '/api/onboarding', { defaultRole: '' }, user(A, 1));
  assert.equal(r.status, 200); assert.equal(r.body.defaultRole, '');
  // Without a default role and without an Entra app role, nobody else may do anything.
  assert.deepEqual((await call('GET', '/api/me', null, user(A, 5))).body.roles, []);
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: 'x', consent: true }, user(A, 5))).status, 403);
  // An Entra app role still applies.
  assert.deepEqual((await call('GET', '/api/me', null, user(A, 5, { roles: ['ProcessDoc.Approver'] }))).body.roles, ['Approver']);
  assert.equal((await call('PUT', '/api/onboarding', { defaultRole: 'Admin' }, user(A, 1))).status, 400);
  assert.equal((await call('PUT', '/api/onboarding', { admins: [] }, user(A, 1))).status, 400);
  await call('PUT', '/api/onboarding', { defaultRole: 'Contributor', admins: [oid(1), oid(6)] }, user(A, 1));
  assert.deepEqual((await call('GET', '/api/me', null, user(A, 6))).body.roles, ['Admin']);
});

test('setup: SharePoint site is validated and stored on the tenant', async () => {
  assert.equal((await call('POST', '/api/onboarding/sharepoint', { siteUrl: 'https://evil.example/sites/x' }, user(A, 1))).status, 400);
  assert.equal((await call('POST', '/api/onboarding/sharepoint', { siteUrl: 'not a url' }, user(A, 1))).status, 400);
  assert.equal((await call('POST', '/api/onboarding/sharepoint', { siteUrl: 'https://alpha.sharepoint.com/sites/ITOps' }, user(A, 5))).status, 403);
  const r = await call('POST', '/api/onboarding/sharepoint', { siteUrl: 'https://alpha.sharepoint.com/sites/ITOps/', libraryName: 'Docs' }, user(A, 1));
  assert.equal(r.status, 200);
  const c = connectCalls.at(-1);
  assert.equal(c.tenantId, A); assert.equal(c.siteUrl, 'https://alpha.sharepoint.com/sites/ITOps/'); assert.equal(c.libraryName, 'Docs'); assert.equal(c.rootFolder, 'IT Process Documentation');
  assert.ok(c.userToken.startsWith('t.'));
  assert.equal(r.body.sharepoint.siteUrl, 'https://alpha.sharepoint.com/sites/ITOps/');
  assert.equal(app.locals.registry.get(A).repository.sharepoint.libraryName, 'Docs');
});

test('SharePoint connector: grants write on the one site on behalf of the admin, then provisions it app-only', async () => {
  const calls = [];
  const json = (status, body) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
  const fetchImpl = async (url, opts = {}) => {
    const m = opts.method || 'GET'; const auth = opts.headers?.authorization; const p = String(url).replace('https://graph.microsoft.com/v1.0', '');
    calls.push({ m, p, auth, body: opts.body });
    if (p.startsWith('/sites/alpha.sharepoint.com:/sites/ITOps')) return json(200, { id: 'site1', webUrl: 'https://alpha.sharepoint.com/sites/ITOps', displayName: 'IT Ops' });
    if (p === '/sites/site1/permissions' && m === 'GET') return json(200, { value: [] });
    if (p === '/sites/site1/permissions' && m === 'POST') return json(201, { id: 'perm1' });
    if (p.startsWith('/sites/site1/drives')) return json(200, { value: [{ id: 'd1', name: 'Documents', webUrl: 'https://alpha.sharepoint.com/sites/ITOps/Shared Documents' }] });
    if (p.startsWith('/drives/d1/list')) return json(200, { id: 'l1' });
    if (p.startsWith('/sites/site1/lists/l1/columns') && m === 'GET') return json(200, { value: [] });
    if (m === 'POST') return json(201, {});
    if (p.startsWith('/drives/d1/root:')) return json(404, { error: { code: 'itemNotFound', message: 'nf' } });
    return json(404, { error: { message: `unexpected ${m} ${p}` } });
  };
  const federated = {
    onBehalfOf: async (tid, userToken, scopes) => { assert.equal(tid, A); assert.equal(userToken, 'admin-token'); assert.deepEqual(scopes, ['https://graph.microsoft.com/Sites.FullControl.All']); return { token: 'obo', exp: Date.now() + 3600_000 }; },
    appToken: async (tid) => { assert.equal(tid, A); return { token: 'app', exp: Date.now() + 3600_000 }; },
  };
  const cfg = { auth: { entra: { apiClientId: API } }, saas: { appName: 'Doku' } };
  const out = await createSharePointConnector({ cfg, federated, fetchImpl, sleep: async () => {} }).connect({ tenantId: A, userToken: 'admin-token', siteUrl: 'https://alpha.sharepoint.com/sites/ITOps', libraryName: 'Documents', rootFolder: 'IT Process Documentation', categories: ['Network'] });
  const grant = calls.find((c) => c.m === 'POST' && c.p === '/sites/site1/permissions');
  assert.equal(grant.auth, 'Bearer obo');
  assert.deepEqual(JSON.parse(grant.body), { roles: ['write'], grantedToIdentities: [{ application: { id: API, displayName: 'Doku' } }] });
  // Everything after the grant runs with the app's own token, as the app will afterwards.
  const after = calls.slice(calls.indexOf(grant) + 1);
  assert.ok(after.length > 3 && after.every((c) => c.auth === 'Bearer app'));
  assert.ok(after.some((c) => c.m === 'POST' && c.p === '/drives/d1/root/children'));
  assert.equal(out.repository.mode, 'sharepoint');
  assert.equal(out.repository.sharepoint.auth, 'federated');
  assert.equal(out.repository.sharepoint.tenantId, A);
});

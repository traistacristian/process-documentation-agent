// Microsoft Marketplace SaaS offer: landing page (resolve, activate), webhook events, and the
// webhook's token check. The Fulfillment API is replaced by a fake with the same answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { loadConfig } from '../../server/config.js';
import { createSaaSApp } from '../../server/saas.js';
import { TenantRegistry } from '../../server/tenants.js';
import { createWebhookVerifier, MARKETPLACE_RESOURCE, createMarketplaceClient } from '../../server/marketplace.js';

const CUST = '77777777-7777-4777-8777-777777777777';
const MSP = '88888888-8888-4888-8888-888888888888';
const TRIAL = '99999999-9999-4999-8999-999999999999';
const PUB = 'abababab-abab-4bab-8bab-abababababab';
const API = 'aaaaaaaa-0000-4000-8000-000000000001';
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const oid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tok = (tid, n, extra = {}) => `t.${Buffer.from(JSON.stringify({ tid, oid: oid(n), name: `U${n}`, preferred_username: `u${n}@x.example`, ...extra })).toString('base64url')}`;
const fakeVerify = async (t) => { if (!t.startsWith('t.')) throw new Error('bad'); return JSON.parse(Buffer.from(t.slice(2), 'base64url').toString()); };

// Fake Fulfillment API.
const subs = {
  'tok-own': { id: 'sub-1', subscriptionName: 'Doku for Customer', offerId: 'doku', planId: 'team', quantity: 5, subscription: { saasSubscriptionStatus: 'PendingFulfillmentStart', beneficiary: { tenantId: CUST }, purchaser: { tenantId: CUST } } },
  'tok-csp': { id: 'sub-2', subscriptionName: 'Doku via partner', offerId: 'doku', planId: 'business', quantity: 20, subscription: { beneficiary: { tenantId: MSP.replace('8888', '1212') }, purchaser: { tenantId: MSP } } },
  'tok-trial': { id: 'sub-3', subscriptionName: 'Doku', offerId: 'doku', planId: 'team', quantity: 3, subscription: { beneficiary: { tenantId: TRIAL }, purchaser: { tenantId: TRIAL } } },
};
const ops = {};
const calls = [];
const marketplace = {
  resolve: async (t) => { calls.push(['resolve', t]); if (!subs[t]) throw Object.assign(new Error('Microsoft Marketplace: invalid token'), { status: 400 }); return subs[t]; },
  activate: async (id, planId, quantity) => { calls.push(['activate', id, planId, quantity]); return null; },
  operation: async (id, opId) => ops[opId],
  ackOperation: async (id, opId, status) => { calls.push(['ack', id, opId, status]); return null; },
};

let srv; let base; let dir; let registry;
const call = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};
const hook = (body, token = 'hook-ok') => call('POST', '/api/marketplace/webhook', body, token);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-mp-'));
  const cfg = loadConfig({ dataDir: dir, multiTenant: true, ai: { provider: 'rules' }, auth: { mode: 'entra', entra: { apiClientId: API, spaClientId: 'spa' } } });
  registry = new TenantRegistry(dir);
  registry.upsert(TRIAL, { name: 'Trial Co', status: 'trial', plan: 'trial', trialEndsAt: Date.now() + 86400_000, admins: [oid(30)], defaultRole: '' });
  const app = createSaaSApp(cfg, {
    registry, verifyToken: fakeVerify, verifyLandingToken: fakeVerify, federated: {}, marketplace, platformLog: () => {},
    verifyWebhookToken: async (t) => { if (t !== 'hook-ok') throw new Error('bad'); return {}; },
  });
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('landing page: sign-in required; resolve shows the plan and whose organisation it is for', async () => {
  assert.equal((await call('POST', '/api/marketplace/resolve', { token: 'tok-own' })).status, 401);
  assert.equal((await call('POST', '/api/marketplace/resolve', {}, tok(CUST, 1))).status, 400);
  assert.equal((await call('POST', '/api/marketplace/resolve', { token: 'nope' }, tok(CUST, 1))).status, 400);
  const r = await call('POST', '/api/marketplace/resolve', { token: 'tok-own' }, tok(CUST, 1));
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'team'); assert.equal(r.body.quantity, 5); assert.equal(r.body.forOwnOrganisation, true); assert.equal(r.body.alreadyActive, false);
});

test('activate by the organisation\'s own administrator: tenant active with plan and seats, buyer is Admin', async () => {
  const r = await call('POST', '/api/marketplace/activate', { token: 'tok-own' }, tok(CUST, 1, { wids: [GLOBAL_ADMIN] }));
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c[0] === 'activate'), ['activate', 'sub-1', 'team', 5]);
  const t = registry.get(CUST);
  assert.equal(t.status, 'active'); assert.equal(t.plan, 'team'); assert.equal(t.seats, 5);
  assert.deepEqual(t.admins, [oid(1)]); assert.equal(t.defaultRole, 'Contributor');
  assert.equal(t.marketplace.subscriptionId, 'sub-1');
  assert.deepEqual((await call('GET', '/api/me', null, tok(CUST, 1))).body.roles, ['Admin']);
  assert.equal((await call('POST', '/api/marketplace/resolve', { token: 'tok-own' }, tok(CUST, 1))).body.alreadyActive, true);
});

test('a trial becomes a paid subscription: no end date, seats from the purchase, colleagues get access', async () => {
  await call('POST', '/api/marketplace/activate', { token: 'tok-trial' }, tok(TRIAL, 30, { wids: [GLOBAL_ADMIN] }));
  const t = registry.get(TRIAL);
  assert.equal(t.status, 'active'); assert.equal(t.trialEndsAt, null); assert.equal(t.seats, 3); assert.equal(t.defaultRole, 'Contributor');
  assert.deepEqual((await call('GET', '/api/me', null, tok(TRIAL, 31))).body.roles, ['Contributor']);
});

test('a partner (CSP) buys for a customer: the partner gets no access; the customer\'s directory admin claims it', async () => {
  const cust = subs['tok-csp'].subscription.beneficiary.tenantId;
  const r = await call('POST', '/api/marketplace/activate', { token: 'tok-csp' }, tok(MSP, 40, { wids: [GLOBAL_ADMIN] }));
  assert.equal(r.status, 200); assert.equal(r.body.forOwnOrganisation, false);
  assert.deepEqual(registry.get(cust).admins, []);
  assert.equal((await call('GET', '/api/me', null, tok(MSP, 40))).status, 403);
  assert.equal((await call('GET', '/api/config', null, tok(cust, 41))).body.tenant.noAdmins, true);
  // A normal user of the customer cannot claim; a directory administrator can.
  await call('POST', '/api/onboarding/start', {}, tok(cust, 41));
  assert.deepEqual(registry.get(cust).admins, []);
  await call('POST', '/api/onboarding/start', {}, tok(cust, 42, { wids: [GLOBAL_ADMIN] }));
  assert.deepEqual(registry.get(cust).admins, [oid(42)]);
});

test('webhook: token required, events checked against the API, then applied and acknowledged', async () => {
  assert.equal((await hook({ id: 'op1', subscriptionId: 'sub-1', action: 'Suspend' }, 'forged')).status, 401);
  ops.op1 = { id: 'op1', subscriptionId: 'sub-1', action: 'ChangeQuantity', quantity: 12 };
  assert.equal((await hook({ id: 'op1', subscriptionId: 'sub-1', action: 'Suspend' })).status, 400); // body does not match the API
  assert.equal((await hook({ id: 'op1', subscriptionId: 'sub-1', action: 'ChangeQuantity', quantity: 999 })).status, 200);
  assert.equal(registry.get(CUST).seats, 12); // from the API, not from the body
  assert.deepEqual(calls.at(-1), ['ack', 'sub-1', 'op1', 'Success']);

  ops.op2 = { id: 'op2', subscriptionId: 'sub-1', action: 'ChangePlan', planId: 'business' };
  await hook({ id: 'op2', subscriptionId: 'sub-1', action: 'ChangePlan' });
  assert.equal(registry.get(CUST).plan, 'business');

  ops.op3 = { id: 'op3', subscriptionId: 'sub-1', action: 'Suspend' };
  await hook({ id: 'op3', subscriptionId: 'sub-1', action: 'Suspend' });
  assert.equal(registry.get(CUST).status, 'suspended');
  assert.equal((await call('POST', '/api/sessions', { mode: 'new', title: 'x', consent: true }, tok(CUST, 1))).status, 402);

  ops.op4 = { id: 'op4', subscriptionId: 'sub-1', action: 'Reinstate' };
  await hook({ id: 'op4', subscriptionId: 'sub-1', action: 'Reinstate' });
  assert.equal(registry.get(CUST).status, 'active');

  ops.op5 = { id: 'op5', subscriptionId: 'sub-1', action: 'Unsubscribe' };
  await hook({ id: 'op5', subscriptionId: 'sub-1', action: 'Unsubscribe' });
  assert.equal(registry.get(CUST).status, 'cancelled');
  assert.equal((await call('GET', '/api/me', null, tok(CUST, 1))).status, 403);

  ops.op6 = { id: 'op6', subscriptionId: 'sub-unknown', action: 'Suspend' };
  assert.equal((await hook({ id: 'op6', subscriptionId: 'sub-unknown', action: 'Suspend' })).body.ignored, true);
});

test('webhook token: issued in the publisher tenant, for our app, to Microsoft Marketplace only', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' };
  const verify = createWebhookVerifier({ publisherTenantId: PUB, appId: API, jwks: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (c) => new SignJWT(c).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await verify(await sign({ iss: `https://sts.windows.net/${PUB}/`, aud: API, appid: MARKETPLACE_RESOURCE }));
  await assert.rejects(verify(await sign({ iss: `https://sts.windows.net/${PUB}/`, aud: API, appid: 'someone-else' })), /Marketplace/);
  await assert.rejects(verify(await sign({ iss: `https://sts.windows.net/${CUST}/`, aud: API, appid: MARKETPLACE_RESOURCE })));
  await assert.rejects(verify(await sign({ iss: `https://sts.windows.net/${PUB}/`, aud: 'other', appid: MARKETPLACE_RESOURCE })));
});

test('Fulfillment API client: Marketplace token from the federated identity, api-version, purchase token header', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'sub-9' }) }; };
  const federated = { appToken: async (tid, scope) => { assert.equal(tid, PUB); assert.equal(scope, `${MARKETPLACE_RESOURCE}/.default`); return { token: 'mp-token' }; } };
  const c = createMarketplaceClient({ publisherTenantId: PUB, appId: API, federated, fetchImpl });
  await c.resolve('purchase-token');
  await c.ackOperation('sub-9', 'op-1');
  assert.equal(seen[0].url, 'https://marketplaceapi.microsoft.com/api/saas/subscriptions/resolve?api-version=2018-08-31');
  assert.equal(seen[0].opts.headers['x-ms-marketplace-token'], 'purchase-token');
  assert.equal(seen[0].opts.headers.authorization, 'Bearer mp-token');
  assert.equal(seen[1].opts.method, 'PATCH');
  assert.deepEqual(JSON.parse(seen[1].opts.body), { status: 'Success' });
});

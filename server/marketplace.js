// Microsoft commercial marketplace: transactable SaaS offer (multi-tenant deployment).
//
// Partner Center → the offer → Technical configuration:
//   Landing page URL     https://<app>/subscribe
//   Connection webhook   https://<app>/api/marketplace/webhook
//   Microsoft Entra tenant ID / application ID   the publisher tenant and the multi-tenant API app
//                        (PDA_PUBLISHER_TENANT_ID, ENTRA_API_CLIENT_ID; PDA_MARKETPLACE_APP_ID to use
//                        another app)
//
// Purchase: Marketplace sends the buyer to the landing page with ?token=. The buyer signs in
// (Microsoft Entra, any tenant); the app resolves the token with the SaaS Fulfillment API, shows
// the plan, and on "Activate" registers the customer tenant (the subscription's beneficiary) with
// that plan and quantity, then activates the subscription. A purchase through a CSP partner (an
// MSP buying for its customer) works the same way: the beneficiary tenant gets the licence.
//
// Changes: Marketplace calls the webhook (a JWT signed by Microsoft Entra for our app). Every event
// is checked again against the Fulfillment API before anything changes.
//   ChangePlan / ChangeQuantity -> plan / seats, then the operation is acknowledged (Success)
//   Suspend -> suspended (read-only) · Reinstate -> active · Unsubscribe -> cancelled · Renew -> active
//
// Calls to the Fulfillment API use a token for the Marketplace resource, obtained by the app's
// federated credential (managed identity, no secret) in the publisher tenant.
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createEntraVerifier, userFromClaims } from './auth.js';
import { isDirectoryAdmin } from './onboarding.js';

export const MARKETPLACE_RESOURCE = '20e940b3-4c77-4b0b-9a53-9e16a1b010a7';
const API = 'https://marketplaceapi.microsoft.com/api/saas/subscriptions';
const V = 'api-version=2018-08-31';
const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMarketplaceClient({ publisherTenantId, appId, federated, fetchImpl = globalThis.fetch }) {
  async function call(method, path, { body, headers = {} } = {}) {
    if (!publisherTenantId) throw err(503, 'Marketplace is not configured (PDA_PUBLISHER_TENANT_ID).', 'NOT_CONFIGURED');
    const { token } = await federated.appToken(publisherTenantId, `${MARKETPLACE_RESOURCE}/.default`);
    const res = await fetchImpl(`${API}${path}${path.includes('?') ? '&' : '?'}${V}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* empty */ }
    if (!res.ok) throw err(res.status === 400 || res.status === 404 ? 400 : 502, `Microsoft Marketplace: ${j?.message || j?.error?.message || res.status}`, 'MARKETPLACE');
    return j;
  }
  return {
    resolve: (marketplaceToken) => call('POST', '/resolve', { headers: { 'x-ms-marketplace-token': marketplaceToken } }),
    get: (id) => call('GET', `/${encodeURIComponent(id)}`),
    activate: (id, planId, quantity) => call('POST', `/${encodeURIComponent(id)}/activate`, { body: quantity ? { planId, quantity } : { planId } }),
    operation: (id, opId) => call('GET', `/${encodeURIComponent(id)}/operations/${encodeURIComponent(opId)}`),
    ackOperation: (id, opId, status = 'Success') => call('PATCH', `/${encodeURIComponent(id)}/operations/${encodeURIComponent(opId)}`, { body: { status } }),
  };
}

// The Marketplace plan id -> our plan name (saas.marketplace.planMap; default: the same name).
const planOf = (cfg, planId) => cfg.saas?.marketplace?.planMap?.[planId] || planId;

// Validates the webhook's bearer token: issued by Microsoft Entra in the publisher tenant, for our
// app, to the Marketplace's own application.
export function createWebhookVerifier({ publisherTenantId, appId, jwks }) {
  let keys = jwks;
  return async (token) => {
    keys ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${publisherTenantId}/discovery/v2.0/keys`));
    const { payload } = await jwtVerify(token, keys, {
      issuer: [`https://sts.windows.net/${publisherTenantId}/`, `https://login.microsoftonline.com/${publisherTenantId}/v2.0`],
      audience: [appId, `api://${appId}`],
    });
    if ((payload.appid || payload.azp) !== MARKETPLACE_RESOURCE) throw new Error('Token was not issued to Microsoft Marketplace');
    return payload;
  };
}

export function mountMarketplace(app, { cfg, registry, verifyUser, client, verifyWebhook, wrap, log = () => {} }) {
  const findTenant = (subscriptionId) => registry.list().find((t) => t.marketplace?.subscriptionId === subscriptionId) || null;
  const view = (s) => ({
    id: s.id, name: s.subscriptionName || s.name, offerId: s.offerId, planId: s.planId, plan: planOf(cfg, s.planId), quantity: s.quantity ?? s.subscription?.quantity ?? null,
    status: s.subscription?.saasSubscriptionStatus || s.saasSubscriptionStatus, beneficiaryTenantId: s.subscription?.beneficiary?.tenantId || s.beneficiary?.tenantId,
    purchaserTenantId: s.subscription?.purchaser?.tenantId || s.purchaser?.tenantId,
  });
  // The landing page signs in with the web app's ID token (the buyer's tenant may not have added the
  // API app yet), so these two routes accept that.
  async function buyer(req) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) throw err(401, 'Sign in with your Microsoft work account first.');
    try { return userFromClaims(await verifyUser(m[1])); } catch { throw err(401, 'Invalid or expired sign-in'); }
  }
  const tokenOf = (req) => { const t = String(req.body?.token || ''); if (!t || t.length > 4096) throw err(400, 'The link from Microsoft Marketplace has no purchase token. Open it again from the Marketplace or the Azure portal (SaaS → Configure account).'); return t; };

  app.post('/api/marketplace/resolve', express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const user = await buyer(req);
    const s = view(await client.resolve(tokenOf(req)));
    const t = s.beneficiaryTenantId ? registry.get(s.beneficiaryTenantId) : null;
    res.json({ ...s, buyer: { name: user.name, email: user.email, tenantId: user.tenantId }, forOwnOrganisation: user.tenantId === s.beneficiaryTenantId, alreadyActive: t?.marketplace?.subscriptionId === s.id && t.status === 'active' });
  }));

  app.post('/api/marketplace/activate', express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const user = await buyer(req);
    const s = view(await client.resolve(tokenOf(req)));
    if (!GUID.test(s.beneficiaryTenantId || '')) throw err(400, 'The subscription has no customer tenant.');
    const cur = registry.get(s.beneficiaryTenantId);
    // The buyer becomes an Admin only of their own organisation, and only as one of its directory
    // administrators; a partner buying for a customer does not get into the customer's data.
    const admins = new Set(cur?.admins || []);
    if (user.tenantId === s.beneficiaryTenantId && isDirectoryAdmin(user)) admins.add(user.id);
    const t = registry.upsert(s.beneficiaryTenantId, {
      name: cur?.name || s.name || '', status: 'active', plan: s.plan, seats: s.quantity ?? null, trialEndsAt: null,
      admins: [...admins], defaultRole: cur?.defaultRole || (cur?.status === 'trial' || !cur ? 'Contributor' : ''),
      marketplace: { subscriptionId: s.id, offerId: s.offerId, planId: s.planId, purchaserTenantId: s.purchaserTenantId, activatedAt: Date.now(), activatedBy: { id: user.id, tenantId: user.tenantId } },
    });
    await client.activate(s.id, s.planId, s.quantity ?? undefined);
    log('marketplace.activated', { tenantId: t.id, subscriptionId: s.id, plan: s.plan, seats: s.quantity });
    res.json({ tenantId: t.id, plan: t.plan, seats: t.seats, status: t.status, forOwnOrganisation: user.tenantId === t.id, needsConsent: !cur || cur.status === 'cancelled' });
  }));

  app.post('/api/marketplace/webhook', express.json({ limit: '64kb' }), wrap(async (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    try { if (!m) throw new Error('no token'); await verifyWebhook(m[1]); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const b = req.body || {};
    if (!b.subscriptionId || !b.id) throw err(400, 'Missing subscriptionId or operation id');
    // Never trust the body alone: read the operation back from the Fulfillment API.
    const op = await client.operation(b.subscriptionId, b.id);
    if (op.subscriptionId !== b.subscriptionId || op.action !== b.action) throw err(400, 'Operation does not match');
    const t = findTenant(b.subscriptionId);
    if (!t) { log('marketplace.unknown_subscription', { subscriptionId: b.subscriptionId, action: op.action }); return res.json({ ok: true, ignored: true }); }
    const patch = {};
    switch (op.action) {
      case 'ChangePlan': patch.plan = planOf(cfg, op.planId); patch.marketplace = { ...t.marketplace, planId: op.planId }; break;
      case 'ChangeQuantity': patch.seats = op.quantity ?? null; break;
      case 'Suspend': patch.status = 'suspended'; break;
      case 'Reinstate': case 'Renew': patch.status = 'active'; break;
      case 'Unsubscribe': patch.status = 'cancelled'; patch.cancelledAt = Date.now(); break;
      default: log('marketplace.unknown_action', { action: op.action }); return res.json({ ok: true, ignored: true });
    }
    registry.upsert(t.id, patch);
    if (['ChangePlan', 'ChangeQuantity', 'Reinstate'].includes(op.action)) await client.ackOperation(b.subscriptionId, b.id, 'Success');
    log('marketplace.event', { tenantId: t.id, action: op.action, ...patch });
    res.json({ ok: true });
  }));
}

// The web app's sign-in for the landing page: ID tokens of the SPA app, from any tenant.
export const landingVerifier = (spaClientId) => createEntraVerifier({ apiClientId: spaClientId });

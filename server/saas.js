// Multi-tenant (SaaS) front: one deployment serves many customer organisations.
//
// Enabled with PDA_MULTI_TENANT=true. Every customer is a Microsoft Entra tenant that has consented
// to the multi-tenant app registration and is listed in the tenant registry (server/tenants.js).
//
// Request routing
//   /api/* with a user token  -> the token is validated for ANY tenant (issuer must match its "tid"),
//                                the tenant must be in the registry and not cancelled, then the
//                                request is handed to that tenant's own app instance.
//   /api/capture/pair         -> the pairing code is looked up in the registry's routing index.
//   /api/capture/*            -> the X-Session-Id header is looked up in the same index; the tenant's
//                                app then checks the capture token against its own session.
//   /api/config               -> with a valid token: that tenant's configuration; without: the
//                                sign-in information only.
//
// Isolation: each tenant's app is created by createApp() with its own configuration
// (config.js tenantConfig): its own data folder (recordings, screenshots, drafts, audit log, search
// index, settings) and its own repository. Nothing in a tenant's app can name another tenant's data,
// because it never receives another tenant's paths.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, securityHeaders } from './app.js';
import { createEntraVerifier, userFromClaims } from './auth.js';
import { tenantConfig } from './config.js';
import { TenantRegistry } from './tenants.js';
import { createFederatedIdentity } from './federated.js';
import { evaluate, checkRequest, seatError } from './licence.js';
import { mountSubscription } from './subscription.js';
import { mountOnboarding, createSharePointConnector, effectiveUser, isDirectoryAdmin } from './onboarding.js';

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

export function createSaaSApp(cfg, deps = {}) {
  const { apiClientId, spaClientId, apiScope } = cfg.auth.entra;
  if (!apiClientId || !spaClientId) throw new Error('Multi-tenant mode needs ENTRA_API_CLIENT_ID and ENTRA_SPA_CLIENT_ID of the multi-tenant app registrations.');
  const registry = deps.registry || new TenantRegistry(cfg.dataDir);
  const verify = deps.verifyToken || createEntraVerifier({ apiClientId });
  const apps = new Map();
  // Signs in to customers' tenants as the multi-tenant app, without secrets (server/federated.js).
  const federated = deps.federated || createFederatedIdentity({ clientId: apiClientId, miClientId: cfg.saas?.miClientId || cfg.teams?.miClientId });
  const connector = deps.sharepointConnector || createSharePointConnector({ cfg, federated });

  function tenantApp(tid) {
    const t = registry.get(tid);
    const key = t.id;
    const hit = apps.get(key);
    // A changed registry record (name, repository) rebuilds the tenant's app on its next request.
    if (hit && hit.version === t.updatedAt) return hit.app;
    const tcfg = tenantConfig(cfg, t);
    fs.mkdirSync(tcfg.dataDir, { recursive: true });
    const extra = deps.tenantDeps?.(key) || {};
    const repoDeps = tcfg.repository.sharepoint?.auth === 'federated' ? { tokenProvider: () => federated.appToken(key), ...(extra.repoDeps || {}) } : extra.repoDeps;
    const app = createApp(tcfg, { ...extra, repoDeps, issuePairingCode: (sessionId, expiresAt) => registry.issuePairingCode(key, sessionId, expiresAt), onAiDraft: () => registry.recordAi(key) });
    deps.onTenantApp?.(app, t);
    apps.set(key, { app, version: t.updatedAt });
    return app;
  }

  // The tenant's app with the licence state of this moment (read-only, AI quota) applied to its
  // configuration; the trial end and the monthly counters change without the record changing.
  function licensedApp(t) {
    const app = tenantApp(t.id);
    const lic = evaluate(cfg, t);
    const { aiUsed } = registry.usage(t.id);
    app.locals.cfg.tenant.licence = { readOnly: lic.readOnly, reason: lic.reason, plan: lic.plan, trialEndsAt: lic.trialEndsAt };
    app.locals.cfg.ai.quotaExceeded = lic.aiGenerations !== null && aiUsed >= lic.aiGenerations;
    return { app, lic };
  }
  const takeSeat = (t, user, lic) => { if (!registry.useSeat(t.id, user.id, lic.seats)) throw seatError(lic.seats); };

  const notOnboarded = () => httpError(403, 'Your organisation has not set up Doku yet. Ask your Microsoft 365 administrator to add it.', 'TENANT_NOT_ONBOARDED');
  const ended = () => httpError(403, "Your organisation's Doku subscription has ended. Ask your Microsoft 365 administrator to renew it.", 'SUBSCRIPTION_ENDED');
  const checkTenant = (tid) => {
    const t = registry.get(tid);
    if (!t) throw notOnboarded();
    if (!registry.canUse(tid)) throw ended();
    return t;
  };
  const bearer = (req) => (/^Bearer (.+)$/.exec(req.get('authorization') || '') || [])[1];
  async function userOf(req) {
    const token = bearer(req);
    if (!token) return null;
    return userFromClaims(await verify(token));
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Failed pairing attempts per client address: six digits are guessable, so slow down guessing.
  const pairFailures = new Map();
  const pairAllowed = (ip) => {
    const now = Date.now(); const f = pairFailures.get(ip);
    if (!f || now - f.since > 60_000) return true;
    return f.count < 10;
  };
  const pairFailed = (ip) => {
    const now = Date.now(); const f = pairFailures.get(ip);
    if (!f || now - f.since > 60_000) pairFailures.set(ip, { since: now, count: 1 }); else f.count++;
    if (pairFailures.size > 10_000) pairFailures.delete(pairFailures.keys().next().value);
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders(cfg));

  app.get('/healthz', (req, res) => {
    try { registry.ping(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false, error: 'storage unavailable' }); }
  });

  // Sign-in information for the web app; after sign-in the same call returns the tenant's settings.
  app.get('/api/config', wrap(async (req, res, next) => {
    let user = null;
    try { user = await userOf(req); } catch { /* not signed in yet: platform information only */ }
    const t = user && registry.get(user.tenantId);
    if (t && registry.canUse(t.id)) {
      const { app: tapp, lic } = licensedApp(t);
      if (!registry.useSeat(t.id, user.id, lic.seats)) {
        return res.json({ authMode: 'entra', multiTenant: true, entra: { tenantId: 'organizations', clientId: spaClientId, scope: apiScope }, tenant: { id: t.id, name: t.name, status: 'no_seat', seats: lic.seats }, categories: [], aiOffCategories: [], repository: { mode: 'none', label: '' } });
      }
      req.upstreamUser = effectiveUser(user, t);
      return tapp(req, res, next);
    }
    res.json({
      authMode: 'entra',
      multiTenant: true,
      entra: { tenantId: 'organizations', clientId: spaClientId, scope: apiScope },
      tenant: user ? { id: user.tenantId, status: t ? 'ended' : 'not_onboarded', canSignUp: !t && cfg.saas?.selfSignup !== false && isDirectoryAdmin(user) } : undefined,
      categories: cfg.categories,
      aiOffCategories: [],
      repository: { mode: 'none', label: '' },
    });
  }));

  // Capture clients: routed by pairing code or session id, never by anything the client claims
  // about its tenant.
  app.post('/api/capture/pair', express.json({ limit: '1mb' }), (req, res, next) => {
    if (!pairAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    const tid = registry.tenantForCode(String(req.body?.code || '').replace(/\D/g, ''));
    if (!tid || !registry.canUse(tid)) { pairFailed(req.ip); return res.status(404).json({ error: 'No active recording with this pairing code' }); }
    const { app: tapp, lic } = licensedApp(registry.get(tid));
    checkRequest(lic, req.method);
    return tapp(req, res, next);
  });
  app.all(/^\/api\/capture\//, (req, res, next) => {
    const tid = registry.tenantForSession(req.get('x-session-id'));
    if (!tid || !registry.canUse(tid)) return res.status(401).json({ error: 'Invalid capture token' });
    const { app: tapp, lic } = licensedApp(registry.get(tid));
    checkRequest(lic, req.method);
    return tapp(req, res, next);
  });

  // Admin consent, sign-up and setup (before the tenant needs to exist).
  mountOnboarding(app, { cfg, registry, userOf, bearer, connector, tenantConfigFor: (t) => tenantConfig(cfg, t), wrap });
  mountSubscription(app, { cfg, registry, userOf, wrap });

  // Everything else under /api: a signed-in user of an onboarded tenant. (Routes, not app.use, so the
  // tenant's app sees the full path.)
  app.all(/^\/api(\/.*)?$/, wrap(async (req, res, next) => {
    let user;
    try { user = await userOf(req); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    const t = checkTenant(user.tenantId);
    const { app: tapp, lic } = licensedApp(t);
    takeSeat(t, user, lic);
    checkRequest(lic, req.method);
    req.upstreamUser = effectiveUser(user, t);
    return tapp(req, res, next);
  }));

  const dist = path.join(cfg._root, 'web/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message, code: err.code });
  });

  // For the hourly jobs (retention) and the tenant admin tool.
  app.locals = { ...app.locals, registry, tenantApp, cfg, federated };
  return app;
}

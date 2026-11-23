// Self-service onboarding of a customer organisation (multi-tenant deployment).
//
//   1. Admin consent.  /api/onboarding/consent sends a Microsoft 365 administrator to Microsoft's
//      admin-consent page, first for the API app (its Graph permissions), then for the web app.
//      Both apps are multi-tenant registrations of the publisher; consent adds them to the
//      customer's tenant. No data is written by these two steps.
//   2. Sign-up.        Back in the app, the admin signs in and starts the trial
//      (POST /api/onboarding/start). Only a directory administrator (token claim "wids") can do this.
//      The tenant is registered with status "trial"; that admin becomes the organisation's first Admin.
//   3. Setup.          The admin decides who may use the app and connects the SharePoint site
//      (POST /api/onboarding/sharepoint): the app grants itself "write" on that ONE site (Graph
//      Sites.Selected, granted on behalf of the admin), then creates its columns and folders there.
//
// Roles: app roles assigned in the customer's Enterprise application still work. On top of that the
// tenant record names Admins (the admin who signed up, and others they add) and a default role for
// everybody else in the organisation, so a customer can start without any Entra configuration.
import express from 'express';
import { ROLES } from './auth.js';
import { SharePointRepository } from './repo/sharepoint.js';
import { trialDays } from './licence.js';

const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Directory roles that may add an app to a tenant (Entra built-in role template ids).
export const CONSENT_ADMIN_ROLES = {
  '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
  '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
};
const DEFAULT_ROLES = ['', ROLES.CONTRIBUTOR, ROLES.APPROVER];

export const isDirectoryAdmin = (user) => (user.directoryRoles || []).some((r) => CONSENT_ADMIN_ROLES[String(r).toLowerCase()]);

// The roles a user has in the app: app roles from the token, plus the tenant record's Admins and
// default role.
export function effectiveUser(user, tenant) {
  const roles = new Set(user.roles);
  if (tenant?.admins?.includes(user.id)) roles.add(ROLES.ADMIN);
  if (!roles.size && tenant?.defaultRole) roles.add(tenant.defaultRole);
  return { ...user, roles: [...roles] };
}

export function tenantView(t) {
  return {
    id: t.id, name: t.name, status: t.status, plan: t.plan || '', trialEndsAt: t.trialEndsAt || null,
    defaultRole: t.defaultRole || '', admins: t.admins || [],
    sharepoint: t.repository?.mode === 'sharepoint' ? { siteUrl: t.repository.sharepoint.siteUrl, libraryName: t.repository.sharepoint.libraryName, rootFolder: t.repository.sharepoint.rootFolder, connectedAt: t.repository.connectedAt } : null,
  };
}

// Connects a customer's SharePoint site: grant on behalf of the admin, then check and provision with
// the app's own (app-only) access, exactly as the app will use it afterwards.
export function createSharePointConnector({ cfg, federated, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { apiClientId } = cfg.auth.entra;
  const appName = cfg.saas?.appName || 'Process Documentation Agent';
  async function graphAs(token, method, path, body) {
    const res = await fetchImpl(`https://graph.microsoft.com/v1.0${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw err(res.status === 404 ? 404 : res.status === 403 || res.status === 401 ? 403 : 502, res.status === 404 ? 'SharePoint site not found. Check the address (https://<company>.sharepoint.com/sites/<site>).' : res.status === 403 || res.status === 401 ? 'You do not have the right to share this site with the app. A SharePoint administrator or the site owner connects it.' : `Microsoft Graph: ${j?.error?.message || res.status}`, 'SHAREPOINT_GRANT');
    return j;
  }
  return {
    async connect({ tenantId, userToken, siteUrl, libraryName, rootFolder, categories }) {
      const u = new URL(siteUrl);
      const obo = await federated.onBehalfOf(tenantId, userToken, ['https://graph.microsoft.com/Sites.FullControl.All']);
      const site = await graphAs(obo.token, 'GET', `/sites/${u.hostname}:${u.pathname.replace(/\/$/, '') || '/'}?$select=id,webUrl,displayName`);
      const perms = await graphAs(obo.token, 'GET', `/sites/${site.id}/permissions`);
      const has = (perms.value || []).some((p) => (p.grantedToIdentitiesV2 || p.grantedToIdentities || []).some((g) => g.application?.id === apiClientId) && (p.roles || []).some((r) => ['write', 'owner', 'fullcontrol'].includes(r)));
      if (!has) await graphAs(obo.token, 'POST', `/sites/${site.id}/permissions`, { roles: ['write'], grantedToIdentities: [{ application: { id: apiClientId, displayName: appName } }] });
      const repository = { mode: 'sharepoint', connectedAt: Date.now(), sharepoint: { tenantId, clientId: apiClientId, auth: 'federated', siteUrl: site.webUrl || siteUrl, libraryName, rootFolder, applyMetadata: true, assignOwnerPermissions: false } };
      // The new grant can take a moment to apply to app-only tokens.
      const repo = new SharePointRepository({ categories, repository }, { tokenProvider: () => federated.appToken(tenantId), fetchImpl, sleep });
      let st;
      for (let i = 0; i < 4; i++) { st = await repo.status(); if (st.connected) break; await sleep(3000 * (i + 1)); }
      if (!st.connected) throw err(502, `The site was shared with the app, but the app cannot open it yet: ${st.error}`, 'SHAREPOINT_CHECK');
      await repo.ensureSchema(categories);
      return { repository, site: { id: site.id, webUrl: site.webUrl, name: site.displayName } };
    },
  };
}

// Routes; mounted by server/saas.js before the routes that require a registered tenant.
export function mountOnboarding(app, { cfg, registry, userOf, bearer, connector, tenantConfigFor, wrap }) {
  const { apiClientId, spaClientId } = cfg.auth.entra;
  const base = (req) => (cfg.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const consentUrl = (req, clientId, state) => `https://login.microsoftonline.com/organizations/adminconsent?${new URLSearchParams({ client_id: clientId, redirect_uri: `${base(req)}/api/onboarding/consent-callback`, state })}`;

  async function signedIn(req) {
    let user;
    try { user = await userOf(req); } catch { throw err(401, 'Invalid or expired token'); }
    if (!user) throw err(401, 'Not signed in');
    return user;
  }
  async function tenantAdmin(req) {
    const user = await signedIn(req);
    const t = registry.get(user.tenantId);
    if (!t || !registry.canUse(t.id)) throw err(403, 'Your organisation has not set up the app.', 'TENANT_NOT_ONBOARDED');
    if (!effectiveUser(user, t).roles.includes(ROLES.ADMIN)) throw err(403, 'This action requires the Admin role');
    return { user, t };
  }

  // Step 1: admin consent for the API app, then for the web app. Public: Microsoft does the checks.
  app.get('/api/onboarding/consent', (req, res) => res.redirect(consentUrl(req, apiClientId, 'api')));
  app.get('/api/onboarding/consent-callback', (req, res) => {
    const q = req.query;
    if (q.error) return res.redirect(`/#/signup?consent_error=${encodeURIComponent(String(q.error).slice(0, 60))}`);
    if (q.state === 'api') return res.redirect(consentUrl(req, spaClientId, 'spa'));
    return res.redirect('/#/setup');
  });

  // Step 2: start the trial.
  app.post('/api/onboarding/start', express_json(), wrap(async (req, res) => {
    const user = await signedIn(req);
    const existing = registry.get(user.tenantId);
    if (existing) return res.status(existing.status === 'cancelled' ? 403 : 200).json(tenantView(existing));
    if (cfg.saas?.selfSignup === false) throw err(403, 'Sign-up is by invitation. Contact us to start a trial.', 'SIGNUP_CLOSED');
    if (!isDirectoryAdmin(user)) throw err(403, 'Only a Microsoft 365 administrator of your organisation can start the trial (Global, Application or Cloud Application Administrator).', 'NOT_DIRECTORY_ADMIN');
    const name = String(req.body?.name || '').trim().slice(0, 120) || user.email?.split('@')[1] || 'My organisation';
    // A self-service trial: at most 5 days and 1 seat, taken by the administrator who signs up.
    // Nobody else gets a role by default; the default role is set once the organisation subscribes.
    const t = registry.upsert(user.tenantId, { name, status: 'trial', plan: 'trial', trialEndsAt: Date.now() + trialDays(cfg) * 86400_000, admins: [user.id], defaultRole: '', signedUpBy: { id: user.id, name: user.name, email: user.email } });
    registry.useSeat(t.id, user.id, 1);
    res.status(201).json(tenantView(t));
  }));

  // Step 3: setup by the organisation's Admins.
  app.get('/api/onboarding', wrap(async (req, res) => res.json(tenantView((await tenantAdmin(req)).t))));
  app.put('/api/onboarding', express_json(), wrap(async (req, res) => {
    const { t } = await tenantAdmin(req);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 120); if (!n) throw err(400, 'Enter the organisation name'); patch.name = n; }
    if (b.defaultRole !== undefined) { if (!DEFAULT_ROLES.includes(b.defaultRole)) throw err(400, 'defaultRole must be "", "Contributor" or "Approver"'); patch.defaultRole = b.defaultRole; }
    if (b.admins !== undefined) {
      if (!Array.isArray(b.admins) || !b.admins.length || b.admins.some((a) => !GUID.test(a))) throw err(400, 'admins must be a non-empty list of Entra user object ids');
      patch.admins = [...new Set(b.admins.map((a) => a.toLowerCase()))];
    }
    res.json(tenantView(registry.upsert(t.id, patch)));
  }));
  app.post('/api/onboarding/sharepoint', express_json(), wrap(async (req, res) => {
    const { t } = await tenantAdmin(req);
    const b = req.body || {};
    let u; try { u = new URL(String(b.siteUrl || '')); } catch { throw err(400, 'Enter the address of the SharePoint site, e.g. https://contoso.sharepoint.com/sites/ITOps'); }
    if (u.protocol !== 'https:' || !/\.sharepoint\.(com|us|de|cn)$/i.test(u.hostname)) throw err(400, 'The address must be a SharePoint Online site (https://<company>.sharepoint.com/sites/<site>)');
    const libraryName = String(b.libraryName || 'Documents').trim().slice(0, 120);
    const rootFolder = String(b.rootFolder || 'IT Process Documentation').trim().replace(/[\\:*?"<>|#%]/g, '-').slice(0, 120);
    const out = await connector.connect({ tenantId: t.id, userToken: bearer(req), siteUrl: `${u.origin}${u.pathname}`, libraryName, rootFolder, categories: tenantConfigFor(t).categories });
    res.json({ ...tenantView(registry.upsert(t.id, { repository: out.repository })), site: out.site });
  }));
}

function express_json() { return express.json({ limit: '100kb' }); }

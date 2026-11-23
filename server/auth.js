// Authentication and role-based access control.
//
// mode "dev"   - prototype mode. The caller chooses one of the configured dev users with the
//                X-Dev-User header (the web UI has a user switcher). NOT for production.
// mode "entra" - Microsoft Entra ID. The SPA signs in with MSAL and sends an access token for the
//                API app registration. The token is validated here (signature via the tenant JWKS,
//                issuer, audience, expiry) and roles are read from the "roles" claim, which holds
//                the app roles assigned in Entra (ProcessDoc.Contributor / .Approver / .Admin).
// multi-tenant - (PDA_MULTI_TENANT=true) one deployment serves many organisations. server/saas.js
//                validates tokens from any tenant and hands the user to that tenant's app
//                (auth.upstream = true in the tenant's configuration).
//
// Capture clients (browser extension, desktop agent) never get a user token. After pairing they
// receive a capture token that only allows writing events/screenshots to that one session.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ROLES = { CONTRIBUTOR: 'Contributor', APPROVER: 'Approver', ADMIN: 'Admin' };
const ENTRA_ROLE_MAP = { 'ProcessDoc.Contributor': 'Contributor', 'ProcessDoc.Approver': 'Approver', 'ProcessDoc.Admin': 'Admin' };

export const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The API app's own ids: its client id, api://<client id>, and api://<host>/<client id> (Teams SSO).
export function isApiAudience(aud, apiClientId) {
  return [].concat(aud || []).some((a) => a === apiClientId || a === `api://${apiClientId}` || (a.startsWith('api://') && a.endsWith(`/${apiClientId}`) && /^api:\/\/[a-z0-9.-]+\/[0-9a-f-]+$/i.test(a)));
}

// Validates an Entra ID access token for the API (signature, expiry, audience, issuer).
// tenantId set   -> single organisation: only tokens issued by that tenant.
// tenantId unset -> multi-tenant (SaaS): any tenant may sign in, but the issuer must be the tenant
//                   named in the token's own "tid" claim. Whether that tenant may use the app is decided
//                   afterwards against the tenant registry (server/saas.js).
export function createEntraVerifier({ tenantId, apiClientId, jwks }) {
  let keys = jwks;
  return async (token) => {
    keys ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId || 'common'}/discovery/v2.0/keys`));
    const { payload } = await jwtVerify(token, keys, tenantId
      ? { issuer: [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`] }
      : {});
    if (!tenantId) {
      const tid = String(payload.tid || '');
      if (!TENANT_ID.test(tid)) throw new Error('Token has no tenant');
      if (![`https://login.microsoftonline.com/${tid}/v2.0`, `https://sts.windows.net/${tid}/`].includes(payload.iss)) throw new Error('Token issuer does not match its tenant');
    }
    if (!isApiAudience(payload.aud, apiClientId)) throw new Error('Token is not for this API');
    return payload;
  };
}

export function userFromClaims(payload) {
  const roles = (payload.roles || []).map((r) => ENTRA_ROLE_MAP[r]).filter(Boolean);
  // directoryRoles: Entra directory role template ids ("wids"), used only to recognise the
  // administrator who signs an organisation up (multi-tenant deployment).
  return { id: payload.oid, name: payload.name || payload.preferred_username, email: payload.preferred_username, roles, tenantId: payload.tid, directoryRoles: payload.wids || [] };
}

export function createAuth(cfg) {
  let verify;
  async function resolveUser(req) {
    // Multi-tenant: the SaaS front (server/saas.js) has already validated the token and chosen this
    // tenant's app; it hands the user over on the request object, never through a header.
    if (cfg.auth.upstream) return req.upstreamUser || null;
    if (cfg.auth.mode === 'dev') {
      const id = req.get('x-dev-user') || cfg.auth.devUsers[0]?.id;
      const u = cfg.auth.devUsers.find((x) => x.id === id);
      return u ? { ...u } : null;
    }
    if (cfg.auth.mode === 'entra') {
      const { tenantId, apiClientId } = cfg.auth.entra;
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      if (!m) return null;
      if (!tenantId) throw new Error('auth.entra.tenantId is not set');
      verify ??= createEntraVerifier({ tenantId, apiClientId });
      return userFromClaims(await verify(m[1]));
    }
    throw new Error(`Unknown auth mode ${cfg.auth.mode}`);
  }

  const authenticate = async (req, res, next) => {
    try {
      const user = await resolveUser(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });
      req.user = user;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
  const requireRole = (role) => (req, res, next) =>
    req.user?.roles.includes(role) || req.user?.roles.includes(ROLES.ADMIN)
      ? next() : res.status(403).json({ error: `This action requires the ${role} role` });

  return { authenticate, requireRole };
}

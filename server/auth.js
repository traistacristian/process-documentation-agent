// Authentication and role-based access control.
//
// mode "dev"   - prototype mode. The caller chooses one of the configured dev users with the
//                X-Dev-User header (the web UI has a user switcher). NOT for production.
// mode "entra" - Microsoft Entra ID. The SPA signs in with MSAL and sends an access token for the
//                API app registration. The token is validated here (signature via the tenant JWKS,
//                issuer, audience, expiry) and roles are read from the "roles" claim, which holds
//                the app roles assigned in Entra (ProcessDoc.Contributor / .Approver / .Admin).
//
// Capture clients (browser extension, desktop agent) never get a user token. After pairing they
// receive a capture token that only allows writing events/screenshots to that one session.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ROLES = { CONTRIBUTOR: 'Contributor', APPROVER: 'Approver', ADMIN: 'Admin' };
const ENTRA_ROLE_MAP = { 'ProcessDoc.Contributor': 'Contributor', 'ProcessDoc.Approver': 'Approver', 'ProcessDoc.Admin': 'Admin' };

export function createAuth(cfg) {
  let jwks;
  async function resolveUser(req) {
    if (cfg.auth.mode === 'dev') {
      const id = req.get('x-dev-user') || cfg.auth.devUsers[0]?.id;
      const u = cfg.auth.devUsers.find((x) => x.id === id);
      return u ? { ...u } : null;
    }
    if (cfg.auth.mode === 'entra') {
      const { tenantId, apiClientId } = cfg.auth.entra;
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      if (!m) return null;
      jwks ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
      const { payload } = await jwtVerify(m[1], jwks, {
        issuer: [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`],
        audience: [apiClientId, `api://${apiClientId}`],
      });
      const roles = (payload.roles || []).map((r) => ENTRA_ROLE_MAP[r]).filter(Boolean);
      return { id: payload.oid, name: payload.name || payload.preferred_username, email: payload.preferred_username, roles };
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

// Tokens for a customer's tenant without any secret (multi-tenant deployment).
//
// The multi-tenant API app registration has a federated identity credential that trusts the App
// Service's user-assigned managed identity. The managed identity proves "I am this app" with a token
// for api://AzureADTokenExchange; Entra accepts it as the client assertion of the multi-tenant app in
// ANY tenant that has consented to that app. So the app gets:
//   - app-only Graph tokens in the customer's tenant (SharePoint with Sites.Selected), and
//   - on-behalf-of tokens for a signed-in admin (granting the app access to one SharePoint site).
// No client secret or certificate exists anywhere. scripts/Setup-SaaSPublisher.ps1 creates the
// credential.
import crypto from 'node:crypto';

const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const TOKEN_URL = (tid) => `https://login.microsoftonline.com/${encodeURIComponent(tid)}/oauth2/v2.0/token`;

export function createFederatedIdentity({ clientId, miClientId, credential, fetchImpl = globalThis.fetch }) {
  let mi = credential;
  const cache = new Map();

  async function assertion() {
    if (!mi) {
      if (!miClientId) throw err(503, 'The managed identity for signing in to customer tenants is not configured (PDA_MI_CLIENT_ID).', 'NOT_CONFIGURED');
      const { ManagedIdentityCredential } = await import('@azure/identity');
      mi = new ManagedIdentityCredential({ clientId: miClientId });
    }
    try { return (await mi.getToken('api://AzureADTokenExchange/.default')).token; } catch (e) {
      throw err(502, `Managed identity token request failed: ${e.message}`, 'AUTH_FAILED');
    }
  }

  async function request(tenantId, params, cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.exp > Date.now() + 60_000) return hit;
    const body = new URLSearchParams({ client_id: clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await assertion(), ...params });
    const res = await fetchImpl(TOKEN_URL(tenantId), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw explainSignIn(j);
    const out = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    cache.set(cacheKey, out);
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return out;
  }

  return {
    // App-only token in the customer's tenant, e.g. scope https://graph.microsoft.com/.default
    appToken: (tenantId, scope = 'https://graph.microsoft.com/.default') =>
      request(tenantId, { grant_type: 'client_credentials', scope }, `app|${tenantId}|${scope}`),
    // Token for the signed-in user (on-behalf-of the user's token for this API).
    onBehalfOf: (tenantId, userToken, scopes) =>
      request(tenantId, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', requested_token_use: 'on_behalf_of', assertion: userToken, scope: scopes.join(' ') },
        `obo|${tenantId}|${crypto.createHash('sha256').update(userToken).digest('hex')}|${scopes.join(' ')}`),
  };
}

export function explainSignIn(j) {
  const d = `${j.error || ''} ${j.error_description || ''}`;
  if (/AADSTS65001|consent/i.test(d)) return err(403, 'Your organisation has not given the app this permission yet. An administrator adds the app again (admin consent) and then retries.', 'CONSENT_REQUIRED');
  if (/AADSTS7000229|AADSTS700016|not found in the directory/i.test(d)) return err(403, 'The app is not added to this organisation yet. An administrator adds it (admin consent) first.', 'APP_NOT_IN_TENANT');
  if (/AADSTS700213|AADSTS70021|AADSTS700222|federated/i.test(d)) return err(502, 'The app cannot sign in to Microsoft Graph (its federated credential is missing or wrong). The platform owner runs scripts/Setup-SaaSPublisher.ps1 again.', 'FIC');
  return err(502, `Microsoft sign-in failed: ${(j.error_description || j.error || 'no details').split('\r\n')[0]}`, 'SIGNIN');
}

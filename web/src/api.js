// API client. In "dev" auth mode the selected prototype user is sent as X-Dev-User. In "entra" mode
// an access token for the API is acquired with MSAL and sent as a Bearer token.
let config = null;
let msal = null;

export async function loadConfig() {
  config = await (await fetch('/api/config')).json();
  if (config.authMode === 'entra') {
    const { PublicClientApplication } = await import('@azure/msal-browser');
    msal = new PublicClientApplication({ auth: { clientId: config.entra.clientId, authority: `https://login.microsoftonline.com/${config.entra.tenantId}`, redirectUri: location.origin }, cache: { cacheLocation: 'sessionStorage' } });
    await msal.initialize();
    const r = await msal.handleRedirectPromise();
    if (r?.account) msal.setActiveAccount(r.account);
    if (!msal.getActiveAccount()) {
      const acc = msal.getAllAccounts()[0];
      if (acc) msal.setActiveAccount(acc); else await msal.loginRedirect({ scopes: [config.entra.scope] });
    }
  }
  return config;
}

export const getConfig = () => config;
export const currentAccount = () => msal?.getActiveAccount() || null;
// Signs out of the app. Entra: ends the Microsoft session for this app and returns to the start page.
// Demo mode: shows the signed-out screen until "Sign in" is clicked.
export async function signOut() {
  setHumanPass(null); // the security puzzle is asked again at the next sign-in
  if (config?.authMode === 'entra' && msal) return msal.logoutRedirect({ account: msal.getActiveAccount(), postLogoutRedirectUri: location.origin });
  try { sessionStorage.setItem('pda.signedOut', '1'); } catch { /* ignore */ }
  location.hash = '#/'; location.reload();
}
export const isSignedOut = () => { try { return config?.authMode !== 'entra' && sessionStorage.getItem('pda.signedOut') === '1'; } catch { return false; } };
export const signIn = () => { try { sessionStorage.removeItem('pda.signedOut'); } catch { /* ignore */ } location.reload(); };
// Re-reads the settings an admin can change (categories, capture policy) without signing in again.
export async function refreshConfig() {
  try { const fresh = await (await fetch('/api/config', { cache: 'no-store' })).json(); Object.assign(config, fresh); } catch { /* keep the cached copy */ }
  return config;
}
export const devUser = () => { try { return localStorage.getItem('pda.devUser') || config?.devUsers?.[2]?.id; } catch { return config?.devUsers?.[2]?.id; } };
export const setDevUser = (id) => { try { localStorage.setItem('pda.devUser', id); } catch { /* ignore */ } };

// Human check: after solving the sign-in puzzle the server returns a pass, kept for this browser tab
// and sent as X-Human-Pass. When the server asks for a new check (428), the puzzle screen is shown.
const PASS_KEY = 'pda.humanPass';
export function humanPass() {
  try { const p = JSON.parse(sessionStorage.getItem(PASS_KEY) || 'null'); return p && p.expiresAt > Date.now() ? p : null; } catch { return null; }
}
export const setHumanPass = (p) => { try { if (p) sessionStorage.setItem(PASS_KEY, JSON.stringify(p)); else sessionStorage.removeItem(PASS_KEY); } catch { /* ignore */ } };
export const HUMAN_CHECK_EVENT = 'pda:human-check-required';

async function headers() {
  const pass = humanPass();
  const extra = pass ? { 'x-human-pass': pass.pass } : {};
  if (config?.authMode === 'entra') {
    const t = await msal.acquireTokenSilent({ scopes: [config.entra.scope] }).catch(() => msal.acquireTokenRedirect({ scopes: [config.entra.scope] }));
    return { authorization: `Bearer ${t.accessToken}`, ...extra };
  }
  return { 'x-dev-user': devUser(), ...extra };
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(await headers()) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : null;
  if (res.status === 428 && data?.code === 'HUMAN_CHECK_REQUIRED') { setHumanPass(null); dispatchEvent(new Event(HUMAN_CHECK_EVENT)); }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, code: data?.code });
  return data;
}

// Binary upload (meeting audio chunks).
export async function apiUpload(path, blob) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(await headers()) }, body: blob });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Upload failed (${res.status})`), { status: res.status });
  return data;
}

// Image and file URLs need auth headers, so they are fetched as blobs.
const blobCache = new Map();
export async function authedBlobUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const res = await fetch(path, { headers: await headers() });
  if (!res.ok) throw new Error('not found');
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(path, url);
  return url;
}

export async function download(path, filename) {
  const res = await fetch(path, { headers: await headers() });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename; a.click();
}

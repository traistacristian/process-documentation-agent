// API client. In "dev" auth mode the selected prototype user is sent as X-Dev-User. In "entra" mode
// an access token for the API is acquired with MSAL and sent as a Bearer token.
let config = null;
let msal = null;
// Inside Microsoft Teams (the Teams app opens the app with ?inTeams=1) sign-in is Teams SSO: Teams
// hands out a token for the API without a second login, so MSAL is not used there.
let teams = null; // { sdk, context }
const wantsTeams = () => { try { return new URLSearchParams(location.search).get('inTeams') === '1'; } catch { return false; } };
export const inTeams = () => !!teams;
export const teamsContext = () => teams?.context || null;
export const teamsSdk = () => teams?.sdk || null;

export async function loadConfig() {
  config = await (await fetch('/api/config')).json();
  if (config.authMode === 'entra' && wantsTeams()) {
    const sdk = await import('@microsoft/teams-js');
    await Promise.race([sdk.app.initialize(), new Promise((_, rej) => setTimeout(() => rej(new Error('Open this page from the Teams app.')), 10_000))]);
    teams = { sdk, context: await sdk.app.getContext() };
    sdk.app.notifySuccess();
    document.documentElement.classList.add('in-teams');
    if (['sidePanel', 'meetingStage'].includes(teams.context.page?.frameContext)) document.documentElement.classList.add('teams-panel');
    return config;
  }
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
export const currentAccount = () => (teams ? { name: teams.context.user?.displayName || teams.context.user?.userPrincipalName, username: teams.context.user?.userPrincipalName } : msal?.getActiveAccount() || null);
// Signs out of the app. Entra: ends the Microsoft session for this app and returns to the start page.
// Demo mode: shows the signed-out screen until "Sign in" is clicked.
export async function signOut() {
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

async function headers() {
  if (teams) return { authorization: `Bearer ${await teams.sdk.authentication.getAuthToken()}` };
  if (config?.authMode === 'entra') {
    const t = await msal.acquireTokenSilent({ scopes: [config.entra.scope] }).catch(() => msal.acquireTokenRedirect({ scopes: [config.entra.scope] }));
    return { authorization: `Bearer ${t.accessToken}` };
  }
  return { 'x-dev-user': devUser() };
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(await headers()) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : null;
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

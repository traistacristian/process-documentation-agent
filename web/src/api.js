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
export const devUser = () => { try { return localStorage.getItem('pda.devUser') || config?.devUsers?.[2]?.id; } catch { return config?.devUsers?.[2]?.id; } };
export const setDevUser = (id) => { try { localStorage.setItem('pda.devUser', id); } catch { /* ignore */ } };

async function headers() {
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

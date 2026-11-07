// Minimal Microsoft Graph client: OAuth 2.0 client-credentials token for the backend's Entra app
// registration, retries on throttling (429/503/504 honouring Retry-After), typed errors.
// `fetchImpl` is injectable so the adapter can be tested without a tenant.

export class GraphError extends Error {
  constructor(status, body, method, url) {
    super(`Graph ${method} ${url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')} failed with ${status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
    this.status = status; this.code = body?.error?.code; this.body = body;
  }
}

export class GraphClient {
  // auth: 'secret' (client credentials of an app registration) or 'managedIdentity' (the App Service
  // identity; no secret exists anywhere). credential is injectable for tests.
  constructor({ tenantId, clientId, clientSecret, auth = 'secret', credential, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { tenantId, clientId, clientSecret, auth, credential, fetch: fetchImpl, sleep });
    this.token = null; this.tokenExp = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    if (this.auth === 'managedIdentity') {
      if (!this.credential) {
        const { ManagedIdentityCredential } = await import('@azure/identity');
        this.credential = new ManagedIdentityCredential(this.clientId ? { clientId: this.clientId } : undefined);
      }
      let t;
      try { t = await this.credential.getToken('https://graph.microsoft.com/.default'); } catch (e) { throw Object.assign(new Error(`Managed identity token request failed: ${e.message}`), { status: 502, code: 'AUTH_FAILED' }); }
      this.token = t.token; this.tokenExp = t.expiresOnTimestamp;
      return this.token;
    }
    if (!this.tenantId || !this.clientId || !this.clientSecret) throw Object.assign(new Error('SharePoint is not configured: tenantId, clientId and client secret are required.'), { status: 503, code: 'NOT_CONFIGURED' });
    const res = await this.fetch(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Entra ID token request failed: ${body.error_description || body.error}`), { status: 502, code: 'AUTH_FAILED' });
    this.token = body.access_token; this.tokenExp = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  async request(method, pathOrUrl, { body, headers = {}, raw = false, attempt = 0 } = {}) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
    const isBinary = Buffer.isBuffer(body);
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.getToken()}`, ...(body !== undefined && !isBinary ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
    });
    if ([429, 503, 504].includes(res.status) && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 1000;
      await this.sleep(wait);
      return this.request(method, pathOrUrl, { body, headers, raw, attempt: attempt + 1 });
    }
    if (!res.ok) {
      let b; try { b = await res.json(); } catch { b = {}; }
      throw new GraphError(res.status, b, method, url);
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  get(p, o) { return this.request('GET', p, o); }
  post(p, body, o = {}) { return this.request('POST', p, { ...o, body }); }
  patch(p, body, o = {}) { return this.request('PATCH', p, { ...o, body }); }
  put(p, body, o = {}) { return this.request('PUT', p, { ...o, body }); }
}

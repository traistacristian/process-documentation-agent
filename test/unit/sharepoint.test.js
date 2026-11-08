// SharePoint adapter against an in-memory fake of the Microsoft Graph endpoints it uses.
// This verifies request construction, folder/metadata handling, version-safe updates and conflict
// detection. It is NOT a substitute for a test against a real tenant (see docs/TESTING.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharePointRepository } from '../../server/repo/sharepoint.js';
import { loadConfig } from '../../server/config.js';
import { emptyDoc, emptyStep } from '../../server/engine/schema.js';

function fakeGraph() {
  const items = new Map(); let n = 0; const calls = [];
  const byPath = (p) => [...items.values()].find((i) => i.path === p);
  const mk = (p, folder, content) => {
    const parentPath = p.split('/').slice(0, -1).join('/');
    const it = { id: `it${++n}`, name: p.split('/').pop(), path: p, folder, content, eTag: `"e${n}.1"`, ver: 1, fields: {}, parentId: byPath(parentPath)?.id || 'root' };
    items.set(it.id, it); return it;
  };
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const view = (it) => ({ id: it.id, name: it.name, eTag: it.eTag, webUrl: `https://contoso.sharepoint.com/sites/ITOps/Documents/${it.path}`, parentReference: { id: it.parentId, path: `/drives/d1/root:/${it.path.split('/').slice(0, -1).join('/')}` } });
  const fetchImpl = async (url, opt = {}) => {
    const u = decodeURIComponent(String(url)); const m = opt.method || 'GET';
    calls.push(`${m} ${u.replace('https://graph.microsoft.com/v1.0', '')}`);
    if (u.includes('/oauth2/v2.0/token')) return json(200, { access_token: 'T', expires_in: 3600 });
    if (u.endsWith('/sites/contoso.sharepoint.com:/sites/ITOps')) return json(200, { id: 'site1' });
    if (u.includes('/sites/site1/drives?')) return json(200, { value: [{ id: 'd1', name: 'Documents', webUrl: 'https://x' }] });
    if (u.includes('/drives/d1/list?')) return json(200, { id: 'list1' });
    if (u.includes('/lists/list1/columns') && m === 'GET') return json(200, { value: [{ name: 'Title' }] });
    if (u.includes('/lists/list1/columns') && m === 'POST') return json(201, {});
    if (u.includes('/lists/list1/items')) {
      // Like real SharePoint: "ne null" is not a supported list-item filter.
      if (/ne%20null|ne null/.test(u)) return json(400, { error: { code: 'invalidRequest', message: 'Invalid filter clause' } });
      const pid = /PDA_ProcessId eq '([^']+)'/.exec(decodeURIComponent(u))?.[1];
      const docs = [...items.values()].filter((i) => !pid || i.fields.PDA_ProcessId === pid);
      return json(200, { value: docs.map((i) => ({ fields: { ...i.fields }, driveItem: { id: i.id, name: i.name, webUrl: view(i).webUrl, parentReference: { id: i.parentId } }, createdDateTime: '2026-01-01', lastModifiedDateTime: '2026-01-02' })) });
    }
    let r;
    if ((r = /\/drives\/d1\/root:\/(.+?):\/content$/.exec(u)) && m === 'PUT') {
      const ex = byPath(r[1]);
      if (opt.headers?.['if-match'] && (!ex || ex.eTag !== opt.headers['if-match'])) return json(412, { error: { code: 'notAllowed', message: 'ETag does not match' } });
      const it = ex || mk(r[1], false); it.content = Buffer.from(opt.body); it.ver++; it.eTag = `"${it.id}.${it.ver}"`; return json(ex ? 200 : 201, view(it));
    }
    if ((r = /\/drives\/d1\/items\/(it\d+)\/content$/.exec(u)) && m === 'PUT') { const it = items.get(r[1]); it.content = Buffer.from(opt.body); it.ver++; it.eTag = `"${it.id}.${it.ver}"`; return json(200, view(it)); }
    if ((r = /\/drives\/d1\/items\/(it\d+)\/content$/.exec(u))) return new Response(items.get(r[1]).content);
    if ((r = /\/drives\/d1\/items\/(it\d+)\/listItem\/fields$/.exec(u))) { Object.assign(items.get(r[1]).fields, JSON.parse(opt.body)); return json(200, {}); }
    if ((r = /\/drives\/d1\/items\/(it\d+)\/versions/.exec(u))) return json(200, { value: Array.from({ length: items.get(r[1]).ver - 1 }, (_, i) => ({ id: `${i + 1}.0`, lastModifiedDateTime: '2026-01-01' })) });
    if ((r = /\/drives\/d1\/items\/(it\d+):\/(.+?):\/content$/.exec(u))) { const it = byPath(`${items.get(r[1]).path}/${r[2]}`); return it ? new Response(it.content) : json(404, { error: { code: 'itemNotFound', message: 'nf' } }); }
    if ((r = /\/drives\/d1\/items\/(it\d+):\/(.+)$/.exec(u))) { const it = byPath(`${items.get(r[1]).path}/${r[2]}`); return it ? json(200, view(it)) : json(404, { error: { code: 'itemNotFound', message: 'nf' } }); }
    if ((r = /\/drives\/d1\/items\/(it\d+)(\?.*)?$/.exec(u)) && m === 'GET') return json(200, view(items.get(r[1])));
    if ((r = /\/drives\/d1\/items\/(it\d+)$/.exec(u)) && m === 'PATCH') { const it = items.get(r[1]); const b = JSON.parse(opt.body); const oldPath = it.path; it.name = b.name; it.path = it.path.split('/').slice(0, -1).concat(b.name).join('/'); for (const c of items.values()) if (c.path.startsWith(`${oldPath}/`)) c.path = it.path + c.path.slice(oldPath.length); return json(200, view(it)); }
    if ((r = /\/drives\/d1\/root:\/(.+?)$/.exec(u)) && m === 'GET') { const it = byPath(r[1]); return it ? json(200, view(it)) : json(404, { error: { code: 'itemNotFound', message: 'nf' } }); }
    if (u.endsWith('/drives/d1/root/children') || /\/drives\/d1\/root:\/(.+?):\/children$/.test(u)) {
      const parent = /root:\/(.+?):\/children/.exec(u)?.[1]; const b = JSON.parse(opt.body);
      const p = parent ? `${parent}/${b.name}` : b.name; if (byPath(p)) return json(409, { error: { code: 'nameAlreadyExists', message: 'exists' } });
      return json(201, view(mk(p, true)));
    }
    return json(500, { error: { message: `unhandled ${m} ${u}` } });
  };
  return { fetchImpl, items, calls };
}

const cfg = () => { const c = loadConfig(); c.repository.mode = 'sharepoint'; Object.assign(c.repository.sharepoint, { tenantId: 't', clientId: 'c', clientSecret: 's', siteUrl: 'https://contoso.sharepoint.com/sites/ITOps', libraryName: 'Documents' }); return c; };
const doc = (v) => { const d = emptyDoc({ processId: 'PRC-2026-ABC123', title: 'Grant helpdesk permissions', version: v, category: 'Identity & Access Management', status: 'Published', owner: 'Alex' }); d.steps = [{ ...emptyStep(1), id: 's1', title: 'Open portal', screenshotIds: ['shot_ab'] }]; return d; };

test('provisioning, publishing, retrieval, versioning and conflict detection via Graph', async () => {
  const g = fakeGraph();
  const repo = new SharePointRepository(cfg(), { fetchImpl: g.fetchImpl, sleep: async () => {} });
  assert.equal((await repo.status()).connected, true);
  await repo.ensureSchema(['Identity & Access Management', 'Network']);
  assert.ok(g.calls.some((c) => c.startsWith('POST /sites/site1/lists/list1/columns')));
  assert.ok([...g.items.values()].some((i) => i.path === 'IT Process Documentation/Network' && i.folder));

  const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pda-sp-')), 'shot_ab.jpg'); fs.writeFileSync(shot, 'jpeg');
  const r1 = await repo.publish({ doc: doc('1.0'), docx: Buffer.from('PK-v1'), screenshots: [{ id: 'shot_ab', path: shot }], expectedEtag: null });
  assert.equal(r1.location, 'IT Process Documentation/Identity & Access Management/Grant helpdesk permissions', 'folders are named after the process, not the id');
  const docItem = [...g.items.values()].find((i) => i.name.endsWith('.docx'));
  assert.equal(docItem.name, 'Grant helpdesk permissions.docx');
  assert.equal(docItem.fields.PDA_Version, '1.0');
  assert.equal(docItem.fields.PDA_Category, 'Identity & Access Management');

  const list = await repo.list();
  assert.equal(list[0].processId, 'PRC-2026-ABC123');
  const got = await repo.get('PRC-2026-ABC123');
  assert.equal(got.doc.info.version, '1.0');
  assert.equal(got.etag, r1.etag);
  assert.equal((await repo.screenshot('PRC-2026-ABC123', 'shot_ab')).buffer.toString(), 'jpeg');

  await assert.rejects(repo.publish({ doc: doc('1.0'), docx: Buffer.from('x'), screenshots: [], expectedEtag: null }), { code: 'DUPLICATE' });
  const r2 = await repo.publish({ doc: doc('1.1'), docx: Buffer.from('PK-v2'), screenshots: [], expectedEtag: got.etag });
  assert.equal(docItem.content.toString(), 'PK-v2', 'the same item is updated, so SharePoint keeps the version history');
  assert.equal(docItem.fields.PDA_Version, '1.1');
  assert.equal((await repo.get('PRC-2026-ABC123')).versions.length, 2);
  await assert.rejects(repo.publish({ doc: doc('1.2'), docx: Buffer.from('x'), screenshots: [], expectedEtag: got.etag }), { code: 'CONFLICT' }, 'stale etag must not overwrite');
  assert.notEqual(r2.etag, got.etag);
  // The author picks another name: folder and file are renamed in place, history stays on the same item.
  const d3 = doc('1.2'); d3.info.fileName = 'Helpdesk rights for a user';
  const r3 = await repo.publish({ doc: d3, docx: Buffer.from('PK-v3'), screenshots: [], expectedEtag: r2.etag });
  assert.equal(r3.location, 'IT Process Documentation/Identity & Access Management/Helpdesk rights for a user');
  assert.equal(docItem.name, 'Helpdesk rights for a user.docx');
  assert.equal(docItem.content.toString(), 'PK-v3');
  assert.equal((await repo.get('PRC-2026-ABC123')).doc.info.version, '1.2');
});

test('missing configuration and throttling are handled', async () => {
  const c = cfg(); c.repository.sharepoint.clientSecret = ''; delete process.env.SP_CLIENT_SECRET;
  const st = await new SharePointRepository(c, { fetchImpl: async () => new Response('{}') }).status();
  assert.equal(st.connected, false);
  assert.equal(st.code, 'NOT_CONFIGURED');
  let n = 0;
  const g = fakeGraph();
  const throttled = async (url, opt) => (String(url).includes('/sites/contoso') && n++ < 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } }) : g.fetchImpl(url, opt));
  assert.equal((await new SharePointRepository(cfg(), { fetchImpl: throttled, sleep: async () => {} }).status()).connected, true);
  assert.equal(n, 3);
});

test('managed identity: Graph token comes from the App Service identity, no secret needed', async () => {
  const g = fakeGraph();
  const c = cfg(); c.repository.sharepoint.clientSecret = ''; c.repository.sharepoint.auth = 'managedIdentity';
  let scopes = [];
  const credential = { getToken: async (s) => { scopes.push(s); return { token: 'mi-token', expiresOnTimestamp: Date.now() + 3600_000 }; } };
  const seen = [];
  const fetchImpl = (url, opt = {}) => { seen.push(opt.headers?.authorization); return g.fetchImpl(url, opt); };
  const repo = new SharePointRepository(c, { fetchImpl, sleep: async () => {}, credential });
  assert.equal((await repo.status()).connected, true);
  assert.deepEqual([...new Set(scopes)], ['https://graph.microsoft.com/.default']);
  assert.ok(seen.every((h) => h === 'Bearer mi-token'));
  assert.ok(!g.calls.some((x) => x.includes('oauth2')));
});

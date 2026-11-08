// Invited users on the Administration page: the API records each invitation, lists it for Admins
// and lets an Admin change an invited guest's role. Microsoft Graph is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../../server/config.js';
import { createApp } from '../../server/app.js';

const G = { Contributor: '11111111-1111-1111-1111-111111111111', Approver: '22222222-2222-2222-2222-222222222222', Admin: '33333333-3333-3333-3333-333333333333' };
const GUEST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const members = Object.fromEntries(Object.values(G).map((id) => [id, new Set()]));
const graph = {
  async get(p) {
    const m = /^\/groups\/([^/]+)\/members/.exec(p);
    if (m) return { value: [...members[m[1]]].map((id) => ({ id, displayName: 'Tess Tester', mail: 'tess@example.com', userType: 'Guest', externalUserState: 'Accepted' })) };
    return { id: GUEST, displayName: 'Tess Tester', userType: 'Guest' };
  },
  async post(p, body) {
    if (p === '/invitations') return { invitedUser: { id: GUEST, userType: 'Guest' } };
    const gid = /^\/groups\/([^/]+)\/members/.exec(p)[1]; members[gid].add(body['@odata.id'].split('/').pop()); return null;
  },
  async delete(p) { const [, gid, id] = /^\/groups\/([^/]+)\/members\/([^/]+)/.exec(p); members[gid].delete(id); return null; },
};

let srv; let base; let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-inv-api-'));
  const cfg = loadConfig({ dataDir: dir, ai: { provider: 'rules' }, invitations: { groups: G }, auth: { humanCheck: { enabled: false } } });
  cfg.repository.local.path = path.join(dir, 'repository');
  srv = http.createServer(createApp(cfg, { inviteGraph: graph }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const call = async (method, p, body, user = 'admin') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': user }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('invitations are listed for Admins and an invited guest can be given another role', async () => {
  assert.equal((await call('POST', '/api/admin/testers', { email: 'tess@example.com', role: 'Contributor' })).status, 200);
  let t = (await call('GET', '/api/admin/testers')).body;
  assert.equal(t.invitations.length, 1);
  const [inv] = t.invitations;
  assert.equal(inv.email, 'tess@example.com'); assert.equal(inv.role, 'Contributor'); assert.equal(inv.status, 'accepted');
  assert.equal(inv.invitedBy.id, 'admin'); assert.ok(inv.invitedAt);

  assert.equal((await call('PUT', `/api/admin/testers/${GUEST}/role`, { role: 'Approver' }, 'sam')).status, 403, 'Admins only');
  const r = await call('PUT', `/api/admin/testers/${GUEST}/role`, { role: 'Approver' });
  assert.equal(r.status, 200);
  t = (await call('GET', '/api/admin/testers')).body;
  assert.equal(t.invitations[0].role, 'Approver');
  assert.deepEqual(t.people.find((p) => p.id === GUEST).roles, ['Approver']);
  const audit = (await call('GET', '/api/admin/audit')).body;
  assert.ok(audit.some((e) => e.action === 'admin.tester_role_changed' && e.role === 'Approver'));
});

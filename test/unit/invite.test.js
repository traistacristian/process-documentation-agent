// Inviting testers: guest invitation + role group membership through a fake Microsoft Graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInviter } from '../../server/invite.js';
import { Store } from '../../server/store.js';

const G = { Contributor: '11111111-1111-1111-1111-111111111111', Approver: '22222222-2222-2222-2222-222222222222', Admin: '' };
const GUEST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; const MEMBER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fakeGraph(extraGroups = {}) {
  const calls = []; const members = { [G.Contributor]: new Set([MEMBER]), [G.Approver]: new Set(), ...extraGroups };
  const users = { [GUEST]: { id: GUEST, displayName: 'Tess Tester', mail: 'tess@example.com', userType: 'Guest', externalUserState: 'PendingAcceptance' }, [MEMBER]: { id: MEMBER, displayName: 'Inge Intern', userPrincipalName: 'inge@contoso.example', userType: 'Member' } };
  return {
    calls,
    async get(p) { calls.push(['GET', p]); const m = /^\/groups\/([^/]+)\/members/.exec(p); if (m) return { value: [...members[m[1]]].map((id) => users[id]) }; const u = /^\/users\/([^?]+)/.exec(p); return users[u[1]]; },
    async post(p, body) {
      calls.push(['POST', p, body]);
      if (p === '/invitations') return { invitedUser: { id: GUEST, userType: 'Guest' } };
      const gid = /^\/groups\/([^/]+)\/members/.exec(p)[1]; const id = body['@odata.id'].split('/').pop();
      if (members[gid].has(id)) throw Object.assign(new Error('One or more added object references already exist'), { status: 400 });
      members[gid].add(id); return null;
    },
    async delete(p) { calls.push(['DELETE', p]); const [, gid, id] = /^\/groups\/([^/]+)\/members\/([^/]+)/.exec(p); members[gid].delete(id); return null; },
  };
}
const cfg = (groups = G) => ({ auth: { mode: 'entra', entra: {} }, repository: { sharepoint: {} }, invitations: { groups } });

test('invites a guest into the role group, lists people and removes only guests', async () => {
  const graph = fakeGraph(); const inv = createInviter(cfg(), { graph });
  const r = await inv.invite({ email: ' Tess@Example.com ', name: 'Tess Tester', role: 'Approver', redirectUrl: 'https://app.example', invitedBy: 'IT Admin' });
  assert.equal(r.email, 'tess@example.com');
  const invitation = graph.calls.find((c) => c[1] === '/invitations')[2];
  assert.equal(invitation.invitedUserEmailAddress, 'tess@example.com'); assert.equal(invitation.sendInvitationMessage, true); assert.equal(invitation.inviteRedirectUrl, 'https://app.example');
  await inv.invite({ email: 'tess@example.com', role: 'Approver', redirectUrl: 'x', invitedBy: 'IT Admin' }); // already a member: no error
  const people = await inv.list();
  assert.deepEqual(people.map((p) => [p.name, p.guest, p.roles.join()]), [['Inge Intern', false, 'Contributor'], ['Tess Tester', true, 'Approver']]);
  await assert.rejects(inv.remove({ userId: MEMBER, role: 'Contributor' }), (e) => e.status === 403);
  await inv.remove({ userId: GUEST, role: 'Approver' });
  assert.deepEqual((await inv.list()).map((p) => p.name), ['Inge Intern']);
});

test('validates input and explains missing setup', async () => {
  const inv = createInviter(cfg(), { graph: fakeGraph() });
  await assert.rejects(inv.invite({ email: 'not-an-address', role: 'Contributor' }), (e) => e.status === 400);
  await assert.rejects(inv.invite({ email: 'a@b.example', role: 'Admin' }), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(inv.invite({ email: 'a@b.example', role: 'Owner' }), (e) => e.status === 400);
  assert.equal(createInviter(cfg({ Contributor: '', Approver: '', Admin: '' }), { graph: fakeGraph() }).status().configured, false);
  const dev = createInviter({ auth: { mode: 'dev', entra: {} }, invitations: { groups: G } });
  assert.equal(dev.status().available, false);
  await assert.rejects(dev.list(), (e) => e.code === 'NOT_AVAILABLE');
});

test('reports which Graph permissions the app token carries', async () => {
  const payload = Buffer.from(JSON.stringify({ roles: ['Sites.Selected', 'User.Invite.All'], iat: 1700000000 })).toString('base64url');
  const graph = { ...fakeGraph(), getToken: async () => `x.${payload}.y` };
  const p = await createInviter(cfg(), { graph }).permissions();
  assert.deepEqual(p.missing, ['GroupMember.ReadWrite.All']);
  assert.ok(!JSON.stringify(p).includes(payload), 'the token itself is never returned');
});

test('records every invitation and keeps its status and role in step with the role groups', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-inv-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir); const graph = fakeGraph();
  const inv = createInviter(cfg(), { graph, store });
  await inv.invite({ email: 'Tess@Example.com', name: 'Tess Tester', role: 'Contributor', redirectUrl: 'x', invitedBy: { id: 'admin', name: 'IT Admin' } });
  let [r] = inv.invitations();
  assert.equal(r.email, 'tess@example.com'); assert.equal(r.role, 'Contributor'); assert.equal(r.status, 'pending');
  assert.deepEqual(r.invitedBy, { id: 'admin', name: 'IT Admin' }); assert.ok(r.invitedAt); assert.equal(r.userId, GUEST);

  // Change the role: the guest ends up in exactly the new group.
  await inv.setRole({ userId: GUEST, role: 'Approver', by: { id: 'admin', name: 'IT Admin' } });
  const people = await inv.list();
  assert.deepEqual(people.find((p) => p.id === GUEST).roles, ['Approver']);
  [r] = inv.invitations(people);
  assert.equal(r.role, 'Approver'); assert.deepEqual(r.history.map((h) => h.action), ['invited', 'role_changed']);
  await assert.rejects(inv.setRole({ userId: MEMBER, role: 'Approver' }), (e) => e.code === 'NOT_GUEST');
  await assert.rejects(inv.setRole({ userId: GUEST, role: 'Owner' }), (e) => e.status === 400);

  // Removing the last role shows the invitation as removed; inviting again with the same address keeps one record.
  await inv.remove({ userId: GUEST, role: 'Approver' });
  [r] = inv.invitations(await inv.list());
  assert.equal(r.status, 'removed');
  await inv.invite({ email: 'tess@example.com', role: 'Contributor', redirectUrl: 'x', invitedBy: 'IT Admin' });
  assert.equal(inv.invitations().length, 1);

  // A failed first invitation is recorded too.
  const failing = createInviter(cfg(), { store, graph: { ...fakeGraph(), post: async () => { throw Object.assign(new Error('nope'), { status: 403 }); } } });
  await assert.rejects(failing.invite({ email: 'new@example.com', role: 'Contributor', redirectUrl: 'x', invitedBy: 'IT Admin' }));
  const failed = failing.invitations().find((x) => x.email === 'new@example.com');
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /permission/);
});

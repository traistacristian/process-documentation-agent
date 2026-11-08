// Inviting testers from the app (Administration → Testers). An Admin enters an e-mail address and a
// role; the app sends a Microsoft Entra B2B guest invitation and adds the guest to the Entra group
// that holds that app role. Guests sign in with their own account and need no licence.
//
// Needs, on the App Service managed identity, the Microsoft Graph application permissions
// User.Invite.All and GroupMember.ReadWrite.All (scripts/Grant-InvitePermissions.ps1), and the object
// ids of the three role groups in the admin settings. Only guests can be removed here; members of your
// own organisation are never changed by the app.
//
// Every invitation is also recorded in the store (collection "invitations", one record per e-mail
// address): e-mail, name, role, who invited, when, the Graph user id and a status (pending, accepted,
// member, removed, failed). The Administration page lists these records and lets an Admin change an
// invited guest's role, which moves the guest to exactly one role group.
import crypto from 'node:crypto';
import { GraphClient } from './repo/graph.js';
import { ROLES } from './auth.js';

const ROLE_NAMES = [ROLES.CONTRIBUTOR, ROLES.APPROVER, ROLES.ADMIN];
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

const recordId = (email) => `inv_${crypto.createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
const who = (u) => (u && typeof u === 'object' ? { id: u.id ?? null, name: u.name ?? null } : { id: null, name: u ? String(u) : null });
// Status of an invited person from what the role groups say right now.
const statusOf = (person) => {
  if (!person || !person.roles.length) return 'removed';
  if (!person.guest) return 'member';
  return person.state === 'PendingAcceptance' ? 'pending' : 'accepted';
};

export function createInviter(cfg, { graph, store } = {}) {
  const groups = () => cfg.invitations?.groups || {};
  const configured = () => ROLE_NAMES.some((r) => GUID.test(groups()[r] || ''));
  const available = () => cfg.auth.mode === 'entra' || !!graph;
  let client = graph;
  const g = () => {
    if (!available()) throw err(409, 'Inviting testers needs Microsoft sign-in (Entra ID mode). In the demo mode the test users are fixed.', 'NOT_AVAILABLE');
    if (!configured()) throw err(409, 'Enter the object ids of the role groups first (Administration → Testers).', 'NOT_CONFIGURED');
    const sp = cfg.repository.sharepoint || {};
    client ??= new GraphClient({ tenantId: sp.tenantId || cfg.auth.entra.tenantId, clientId: sp.clientId, clientSecret: process.env[sp.clientSecretEnv] || sp.clientSecret, auth: sp.auth || 'managedIdentity' });
    return client;
  };
  const groupOf = (role) => {
    const id = groups()[role];
    if (!ROLE_NAMES.includes(role)) throw err(400, 'Unknown role');
    if (!GUID.test(id || '')) throw err(409, `No group is set up for the ${role} role.`, 'NOT_CONFIGURED');
    return id;
  };
  const explain = (e) => {
    if (e.status === 401 || e.status === 403) return err(502, 'Microsoft Graph refused the request (missing permission). Check that the app has User.Invite.All and GroupMember.ReadWrite.All (scripts/Grant-InvitePermissions.ps1) and that guest invitations are allowed in Entra ID → External collaboration settings. After granting, the app can take up to 24 hours to receive the new permission; restarting the app sometimes helps sooner.', 'GRAPH_FORBIDDEN');
    return err(e.status && e.status < 500 ? 400 : 502, `Microsoft Graph: ${e.message}`, e.code);
  };

  const save = (email, change) => {
    if (!store) return null;
    const id = recordId(email); const now = new Date().toISOString();
    const old = store.get('invitations', id);
    const { event, ...fields } = change;
    const rec = { id, email, name: null, role: null, userId: null, invitedBy: null, invitedAt: now, status: 'pending', history: [], ...old, ...fields, updatedAt: now };
    if (event) rec.history = [...(old?.history || []), { at: now, ...event }].slice(-50);
    return store.put('invitations', rec);
  };
  const findByUser = (userId) => store?.list('invitations').find((r) => r.userId === userId) || null;

  // Graph: the guest invitation e-mail, then membership in the role group.
  async function sendInvitation({ c, email, name, role, groupId, redirectUrl, invitedBy }) {
    let user;
    try {
      const inv = await c.post('/invitations', {
        invitedUserEmailAddress: email,
        ...(name ? { invitedUserDisplayName: name } : {}),
        inviteRedirectUrl: redirectUrl,
        sendInvitationMessage: true,
        invitedUserMessageInfo: { customizedMessageBody: `${invitedBy} invites you to test the Process Documentation Agent with the role ${role}. Accept the invitation, then sign in with this e-mail address.` },
      });
      user = inv.invitedUser;
    } catch (e) { throw explain(e); }
    try {
      await c.post(`/groups/${groupId}/members/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${user.id}` });
    } catch (e) {
      // Already a member: fine (Graph answers 400 "One or more added object references already exist").
      if (!(e.status === 400 && /already exist/i.test(e.message))) throw explain(e);
    }
    return { id: user.id, email, role, existing: user.userType !== 'Guest' };
  }

  const api = {
    status: () => ({ available: available(), configured: configured(), groups: groups() }),

    // Which Graph application permissions the app's current token carries (roles claim only; the token is never returned).
    async permissions() {
      if (!available()) throw err(409, 'Only available with Microsoft sign-in (Entra ID mode).', 'NOT_AVAILABLE');
      const sp = cfg.repository.sharepoint || {};
      client ??= new GraphClient({ tenantId: sp.tenantId || cfg.auth.entra.tenantId, clientId: sp.clientId, clientSecret: process.env[sp.clientSecretEnv] || sp.clientSecret, auth: sp.auth || 'managedIdentity' });
      if (!client.getToken) return { roles: [], missing: [] };
      const tok = await client.getToken();
      let claims = {};
      try { claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')); } catch { /* not a JWT */ }
      const roles = claims.roles || [];
      return { roles, missing: ['User.Invite.All', 'GroupMember.ReadWrite.All'].filter((r) => !roles.includes(r)), issuedAt: claims.iat ? new Date(claims.iat * 1000).toISOString() : null, appId: claims.appid || claims.azp || null };
    },

    // Everyone in the three role groups, with their role(s); guests are marked.
    async list() {
      const c = g(); const people = new Map();
      for (const role of ROLE_NAMES) {
        if (!GUID.test(groups()[role] || '')) continue;
        let url = `/groups/${groups()[role]}/members/microsoft.graph.user?$select=id,displayName,mail,userPrincipalName,userType,externalUserState&$top=200`;
        try {
          while (url) {
            const page = await c.get(url);
            for (const u of page.value || []) {
              const p = people.get(u.id) || { id: u.id, name: u.displayName, email: u.mail || u.userPrincipalName, guest: u.userType === 'Guest', state: u.externalUserState || null, roles: [] };
              p.roles.push(role); people.set(u.id, p);
            }
            url = page['@odata.nextLink'] || null;
          }
        } catch (e) { throw explain(e); }
      }
      return [...people.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },

    async invite({ email, name, role, redirectUrl, invitedBy }) {
      email = String(email || '').trim().toLowerCase(); name = String(name || '').trim().slice(0, 100);
      if (!EMAIL.test(email)) throw err(400, 'Enter a valid e-mail address');
      const groupId = groupOf(role); const c = g();
      const by = who(invitedBy);
      try {
        const r = await sendInvitation({ c, email, name, role, groupId, redirectUrl, invitedBy: by.name || 'An administrator' });
        save(email, { name: name || null, role, userId: r.id, invitedBy: by, invitedAt: new Date().toISOString(), status: r.existing ? 'member' : 'pending', error: null, event: { action: 'invited', role, by } });
        return r;
      } catch (e) {
        // A failed repeat invitation keeps the earlier, working record; only a first attempt is marked failed.
        const earlier = store?.get('invitations', recordId(email));
        if (earlier?.userId) save(email, { error: e.message, event: { action: 'invite_failed', role, by } });
        else save(email, { name: name || null, role, invitedBy: by, invitedAt: new Date().toISOString(), status: 'failed', error: e.message, event: { action: 'invite_failed', role, by } });
        throw e;
      }
    },

    async remove({ userId, role, by }) {
      if (!GUID.test(userId || '')) throw err(400, 'Unknown user');
      const groupId = groupOf(role); const c = g();
      let u;
      try { u = await c.get(`/users/${userId}?$select=id,userType,displayName`); } catch (e) { throw explain(e); }
      if (u.userType !== 'Guest') throw err(403, 'Only guests can be removed here. Change roles of people in your organisation in Microsoft Entra ID.', 'NOT_GUEST');
      try { await c.delete(`/groups/${groupId}/members/${userId}/$ref`); } catch (e) { if (e.status !== 404) throw explain(e); }
      const rec = findByUser(userId);
      if (rec) save(rec.email, { event: { action: 'role_removed', role, by: who(by) } });
      return { id: userId, role, name: u.displayName };
    },

    // Every recorded invitation, newest first. With people (the current members of the role groups,
    // from list()) the status and role are refreshed from Entra and the records are updated.
    invitations(people = null) {
      if (!store) return [];
      const byId = people ? new Map(people.map((p) => [p.id, p])) : null;
      return store.list('invitations').map((r) => {
        if (!byId || !r.userId || r.status === 'failed') return r;
        const p = byId.get(r.userId); const status = statusOf(p);
        const role = p?.roles.length ? (p.roles.includes(r.role) && p.roles.length === 1 ? r.role : p.roles.join(', ')) : r.role;
        const guest = p ? p.guest : r.guest ?? null;
        return status === r.status && role === r.role && guest === r.guest ? r : save(r.email, { status, role, guest });
      }).sort((a, b) => String(b.invitedAt).localeCompare(String(a.invitedAt)));
    },

    // Gives an invited guest exactly this role: adds them to its group first (so they never lose
    // access in between), then takes them out of the other role groups.
    async setRole({ userId, role, by }) {
      if (!GUID.test(userId || '')) throw err(400, 'Unknown user');
      const groupId = groupOf(role); const c = g();
      let u;
      try { u = await c.get(`/users/${userId}?$select=id,userType,displayName,mail,userPrincipalName`); } catch (e) { throw explain(e); }
      if (u.userType !== 'Guest') throw err(403, 'Only guests can be changed here. Change roles of people in your organisation in Microsoft Entra ID.', 'NOT_GUEST');
      try {
        await c.post(`/groups/${groupId}/members/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` });
      } catch (e) { if (!(e.status === 400 && /already exist/i.test(e.message))) throw explain(e); }
      for (const other of ROLE_NAMES) {
        if (other === role || !GUID.test(groups()[other] || '')) continue;
        try { await c.delete(`/groups/${groups()[other]}/members/${userId}/$ref`); } catch (e) { if (e.status !== 404) throw explain(e); }
      }
      const rec = findByUser(userId);
      if (rec) save(rec.email, { role, status: rec.status === 'removed' ? 'pending' : rec.status, event: { action: 'role_changed', from: rec.role, role, by: who(by) } });
      return { id: userId, role, name: u.displayName };
    },
  };
  return api;
}

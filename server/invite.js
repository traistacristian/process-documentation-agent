// Inviting testers from the app (Administration → Testers). An Admin enters an e-mail address and a
// role; the app sends a Microsoft Entra B2B guest invitation and adds the guest to the Entra group
// that holds that app role. Guests sign in with their own account and need no licence.
//
// Needs, on the App Service managed identity, the Microsoft Graph application permissions
// User.Invite.All and GroupMember.ReadWrite.All (scripts/Grant-InvitePermissions.ps1), and the object
// ids of the three role groups in the admin settings. Only guests can be removed here; members of your
// own organisation are never changed by the app.
import { GraphClient } from './repo/graph.js';
import { ROLES } from './auth.js';

const ROLE_NAMES = [ROLES.CONTRIBUTOR, ROLES.APPROVER, ROLES.ADMIN];
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

export function createInviter(cfg, { graph } = {}) {
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
    if (e.status === 403) return err(502, 'Microsoft Graph refused the request. The app needs the permissions User.Invite.All and GroupMember.ReadWrite.All (run scripts/Grant-InvitePermissions.ps1), and guest invitations must be allowed in Entra ID → External collaboration settings.', 'GRAPH_FORBIDDEN');
    return err(e.status && e.status < 500 ? 400 : 502, `Microsoft Graph: ${e.message}`, e.code);
  };

  return {
    status: () => ({ available: available(), configured: configured(), groups: groups() }),

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
    },

    async remove({ userId, role }) {
      if (!GUID.test(userId || '')) throw err(400, 'Unknown user');
      const groupId = groupOf(role); const c = g();
      let u;
      try { u = await c.get(`/users/${userId}?$select=id,userType,displayName`); } catch (e) { throw explain(e); }
      if (u.userType !== 'Guest') throw err(403, 'Only guests can be removed here. Change roles of people in your organisation in Microsoft Entra ID.', 'NOT_GUEST');
      try { await c.delete(`/groups/${groupId}/members/${userId}/$ref`); } catch (e) { if (e.status !== 404) throw explain(e); }
      return { id: userId, role, name: u.displayName };
    },
  };
}

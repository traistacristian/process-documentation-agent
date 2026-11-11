# Security, privacy and permission model

## Roles (Entra ID app roles on the API app registration)

| Role | Can | Cannot |
|---|---|---|
| **Contributor** (`ProcessDoc.Contributor`) | Start/pause/stop own recordings, see own recordings and drafts, edit own drafts, answer clarifications | Approve, publish, see others' recordings |
| **Approver** (`ProcessDoc.Approver`) | Everything a Contributor can, plus see all drafts, approve, reject, publish | Change settings |
| **Admin** (`ProcessDoc.Admin`) | Everything, plus categories, capture policy, retention, provisioning, audit log | – |

Optional separation of duties (`auth.requireSeparateApprover: true`): the person who recorded a process cannot approve it.

Read access to **published** documents is governed by SharePoint permissions on the library, not by the app. The app reads through its own Graph identity, so restrict the library to the audience that should see IT procedures. Optionally (`assignOwnerPermissions`) the process owner gets edit rights on the document item.

## Capture safeguards (implemented)

| Requirement | How |
|---|---|
| Explicitly activated | A recording only exists after the user ticks the consent statement and clicks Start. Capture clients do nothing unless paired with an active recording. |
| Always visible | Red recording banner + timer in the app, `● REC` in the tab title, `REC` badge on the extension icon, always-on-top indicator from the desktop agent. |
| Pause / stop | Pause and Stop in the app; the server drops events while paused (even from an outdated client), and Stop revokes the capture token. |
| No passwords / tokens / secrets | Password fields, `autocomplete=cc-*`/`one-time-code` fields and configurable sensitive labels are never read. Typed text is not captured by default (only "a value was entered"). URLs lose sensitive query parameters (`code`, `token`, `sig`, …). Free text is scanned for JWTs, bearer tokens, API keys, connection-string keys, private keys, card numbers (Luhn) and IBANs. Redaction runs on the client **and** the server. |
| Mask personal data | E-mail addresses are masked in events (`j***@contoso.com`). Sensitive fields are blurred in screenshots before capture. The browser add-in covers e-mail addresses and international phone numbers on the page before each screenshot. With AI configured, every screenshot (add-in, desktop agent, screen sharing) is checked by Claude for names, e-mail addresses, phone numbers, addresses, personal IDs, profile photos and clear-text secrets, and those areas are pixelated in the stored file before anyone can view it or it is used for a description, draft or publication (`capture.blurPersonalData`, on by default; Admin page). |
| Exclusions | Admin-configurable excluded applications and URL patterns (password managers, mail, banking by default). Excluded events are dropped client-side and server-side. |
| No indefinite storage | Raw events and unused screenshots are deleted at publish time and, in any case, after `retention.rawCaptureDays` (default 14). Abandoned recordings are stopped automatically. In Azure, add a Blob lifecycle rule as a second line of defence. |
| Verified by test | The end-to-end test types a password during a recording and asserts it is not present in any stored file. |

Known limitation: AI detection is best effort. It can miss an area (or blur too much), and without an AI key only the add-in's e-mail/phone covering applies. Reviewers still check screenshots and can remove them before approval. Personal data in element names of recorded events (for example a clicked row "John Doe") stays in the event log until retention deletes it; documents refer to such values generically.

## GDPR and employee-monitoring considerations

The tool records an employee's activity, so before roll-out: complete a DPIA, inform/consult the works council where required, publish a notice describing what is captured, and define the legal basis (typically legitimate interest in business continuity). The design supports this: capture only when the employee starts it, purpose limitation (documentation only, no productivity metrics), data minimisation (no typed text by default), short retention, and an audit trail of who recorded, approved and published what.

## Data sent to the AI model

Only redacted events and screenshots of the recording are sent; screenshots are sent first for the personal-data check and afterwards only in their blurred form. Published documents are sent once more for the translation into the other language. Use the Anthropic API under your organisation's commercial terms or Claude on Microsoft Foundry to keep processing under an existing Microsoft agreement. Set `PDA_AI_PROVIDER=rules` to disable AI entirely.

## Other controls

No standing secrets in production: the App Service managed identity reaches SharePoint (Graph `Sites.Selected`, write on one site) and Microsoft Foundry; the only optional secret, a Claude API key, lives in Key Vault and is resolved by App Service. GitHub deploys with OIDC, FTP and basic publishing credentials are disabled, and the app refuses to start with test users on App Service. The browser extension and desktop agent can be locked by policy to pair only with your server (`allowedServers`). Security headers (`nosniff`, `DENY` framing, `no-referrer`, HSTS behind HTTPS); IDs validated before touching the file system; capture tokens stored only as hashes; ETag-based optimistic concurrency on drafts and on the repository (no silent overwrite); Graph via managed identity (or client credentials) with `Sites.Selected`; secrets only from environment / Key Vault references; append-only audit log of every state change.

## Inviting testers (optional)

Administration → Testers lets an Admin invite people outside the organisation as Microsoft Entra B2B guests and put them into one of the three role groups. It is off until a Global Administrator runs `scripts/Grant-InvitePermissions.ps1`, which grants the App Service managed identity two Microsoft Graph application permissions:

| Permission | Why | Risk and mitigation |
|---|---|---|
| `User.Invite.All` | Send the guest invitation | Can invite any address. Only Admins of the app can trigger it; every invitation is in the audit log. |
| `GroupMember.ReadWrite.All` | Add the guest to the role group, remove them again | Tenant-wide. The app only uses the three group ids saved in the settings, and only removes guests, never members of your organisation. Revoke with `Grant-InvitePermissions.ps1 -Remove`. |

Guests need no licence. Guest invitations must be allowed in the External collaboration settings. Assigning app roles to groups needs Microsoft Entra ID P1.

## Microsoft Teams app and meeting transcripts (optional)

`scripts/Enable-TeamsApp.ps1` sets this up; Administration → Microsoft Teams downloads the app package for the Teams admin center.

- **Delegated access only.** Transcripts are read on behalf of the signed-in person (on-behalf-of flow) with `OnlineMeetings.Read` and `OnlineMeetingTranscript.Read.All` (delegated, admin consent). The app can only reach meetings that person may read, in practice meetings they organised. There is no application permission, no `getAllTranscripts`, no application access policy and no access to calendars or chats.
- **No secret.** The on-behalf-of exchange authenticates the API app registration with a federated identity credential that trusts the App Service's user-assigned managed identity (`<prefix>-id-<suffix>`). The identity has no other role.
- **Teams sign-in.** The Teams clients are pre-authorised for the API's `access_as_user` scope; the API accepts its token audience `api://<host>/<client id>` in addition to the existing ones. The app can be framed only by Teams and Microsoft 365 hosts (`frame-ancestors`), and by nothing at all when the Teams app is not set up.
- **What is stored.** The parsed transcript is stored with the import (spoken passwords, tokens and e-mail addresses masked) so drafts can be made from it; the importer can delete it. Every import and draft is in the audit log.
- **Tenant controls still apply.** If Graph access to transcripts is switched off for apps (`GraphAccessToTranscriptsDisabled`), imports fail with a clear message. `-Remove` undoes the setup.

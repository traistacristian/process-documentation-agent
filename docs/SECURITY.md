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
| Mask personal data | E-mail addresses are masked (`j***@contoso.com`). Sensitive fields are blurred in screenshots before capture. |
| Exclusions | Admin-configurable excluded applications and URL patterns (password managers, mail, banking by default). Excluded events are dropped client-side and server-side. |
| No indefinite storage | Raw events and unused screenshots are deleted at publish time and, in any case, after `retention.rawCaptureDays` (default 14). Abandoned recordings are stopped automatically. In Azure, add a Blob lifecycle rule as a second line of defence. |
| Verified by test | The end-to-end test types a password during a recording and asserts it is not present in any stored file. |

Known limitation: screenshots can still contain personal data that is visible on screen (names in a user list, for example). Reviewers can remove screenshots before approval. OCR-based masking (Azure AI Vision + PII detection) is a possible Phase 5 addition.

## GDPR and employee-monitoring considerations

The tool records an employee's activity, so before roll-out: complete a DPIA, inform/consult the works council where required, publish a notice describing what is captured, and define the legal basis (typically legitimate interest in business continuity). The design supports this: capture only when the employee starts it, purpose limitation (documentation only, no productivity metrics), data minimisation (no typed text by default), short retention, and an audit trail of who recorded, approved and published what.

## Data sent to the AI model

Only redacted events and screenshots of the recording are sent. Use the Anthropic API under your organisation's commercial terms or Claude on Microsoft Foundry to keep processing under an existing Microsoft agreement. Set `PDA_AI_PROVIDER=rules` to disable AI entirely.

## Other controls

No standing secrets in production: the App Service managed identity reaches SharePoint (Graph `Sites.Selected`, write on one site) and Microsoft Foundry; the only optional secret, a Claude API key, lives in Key Vault and is resolved by App Service. GitHub deploys with OIDC, FTP and basic publishing credentials are disabled, and the app refuses to start with test users on App Service. The browser extension and desktop agent can be locked by policy to pair only with your server (`allowedServers`). Security headers (`nosniff`, `DENY` framing, `no-referrer`, HSTS behind HTTPS); IDs validated before touching the file system; capture tokens stored only as hashes; ETag-based optimistic concurrency on drafts and on the repository (no silent overwrite); Graph via managed identity (or client credentials) with `Sites.Selected`; secrets only from environment / Key Vault references; append-only audit log of every state change.

# Multi-tenant (SaaS) deployment

One deployment serves many customer organisations. Each customer is a Microsoft Entra tenant. Its admin adds the app to the tenant (admin consent), the platform owner registers the tenant, and the tenant's users sign in with their own Microsoft accounts.

The single-organisation deployment (docs/GO-LIVE.md) is unchanged and stays the default. Multi-tenant mode is switched on with `PDA_MULTI_TENANT=true`.

## Status

| Part | Status |
|---|---|
| Sign-in from any tenant, issuer checked against the token's own tenant | Done, tested |
| Tenant registry (trial, active, suspended, cancelled) and `npm run tenant` | Done, tested |
| Separate data per tenant (recordings, screenshots, drafts, audit log, search index, settings, local repository) | Done, tested with two tenants |
| Capture clients routed by pairing code or session id; pairing codes unique across tenants; wrong-code limit | Done, tested |
| Self-service onboarding: admin consent, trial sign-up by a directory administrator, setup page | Done, tested (Microsoft endpoints mocked) |
| Roles without Entra configuration: the admin who signed up is Admin, everybody else gets a default role | Done, tested |
| Customer's SharePoint site connected from the setup page, app-only access to that one site, no secrets | Done, tested with a mocked Graph; not yet run against real tenants |
| `scripts/Setup-SaaSPublisher.ps1`: multi-tenant app registrations, federated credential, App Service settings | Written; not yet run |
| Licence rules: trial end and suspension make the app read-only, seats per month, monthly AI quota | Done, tested |
| Microsoft Marketplace SaaS offer: landing page, SaaS Fulfillment API v2, webhook | Done, tested against a fake Fulfillment API; not yet run against Partner Center |
| Teams app for customer tenants (store listing) | After Marketplace; the Teams manifest needs the verified publisher domain |
| Table/Blob Storage instead of files, more than one instance | Later |

## How a customer is onboarded

1. **Admin consent.** A Microsoft 365 administrator of the customer opens `https://<your app>/#/signup` and clicks *Add to my organisation*. Microsoft's consent page opens twice: once for the API app (its Graph permissions), once for the web app. Consent adds both apps to the customer's tenant; Doku stores nothing yet.
2. **Trial.** Back in the app, the administrator signs in and starts the trial. Only a Global, Privileged Role, Application or Cloud Application Administrator can (token claim `wids`). The tenant is registered with status `trial`: at most 5 days (`PDA_TRIAL_DAYS` can shorten it) and 1 seat, so only that administrator, who becomes the organisation's first Admin, can use it. Nobody else gets a default role during the trial. With `PDA_SELF_SIGNUP=false` only tenants you add with `npm run tenant` can start.
3. **Setup** (*Organisation setup* page, Admins only).
   - *Who can use the app:* everybody in the organisation gets the default role (Contributor unless changed). App roles assigned in the customer's Enterprise application still apply, so a customer can switch the default off and assign roles to groups instead.
   - *SharePoint:* the Admin enters the site address. The app grants itself `write` on that one site (Graph `Sites.Selected`), on behalf of the Admin, who must be a SharePoint administrator or the site owner. It then opens the site with its own app-only access, exactly as it will when publishing, and creates its columns and folders. Until a site is connected, published documents are kept in a folder in the tenant's data folder and Admins see a banner.

## Permissions a customer consents to

| Permission (Microsoft Graph) | Type | Used for |
|---|---|---|
| `User.Read` | Delegated | Sign-in |
| `Sites.Selected` | Application | Reading and writing the one SharePoint site the customer connected; no other site |
| `Sites.FullControl.All` | Delegated | Only while an Admin connects the site: granting the app access to it. Works only for a person who already has that right on the site. |
| `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` | Delegated | Teams transcripts the signed-in person may read (when Teams is enabled) |

## No secrets

The App Service's user-assigned managed identity signs in to every customer tenant as the multi-tenant API app, through a federated identity credential on that app (`server/federated.js`). No client secret or certificate exists. Customer tenants trust the app only because their administrator consented to it, and can remove it at any time (Enterprise applications → delete), which stops all access immediately.

## How a request finds its tenant

| Request | How the tenant is chosen |
|---|---|
| `/api/*` from the web app or Teams | The user's access token is validated for any tenant (signature, expiry, audience; issuer must be `login.microsoftonline.com/<tid>/v2.0` of the token's own `tid`). The tenant must be in the registry and not cancelled. |
| `/api/capture/pair` | The 6-digit pairing code is looked up in the registry's capture index. 10 wrong codes per minute per address, then HTTP 429. |
| `/api/capture/*` | The `X-Session-Id` header is looked up in the capture index; the tenant's app then checks the capture token against its own session. |
| `/api/config` | Without a token: sign-in information only (authority `organizations`). With a token: the tenant's own configuration, or `tenant.status` = `not_onboarded` / `ended`. |

Each tenant gets its own instance of the API (`createApp`) with its own configuration (`tenantConfig` in `server/config.js`). That instance only knows its own data folder, `<PDA_DATA_DIR>/tenants/<tenant id>/`, so it cannot address another tenant's files. `test/unit/saas.test.js` checks this with two tenants: lists, reads, screenshots, deletes, generation, audit logs, settings, capture tokens and files on disk.

## Set it up

1. Deploy `infra/main.bicep` with `enableTeams=true` (creates the user-assigned managed identity).
2. Run `scripts/Setup-SaaSPublisher.ps1 -ResourceGroup <rg> -WebAppName <app> -PublicUrl https://<your domain>`. It creates both multi-tenant app registrations, the federated credential, and sets `PDA_MULTI_TENANT`, `ENTRA_API_CLIENT_ID`, `ENTRA_SPA_CLIENT_ID`, `PDA_MI_CLIENT_ID` and `PDA_PUBLIC_URL`.
3. Complete Publisher Verification for both app registrations.
4. Test with a free Microsoft 365 developer tenant: open `/#/signup` as its Global Administrator.

Locally (without Microsoft sign-in the app cannot be used, but the server starts):

```bash
PDA_MULTI_TENANT=true ENTRA_API_CLIENT_ID=<api app id> ENTRA_SPA_CLIENT_ID=<spa app id> npm start
```

## Selling through Microsoft Marketplace

The offer is a transactable SaaS offer in Partner Center (Microsoft commercial marketplace), priced per user per month. Plan ids in Partner Center should match the plan names below (`team`, `business`, …); otherwise map them with `saas.marketplace.planMap`. The quantity bought becomes the tenant's seats.

**Partner Center → the offer → Technical configuration** (the setup script prints these):

| Field | Value |
|---|---|
| Landing page URL | `https://<your app>/subscribe` |
| Connection webhook | `https://<your app>/api/marketplace/webhook` |
| Microsoft Entra tenant ID | your (publisher) tenant, `PDA_PUBLISHER_TENANT_ID` |
| Microsoft Entra application ID | the multi-tenant API app (`ENTRA_API_CLIENT_ID`; another app with `PDA_MARKETPLACE_APP_ID`) |

**Purchase.** Marketplace sends the buyer to `/subscribe?token=…`. The buyer signs in with a work account (only the web app, so the organisation does not need to have added Doku yet). The page resolves the purchase with the SaaS Fulfillment API and shows plan, users and organisation. *Activate* registers the customer's tenant (the subscription's beneficiary) as `active` with that plan and seats and activates the subscription. A trial that is bought keeps its data and loses its end date.

- Bought by the organisation's own directory administrator: that person becomes its Admin; then *add the app* (admin consent) and *organisation setup* as above.
- Bought by a partner for a customer (CSP, an MSP): the partner gets no access to the customer. The customer's first directory administrator who signs in becomes its Admin (*become its administrator* banner).

**Changes** come through the webhook, whose token must be issued by Microsoft Entra in the publisher tenant, for our app, to the Marketplace application. Each event is read back from the Fulfillment API before it is applied:

| Event | Effect |
|---|---|
| ChangePlan | plan changes (acknowledged to Marketplace) |
| ChangeQuantity | seats change (acknowledged) |
| Suspend | `suspended`: read-only |
| Reinstate, Renew | `active` (Reinstate acknowledged) |
| Unsubscribe | `cancelled`: no access; the data folder stays until you delete it |

Calls to the Fulfillment API use a token for the Marketplace resource from the app's federated credential: no secret.

## Plans and licence rules

| Plan | Seats per month | AI-drafted documents per month |
|---|---|---|
| trial (self-service, at most 5 days) | 1 | 20 |
| pilot | 25 | 300 |
| team | 10 | 200 |
| business | 50 | 1000 |

Defaults live in `server/licence.js` and can be changed with `saas.plans` in the configuration; a tenant's own `seats` / `aiGenerations` override its plan.

- **Read-only** when the trial has ended or the subscription is suspended: people can still read, download and delete; starting recordings, capture clients, generating, editing and publishing return HTTP 402.
- **Seats**: distinct people per calendar month (UTC). When all are taken, a further person gets HTTP 402 `SEAT_LIMIT` (the web app explains it); people already counted this month keep access.
- **AI quota**: over the monthly quota, documents are drafted by the rule-based engine (audit entry `draft.ai_quota_exceeded`). Screenshot privacy checks are not counted and keep running.
- Admins see the plan and this month's usage on *Organisation setup* (`GET /api/subscription`).

## Managing tenants

```bash
npm run tenant -- list
npm run tenant -- add <tenant id> --name "Contoso" --status active --plan pilot
npm run tenant -- set <tenant id> --status suspended
npm run tenant -- set <tenant id> --status active --plan pilot --seats 25 --ai 300
npm run tenant -- set <tenant id> --trial-ends 2026-12-31   # a longer trial for a pilot, set by you
npm run tenant -- usage <tenant id>
npm run tenant -- remove <tenant id>     # registry entry only; the data folder is kept
```

On Azure App Service, run these from the SSH console of the web app. The registry is `<PDA_DATA_DIR>/platform/tenants.json`.

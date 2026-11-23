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
| Self-service onboarding (admin consent link, setup wizard), SharePoint per tenant without secrets, Teams store manifest | Next (PR 2) |
| Licence rules (read-only when suspended, seats, AI quota), Marketplace SaaS offer (landing page, Fulfillment API, webhook) | PR 3 and PR 4 |
| Table/Blob Storage instead of files, more than one instance | Later |

Until PR 2, a tenant's published documents go to a local folder inside its data folder (shown as "not SharePoint" in the app), Teams meeting import is not available to customer tenants, and roles come only from the app roles assigned in the customer's Enterprise application.

## How a request finds its tenant

| Request | How the tenant is chosen |
|---|---|
| `/api/*` from the web app or Teams | The user's access token is validated for any tenant (signature, expiry, audience; issuer must be `login.microsoftonline.com/<tid>/v2.0` of the token's own `tid`). The tenant must be in the registry and not cancelled. |
| `/api/capture/pair` | The 6-digit pairing code is looked up in the registry's capture index. 10 wrong codes per minute per address, then HTTP 429. |
| `/api/capture/*` | The `X-Session-Id` header is looked up in the capture index; the tenant's app then checks the capture token against its own session. |
| `/api/config` | Without a token: sign-in information only (authority `organizations`). With a token: the tenant's own configuration, or `tenant.status` = `not_onboarded` / `ended`. |

Each tenant gets its own instance of the API (`createApp`) with its own configuration (`tenantConfig` in `server/config.js`). That instance only knows its own data folder, `<PDA_DATA_DIR>/tenants/<tenant id>/`, so it cannot address another tenant's files. `test/unit/saas.test.js` checks this with two tenants: lists, reads, screenshots, deletes, generation, audit logs, settings, capture tokens and files on disk.

## Run it locally

```bash
export PDA_MULTI_TENANT=true
export ENTRA_API_CLIENT_ID=<multi-tenant API app id>
export ENTRA_SPA_CLIENT_ID=<multi-tenant SPA app id>
npm run tenant -- add <customer tenant id> --name "Contoso" --status trial
npm run build && npm start
```

Both app registrations must have **Supported account types: Accounts in any organizational directory** (`AzureADMultipleOrgs`). PR 2 adds a script that creates them in the publisher tenant.

## Managing tenants

```bash
npm run tenant -- list
npm run tenant -- add <tenant id> --name "Contoso" --status active --plan pilot
npm run tenant -- set <tenant id> --status suspended
npm run tenant -- remove <tenant id>     # registry entry only; the data folder is kept
```

On Azure App Service, run these from the SSH console of the web app. The registry is `<PDA_DATA_DIR>/platform/tenants.json`.

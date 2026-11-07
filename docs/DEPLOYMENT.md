# Deployment and configuration

## Run the prototype locally (no tenant needed)

```bash
npm install
npm run build          # builds the web app into web/dist
npm start              # http://localhost:3000
```

- Auth mode `dev`: pick a test user (Contributor / Approver / Admin) in the top bar.
- Repository mode `local`: published documents go to `data/repository/` (the UI says so).
- Documentation engine: rule-based unless `ANTHROPIC_API_KEY` is set, then Claude (`claude-opus-5-5`).

**Load the browser extension:** Edge `edge://extensions` or Chrome `chrome://extensions` → Developer mode → *Load unpacked* → select `extension/`. Start a recording in the web app; the extension pairs automatically and its icon shows `REC`.

**Desktop agent (Windows):**
```powershell
cd desktop-agent
py -m pip install -r requirements.txt
py -m pda_agent --server http://localhost:3000 --code <pairing code from the recording screen>
```

## Configuration

`config/default.json` holds all defaults; override with `config/local.json`, a file named by `PDA_CONFIG`, or environment variables:

| Variable | Purpose |
|---|---|
| `PORT`, `PDA_DATA_DIR` | Listen port; directory for sessions, drafts, temporary screenshots, audit log |
| `PDA_AUTH_MODE` | `dev` or `entra` |
| `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_SPA_CLIENT_ID` | Entra app registrations (plus `auth.entra.apiScope` in config, e.g. `api://<api-client-id>/access_as_user`) |
| `PDA_REPOSITORY_MODE` | `local` or `sharepoint` |
| `SP_TENANT_ID`, `SP_CLIENT_ID`, `SP_CLIENT_SECRET`, `SP_SITE_URL`, `SP_LIBRARY` | SharePoint destination and the backend app's credentials |
| `ANTHROPIC_API_KEY` | Enables the Claude documentation engine (`PDA_AI_PROVIDER=rules` forces the rule engine) |

Categories, capture policy, retention and the Power Automate webhook are edited by Admins in the Administration page (stored in `<dataDir>/settings.json`).

## Microsoft 365 / Azure setup

1. **API app registration** (Entra ID → App registrations → New):
   - Expose an API: Application ID URI `api://<client-id>`, scope `access_as_user`.
   - App roles (allowed member types: Users/Groups): `ProcessDoc.Contributor`, `ProcessDoc.Approver`, `ProcessDoc.Admin`. Assign them to groups in *Enterprise applications → Users and groups*.
   - API permissions → Microsoft Graph → **Application** → `Sites.Selected` → Grant admin consent.
   - Certificates & secrets: create a secret (or, better, a certificate / managed identity federated credential) and store it in Key Vault.
2. **Grant the app write access to the documentation site only** (run once by a SharePoint/Global admin):
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<api-client-id>", "displayName": "Process Documentation Agent" } }] }
   ```
   (`Get-PnPSite` / `Grant-PnPAzureADAppSitePermission` in PnP.PowerShell does the same.)
3. **SPA app registration**: platform *Single-page application*, redirect URI = the app URL, delegated permission to the API scope `access_as_user`.
4. **SharePoint library**: enable versioning (major versions; keep e.g. 50). Then in the app: Administration → *Create metadata columns and category folders* (creates `PDA_ProcessId`, `PDA_Version`, `PDA_Status`, `PDA_Owner`, `PDA_Department`, `PDA_Category`, `PDA_Approver` and the folder tree).
5. **Hosting**: Azure App Service (Linux, Node 20+) or Container Apps; `npm ci && npm run build && npm start`. Enable *Always On*, HTTPS only, and Key Vault references for secrets. Mount `PDA_DATA_DIR` on Azure Files for the prototype store; for production replace `server/store.js` with Cosmos DB + Blob Storage (same interface) and add a Blob lifecycle rule deleting `screenshots/` after 14 days.
6. **Browser extension**: publish to the Edge Add-ons store as an unlisted extension or host the CRX internally, then force-install with Intune (`ExtensionInstallForcelist`). Restrict `host_permissions` to your admin portals if you want a narrower footprint.
7. **Desktop agent**: package with PyInstaller into a signed MSI and deploy with Intune; or port `core.py` to .NET (see architecture document).
8. **Monitoring**: add the Application Insights Node SDK, forward the audit log to Log Analytics.

## What has not been verified in this environment

- No Entra tenant: `entra` auth mode and MSAL sign-in are implemented but untested.
- No SharePoint tenant: the Graph adapter is tested only against a mocked Graph.
- No Anthropic API key: the Claude engine is tested only with a fake client; the app falls back to the rule engine if the model call fails.
- No Windows desktop: the desktop agent's platform layer (UI Automation, pynput, mss) has not been run.

# Go-live guide

This is the whole path from an empty Azure resource group to employees recording processes. Expect
about half a day for a first deployment. Nothing here asks you to put a password or key in a chat,
an email or a file: the only secret (an optional Claude API key) is typed into the setup script and
goes straight into Key Vault.

## Free mode (default)

`costProfile=free` deploys only free-of-charge resources: App Service plan **F1 (Free)**, data on the
App Service's own persistent `/home` storage (1 GB), no storage account, Key Vault, Log Analytics or
Application Insights, and the built-in rule engine instead of Claude (Claude can be added, billed by Anthropic, see below). Entra app registrations,
SharePoint (your existing Microsoft 365) and GitHub Actions on a public repository are free too. If
your tenant has no Entra ID P1, the setup script assigns roles to the groups' members one by one.
Set `budgetAlertEmail` to get an e-mail on any spend at all.

### Claude in free mode (optional, lowest cost)

Claude is billed by Anthropic, not by Azure, so it does not touch the "no Azure costs" rule. To turn it on:

1. In the [Claude Console](https://console.anthropic.com) create an organization, buy the smallest
   prepaid credit and set a low monthly **spend limit** (Settings > Limits). Create an API key.
2. In GitHub: repository **Settings > Secrets and variables > Actions > New repository secret**, name
   `ANTHROPIC_API_KEY`, paste the key there (never in a chat, ticket or file).
3. Re-run the latest **Deploy to Azure** run (or push any change). The key becomes an encrypted app
   setting; without the secret the app keeps using the rule engine.

Defaults: model **Claude Haiku 5.5** (`claude-haiku-5-5`, the lowest-cost model) at effort **low**
(repository variables `CLAUDE_MODEL` / `CLAUDE_EFFORT` change them). Claude then drafts each step's
description from its screenshot while you record (one short call per step) and writes the document
draft. Typical cost: well under one cent per recorded step.

Free-tier limits: 60 CPU minutes per day, the app sleeps after about 20 minutes idle (the first
request then takes ~20 s), 1 GB of storage, one free Linux plan per region per subscription. Fine for
a pilot; switch to `costProfile=standard` for daily use by a team.

## What you need before you start

| Item | Who usually has it |
|---|---|
| Azure subscription and an empty resource group, you as Owner on it | Azure admin |
| Global Administrator, or Application Admin + Privileged Role Admin + SharePoint Admin | Entra admin |
| SharePoint site and document library for the published documents (library versioning on) | SharePoint admin |
| Three Entra security groups: recorders (Contributor), approvers, admins of the tool | Entra admin |
| Entra ID P1 or P2 (to assign app roles to groups) | Licensing |
| Claude access: a **Microsoft Foundry** resource with a Claude model deployed (recommended, billed through Azure, no key) **or** a Claude API key | Azure admin / Anthropic Console |
| GitHub repository with Actions enabled | You |
| Intune (or Group Policy) for the extension and the desktop agent | Endpoint admin |
| DPIA done, works council informed where required, employee notice published | DPO / HR |

Tools on the admin workstation: PowerShell 7.2+, `Install-Module Az, Microsoft.Graph -Scope CurrentUser`, Azure CLI.

## Step 1. Deploy the Azure resources

```bash
az login
az group create -n rg-process-docs -l westeurope
az deployment group create -g rg-process-docs -f infra/main.bicep \
  -p sharePointSiteUrl=https://contoso.sharepoint.com/sites/ITOps sharePointLibrary=Documents \
     aiProvider=foundry foundryResourceName=contoso-ai
```

Note the outputs `webAppName` and `url`. This creates App Service (Linux, Node 22, Always On, HTTPS
only, FTP/basic auth off, health check), a managed identity, an Azure Files share mounted as the data
directory, Key Vault, Log Analytics and Application Insights.

## Step 2. Run the Entra and SharePoint setup script

```powershell
./scripts/Setup-EntraAndSharePoint.ps1 -ResourceGroup rg-process-docs -WebAppName <webAppName> `
  -SharePointSiteUrl https://contoso.sharepoint.com/sites/ITOps -LibraryName Documents `
  -ContributorGroup "IT Staff" -ApproverGroup "IT Process Approvers" -AdminGroup "IT Process Admins" `
  -AiProvider foundry -FoundryResourceId /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/contoso-ai
```

It creates the two app registrations, assigns the roles to your groups, gives the App Service's
managed identity `Sites.Selected` with write access **to this one site only**, creates the metadata
columns and the root folder, grants access to Foundry (or asks for the Claude API key and stores it in
Key Vault), writes the settings into App Service and restarts it. It prints two client ids; keep them
for step 3.

## Step 3. Connect GitHub for automatic deployments

1. Create a user-assigned managed identity or app registration for GitHub, give it **Contributor** on
   the resource group, and add a federated credential: organisation/repository, entity *Environment*,
   name `production`.
2. In GitHub: Settings → Environments → `production` (add required reviewers if you want a manual gate).
3. Settings → Secrets and variables → Actions → **Variables** (none of these are secrets):
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`,
   `SHAREPOINT_SITE_URL`, `SHAREPOINT_LIBRARY`, `AI_PROVIDER`, `FOUNDRY_RESOURCE_NAME`,
   `ENTRA_API_CLIENT_ID`, `ENTRA_SPA_CLIENT_ID`.
4. Run *Deploy to Azure* manually once (Actions tab). After that every green CI run on `main` deploys.

## Step 4. First sign-in and configuration

1. Open the app URL and sign in as a member of the admin group.
2. Administration: check that the SharePoint status is **Connected**, click *Create metadata columns and
   category folders*, review categories, excluded applications/URLs and retention.
3. Optional: paste a Power Automate HTTP trigger URL to notify approvers (Teams / e-mail).

## Step 5. Roll out the capture clients

- **Browser extension**: CI builds `pda-extension-<version>.zip`. Publish it as a hidden Edge Add-on,
  force-install it with Intune and set `allowedServers` to your app URL. See `deploy/extension-policy/README.md`.
- **Desktop agent** (Windows applications, MMC consoles, RDP): CI builds the `desktop-agent-intune`
  folder. Sign `ProcessDocAgent.exe`, wrap it with `IntuneWinAppUtil.exe` and deploy as a Win32 app
  with the install command in `deploy/desktop-agent/Install-ProcessDocAgent.ps1`. Users start it from
  the Start menu and type the pairing code shown on the recording screen.
- No install possible? The recorder can also capture with browser screen sharing (screenshots only).

## Step 6. Pilot (one or two weeks, 3 to 5 people)

Run the scenarios M1 to M10 in `docs/REQUIREMENTS-AND-TESTING.md` against the real tenant. Sign-off
criteria: every published document opens in SharePoint with metadata and screenshots, version 1.1
keeps 1.0 in the version history, a contributor cannot approve, no password appears in any stored file
(check the Azure Files share), and Application Insights shows the `audit.*` events.

## Operations

| Topic | Where |
|---|---|
| Logs and errors | Application Insights → Failures; Log Analytics `AppServiceConsoleLogs` |
| Audit trail | Administration → Audit log, and `customEvents` where `name startswith "audit."` |
| Backups | Azure Files share snapshots (enable Azure Backup for the storage account); SharePoint has its own versioning |
| Rotating the Claude API key | Add a new version of `anthropic-api-key` in Key Vault, restart the app |
| Changing SharePoint site | Re-run step 2 with the new site URL, update `SHAREPOINT_SITE_URL` |
| Scale | Single instance by design (file store). For more than ~200 active users, move `server/store.js` to Cosmos DB + Blob Storage (same interface) before scaling out |

## Known limits at go-live

- Entra sign-in, SharePoint via the managed identity, Foundry and the Windows desktop agent are built
  against the documented Microsoft and Anthropic APIs and tested with mocks and in CI, but they have
  not yet run against **your** tenant. Step 6 is where that is verified.
- Screenshots can show personal data that is on screen (for example names in a user list). Reviewers
  remove such screenshots before approval.
- The desktop agent is Windows-first; macOS and Linux layers exist but are not packaged.

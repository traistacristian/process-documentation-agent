<#
.SYNOPSIS
  One-time Microsoft 365 / Entra ID setup for the Process Documentation Agent.
  Run after infra/main.bicep has been deployed. Safe to re-run (idempotent).

.DESCRIPTION
  1. Creates the API app registration (app roles ProcessDoc.Contributor / Approver / Admin, scope access_as_user).
  2. Creates the SPA app registration (redirect URI = the App Service URL), pre-authorised for the API.
  3. Assigns the three app roles to your Entra groups (group assignment needs Entra ID P1 or P2).
  4. Gives the App Service managed identity Microsoft Graph Sites.Selected and "write" on the
     documentation site ONLY. No client secret is created for SharePoint.
  5. Creates the metadata columns on the library and the root folder (with your admin session).
  6. AI: grants the managed identity access to the Microsoft Foundry resource, or prompts for the
     Claude API key and stores it straight into Key Vault (it is never printed or written to disk).
  7. Writes the Entra ids into the App Service settings and restarts it.

  Who runs it: a Global Administrator, or Application Administrator + Privileged Role Administrator
  + SharePoint Administrator, who is also Owner (or User Access Administrator) on the resource group.

.EXAMPLE
  ./Setup-EntraAndSharePoint.ps1 -ResourceGroup rg-pda -WebAppName pda-app-xxxx `
     -SharePointSiteUrl https://contoso.sharepoint.com/sites/ITOps -LibraryName Documents `
     -ContributorGroup "IT Staff" -ApproverGroup "IT Process Approvers" -AdminGroup "IT Process Admins" `
     -AiProvider foundry -FoundryResourceId /subscriptions/.../providers/Microsoft.CognitiveServices/accounts/contoso-ai
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $WebAppName,
  [Parameter(Mandatory)] [string] $SharePointSiteUrl,
  [string] $LibraryName = 'Documents',
  [string] $RootFolder = 'IT Process Documentation',
  [Parameter(Mandatory)] [string] $ContributorGroup,
  [Parameter(Mandatory)] [string] $ApproverGroup,
  [Parameter(Mandatory)] [string] $AdminGroup,
  [ValidateSet('foundry', 'anthropic', 'rules')] [string] $AiProvider = 'foundry',
  [string] $FoundryResourceId,
  [string] $KeyVaultName,
  [string] $AppDisplayName = 'Process Documentation Agent',
  [string] $TenantId
)

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }

foreach ($m in 'Az.Accounts', 'Az.Websites', 'Az.Resources', 'Az.KeyVault', 'Microsoft.Graph.Applications', 'Microsoft.Graph.Groups', 'Microsoft.Graph.Authentication') {
  if (-not (Get-Module -ListAvailable -Name $m)) { throw "PowerShell module $m is missing. Install-Module Az, Microsoft.Graph -Scope CurrentUser" }
}

Step 'Signing in'
if (-not (Get-AzContext)) { Connect-AzAccount -Tenant $TenantId | Out-Null }
$ctx = Get-AzContext
if (-not $TenantId) { $TenantId = $ctx.Tenant.Id }
$graphScopes = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Group.Read.All', 'Sites.FullControl.All')
$inCloudShell = "$env:AZUREPS_HOST_ENVIRONMENT" -like 'cloud-shell*' -or [bool]$env:ACC_CLOUD
if ($inCloudShell) { Connect-MgGraph -TenantId $TenantId -NoWelcome -Scopes $graphScopes -UseDeviceCode }
else { Connect-MgGraph -TenantId $TenantId -NoWelcome -Scopes $graphScopes }
Ok "Tenant $TenantId, subscription $($ctx.Subscription.Name)"

$web = Get-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName
$appUrl = "https://$($web.DefaultHostName)"
$miObjectId = $web.Identity.PrincipalId
if (-not $miObjectId) { throw "The web app has no system-assigned managed identity. Deploy infra/main.bicep first." }
$miSp = Get-MgServicePrincipal -ServicePrincipalId $miObjectId
Ok "App Service $WebAppName ($appUrl), managed identity $($miSp.AppId)"

# ------------------------------------------------------------------ 1. API app registration
Step 'API app registration'
$roleDefs = @(
  @{ Value = 'ProcessDoc.Contributor'; DisplayName = 'Contributor'; Description = 'Record processes and edit own drafts.' },
  @{ Value = 'ProcessDoc.Approver'; DisplayName = 'Approver'; Description = 'Review, approve, reject and publish documentation.' },
  @{ Value = 'ProcessDoc.Admin'; DisplayName = 'Admin'; Description = 'Manage categories, capture policy, retention and SharePoint provisioning.' }
)
$apiName = "$AppDisplayName API"
$api = Get-MgApplication -Filter "displayName eq '$apiName'" | Select-Object -First 1
if (-not $api) {
  $api = New-MgApplication -DisplayName $apiName -SignInAudience AzureADMyOrg
  Ok "Created $apiName ($($api.AppId))"
} else { Ok "Found $apiName ($($api.AppId))" }

$existingRoles = @($api.AppRoles)
$appRoles = foreach ($r in $roleDefs) {
  $have = $existingRoles | Where-Object Value -eq $r.Value | Select-Object -First 1
  @{ Id = $(if ($have) { $have.Id } else { [guid]::NewGuid() }); Value = $r.Value; DisplayName = $r.DisplayName; Description = $r.Description; AllowedMemberTypes = @('User'); IsEnabled = $true }
}
$scope = $api.Api.Oauth2PermissionScopes | Where-Object Value -eq 'access_as_user' | Select-Object -First 1
$scopeId = if ($scope) { $scope.Id } else { [guid]::NewGuid() }
Update-MgApplication -ApplicationId $api.Id -IdentifierUris @("api://$($api.AppId)") -AppRoles $appRoles -Api @{
  RequestedAccessTokenVersion = 2
  Oauth2PermissionScopes = @(@{
    Id = $scopeId; Value = 'access_as_user'; Type = 'User'; IsEnabled = $true
    AdminConsentDisplayName = "Use $AppDisplayName"; AdminConsentDescription = "Allows the web app to call the $AppDisplayName API as the signed-in user."
    UserConsentDisplayName = "Use $AppDisplayName"; UserConsentDescription = "Allows the web app to call the $AppDisplayName API on your behalf."
  })
}
$apiSp = Get-MgServicePrincipal -Filter "appId eq '$($api.AppId)'" | Select-Object -First 1
if (-not $apiSp) { $apiSp = New-MgServicePrincipal -AppId $api.AppId }
# Only users who hold one of the roles (via their group) can sign in at all.
Update-MgServicePrincipal -ServicePrincipalId $apiSp.Id -AppRoleAssignmentRequired:$true
$api = Get-MgApplication -ApplicationId $api.Id
Ok "Scope api://$($api.AppId)/access_as_user, roles: $($roleDefs.Value -join ', ')"

# ------------------------------------------------------------------ 2. SPA app registration
Step 'Web app (SPA) registration'
$spaName = "$AppDisplayName Web"
$spa = Get-MgApplication -Filter "displayName eq '$spaName'" | Select-Object -First 1
if (-not $spa) { $spa = New-MgApplication -DisplayName $spaName -SignInAudience AzureADMyOrg; Ok "Created $spaName ($($spa.AppId))" } else { Ok "Found $spaName ($($spa.AppId))" }
Update-MgApplication -ApplicationId $spa.Id -Spa @{ RedirectUris = @($appUrl, "$appUrl/") } -RequiredResourceAccess @(
  @{ ResourceAppId = $api.AppId; ResourceAccess = @(@{ Id = $scopeId; Type = 'Scope' }) }
)
if (-not (Get-MgServicePrincipal -Filter "appId eq '$($spa.AppId)'")) { New-MgServicePrincipal -AppId $spa.AppId | Out-Null }
# Pre-authorise the SPA so nobody sees a consent prompt.
Update-MgApplication -ApplicationId $api.Id -Api @{
  RequestedAccessTokenVersion = 2
  Oauth2PermissionScopes = $api.Api.Oauth2PermissionScopes
  PreAuthorizedApplications = @(@{ AppId = $spa.AppId; DelegatedPermissionIds = @("$scopeId") })
}
Ok "Redirect URI $appUrl"

# ------------------------------------------------------------------ 3. Role assignments to groups
Step 'Assigning app roles to groups'
function Resolve-Group($nameOrId) {
  if ($nameOrId -match '^[0-9a-f-]{36}$') { return Get-MgGroup -GroupId $nameOrId }
  $g = @(Get-MgGroup -Filter "displayName eq '$($nameOrId -replace "'", "''")'")
  if ($g.Count -ne 1) { throw "Group '$nameOrId' not found or not unique ($($g.Count) matches). Pass its object id instead." }
  return $g[0]
}
$assigned = @(Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $apiSp.Id -All)
foreach ($pair in @(@($ContributorGroup, 'ProcessDoc.Contributor'), @($ApproverGroup, 'ProcessDoc.Approver'), @($AdminGroup, 'ProcessDoc.Admin'))) {
  $group = Resolve-Group $pair[0]
  $role = $api.AppRoles | Where-Object Value -eq $pair[1]
  if ($assigned | Where-Object { $_.PrincipalId -eq $group.Id -and $_.AppRoleId -eq $role.Id }) { Ok "$($group.DisplayName) already has $($pair[1])"; continue }
  try {
    New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $apiSp.Id -PrincipalId $group.Id -ResourceId $apiSp.Id -AppRoleId $role.Id | Out-Null
    Ok "$($group.DisplayName) -> $($pair[1])"
  } catch {
    # Assigning roles to groups needs Entra ID P1/P2. Without it, assign the current members one by one
    # (free); re-run this script after changing group membership.
    Write-Warning "Group assignment not possible ($($_.Exception.Message.Split([Environment]::NewLine)[0])). Assigning the group's current members individually."
    foreach ($m in Get-MgGroupMember -GroupId $group.Id -All | Where-Object { $_.AdditionalProperties['@odata.type'] -eq '#microsoft.graph.user' }) {
      if ($assigned | Where-Object { $_.PrincipalId -eq $m.Id -and $_.AppRoleId -eq $role.Id }) { continue }
      New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $apiSp.Id -PrincipalId $m.Id -ResourceId $apiSp.Id -AppRoleId $role.Id | Out-Null
      Ok "$($m.AdditionalProperties['userPrincipalName']) -> $($pair[1])"
    }
  }
}

# ------------------------------------------------------------------ 4. SharePoint access for the managed identity
Step 'Microsoft Graph Sites.Selected for the managed identity'
$graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$sitesSelected = $graphSp.AppRoles | Where-Object { $_.Value -eq 'Sites.Selected' -and $_.AllowedMemberTypes -contains 'Application' }
$miRoles = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $miObjectId -All)
if (-not ($miRoles | Where-Object AppRoleId -eq $sitesSelected.Id)) {
  New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $miObjectId -PrincipalId $miObjectId -ResourceId $graphSp.Id -AppRoleId $sitesSelected.Id | Out-Null
  Ok 'Granted Sites.Selected (admin consent)'
} else { Ok 'Sites.Selected already granted' }

$siteUri = [uri]$SharePointSiteUrl
$sitePath = $siteUri.AbsolutePath.TrimEnd('/')
$site = Invoke-MgGraphRequest GET "https://graph.microsoft.com/v1.0/sites/$($siteUri.Host):$sitePath"
$perms = (Invoke-MgGraphRequest GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/permissions").value
$mine = $perms | Where-Object { $_.grantedToIdentitiesV2.application.id -contains $miSp.AppId -or $_.grantedToIdentities.application.id -contains $miSp.AppId }
if (-not $mine) {
  Invoke-MgGraphRequest POST "https://graph.microsoft.com/v1.0/sites/$($site.id)/permissions" -Body (@{
    roles = @('write'); grantedToIdentities = @(@{ application = @{ id = $miSp.AppId; displayName = $AppDisplayName } })
  } | ConvertTo-Json -Depth 5) | Out-Null
  Ok "Granted write on $SharePointSiteUrl (this site only)"
} else { Ok "Managed identity already has $($mine.roles -join ',') on the site" }

# ------------------------------------------------------------------ 5. Library columns and root folder
Step "Library '$LibraryName': metadata columns and root folder"
$drives = (Invoke-MgGraphRequest GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/drives?`$select=id,name").value
$drive = $drives | Where-Object { $_.name -eq $LibraryName } | Select-Object -First 1
if (-not $drive) { throw "Library '$LibraryName' not found on $SharePointSiteUrl. Existing: $($drives.name -join ', ')" }
$list = Invoke-MgGraphRequest GET "https://graph.microsoft.com/v1.0/drives/$($drive.id)/list?`$select=id"
$cols = (Invoke-MgGraphRequest GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($list.id)/columns?`$select=name").value.name
foreach ($c in 'PDA_ProcessId', 'PDA_Version', 'PDA_Status', 'PDA_Owner', 'PDA_Department', 'PDA_Category', 'PDA_Approver') {
  if ($cols -contains $c) { continue }
  Invoke-MgGraphRequest POST "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($list.id)/columns" -Body (@{
    name = $c; displayName = $c.Replace('PDA_', 'Process '); text = @{}; indexed = ($c -eq 'PDA_ProcessId')
  } | ConvertTo-Json) | Out-Null
  Ok "Column $c"
}
try { Invoke-MgGraphRequest GET "https://graph.microsoft.com/v1.0/drives/$($drive.id)/root:/$([uri]::EscapeDataString($RootFolder))" | Out-Null; Ok "Folder '$RootFolder' exists" }
catch {
  Invoke-MgGraphRequest POST "https://graph.microsoft.com/v1.0/drives/$($drive.id)/root/children" -Body (@{ name = $RootFolder; folder = @{}; '@microsoft.graph.conflictBehavior' = 'fail' } | ConvertTo-Json) | Out-Null
  Ok "Created folder '$RootFolder' (category folders are created by the app)"
}
Write-Host "    Turn on library versioning if it is off: Library settings > Versioning settings > Create major versions." -ForegroundColor Yellow

# ------------------------------------------------------------------ 6. AI access
Step "AI provider: $AiProvider"
if ($AiProvider -eq 'foundry') {
  if (-not $FoundryResourceId) { throw '-FoundryResourceId is required for -AiProvider foundry.' }
  if (-not (Get-AzRoleAssignment -ObjectId $miObjectId -Scope $FoundryResourceId -RoleDefinitionName 'Cognitive Services User' -ErrorAction SilentlyContinue)) {
    New-AzRoleAssignment -ObjectId $miObjectId -Scope $FoundryResourceId -RoleDefinitionName 'Cognitive Services User' | Out-Null
  }
  Ok 'Managed identity can call Claude in Microsoft Foundry (no key needed)'
} elseif ($AiProvider -eq 'anthropic') {
  if (-not $KeyVaultName) { $KeyVaultName = (Get-AzKeyVault -ResourceGroupName $ResourceGroup | Select-Object -First 1).VaultName }
  $vault = Get-AzKeyVault -VaultName $KeyVaultName
  $me = (Get-MgContext).Account
  $meId = (Invoke-MgGraphRequest GET 'https://graph.microsoft.com/v1.0/me?$select=id').id
  if (-not (Get-AzRoleAssignment -ObjectId $meId -Scope $vault.ResourceId -RoleDefinitionName 'Key Vault Secrets Officer' -ErrorAction SilentlyContinue)) {
    New-AzRoleAssignment -ObjectId $meId -Scope $vault.ResourceId -RoleDefinitionName 'Key Vault Secrets Officer' | Out-Null
    Write-Host '    Waiting 30 s for the Key Vault role to take effect...'; Start-Sleep 30
  }
  $key = Read-Host -AsSecureString "Paste the Claude API key for $me (input hidden; stored only in Key Vault $KeyVaultName)"
  Set-AzKeyVaultSecret -VaultName $KeyVaultName -Name 'anthropic-api-key' -SecretValue $key -ContentType 'Claude API key' | Out-Null
  Ok "Stored secret anthropic-api-key in $KeyVaultName"
} else { Ok 'AI disabled; the rule-based engine writes the drafts' }

# ------------------------------------------------------------------ 7. App settings
Step 'Updating App Service settings'
$settings = @{}
foreach ($s in $web.SiteConfig.AppSettings) { $settings[$s.Name] = $s.Value }
$settings['ENTRA_TENANT_ID'] = $TenantId
$settings['ENTRA_API_CLIENT_ID'] = $api.AppId
$settings['ENTRA_SPA_CLIENT_ID'] = $spa.AppId
$settings['ENTRA_API_SCOPE'] = "api://$($api.AppId)/access_as_user"
$settings['SP_SITE_URL'] = $SharePointSiteUrl
$settings['SP_LIBRARY'] = $LibraryName
$settings['SP_ROOT_FOLDER'] = $RootFolder
$settings['PDA_AI_PROVIDER'] = $AiProvider
Set-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName -AppSettings $settings | Out-Null
Restart-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName | Out-Null
Ok 'Settings saved and app restarted'

Write-Host "`nDone. Open $appUrl and sign in with a member of '$AdminGroup'." -ForegroundColor Green
Write-Host 'Add these as GitHub repository variables so future deployments keep them (they are ids, not secrets):'
Write-Host "  ENTRA_API_CLIENT_ID = $($api.AppId)"
Write-Host "  ENTRA_SPA_CLIENT_ID = $($spa.AppId)"

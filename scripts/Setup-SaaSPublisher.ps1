<#
.SYNOPSIS
  One-time setup of the MULTI-TENANT (SaaS) deployment in the publisher's own tenant.
  Run after infra/main.bicep has been deployed with enableTeams=true (that creates the user-assigned
  managed identity this script trusts). Safe to re-run (idempotent).

.DESCRIPTION
  1. Creates the multi-tenant API app registration (AzureADMultipleOrgs): app roles
     ProcessDoc.Contributor / Approver / Admin, scope access_as_user, directory roles in tokens
     ("wids", to recognise the administrator who signs an organisation up), and these Microsoft
     Graph permissions, consented by each customer's administrator:
       Sites.Selected (application)          write on the ONE SharePoint site the customer connects
       Sites.FullControl.All (delegated)     used only while the customer's admin connects that site,
                                             to grant the app access to it (on behalf of that admin)
       OnlineMeetings.Read, OnlineMeetingTranscript.Read.All (delegated)   Teams transcripts that
                                             the signed-in person may read
       User.Read (delegated)                 sign-in
  2. Adds a federated identity credential to the API app that trusts the App Service's managed
     identity. The app signs in to every customer tenant with it: no secret or certificate exists.
  3. Creates the multi-tenant web (SPA) app registration, pre-authorised for the API.
  4. Writes the settings into the App Service (PDA_MULTI_TENANT=true, ids, public URL) and restarts it.

  Who runs it: Application Administrator (or Global Administrator) of the publisher tenant, who is
  also Contributor on the resource group.

  NOT verified against a real tenant from the development environment. Afterwards, complete
  Publisher Verification for both app registrations (Entra admin center → App registrations →
  Branding & properties → Publisher verification, needs a Microsoft AI Cloud Partner Program id),
  otherwise customers see "unverified" on the consent page and many tenants block the consent.

.EXAMPLE
  ./Setup-SaaSPublisher.ps1 -ResourceGroup rg-doku -WebAppName doku-app-xxxx -PublicUrl https://app.doku.example
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $WebAppName,
  # The address customers use. A custom domain verified in your tenant is recommended.
  [string] $PublicUrl,
  [string] $IdentityName,
  [string] $AppDisplayName = 'Process Documentation Agent',
  [string] $TenantId
)

$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }

foreach ($m in 'Az.Accounts', 'Az.Websites', 'Az.ManagedServiceIdentity', 'Microsoft.Graph.Applications', 'Microsoft.Graph.Authentication') {
  if (-not (Get-Module -ListAvailable -Name $m)) { throw "PowerShell module $m is missing. Install-Module Az, Microsoft.Graph -Scope CurrentUser" }
}

Step 'Signing in'
if (-not (Get-AzContext)) { Connect-AzAccount -Tenant $TenantId | Out-Null }
$ctx = Get-AzContext
if (-not $TenantId) { $TenantId = $ctx.Tenant.Id }
Connect-MgGraph -TenantId $TenantId -NoWelcome -Scopes 'Application.ReadWrite.All'
$web = Get-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName
if (-not $PublicUrl) { $PublicUrl = "https://$($web.DefaultHostName)" }
$PublicUrl = $PublicUrl.TrimEnd('/')
$callback = "$PublicUrl/api/onboarding/consent-callback"
$uaIds = @($web.Identity.UserAssignedIdentities.Keys)
if (-not $uaIds.Count) { throw 'The web app has no user-assigned managed identity. Deploy infra/main.bicep with enableTeams=true first.' }
if (-not $IdentityName) { $IdentityName = $uaIds[0].Split('/')[-1] }
$uaGroup = if ($IdentityName -eq $uaIds[0].Split('/')[-1]) { $uaIds[0].Split('/')[4] } else { $ResourceGroup }
$ua = Get-AzUserAssignedIdentity -ResourceGroupName $uaGroup -Name $IdentityName
Ok "Publisher tenant $TenantId, App Service $WebAppName, public URL $PublicUrl, managed identity $($ua.Name)"

# Microsoft Graph permission ids are looked up by name, not hard-coded.
$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
function GraphScope($v) { ($graph.Oauth2PermissionScopes | Where-Object Value -eq $v).Id }
function GraphRole($v) { ($graph.AppRoles | Where-Object Value -eq $v).Id }
$graphAccess = @{ ResourceAppId = $graph.AppId; ResourceAccess = @(
  @{ Id = (GraphRole 'Sites.Selected'); Type = 'Role' },
  @{ Id = (GraphScope 'Sites.FullControl.All'); Type = 'Scope' },
  @{ Id = (GraphScope 'OnlineMeetings.Read'); Type = 'Scope' },
  @{ Id = (GraphScope 'OnlineMeetingTranscript.Read.All'); Type = 'Scope' },
  @{ Id = (GraphScope 'User.Read'); Type = 'Scope' }
) }

# ------------------------------------------------------------------ 1. API app
Step 'Multi-tenant API app registration'
$apiName = "$AppDisplayName API"
$api = Get-MgApplication -Filter "displayName eq '$apiName'" | Select-Object -First 1
if (-not $api) { $api = New-MgApplication -DisplayName $apiName -SignInAudience AzureADMultipleOrgs; Ok "Created $apiName ($($api.AppId))" } else { Ok "Found $apiName ($($api.AppId))" }
$roleDefs = @(
  @{ Value = 'ProcessDoc.Contributor'; DisplayName = 'Contributor'; Description = 'Record processes and edit own drafts.' },
  @{ Value = 'ProcessDoc.Approver'; DisplayName = 'Approver'; Description = 'Review, approve, reject and publish documentation.' },
  @{ Value = 'ProcessDoc.Admin'; DisplayName = 'Admin'; Description = 'Manage the organisation setup, categories, capture policy and retention.' }
)
$appRoles = foreach ($r in $roleDefs) {
  $have = @($api.AppRoles) | Where-Object Value -eq $r.Value | Select-Object -First 1
  @{ Id = $(if ($have) { $have.Id } else { [guid]::NewGuid() }); Value = $r.Value; DisplayName = $r.DisplayName; Description = $r.Description; AllowedMemberTypes = @('User'); IsEnabled = $true }
}
$scope = $api.Api.Oauth2PermissionScopes | Where-Object Value -eq 'access_as_user' | Select-Object -First 1
$scopeId = if ($scope) { $scope.Id } else { [guid]::NewGuid() }
Update-MgApplication -ApplicationId $api.Id -SignInAudience AzureADMultipleOrgs -IdentifierUris @("api://$($api.AppId)") -AppRoles $appRoles `
  -GroupMembershipClaims 'DirectoryRole' -RequiredResourceAccess @($graphAccess) -Web @{ RedirectUris = @($callback) } -Api @{
  RequestedAccessTokenVersion = 2
  Oauth2PermissionScopes = @(@{
    Id = $scopeId; Value = 'access_as_user'; Type = 'User'; IsEnabled = $true
    AdminConsentDisplayName = "Use $AppDisplayName"; AdminConsentDescription = "Allows the web app to call the $AppDisplayName API as the signed-in user."
    UserConsentDisplayName = "Use $AppDisplayName"; UserConsentDescription = "Allows the web app to call the $AppDisplayName API on your behalf."
  })
}
if (-not (Get-MgServicePrincipal -Filter "appId eq '$($api.AppId)'")) { New-MgServicePrincipal -AppId $api.AppId | Out-Null }
Ok "Scope api://$($api.AppId)/access_as_user, consent callback $callback"

# ------------------------------------------------------------------ 2. Federated credential
Step 'Federated credential (no secrets)'
$FIC_NAME = 'saas-managed-identity'
$fic = @{ Name = $FIC_NAME; Issuer = "https://login.microsoftonline.com/$TenantId/v2.0"; Subject = $ua.PrincipalId; Audiences = @('api://AzureADTokenExchange'); Description = "$AppDisplayName ($WebAppName): sign-in to customer tenants" }
$existing = Get-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id | Where-Object { $_.Name -eq $FIC_NAME -or $_.Subject -eq $ua.PrincipalId } | Select-Object -First 1
if ($existing) { Update-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id -FederatedIdentityCredentialId $existing.Id -BodyParameter $fic } else { New-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id -BodyParameter $fic | Out-Null }
Ok "API app trusts managed identity $($ua.Name) ($($ua.ClientId))"

# ------------------------------------------------------------------ 3. Web (SPA) app
Step 'Multi-tenant web app registration'
$spaName = "$AppDisplayName Web"
$spa = Get-MgApplication -Filter "displayName eq '$spaName'" | Select-Object -First 1
if (-not $spa) { $spa = New-MgApplication -DisplayName $spaName -SignInAudience AzureADMultipleOrgs; Ok "Created $spaName ($($spa.AppId))" } else { Ok "Found $spaName ($($spa.AppId))" }
Update-MgApplication -ApplicationId $spa.Id -SignInAudience AzureADMultipleOrgs -Spa @{ RedirectUris = @($PublicUrl, "$PublicUrl/") } -Web @{ RedirectUris = @($callback) } -RequiredResourceAccess @(
  @{ ResourceAppId = $api.AppId; ResourceAccess = @(@{ Id = $scopeId; Type = 'Scope' }) }
)
if (-not (Get-MgServicePrincipal -Filter "appId eq '$($spa.AppId)'")) { New-MgServicePrincipal -AppId $spa.AppId | Out-Null }
$api = Get-MgApplication -ApplicationId $api.Id
$preAuth = @($api.Api.PreAuthorizedApplications | Where-Object AppId -ne $spa.AppId) + @(@{ AppId = $spa.AppId; DelegatedPermissionIds = @("$scopeId") })
Update-MgApplication -ApplicationId $api.Id -Api @{ RequestedAccessTokenVersion = 2; Oauth2PermissionScopes = $api.Api.Oauth2PermissionScopes; PreAuthorizedApplications = $preAuth; KnownClientApplications = @($spa.AppId) }
Ok "Redirect URI $PublicUrl, pre-authorised for the API"

# ------------------------------------------------------------------ 4. App Service settings
Step 'App Service settings'
$settings = @{}
foreach ($s in $web.SiteConfig.AppSettings) { $settings[$s.Name] = $s.Value }
$settings['PDA_MULTI_TENANT'] = 'true'
$settings['PDA_AUTH_MODE'] = 'entra'
$settings['ENTRA_API_CLIENT_ID'] = $api.AppId
$settings['ENTRA_SPA_CLIENT_ID'] = $spa.AppId
$settings['PDA_MI_CLIENT_ID'] = $ua.ClientId
$settings['PDA_PUBLIC_URL'] = $PublicUrl
Set-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName -AppSettings $settings | Out-Null
Restart-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName | Out-Null
Ok 'Saved and restarted'

Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "  1. Publisher verification for '$apiName' and '$spaName' (Entra admin center → App registrations → Branding & properties)."
Write-Host "  2. Try it with a second tenant (a Microsoft 365 developer tenant): open $PublicUrl/#/signup as its Global Administrator."
Write-Host "  3. Optional: PDA_SELF_SIGNUP=false to allow only tenants you register with 'npm run tenant -- add'."

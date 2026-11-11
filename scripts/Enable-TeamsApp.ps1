<#
.SYNOPSIS
  Sets up the Process Documentation Agent as a Microsoft Teams app that can read meeting transcripts.

.DESCRIPTION
  Least privilege. Transcripts are read with DELEGATED permissions on behalf of the signed-in person,
  so the app can only read meetings that person organised. It gets no tenant-wide application
  permission, needs no application access policy and has no client secret.

  On the API app registration ("Process Documentation Agent API"), the script:
    1. Adds the Teams sign-in address api://<app host>/<client id> and pre-authorises the Teams
       desktop/mobile and web clients for the access_as_user scope. That is Teams single sign-on.
    2. Adds two delegated Microsoft Graph permissions and grants admin consent for them:
         OnlineMeetings.Read               find the meeting from its link or meeting chat
         OnlineMeetingTranscript.Read.All  read the transcript of a meeting the person may read
    3. Adds a federated identity credential that trusts the App Service's user-assigned managed
       identity (<prefix>-id-<suffix>, created by the deployment). The app exchanges that identity's
       token for the on-behalf-of call, so no secret exists.

  Run it once as a Global Administrator, Privileged Role Administrator or Cloud Application
  Administrator (the consent step needs one of the first two for Graph permissions). Undo with -Remove.
  Afterwards: Administration → Microsoft Teams → download the app package, then upload it in the
  Teams admin center → Teams apps → Manage apps → Upload new app. Transcription must be allowed in the
  Teams meeting policy.

.EXAMPLE
  ./Enable-TeamsApp.ps1 -WebAppName pda-app-xxxx
.EXAMPLE
  ./Enable-TeamsApp.ps1 -WebAppName pda-app-xxxx -Remove
#>
param(
  [Parameter(Mandatory)] [string] $WebAppName,
  [string] $HostName = "$WebAppName.azurewebsites.net",
  [string] $IdentityName = ($WebAppName -replace '-app-', '-id-'),
  [string] $ApiAppName = 'Process Documentation Agent API',
  [switch] $Remove
)
$ErrorActionPreference = 'Stop'
function Ok($m) { Write-Host "  [ok] $m" -ForegroundColor Green }

foreach ($m in 'Microsoft.Graph.Applications', 'Microsoft.Graph.Identity.SignIns', 'Microsoft.Graph.Authentication') {
  if (-not (Get-Module -ListAvailable $m)) { Install-Module $m -Scope CurrentUser -Force }
}
Connect-MgGraph -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -NoWelcome
$tenantId = (Get-MgContext).TenantId

$TEAMS_CLIENTS = @('1fec8e78-bce4-4aaf-ab1b-5451cc387264', '5e3ce6c0-2b1f-4285-8d4b-75ee78787346') # Teams desktop/mobile, Teams web
$GRAPH_SCOPES = @('OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All')
$FIC_NAME = 'pda-teams-managed-identity'

$api = @(Get-MgApplication -Filter "displayName eq '$ApiAppName'")
if ($api.Count -ne 1) { throw "App registration '$ApiAppName' not found (or not unique). Run Setup-EntraAndSharePoint.ps1 first." }
$api = $api[0]
$apiSp = Get-MgServicePrincipal -Filter "appId eq '$($api.AppId)'"
$graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$scope = $api.Api.Oauth2PermissionScopes | Where-Object Value -eq 'access_as_user' | Select-Object -First 1
if (-not $scope) { throw "The API app has no access_as_user scope. Run Setup-EntraAndSharePoint.ps1 first." }
$teamsUri = "api://$HostName/$($api.AppId)"

# --- 1. Teams single sign-on
$uris = @($api.IdentifierUris)
$pre = @($api.Api.PreAuthorizedApplications | ForEach-Object { @{ AppId = $_.AppId; DelegatedPermissionIds = @($_.DelegatedPermissionIds) } })
if ($Remove) {
  $uris = @($uris | Where-Object { $_ -ne $teamsUri })
  $pre = @($pre | Where-Object { $TEAMS_CLIENTS -notcontains $_.AppId })
} else {
  if ($uris -notcontains $teamsUri) { $uris += $teamsUri }
  foreach ($c in $TEAMS_CLIENTS) { if (-not ($pre | Where-Object { $_.AppId -eq $c })) { $pre += @{ AppId = $c; DelegatedPermissionIds = @("$($scope.Id)") } } }
}
$apiBody = @{ Oauth2PermissionScopes = $api.Api.Oauth2PermissionScopes; PreAuthorizedApplications = $pre }
if ($api.Api.RequestedAccessTokenVersion) { $apiBody.RequestedAccessTokenVersion = $api.Api.RequestedAccessTokenVersion }
Update-MgApplication -ApplicationId $api.Id -IdentifierUris $uris -Api $apiBody
Ok ($(if ($Remove) { "Removed Teams sign-in ($teamsUri)" } else { "Teams sign-in: $teamsUri, Teams clients pre-authorised" }))

# --- 2. Delegated Graph permissions + admin consent
$ids = foreach ($s in $GRAPH_SCOPES) { ($graphSp.Oauth2PermissionScopes | Where-Object Value -eq $s).Id }
$rra = @($api.RequiredResourceAccess | ForEach-Object { @{ ResourceAppId = $_.ResourceAppId; ResourceAccess = @($_.ResourceAccess | ForEach-Object { @{ Id = $_.Id; Type = $_.Type } }) } })
$g = $rra | Where-Object { $_.ResourceAppId -eq $graphSp.AppId }
if (-not $g) { $g = @{ ResourceAppId = $graphSp.AppId; ResourceAccess = @() }; $rra += $g }
if ($Remove) { $g.ResourceAccess = @($g.ResourceAccess | Where-Object { $ids -notcontains $_.Id }) }
else { foreach ($i in $ids) { if (-not ($g.ResourceAccess | Where-Object { $_.Id -eq $i })) { $g.ResourceAccess += @{ Id = $i; Type = 'Scope' } } } }
$rra = @($rra | Where-Object { $_.ResourceAccess.Count -gt 0 })
Update-MgApplication -ApplicationId $api.Id -RequiredResourceAccess $rra

$grant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$($apiSp.Id)' and resourceId eq '$($graphSp.Id)' and consentType eq 'AllPrincipals'" | Select-Object -First 1
$have = @(if ($grant) { $grant.Scope -split ' ' | Where-Object { $_ } })
$want = if ($Remove) { @($have | Where-Object { $GRAPH_SCOPES -notcontains $_ }) } else { @($have + $GRAPH_SCOPES | Select-Object -Unique) }
if ($grant -and -not $want.Count) { Remove-MgOauth2PermissionGrant -OAuth2PermissionGrantId $grant.Id }
elseif ($grant) { Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $grant.Id -Scope ($want -join ' ') }
elseif ($want.Count) { New-MgOauth2PermissionGrant -ClientId $apiSp.Id -ConsentType 'AllPrincipals' -ResourceId $graphSp.Id -Scope ($want -join ' ') | Out-Null }
Ok ($(if ($Remove) { "Removed $($GRAPH_SCOPES -join ', ')" } else { "Delegated $($GRAPH_SCOPES -join ', ') with admin consent" }))

# --- 3. Keyless credential: trust the user-assigned managed identity
$existing = Get-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id | Where-Object Name -eq $FIC_NAME
if ($Remove) {
  if ($existing) { Remove-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id -FederatedIdentityCredentialId $existing.Id }
  Ok 'Removed the federated credential'
  Write-Host "`nDone. Remove the app in the Teams admin center too." -ForegroundColor Green; return
}
$mi = @(Get-MgServicePrincipal -Filter "displayName eq '$IdentityName'" | Where-Object ServicePrincipalType -eq 'ManagedIdentity')
if ($mi.Count -ne 1) { throw "Managed identity '$IdentityName' not found. Deploy the latest version first (it creates it), or pass -IdentityName." }
$fic = @{ Name = $FIC_NAME; Issuer = "https://login.microsoftonline.com/$tenantId/v2.0"; Subject = $mi[0].Id; Audiences = @('api://AzureADTokenExchange'); Description = "Process Documentation Agent ($WebAppName): Teams transcripts on behalf of the user" }
if ($existing) { Update-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id -FederatedIdentityCredentialId $existing.Id -BodyParameter $fic }
else { New-MgApplicationFederatedIdentityCredential -ApplicationId $api.Id -BodyParameter $fic | Out-Null }
Ok "Federated credential trusts $IdentityName"

Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "  1. In the app: Administration → Microsoft Teams → Download the Teams app package."
Write-Host "  2. Teams admin center → Teams apps → Manage apps → Upload new app → choose the .zip."
Write-Host "  3. Teams admin center → Meetings → Meeting policies: transcription allowed."
Write-Host "Changes to sign-in can take a few minutes to apply." -ForegroundColor Green

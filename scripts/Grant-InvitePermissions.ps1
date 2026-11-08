<#
.SYNOPSIS
  Lets the Process Documentation Agent invite testers (Administration → Testers).

.DESCRIPTION
  1. Gives the App Service managed identity two Microsoft Graph application permissions:
     - User.Invite.All            send Microsoft Entra B2B guest invitations
     - GroupMember.ReadWrite.All  add and remove members of groups (tenant-wide; the app itself only
                                  touches the three role groups you enter, and only removes guests)
  2. Prints the object ids of the groups that hold the app roles, to paste into
     Administration → Testers → Setup.

  Run it once as a Global Administrator or Privileged Role Administrator. Undo with -Remove.
  Guest invitations must be allowed in Entra ID → External Identities → External collaboration settings.
  Assigning app roles to groups needs Microsoft Entra ID P1 (e.g. Microsoft 365 Business Premium, E3, E5).

.EXAMPLE
  ./Grant-InvitePermissions.ps1 -WebAppName pda-app-xxxx
.EXAMPLE
  ./Grant-InvitePermissions.ps1 -WebAppName pda-app-xxxx -Remove
#>
param(
  [Parameter(Mandatory)] [string] $WebAppName,
  [string] $ApiAppName = 'Process Documentation Agent API',
  [switch] $Remove
)
$ErrorActionPreference = 'Stop'
function Ok($m) { Write-Host "  [ok] $m" -ForegroundColor Green }

foreach ($m in 'Microsoft.Graph.Applications', 'Microsoft.Graph.Authentication') {
  if (-not (Get-Module -ListAvailable $m)) { Install-Module $m -Scope CurrentUser -Force }
}
Connect-MgGraph -Scopes 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All', 'Group.Read.All' -NoWelcome

$mi = @(Get-MgServicePrincipal -Filter "displayName eq '$WebAppName'" | Where-Object ServicePrincipalType -eq 'ManagedIdentity')
if ($mi.Count -ne 1) { throw "Managed identity of '$WebAppName' not found. Check the App Service name (Identity must be switched on)." }
$mi = $mi[0]
$graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$current = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id -All

foreach ($perm in 'User.Invite.All', 'GroupMember.ReadWrite.All') {
  $role = $graphSp.AppRoles | Where-Object { $_.Value -eq $perm -and $_.AllowedMemberTypes -contains 'Application' }
  $has = $current | Where-Object { $_.ResourceId -eq $graphSp.Id -and $_.AppRoleId -eq $role.Id }
  if ($Remove) {
    if ($has) { Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id -AppRoleAssignmentId $has.Id; Ok "Removed $perm" } else { Ok "$perm was not granted" }
  } elseif ($has) { Ok "$perm already granted" }
  else { New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id -PrincipalId $mi.Id -ResourceId $graphSp.Id -AppRoleId $role.Id | Out-Null; Ok "Granted $perm (admin consent)" }
}
if ($Remove) { Write-Host "`nDone. Inviting from the app is switched off. Restart the web app to drop its cached token." -ForegroundColor Green; return }

$api = Get-MgServicePrincipal -Filter "displayName eq '$ApiAppName'" | Select-Object -First 1
if (-not $api) { Write-Warning "App '$ApiAppName' not found; look up the group ids in Entra ID → Groups."; return }
Write-Host "`nPaste these into Administration → Testers → Setup:" -ForegroundColor Cyan
$roles = @{}; foreach ($r in $api.AppRoles) { $roles["$($r.Id)"] = $r.Value -replace '^ProcessDoc\.', '' }
$groups = Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $api.Id -All | Where-Object PrincipalType -eq 'Group'
if (-not $groups) { Write-Warning 'No groups hold the app roles (roles are assigned to users directly, which happens without Entra ID P1). Create three groups, assign them the roles in Enterprise applications → Users and groups, then run this script again.' }
foreach ($g in $groups) { "{0,-12} {1}  ({2})" -f $roles["$($g.AppRoleId)"], $g.PrincipalId, $g.PrincipalDisplayName }
Write-Host "`nRestart the web app once so it picks up the new permissions (tokens are cached for up to an hour)." -ForegroundColor Green

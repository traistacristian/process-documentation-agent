<#
.SYNOPSIS
  Lets GitHub Actions deploy to the resource group with OpenID Connect (no secret stored in GitHub),
  and sets the repository variables the deploy workflow needs.

.DESCRIPTION
  Creates an app registration "Process Documentation Agent - GitHub deploy" with a federated credential
  for <owner>/<repo>, environment "production", gives it Contributor + User Access Administrator
  (limited to assigning Key Vault Secrets User) on the resource group, and prints - or, if the GitHub
  CLI is signed in, sets - the repository variables.

.EXAMPLE
  ./scripts/Connect-GitHubDeploy.ps1 -ResourceGroup rg-process-docs -Repository traistacristian/process-documentation-agent `
     -SharePointSiteUrl https://pbksupport.sharepoint.com/sites/process-documentation-agent -WebAppName pda-app-xxxx
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [ValidatePattern('^[\w.-]+/[\w.-]+$')] [string] $Repository,
  [Parameter(Mandatory)] [string] $SharePointSiteUrl,
  [Parameter(Mandatory)] [string] $WebAppName,
  [string] $LibraryName = 'Documents',
  [ValidateSet('foundry', 'anthropic', 'rules')] [string] $AiProvider = 'rules',
  [string] $FoundryResourceName = ''
)
$ErrorActionPreference = 'Stop'
$ctx = Get-AzContext
if (-not $ctx) { Connect-AzAccount | Out-Null; $ctx = Get-AzContext }
$rg = Get-AzResourceGroup -Name $ResourceGroup
$name = 'Process Documentation Agent - GitHub deploy'

$app = Get-AzADApplication -DisplayName $name | Select-Object -First 1
if (-not $app) { $app = New-AzADApplication -DisplayName $name }
$sp = Get-AzADServicePrincipal -ApplicationId $app.AppId
if (-not $sp) { $sp = New-AzADServicePrincipal -ApplicationId $app.AppId }

$subject = "repo:$($Repository):environment:production"
if (-not (Get-AzADAppFederatedCredential -ApplicationObjectId $app.Id | Where-Object Subject -eq $subject)) {
  New-AzADAppFederatedCredential -ApplicationObjectId $app.Id -Name 'github-production' -Issuer 'https://token.actions.githubusercontent.com' -Subject $subject -Audience 'api://AzureADTokenExchange' | Out-Null
}
# Contributor deploys the resources; the template also creates one role assignment (Key Vault Secrets User
# for the app's identity), which needs permission to write role assignments on this resource group.
foreach ($role in 'Contributor', 'Role Based Access Control Administrator') {
  if (-not (Get-AzRoleAssignment -ObjectId $sp.Id -Scope $rg.ResourceId -RoleDefinitionName $role -ErrorAction SilentlyContinue)) {
    New-AzRoleAssignment -ObjectId $sp.Id -Scope $rg.ResourceId -RoleDefinitionName $role | Out-Null
  }
}

$web = Get-AzWebApp -ResourceGroupName $ResourceGroup -Name $WebAppName
$s = @{}; foreach ($x in $web.SiteConfig.AppSettings) { $s[$x.Name] = $x.Value }
$vars = [ordered]@{
  AZURE_CLIENT_ID       = $app.AppId
  AZURE_TENANT_ID       = $ctx.Tenant.Id
  AZURE_SUBSCRIPTION_ID = $ctx.Subscription.Id
  AZURE_RESOURCE_GROUP  = $ResourceGroup
  SHAREPOINT_SITE_URL   = $SharePointSiteUrl
  SHAREPOINT_LIBRARY    = $LibraryName
  COST_PROFILE          = 'free'
  AI_PROVIDER           = $AiProvider
  FOUNDRY_RESOURCE_NAME = $FoundryResourceName
  ENTRA_API_CLIENT_ID   = $s['ENTRA_API_CLIENT_ID']
  ENTRA_SPA_CLIENT_ID   = $s['ENTRA_SPA_CLIENT_ID']
}
if (-not $vars.ENTRA_API_CLIENT_ID) { Write-Warning 'ENTRA_API_CLIENT_ID is empty: run Setup-EntraAndSharePoint.ps1 first.' }

$gh = Get-Command gh -ErrorAction SilentlyContinue
$ghOk = $false
if ($gh) { gh auth status *> $null; $ghOk = ($LASTEXITCODE -eq 0) }
if ($ghOk) {
  gh api -X PUT "repos/$Repository/environments/production" | Out-Null
  foreach ($k in $vars.Keys) { if ("$($vars[$k])") { gh variable set $k --repo $Repository --body "$($vars[$k])" } }
  Write-Host "Repository variables set on $Repository. Start the first deployment: gh workflow run deploy.yml --repo $Repository" -ForegroundColor Green
} else {
  Write-Host "`nAdd these in GitHub: $Repository > Settings > Secrets and variables > Actions > Variables (they are ids, not secrets)," -ForegroundColor Yellow
  Write-Host "and create the environment 'production' under Settings > Environments. Then run 'Deploy to Azure' from the Actions tab.`n" -ForegroundColor Yellow
  foreach ($k in $vars.Keys) { '{0,-22} {1}' -f $k, $vars[$k] }
}

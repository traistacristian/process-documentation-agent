<#
  Sets the Process Documentation Agent extension policy for Edge and Chrome (HKLM, machine-wide).
  Deploy as an Intune platform script (run as SYSTEM, 64-bit) or run once elevated.
  Example: .\set-extension-policy.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop -ServerUrl https://pda-app-xxxx.azurewebsites.net
#>
param(
  [Parameter(Mandatory)] [ValidatePattern('^[a-p]{32}$')] [string] $ExtensionId,
  [Parameter(Mandatory)] [ValidatePattern('^https://')] [string] $ServerUrl
)
$ErrorActionPreference = 'Stop'
$origin = ([uri]$ServerUrl).GetLeftPart([System.UriPartial]::Authority)
foreach ($browser in 'Microsoft\Edge', 'Google\Chrome') {
  $base = "HKLM:\SOFTWARE\Policies\$browser\3rdparty\extensions\$ExtensionId\policy"
  New-Item -Path "$base\allowedServers" -Force | Out-Null
  Set-ItemProperty -Path "$base\allowedServers" -Name '1' -Value $origin -Type String
  Set-ItemProperty -Path $base -Name 'serverUrl' -Value $origin -Type String
}
Write-Output "Extension $ExtensionId may pair only with $origin"

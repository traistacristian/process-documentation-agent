<#
  Intune Win32 app install script for the desktop capture agent.
  Package:  IntuneWinAppUtil.exe -c <folder with ProcessDocAgent\ and this script> -s Install-ProcessDocAgent.ps1 -o out
  Install command:   powershell.exe -ExecutionPolicy Bypass -File Install-ProcessDocAgent.ps1 -ServerUrl https://pda-app-xxxx.azurewebsites.net
  Uninstall command: powershell.exe -ExecutionPolicy Bypass -File Install-ProcessDocAgent.ps1 -Uninstall
  Detection rule:    File exists  %ProgramFiles%\ProcessDocumentationAgent\ProcessDocAgent.exe
  Install behaviour: System
#>
param(
  [string] $ServerUrl,
  [switch] $Uninstall
)
$ErrorActionPreference = 'Stop'
$target = Join-Path $env:ProgramFiles 'ProcessDocumentationAgent'
$policyKey = 'HKLM:\SOFTWARE\Policies\ProcessDocumentationAgent'
$shortcut = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Process Documentation Agent.lnk'

if ($Uninstall) {
  Get-Process ProcessDocAgent -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $shortcut -Force -ErrorAction SilentlyContinue
  Remove-Item $policyKey -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}
if (-not $ServerUrl -or $ServerUrl -notmatch '^https://') { throw '-ServerUrl https://... is required' }

New-Item $target -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'ProcessDocAgent\*') $target -Recurse -Force

$origin = ([uri]$ServerUrl).GetLeftPart([System.UriPartial]::Authority)
New-Item $policyKey -Force | Out-Null
Set-ItemProperty $policyKey -Name ServerUrl -Value $origin -Type String
New-ItemProperty $policyKey -Name AllowedServers -Value @($origin) -PropertyType MultiString -Force | Out-Null

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($shortcut)
$lnk.TargetPath = Join-Path $target 'ProcessDocAgent.exe'
$lnk.Description = 'Capture desktop steps for a Process Documentation Agent recording'
$lnk.Save()
exit 0

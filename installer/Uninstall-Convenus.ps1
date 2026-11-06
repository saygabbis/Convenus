#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Convenus'
$ProfileDir = Join-Path $InstallDir 'chrome-profile'
$Startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Convenus Sync.lnk'

Write-Host "Removendo Convenus Sync..." -ForegroundColor Cyan

Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -like "*$ProfileDir*") {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 1

if (Test-Path $Startup) { Remove-Item $Startup -Force }
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }

Write-Host "Removido. O Chrome normal do usuario permanece intacto." -ForegroundColor Green

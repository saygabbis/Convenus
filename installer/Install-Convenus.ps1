#Requires -Version 5.1
<#
.SYNOPSIS
  Instalador Convenus (sem admin): perfil Chrome dedicado, extensao, login Google,
  inicio com o Windows e execucao em segundo plano/bandeja.
#>
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
. "$Root\lib\ChromePath.ps1"
. "$Root\lib\CdpClient.ps1"
. "$Root\lib\GoogleLogin.ps1"

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    ! $msg" -ForegroundColor Yellow }

$InstallDir = Join-Path $env:LOCALAPPDATA 'Convenus'
$ProfileDir = Join-Path $InstallDir 'chrome-profile'
$ExtDir = Join-Path $InstallDir 'extension'
$SecretsSrc = Join-Path $Root 'secrets.local.json'
$SecretsDst = Join-Path $InstallDir 'secrets.local.json'
$DebugPort = 9229
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'Convenus Sync.lnk'
$StartHiddenVbs = Join-Path $InstallDir 'Start-Convenus-Hidden.vbs'
$StartPs1 = Join-Path $InstallDir 'Start-Convenus.ps1'

Write-Host "Convenus — instalador (sem administrador)" -ForegroundColor White
Write-Host "Destino: $InstallDir"

# --- secrets ---
if (-not (Test-Path $SecretsSrc)) {
  throw "Falta secrets.local.json ao lado do instalador."
}
$secrets = Get-Content $SecretsSrc -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $secrets.email -or -not $secrets.password -or -not $secrets.adminToken) {
  throw "secrets.local.json incompleto (email/password/adminToken)."
}

$chrome = Get-ChromePath
Write-Ok "Chrome: $chrome"

Write-Step "Copiando arquivos"
New-Item -ItemType Directory -Force -Path $InstallDir, $ProfileDir, $ExtDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $Root 'extension\*') $ExtDir
Copy-Item -Force $SecretsSrc $SecretsDst

# Garante config da extensao com o token da VPS
$cfgPath = Join-Path $ExtDir 'config.local.json'
@{
  apiBase = $(if ($secrets.apiBase) { $secrets.apiBase } else { 'https://convert.saygabbis.cloud' })
  adminToken = $secrets.adminToken
  deviceName = "PC $($env:COMPUTERNAME)"
  autoSyncCookies = $true
  syncMinutes = 2
} | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
Write-Ok "Extensao + config em $ExtDir"

Write-Step "Preparando perfil Chrome (modo segundo plano)"
$localStatePath = Join-Path $ProfileDir 'Local State'
$defaultDir = Join-Path $ProfileDir 'Default'
New-Item -ItemType Directory -Force -Path $defaultDir | Out-Null
$prefsPath = Join-Path $defaultDir 'Preferences'

$localState = @{
  background_mode = @{ enabled = $true }
  browser = @{ enabled_labs_experiments = @() }
}
$localState | ConvertTo-Json -Depth 6 | Set-Content $localStatePath -Encoding UTF8

$prefs = @{
  session = @{
    restore_on_startup = 1
  }
  profile = @{
    exit_type = 'Normal'
    exited_cleanly = $true
  }
  browser = @{
    check_default_browser = $false
  }
  distribution = @{
    import_search_engine = $false
    import_history = $false
    skip_first_run_ui = $true
  }
}
$prefs | ConvertTo-Json -Depth 8 | Set-Content $prefsPath -Encoding UTF8
Write-Ok "Preferencias de background gravadas"

Write-Step "Gravando scripts de inicio"
$startScript = @"
#Requires -Version 5.1
`$ErrorActionPreference = 'Stop'
`$InstallDir = '$InstallDir'
`$ProfileDir = '$ProfileDir'
`$ExtDir = '$ExtDir'
function Get-ChromePath {
  foreach (`$p in @(
    "`$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "`${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "`$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )) { if (Test-Path `$p) { return `$p } }
  throw 'Chrome nao encontrado'
}
# Mata so instancias DESTE perfil (nao mexe no Chrome normal)
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if (`$_.CommandLine -and `$_.CommandLine -like "*$($ProfileDir.Replace('\','\\'))*") {
    Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 800
`$chrome = Get-ChromePath
`$args = @(
  "--user-data-dir=`$ProfileDir",
  "--load-extension=`$ExtDir",
  "--disable-extensions-except=`$ExtDir",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-sync",
  "--window-size=900,700",
  "https://www.youtube.com/"
)
Start-Process -FilePath `$chrome -ArgumentList `$args -WindowStyle Minimized
# Apos alguns segundos, tenta fechar so a janela (Chrome fica na bandeja com background_mode)
Start-Sleep -Seconds 8
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
  `$procs = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { `$_.MainWindowHandle -ne 0 }
  foreach (`$p in `$procs) {
    `$cl = (Get-CimInstance Win32_Process -Filter "ProcessId = `$(`$p.Id)").CommandLine
    if (`$cl -and `$cl -like "*Convenus\chrome-profile*") {
      `$p.CloseMainWindow() | Out-Null
    }
  }
} catch {}
"@
Set-Content -Path $StartPs1 -Value $startScript -Encoding UTF8

$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$StartPs1""", 0, False
"@
Set-Content -Path $StartHiddenVbs -Value $vbs -Encoding ASCII
Write-Ok "Start-Convenus.ps1 + VBS oculto"

Write-Step "Atalho no Iniciar com o Windows (Startup do usuario)"
$wshell = New-Object -ComObject WScript.Shell
$sc = $wshell.CreateShortcut($ShortcutPath)
$sc.TargetPath = $StartHiddenVbs
$sc.WorkingDirectory = $InstallDir
$sc.WindowStyle = 7
$sc.Description = 'Convenus — sync YouTube em segundo plano'
$sc.Save()
Write-Ok $ShortcutPath

Write-Step "Abrindo Chrome do Convenus para login automatico"
# Encerra instancia anterior deste perfil
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -like "*$ProfileDir*") {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 1

$launchArgs = @(
  "--user-data-dir=$ProfileDir",
  "--remote-debugging-port=$DebugPort",
  "--remote-allow-origins=*",
  "--load-extension=$ExtDir",
  "--disable-extensions-except=$ExtDir",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-blink-features=AutomationControlled",
  "--window-size=1000,800",
  "about:blank"
)
$proc = Start-Process -FilePath $chrome -ArgumentList $launchArgs -PassThru
Write-Ok "Chrome PID $($proc.Id) (porta CDP $DebugPort)"

# Espera CDP
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 1
    $ready = $true
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) { throw "Chrome CDP nao respondeu na porta $DebugPort" }

$client = $null
$loginOk = $false
try {
  $client = Connect-Cdp -DebugUrl "http://127.0.0.1:$DebugPort"
  Write-Step "Login Google (conta descartavel)"
  $result = Invoke-GoogleLogin -Client $client -Email $secrets.email -Password $secrets.password
  $loginOk = [bool]$result.ok
  if ($result.already) { Write-Ok "Ja estava logado" } else { Write-Ok "Login concluido" }
} catch {
  Write-Warn $_.Exception.Message
  Write-Warn "Se o Google pediu captcha/verificacao, conclua NA JANELA do Chrome que abriu e pressione Enter aqui."
  Read-Host "Quando o YouTube estiver logado na conta descartavel, Enter"
  $loginOk = $true
} finally {
  if ($client) { Close-Cdp $client }
}

Write-Step "Finalizando: segundo plano + bandeja"
# Fecha porta de debug: reinicia sem remote-debugging (mais estavel / menos bloqueio)
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -like "*$ProfileDir*") {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2
& $StartPs1
Write-Ok "Convenus em execucao (minimizado / bandeja)"

Write-Host ""
Write-Host "Pronto." -ForegroundColor Green
Write-Host " - Perfil:     $ProfileDir"
Write-Host " - Extensao:   $ExtDir"
Write-Host " - Iniciar:    $ShortcutPath"
Write-Host " - Desinstalar: rode Uninstall-Convenus.ps1"
Write-Host ""
Write-Host "O Chrome NORMAL do amigo nao e afetado. So o perfil Convenus fica logado na descartavel."
if (-not $loginOk) {
  Write-Warn "Login pode ter ficado incompleto — abra o perfil Convenus e confira o YouTube."
}

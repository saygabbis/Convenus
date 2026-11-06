#Requires -Version 5.1
# Gera dist\Convenus-Setup.zip para mandar ao amigo (duplo clique em Instalar.bat).
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Repo = Split-Path $Root -Parent
$OutDir = Join-Path $Repo 'dist\Convenus-Setup'
$Zip = Join-Path $Repo 'dist\Convenus-Setup.zip'

if (-not (Test-Path (Join-Path $Root 'secrets.local.json'))) {
  throw 'Crie installer\secrets.local.json antes de empacotar.'
}

# Atualiza extensao no pacote
$extSrc = Join-Path $Repo 'extension'
$extDst = Join-Path $Root 'extension'
New-Item -ItemType Directory -Force -Path $extDst | Out-Null
Copy-Item -Recurse -Force "$extSrc\*" $extDst
Remove-Item (Join-Path $extDst 'README.md') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $extDst 'config.example.json') -ErrorAction SilentlyContinue

$secrets = Get-Content (Join-Path $Root 'secrets.local.json') -Raw | ConvertFrom-Json
@{
  apiBase = $secrets.apiBase
  adminToken = $secrets.adminToken
  deviceName = 'Convenus Ext'
  autoSyncCookies = $true
  syncMinutes = 2
} | ConvertTo-Json | Set-Content (Join-Path $extDst 'config.local.json') -Encoding UTF8

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Copy-Item (Join-Path $Root 'Instalar.bat') $OutDir
Copy-Item (Join-Path $Root 'Desinstalar.bat') $OutDir
Copy-Item (Join-Path $Root 'Install-Convenus.ps1') $OutDir
Copy-Item (Join-Path $Root 'Uninstall-Convenus.ps1') $OutDir
Copy-Item (Join-Path $Root 'secrets.local.json') $OutDir
Copy-Item -Recurse (Join-Path $Root 'lib') (Join-Path $OutDir 'lib')
Copy-Item -Recurse $extDst (Join-Path $OutDir 'extension')

@"
Convenus Sync — para o amigo
============================

1. Instale o Google Chrome (se ainda nao tiver).
2. Duplo clique em Instalar.bat (NAO precisa senha de administrador).
3. Espere o script logar na conta descartavel e ir pra bandeja.
4. Pronto: inicia com o Windows sozinho.

Se o Google pedir captcha/verificacao na primeira vez, resolva na janela
e aperte Enter no instalador.

Desinstalar: Desinstalar.bat
"@ | Set-Content (Join-Path $OutDir 'LEIA-ME.txt') -Encoding UTF8

if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $Zip -Force
Write-Host "Pacote: $Zip"
Write-Host "Pasta:  $OutDir"

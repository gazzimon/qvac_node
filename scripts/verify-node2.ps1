# Verificador de la DoD de Fase 0, para correr en la MAQUINA 2 (Windows).
#
# No necesita el repo: se pega en una PowerShell y listo. Ese es el punto del
# track — la maquina 2 no clona nada, todo viaja por P2P.
#
#   powershell -ExecutionPolicy Bypass -File verify-node2.ps1
#
# Instala en una carpeta propia y llama al binario por ruta completa, para no
# depender de que el PATH se refresque (que es lo que mas confunde este test).

$ErrorActionPreference = 'Stop'
$Link = 'pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny'
$Target = Join-Path $env:USERPROFILE 'qvac-node-test'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "    FALLA $msg" -ForegroundColor Red }

Step 0 'Internet (no alcanza con estar conectado al wifi)'
# Hyperswarm necesita llegar a los nodos bootstrap de la DHT. Sin internet real
# el install solo puede dar "Network Timeout 30s", que no dice nada sobre la
# causa: un hotspot sin datos da link wifi perfecto y cero conectividad.
try {
  $null = Invoke-WebRequest -Uri 'https://github.com' -TimeoutSec 15 -UseBasicParsing
  Ok 'hay salida a internet'
} catch {
  Fail 'NO hay internet. El wifi puede estar conectado igual.'
  Write-Host '    Si es un hotspot, fijate que el telefono tenga datos moviles.'
  exit 1
}

Step 1 'Node y npm'
try {
  $nodeV = (& node --version) 2>&1
  Ok "node $nodeV / npm $((& npm --version) 2>&1)"
} catch {
  Fail 'Node no esta instalado. Instalalo desde https://nodejs.org y volve a correr esto.'
  exit 1
}

Step 2 'CLI de Pear'
$pearExe = Join-Path $env:LOCALAPPDATA 'Programs\pear\pear.exe'
if (-not (Test-Path $pearExe)) {
  Write-Host '    instalando pear...'
  & npm install -g pear 2>&1 | Select-Object -Last 3
  # la primera invocacion es la que baja el runtime real; el npm install solo
  # deja un shim. Sin este paso el install falla de formas poco descriptivas.
  & pear help *> $null
}
if (Test-Path $pearExe) { Ok $pearExe } else { Fail 'no se encontro pear.exe'; exit 1 }

Step 3 "Instalando en $Target"
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }
$t0 = Get-Date
& $pearExe install --to $Target $Link
$secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

$bin = Join-Path $Target 'qvac-node.exe'
if (Test-Path $bin) {
  $mb = [math]::Round((Get-Item $bin).Length / 1MB, 1)
  Ok "instalado en ${secs}s, $mb MB"
} else {
  Fail 'el binario no quedo en disco'
  exit 1
}

Step 4 'Version instalada'
$v = (& $bin --version) 2>&1
Ok $v

Write-Host "`n=== INSTALL OK ===" -ForegroundColor Green
Write-Host @"

Falta la mitad OTA de la DoD. Dejalo corriendo:

    $bin

y desde la MAQUINA 1 publica una version nueva:

    npm version 0.5.0 --no-git-tag-version
    npm run release

Si aca aparecen lineas [updater] sin que toques nada, Fase 0 esta cerrada.
"@

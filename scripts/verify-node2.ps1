# Verificador de la DoD de Fase 0 Y Fase 1, para correr en la MAQUINA 2
# (Windows).
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
$Pregunta = 'Explica en dos frases que es una red peer-to-peer.'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "    FALLA $msg" -ForegroundColor Red }

# Extrae un numero de las mediciones que imprime el CLI.
function Metric($text, $label) {
  $m = [regex]::Match($text, [regex]::Escape($label) + '\s*:\s*([\d.]+)s')
  if ($m.Success) { return [double]$m.Groups[1].Value }
  return $null
}

# Corre el binario capturando stdout Y stderr sin que el script se caiga.
#
# El addon de llama.cpp escribe "parse: load the model metadata..." por stderr.
# En PowerShell 5.1 cada linea de stderr de un exe nativo se envuelve en un
# ErrorRecord, y con $ErrorActionPreference='Stop' eso ABORTA el script en el
# medio de una corrida perfectamente sana. Se baja a 'Continue' solo alrededor
# de la llamada.
function RunBin {
  param([string]$Exe, [string[]]$BinArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return (& $Exe @BinArgs 2>&1 | Out-String)
  } finally {
    $ErrorActionPreference = $prev
  }
}

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
$v = (RunBin $bin @('--version')).Trim()
Ok $v

Step 5 'Inferencia 100% local (Fase 1)'
Write-Host @'
    La PRIMERA corrida baja el modelo: 807 MB, por hypercore (no por HTTP).
    En una wifi mala esto tarda. Si ya lo bajaste antes, arranca al toque.
    Ctrl+C ahora si preferis no bajarlo todavia.
'@
$out = RunBin $bin @('prompt', $Pregunta)
$out -split "`n" | ForEach-Object { Write-Host "    | $_" }

$load = Metric $out 'carga del modelo'
$ttft = Metric $out 'primer token (TTFT)'

if ($null -eq $ttft) {
  Fail 'no hubo primer token: la inferencia no corrio'
  exit 1
}
Ok "primer token en ${ttft}s (carga del modelo: ${load}s)"

# El numero que faltaba de la DoD de Fase 1: del `pear install` al primer
# token. Se compone de partes medidas, no se estima.
$total = [math]::Round($secs + $load + $ttft, 1)
Ok "pear install -> primer token: ${total}s"
Write-Host "         (install ${secs}s + carga ${load}s + TTFT ${ttft}s)"

Step 6 'GPU vs CPU en ESTA maquina'
# En la maquina Windows de la demo (Intel UHD 620) el CPU gana 8x: la iGPU
# comparte la RAM del sistema y paga la copia sin ganar computo. En una Mac
# con Metal deberia ganar la GPU. Hay que medirlo, no suponerlo.
$out2 = RunBin $bin @('prompt', $Pregunta, '--gpu-layers', '0')
$ttft2 = Metric $out2 'primer token (TTFT)'
if ($null -ne $ttft2) {
  Ok "TTFT default ${ttft}s   vs   --gpu-layers 0 ${ttft2}s"
  Write-Host '    Anota cual gana aca: es el flag que hay que usar en la demo.'
} else {
  Fail 'la corrida con --gpu-layers 0 no dio primer token'
}

Step 7 'Acentos por argv (bug conocido de bare-build en Windows)'
# El binario standalone de bare-build recibe el argv en codepage ANSI y rompe
# todo lo no-ASCII. Se espera que ESTE paso FALLE en Windows: no es un
# problema nuestro, es de bare-build, y por eso existe `prompt -`.
$echoed = (RunBin $bin @('prompt', '¿Qué es esto?', '--gpu-layers', '0')) -split "`n" |
  Where-Object { $_ -like '> *' } | Select-Object -First 1
if ($echoed -like '*¿Qué*') {
  Ok "argv pasa los acentos limpios:  $echoed"
} else {
  Fail "argv ROMPE los acentos:  $echoed"
  Write-Host '    Esperado en Windows. Usa stdin en la demo:'
  Write-Host '        "¿Qué es P2P?" | qvac-node prompt -'
}

Write-Host "`n=== FASE 1 OK EN ESTA MAQUINA ===" -ForegroundColor Green
Write-Host @"

Falta la mitad OTA de la DoD de Fase 0. Dejalo corriendo:

    $bin

y desde la MAQUINA 1 publica una version nueva:

    npm version 0.11.0 --no-git-tag-version
    npm run release

Si aca aparecen lineas [updater] sin que toques nada, Fase 0 tambien cierra.
"@

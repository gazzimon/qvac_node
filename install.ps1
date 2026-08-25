# Instalador de una linea para Windows:
#
#   irm https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.ps1 | iex
#
# Baja el binario standalone y lo ejecuta. El binario trae el motor de
# inferencia adentro: NO hace falta Node, ni npm, ni Pear.
#
# La instalacion por Pear sigue existiendo y es la que da updates OTA
# automaticos; esta via es para el primer contacto.

$ErrorActionPreference = 'Stop'

$repo = 'gazzimon/qvac_node'
$bin  = 'pyrusllm'

# win32-arm64 no se publica: @qvac/llm-llamacpp no tiene prebuild para esa
# plataforma, asi que con la inferencia adentro el binario no compila.
# Ver NOTES.md, "Fase 1 / plataformas".
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Host ''
  Write-Error "pyrusllm: no hay binario para Windows ARM64 todavia."
  exit 1
}

$target = 'win32-x64'
$url    = "https://github.com/$repo/releases/latest/download/$bin-$target.exe"

# En %LOCALAPPDATA% y no en Program Files: no requiere permisos de
# administrador. Pedir UAC para probar una app es una puerta que mucha gente
# no cruza.
$dir  = if ($env:PYRUSLLM_DIR) { $env:PYRUSLLM_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\pyrusllm' }
$dest = Join-Path $dir "$bin.exe"

New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host ''
Write-Host "  pyrusllm -- instalando para $target"
Write-Host ''

# Se baja a un temporal y recien al final se mueve, para que un corte de red no
# deje un ejecutable a medias en el PATH. Son ~165 MB.
$tmp = Join-Path $env:TEMP "pyrusllm-$([guid]::NewGuid().ToString('N')).part"

try {
  # ProgressPreference silencioso: la barra de Invoke-WebRequest hace la
  # descarga varias veces mas lenta en PowerShell 5.1 (bug conocido).
  $prev = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  $ProgressPreference = $prev
} catch {
  Write-Host ''
  Write-Host "  no se pudo bajar $url" -ForegroundColor Red
  Write-Host "  Si el release todavia no esta publicado, la via alternativa es:" -ForegroundColor Red
  Write-Host "    npm i -g pear" -ForegroundColor Red
  Write-Host "    pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny" -ForegroundColor Red
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  exit 1
}

# Checksum si el release lo publica. No se inventa una verificacion que no
# existe: si no hay .sha256 se dice, en vez de callarlo.
try {
  $sha = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content
  $esperado = ($sha -split '\s+')[0]
  $real = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash
  if ($real -ne $esperado) {
    Remove-Item $tmp -Force
    Write-Error "pyrusllm: el checksum no coincide. Se aborta."
    exit 1
  }
  Write-Host '  checksum verificado' -ForegroundColor DarkGray
} catch {
  Write-Host '  (el release no publica checksum: descarga sin verificar)' -ForegroundColor DarkGray
}

Move-Item -Path $tmp -Destination $dest -Force

Write-Host ''
Write-Host "  instalado en $dest"

# PATH del usuario, no del sistema: tampoco requiere administrador.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  $env:Path = "$env:Path;$dir"
  Write-Host "  agregado al PATH (abri una terminal nueva para usar 'pyrusllm')"
}

# Ejecutarlo es la mitad del punto: el instalador termina con la app abierta en
# el navegador, no con instrucciones para un segundo paso.
Write-Host ''
Write-Host '  arrancando pyrusllm...'
Write-Host ''
& $dest

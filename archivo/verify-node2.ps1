# Phase 0 AND Phase 1 DoD verifier, meant to run on MACHINE 2
# (Windows).
#
# Doesn't need the repo: paste it into a PowerShell and you're done. That's
# the whole point of the track — machine 2 doesn't clone anything, everything
# travels over P2P.
#
#   powershell -ExecutionPolicy Bypass -File verify-node2.ps1
#
# Installs into its own folder and calls the binary by full path, so it
# doesn't depend on the PATH refreshing (which is what confuses this test
# the most).

$ErrorActionPreference = 'Stop'
$Link = 'pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny'
$Target = Join-Path $env:USERPROFILE 'qvac-node-test'
# Kept in Spanish on purpose — same benchmark prompt used verbatim in
# docs/NOTES.md, scripts/soak.js and verify-node2.sh (see the note in
# qvac/infer.mjs).
$Pregunta = 'Explica en dos frases que es una red peer-to-peer.'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "    FAIL $msg" -ForegroundColor Red }

# Extracts a number from the measurements the CLI prints.
function Metric($text, $label) {
  $m = [regex]::Match($text, [regex]::Escape($label) + '\s*:\s*([\d.]+)s')
  if ($m.Success) { return [double]$m.Groups[1].Value }
  return $null
}

# Runs the binary capturing stdout AND stderr without the script dying.
#
# llama.cpp's addon writes "parse: load the model metadata..." to stderr.
# In PowerShell 5.1 every stderr line from a native exe gets wrapped in an
# ErrorRecord, and with $ErrorActionPreference='Stop' that ABORTS the script
# in the middle of a perfectly healthy run. It's lowered to 'Continue' only
# around the call.
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

Step 0 'Internet (being connected to wifi is not enough)'
# Hyperswarm needs to reach the DHT bootstrap nodes. Without real internet
# the install can only give "Network Timeout 30s", which says nothing about
# the cause: a hotspot with no data gives a perfect wifi link and zero
# connectivity.
try {
  $null = Invoke-WebRequest -Uri 'https://github.com' -TimeoutSec 15 -UseBasicParsing
  Ok 'internet access is available'
} catch {
  Fail 'There is NO internet. Wifi may still show as connected.'
  Write-Host '    If it is a hotspot, check that the phone has mobile data.'
  exit 1
}

Step 1 'Node and npm'
try {
  $nodeV = (& node --version) 2>&1
  Ok "node $nodeV / npm $((& npm --version) 2>&1)"
} catch {
  Fail 'Node is not installed. Install it from https://nodejs.org and run this again.'
  exit 1
}

Step 2 'Pear CLI'
$pearExe = Join-Path $env:LOCALAPPDATA 'Programs\pear\pear.exe'
if (-not (Test-Path $pearExe)) {
  Write-Host '    installing pear...'
  & npm install -g pear 2>&1 | Select-Object -Last 3
  # the first invocation is what downloads the real runtime; npm install only
  # leaves a shim behind. Without this step the install fails in unhelpful ways.
  & pear help *> $null
}
if (Test-Path $pearExe) { Ok $pearExe } else { Fail 'pear.exe was not found'; exit 1 }

Step 3 "Installing into $Target"
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }
$t0 = Get-Date
$installOut = RunBin $pearExe @('install', '--to', $Target, $Link)
$secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
$installOut -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "    | $_" } }

$bin = Join-Path $Target 'qvac-node.exe'

# We trust NEITHER the file existing NOR the exit code.
#
# Measured on the MacBook: `pear install` printed "Network Timeout 30s" and
# "Failed", exited with code 0, and left a truncated 77 MB binary (out of
# 105 MB) with execute permission behind. The old check reported that as
# "OK installed in 34s": a false positive that marked Phase 0 as closed.
if ($installOut -match 'Network Timeout|Failed|Error') {
  Fail "the install did NOT finish cleanly (${secs}s). Look at the lines above."
  if (Test-Path $bin) {
    $mb = [math]::Round((Get-Item $bin).Length / 1MB, 1)
    Write-Host "    A PARTIAL binary of $mb MB was left behind: it is useless."
    Write-Host "    Delete it:  Remove-Item -Recurse -Force $Target"
  }
  Write-Host '    Retry: Hyperdrive is incremental and resumes from what was already downloaded.'
  Write-Host '    If it drops again, plan B: phone hotspot WITH DATA.'
  exit 1
}

if (-not (Test-Path $bin)) {
  Fail 'the binary did not end up on disk'
  exit 1
}
$mb = [math]::Round((Get-Item $bin).Length / 1MB, 1)
Ok "downloaded in ${secs}s, $mb MB"

Step 4 'The binary RUNS (this is the real proof the install worked)'
# A truncated binary exists, is executable, and does not start. Whether
# --version returns a version is the only thing that distinguishes a
# complete install from a partial one.
$v = (RunBin $bin @('--version')).Trim()
if ($v -match 'v\d+\.\d+\.\d+') {
  Ok $v
} else {
  Fail 'the binary is on disk but does NOT run: the install stayed incomplete.'
  Write-Host "    output of --version: $(if ($v) { $v } else { '(empty)' })"
  Write-Host "    Delete and retry:  Remove-Item -Recurse -Force $Target"
  exit 1
}

Step 5 'Fully local inference (Phase 1)'
Write-Host @'
    The FIRST run downloads the model: 807 MB, over hypercore (not HTTP).
    On bad wifi this takes a while. If you already downloaded it before, it starts right away.
    Ctrl+C now if you would rather not download it yet.
'@
$out = RunBin $bin @('prompt', $Pregunta)
$out -split "`n" | ForEach-Object { Write-Host "    | $_" }

$load = Metric $out 'model load'
$ttft = Metric $out 'first token (TTFT)'

if ($null -eq $ttft) {
  Fail 'there was no first token: inference did not run'
  exit 1
}
Ok "first token in ${ttft}s (model load: ${load}s)"

# The missing number from the Phase 1 DoD: from `pear install` to first
# token. Built from measured parts, not estimated.
$total = [math]::Round($secs + $load + $ttft, 1)
Ok "pear install -> first token: ${total}s"
Write-Host "         (install ${secs}s + load ${load}s + TTFT ${ttft}s)"

Step 6 'GPU vs CPU on THIS machine'
# On the demo's Windows machine (Intel UHD 620) the CPU wins 8x: the iGPU
# shares the system RAM and pays for the copy without gaining compute. On a
# Mac with Metal the GPU should win. It has to be measured, not assumed.
$out2 = RunBin $bin @('prompt', $Pregunta, '--gpu-layers', '0')
$ttft2 = Metric $out2 'first token (TTFT)'
if ($null -ne $ttft2) {
  Ok "TTFT default ${ttft}s   vs   --gpu-layers 0 ${ttft2}s"
  Write-Host '    Note which one wins here: that is the flag to use in the demo.'
} else {
  Fail 'the run with --gpu-layers 0 did not produce a first token'
}

Step 7 'Accents via argv (known bare-build bug on Windows)'
# The bare-build standalone binary receives argv in the ANSI codepage and
# breaks everything non-ASCII. This step is EXPECTED TO FAIL on Windows: it
# is not our bug, it is bare-build's, and that is why `prompt -` exists.
$echoed = (RunBin $bin @('prompt', '¿Qué es esto?', '--gpu-layers', '0')) -split "`n" |
  Where-Object { $_ -like '> *' } | Select-Object -First 1
if ($echoed -like '*¿Qué*') {
  Ok "argv passes accents cleanly:  $echoed"
} else {
  Fail "argv BREAKS accents:  $echoed"
  Write-Host '    Expected on Windows. Use stdin in the demo:'
  Write-Host '        "¿Qué es P2P?" | qvac-node prompt -'
}

Write-Host "`n=== PHASE 1 OK ON THIS MACHINE ===" -ForegroundColor Green
Write-Host @"

The OTA half of the Phase 0 DoD is still missing. Leave it running:

    $bin

and from MACHINE 1 publish a new version:

    npm version 0.11.0 --no-git-tag-version
    npm run release

If [updater] lines show up here without you touching anything, Phase 0 closes too.
"@

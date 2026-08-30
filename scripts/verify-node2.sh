#!/usr/bin/env bash
# Phase 0 AND Phase 1 DoD verifier, meant to run on MACHINE 2
# (macOS / Linux).
#
# Doesn't need the repo: paste it into a terminal and you're done. That's the
# whole point of the track — machine 2 doesn't clone anything, everything
# travels over P2P.
#
#   bash verify-node2.sh
#
# Installs into its own folder and calls the binary by full path, so it
# doesn't depend on the PATH refreshing (which is what confuses this test
# the most).

set -u
LINK="pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny"
TARGET="$HOME/qvac-node-test"
# Kept in Spanish on purpose — same benchmark prompt used verbatim in
# docs/NOTES.md, scripts/soak.js and verify-node2.ps1 (see the note in
# qvac/infer.mjs).
PREGUNTA="Explica en dos frases que es una red peer-to-peer."

step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '    \033[32mOK   %s\033[0m\n' "$1"; }
fail() { printf '    \033[31mFALLA %s\033[0m\n' "$1"; }

# Extracts a number from the measurements the CLI prints.
metric() { sed -n "s/.*$1 *: *\([0-9.]*\)s.*/\1/p" | head -1; }

step 0 "Internet (being connected to wifi isn't enough)"
# Hyperswarm needs to reach the DHT bootstrap nodes. Without real internet
# the install can only give "Network Timeout 30s", which says nothing about
# the cause: a hotspot with no data gives a perfect wifi link and zero
# connectivity.
if curl -s --max-time 15 -o /dev/null https://github.com 2>/dev/null; then
  ok 'internet access is available'
else
  fail 'There is NO internet. Wifi may still show as connected.'
  echo '    Test it with:  curl -sS https://github.com -o /dev/null'
  echo '    If it is a hotspot, check that the phone has mobile data.'
  exit 1
fi

step 1 'Node and npm'
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version) / npm $(npm --version)"
else
  fail 'Node is not installed. Install it from https://nodejs.org and run this again.'
  exit 1
fi

step 2 'Pear CLI'
if ! command -v pear >/dev/null 2>&1; then
  echo '    installing pear...'
  npm install -g pear 2>&1 | tail -3
  # the first invocation is what downloads the real runtime; npm install only
  # leaves a shim behind. Without this step the install fails in unhelpful ways.
  pear help >/dev/null 2>&1 || true
  export PATH="$HOME/.config/pear/bin:$PATH"
fi
command -v pear >/dev/null 2>&1 || { fail 'pear did not end up in the PATH; open a new terminal and run this again'; exit 1; }
ok "$(command -v pear)"

step 3 "Installing into $TARGET"
mkdir -p "$TARGET"   # pear install --to fails with ENOENT if the dir doesn't exist
T0=$(date +%s)
INSTALL_OUT=$(pear install --to "$TARGET" "$LINK" 2>&1)
INSTALL_RC=$?
SECS=$(( $(date +%s) - T0 ))
echo "$INSTALL_OUT" | sed 's/^/    | /'

BIN="$TARGET/qvac-node"

# We trust NEITHER the exit code NOR the file existing.
#
# Measured on the MacBook: `pear install` printed "Network Timeout 30s" and
# "Failed", EXITED WITH CODE 0, and left a truncated 77 MB binary on disk
# (out of the 105 MB darwin-arm64 weighs) with execute permission. With the
# old checks (`|| fail` and `test -x`) that was reported as
# "OK installed in 34s" — a false positive that marked Phase 0 as closed
# when the install had actually failed.
if [ $INSTALL_RC -ne 0 ] || printf '%s' "$INSTALL_OUT" | grep -qiE 'network timeout|failed|error'; then
  fail "the install did NOT finish cleanly (${SECS}s). Look at the lines above."
  [ -e "$BIN" ] && echo "    A PARTIAL binary of $(du -h "$BIN" | cut -f1) was left behind: it's useless, delete it with  rm -rf $TARGET"
  echo '    Retry: Hyperdrive is incremental and resumes from what was already downloaded.'
  echo '    If it drops again, plan B: phone hotspot WITH DATA, both machines on it.'
  exit 1
fi

if [ ! -e "$BIN" ]; then
  fail 'the binary did not end up on disk'
  exit 1
fi
ok "downloaded in ${SECS}s, $(du -h "$BIN" | cut -f1)"

step 4 'The binary RUNS (this is the real proof the install worked)'
# A truncated binary exists, is executable, and doesn't start. Whether
# `--version` returns a version is the only thing that distinguishes a
# complete install from a partial one.
VER=$("$BIN" --version 2>&1 | head -1)
if printf '%s' "$VER" | grep -qE 'v[0-9]+\.[0-9]+\.[0-9]+'; then
  ok "$VER"
else
  fail "the binary is on disk but does NOT run: the install stayed incomplete."
  echo "    output of --version: ${VER:-(empty)}"
  echo "    Delete and retry:  rm -rf $TARGET && bash $0"
  exit 1
fi

step 5 'Fully local inference (Phase 1)'
cat <<'TXT'
    The FIRST run downloads the model: 807 MB, over hypercore (not HTTP).
    On bad wifi this takes a while. If you already downloaded it before, it starts right away.
    Ctrl+C now if you'd rather not download it yet.
TXT
OUT=$("$BIN" prompt "$PREGUNTA" 2>&1)
echo "$OUT" | sed 's/^/    | /'

LOAD=$(echo "$OUT" | metric 'model load')
TTFT=$(echo "$OUT" | metric 'first token (TTFT)')

if [ -z "$TTFT" ]; then
  fail 'there was no first token: inference did not run'
  exit 1
fi
ok "first token in ${TTFT}s (model load: ${LOAD}s)"

# The missing number from the Phase 1 DoD: from `pear install` to first
# token. It's built from measured parts, not estimated.
TOTAL=$(awk "BEGIN{printf \"%.1f\", $SECS + $LOAD + $TTFT}")
ok "pear install -> first token: ${TOTAL}s"
echo "         (install ${SECS}s + load ${LOAD}s + TTFT ${TTFT}s)"

step 6 'GPU vs CPU on THIS machine'
# On the demo's Windows machine (Intel UHD 620) the CPU wins 8x: the iGPU
# shares the system RAM and pays for the copy without gaining compute. On a
# Mac with Metal the GPU should win. It has to be measured, not assumed.
OUT2=$("$BIN" prompt "$PREGUNTA" --gpu-layers 0 2>&1)
TTFT2=$(echo "$OUT2" | metric 'first token (TTFT)')
if [ -n "$TTFT2" ]; then
  ok "TTFT default ${TTFT}s   vs   --gpu-layers 0 ${TTFT2}s"
  echo '    Note which one wins here: that is the flag to use in the demo.'
else
  fail 'the run with --gpu-layers 0 did not produce a first token'
fi

step 7 'Accents via argv (known bare-build bug on Windows)'
# The bare-build standalone binary receives argv in the ANSI codepage on
# Windows and that breaks everything non-ASCII. On macOS/Linux argv is
# native UTF-8 and should pass through clean. This step confirms it on THIS
# platform.
ECHOED=$("$BIN" prompt "¿Qué es esto?" --gpu-layers 0 2>&1 | grep '^> ' | head -1)
if echo "$ECHOED" | grep -q '¿Qué'; then
  ok "argv passes accents cleanly:  $ECHOED"
else
  fail "argv BREAKS accents:  $ECHOED"
  echo '    Use stdin in the demo:   echo "¿Qué es P2P?" | qvac-node prompt -'
fi

printf '\n\033[32m=== PHASE 1 OK ON THIS MACHINE ===\033[0m\n'
cat <<TXT

The OTA half of the Phase 0 DoD is still missing. Leave it running:

    $BIN

and from MACHINE 1 publish a new version:

    npm version 0.11.0 --no-git-tag-version
    npm run release

If [updater] lines show up here without you touching anything, Phase 0 closes too.
TXT

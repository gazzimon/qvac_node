#!/usr/bin/env bash
# Verificador de la DoD de Fase 0, para correr en la MAQUINA 2 (macOS / Linux).
#
# No necesita el repo: se pega en una terminal y listo. Ese es el punto del
# track — la maquina 2 no clona nada, todo viaja por P2P.
#
#   bash verify-node2.sh
#
# Instala en una carpeta propia y llama al binario por ruta completa, para no
# depender de que el PATH se refresque (que es lo que mas confunde este test).

set -u
LINK="pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny"
TARGET="$HOME/qvac-node-test"

step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '    \033[32mOK   %s\033[0m\n' "$1"; }
fail() { printf '    \033[31mFALLA %s\033[0m\n' "$1"; }

step 1 'Node y npm'
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version) / npm $(npm --version)"
else
  fail 'Node no esta instalado. Instalalo desde https://nodejs.org y volve a correr esto.'
  exit 1
fi

step 2 'CLI de Pear'
if ! command -v pear >/dev/null 2>&1; then
  echo '    instalando pear...'
  npm install -g pear 2>&1 | tail -3
  # la primera invocacion es la que baja el runtime real; el npm install solo
  # deja un shim. Sin este paso el install falla de formas poco descriptivas.
  pear help >/dev/null 2>&1 || true
  export PATH="$HOME/.config/pear/bin:$PATH"
fi
command -v pear >/dev/null 2>&1 || { fail 'pear no quedo en el PATH; abri una terminal nueva y volve a correr esto'; exit 1; }
ok "$(command -v pear)"

step 3 'Alcanza el DHT? (unos pocos KB, aisla red de resto)'
INFO="$(pear info "$LINK" 2>&1 || true)"
if echo "$INFO" | grep -q 'qvac-node'; then
  ok "resuelve. $(echo "$INFO" | grep -E '^\s*(version|length)' | tr -s ' ' | tr '\n' ' ')"
else
  fail 'no resolvio el link.'
  echo '    Causas tipicas: el seeder de la maquina 1 no esta corriendo,'
  echo '    o esta red bloquea UDP (Hyperswarm holepunchea por UDP).'
  echo '    Proba con el hotspot del celular para descartar el firewall.'
  echo "$INFO"
  exit 1
fi

step 4 "Instalando en $TARGET"
mkdir -p "$TARGET"   # pear install --to falla con ENOENT si el dir no existe
T0=$(date +%s)
pear install --to "$TARGET" "$LINK" || { fail 'el install fallo'; exit 1; }
SECS=$(( $(date +%s) - T0 ))

BIN="$TARGET/qvac-node"
if [ -x "$BIN" ]; then
  ok "instalado en ${SECS}s, $(du -h "$BIN" | cut -f1)"
else
  fail 'el binario no quedo en disco'
  exit 1
fi

step 5 'Version instalada'
ok "$("$BIN" --version 2>&1 | head -1)"

printf '\n\033[32m=== INSTALL OK ===\033[0m\n'
cat <<TXT

Falta la mitad OTA de la DoD. Dejalo corriendo:

    $BIN

y desde la MAQUINA 1 publica una version nueva:

    npm version 0.5.0 --no-git-tag-version
    npm run release

Si aca aparecen lineas [updater] sin que toques nada, Fase 0 esta cerrada.
TXT

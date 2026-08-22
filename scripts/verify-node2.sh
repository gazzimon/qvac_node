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

step 0 'Internet (no alcanza con estar conectado al wifi)'
# Hyperswarm necesita llegar a los nodos bootstrap de la DHT. Sin internet real
# el install solo puede dar "Network Timeout 30s", que no dice nada sobre la
# causa: un hotspot sin datos da link wifi perfecto y cero conectividad.
if curl -s --max-time 15 -o /dev/null https://github.com 2>/dev/null; then
  ok 'hay salida a internet'
else
  fail 'NO hay internet. El wifi puede estar conectado igual.'
  echo '    Probalo con:  curl -sS https://github.com -o /dev/null'
  echo '    Si es un hotspot, fijate que el telefono tenga datos moviles.'
  exit 1
fi

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

step 3 'Sonda: resuelve el link? (informativo, NO bloquea)'
# OJO: no esta verificado que `pear info` haga lookup por red para un link que
# esta maquina nunca vio. Si no lo hace, falla siempre aunque el install ande.
# Por eso es informativo: el veredicto lo da el paso 4.
INFO="$(pear info "$LINK" 2>&1 || true)"
if echo "$INFO" | grep -q 'qvac-node'; then
  ok 'el link resuelve'
else
  printf '    [33mSIN DATO  pear info no devolvio nada. Seguimos igual:[0m
'
  printf '    [33m          el que decide es el install del paso 4.[0m
'
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

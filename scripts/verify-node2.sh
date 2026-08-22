#!/usr/bin/env bash
# Verificador de la DoD de Fase 0 Y Fase 1, para correr en la MAQUINA 2
# (macOS / Linux).
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
PREGUNTA="Explica en dos frases que es una red peer-to-peer."

step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '    \033[32mOK   %s\033[0m\n' "$1"; }
fail() { printf '    \033[31mFALLA %s\033[0m\n' "$1"; }

# Extrae un numero de las mediciones que imprime el CLI.
metric() { sed -n "s/.*$1 *: *\([0-9.]*\)s.*/\1/p" | head -1; }

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

step 3 "Instalando en $TARGET"
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

step 4 'Version instalada'
ok "$("$BIN" --version 2>&1 | head -1)"

step 5 'Inferencia 100% local (Fase 1)'
cat <<'TXT'
    La PRIMERA corrida baja el modelo: 807 MB, por hypercore (no por HTTP).
    En una wifi mala esto tarda. Si ya lo bajaste antes, arranca al toque.
    Ctrl+C ahora si preferis no bajarlo todavia.
TXT
OUT=$("$BIN" prompt "$PREGUNTA" 2>&1)
echo "$OUT" | sed 's/^/    | /'

LOAD=$(echo "$OUT" | metric 'carga del modelo')
TTFT=$(echo "$OUT" | metric 'primer token (TTFT)')

if [ -z "$TTFT" ]; then
  fail 'no hubo primer token: la inferencia no corrio'
  exit 1
fi
ok "primer token en ${TTFT}s (carga del modelo: ${LOAD}s)"

# El numero que faltaba de la DoD de Fase 1: del `pear install` al primer
# token. Se compone de partes medidas, no se estima.
TOTAL=$(awk "BEGIN{printf \"%.1f\", $SECS + $LOAD + $TTFT}")
ok "pear install -> primer token: ${TOTAL}s"
echo "         (install ${SECS}s + carga ${LOAD}s + TTFT ${TTFT}s)"

step 6 'GPU vs CPU en ESTA maquina'
# En la maquina Windows de la demo (Intel UHD 620) el CPU gana 8x: la iGPU
# comparte la RAM del sistema y paga la copia sin ganar computo. En una Mac
# con Metal deberia ganar la GPU. Hay que medirlo, no suponerlo.
OUT2=$("$BIN" prompt "$PREGUNTA" --gpu-layers 0 2>&1)
TTFT2=$(echo "$OUT2" | metric 'primer token (TTFT)')
if [ -n "$TTFT2" ]; then
  ok "TTFT default ${TTFT}s   vs   --gpu-layers 0 ${TTFT2}s"
  echo '    Anota cual gana aca: es el flag que hay que usar en la demo.'
else
  fail 'la corrida con --gpu-layers 0 no dio primer token'
fi

step 7 'Acentos por argv (bug conocido de bare-build en Windows)'
# El binario standalone de bare-build recibe el argv en codepage ANSI en
# Windows y rompe todo lo no-ASCII. En macOS/Linux el argv es UTF-8 nativo y
# deberia pasar limpio. Este paso lo confirma en ESTA plataforma.
ECHOED=$("$BIN" prompt "¿Qué es esto?" --gpu-layers 0 2>&1 | grep '^> ' | head -1)
if echo "$ECHOED" | grep -q '¿Qué'; then
  ok "argv pasa los acentos limpios:  $ECHOED"
else
  fail "argv ROMPE los acentos:  $ECHOED"
  echo '    Usa stdin en la demo:   echo "¿Qué es P2P?" | qvac-node prompt -'
fi

printf '\n\033[32m=== FASE 1 OK EN ESTA MAQUINA ===\033[0m\n'
cat <<TXT

Falta la mitad OTA de la DoD de Fase 0. Dejalo corriendo:

    $BIN

y desde la MAQUINA 1 publica una version nueva:

    npm version 0.11.0 --no-git-tag-version
    npm run release

Si aca aparecen lineas [updater] sin que toques nada, Fase 0 tambien cierra.
TXT

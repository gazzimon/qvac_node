#!/bin/sh
#
# Instalador de una linea para macOS y Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.sh | sh
#
# Baja el binario standalone de esta plataforma y lo ejecuta. El binario trae
# el motor de inferencia adentro: NO hace falta Node, ni npm, ni Pear. Ese es
# el punto -- pedirle a alguien que instale tres cosas antes de poder probar
# la app es donde se pierde a la mayoria de la gente.
#
# La instalacion por Pear (`pear install pear://...`) sigue existiendo y es la
# que da updates OTA automaticos; esta via es para el primer contacto.

set -eu

REPO="gazzimon/qvac_node"
BIN="pyrusllm"

rojo() { printf '\033[31m%s\033[0m\n' "$1" >&2; }
gris() { printf '\033[2m%s\033[0m\n' "$1"; }

# --- plataforma -------------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) plat="darwin" ;;
  Linux)  plat="linux" ;;
  *)
    rojo "pyrusllm: no hay binario para $os."
    rojo "Plataformas soportadas: macOS y Linux (x64/arm64), Windows x64."
    exit 1
    ;;
esac

case "$arch" in
  arm64|aarch64) a="arm64" ;;
  x86_64|amd64)  a="x64" ;;
  *)
    rojo "pyrusllm: no hay binario para la arquitectura $arch."
    exit 1
    ;;
esac

target="$plat-$a"
url="https://github.com/$REPO/releases/latest/download/$BIN-$target"

# --- donde se instala -------------------------------------------------------
# ~/.local/bin y no /usr/local/bin: no requiere sudo. Pedir root para probar
# una app es otra puerta que mucha gente no cruza.
dir="${PYRUSLLM_DIR:-$HOME/.local/bin}"
dest="$dir/$BIN"
mkdir -p "$dir"

if ! command -v curl >/dev/null 2>&1; then
  rojo "pyrusllm: hace falta curl."
  exit 1
fi

echo ""
echo "  pyrusllm -- instalando para $target"
echo ""

# Son ~165 MB: sin barra de progreso esto parece colgado durante minutos.
# Se baja a un temporal y recien al final se mueve, para que un corte de red
# no deje un ejecutable a medias en el PATH.
tmp="$(mktemp "${TMPDIR:-/tmp}/pyrusllm.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM

if ! curl -fL --progress-bar "$url" -o "$tmp"; then
  rojo ""
  rojo "pyrusllm: no se pudo bajar $url"
  rojo "Si el release todavia no esta publicado, la via alternativa es:"
  rojo "  npm i -g pear && pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny"
  exit 1
fi

# Checksum si el release lo publica. No se inventa una verificacion que no
# existe: si no hay .sha256 se dice, en vez de callarlo.
if curl -fsSL "$url.sha256" -o "$tmp.sha256" 2>/dev/null; then
  esperado="$(cut -d' ' -f1 < "$tmp.sha256")"
  if command -v shasum >/dev/null 2>&1; then
    real="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    real="$(sha256sum "$tmp" | cut -d' ' -f1)"
  else
    real=""
  fi
  if [ -n "$real" ] && [ "$real" != "$esperado" ]; then
    rojo "pyrusllm: el checksum no coincide. Se aborta."
    exit 1
  fi
  [ -n "$real" ] && gris "  checksum verificado"
else
  gris "  (el release no publica checksum: descarga sin verificar)"
fi

chmod +x "$tmp"
mv "$tmp" "$dest"
trap - EXIT INT TERM

echo ""
echo "  instalado en $dest"

# --- PATH -------------------------------------------------------------------
case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    echo ""
    echo "  $dir no esta en tu PATH. Agregalo con:"
    echo ""
    echo "    echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile"
    echo ""
    ;;
esac

# --- arrancar ---------------------------------------------------------------
# Ejecutarlo es la mitad del punto: el instalador termina con la app abierta en
# el navegador, no con instrucciones para un segundo paso.
echo ""
echo "  arrancando pyrusllm..."
echo ""
exec "$dest"

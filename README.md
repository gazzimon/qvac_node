# QVAC-Node

**La red distribuye su propio cliente por la red.**

Un CLI que se instala con `pear install`, se actualiza solo por OTA P2P, y al
instalarse hace que tu máquina entre a una red de inferencia viva. Cada nodo
corre un LLM local con QVAC y se anuncia en un topic Hyperswarm con un
manifiesto firmado; un gateway compatible con la API de OpenAI enruta requests
hacia esos nodos.

Hackathon CRECIMIENTO / Aleph 2026 — 🍐 Pears Track.

---

## Instalación

```bash
npm i -g pear
pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
qvac-node --help
```

No hay npm install del proyecto, no hay build, no hay repo que clonar. El canal
de distribución **es** la red P2P. Se descargan 55 MB en ~12 s y el binario
queda en el PATH.

A partir de ahí la copia instalada se mantiene sola: cuando se publica una
versión nueva, la detecta y se actualiza en ~10 segundos, sin que el usuario
haga nada.

---

## Por qué el pear-runtime corre en un worker thread

Usamos la variante `main` de `hello-pear-bare`: el updater OTA vive en un
worker thread propio (`workers/main.js`), separado del hilo que atiende al
usuario.

No es la variante más simple —`single-thread` lo es— y la elegimos igual, por
una razón concreta. `qvac-node serve` y `qvac-node gateway` son procesos
**long-lived** que van a estar haciendo streaming de tokens hacia un cliente.
El updater, mientras tanto, descarga decenas de megabytes por la red y escribe
un binario a disco. En un solo hilo, esa descarga compite con el streaming: el
usuario ve el output trabarse justo cuando el nodo se está actualizando.

Separarlos hace que el OTA sea invisible para quien está usando el nodo. Es el
único costo de complejidad que aceptamos en el proceso, y es el que hace que
"se actualiza solo" no sea a costa de "deja de responder mientras lo hace".

La contrapartida elegida a propósito: el updater **no** reinicia el proceso al
aplicar la actualización. Avisa y deja que la versión nueva entre en el próximo
arranque. Matar un proceso que está sirviendo tokens para aplicar un update es
exactamente el comportamiento que esta arquitectura existe para evitar.

---

## Desarrollo

```bash
npm install
npm start                  # corre local con bare, sin updates
npm run make               # binario standalone de la plataforma local
npm run release:host       # build + stage, solo plataforma local (iterar)
npm run release            # build + stage, las 6 plataformas (antes de la demo)
npm run seed               # seedea el link
```

`npm start` usa `--no-updates`: durante el ciclo de desarrollo no querés que la
copia local se te actualice sola a mitad de una prueba.

### Publicar una versión

```bash
npm version patch --no-git-tag-version
npm run release
```

`release` encadena `bare-build` (los 6 targets cross-compilan desde cualquier
host), `pear build` (arma `by-arch/`, que es donde `pear install` busca el
binario) y `pear stage --purge`.

---

## Estado

- **Fase 0 — distribución OTA:** pipeline completo funcionando. Falta validar
  en una segunda máquina limpia.
- **Fase 1 — inferencia local con QVAC:** siguiente.

Los números medidos (peso del install, tiempos, propagación del OTA) están en
[NOTES.md](NOTES.md).

## Stack

`bare` 1.31 · `pear-runtime` 1.3.1 · `hyperswarm` 4.17 · `hypercore` 11.35 ·
`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0 (Fase 1) ·
`bare-http1` 4.5.8 (Fase 2)

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
de distribución **es** la red P2P: el binario queda en el PATH y trae el motor
de inferencia adentro (105 MB en macOS ARM, 166 MB en Windows x64).

A partir de ahí la copia instalada se mantiene sola: cuando se publica una
versión nueva, la detecta y se actualiza en ~10 segundos, sin que el usuario
haga nada.

---

## Inferencia 100% local

```bash
qvac-node prompt "¿Qué es una red peer-to-peer?"
```

El LLM corre **en tu máquina**. Nada del prompt ni de la respuesta sale de ahí.
Los pesos del modelo tampoco vienen por HTTP: bajan por hypercore desde el
registry de QVAC y quedan cacheados en `~/.qvac/models`. La primera corrida
descarga el modelo (807 MB para el default, Llama 3.2 1B); las siguientes no.

```bash
qvac-node prompt "..." --model smol        # SmolLM2 360M, más liviano
qvac-node prompt "..." --gpu-layers 0      # todo CPU (ver abajo)
qvac-node prompt "..." --quiet             # sólo la respuesta
echo "¿Qué es P2P?" | qvac-node prompt -   # el prompt por stdin
```

**Dos cosas que hay que saber antes de una demo:**

1. **`--gpu-layers 0` puede ser mucho más rápido.** En una GPU integrada floja
   (Intel UHD 620) el offload a GPU paga la copia sin ganar cómputo: TTFT pasa
   de 4.66 s a **0.59 s** yendo todo por CPU. En una Mac con Metal conviene el
   default. Medido, en [NOTES.md](NOTES.md).
2. **En Windows, pasá el prompt por stdin si tiene acentos.** El binario
   standalone de `bare-build` recibe el argv en codepage ANSI y rompe cualquier
   carácter no-ASCII. Es un bug de bare-build, con repro mínimo en
   [NOTES.md](NOTES.md). `qvac-node prompt -` lo esquiva.

Arrancar el nodo (`qvac-node` a secas) **no** descarga ningún modelo: bajar
pesos es siempre un efecto explícito de pedir una inferencia.

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
npm run release            # build + stage, las 5 plataformas (antes de la demo)
npm run seed               # seedea el link
```

`npm start` usa `--no-updates`: durante el ciclo de desarrollo no querés que la
copia local se te actualice sola a mitad de una prueba.

### Publicar una versión

```bash
npm version patch --no-git-tag-version
npm run release
```

`release` encadena `bare-build` (los 5 targets cross-compilan desde cualquier
host), `pear build` (arma `by-arch/`, que es donde `pear install` busca el
binario) y `pear stage --purge`.

**`win32-arm64` no se publica.** `@qvac/llm-llamacpp` no tiene prebuild para esa
plataforma, así que con la inferencia adentro el binario no compila.

---

## Estado

- **Fase 0 — distribución OTA:** pipeline completo funcionando. Falta validar el
  OTA en una segunda máquina limpia (el install cross-máquina ya está
  verificado, Windows → MacBook Apple Silicon).
- **Fase 1 — inferencia local con QVAC:** **cerrada**. El binario que publica
  `pear install` responde un prompt con inferencia 100% local. Falta un solo
  número: el tiempo de `pear install` a primer token, que requiere publicar y
  reinstalar en una máquina limpia.
- **Fase 2-a — gateway compatible con OpenAI:** **cerrada**.
  `POST /v1/chat/completions` acepta `{ model, messages[], stream }` y responde
  `chat.completion.chunk` por SSE (o un `chat.completion` único sin `stream`).
  `GET /v1/models` devuelve `{ object: "list", data: [...] }`. Sirve para
  apuntarle cualquier cliente de OpenAI sin modificarlo.
  No emite `usage`: el SDK no expone el conteo de tokens y un número inventado
  sería peor que un campo ausente.
- **Fase 2-a — manifiesto firmado:** **cerrada**. Ed25519 sobre JCS (RFC 8785)
  en [qvac/manifest.mjs](qvac/manifest.mjs), con casos negativos en
  [test/index.js](test/index.js).
- **Fase 2-b — swarm y descubrimiento P2P:** **cerrada**. Topic fijo,
  `FramedStream` por conexión, `manifest:announce` + `node:status`. Los
  candidatos mueren con el socket (D3), no por `expiresAt`.
- **Fase 3 — inferencia sobre el canal P2P:** **cerrada**. `serve --swarm` es
  el nodo completo: gateway y proveedor. Un `POST /v1/chat/completions` contra
  una máquina devuelve tokens generados en **otra**, por
  `chat:request`/`chat:chunk` sobre el mismo `FramedStream` del swarm — sin
  conexión aparte y sin hop HTTP a localhost (D1). Incluye reintento sólo antes
  del primer token (D4), acuse `chat:accepted` para distinguir "cargando" de
  "colgado", y `chat:cancel` cuando el cliente se va.

```bash
# en las dos máquinas
qvac-node serve --swarm --operator "Mi Nodo"

# el prompt entra por una y lo contesta la otra
curl -N http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama1b","messages":[{"role":"user","content":"hola"}],"stream":true}'
```

- **Fase 4 — el install es la demo:** siguiente.

### Qué es simulado (leer antes de mirar los paneles)

Nada de esto está escondido, y conviene decirlo antes de que alguien lo
descubra solo:

- **`serve` arranca con el registro vacío.** Sin nodos anunciados, un request
  devuelve un error claro (`no hay nodos sirviendo <modelo>`). Ese es el estado
  real mientras el descubrimiento P2P no esté conectado.
- **`serve --demo` puebla el registro con nodos simulados**: uno hace
  inferencia de verdad (`engine.mjs`, en este equipo) y tres responden texto
  enlatado, marcados como `simulado` en los paneles. El `%` de carga de los
  mocks lo mueve un timer, no tráfico real.
- **`economic` y `directory` del manifiesto son mock** (wallet en ceros,
  `discoveryKey` en ceros), con un campo `_mock` que lo dice dentro del propio
  manifiesto. WDK, recibos y liquidación están fuera de alcance de este track;
  ni el nodo ni el gateway leen esos campos.
- **Elegir nodo por carga (D6) no está implementado.** Con pares P2P sí puede
  haber dos nodos sirviendo el mismo `modelId`. Entre ellos se prefiere el par
  remoto sobre el local —decisión de demo, para que el camino P2P se ejercite
  en vez de que conteste la misma máquina— y entre varios pares se toma el
  primero. El log de routing dice cuántos candidatos hubo y que la elección por
  carga sigue sin implementarse; no afirma una decisión que no ocurrió.
- **El nodo que ejecuta la inferencia ve el prompt en texto plano.** El claim
  correcto es "ninguna corporación centralizada agrega tus datos a escala", no
  "nadie más ve tu prompt": el cifrado E2E está fuera de alcance.

Los números medidos (peso del install, tiempos, propagación del OTA, TTFT) están
en [NOTES.md](NOTES.md).

## Stack

`bare` 1.31 · `pear-runtime` 1.3.1 · `hyperswarm` 4.17 · `hypercore` 11.35 ·
`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0 (Fase 1) ·
`bare-http1` 4.5.8 (Fase 2)

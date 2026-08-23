# PyrusLLM

**La red distribuye su propio cliente por la red.**

Un CLI que se instala con `pear install`, se actualiza solo por OTA P2P, y al
instalarse hace que tu máquina entre a una red de inferencia viva. Cada nodo
corre un LLM local con QVAC y se anuncia en un topic Hyperswarm con un
manifiesto firmado; un gateway compatible con la API de OpenAI enruta requests
hacia esos nodos, y cualquier cliente OpenAI —tu terminal, un bot de Telegram,
Open WebUI— le puede hablar sin modificarlo.

Hackathon CRECIMIENTO / Aleph 2026 — 🍐 Pears Track.

---

## Instalación

```bash
npm i -g pear
pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
pyrusllm --help
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
pyrusllm prompt "¿Qué es una red peer-to-peer?"
```

El LLM corre **en tu máquina**. Nada del prompt ni de la respuesta sale de ahí.
Los pesos del modelo tampoco vienen por HTTP: bajan por hypercore desde el
registry de QVAC y quedan cacheados en `~/.qvac/models`. La primera corrida
descarga el modelo (807 MB para el default, Llama 3.2 1B); las siguientes no.

```bash
pyrusllm prompt "..." --model smol        # SmolLM2 360M, más liviano
pyrusllm prompt "..." --gpu-layers 0      # todo CPU (ver abajo)
pyrusllm prompt "..." --ctx 4096          # tamaño de contexto
pyrusllm prompt "..." --no-download       # fallar si los pesos no están en cache
pyrusllm prompt "..." --quiet             # sólo la respuesta
echo "¿Qué es P2P?" | pyrusllm prompt -   # el prompt por stdin
```

**Dos cosas que hay que saber antes de una demo:**

1. **`--gpu-layers 0` puede ser mucho más rápido.** En una GPU integrada floja
   (Intel UHD 620) el offload a GPU paga la copia sin ganar cómputo: TTFT pasa
   de 4.66 s a **0.59 s** yendo todo por CPU. En una Mac con Metal conviene el
   default. Medido, en [NOTES.md](NOTES.md).
2. **En Windows, pasá el prompt por stdin si tiene acentos.** El binario
   standalone de `bare-build` recibe el argv en codepage ANSI y rompe cualquier
   carácter no-ASCII. Es un bug de bare-build, con repro mínimo en
   [NOTES.md](NOTES.md). `pyrusllm prompt -` lo esquiva.

Arrancar el nodo (`pyrusllm serve`) **no** descarga ningún modelo: bajar pesos
es siempre un efecto explícito de pedir una inferencia.

---

## El nodo completo

```bash
pyrusllm serve --swarm --operator "Mi Nodo"
```

Un solo proceso que es las dos cosas a la vez: **gateway** (habla OpenAI hacia
afuera) y **proveedor** (contesta prompts de otros nodos con su LLM local). Se
une al topic `pyrusllm:marketplace:v1`, anuncia su manifiesto firmado, y sirve
tres paneles y la API en `http://localhost:8787`.

| Flag                  | Qué hace                                                       |
| --------------------- | -------------------------------------------------------------- |
| `--port <n>`          | puerto HTTP del gateway (default 8787)                         |
| `--swarm`             | unirse al topic P2P y poblar el registro con pares verificados |
| `--demo`              | poblar el registro con nodos **simulados** (1 real + 3 mocks)  |
| `--operator <nombre>` | nombre que se anuncia en el manifiesto                         |
| `--gpu-layers <n>`    | capas a la GPU del nodo real; `0` = todo CPU                   |
| `--no-store`          | sin Hyperbee/Hyperdrive: sin persistencia ni archivos          |

Sin `--demo` el registro arranca **vacío**, y un request devuelve un error claro
(`no hay nodos sirviendo <modelo>`) en vez de fingir que hay red.

### Los tres paneles

| Ruta         | Para quién                                                                    |
| ------------ | ----------------------------------------------------------------------------- |
| `/`          | **Cliente** — el marketplace: elegís proveedor, chateás, o apretás _Conectar_ |
| `/proveedor` | **Proveedor** — lo que ofrece esta máquina, precio, archivos publicados       |
| `/admin`     | **Admin** — registro completo, log de ruteo, kick de nodos                    |

El panel de cliente se lee como marketplace de **proveedores**, no como catálogo
de modelos: lo que elegís es de quién es la máquina que va a correr tu prompt.

### La API

```
GET  /v1/models                 catálogo, formato OpenAI estricto
POST /v1/chat/completions       { model, messages[], stream } -> SSE o JSON único
GET  /v1/nodes                  vista rica del marketplace (precio, operador, carga)
GET  /v1/routing-log            por qué se eligió cada nodo
POST /v1/nodes/:id              editar pricing / status
POST /v1/nodes/:id/kick         sacar un nodo del registro
POST /v1/connection/:id         emitir la credencial para un cliente externo
GET  /v1/files                  listar el drive propio, o el de otro con ?link=
POST /v1/files/upload           publicar (los bytes crudos en el body, ?name=)
POST /v1/files/fetch            bajar un archivo de otro drive a esta máquina
```

`/v1/models` y `/v1/chat/completions` son OpenAI **de verdad**: sirven para
apuntarle cualquier cliente sin modificarlo. La vista rica del marketplace vive
en `/v1/nodes` justamente para no contaminar el protocolo.

No se emite `usage`: el SDK no expone el conteo de tokens, y un número inventado
sería peor que un campo ausente.

Las rutas de archivos existen sólo con `serve --swarm` y sin `--no-store` —sin
Corestore no hay drive—. En ese caso responden **503 con un motivo legible**,
porque "no está habilitado" y "se rompió" son cosas distintas para quien lo lee.

---

## Conectar: el mismo nodo desde afuera

El botón **Conectar** de cada tarjeta del marketplace emite una API key
(`qvac_sk_…`, bytes de `hypercore-crypto`, nunca `Math.random`) y muestra los
pasos exactos para cinco clientes:

- **Telegram** — vía OpenClaw, un runtime de agente self-hosted: le escribís a
  un bot desde el celular y la respuesta la genera este nodo.
- **WhatsApp** — el mismo OpenClaw, otro canal. Acá no hay bot: se vincula la
  cuenta personal del operador escaneando un **QR** (igual que WhatsApp Web),
  así que el modal lo avisa **antes** de los pasos y deja `dmPolicy: "pairing"`
  puesto por defecto: sin aprobar el pedido, nadie le escribe al nodo.
- **Terminal** — un `curl` con `Authorization: Bearer`. Si ese curl anda, anda
  cualquier cliente compatible: el panel no tiene un camino privilegiado.
- **Hermes Agent** — cuatro líneas en `~/.hermes/config.yaml`.
- **Open WebUI** — un `docker run` con `OPENAI_API_BASE_URL` apuntado acá.

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer qvac_sk_..." \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama1b","messages":[{"role":"user","content":"hola"}],"stream":true}'
```

Dos decisiones sobre las keys:

1. **Una key por nodo.** Apretar _Conectar_ dos veces sobre la misma tarjeta
   devuelve la **misma** credencial. Si no, el registro se llena de keys
   huérfanas que el usuario ya pegó en un config y no puede distinguir.
2. **El `baseUrl` lo dice el request, no una constante.** Si el operador entra
   por la IP de la LAN, el comando que copia apunta ahí y no a `127.0.0.1`, que
   en la máquina del cliente es otra cosa.

Las keys viven en memoria y se resetean con el proceso (mismo criterio que el
registro de nodos: para una demo alcanza y no hay estado que limpiar entre
corridas).

---

## Mandar archivos entre máquinas

```bash
# en la máquina que manda
pyrusllm send ./plano.pdf
#   drive : 41dc77b9…
#   En la otra maquina:
#     pyrusllm fetch qvac://41dc77b9…/plano.pdf

# en la máquina que recibe
pyrusllm fetch qvac://41dc77b9…/plano.pdf --out ./descargas
pyrusllm files --link qvac://41dc77b9…/     # listar sin bajar nada
```

Lo mismo está en el panel de proveedor (`/v1/files/*`), donde arrastrás el
archivo y te da el link.

Va por **Hyperdrive**: un Hyperbee de metadata (ruta → puntero al blob) más un
Hyperblobs con los bytes. De ahí salen las dos propiedades que importan:

- **Se transfiere solo lo que se pide.** Un drive con 40 GB publicados no
  obliga a nadie a bajar más que el archivo que eligió. `files --link` lista el
  contenido sin traer un solo byte de blob, porque la metadata replica aparte.
- **Cada bloque se verifica contra el merkle root al llegar.** Un archivo
  alterado a mitad de camino no puede completarse. Eso lo da Hypercore.

Dos cosas que **no** hace, dichas en voz alta:

1. **No es store-and-forward.** No hay servidor donde el archivo quede
   guardado: los bytes salen de la máquina que hizo `send`, y por eso ese
   proceso queda corriendo. Si se apaga antes de que el otro termine, la
   descarga se corta (y retoma sola cuando vuelve: lo que ya bajó no se
   re-descarga).
2. **La clave no dice de quién es.** Que los bytes correspondan a la clave está
   garantizado; que la clave sea de quien creés, no. Cuando llega por
   `files:announce` viene por el canal Noise ya autenticado y es atribuible al
   par. Cuando la pegás a mano, la confianza es la del canal por el que te
   pasaron el link.

El mismo Hyperdrive es el que resuelve el transporte de los nodos verticales
del marketplace: un plano o un PDF escaneado no entra por el canal de control
—16 MiB por frame, y `Provider._validate` corta el contenido en 32000
caracteres—, así que "Facturas AR" y "Lectura de planos" reciben la clave del
drive y la ruta, no el archivo.

---

## El marketplace se acuerda de los nodos que vio

Antes, dos nodos se conocían **solo si estaban online al mismo tiempo**: el
manifiesto se intercambiaba en el handshake y moría con el socket. Ahora cada
nodo escribe los manifiestos verificados en un **Hyperbee** propio que replica
con sus pares, así que conectarse con uno alcanza para enterarse de todos los
que ese par vio.

Retransmitir el manifiesto de un tercero es seguro porque ya viene firmado: el
que lo recibe de rebote lo verifica igual, sin confiar en el intermediario.

Lo que un manifiesto de rebote **no** prueba es que ese nodo esté vivo —
`verifyManifest` ata la firma a la clave del socket, y un manifiesto que sale
del Hyperbee no tiene socket. Por eso esas entradas aparecen en el panel como
**conocidas y offline**, y nunca como candidatas de ruteo: D3 (el candidato
nace y muere con su socket) no tiene excepciones. Hay un test que lo fija.

La identidad del nodo **se persiste** ([qvac/identity.mjs](qvac/identity.mjs)
guarda la semilla Ed25519 de 32 bytes, no el par entero). Una clave nueva en
cada arranque significaría que el nodo es un desconocido distinto cada vez, y la
palabra "verificable" del pitch se quedaría sin sujeto.

---

## Una conexión, tres cosas encima

El socket de Hyperswarm ya no va envuelto en `FramedStream` —que se adueña del
stream— sino en un canal **Protomux** (`qvac/node/v0`). Sobre ese mismo
multiplexor viaja la replicación del Corestore. Resultado: un solo hole-punch
transporta el chat, el directorio Hyperbee y los Hyperdrive de archivos, sin la
segunda conexión que D1 existe para evitar.

El cap de 16 MiB por frame que daba `bits: 24` no se pierde: `NoiseSecretStream`
frena en `MAX_ATOMIC_WRITE = 0xffffff`, los mismos 16 MiB, una capa más abajo.

**Esto rompe compatibilidad de cable con v0.10.0.** Un nodo viejo y uno nuevo no
pueden hacer handshake, así que el topic pasó a `pyrusllm:marketplace:v1`: en la
ventana del OTA cada versión se ve entre sí y no se cruzan, en vez de conectarse
y quedarse mudas hasta el timeout.

---

## Por qué el pear-runtime corre en un worker thread

Usamos la variante `main` de `hello-pear-bare`: el updater OTA vive en un
worker thread propio ([workers/main.js](workers/main.js)), separado del hilo que
atiende al usuario.

No es la variante más simple —`single-thread` lo es— y la elegimos igual, por
una razón concreta. `pyrusllm serve` es un proceso **long-lived** que va a
estar haciendo streaming de tokens hacia un cliente. El updater, mientras tanto,
descarga decenas de megabytes por la red y escribe un binario a disco. En un
solo hilo, esa descarga compite con el streaming: el usuario ve el output
trabarse justo cuando el nodo se está actualizando.

Separarlos hace que el OTA sea invisible para quien está usando el nodo. Es el
único costo de complejidad que aceptamos en el proceso, y es el que hace que
"se actualiza solo" no sea a costa de "deja de responder mientras lo hace".

La contrapartida elegida a propósito: el updater **no** reinicia el proceso al
aplicar la actualización. Avisa y deja que la versión nueva entre en el próximo
arranque. Matar un proceso que está sirviendo tokens para aplicar un update es
exactamente el comportamiento que esta arquitectura existe para evitar.

---

## Verificar la red con dos máquinas

```bash
# en las DOS máquinas, al mismo tiempo
pyrusllm peers --operator "Maquina A" --timeout 90 --expect 1
```

`peers` no levanta el gateway: se une al topic, anuncia su manifiesto firmado y
reporta qué pares aparecieron, cuáles verificaron, y los tiempos de
join → primer par y join → primer manifiesto verificado (D7 del roadmap).
`--expect` le da exit code 1 si no llegó al mínimo, así sirve de gate en un
script.

**Las ventanas tienen que solaparse.** El descubrimiento tarda ~17 s; correr una
máquina con `--timeout 60` y arrancar la otra después es la causa habitual de
"0 pares", y no la red. Los scripts [verify-node2.sh](scripts/verify-node2.sh) y
[verify-node2.ps1](scripts/verify-node2.ps1) automatizan la corrida en el
segundo equipo; [soak.js](scripts/soak.js) la sostiene en el tiempo.

---

## Desarrollo

```bash
npm install
npm start                  # corre local con bare, sin updates
npm test                   # brittle-bare test/index.js
npm run lint               # prettier --check && lunte
npm run make               # binario standalone de la plataforma local
npm run release:host       # build + stage, solo plataforma local (iterar)
npm run release            # build + stage, las 5 plataformas (antes de la demo)
npm run seed               # seedea el link
```

`npm start` usa `--no-updates`: durante el ciclo de desarrollo no querés que la
copia local se te actualice sola a mitad de una prueba.

### El código

| Archivo                                                                | Qué resuelve                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| [bin.mjs](bin.mjs)                                                     | CLI (`prompt`, `serve`, `peers`, `send`, `fetch`, `files`) |
| [qvac/engine.mjs](qvac/engine.mjs) · [infer.mjs](qvac/infer.mjs)       | el LLM local sobre `@qvac/llm-llamacpp`                    |
| [qvac/manifest.mjs](qvac/manifest.mjs)                                 | Ed25519 sobre JCS (RFC 8785), firma y verificación         |
| [qvac/identity.mjs](qvac/identity.mjs)                                 | la semilla persistente del nodo                            |
| [qvac/swarm.mjs](qvac/swarm.mjs) · [channel.mjs](qvac/channel.mjs)     | topic, Protomux, `chat:*` y `manifest:announce`            |
| [qvac/directory.mjs](qvac/directory.mjs)                               | el Hyperbee que recuerda los manifiestos vistos            |
| [qvac/files.mjs](qvac/files.mjs) · [corestore.mjs](qvac/corestore.mjs) | Hyperdrive, links `qvac://`                                |
| [qvac/gateway.mjs](qvac/gateway.mjs)                                   | HTTP, ruteo, SSE en formato OpenAI                         |
| [qvac/store.mjs](qvac/store.mjs) · [apikeys.mjs](qvac/apikeys.mjs)     | registro de nodos y credenciales, en memoria               |
| [qvac/pages.mjs](qvac/pages.mjs)                                       | los tres paneles                                           |
| [workers/main.js](workers/main.js)                                     | el updater OTA, en su propio hilo                          |

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

- **Fase 0 — distribución OTA:** pipeline completo funcionando. Install
  cross-máquina verificado (Windows → MacBook Apple Silicon).
- **Fase 1 — inferencia local con QVAC:** **cerrada**. El binario que publica
  `pear install` responde un prompt con inferencia 100% local, y el camino
  completo `pear install` → primer token mide **~24 s** (medido en la máquina 1;
  falta repetirlo en una segunda máquina limpia).
- **Fase 2-a — gateway compatible con OpenAI:** **cerrada**. `/v1/models` y
  `/v1/chat/completions` en formato OpenAI estricto, con SSE.
- **Fase 2-a — manifiesto firmado:** **cerrada**. Ed25519 sobre JCS (RFC 8785)
  en [qvac/manifest.mjs](qvac/manifest.mjs), con casos negativos en
  [test/index.js](test/index.js).
- **Fase 2-b — swarm y descubrimiento P2P:** **cerrada**. Topic fijo,
  `manifest:announce` + `node:status`. Los candidatos mueren con el socket (D3),
  no por `expiresAt`.
- **Fase 3 — inferencia sobre el canal P2P:** **cerrada**. Un
  `POST /v1/chat/completions` contra una máquina devuelve tokens generados en
  **otra**, por `chat:request`/`chat:chunk` sobre la misma conexión del swarm —
  sin conexión aparte y sin hop HTTP a localhost (D1). Incluye reintento sólo
  antes del primer token (D4), acuse `chat:accepted` para distinguir "cargando"
  de "colgado", y `chat:cancel` cuando el cliente se va.
- **Fase 4 — el install es la demo:** el recorrido está construido —marketplace,
  botón _Conectar_, los cuatro clientes externos— y el objetivo de <60 s se
  cumple con los ~24 s de arriba. Lo que falta para darla por cerrada es
  cronometrarlo en la segunda máquina, con el swarm-join medido aparte del
  `pear install` (D7): si además hay que esperar el descubrimiento, no entra.
- **Persistencia y archivos:** **cerrada**. Protomux sobre una sola conexión,
  directorio Hyperbee, Hyperdrive con `send`/`fetch`/`files`. (El Stack de abajo
  las llama "Fase 5"; en [ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md) la Fase 5 es
  otra cosa —OTA en vivo y endurecimiento—, que sigue pendiente de correrse en
  vivo.)
- **Fase 6 — ledger y liquidación:** **fuera de alcance de este track**. Necesita
  Autobase, y lo que falta no es código sino gobernanza: quién es el primer
  escritor, cómo entra el segundo, quiénes firman la vista como indexers.

### Qué es simulado (leer antes de mirar los paneles)

Nada de esto está escondido, y conviene decirlo antes de que alguien lo
descubra solo:

- **`serve` arranca con el registro vacío.** Sin nodos anunciados, un request
  devuelve un error claro (`no hay nodos sirviendo <modelo>`).
- **`serve --demo` puebla el registro con nodos simulados**: uno hace
  inferencia de verdad (`engine.mjs`, en este equipo) y tres responden texto
  enlatado, marcados como `simulado` en los paneles. El `%` de carga de los
  mocks lo mueve un timer, no tráfico real.
- **`economic` del manifiesto es mock** (wallet en ceros), con un campo `_mock`
  que lo dice dentro del propio manifiesto. WDK, recibos y liquidación están
  fuera de alcance de este track; ni el nodo ni el gateway leen ese campo. El
  campo `directory`, en cambio, ya **no** es mock: lo que se firma ahí es la
  clave real del Hyperbee.
- **Elegir nodo por carga (D6) no está implementado.** Con pares P2P sí puede
  haber dos nodos sirviendo el mismo `modelId`. Entre ellos se prefiere el par
  remoto sobre el local —decisión de demo, para que el camino P2P se ejercite
  en vez de que conteste la misma máquina— y entre varios pares se toma el
  primero. El log de routing dice cuántos candidatos hubo y que la elección por
  carga sigue sin implementarse; no afirma una decisión que no ocurrió.
- **Las API keys no persisten** y no tienen scopes ni revocación: viven en el
  proceso.
- **El nodo que ejecuta la inferencia ve el prompt en texto plano.** El claim
  correcto es "ninguna corporación centralizada agrega tus datos a escala", no
  "nadie más ve tu prompt": el cifrado E2E está fuera de alcance.

Los números medidos (peso del install, tiempos, propagación del OTA, TTFT) están
en [NOTES.md](NOTES.md). El plan por fases y las decisiones cerradas, en
[ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md).

---

## Stack

`bare` 1.31 · `pear-runtime` 1.3.1 · `hyperswarm` 4.17 · `hypercore` 11.35 ·
`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0 (Fase 1) ·
`bare-http1` 4.5.8 (Fase 2) · `protomux` 3.11 + `corestore` 7.12 +
`hyperbee` 2.27 + `hyperdrive` 13.3 (Fase 5)

## Licencia

Apache-2.0 · [gazzimon](https://github.com/gazzimon)

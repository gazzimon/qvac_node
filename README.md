# PyrusLLM

**Un marketplace de inferencia de IA sin datacenter en el medio.**

PyrusLLM convierte cualquier computadora en un proveedor de inferencia: instala
un CLI que se actualiza solo por OTA P2P, y al instalarse hace que la máquina
entre a una red viva de nodos. Cada nodo corre un LLM local con QVAC y se
anuncia con un manifiesto firmado; un gateway compatible con la API de OpenAI
enruta cada request hacia el proveedor disponible, y cualquier cliente OpenAI
—tu terminal, un bot de Telegram, Open WebUI— le habla sin modificar una línea.

Para quien compra inferencia, es una factura más baja y sin intermediario
centralizado. Para quien la vende, es monetizar cómputo que hoy está ocioso.
El protocolo es el mismo de un lado y del otro: no hay servidor propietario en
el medio, ni un tercero que se quede con el margen.

Hackathon CRECIMIENTO / Aleph 2026 — Pears Track.

---

## Instalación

**Una línea, sin dependencias previas.** El binario trae el motor de inferencia
adentro: no hace falta Node, ni npm, ni Pear.

```bash
# macOS y Linux
curl -fsSL https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.ps1 | iex
```

Detecta plataforma, baja el binario del
[release](https://github.com/gazzimon/qvac_node/releases/latest), verifica el
checksum, lo instala **sin sudo ni UAC** (`~/.local/bin` o `%LOCALAPPDATA%`) y
lo arranca: la app abre sola en el navegador.

**Descarga directa**, para quien no ejecuta un script bajado de internet sin
haber visto antes el archivo. Son los mismos archivos que baja el instalador,
listados uno por uno con su `.sha256` en la sección *Get started* del
[landing](landing/index.html) y en la
[página del release](https://github.com/gazzimon/qvac_node/releases/latest):

| Plataforma | Archivo | Tamaño |
| --- | --- | --- |
| macOS Apple silicon | `pyrusllm-darwin-arm64` | ~101 MB |
| macOS Intel | `pyrusllm-darwin-x64` | ~104 MB |
| Linux x64 | `pyrusllm-linux-x64` | ~253 MB |
| Linux arm64 | `pyrusllm-linux-arm64` | ~228 MB |
| Windows x64 | `pyrusllm-win32-x64.exe` | ~158 MB |

Bajados a mano, lo que hace el instalador queda de tu lado: verificar el
checksum (`shasum -a 256` o `Get-FileHash`), dar permiso de ejecución, y —en
macOS— sacar la cuarentena que el navegador le pone a todo lo que baja
(`xattr -d com.apple.quarantine pyrusllm-darwin-arm64`). En Windows, SmartScreen
avisa una vez: el binario no está firmado.

Windows ARM no tiene build. `@qvac/llm-llamacpp` no publica prebuild para esa
plataforma y `bare-build` no tiene con qué linkear el addon.

**Instalación por Pear**, que además da updates OTA automáticos:

```bash
npm i -g pear
pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
pyrusllm
```

Sin `npm install` del proyecto, sin build, sin repo que clonar: el canal de
distribución **es** la red P2P. La copia instalada se actualiza sola, en ~10 s,
sin que el usuario haga nada.

## Uso

```bash
pyrusllm                                             # abre la app en el navegador
pyrusllm prompt "¿Qué es una red peer-to-peer?"     # inferencia 100% local, sin abrir nada
pyrusllm serve --swarm --operator "Mi Nodo"          # arranca ya unido a la red, sin pasar por la puerta
pyrusllm peers --operator "Mi Nodo" --timeout 90     # verificar que se descubre con otro nodo
pyrusllm send ./plano.pdf                            # publicar un archivo (link qvac://)
pyrusllm fetch qvac://<clave>/plano.pdf              # bajarlo en la otra máquina
```

**`pyrusllm` a secas levanta la app en `http://localhost:8787` y abre el
navegador.** El updater OTA sigue corriendo abajo: es además, no en vez de.
Flags de la raíz: `--port <n>`, `--no-open` (no abrir el navegador) y
`--no-serve` (solo el updater, sin app).

### La puerta

La app abre en el **chat**, y arranca con el nodo apagado: lo primero que se ve
es **Launch local agent**. Lanzarlo une la máquina al swarm en caliente —sin
reiniciar el proceso— y abre el chat.

**Sin agente lanzado no se llega a la red**: el selector no ofrece `Auto` ni
nodos remotos, y `/v1/chat/completions` responde 503 `agent_offline` si el único
candidato era un par. **El modelo local nunca se bloquea**: esa es la única
excepción, y existe para que el primer arranque no sea una pared sin nada atrás.

### El selector: qué modelo y en qué máquina

Arriba del chat hay **un solo selector con tres modos**, porque son dos preguntas
distintas —qué modelo y en qué máquina— y antes se contestaban con un combo y un
checkbox que podían contradecirse (elegir el modelo de un par *y* tildar "local
only" daba 404):

| Modo | Qué viaja en el body | Qué significa |
| --- | --- | --- |
| `<modelo> — this machine only` | `local: true` | nada sale de esta máquina |
| `Auto — best available node` | sin `node` | decide el gateway, por carga |
| `<operador> — <modelo> — N% busy` | `node: "<id>"` | esa máquina y no otra |

`model` dice **qué** se quiere y `node` dice **a quién**: con dos pares sirviendo
el mismo `modelId` no había forma de elegir uno. En `/network`, cada tarjeta
tiene **Use this node**, que fija esa máquina y abre el chat con ella elegida.
**Pin es pin**: si la máquina fijada no está, la respuesta es 404 con el motivo,
nunca un reemplazo silencioso.

### El ruteo con reintento

Elegir un candidato **no es casarse con él**. El gateway recorre la lista
puntuada en orden y prueba el siguiente cada vez que uno falla *antes de que al
cliente le salga un byte*: un par sin agente lanzado, un motor local que no está
levantado, un proveedor que devuelve 429 porque se agotó su cuota del día. Un
solo recorrido para todas las clases de candidato —par P2P, motor embebido,
motor local por HTTP, API de un tercero, mock—, con la reserva de presupuesto
abierta **por intento**, porque el precio depende del nodo.

El corte es D4 y mira **lo que vio el cliente**, no lo que generó el proveedor:
en `stream: true` el primer token escrito cierra la puerta al reintento —una
respuesta a medias no se retoma en otra máquina—, pero sin stream el contenido
se junta y no sale hasta el final, así que reintentar sigue siendo legítimo y se
descarta lo que alcanzó a generar el que se cayó.

Un `429` se lee como *"está lleno"* y no como *"está roto"*: mismo tratamiento
que el `at_capacity` de un par, incluido marcarlo saturado para que el request
siguiente no se coma el mismo rechazo. Es la única forma de reaccionar a una
cuota diaria agotada, que el ledger no puede ver porque no se mide en dólares.

### El ruteo

`Auto` no es un orden fijo. `qvac/routing.mjs` descarta a los saturados, ordena
por carga, desempata con el histórico por par que el directorio ya venía
guardando, y recién al final aplica la preferencia por tipo de nodo. Los mocks de
`--demo` no compiten por carga: la suya la mueve un timer al azar, y compararla
con carga real sería comparar un número con una ficción.

Cada decisión queda registrada **con el motivo**: `/v1/routing-log` devuelve las
últimas 30 (lo que pinta `/admin`) y `/v1/audit` la serie completa desde el
Hyperbee, con la clave pública del nodo al lado —un JSONL suelto no dice quién lo
generó, y una auditoría que no puede atribuir el rastro a una clave no prueba
gran cosa.

### Las tres vistas

| Ruta | Qué es |
| --- | --- |
| `/` | **Chat.** Multi-turno, markdown, streaming. Cada respuesta dice qué máquina la produjo. |
| `/node` | **My Node.** Tu propia máquina como proveedor: estado, carga, precio, modelo. |
| `/network` | **Network.** La grilla del marketplace: todos los nodos, con precio y carga. |
| `/admin` | Log de ruteo y controles de caos. |

`/proveedor` y `/cliente` redirigen a las rutas nuevas.

### API

```
GET  /v1/models                 catálogo, formato OpenAI estricto
POST /v1/chat/completions       { model, messages[], stream, local?, node? } -> SSE o JSON
GET  /v1/agent                  estado del agente local (offline|launching|live|error)
POST /v1/agent/launch           unirse al swarm en caliente
GET  /v1/nodes                  vista rica del marketplace
GET  /v1/routing-log            las últimas 30 decisiones de ruteo, con el motivo
GET  /v1/audit                  la serie completa desde el Hyperbee, con la identidad del nodo
GET  /v1/budget                 gasto, reserva y saldo de la cuenta que pregunta
GET  /v1/budget/report          el reparto del mes: cuánto consumió cada cuenta
GET  /v1/quota                  cuánto regala este nodo, y a qué par
GET  /v1/swarm/manifest · POST  lo que este nodo anuncia (el POST pide key)
GET  /v1/keys/panel             credencial del panel (unica ruta sin gate)
GET  /v1/keys · POST · DELETE   administrar credenciales, una por cliente
POST /v1/keys/revoke-all        revocar todas
GET  /v1/files · POST /upload · POST /fetch     archivos entre nodos (Hyperdrive)
```

Tres extensiones propias sobre `/v1/chat/completions`, que ningún cliente de
OpenAI manda y que omitidas no cambian nada:

- **`local: true`** en el body fuerza que el prompt no salga de esta máquina.
- **`node: "<id>"`** fija la máquina que tiene que contestar. Sin él, elige el
  gateway.
- La respuesta trae headers **`X-Pyrus-Operator`**, **`-Kind`** y **`-Model`**
  con quién contestó. Van en headers y no en el cuerpo a propósito: meter un
  campo propio adentro de un `chat.completion.chunk` ensuciaría el formato de
  OpenAI, que es justo lo que este gateway promete respetar. Van en las **dos**
  formas de respuesta: hasta la suite de integración, con `stream` iban y sin
  `stream` no, así que un `curl` o un Open WebUI con el default no tenía cómo
  saber qué máquina le contestó.

### Credenciales

**Todo request de inferencia exige `Authorization: Bearer <api-key>`.** No hay
excepción: el panel pide la suya a `/v1/keys/panel` y la manda como cualquier
otro cliente, así hay un solo camino de autenticación y no una puerta trasera
para el navegador.

Las keys se administran en `/node`, **una por cliente**: con una sola, cada bot
nuevo obligaría a compartir la misma credencial y revocar por uno sería revocar
por todos. Cada fila tiene **Connect**, que muestra los pasos para Telegram,
WhatsApp, terminal, Hermes Agent u Open WebUI con *esa* key, y **Revoke**, que
la corta sin tocar a las demás.

Alcance de la revocación, para que nadie lo descubra solo: el registro vive en
la memoria de **tu** proceso. Revocar no puede afectar a otros nodos —no hay
registro compartido, y el protocolo P2P no transporta API keys—, pero sí borra
todas las que emitió este gateway. Y como no hay persistencia, **reiniciar el
nodo revoca todo igual**.

Límite honesto del gate: el gateway escucha solo en `127.0.0.1`, así que esto no
defiende de otro proceso de la misma máquina, que puede pedirle una credencial
al bootstrap igual que el panel. Defiende del resto de la red si el bind alguna
vez deja de ser loopback, y hace el consumo atribuible por cliente.

El botón **Archivos** de cada nodo abre un modal de **solo lectura**: lista lo
que ese nodo publica y deja copiar el link `qvac://`. La carga y la descarga
**no tienen UI todavía** —`/v1/files/upload` y `/v1/files/fetch` existen en el
gateway, pero ningún botón del panel las llama—; hoy se hacen por CLI con
`send`/`fetch`, como en el bloque de arriba.

### Costos y cuota

Dos contadores que parecen uno solo y no lo son: uno mira hacia adentro y el otro
hacia afuera. El principio es el mismo —**el contador vive del lado que paga**—,
la unidad no:

|  | `qvac/budget.mjs` | `qvac/quota.mjs` |
| --- | --- | --- |
| Qué mide | dólares | tokens de salida |
| De quién | la cuenta que consume | el par que pide |
| Quién lo lleva | el gateway (gasta) | el proveedor (presta la GPU) |
| Ventana | mes calendario | 24 h deslizantes |
| Tope por default | USD 20 | 100.000 tokens por par |

El **ledger** cuenta en micro-dólares enteros (1 USD = 1.000.000 micros): un tope
acumulado en punto flotante deriva justo en el borde, que es el único lugar donde
el número importa. Y trabaja en dos tiempos, porque antes del request no se sabe
lo que va a costar: `reserve()` aparta la **cota superior** —asume que se generan
todos los `max_tokens`— y la escribe a disco *antes* de que el request salga;
`settle()` la cambia por el costo real y devuelve la diferencia. Un tope aplicado
al facturar no es un tope, es un descuento: el gasto ya ocurrió. Si el proceso se
corta en el medio, la reserva huérfana se cobra entera al estimado —cobra de más
y corta antes, que es el lado correcto para equivocarse. La invariante la fija un
test: tope de USD 0,10, cien vueltas, y el gasto real nunca lo supera.

La **cuota** es lo contrario: cuánta GPU regala este nodo a cada par antes de
decir que no. Ventana deslizante con baldes por hora, porque un corte a
medianoche hace un pico a las 00:01 y castiga al que empezó 23:50. Se chequea
*antes* del request —y antes que el límite de capacidad, porque "estoy lleno"
invita a volver en dos segundos y "te quedaste sin cuota" dice recién cuándo se
repone— y se registra *después*, con los tokens que se generaron **de verdad**:
un request cancelado a los tres tokens gasta tres, y uno que falló cargando el
modelo no gasta nada. El request que cruza el límite se sirve entero, porque
cortar una generación por la mitad se ve como un bug y regala igual la GPU ya
gastada; el que no entra es el siguiente.

Los dos se ven juntos en `/node`, en una tarjeta con las dos lecturas, y por API
en `/v1/budget` y `/v1/quota`. La inferencia local no está en ninguna de las dos
y la tarjeta lo dice: no le cuesta a nadie más que al dueño de la máquina.

### El asistente externo

Un nodo sin GPU —o con la red saturada— puede contestar preguntándole a una API
externa. Es **un candidato más** del registro (`kind: 'upstream'`), no un camino
aparte: el ruteo lo puntúa, `/v1/models` lo lista, el chat lo ofrece y los
headers de procedencia lo declaran, sin una sola línea especial en el despacho.

Se configura copiando [`upstreams.example.json`](upstreams.example.json) a
`<storage>/upstreams.json`. La credencial **no va en el archivo**: va el *nombre*
de una variable de entorno, así el secreto no toca el disco del repo ni entra al
manifiesto firmado que se anuncia a la red.

```bash
export NVIDIA_API_KEY=...          # el nombre lo dice el campo apiKeyEnv
pyrusllm serve --swarm
```

Un upstream remoto se registra **offline** si le falta la credencial o el precio,
y el arranque dice cuál de las dos. Lo del precio no es burocracia: sin él
`costs.estimar()` devuelve cero, la reserva no aparta nada y el tope de gasto
deja de cortar justo en el único camino que cuesta dólares.

El externo es el **último recurso por posición, no por veto**: mientras algún
candidato de casa pueda atender ahora, los terceros van al fondo de la lista.
Antes se los filtraba, y eso tenía un agujero que sólo se ve probándolo: la
capacidad *declarada* de un candidato no prueba que ese candidato funcione. Un
`llama-server` apagado anuncia 0/2 —o sea "tengo lugar"—, el externo quedaba
excluido, el local fallaba y no había a quién recurrir. Quedar último **es** la
condición, medida por lo que pasó y no por lo que se anunció.

Mandarle el prompt a un tercero pide **opt-in explícito** (`"optIn": true`, o el
interruptor de `/node`). Y aun prendido, el externo solo entra a la puja cuando no
hay capacidad local ni en la red: mientras alguien de este lado pueda atender, el
prompt no sale. Si el presupuesto se agota, se **degrada a un candidato local**
en vez de negar el servicio —y el rastro de ruteo lo registra como degradación,
no como una elección normal. `GET /v1/upstream` muestra el estado.

**No todo upstream es un tercero.** `"local": true` marca un endpoint que corre en
esta máquina —`llama-server`, vLLM, un NIM self-hosted— hablando OpenAI en
localhost. Entra por HTTP como cualquier upstream, pero el prompt no sale de la
máquina: no lleva credencial, no lleva precio, no le aplica el opt-in y sobrevive
al candado de `local: true` del pedido. Lo que decide todo eso es el campo
`local`, nunca el `kind`, que sólo dice *cómo* se le pide y no *a quién*. La
respuesta lo declara en `X-Pyrus-Scope: local|external`, y el chat lo muestra como
"(this machine)" en vez de "(external API)".

Ese es además el único camino para servir **pesos abiertos**: el motor embebido
resuelve nombres del registry de QVAC (`registry://`), así que un `.gguf` bajado
de HuggingFace no entra por ahí. Se levanta aparte y se consume por HTTP.

**Varias puertas al mismo modelo.** El campo `as` separa cómo llama el proveedor a
un modelo de cómo lo anuncia esta red: NVIDIA sirve
`nvidia/nemotron-3.5-lightning-30b-a3b`, OpenRouter sirve
`nvidia/nemotron-3.5-lightning` y tu `llama-server` sirve lo que le pongas —los
tres con `"as": "nemotron-3.5-lightning"` entran como **una sola fila** del
catálogo. Sin eso serían tres modelos distintos: `findAllByModelId` filtra por
nombre exacto, así que el ruteo por carga, el desempate y la degradación por
presupuesto nunca llegarían a tener dos candidatos entre los cuales elegir. Lo que
viaja en el body sigue siendo el nombre de cada proveedor.

## Pruebas

```bash
npm test                    # las dos suites
npm run test:unit           # cada módulo aislado
npm run test:integracion    # el gateway de verdad, por HTTP, en un proceso y sin red
```

**56 tests, 234 asserts, verde** (46/193 unitarios + 10/41 de integración). La
suite de integración existe porque lo que se rompe al juntar ramas casi nunca es
un módulo: es el cable entre dos. Encontró un defecto que ninguna prueba unitaria
podía ver —los headers de procedencia se aplicaban solo en los caminos con
`stream`— y una comilla invertida en un comentario que cerraba el template
literal del chat y rompía la página entera.

Detalles de por qué (Protomux sobre una sola conexión, D1–D7, el updater OTA en
su propio hilo, verificación con dos máquinas) están en [NOTES.md](NOTES.md).
El plan por fases, en [ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md) y
[ROADMAP_FASE7-X402.md](ROADMAP_FASE7-X402.md); los defectos de saturación que
cerró el ruteo, en [NOTES-SATURACION.md](NOTES-SATURACION.md).

## Estado

- **Fases 0–3 (distribución, inferencia local, gateway, manifiesto firmado,
  swarm P2P, chat sobre el canal P2P): cerradas.** `pear install` → primer
  token, ~24 s. Verificado cross-máquina.
- **Persistencia y archivos: cerrado.** Directorio Hyperbee (los nodos se
  acuerdan de a quién vieron aunque no esté online ahora) + Hyperdrive
  (`send`/`fetch`/`files`).
- **Fase 4 (el install es la demo): construida**, falta cronometrar el
  swarm-join aparte del install en la segunda máquina.
- **Distribución sin dependencias: cerrado.** Binarios standalone para 5
  plataformas publicados en
  [v0.10.0](https://github.com/gazzimon/qvac_node/releases/tag/v0.10.0), más
  instaladores de una línea. Ya no hace falta Node ni Pear para probar la app.
- **Chat-first y puerta de lanzamiento: cerrado.** La app abre en el chat, el
  agente se lanza desde la propia página (join al swarm en caliente, sin
  reiniciar el proceso) y la red exige tenerlo lanzado.
- **Ruteo por carga (D6): cerrado.** `qvac/routing.mjs` elige por carga real, no
  por un orden fijo, y el log dice por qué. Con él entraron el campo `node` (fijar
  máquina), la capacidad honrada desde `swarmModels()`, la key en
  `POST /v1/swarm/manifest` —era la única ruta mutante sin puerta— y el corte
  inmediato ante un `at_capacity`.
- **Elegir máquina desde el chat: cerrado.** Un selector con tres modos (local /
  auto / máquina fija) y **Use this node** en cada tarjeta de `/network`.
- **Fase 6.5 (ledger con tope) y 6.6 (cuota gratuita por par): cerradas.** Con
  reserva write-ahead, corte por tope, panel en `/node` y las rutas
  `/v1/budget`, `/v1/budget/report` y `/v1/quota`.
- **D11 cerrada: WDK y x402 corren directo bajo Bare**, sin shim, sin worklet y
  sin sidecar. El spike (`scripts/spike-d11-wdk-bare.mjs`) importa
  `@tetherto/wdk-wallet-evm`, deriva la cuenta y firma EIP-3009 offline; y la
  firma sale **byte a byte idéntica bajo Node y bajo Bare**, que descarta la
  pregunta de si dos máquinas del swarm con runtimes distintos firmarían
  autorizaciones distintas. Desbloquea las fases 7–12.
- **La liquidación (pagos reales sobre esa base): sigue fuera de alcance** de
  este track — necesita Autobase y decisiones de gobernanza, no solo código.

**Qué es simulado**, para que nadie lo descubra solo:

- `serve` arranca con el registro **vacío**. `--demo` lo puebla con 1 nodo real
  + 3 mocks marcados como `simulado`.
- `economic` del manifiesto es mock (wallet en ceros, con `_mock: true`
  explícito). WDK, recibos y liquidación no están implementados. `directory`
  **no** es mock: ahí se firma la clave real del Hyperbee.
- `Auto` elige por **carga**, no por precio: no es una subasta. El precio viaja
  en el manifiesto pero todavía no participa del ruteo.
- **El ledger corta, y con un asistente externo configurado deja de dar cero.**
  La inferencia local y la de un par siguen valiendo 0 —no le cuestan a nadie más
  que al dueño de la máquina—, así que sin upstream el gasto registrado es 0 y el
  tope nunca se toca. Con un upstream configurado (ver abajo) el camino cobra de
  verdad: reserva, corte y liquidación con los tokens que reporta el proveedor.
- El ledger y el registro de keys persisten a disco; **la cuota gratuita no**: se
  repone al reiniciar el nodo. No hay registro compartido entre nodos.
- **El precio no es comparable todavía.** Viaja estructurado en el manifiesto,
  pero lo llena una constante: todos los nodos anuncian el mismo número. Por eso
  el chat no muestra cuánto costó cada respuesta — un costo inventado sería peor
  que ninguno.
- Las API keys **persisten** en `<storage>/apikeys.json`, en claro y con permisos
  de solo-dueño, todavía sin scopes. Persisten porque tienen que hacerlo: la
  cuenta a la que el ledger le imputa el gasto **es** la key, así que con el
  registro en memoria el tope de USD 20 se reponía apagando y prendiendo el
  nodo. En claro por el mismo criterio que `identity.json`, que ya guarda la
  semilla de red así en ese directorio: el gateway escucha solo en 127.0.0.1 y
  el panel existe para poder volver a copiar una key semanas después. La que
  **no** puede ir en claro es la semilla de la wallet, y eso es otra cosa (D13).
- El login por rol (`qvac/auth.mjs`) **no está conectado a ninguna ruta**: es
  código muerto, no un gate. El gate real son las API keys (ver arriba).
- Las transacciones muestran tokens, latencia y quién — **no muestran plata**.
  El precio lo llena una constante y todos los nodos anuncian el mismo número;
  un monto ahí sería inventado.
- Los instaladores están verificados en Windows; los caminos de macOS y Linux
  están escritos pero no ejecutados end-to-end.
- El nodo que infiere ve el prompt en texto plano. El claim es "ninguna
  corporación centralizada agrega tus datos a escala", no "nadie más lo ve":
  el cifrado E2E está fuera de alcance.
- **El ledger cuenta dólares, y hay límites que no se miden en dólares.** El tier
  gratuito de NVIDIA se agota por *créditos* y el de OpenRouter por *requests por
  día*. Para `budget.mjs` los dos son gratis y por lo tanto ilimitados, que es
  justo lo que no son: el nodo deja de contestar sin que ningún contador lo haya
  visto venir.
- **El asistente externo manda tu prompt a un tercero.** Es el único camino del
  proyecto donde el texto sale de la red P2P hacia la API de una empresa, que lo
  ve, lo puede loguear y lo factura. (Un upstream con `"local": true` no cuenta:
  no sale de la máquina.) Está **apagado por default** y hacen falta
  tres cosas a la vez para que se use: `optIn` prendido, que no haya capacidad
  local ni en la red, y presupuesto disponible. `local: true` lo excluye siempre,
  con opt-in o sin él. Cuando contesta, lo dice: `X-Pyrus-Kind: upstream` en los
  headers y "(external API)" en la línea de procedencia del chat.

## Stack

`bare` 1.31 · `pear-runtime` 1.3.1 · `hyperswarm` 4.17 · `hypercore` 11.35 ·
`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0 · `bare-http1` 4.5.8 ·
`protomux` 3.11 + `corestore` 7.12 + `hyperbee` 2.27 + `hyperdrive` 13.3

## Licencia

Apache-2.0 · [gazzimon](https://github.com/gazzimon)

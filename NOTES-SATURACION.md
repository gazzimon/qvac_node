# NOTES — saturación, capacidad y ruteo

Cómo se mide hoy la carga de un nodo, quién la publica, quién la lee y quién la
ignora. Insumo de la Fase 8 del roadmap (D6: elegir por carga) y de la capa de
upstreams.

Escrito leyendo el código, no la intención: cada afirmación cita archivo y línea.
Lo que no está implementado se dice que no está, no se describe en futuro.

---

## Resumen en una línea

**No hay ninguna cola.** La única admisión que existe es un rechazo de profundidad 1
en el provider (`qvac/provider.mjs:169`). Y la señal de carga viaja completa de punta
a punta hasta llegar al ruteo, donde **nadie la lee**.

---

## La cadena de la carga

```
provider.active                       provider.mjs:51,177,223
  │  Map de requests en vuelo. Es el único contador que refleja trabajo real.
  │
  ├─► rechaza si  active.size >= maxConcurrent      provider.mjs:169-174
  │     code 'at_capacity'. NO encola: contesta y se olvida.
  │
  ▼
store.beginRequest / endRequest        store.mjs:176-186
  │  Contador por fila del registro. Lo llama el provider (:184,:224)
  │  y también el gateway en los dos caminos HTTP (gateway.mjs:594,789).
  ▼
store.localLoad()                      store.mjs:410-419
  │  Suma activeRequests y maxConcurrentRequests de las filas kind==='real'.
  │  Los mocks del modo --demo quedan afuera a propósito: anunciar capacidad
  │  que no existe sería mentirle a la red.
  ▼
node:status  cada 2000 ms              swarm.mjs:48,310-324,485-493
  │  { activeRequests, maxConcurrentRequests } a cada par verificado.
  │  Sin gateway (comando `peers`) manda 0 activos pero la capacidad declarada
  │  del manifiesto, no 0/0 (swarm.mjs:311-322).
  ▼
store.updateStatus(peerKey, status)    store.mjs:356-368
  │  Lo que este nodo cree del otro. Pisa también maxConcurrentRequests: el par
  │  pudo haber cargado otro modelo desde que firmó el manifiesto.
  ▼
toPublic().loadPct                     store.mjs:147-160
  │  Sale por GET /v1/nodes y lo pinta el panel /network.
  ▼
findAllByModelId()                     store.mjs:425-446
     ✗ NO mira activeRequests. NO mira loadPct. Ordena por `kind`.
```

El último eslabón es el punto: todo lo de arriba existe, funciona y se muestra en
pantalla, pero la decisión de ruteo no lo consulta.

---

## Los tres números de capacidad, y que son tres

Hay **tres** lugares distintos donde vive "cuántos requests concurrentes aguanta este
nodo", y no hay nada que los mantenga sincronizados:

| # | Dónde | Qué es | Quién lo usa |
|---|---|---|---|
| 1 | `bin.mjs:389` — `maxConcurrent: 3` en el constructor del `Provider` | la capacidad **honrada** | `provider.mjs:169`, el único que rechaza |
| 2 | `bin.mjs:497` — `maxConcurrentRequests: 3` en `swarmModels()` | la capacidad **anunciada** | va al manifiesto firmado (`manifest.mjs:184-188`) |
| 3 | `POST /v1/swarm/manifest` (`gateway.mjs:1129`) | la capacidad **editada desde el panel** | re-firma el manifiesto |

Coinciden hoy porque son dos literales iguales escritos a mano. El comentario de
`bin.mjs:485-488` dice que `swarmModels()` es *"UNA sola fuente: la usa el manifiesto
que se firma Y el Provider"* — es la intención, pero el `3` del Provider no sale de
ahí, está escrito aparte.

Editar la capacidad desde el panel cambia **(2)** y no toca **(1)**: el nodo pasa a
anunciar un número que no honra. El manifiesto firmado existe justamente para impedir
anunciar lo que no se sirve, y esta es la grieta.

---

## Defectos identificados

### S1 — el ruteo ignora la carga

`gateway.mjs:750` toma `candidatos[0]`. El orden lo fija `findAllByModelId`
(`store.mjs:444`) con un rank fijo `{ peer: 0, real: 1, mock: 2 }`.

El comentario de `store.mjs:435-443` es explícito sobre por qué: los pares van primero
**por una razón de demo**, para que con `--demo --swarm` el camino P2P se ejercite en
vez de que conteste la máquina local. No es una decisión de performance y el código lo
dice.

Consecuencia con dos pares sirviendo el mismo `modelId`: gana siempre el mismo (el
primero que devuelva la iteración del `Map`), sin importar que esté al 100 % y el otro
libre.

### S2 — capacidad anunciada ≠ capacidad honrada

Ver la tabla de arriba. `POST /v1/swarm/manifest` con `maxConcurrentRequests: 10`
hace que la red crea que hay 10 slots; el provider sigue rechazando en el cuarto.

### S3 — `POST /v1/swarm/manifest` no pide API key

Todas las demás rutas que mutan estado están detrás de `rechazoPorKey`:

| ruta | gate |
|---|---|
| `POST /v1/chat/completions` | sí — `gateway.mjs:1103` |
| `POST /v1/files/upload` | sí — `:1300` |
| `POST /v1/files/fetch` | sí — `:1323` |
| `POST /v1/nodes/:id/kick` | sí — `:1358` |
| `POST /v1/nodes/:id` | sí — `:1370` |
| **`POST /v1/swarm/manifest`** | **no — `:1112-1229`** |

Cualquier cosa corriendo en localhost puede cambiar el modelo anunciado, los tags, el
displayName y la capacidad de este nodo, y el nodo lo re-firma con su identidad. Es la
única ruta mutante sin puerta.

### S4 — estampida por status atrasado

`node:status` es broadcast cada 2 s (`swarm.mjs:48`). El día que el ruteo mire la
carga, N consumidores que decidan dentro de la misma ventana van a ver el mismo
"menos cargado" y le van a mandar todo a él a la vez. La corrección de la vista llega
recién en el tick siguiente, cuando el daño ya está hecho.

No es un defecto de hoy —hoy no se mira la carga— pero es la trampa que espera a
quien implemente D6 sin pensarlo.

### S5 — un `at_capacity` no realimenta la vista local

El loop de reintento (`gateway.mjs:591-622`) recorre los candidatos y registra el
resultado de cada intento en `intentos` (`:610`), pero cuando un par contesta
`at_capacity` **no se actualiza la fila de ese par en el registro**. El request
siguiente vuelve a evaluarlo como si estuviera libre, hasta el próximo `node:status`.

Hasta 2 s de requests mandados a un par que ya dijo que no puede.

---

## Lo que NO hay que cambiar

**El provider rechaza en vez de encolar, y así tiene que seguir.**

`provider.mjs:162-168` lo argumenta:

> Se rechaza en vez de encolar a proposito: el consumidor recibe el error ANTES del
> primer chunk, asi que D4 aplica y reintenta en otro candidato. Una cola haria
> esperar al cliente sin que nadie sepa por cuanto.

Y D4 vive en `gateway.mjs:612-615`:

```js
if (r.ok) break
// D4: si ya se le mando aunque sea un token al cliente, NO se reintenta.
// El contexto de una respuesta a medias no se puede retomar en otro nodo.
if (r.started) break
```

Las dos piezas son una sola: el rechazo temprano es lo que **habilita** el reintento
barato. Encolar en el provider convierte un fallo de 1 ms que se resuelve en otro nodo
en una espera ciega contra un nodo que ya está lleno.

Dicho al revés: la cola correcta para un nodo saturado es la red, no un array.

---

## Dónde sí falta una cola

Donde el límite no es GPU propia sino **rate limit ajeno**: las APIs externas.

Ahí la asimetría se da vuelta. Reintentar contra otro proveedor no ahorra nada si
todos tienen el mismo cupo por minuto, esperar 200 ms sí resuelve, y el costo de
esperar lo paga un socket ocioso en vez de una placa de video. Una cola acotada
—con tope de profundidad y de espera, que rechace en el desborde en vez de crecer— es
la estructura correcta **solo en ese borde**.

Es el único lugar del sistema donde encolar es la respuesta.

---

## Lo que ya está medido y nadie consume

Dos fuentes de datos existen, se escriben en cada request y ninguna alimenta una
decisión:

| Dato | Dónde se escribe | Quién lo lee hoy |
|---|---|---|
| `tokens`, `ttftMs`, `tokensPerSec`, `ms`, `ok` por request | `store.pushLog` (`store.mjs:452-465`) → ring de 30 + Hyperbee | el panel `/admin` y `GET /v1/audit` |
| `requests`, `errors`, `tokens`, `lastMs` acumulados por par | `directory.recordStat` (`directory.mjs:233`) vía `store.recordPeerResult` (`store.mjs:469`) | **nadie** |

El histórico por par es exactamente el desempate que necesita un ruteo por latencia, y
ya está en disco. `store.recordPeerResult` se llama en cada cierre de request remoto
(`gateway.mjs:702`) y lo único que hace con el dato es guardarlo.

Nota aparte, para cuando se hable de liquidación: `recordStat` **le cree al par**. Los
`tokens` que suma son los que el par dijo haber servido. Un nodo que reporta 900
cuando sirvió 400 no tiene hoy quién lo contradiga.

---

## Contadores que existen y no son carga real

Para que no se confundan al leer el panel:

- `store.startFluctuation()` (`store.mjs:488-501`) mueve al azar el `activeRequests`
  de las filas `kind==='mock'` cada 2,2 s. Es teatro para el video. **Nunca toca las
  filas `real`** (`:492`), y `localLoad()` las excluye igual (`:414`), así que no
  contamina lo que se anuncia a la red.
- `capacidad()` (`store.mjs:259-266`) clampea lo que llega en un manifiesto ajeno
  entre 1 y 1024. Es anti-mentira, no medición: un par que anuncia 10⁹ slots no
  envenena el registro.

---

## Otros límites del sistema, para tener el mapa completo

No son saturación, pero son las otras cotas que existen:

| Límite | Valor | Dónde |
|---|---|---|
| mensajes por prompt | 64 | `provider.mjs:26` |
| caracteres por prompt | 32 000 | `provider.mjs:27` |
| upload | 512 MB, con backpressure real de `drain` | `gateway.mjs:188,241` |
| ACK de un par | 8 s | `gateway.mjs:364` |
| primer chunk (puede estar cargando 807 MB de pesos) | 120 s | `gateway.mjs:369` |
| stream frenado a mitad | 60 s | `gateway.mjs:373` |
| handshake del swarm | 10 s | `swarm.mjs:53` |
| ring del log en memoria | 30 entradas | `store.mjs:21` |
| TTL del log en Hyperbee | 7 días | `directory.mjs:51` |

La única "cola" del repo es la de escrituras a disco del directorio
(`directory.mjs:117-127`): un `_tail` de una sola vía para que el handler síncrono del
swarm nunca espere al disco. No tiene nada que ver con los requests.

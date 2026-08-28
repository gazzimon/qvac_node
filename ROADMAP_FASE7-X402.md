# PyrusLLM — Roadmap Fase 7→12 · x402, liquidación y capa agéntica

Asume las Fases 0–4 cerradas y el estado que declara el [README](README.md):
distribución P2P, inferencia local, gateway compatible con OpenAI, manifiesto
firmado, swarm, persistencia y archivos. Este documento arranca donde el
[ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md) se detiene: la Fase 6 (ledger y
liquidación) quedó fuera de alcance por track, y con ella quedaron sin dueño
tres deudas que el propio README enumera — `economic` es mock, el precio no es
comparable, y el precio no participa del ruteo.

**Regla del documento, heredada del anterior:** cada decisión tiene contexto,
opciones consideradas y **la que recomiendo**. No quedan preguntas abiertas para
resolver bajo presión. Si el equipo prefiere la otra opción, lo importante es
que quede escrita _una_ antes de tocar código, no cuál.

**Regla de honestidad, también heredada:** todo mock nuevo se marca donde se
vea — en el código que lo arma, en el README y en el propio artefacto. Un
`X-PAYMENT-RESPONSE` con un tx hash inventado sería exactamente la falla que se
ve idéntica a que funcione, y es la única forma de perder por deshonestidad en
vez de por alcance.

**Regla de delegación (nueva, y es la que estructura el documento):** las
**fases** son delegables —exploración, debugging, refactor, implementación,
tests y documentación—, y en las complejas se usan varios agentes para analizar,
implementar y revisar por separado. Las **decisiones D8–D23 no se delegan**: son
de arquitectura, seguridad, modelo de datos o negocio. Un agente propone y
ejecuta; la decisión final es del dueño del proyecto.

Por eso este documento está partido en dos mitades con propósitos distintos: la
sección 1 son decisiones que necesitan una firma humana antes de que alguien
escriba una línea, y la sección 2 son fases que se pueden repartir apenas esas
decisiones estén tomadas. La tabla de la sección 7 marca de qué tipo es cada
decisión, para que se vea de un vistazo cuál no puede salir en un PR de un
agente.

---

## 0 · De qué se parte

Lo que ya está construido y sobre lo que se apoya todo lo que sigue:

| Pieza                                                                                         | Estado                        | Por qué importa acá                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handleChat` en [qvac/gateway.mjs:702](qvac/gateway.mjs#L702)                                 | Cerrado                       | **Único plano HTTP del sistema.** Es el punto de inserción del 402, y es uno solo.                                                                                |
| Bloque `economic` en [qvac/manifest.mjs](qvac/manifest.mjs)                                   | Mock marcado (`_mock`)        | El schema **ya previó WDK**. No hay que subir `schemaVersion`.                                                                                                    |
| [manifest-v0.json:84](manifest-v0.json#L84)                                                   | Congelado                     | Dice textualmente que `economic.walletAddress` es la identidad de COBRO y firma los recibos, y que es **distinta** de la clave de red. El diseño ya está escrito. |
| `pushLog` en [qvac/gateway.mjs:855](qvac/gateway.mjs#L855)                                    | Cerrado                       | Ya cuenta `tokens`, `ttftMs`, `ms` por request. **La medición del cobro ya existe**, falta ponerle precio.                                                        |
| [qvac/apikeys.mjs](qvac/apikeys.mjs)                                                          | En memoria, sin scopes        | Auth actual por `Authorization: Bearer`. x402 no lo reemplaza: convive (D16).                                                                                     |
| Protomux en [qvac/swarm.mjs](qvac/swarm.mjs)                                                  | Cerrado                       | `manifest:announce` / `node:status` / `chat:request`. Sumar tipos de pago es agregar casos, no protocolo nuevo.                                                   |
| [qvac/identity.mjs](qvac/identity.mjs)                                                        | Cerrado                       | Guarda la semilla de red **en claro**. Suficiente para una clave de red; insuficiente para una wallet (D13).                                                      |
| [old/PROMPT_CAPA-AGENTICA_DESCARTADO.md](old/PROMPT_CAPA-AGENTICA_DESCARTADO.md)              | Diseñado, **no implementado** | La capa agéntica está pensada entera y descartada solo por elegibilidad del hackathon. Es recuperable tal cual (Fase 11).                                         |
| [deck/TrustGap.dc.html](deck/TrustGap.dc.html) y [deck/Enclave.dc.html](deck/Enclave.dc.html) | Escrito                       | Ya plantean el problema del centro que ve las dos puntas y la forma del trabajo confidencial. Es la base del Track V.                                             |

**Deudas declaradas en el README que este roadmap cierra:** `economic` mock, el
precio no comparable, el precio ausente del ruteo, y la Fase 6 sin dueño.

---

## 0-bis · Las cuatro restricciones que deciden el diseño

Estas no son decisiones: son hechos del entorno. Todo lo de abajo sale de acá.

### R1 — Corremos `bare`, no Node

`bin.mjs` corre bajo `bare` y el árbol de dependencias es `bare-*`.
**`@x402/express` es inutilizable**: el gateway es `bare-http1`, no hay Express
ni middleware chain. Lo que sí sirve es `@x402/core` + `@x402/evm`, que son
agnósticos de framework, cableados a mano al handler.

Queda por verificar que corran bajo Bare — dependen de criptografía secp256k1 y
probablemente de `viem`. Es el riesgo #1 y tiene un spike propio (D11). El
camino oficial de escape existe y es de Tether:
[`@tetherto/pear-wrk-wdk`](https://github.com/tetherto/pear-wrk-wdk), un worklet
Bare que corre el stack WDK en un hilo aparte con puente HRPC — exactamente la
forma que el proyecto ya usa para el updater OTA.

### R2 — x402 es HTTP; el transporte interno no lo es

D1 del roadmap anterior decidió Protomux sobre Hyperswarm, sin `baseUrl`
alcanzable. Entonces hay **dos planos de pago distintos y no se mezclan**:

- **Plano externo (HTTP):** cliente → gateway. Ahí vive el 402 y el `X-PAYMENT`.
- **Plano interno (P2P):** gateway → proveedor. Ahí viaja un **recibo firmado**,
  no un pago.

Confundirlos lleva a intentar meter HTTP dentro del canal P2P, que es
precisamente lo que D1 descartó por escrito.

### R3 — El costo real se conoce _después_ de responder

El esquema `exact` de x402 cobra un monto fijo declarado **antes**. Un LLM no
sabe cuántos tokens va a generar. Esto no tiene solución elegante: hay que
elegir (D9), y la elección hay que declararla en el 402 para que sea honesta.

### R4 — Con `stream: true`, el recibo llega tarde

x402 devuelve el settlement en el header `X-PAYMENT-RESPONSE`, pero en SSE los
headers salen **antes** del primer token. Liquidar antes de streamear mete la
latencia de una transacción on-chain delante del TTFT, que es la métrica del
pitch. Ver D12.

### R5 — El asistente externo introduce una economía distinta

Cuando la red se satura y el request se va a un asistente externo (Claude), el
costo deja de ser P2P y pasa a ser **una factura en dólares contra una empresa
centralizada**. Eso rompe tres supuestos de todo lo anterior:

1. **El costo se paga en fiat y se cobra en USD₮.** El operador adelanta la
   plata y la recupera a fin de mes: eso es riesgo de crédito, no de protocolo.
2. **El prompt sale de la red.** La promesa del README —_"ninguna corporación
   centralizada agrega tus datos a escala"_— no aplica a ese camino, y hay que
   decirlo en la respuesta misma, no en una nota al pie.
3. **El tope de USD 20 no es un descuento, es un corte.** Un tope que se aplica
   al facturar es un descuento: el gasto ya ocurrió y alguien lo pagó. Para que
   sea un tope tiene que evaluarse **antes** de mandar el request.

De ahí sale la Fase 6.5 y las decisiones D18 y D19.

---

---

## 0-ter · Estado real al 2026-08-26 (tercera pasada) — lo que la auditoría encontró y lo que se arregló

Esta sección se reescribió tres veces el mismo día, y esa frecuencia es el dato
más honesto del documento. La primera pasada declaró cerradas las Fases 6.5 y
8.5; la segunda encontró que los commits `326ae4b` "OpenRouter" y `c1ba394`
"OPEN ROUTER 2" les habían seguido agregando superficie después de cerrarlas, con
cuatro bugs nuevos adentro; ésta registra que esos cuatro están cerrados, con
test que falla si se les quita el arreglo.

Suite al 2026-08-27, después de la Fase 9: **146 tests (90 unit + 56
integración), 707/707 asserts, 7 corridas seguidas en verde**. Que diga cuántas
corridas no es adorno — ver B18. (Cuando esta sección se escribió eran 99 tests
y 419 asserts; el número se actualiza acá en vez de dejarlo envejecer en una
sección que dice "estado real".) `prettier --check` sigue fallando en el resto
del árbol; sigue sin haber CI.

**La regla del bug puesto dejó de ser una costumbre y pasó a ser un comando.**
`npm run bug-puesto` deshace cada arreglo, corre la suite y verifica que rompa
_el test que lo vigila_ — con tres resultados, y el del medio es el que más
informa: `OK`, `OTRO TEST` (se cayó algo distinto: o el arreglo está acoplado, o
el test que se creía que lo vigilaba no lo vigila) y `NO ROMPIO` (nadie lo mira).
Hasta acá esa comprobación se hacía a mano, una vez, el día que se escribía el
test: o sea que la evidencia vivía en la cabeza de quien lo hizo y se perdía ahí
mismo. Hoy cubre los 9 arreglos de la Fase 9 y los 9 dan OK.

**La regla que se rompió dos veces, y por qué la segunda fue distinta.** La
primera vez se ejecutó la 8.5 con la 7 sin empezar: se salteó una precondición.
La segunda no fue eso — fue seguir construyendo sobre una fase **ya declarada
cerrada**, el mismo día, sin volver a abrirla. Es la falla más difícil de ver de
las dos, porque no hay ningún momento en que alguien decida saltearse nada:
simplemente el trabajo sigue y la declaración de cierre queda atrás, todavía
escrita, ya falsa. Una fase cerrada tiene que quedar quieta; si se le toca la
superficie, se reabre y se vuelve a cerrar con lo que haya aparecido.

**Y lo que la evidencia de una auditoría vale.** `c1ba394` reescribió 767 líneas
de `gateway.mjs`, y con eso ocho de las nueve líneas que la primera pasada citaba
dejaron de apuntar a lo que citaban. Las de abajo están verificadas contra el
árbol de hoy y van a caducar igual: lo que no caduca es el **test**, que es la
única evidencia que se rompe sola cuando alguien deshace el arreglo. Por eso a
partir de acá un bug no cuenta como cerrado sin uno, y sin haber comprobado que
falla con el bug puesto.

| Fase                    | Estado real                                | Qué falta exactamente                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.5 Presupuesto         | **CERRADA 2026-08-26**                     | Descongelada y cerrada. B1, B2, B6, B13 y B14, los cinco con test verificado contra el bug puesto. B14 era la condición no negociable de D9 y la Fase 9 la necesitaba; B13 es lo que hace que el tope acote la factura y no a un cliente                                                                                                     |
| 6.6 Cuota gratuita      | **Cerrada**                                | Nada. `quota.mjs` no lo tocó ninguno de los commits nuevos. No persiste, y eso está declarado                                                                                                                                                                                                                                                |
| 7 Desmockear `economic` | **CERRADA 2026-08-26**                     | El manifiesto firmado lleva la dirección de cobro real que genera WDK. D13 implementado: seed propia, nunca derivada de la de red, cifrada con Argon2id + secretbox. El `_mock` queda sólo para un nodo SIN wallet, y ahí significa "no declara dirección de cobro", no "no implementado". Desbloquea 9, 10 y 11                             |
| 8 Precio que rutea      | **CERRADA 2026-08-26**                     | El precio entra al score en el paso 4: después de la carga, antes del histórico. El log dice "mas barato" con los dos números, y el chat muestra el techo por respuesta (`up to USD …` / `no charge`). Los tests están verificados contra el criterio desactivado                                                                            |
| 8.5 Asistente externo   | **CERRADA 2026-08-26 (segunda vez)**       | B11, B12, B15 y B16 arreglados, los cuatro con test verificado contra el bug puesto. B5 sigue acotado y con dueño (D20 / Fase 11), que es de otra fase                                                                                                                                                                                       |
| 9 x402 en el borde      | **CERRADA 2026-08-27; reabierta y recerrada 2026-08-28** | Tres de los cuatro ítems del DoD verificados con test; el cuarto —el tx hash en el explorer de Plasma— **no se puede verificar sin fondear** (D13) y **no se fondeó**. Lleva además D24, D25 y D27. Dos ítems abiertos que son decisión del dueño: B21 y B22. La Fase 10 le agregó a `qvac/x402.mjs` la entrada `plasma-testnet` (9746) al `accepts[]` — eso reabrió y recerró la 9. **El detalle está en § 0-quater y § 0-sexies** |
| 10 Recibos y lote       | **PARCIAL 2026-08-28** — formato, lote, y el transporte por Protomux | El recibo x402 es un artefacto versionado (`qvac/lote.mjs`); se agrupa en un lote por red+wallet, se firma con la wallet (JCS + EIP-191) y se liquida diferido. **El par que sirve un request ruteado cobra**: el gateway le reenvía la autorización EIP-3009, el par atestigua (D24) y acumula en su lote, y el gateway deja de liquidar los ruteados (§ 0-sexies-bis). `npm run verificar-lote` valida un lote offline. **Falta:** flush automático, persistencia del acumulador, y que un `batch-receipts` local difiera. Ver § 0-sexies y 0-sexies-bis |
| 11–12, 11.5, Track V    | No empezadas                               | —                                                                                                                                                                                                                                                                                                                                          |

### Los bugs, y de qué fase es cada uno

| #       | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fase dueña                             | Evidencia                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| **B1**  | **CERRADO.** El registro de keys persiste con escritura atómica ([apikeys.mjs:64-111](qvac/apikeys.mjs#L64-L111)) y está cableado: `apikeys.open` en [bin.mjs:465](bin.mjs#L465), `close` en [bin.mjs:604](bin.mjs#L604). Dos tests, y el segundo reinicia el nodo en el medio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 6.5                                    | [test/index.js:1440](test/index.js#L1440)                                               |
| **B2**  | **CERRADO.** `include_usage: true` lo impone el código y la config no lo puede apagar; sin `usage` y con tokens se liquida por la reserva entera y se avisa. El test apaga el `usage` del proveedor falso y verifica 514 micros contra los 4 que habrían salido de contar deltas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 6.5                                    | [test/integracion.js:807](test/integracion.js#L807)                                     |
| **B3**  | **CERRADO.** El `AbortController` del gateway llega al externo como `signal`, y los dos relojes viven en `completar()`. El test cuelga al proveedor y verifica que la reserva se liberó y no se cobró nada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 8.5                                    | [test/integracion.js:873](test/integracion.js#L873)                                     |
| **B4**  | **CERRADO.** `extraBody` se esparce primero; `stream`, `stream_options` y `max_tokens` van después. El test manda una config hostil y verifica que gana el nodo en los tres campos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 8.5                                    | [test/integracion.js:652](test/integracion.js#L652)                                     |
| **B5**  | **ACOTADO, no cerrado, y agravado por OpenRouter.** 3 reintentos con backoff sobre un POST sin clave de idempotencia ([upstream.mjs:330](qvac/upstream.mjs#L330)). Lo que cambió es contra qué corre: `esReintentable` incluye 429, y en el tier `:free` de OpenRouter el 429 **es** el límite del día — que se cuenta en requests, no en dólares, así que `budget.mjs` no lo ve ni lo puede acotar. Un solo request del usuario consume 3 del cupo diario antes de degradar. Y con el reloj en 180s (B16) la ventana de reserva comprometida por un request que reintenta tres veces es de ~9 minutos. El arreglo de verdad sigue siendo el `nonce` de D20                                                                                                                                                                                                                                                                                                                                                   | **11** (D20)                           | [upstream.mjs:330](qvac/upstream.mjs#L330)                                              |
| **B6**  | **CERRADO 2026-08-26.** La estimación cuenta bytes UTF-8 ([gateway.mjs:502](qvac/gateway.mjs#L502)), y **ahora hay un test que lo distingue**: con 10 caracteres CJK son 30 bytes, o sea 15 tokens contra los 4 que daría contar caracteres — 527 micros de reserva contra 516. El test que existía usaba `hola`, donde los dos criterios dan 2 y el bug sobrevivía                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 6.5                                    | [test/integracion.js](test/integracion.js)                                              |
| **B7**  | **CERRADO.** `GET /v1/upstream` pide credencial, con test. Ver B12: lo que esa ruta protege se leía sin credencial en dos rutas de al lado, y eso ya no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 8.5                                    | [test/integracion.js:495](test/integracion.js#L495)                                     |
| **B8**  | **574 LOC de RAG huérfanas** —no 576—: `rag.mjs` (180), `embeddings.mjs` (185), `rag-corpus.mjs` (209). Último commit sobre los tres: `ede441a`, anterior a las tres pasadas; nada del trabajo nuevo los tocó. 0 importadores fuera de sí mismos, 0 tests, 0 endpoints. Y quedaron peor: `upstreams.example.json` conserva un bloque `_embeddings` que documenta cómo configurarlos, y `leerConfig` sólo lee `upstreams`, `optIn` y `brokerEnabled` — ese bloque no lo parsea nadie                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | fuera de fase — hay que decidir        | [qvac/rag.mjs:39](qvac/rag.mjs#L39)                                                     |
| **B9**  | El instalador —único canal de distribución— baja el `.exe` de `releases/latest` **sin checksum ni firma**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | fuera de fase                          | [installer/PyrusLLM.bat:36](installer/PyrusLLM.bat#L36)                                 |
| **B10** | Sin CI, y `prettier --check` pasó de fallar en 7 archivos a fallar en **40**. `npm run lint` no está limpio ni antes de tocar nada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | fuera de fase                          | `npx prettier . --check`                                                                |
| **B11** | **CERRADO — la credencial de un proveedor podía viajar al endpoint de otro.** `#headers()` escribía `Content-Type` y `Authorization` después de esparcir los `extraHeaders` del archivo, y el comentario declaraba que por eso no se podían pisar. Era falso: los nombres de header de HTTP no distinguen mayúsculas y un objeto de JavaScript sí, así que un `authorization` en minúscula —como lo escribe cualquiera que copie una línea de un curl— no colisionaba, sobrevivían los dos y `bare-fetch` los mandaba concatenados. Se normaliza a minúscula al entrar ([upstream.mjs:114](qvac/upstream.mjs#L114), [:202](qvac/upstream.mjs#L202)) y los nuestros se escriben también en minúscula ([:278](qvac/upstream.mjs#L278)): la colisión la resuelve el objeto, sin lista de nombres reservados que mantener. El test mira lo que recibió el **servidor**, no el objeto que armó el cliente. Verificado contra el bug puesto: `Bearer CREDENCIAL-DE-OTRO-PROVEEDOR, Bearer clave-de-prueba`          | 8.5                                    | [test/integracion.js:732](test/integracion.js#L732)                                     |
| **B12** | **CERRADO — cerrar una de las tres puertas no cerraba nada.** B7 le puso credencial a `/v1/upstream` porque decía quién es el proveedor y si hay cuenta del otro lado. El argumento era correcto y estaba incompleto: `/v1/nodes` devolvía el mismo `operator` y además el `pricing`, y `/v1/routing-log` devolvía `costMicros` —el gasto en dólares, request por request— que es **más** de lo que `/v1/upstream` llega a decir. Las dos piden key ahora ([gateway.mjs:1555](qvac/gateway.mjs#L1555), [:1613](qvac/gateway.mjs#L1613)). `/v1/models` **no** se cierra —un cliente OpenAI tiene que descubrir el catálogo antes de tener credencial— y se le saca el dato en vez de la puerta ([:1543](qvac/gateway.mjs#L1543)). Las seis llamadas del panel pasaron a `authFetch`. Verificado en el nodo real: 401/401/200 sin credencial y los cuatro paneles cargando                                                                                                                                      | 8.5                                    | [test/integracion.js:191](test/integracion.js#L191), [:208](test/integracion.js#L208)   |
| **B13** | **CERRADO 2026-08-26.** Dos topes, y un request pasa sólo si entra en los dos: el de la cuenta acota a ESE cliente, el del nodo acota **la factura**, que es una sola. El rechazo dice cuál se agotó, y un `budget.json` sin el campo toma el default en vez de significar "sin techo"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 6.5                                    | [budget.mjs](qvac/budget.mjs)                                                           |
| **B14** | **CERRADO 2026-08-26.** `finish_reason` lo dice quien generó: el proveedor lo manda en el último chunk y `upstream.mjs` lo reporta por `onFinish`. Un motivo desconocido viaja tal cual en vez de aplanarse a `stop`. Y la guarda del 200 vacío pasó a estar antes de partir los dos caminos — estaba sólo del lado del stream                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 6.5                                    | [test/integracion.js](test/integracion.js)                                              |
| **B15** | **CERRADO — un 200 no quería decir que salió bien.** El status viaja con los headers, o sea antes del primer token; lo que se rompe después viaja como un objeto `error` en el cuerpo, con el stream cerrándose limpio. El parser miraba `usage` y `delta.content` y nada más, así que ese error se descartaba: el generador terminaba normal, el gateway lo leía como `ok: true`, **cortaba el recorrido de candidatos sin probar el siguiente**, y el cliente recibía 200 con `content: ""` y `finish_reason: "stop"`. Ahora se tira ([upstream.mjs:415](qvac/upstream.mjs#L415)) y el detalle del proveedor va al log de este proceso, no al cliente. Dos tests: que no salga como exitoso, y que el recorrido siga                                                                                                                                                                                                                                                                                        | 8.5                                    | [test/integracion.js:960](test/integracion.js#L960), [:1018](test/integracion.js#L1018) |
| **B16** | **CERRADO — el reloj del primer byte estaba calibrado al ras de una sola medición.** Los 60s salían de los 43,4s medidos el 2026-08-25; el 2026-08-26 el mismo endpoint tardó 58. Dos segundos de margen: el reloj que existe para atrapar a un proveedor colgado estaba por cortar a uno lento contestando bien. Ahora 180s ([upstream.mjs:73](qvac/upstream.mjs#L73)). Lo que importa no es el número sino de dónde sale: un tier gratis es una cola y un techo calibrado al ras de una corrida no es un techo. Los dos relojes pasan a tener test —no tenían ninguno—, incluidas las tres formas de escribirlos mal                                                                                                                                                                                                                                                                                                                                                                                        | 8.5                                    | [test/index.js:1233](test/index.js#L1233)                                               |
| **B17** | **CERRADO 2026-08-26 con la Fase 7.** `.env`, `wallet.json` y `upstreams.json` entran a `pear.stage.ignore` ([package.json:22-24](package.json#L22-L24)). Cambió de dueño en el camino: era "fuera de fase" mientras el `.env` sólo llevaba credenciales de API, y pasó a ser de D13 cuando empezó a llevar la passphrase de la wallet. Lo que sigue **no verificado** es si `pear stage` consulta además el `.gitignore` por su cuenta; ahora no hace falta que lo haga. El texto original decía: el `.env` no está en la lista de exclusión del empaquetado — `.env.example` le dice al operador que el archivo se lee del directorio de trabajo y `cargarEnv()` lo lee de `process.cwd()`. `.gitignore:34` lo cubre para git; `pear.stage.ignore` ([package.json:19-36](package.json#L19-L36)) **no lo menciona**, y `npm run seed` publica ese stage. **No verificado**: si `pear stage` consulta además el `.gitignore` por su cuenta. Si no lo hace, el canal OTA publica la credencial                 | fuera de fase                          | [package.json:19](package.json#L19)                                                     |
| **B18** | **CERRADO — la suite fallaba ~1 de cada 2 corridas y se leía como "suite en verde".** El test del upstream caído ordenaba los candidatos con "el caído con MÁS capacidad libre" (8 contra 1), y eso no ordena nada: `cargaDe` es un cociente y 0/8 y 0/1 son los dos cero. Empatados en carga, `errorRate` y `lastMs`, decidía el `jitter: random()` de `routing.mjs`. Y el modo de falla era un `TypeError` sobre `e.intentos`, no un assert, así que no decía qué se había roto. **Toda afirmación de "suite en verde" anterior a este arreglo era una moneda**, incluidas las dos pasadas anteriores de esta sección. Ahora al vivo se le ocupa su único slot, que lo manda al fondo por la regla de saturados —determinística y anterior a cualquier azar—; 5 corridas completas seguidas en verde                                                                                                                                                                                                        | fuera de fase                          | [test/integracion.js:1282](test/integracion.js#L1282)                                   |
| **B19** | **NUEVO — ningún manifiesto validó nunca contra su propio schema congelado, y nadie lo notó porque nada lo validaba.** D2 pide marcar el mock donde se vea y lo implementa con un campo `_mock` adentro del bloque; `manifest-v0.json` declara `additionalProperties: false` tanto en `economic` como en `directory`. Las dos reglas chocan: **todo manifiesto con un bloque mock es schema-inválido**, y lo viene siendo desde que los mocks existen — `directory` sigue así hoy, sin haberlo tocado la Fase 7. La causa raíz es que el schema era un documento y no un chequeo: `grep manifest-v0` sobre el árbol devolvía sólo comentarios. Ahora hay test, y fija la violación conocida en vez de taparla: si aparece otra, falla. **Lo que hay que decidir** es cuál de las dos reglas cede — la marca de honestidad de D2, o `additionalProperties: false` (que subirlo sería tocar el schema, y D2 lo prohíbe)                                                                                         | fuera de fase — hay que decidir        | [test/index.js](test/index.js)                                                          |
| **B20** | **CERRADO 2026-08-27 con la Fase 9 — el 402 declaraba un tope de tokens y no lo aplicaba nadie.** `topeDeSalidaCobrado` armaba el `outputTokenLimit` del `accepts[]` y no se llamaba en ningún otro lado; la generación usaba `topeDeSalida`, que para un par, el motor local y un mock devuelve lo que pidió el cliente — o sea cero, o sea sin techo. Se cobraba un precio fijo diciendo "hasta N tokens de salida" y se generaba sin límite, con un comentario al lado que afirmaba lo contrario ("se declara ANTES y se aplica DESPUES: son el mismo"). Es la mitad de D9(a) que hace honesto al precio fijo, y sin ella el caso 3 de D27 no puede ni existir. Ahora se aplica sobre el **texto acumulado** y no sobre el conteo de deltas: quien decide cómo se trocea el stream es el proveedor, así que un tope contado en deltas hereda el mismo agujero que D24 cierra. Dos límites dichos donde se ven: es una **estimación** (bytes UTF-8 ÷ 4), no el tokenizador del modelo, que el gateway no ve | 9                                      | `npm run bug-puesto "D9"`                                                               |
| **B21** | **NUEVO, ABIERTO — un socket destruido a mitad de stream NO llega como falla, y se cobra.** Reproducido limpio dos veces: el proveedor abre 200, manda un delta, espera 400 ms y hace `res.destroy()`; el gateway lo lee como `ok: true` y **liquida** (`[x402] liquidado chatcmpl-…`). Sólo se detecta cuando destruye en el MISMO tick, que es lo que hacía el harness viejo — ahí bare-fetch descarta la respuesta entera y falla con NETWORK_ERROR antes del primer delta, que es otro caso. O sea que el tercer ítem del DoD de la Fase 9 vale para el par (donde el framing del swarm lo dice) y **no** para un upstream HTTP. **Es superficie de la 8.5, que está cerrada**: arreglarlo la reabre, y esa es decisión del dueño, no de quien lo encontró. Mientras tanto el test de D27 caso 2 se montó sobre el error-en-el-cuerpo (B15), que sí se detecta, y sobre el par                                                                                                                            | **8.5 — hay que decidir si se reabre** | `test/integracion.js` (D27 caso 2, montado sobre B15 a propósito)                       |
| **B22** | **NUEVO, ABIERTO — un corte del cliente ahora cuenta como ÉXITO del par.** D27 decide que si corta el cliente se cobra, porque el par hizo su trabajo. Para que eso fuera cierto hubo que hacer que `streamFromPeer` resuelva `ok: true` cuando el corte es NUESTRO y ya había tokens (antes esperaba los 60 s del reloj de inactividad y terminaba como `peer_stalled`, o sea sin cobrar y sin atestiguar un prefijo que el cliente sí había recibido). Ese mismo `ok` alimenta `recordPeerResult`, o sea `errorRate`, o sea un desempate del ruteo. **No toca el precio** —que es con lo que cerró la Fase 8— pero sí una entrada de la 8, y por eso se anota en vez de darse por obvio. El cambio va en la dirección correcta (un par que sirvió 141 tokens y fue cancelado por el cliente no es un par que falla), pero la decisión de si eso reabre la 8 es del dueño                                                                                                                                    | **8 — hay que decidir si se reabre**   | `npm run bug-puesto "un corte NUESTRO"`                                                 |

### El orden que se ejecuta desde acá

1. ~~**Fase 8.5 — cerrarla de nuevo** (B11, B12, B15, B16)~~ **HECHO 2026-08-26.**
   La credencial de un proveedor ya no puede viajar a otro; las tres rutas que
   exponían proveedor, precio y gasto están cerradas o sin el dato; un error
   dentro de un 200 deja de verse como una respuesta exitosa y vacía; y el reloj
   del primer byte dejó de estar dos segundos por encima de lo medido. Los
   cuatro con test, y los cuatro verificados contra el bug puesto — que es el
   criterio que B6 no cumple y por eso B6 sigue abierto.
2. ~~**Fase 6.5 — cerrar lo que se reabrió**~~ **HECHA 2026-08-26.** Se
   congeló y se descongeló el mismo día para cerrarla entera. B14 salió con
   ella, así que la Fase 9 ya no lo hereda.
3. ~~**Fase 7** — la precondición que se salteaba desde la primera pasada~~
   **HECHA 2026-08-26.** Con ella cae B17, que cambió de dueño: era "fuera de
   fase" mientras el `.env` sólo tenía credenciales de API, y pasó a ser de D13
   cuando empezó a tener la passphrase de la wallet.
4. ~~**Fase 8 — la mitad que falta**: el precio en el score y el costo en el chat.~~
   **HECHA 2026-08-26.**
5. ~~**Fase 9** en adelante, como estaba escrito.~~ **CERRADA 2026-08-27**, con
   el tx hash declarado afuera (D30). Con D24, D25 y D27 adentro, y con B20 aparecido y cerrado en el
   camino. Lo que falta para poder cerrarla está en **§ 0-quater**.

Y una regla nueva, que sale de B18 y no de ninguna fase: **una corrida verde no
es evidencia de nada si el test no falla cuando se quita el arreglo, y una suite
no está verde hasta que lo esté varias veces seguidas.** Las dos pasadas
anteriores de esta sección afirmaron "suite en verde" sobre una suite que fallaba
la mitad de las veces. Desde 2026-08-27 esa regla se ejecuta: `npm run
bug-puesto`.

---

## 0-quater · Fase 9 — CERRADA el 2026-08-27, con un ítem explícitamente afuera

**Se cierra con tres de los cuatro ítems del DoD cumplidos y el cuarto —el tx
hash en el explorer— DECLARADO AFUERA**, no dado por bueno. Las dos salidas eran
legítimas: fondear, o cerrar dejando el ítem escrito como pendiente. La que no lo
era es cerrarla sin decirlo, que es lo que § 0-ter documenta que ya pasó dos
veces. Queda dicho acá, en la tabla de fases y en la Fase 9 misma.

**Por qué se cierra igual.** El ítem no está bloqueado por trabajo nuestro sino
por dos cosas externas y una decisión: no hay stablecoin en Plasma testnet, el
facilitator hosted no responde, y D30 decidió que nada se estrena en mainnet.
Dejar la fase abierta esperando eso convertiría "abierta" en un estado sin
criterio de salida — y el resto de la fase sí está terminado y con test.

**Los dos ítems de auditoría que quedan abiertos, y que NO son de esta fase:**
B21 (superficie de la 8.5) y B22 (una entrada de la 8). Se cierran cuando el
dueño decida si esas fases se reabren.

### El DoD, ítem por ítem

| Ítem del DoD                                                                                    | Estado                                        | Con qué se comprueba                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Un `curl` sin pago recibe un 402 legible: cuánto, a quién, en qué cadena y hasta cuántos tokens | ✅ los cuatro datos asertados                 | `npm run test:integracion` → _sin credencial y con wallet…_ |
| El mismo request con un cliente x402 devuelve tokens                                            | ✅ firma real (`ExactEvmScheme` + wallet WDK) | → _con el X-PAYMENT firmado, el desconocido recibe tokens_  |
| …y un **tx hash visible en el explorer de Plasma**                                              | ❌ **NO VERIFICADO**                          | — ver abajo                                                 |
| Matar el nodo a mitad de stream no cobra                                                        | ✅ contra un **par**, no contra un upstream   | → _FASE 9 DoD: matar el nodo a mitad de stream NO cobra_    |

**El tx hash, sin adornos.** Lo que devuelven los tests es `0xfe…fe`, inventado
por un facilitator falso que corre en `127.0.0.1`. Para el real faltan **dos**
cosas, no una: (a) una wallet fondeada, que D13 prohíbe hasta que la custodia
esté hecha —lo está— pero que sigue siendo una decisión de plata real, no una
tarea; y (b) verificar contra la cadena la dirección del contrato USDT0 de
Plasma, que hoy está apagada por default detrás de
`PYRUS_X402_PLASMA_ASSET_VERIFICADO` justamente porque nadie la miró. Sin (b), un
fondeo cobraría en Stable y no en Plasma, así que ni siquiera probaría lo que el
DoD pide. **Esto no se da por bueno y no se marca en verde en ningún lado.**

**Por qué el tercer ítem dice "contra un par".** El DoD habla de matar _el nodo_,
y un nodo no es HTTP: es el canal del swarm, con su propio framing y su propio
`chat:cancel`. Ese es el que se prueba, con un swarm falso que da lo que HTTP no
puede dar — **un `chat:cancel` tarda un round trip y el par sigue generando
mientras tanto**, así que los chunks en vuelo llegan _después_ de que este lado
decidió cortar. Para un upstream HTTP el mismo ítem **no** se cumple hoy: ver
**B21**, que está abierto y es decisión del dueño porque reabre la 8.5.

### Lo que se sumó, y lo que deliberadamente no hace

- **D24** — `qvac/atestacion.mjs`: JCS del artefacto sin `signature`, firmado con
  la **wallet** (`account.sign`, EIP-191), colgado del recibo de D12 y
  recuperable por `GET /v1/receipts/:id`. Tres decisiones que conviene tener
  escritas: **un par no se atestigua** (el que corrió el modelo fue él y el 402
  pagó a _su_ wallet — firmar acá sería el artefacto que parece prueba y no lo
  es; la suya viaja por Protomux y es la Fase 10); **sin firmante no sale nada**,
  nunca sin firma; y el hash lleva el algoritmo pegado al valor
  (`blake2b-256:…`) en vez de en un campo aparte, que se puede desincronizar. La
  ausencia de atestación **siempre viaja con motivo**.
- **D25** — `pushLog` agrega `tokensPrefill`, `tokensDecode` y `tokensFuente`.
  `tokens`, `ttftMs` y `ms` no cambian de significado. **No reabre la Fase 8**:
  ni `estimarRequest` ni `costoDelIntento` leen el log, y D22 queda intacto.
- **D27** — los tres casos, con test cada uno y los tres verificados contra el
  bug puesto.
- **Nada de esto lo consume nadie todavía.** Es deliberado y es la razón 2 de
  D24: hacia atrás no se firma, así que el artefacto empieza a acumularse antes
  de que haga falta. Quien lo consume es la Fase 10.

### El ítem que quedó afuera, y qué haría falta para cumplirlo

No se cierra por decreto: queda con su camino escrito, y ese camino es la
Fase 10 más D30.

1. **Un activo con EIP-3009 en Plasma testnet.** No existe: hay que desplegarlo
   (D30.1). El criterio de aceptación ya es ejecutable — `npm run verificar-x402`
   con `PYRUS_X402_PLASMA_TESTNET_ASSET` apuntando al contrato nuevo.
2. **Un facilitator que soporte 9746**, o sea D14(b) self-hosted (D30.2).
3. **Recién entonces**, el tx hash en `testnet.plasmascan.to`. Y mainnet
   después, si alguna vez, como promoción de algo que ya funcionó.

Mientras tanto **el ítem se reporta como no cumplido**, no como pendiente de
mirar: `npm run verificar-x402` sale con exit 1 y dice cuál de las tres partes
falta.

**Cómo se firma la atestación, para poder repetirlo.** `bin.mjs` abre el
keystore y le pasa al gateway **una función que firma**, no la cuenta ni la
frase: la invariante de que el gateway nunca ve la seed queda igual de apretada
que antes de la Fase 9. Verificado a mano contra la seed pública de prueba —
`account.sign` → `viem.recoverMessageAddress` recupera `0xf39F…2266`.

---

## 0-quinquies · Bloque 0 de D30 — hecho el 2026-08-27. La Fase 7 se reabrió y se volvió a cerrar

D30 se decidió el 2026-08-27 y dejó tres consecuencias escritas. Escritas no
alcanzaba: sin ellas la Fase 10 se podía redactar pero no demostrar, porque no
había activo con qué firmar, no había facilitator que aceptara 9746, y el nodo no
sabía hablarle a otra cosa que a mainnet. Esto es lo que se ejecutó.

### La Fase 7 se reabrió, y se dice acá porque la regla lo pide

Dos de las cuatro precondiciones tocan `qvac/wallet.mjs` y `bin.mjs`, que son
superficie de la **Fase 7 (cerrada el 2026-08-26)**. La regla del proyecto dice
que una fase cerrada no se toca de costado: se reabre explícitamente y se vuelve
a cerrar con lo que aparezca. **Se reabrió, se hicieron D30.1 y D30.2, y se
cierra de nuevo con esto.** No se tocó nada más de la fase.

Lo que **no** cambió, para que se pueda verificar rápido: el formato del keystore
(`VERSION` sigue en 1, un archivo viejo se abre igual), la derivación, el
cifrado, la invariante de que la seed no sale del proceso que la abre, y el
default de D15 — que sigue siendo Plasma mainnet.

**La Fase 9 NO se reabrió, y hay una consecuencia que hay que anotar.** Este
bloque no toca `qvac/x402.mjs`, que es donde viven `CAIP2` y `activoDe()`. O sea
que el nodo hoy puede **firmar** contra 9746 pero todavía no arma un `accepts[]`
para esa red: `x402.mjs` sólo conoce `plasma` (9745) y `stable` (988). Esa
entrada es trabajo de la Fase 10 y reabre la 9, así que es decisión del dueño y
no se hizo por cuenta propia. Queda dicho como lo que falta entre "el camino
existe" y "el `curl` cobra en testnet".

### Los cuatro ítems

| Ítem      | Qué era                                                                                             | Qué se hizo                                                                                                                                  | Cómo se comprueba                                                     |
| --------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **D30.1** | `swarmStorageDir()` mandaba el keystore a `os.tmpdir()` bajo `bare`, y Windows limpia temp          | `wallet.directorioKeystore()` lo resuelve al directorio **persistente**, nunca a temp; `bin.mjs` tiene `walletStorageDir()` aparte del resto | `D30.1: el keystore NUNCA cae en temp por su cuenta` · 2 anclas       |
| **D30.2** | `RPC_DEFAULT` era una constante de mainnet y `economicDelNodo` nunca le pasaba un `rpc` a `abrir()` | tabla `REDES` + `redDe(env)` + `PYRUS_WALLET_RED` / `PYRUS_WALLET_RPC`, enhebrado hasta `cuentaDesde`                                        | 3 tests, incluido uno de punta a punta · 2 anclas                     |
| **D30.3** | en 9746 no hay stablecoin; los faucets dan XPL, que es gas y no tiene contrato                      | `scripts/activo-prueba.sol` — ERC-20 con EIP-3009 — compilado a `activo-prueba.artefacto.json` y desplegable con `npm run desplegar-activo`  | selectores verificados **contra el bytecode**, no contra el ABI       |
| **D30.4** | el hosted de D14 devolvía 500/503 en todos sus endpoints y no soporta 9746                          | `scripts/facilitator.js` — `/verify`, `/settle`, `/supported` — **sin una sola dependencia nueva**                                           | levanta en un proceso node de verdad y contesta `/supported` con 9746 |

### Cinco decisiones de implementación que conviene tener escritas

1. **El compilador no entró al repo.** D30 pedía bytecode precompilado desde
   `scripts/` y sin hardhat ni foundry, y así quedó: la compilación pasó **una
   vez, fuera del árbol**, con `solc` suelto. `package.json` no ganó ni una
   dependencia. El precio hay que decirlo: recompilar no es `npm run` de nada, y
   por eso el artefacto guarda la versión exacta del compilador, los settings y
   el **SHA-256 de la fuente** — y un test lo recomputa. Alguien que edite el
   `.sol` y no recompile rompe la suite en vez de desplegar en silencio algo que
   no es lo que se lee al lado.
2. **El facilitator no usa el adapter de SemanticPay, y no es capricho.**
   `@semanticio/wdk-wallet-evm-x402-facilitator@1.0.0-beta.2` fija
   `@x402/evm@2.2.0` y `@tetherto/wdk-wallet-evm@1.0.0-beta.7`, y este árbol
   corre **2.23.0 y beta.17**. Instalarlo dejaría dos copias de `@x402/evm` en el
   mismo proceso, y la que arma el 402 no sería la que lo liquida. Resultó
   innecesario: `@x402/evm` 2.23 ya exporta `toFacilitatorEvmSigner`, que es
   exactamente lo que ese adapter hacía, y los tres endpoints son un
   `http.createServer`. Cero dependencias nuevas, Express incluido.
   (De paso: el paquete que D30 nombraba como `@semanticpay/…` no existe con ese
   scope; el real es `@semanticio/…`, que es como lo escribe D14.)
3. **`registerExactEvmScheme` anuncia mainnets que nadie pidió.** Adentro llama a
   `registerV1()` con su propia lista de fábrica, así que un `/supported` crudo
   declara `ethereum`, `base`, `avalanche` y veinte más — redes que ese proceso no
   puede servir, porque su signer y su RPC están en 9746. Anunciar lo que no se
   puede cumplir es el modo de falla que este bloque existe para evitar, así que
   `/supported` se filtra a la red configurada y `/verify`/`settle` rechazan
   cualquier otra **antes** de mirar la firma. Encontrado probando, no leyendo.
4. **El guardia de D30 es lista blanca, y no tiene flag.** Una lista negra de
   mainnets cumple hasta el día que aparece una cadena que nadie anotó, y el modo
   de falla de esa omisión es desplegar en una red con plata real creyendo que
   era un ensayo. Con lista blanca la omisión falla del lado barato. Y no hay
   variable que lo saltee a propósito: D30 dice "sin excepción", así que
   promocionar a mainnet es un cambio de código con revisión, no un `export`.
5. **El token no se llama $QVAC**, por lo que dice D30.3 y con la marca en los
   tres lugares donde se ve: `name` = `PyrusLLM Test USD`, `symbol` = `tUSD`, y
   una constante `AVISO` en el contrato que dice que no es una stablecoin y no
   vale nada. El `mint` es **abierto** — cualquiera puede emitirlo — que además
   de evitar custodiar una llave de emisión es la marca más fuerte posible de que
   esto no es una stablecoin.

### Revisión del Bloque 0 contra la implementación de referencia — 2026-08-27

El bloque se revisó entero contra `@x402/core` y `@x402/evm`, que es la
comparación que manda: **es el mismo código que corre cualquier facilitator
hosted, y además es el cliente que nuestro propio gateway usa para liquidar.**
El spec público de x402 describe el flujo pero no fija los campos de respuesta,
así que el contrato vinculante es el schema del paquete instalado.

Lo que quedó confirmado, para no volver a mirarlo: el contrato coincide
exactamente con el `eip3009ABI` de la referencia (las dos sobrecargas,
`balanceOf`, `name`, `version`, `authorizationState`); el guardia de maleabilidad
usa el valor de OpenZeppelin; el nonce se marca antes de transferir; el
`DOMAIN_SEPARATOR` se recomputa en fork; la ventana usa desigualdades estrictas
igual que FiatTokenV2. Y **Multicall3 está desplegado en 9746** — `@x402/evm` lo
usa en su camino de diagnóstico, y se verificó con un `eth_getCode` contra la
cadena, igual que se verificó que el RPC de la tabla contesta `0x2612`.

Aparecieron tres cosas. Las tres compartían un modo de falla y por eso van
juntas: **ninguna rompía nada de forma visible, y ninguna la podía ver un test
que mirara el JSON crudo.**

1. **Los revert strings estaban en castellano, y `@x402/evm` clasifica por
   regex sobre el revert string.** Los regex de `parseEip3009TransferError` están
   escritos contra el FiatTokenV2 de Circle, así que los cinco motivos
   —vencida, todavía no válida, nonce usado, saldo insuficiente, firma inválida—
   colapsaban a un único `transaction_failed`. Con D9 cobrando un tope fijo casi
   no molesta; **en la Fase 10 rompe la decisión**, porque el lote liquida solo y
   esos cinco piden tres acciones incompatibles: `nonce_already_used` es un
   reintento idempotente y se da por cobrado, `insufficient_balance` es del otro
   lado y no se reintenta, `invalid_signature` no es contabilidad sino
   reputación. Los mensajes pasaron a inglés **con la nota de por qué no se
   traducen** —son interfaz de máquina, no texto para una persona— y hay un test
   que corre los regex REALES del paquete instalado contra los mensajes reales
   del contrato, con control negativo incluido.

2. **El facilitator contestaba errores que el cliente oficial no podía leer**, y
   de dos formas distintas. En `/verify` mandaba `errorReason`/`errorMessage`
   —los nombres de _settle_—, y `verifyResponseSchema` los descarta sin
   quejarse: el gateway recibía `{isValid:false}` pelado, sin motivo. En
   `/settle` faltaban `transaction` y `network`, que el schema exige como string
   aunque la liquidación haya fallado, así que zod rechazaba la respuesta entera
   y el cliente tiraba `FacilitatorResponseError` con el motivo real anidado
   adentro de otra excepción. Las dos rompían exactamente lo que ese bloque de
   errores existe para sostener —del otro lado hay un gateway que ya sirvió los
   tokens y necesita registrar por qué no cobró—, y las dos se reprodujeron
   punta a punta antes de tocar nada.

   **Por qué el test no lo agarró, que es lo que más importa:** verificaba la
   respuesta con un cliente escrito a mano. Un test que valida contra un cliente
   que no es el que corre en producción no vigila el contrato que importa. Ahora
   hay uno que usa `HTTPFacilitatorClient`, el mismo que usa `x402.liquidar()`.

3. **El encabezado del `.sol` prometía ERC-1271 y el contrato no lo hace.**
   La sobrecarga de `bytes` existe porque `@x402/evm` elige por largo de firma,
   no porque haya soporte para pagadores que sean contratos: `_recuperar` exige
   65 bytes y hace `ecrecover`. Hoy no molesta —el pagador de D30 es una EOA de
   WDK—, y se corrigió el texto igual, porque un comentario que promete una
   capacidad inexistente es la misma clase de artefacto que este proyecto
   persigue en todos lados.

De paso quedaron escritas dos cosas que estaban implícitas: **la receta de
recompilación completa** (el artefacto no anotaba `claveFuente`, que entra en el
hash de metadata del bytecode y por lo tanto lo determina — hubo que adivinarla
una vez, y el control de reproducir el artefacto viejo byte a byte antes de
regenerarlo ahora está escrito), y **la reserva contigua del bloque de puertos**
de la suite, que no cubría los puertos derivados que abren los tests del
facilitator.

**Lo que esta revisión NO cambió:** `qvac/x402.mjs` y `qvac/gateway.mjs` no se
tocaron, así que la Fase 9 sigue cerrada y el punto de más arriba sigue en pie —
el nodo todavía no arma un `accepts[]` para 9746. Tampoco hay tx hash: nada de
esto tocó una cadena salvo las dos lecturas de comprobación.

---

### Lo que este bloque NO hace, y no se va a leer como si lo hiciera

- **No hay un tx hash.** Nada de esto tocó una cadena: falta desplegar el activo
  (necesita XPL de faucet en una clave desechable) y correr `verificar-x402`
  contra el contrato desplegado. El ítem del DoD de la Fase 9 **sigue reportado
  como no cumplido**, exactamente como lo dejó 0-quater.
- **No hay 402 en testnet todavía**, por lo de `x402.mjs` de más arriba.
- **Ningún test sale a internet, y no por suerte.** El facilitator se prueba con
  un RPC apuntado a un puerto donde no hay nada: los tres endpoints que se
  ejercitan se contestan sin tocar la cadena, y si alguno necesitara la red el
  test colgaría — que es la señal, no el problema. El artefacto del token se mira
  en disco y las redes salen de una tabla.

---

## 0-sexies · Fase 10 — recibos y lote (parcial), hecho el 2026-08-28. La Fase 9 se reabrió y se recerró

Esto ejecuta la primera mitad de la Fase 10: el **formato** del recibo y del
lote, la **firma** del lote con la wallet, y la **liquidación diferida** local.
La otra mitad —la atestación **del par** viajando por Protomux, firmada por él—
se hizo en una segunda pasada el mismo día: **§ 0-sexies-bis**. Lo que sigue sin
hacer después de las dos: el disparador que vacía el lote solo, la persistencia
del acumulador, y que un `settlement: 'batch-receipts'` local difiera en vez de
liquidar por request.

### La Fase 9 se reabrió, y se dice acá porque la regla lo pide

La precondición de la Fase 10 era agregar `plasma-testnet` (`eip155:9746`) a
`CAIP2` y a `activoDe()` en `qvac/x402.mjs` — que es superficie de la **Fase 9
(cerrada el 2026-08-27)**. 0-quinquies ya había anotado esto como lo que
faltaba entre "el camino existe" y "el `curl` cobra en testnet", y que era
decisión del dueño. **Se reabrió, se hizo, y se recierra con esto.** No se tocó
nada más de la Fase 9. Lo que **no** cambió: el `accepts[]` de `plasma` (9745) y
`stable` (988), el orden de preferencia de D15, la verificación sincrónica
(D12), y la liquidación inmediata por request — el lote **no la reemplaza**,
`recibo.liquidacion` guarda cómo salió y `liquidarLote` reintenta las que
fallaron.

### Lo que se sumó

| Pieza | Qué es | Cómo se comprueba |
| --- | --- | --- |
| **`plasma-testnet` en `x402.mjs`** | `CAIP2['plasma-testnet'] = 'eip155:9746'`; `activoDe()` lo arma desde `PYRUS_X402_PLASMA_TESTNET_ASSET` / `_NAME` / `_VERSION` / `_DECIMALS` / `_SYMBOL` — los mismos nombres que lee `scripts/verificar-x402.js`. Sin `ASSET` y `NAME` la red **no se ofrece**: un cliente no firma un EIP-712 a medias | `FASE 10 / precondicion: x402 arma un accepts[] para plasma-testnet` · `npm run bug-puesto "plasma-testnet"` |
| **El recibo x402 estructurado** (`qvac/lote.mjs`) | Un pago verificado con el settlement diferido: `authorization` + `signature` EIP-3009, el dominio EIP-712 (`assetName`/`assetVersion`/`asset`), el `payTo`, el `requirements` entero tal cual se ofreció en el 402, y —colgada— la atestación de D24. La clave de idempotencia es el `nonce` de la autorización (D20) | tests unit `FASE 10: un recibo sin lo esencial…` |
| **El lote** | Agrupa recibos de **una** red y **una** wallet (se liquida contra un facilitator). Firmado con la wallet: JCS (RFC 8785) del lote sin `signature` + `personal_sign` EIP-191, mismo patrón que `atestacion.mjs`. `verificarLote` recupera al firmante, chequea homogeneidad y total, y recibo por recibo recupera la firma EIP-3009 contra el dominio guardado | tests unit `FASE 10: el lote se firma…`, `…cambiar el lote…`, `…verificarLote agarra un recibo…` |
| **Liquidación diferida** | `liquidarLote({ lote, liquidar })` recorre el lote llamando a `x402.liquidar()` una vez por recibo. Clasifica el resultado por la taxonomía de errores de `@x402/evm` (0-quinquies, punto 1): `nonce_already_used` cuenta como liquidado, `insufficient_balance` es del otro lado, `invalid_signature` es reputación | tests unit `FASE 10: liquidarLote…`, integración `…se puede liquidar diferido` |
| **`npm run verificar-lote`** | `bare scripts/verificar-lote.mjs <lote.json>` — valida un lote firmado offline, sin red. Corre bajo `bare` (no `node` como `verificar-x402`) para usar la **misma** `verificarLote` que el gateway y no reimplementar el JCS | levanta y sale 0/1 según el lote |
| **Acumulación en el gateway** | `liquidarYRegistrar` mete el recibo al lote **sólo si lo servimos nosotros** — el `payTo` del 402 es nuestra wallet. Si contestó un par, el `payTo` apuntó a **su** wallet (D10) y ese recibo **no** entra: es de él | integración `FASE 10 / D10: el lote acumula recibos al payTo del NODO, y los de un par NO` |
| **`x402.PROTOCOLO_FACILITATOR`** | El descriptor congelado de lo que este nodo manda a `/verify` y `/settle` (`paymentPayload` + `paymentRequirements`) y lo que lee de vuelta. Escrito, no adivinado — un lote que no se arma con esos campos se rechaza del otro lado sin decir por qué | tests unit + integración `…el protocolo nodo<->facilitator…` |

### Cuatro decisiones de implementación que conviene tener escritas

1. **El lote acumula TODOS los recibos locales, no sólo los que fallaron al
   liquidar.** La liquidación inmediata de la Fase 9 sigue corriendo; el recibo
   guarda `liquidacion: { success, transaction }` y `pendientes({ soloPendientes:
   true })` filtra los que todavía se deben. El valor real de `liquidarLote` hoy
   es reintentar esos — que es exactamente lo que D12 dice que la Fase 10
   arregla. El día que se apague la liquidación por request, el mismo lote pasa a
   ser el único camino sin cambiar de forma.
2. **`verificar-lote` corre bajo `bare`, no bajo `node`.** `verificar-x402.js` es
   node porque hace RPC a cadenas reales y por eso **duplica** la tabla de redes.
   `verificar-lote` es sólo cripto local, así que importa `qvac/lote.mjs` y usa
   `verificarLote` tal cual: una canonicalización que se copia es una que puede
   divergir al validar.
3. **`verificarLote` no ata `firmante == payTo`.** Expone quién firmó el lote y
   deja que quien lo consume decida — igual que `atestacion.verificar` no ata la
   atestación a un pago. El test `firmar con TU wallet no te deja quedarte con el
   lote de OTRO` fija que el firmante recuperado **no** es el `payTo`, que es lo
   que permite rechazarlo aguas arriba.
4. **No hay endpoint nuevo ni disparador de flush.** El acumulador es memoria del
   proceso, como el `Map` de recibos del gateway — no un ledger. Armar y firmar
   el lote es una llamada de `qvac/lote.mjs`; cuándo hacerlo (tamaño, tiempo,
   apagado) no se decidió y se anota como lo que falta.

### Lo que este bloque NO hace

- **No mueve un peso.** `liquidarLote` en los tests corre contra el facilitator
  falso o una función inyectada; ninguno toca una cadena. Sigue sin haber tx
  hash, exactamente como lo dejó 0-quater.
- **No transporta la atestación del par** — ~~la mitad grande, pendiente~~
  **hecho en § 0-sexies-bis** el mismo día.
- **No hay flush automático del lote.** Ver decisión 4.
- **Un test de la suite queda rojo, y no es de esta fase:** `D30.4: los errores
  del facilitator sobreviven al CLIENTE OFICIAL` — falla igual en un checkout
  limpio de esta rama (`scripts/facilitator.js`, superficie de 0-quinquies).

---

## 0-sexies-bis · El transporte por Protomux — hecho el 2026-08-28 (segunda pasada del mismo día)

La mitad grande de la Fase 10: cuando un gateway rutea un request pagado a un
par, **el par es el que cobra**. Dos decisiones del dueño lo enmarcan:

1. **Handoff completo, no compartido.** El gateway reenvía la autorización
   EIP-3009 del cliente al par por Protomux; el par arma su recibo y su
   atestación D24 y lo acumula en **su** lote; el gateway **deja de liquidar los
   ruteados**. La alternativa —el gateway sigue liquidando y el par sólo
   atestigua— se descartó: dejaba dos vías de cobro para el mismo pago y no
   cerraba `batch-receipts`.
2. **El par NO re-verifica el pago reenviado.** Confía en que el gateway que
   ruteó ya corrió `x402.verificarPago`. Es a cambio del TTFT, y su costo hay
   que decirlo: un gateway comprometido puede quemar GPU de un par. Queda
   anotado como lo que un `verificarPago` del lado del par cerraría.

### El cable

| Mensaje | Cambio |
| --- | --- |
| `chat:request` (gateway→par) | Gana `payment` = `{ authorization, signature, requirements, red }` (el pago del cliente, tal cual) y `maxTokens` (el tope del 402). Ausentes = request de cuota gratuita, como siempre. |
| `chat:done` (par→gateway) | Gana `attestation` (la D24 firmada por el par) y `attestationMissing` (el motivo si falta). |

`channel.mjs` no se tocó: sigue siendo **un** mensaje JSON, y agregar campos es
compatible hacia atrás — un nodo viejo ignora `payment` y sirve gratis, uno
nuevo sin `payment` hace lo mismo.

### El reparto

- **`qvac/provider.mjs`** — con `payment`, el par acumula el texto servido, lo
  recorta en `maxTokens` (estimación bytes UTF-8 ÷ 4, igual que el gateway — así
  la atestación y lo que el cliente recibe son el **mismo** texto y no uno más
  largo), firma la atestación D24 con su wallet (`bin.mjs` le inyecta
  `walletAddress` + `firmarConWallet`, mismo patrón que el gateway), arma el
  recibo con `lote.construirRecibo` y hace `lote.agregar`. Guarda: sólo si
  `requirements.payTo` es su propia wallet. Sin wallet/firmante: sirve igual, no
  atestigua, y el `chat:done` dice el motivo.
- **`qvac/swarm.mjs`** — `chatRequest` reenvía `payment`/`maxTokens`; el
  `chat:done` entrega `{ attestation, attestationMissing }` a `onDone`.
- **`qvac/gateway.mjs`** — `streamFromPeer` arma el `payment` desde el
  `pagoVerificado` y lo pasa; `procesarPago` bifurca por `node.kind`: **par →
  `registrarRuteado`** (NO liquida; verifica la atestación del par con
  `atestacion.verificar` **y** que el firmante sea la wallet del manifiesto
  firmado del par, y la cuelga del rastro), **local → `liquidarYRegistrar`**
  como antes. El evento SSE y `/v1/receipts/:id` de un ruteado traen
  `settledBy: 'peer-batch'` y `paymentResponse: null`.

### Comprobación

- `FASE 10: un par que sirve un request ruteado atestigua y acumula en su lote`
  — el par firma, el recibo entra a `lote.pendientes()` con el `payTo` del par y
  el `payer` del cliente.
- `FASE 10: el par recorta en el tope del 402 y lo atestigua como length (D9)`.
- `FASE 10: sin wallet el par sirve igual pero no atestigua ni acumula`.
- `FASE 10: un pago reenviado a otra wallet NO lo acumula el par`.
- `npm run bug-puesto "Fase 10"` — 9 anclas, las 4 nuevas incluidas.

### Lo que esta pasada NO hace

- **El corte del cliente (D27 caso 1) no devuelve la atestación al gateway.** El
  par sí acumula el recibo parcial de su lado (cobra el prefijo que sirvió), pero
  su `chat:done` no llega porque el chat del gateway ya se fue con el `abort`. El
  rastro del gateway lo dice con un motivo, no en verde. Cerrarlo pide que
  `cancelChat` mantenga el chat vivo hasta el `chat:done` o un timeout — anotado,
  no hecho.
- **Sigue sin haber flush ni persistencia del acumulador.** Un corte del proceso
  entre "servido" y "flush" pierde el recibo. Es lo próximo de la Fase 10.
- **Sólo los ruteados difieren.** Un serve local sigue liquidando por request
  (Fase 9) y además acumula; un `settlement: 'batch-receipts'` en el manifiesto
  todavía no cambia eso.

---

## 1 · Decisiones bloqueantes

Numeración continuada del roadmap anterior, que llegó hasta D7.

### D8. Dónde vive el 402

**Problema:** el pago tiene que ocurrir en algún punto del camino
cliente → gateway → proveedor, y solo un tramo de ese camino habla HTTP.

**Opciones:** (a) en el gateway, sobre `/v1/chat/completions`; (b) en cada nodo
proveedor.

**Decisión: (a), el gateway.** Es el único que habla HTTP. El nodo proveedor no
tiene puerto alcanzable desde afuera — esa es toda la razón por la que existe
D1. Ponerle 402 al nodo obligaría a inventar un transporte HTTP sobre el canal
P2P, que es trabajo nuevo para resolver un problema que ya está resuelto del
otro lado.

**Impacto si no se decide:** alguien intenta cobrar en el nodo, descubre a mitad
de camino que no hay dónde escuchar, y el trabajo se tira.

---

### D9. Esquema de cobro (R3)

**Problema:** `exact` cobra un monto fijo declarado antes de generar. El costo
real depende de los tokens de salida, que no se conocen hasta terminar.

**Opciones:** (a) `exact` por request a precio fijo con `max_tokens` acotado;
(b) saldo prepago descontado por uso real; (c) cobro ex-post por tokens reales.

**Decisión: (a) en la Fase 9, (b) en la Fase 10.** (c) no existe en el esquema
`exact` de x402 y construirlo sería salirse del stack. (a) es honesto **si el
402 declara el tope**: el `accepts[]` dice "hasta N tokens de salida por $X" y
el gateway aplica ese `max_tokens` aunque el cliente no lo mande. (b) es lo que
el schema ya llama `prepaid-balance` y es el modo correcto para un agente que
hace 200 llamadas.

**Condición no negociable:** si el gateway recorta la respuesta por el tope, el
`finish_reason` tiene que decir `length`, no `stop`. Cobrar por un tope y
reportar terminación normal es mentir en el único campo que el cliente mira.

**Impacto si no se decide:** el precio del 402 se elige en vivo y termina siendo
un número inventado que no corresponde a nada.

---

### D10. Quién cobra: el gateway o el proveedor

**Problema:** el `payTo` del 402 tiene que apuntar a una dirección. Puede ser la
del gateway (que después reparte) o la del proveedor elegido.

**Opciones:** (a) el gateway cobra y liquida al proveedor; (b) `payTo` apunta
**directo a la wallet del par elegido**.

**Decisión: (b), y no es solo técnico.** El README promete _"ni un tercero que
se quede con el margen"_. Si el gateway cobra y reparte, el proyecto es
OpenRouter con más pasos, y el argumento entero del pitch se cae. Con `payTo`
directo, el gateway arma el 402 con la wallet que vino en el manifiesto
**firmado** del proveedor — y la firma Ed25519 sobre JCS es justamente lo que
prueba que esa wallet pertenece a ese nodo. La pieza que hace esto posible ya
está construida desde la Fase 2.

**Consecuencia que hay que aceptar:** el gateway no puede garantizar el cobro de
nadie más que de sí mismo cuando sirve local. Es correcto: no es un custodio.

**Impacto si no se decide:** se implementa el camino cómodo (el gateway cobra) y
después es un refactor con implicancias de producto, no de código.

---

### D11. Runtime de la wallet (R1)

**Problema:** WDK y `@x402/*` están escritos para Node. Este proyecto corre bajo
Bare y se distribuye como binario standalone que **no requiere Node instalado**.

**Opciones:** (a) `@tetherto/wdk-wallet-evm` directo bajo Bare; (b) worklet
`@tetherto/pear-wrk-wdk`; (c) sidecar Node.

**Decisión: (a), `@tetherto/wdk-wallet-evm` directo bajo Bare.**

> **RESUELTO el 2026-08-25 por el spike.** Los cuatro pasos pasan bajo Bare sin
> shim, sin worklet y sin sidecar. Y hay un resultado que el spike no buscaba y
> vale más que el sí: **la firma EIP-3009 es byte a byte idéntica bajo Node y
> bajo Bare** — misma seed, mismo dominio, mismos 65 bytes. Eso descarta de una
> vez la pregunta de si dos máquinas del swarm con runtimes distintos podrían
> firmar autorizaciones distintas.
>
> ```
> OK 1. import @tetherto/wdk-wallet-evm            -> function
> OK 2. derivar una cuenta desde la seed           -> 0xf39Fd6e5…92266
> OK 3. firmar EIP-3009 OFFLINE                    -> 0x65afa8f9…3a9181c
> OK 4. import @x402/core y @x402/evm              -> core:1, evm:52
> ```
>
> (b) y (c) quedan como planes de contingencia si una versión futura de WDK
> rompe la compatibilidad, no como caminos a construir. **El riesgo #1 del
> roadmap está muerto y las Fases 7 a 12 quedan desbloqueadas.**

El spike que lo resolvió, para poder repetirlo cuando suba una versión:

```
1. bare -e "import('@tetherto/wdk-wallet-evm').then(m => console.log(Object.keys(m)))"
2. derivar una cuenta desde una seed phrase de prueba
3. firmar un EIP-3009 transferWithAuthorization OFFLINE (sin red, sin RPC)
4. lo mismo para @x402/core y @x402/evm
```

Si los cuatro pasan, es (a) — que es lo que ocurrió. Si una versión futura
falla por dependencias nativas o de `node:crypto`, es (b), que además es el
camino oficial de Tether para exactamente este caso. (c) rompe la promesa de
"el binario trae todo adentro": sería un retroceso de producto, no solo de
código, y habría que decirlo en el README si se llega ahí.

---

### D12. El recibo en modo stream (R4)

**Problema:** en SSE los headers salen antes del primer token, y el settlement
de x402 viaja en un header.

**Opciones:** (a) liquidar antes del primer chunk y mandar
`X-PAYMENT-RESPONSE` normal; (b) **verificar** antes (barato, sin blockchain),
servir, **liquidar después**, y emitir el recibo como **evento SSE final** más
un `GET /v1/receipts/:id` para recuperarlo.

**Decisión: (b), documentando la desviación del spec.** (a) mete la latencia de
una transacción on-chain delante del TTFT, que es el número que el proyecto
mide, publica y usa para vender. La verificación —que es la parte que protege al
proveedor de gastar GPU gratis— sí es sincrónica y no toca la cadena.

En el camino **no-stream** no hay problema: `X-PAYMENT-RESPONSE` normal, porque
la respuesta se arma entera antes de escribir nada.

**Condición:** la desviación se documenta en el README y en la respuesta misma.
Un cliente x402 estándar que no encuentre el header tiene que poder enterarse de
por qué, no quedarse esperando.

**Impacto si no se decide:** se implementa (a) sin pensarlo, el TTFT de la demo
se triplica, y el mejor número del proyecto desaparece.

---

### D13. Custodia de la seed de la wallet

**Problema:** [qvac/identity.mjs](qvac/identity.mjs) guarda la semilla de 32
bytes **en claro** en `identity.json`. Para una clave de red está perfecto —
comprometerla permite suplantar a un nodo, no robar plata. Para una wallet con
USD₮ real, no alcanza.

**Decisión: seed de wallet separada, nunca derivada de la identidad de red**,
cifrada en reposo o delegada al secret manager de WDK. El schema congelado ya
declara que son dos claves distintas ([manifest-v0.json:84](manifest-v0.json#L84));
la decisión acá es que esa separación **también existe en disco**, no solo en el
documento.

**Regla operativa:** no se fondea ninguna wallet hasta que esto esté hecho. No
es una tarea de endurecimiento posterior — es la precondición de la Fase 9.

**Impacto si no se decide:** se fondea una wallet cuya clave está en claro en el
directorio de datos de una app que se distribuye por P2P.

---

### D14. Facilitator

**Problema:** el settlement necesita un facilitator que verifique firmas y
empuje las transacciones.

**Opciones:** (a) el hosted de Semantic (`x402.semanticpay.io`);
(b) self-hosted con `@semanticio/wdk-wallet-evm-x402-facilitator`.

**Decisión: (a) hasta la Fase 10.** El self-hosted está **en beta** según la
propia documentación, necesita una wallet adicional fondeada con gas nativo, y
agrega un componente que el equipo no controla al camino crítico de la primera
demo que cobra de verdad.

**Lo que hay que decir en voz alta:** la documentación de WDK aclara que Tether
_"does not endorse, operate, or assume legal or financial responsibility for any
third-party facilitator"_. Eso va en el README junto al resto de las
advertencias, no escondido.

**Cuándo se revisa:** en la Fase 10, o antes si D17 se activa.

**REVISADA el 2026-08-27, y el resultado es (b).** No por preferencia: el hosted
devolvía 500/503 en todos sus endpoints ese día y no soporta 9746. D30 lo volvió
obligatorio y el self-hosted está hecho — `scripts/facilitator.js`, ver
0-quinquies. Los tres reparos de esta decisión envejecieron así: sigue en beta
(cierto, y por eso corre contra testnet); necesita una wallet con gas nativo
(cierto, y en testnet el faucet la fondea gratis); agrega un componente que no
controlamos al camino crítico (**al revés**: reemplaza uno que no controlamos por
uno que sí, y el que no controlábamos fue justo el que se cayó).

---

### D15. Chain

**Problema:** x402 requiere una EVM con USD₮0 desplegado y soporte de EIP-3009.

**Decisión: Plasma (`eip155:9745`) como default, Stable (`eip155:988`) como
fallback.** Fees casi nulos, finalidad casi instantánea, y son las dos que el
facilitator hosted soporta. `chains: ['plasma', 'stable']` pasa el pattern
kebab-case del schema **sin tocarlo**, que era la condición de D2.

**Nota sobre plata real:** Plasma no es una testnet. Se empieza con montos de
$0.001 y una wallet con USD 2. El riesgo está acotado por el monto, no por el
entorno, y eso hay que saberlo antes de la primera corrida (riesgo #2).

**SUPERSEDIDA POR D30 en cuanto al orden.** Esa nota decía cómo empezar y D30
decidió que no se empieza ahí: 9745 sigue siendo el default y la elección de
D15 no cambia, pero se estrena en 9746. Desde 0-quinquies eso es operable —
`PYRUS_WALLET_RED=plasma-testnet`— y el chainId no es un detalle de
configuración: por EIP-155 entra en lo que se firma, así que una transacción
firmada para 9745 no vale en 9746.

---

### D16. Convivencia con las API keys

**Problema:** [qvac/apikeys.mjs](qvac/apikeys.mjs) ya autentica clientes
externos. Un segundo mecanismo de acceso puede volverse contradictorio.

**Decisión: tres caminos que no se pisan.**

| Camino                            | Condición                | Qué pasa                                                        |
| --------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `local: true`                     | siempre                  | Gratis, sin red, sin pago. La excepción del README se mantiene. |
| `Authorization: Bearer qvac_sk_…` | key emitida por el panel | Cuenta con saldo prepago (Fase 10).                             |
| Sin key ni saldo                  | default                  | **402.**                                                        |

El 402 es el **default para desconocidos**, que es exactamente lo que un agente
necesita para consumir sin registrarse en nada. Las keys siguen siendo el camino
del humano que ya configuró un bot y no quiere volver a pensar en esto.

---

### D17. Dónde vive la liquidación si VELA entra

**Problema:** WDK recomienda Plasma con facilitator hosted (D15). VELA vive en
Base Sepolia y en Horizen Chain, un L3 sobre Base. Si el Exitpoint de VELA tiene
que disparar el pago, la liquidación tiene que estar donde VELA puede tocarla.

**Decisión: no se cierra ahora.** Se cierra recién si Horizen acepta el early
access. Hasta entonces, Plasma + hosted, que es más barato de probar y no
compromete nada.

**Lo que ya se sabe para cuando haya que cerrarla:** el facilitator self-hosted
soporta cualquier EVM con USD₮0 desplegado, así que mover la liquidación a Base
es posible — al precio de activar D14(b), que está en beta. Es un costo
conocido, no una incógnita.

**Impacto si no se decide a tiempo:** se construye la liquidación en una cadena
y hay que rehacerla en otra. Por eso el Track V no toca la liquidación hasta que
esta decisión esté cerrada.

---

### D18. Cómo se impone el tope de USD 20 (negocio + seguridad)

**Problema:** el tope tiene que evaluarse **antes** del gasto (R5.3). Y hay una
restricción técnica que lo complica: una autorización EIP-3009 es por un **monto
fijo** — no se liquida parcialmente. Firmar USD 20 y consumir USD 7 no deja
liquidar 7: deja liquidar 20 o nada.

**Opciones:**

- **(a) Autorizaciones denominadas.** El usuario firma N autorizaciones chicas
  (por ejemplo 20 × USD 1) válidas por el mes; a fin de mes se liquidan solo las
  que se consumieron. **El techo es criptográfico**: no existe una firma para el
  peso número 21, así que el sistema no puede cobrar de más aunque el código
  tenga un bug.
- **(b) Saldo prepago** (`prepaid-balance`, que el schema ya nombra). Se carga en
  tramos, se descuenta por uso medido, se corta en cero. El tope es no
  autorecargar más de 4 tramos de USD 5 por mes.
- **(c) Postpago con tope por política.** Se mide todo el mes y se factura al
  final aplicando el tope.

**Decisión: (b) en la Fase 6.5, (a) como objetivo de la Fase 10.** (c) queda
descartada por lo que dice R5.3 — un tope aplicado al facturar es un descuento,
porque el gasto ya ocurrió y alguien lo pagó.

Lo que hace que (b) vaya primero no es que sea mejor, sino que **se puede
construir hoy, sin wallet y sin blockchain**: la medición ya existe en
`pushLog`, y un contador con corte no necesita nada de lo que D11 todavía no
resolvió. (a) es estrictamente superior —el techo lo impone la criptografía y no
el código del gateway— pero depende de que WDK corra.

**Condición no negociable:** el contador vive del lado que gasta, nunca en el
cliente. Un tope que el consumidor puede editar no es un tope.

**Impacto si no se decide:** se implementa (c) sin querer, porque es la más
fácil, y el primer mes con tráfico real termina en una factura que nadie acordó.

---

### D19. Cuándo se dispara el asistente externo, y qué se le dice al usuario (negocio + privacidad)

**Problema:** _"cuando la red se satura"_ no es una condición ejecutable, y el
camino externo rompe la promesa de privacidad del README (R5.2).

**Decisión: tres condiciones, todas necesarias.**

1. **No hay candidato con capacidad** — todos los pares que sirven ese modelo
   están en su `maxConcurrentRequests`, o no hay ninguno. Se reutiliza el
   `node:status` de D6, no se inventa una métrica de saturación nueva.
2. **El usuario lo habilitó** — opt-in por cuenta, apagado por default.
3. **Queda presupuesto** (D18).

Si alguna falla: 503 con el motivo, o el modelo local. **Nunca el externo en
silencio.**

**Divulgación:** se reutilizan los headers de procedencia que ya existen —
`X-Pyrus-Operator: Anthropic`, `X-Pyrus-Kind: external`, `X-Pyrus-Model` con el
ID real— y el chat lo muestra en la respuesta como muestra cualquier otro nodo.
`local: true` prohíbe este camino igual que prohíbe los pares remotos: es la
misma regla, sin excepción nueva.

**Modelo:** `claude-sonnet-5`, que es el que pediste. Los números para la
aritmética del tope, al 2026-08-25:

| Modelo           | ID                 |                               Input $/1M |           Output $/1M |
| ---------------- | ------------------ | ---------------------------------------: | --------------------: |
| Claude Sonnet 5  | `claude-sonnet-5`  | $3,00 (intro $2,00 **hasta 2026-08-31**) | $15,00 (intro $10,00) |
| Claude Haiku 4.5 | `claude-haiku-4-5` |                                    $1,00 |                 $5,00 |

**Ojo con la fecha: el precio intro de Sonnet 5 vence el 31-ago-2026**, dentro de
seis días. Si la aritmética del tope se calibra esta semana con $2/$10, el 1 de
septiembre el costo por turno sube 50% solo, sin que nadie toque nada.

Con un turno típico de 2.000 tokens de entrada y 500 de salida, a precio
estándar: **USD 0,0135 por turno → ~1.480 turnos por los USD 20**. Con Haiku 4.5:
USD 0,0045 → ~4.400 turnos. Dos palancas más que están en la API y no cuestan
código nuevo: **prompt caching** (las lecturas de caché salen ~0,1× y el system
prompt del agente es estable, así que es la optimización más grande disponible)
y la **Batch API a mitad de precio**, que no sirve para el chat interactivo pero
**sí para el procesamiento de lotes de la Fase 11**, que no es sensible a la
latencia.

**Lo que queda para vos:** Sonnet 5 o Haiku 4.5 es una decisión de negocio —
triplica la cantidad de turnos por el mismo tope, a cambio de capacidad. Y hay
un detalle técnico que la inclina: el canal de instrucciones de operador a mitad
de conversación (mensajes con rol `system` dentro de `messages[]`), que es el
camino recomendado contra inyección de prompt en D21, **existe en Opus 5 y Opus
4.8 pero no en Sonnet 5**.

**Impacto si no se decide:** el fallback se dispara por una heurística escrita en
vivo, y el primer usuario que vea "Anthropic" en un header sin haberlo
habilitado tiene razón en enojarse.

---

### D20. Harness del agente: límites, timeouts, reintentos, idempotencia (arquitectura)

**Problema:** el agente de la Fase 11 corre solo, con herramientas y con acceso
a una wallet. Sin límites duros, un loop no es un bug: es una factura.

**Decisión: cuatro controles, todos en el harness y ninguno confiado al
modelo.**

| Control                                         | Qué evita                                           | Cómo                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Límite de pasos y de tokens por tarea**       | loops infinitos                                     | Contador en el harness. El gateway ya cuenta tokens por request; acá se acumulan por tarea                                                                    |
| **Timeout por herramienta**                     | que una herramienta colgada bloquee la tarea entera | Timeout propio por llamada, más chico que el de la tarea                                                                                                      |
| **Reintentos con backoff exponencial y jitter** | fallos transitorios                                 | Solo para 429, 5xx y errores de conexión. **Nunca** para 400, 404 ni un pago inválido: reintentar un error determinista es gastar dos veces para fallar igual |
| **Idempotencia**                                | que el reintento cobre o escriba dos veces          | Ver abajo                                                                                                                                                     |

**La idempotencia tiene una respuesta que sale gratis del stack:** el `nonce` del
EIP-3009 **es** la clave de idempotencia. Un reintento que reusa el mismo nonce
no puede cobrar dos veces, porque la cadena rechaza la segunda liquidación. No
hay que inventar un registro de claves: el mecanismo de pago ya trae uno, y es
más fuerte que cualquier tabla en memoria porque lo impone la red y no el
proceso. Para las operaciones que no involucran pago (escribir un campo
extraído, guardar un recibo), la clave se deriva del hash del documento más el
identificador del campo.

Esto es lo que hace que reintentar sea seguro. **Sin idempotencia, el backoff
exponencial no es tolerancia a fallas: es un multiplicador de cobros.**

Hay precedente en el repo y conviene respetarlo: D4 ya decidió que el gateway
reintenta solo **antes** del primer chunk, y nunca después de empezar a
streamear. El harness del agente aplica la misma regla un nivel más arriba.

**Impacto si no se decide:** el primer fallo transitorio en producción cobra dos
veces, y el log no alcanza para saber si fue un bug o un doble consumo real.

---

### D21. Prompt injection y exfiltración: cómo se miden (seguridad)

**Problema:** el agente documental de la Fase 11 lee entradas que vienen de
afuera —facturas escaneadas, PDFs de terceros, texto OCR— y tiene herramientas y
un presupuesto. **Un documento con texto adversarial es una entrada de
ejecución**, no un dato. Esto no es hipotético en este proyecto: la Parte D del
diseño original pide explícitamente fixtures "genuinamente desprolijos" de
origen externo.

**Decisión: se mide, no se asume.** Una suite adversarial con fixtures
envenenados —instrucciones embebidas en el cuerpo del documento, en metadatos,
en texto blanco sobre blanco, en el resultado del OCR— y cuatro métricas que se
publican junto con las de acierto:

| Métrica                       | Qué cuenta                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Obediencia a la inyección** | cuántas veces el agente siguió la instrucción del documento en vez de la del operador                                                              |
| **Violación de herramientas** | llamadas a una herramienta fuera de la allowlist, o con argumentos fuera del rango declarado                                                       |
| **Exfiltración**              | datos del documento apareciendo en un destino que no les corresponde — incluido **el prompt saliendo hacia el asistente externo sin opt-in** (D19) |
| **Gasto no autorizado**       | el caso propio de este proyecto: ¿el documento logró que el agente pagara algo?                                                                    |

**Trazabilidad:** por cada paso se registra la **cadena de entrada completa**,
**qué herramienta se eligió y con qué argumentos**, y **la salida**. El log
JSONL del gateway ya es el audit trail —así lo declara el diseño de la capa
agéntica—; acá se extiende con esos tres campos, no se inventa un sistema nuevo.

**Tres controles que no dependen de que el modelo se porte bien**, porque
medir sin contener es solo documentar el incidente:

1. **El presupuesto (D18) es el límite de daño.** Un agente comprometido no
   puede gastar más que el tope. Esta es la razón más fuerte para que la Fase
   6.5 vaya antes que la capa agéntica y no después.
2. **`security.allowedTools` del manifiesto deja de estar vacío.** El campo
   existe desde la Fase 2 con la lista en cero; acá empieza a usarse.
3. **El contenido del documento nunca se concatena al system prompt.** Va en un
   bloque marcado como datos. Para instrucciones de operador que llegan a mitad
   de la conversación, la API tiene un canal propio —mensajes con rol `system`
   dentro de `messages[]`— que existe justamente para no reescribir el prompt
   del sistema con texto que vino de afuera; disponible en Opus 5 y Opus 4.8, no
   en Sonnet 5 (ver D19).

**Impacto si no se decide:** la Fase 11 sale con un agente que tiene wallet,
herramientas y entradas de origen desconocido, y sin un solo número que diga qué
tan seguido hace lo que le pide el documento en vez de lo que le pide el dueño.

---

### D22. Política de precios (negocio)

**Problema:** el manifiesto anuncia `1000000 QVAC / per 1m completion tokens`,
que es una constante de relleno. Hay que reemplazarla por un número defendible
antes de la Fase 8, que hace que el precio participe del ruteo.

**El dato que decide, y es del propio repo.**
[EVALUACION-DGX-SPARK.md:109](EVALUACION-DGX-SPARK.md#L109):

| Escenario                 | USD/MTok |       Payback |     VAN 12% |
| ------------------------- | -------: | ------------: | ----------: |
| Vender commodity 24/7     |     0,30 | **181 meses** |  **−3.995** |
| Nodo privacidad (clínica) |       15 |   **7 meses** | **+15.716** |

Mismo equipo, utilización parecida. **Vender barato no es ganar menos: es no
recuperar nunca el hardware.**

**El dato del mercado, al 2026-08-25:** DeepInfra vende Llama 3.2 **3B** —más
grande que el `LLAMA_3_2_1B_INST_Q4_0` de este repo— a **USD 0,02 por millón**.
La misma evaluación dice que a 20 tok/s la electricidad sola cuesta USD
0,176/MTok: el datacenter vende **nueve veces por debajo de nuestra luz**.
Competir por token no es difícil, está perdido. Referencias: DeepSeek V4 Flash
USD 0,22/0,66 (off-peak), V4 Pro 0,66/1,98; Groq Llama 3.3 70B 0,59/0,79;
Sonnet 5 3/15.

**Decisión: cuatro reglas.**

1. **La referencia no es el token más barato del mercado, es el modelo que el
   comprador no puede usar.** Quien compra acá no elige entre este nodo y
   DeepInfra: elige entre este nodo y no poder mandar la historia clínica a
   ninguna API. Ese comprador no compara contra USD 0,02.
2. **Tres precios, porque hay tres pagadores** (ver también D16 y D19):
   inferencia local **gratis y sin cuota** —racionarle al usuario su propia
   máquina no tiene sentido—, par P2P al precio de su manifiesto, y asistente
   externo a costo más margen contra el tope de D18.
3. **Los modelos chicos (1B–3B) no se cobran: el free tier es el producto.** A
   cualquier precio compiten contra USD 0,02. Cobrarlos no da plata y mata la
   adopción. Se cobra en modelos grandes sobre hardware serio, que es el
   escenario "nodo privacidad" de la tabla.
4. **Piso duro: nunca por debajo de USD 0,50/MTok de salida.** Debajo de eso la
   evaluación propia dice que el equipo no se paga nunca. Vender más barato es
   subsidiar al comprador con hardware propio.

**Impacto si no se decide:** la Fase 8 hace que el precio rutee, y sin política
el número que rutea es el que quedó escrito en una constante.

---

### D23. La cuota gratuita: dónde se hace cumplir y cuánto (negocio + arquitectura)

**Problema:** la regla 3 de D22 dice que el free tier es el producto. Un free
tier sin límite es un producto gratis, y uno que no se puede hacer cumplir es
peor: promete algo que no controla.

**Dónde. Decisión: la hace cumplir el PROVEEDOR, por clave de par.**

El gateway es del consumidor. Pedirle que respete la cuota del proveedor es
poner al zorro a cuidar el gallinero: cualquiera que edite su propio gateway
consume gratis sin límite. El proveedor, en cambio, sabe quién le está pidiendo
—la clave del par viene autenticada por la conexión del swarm, no la elige el
mensaje— así que puede medir por par y cortar.

Es el mismo principio que ya fijó D18 para el tope en dólares: **el contador
vive del lado que paga.** Allá el que paga es el que gasta; acá, el que presta
la GPU.

**Cuánto. Decisión: 100.000 tokens de salida cada 24 h, por par.** Son ~200
turnos de chat por día: alcanza para probar la red en serio y para uso personal
liviano, y no alcanza para montar un producto encima sin pagar. Es el punto
donde el free tier capta sin regalar el negocio que D22 quiere cobrar.

**Ventana deslizante, no calendario.** Un corte a medianoche crea un pico de
tráfico a las 00:01 y castiga al que empezó 23:50.

**Al agotarse, degrada — no niega.** El consumidor recibe el error ANTES del
primer chunk, así que D4 aplica: reintenta en otro candidato, y si no hay
ninguno cae al modelo local, que es gratis. Mismo criterio que la Fase 6.5.

**Lo que queda afuera a propósito:** que cada proveedor declare su cuota en el
manifiesto. Sería lo más coherente con el marketplace, pero `economic` está
congelado con `additionalProperties: false` y agregarle un campo obliga a subir
`schemaVersion` (que es el camino sancionado por el propio schema, no un
atajo). Se hace cuando haya un segundo implementador que necesite leerlo;
hasta entonces la cuota es una constante del proveedor y está dicho acá.

**Impacto si no se decide:** se implementa en el gateway porque es más fácil, y
la cuota es decorativa desde el día uno.

---

### D30. Nunca se estrena en mainnet (operativa)

**Problema.** D15 dejó una nota operativa que decía cómo empezar: _"Plasma no es
una testnet. Se empieza con montos de $0.001 y una wallet con USD 2. El riesgo
está acotado por el monto, no por el entorno."_ Eso es cierto y es insuficiente:
el riesgo acotado por el monto sigue siendo riesgo, y sobre todo **no protege del
modo de falla que apareció de verdad**, que no fue perder plata sino gastarla
para descubrir que el camino no existía. El facilitator hosted de D14 devolvía
500/503 el 2026-08-27; fondear antes de mirarlo habría sido pagar por esa
información.

**Decisión: todo camino que mueva valor se estrena en testnet. Sin excepción.**
Mainnet es la promoción de algo que ya funcionó en otro lado, nunca el lugar
donde se prueba si funciona.

**Las tres consecuencias, porque ninguna es gratis y hay que aceptarlas juntas:**

1. **En Plasma testnet (9746) no hay stablecoin que sirva.** Los faucets dan XPL,
   que es gas nativo y no tiene contrato; el USD₮0 de testnet está "in
   development" y los deployments oficiales de USDT0 no listan ninguna testnet.
   Verificado por cinco vías independientes, incluido un `eth_getCode` contra la
   cadena. **Así que el activo de prueba hay que desplegarlo nosotros**, con el
   XPL del faucet pagando el gas. Es un ERC-20 con EIP-3009, y el criterio de
   aceptación ya está escrito y es ejecutable: `npm run verificar-x402`.
2. **D14(b) deja de ser plan B y pasa a ser obligatorio.** El facilitator hosted
   no soporta 9746 —ni responde—, y menos va a conocer un token nuestro. El
   self-hosted estaba presupuestado en la Fase 10 y en el riesgo #5; se adelanta.
3. **Ese token NO se llama $QVAC**, y no es una cuestión de gusto: D28 decidió
   que el riel de pago es stablecoin y que el token nativo vive en la capa de
   incentivos. Como la atestación de D24 y el recibo de x402 **registran el
   activo**, llamarlo $QVAC escribiría adentro de artefactos firmados la misma
   contradicción que D28 acaba de borrar del pitch. Es un stand-in de stablecoin,
   se llama como tal, y va marcado como prueba donde se vea.

**Lo que esto NO cambia:** D15 sigue eligiendo Plasma, y la dirección de mainnet
quedó verificada contra la cadena (ver 0-quater). Lo que cambia es el orden: se
prueba en 9746 y recién después se toca 9745.

**Impacto si no se decide:** vuelve a pasar lo del 2026-08-27, pero con la wallet
ya fondeada.

---

## 2 · Fases

### Fase 6.5 — Presupuesto, corte y degradación a local (~2 días) ← va primero

> **CERRADA 2026-08-26.** Estuvo congelada unas horas y se descongeló para
> cerrarla entera: B1, B2, B6, B13 y B14.
>
> **B6** tenía el arreglo desde la primera pasada y seguía abierto porque ningún
> test lo distinguía: el que existía usaba el prompt `hola`, donde contar bytes
> y contar caracteres dan el mismo número. Con CJK son 15 tokens contra 4.
>
> **B14** era la condición que D9 declara no negociable y que la Fase 9
> necesitaba: `finish_reason` decía `stop` aunque el nodo hubiera recortado por
> el tope. Ahora lo dice quien generó — el proveedor lo manda en el último
> chunk y `upstream.mjs` lo reporta, igual que ya hacía con `usage`.
>
> **B13** cambia lo que el tope significa. Era por cuenta, y la cuenta es la API
> key; la factura del proveedor, en cambio, es **una sola**. Con N keys
> emitidas el techo real eran N × USD 20. Ahora hay dos topes y un request pasa
> sólo si entra en los dos: las keys quedan como sub-topes del nodo.

**Sí, esto va antes que todo lo demás, y la razón no es económica: es de
seguridad.**

El mecanismo de corte es la misma pieza que aparece cuatro veces en este
documento con nombres distintos: el tope de USD 20 del asistente externo, el
`--budget` del agente de la Fase 11, el límite de tokens por tarea de D20, y el
límite de daño de un agente comprometido de D21. **Construirlo una vez, primero,
hace que todas las fases siguientes lo hereden.** Construirlo al final significa
que cada fase intermedia inventa su propia versión y ninguna es la buena.

Y tiene una propiedad que ninguna otra fase de este roadmap tiene: **no depende
de D11.** Un contador de consumo con corte no necesita wallet, ni cadena, ni que
WDK corra bajo Bare — necesita medición, y la medición ya existe en `pushLog`.
Es la única fase que se puede empezar hoy sin saber el resultado del spike, y
eso la vuelve el mejor primer movimiento aunque x402 después se caiga entero.

**Qué se construye:**

1. **Contador de consumo por cuenta**, del lado que gasta (D18), persistido.
   Toma los `tokens` que el gateway ya cuenta y les aplica el precio de la
   Fase 8 cuando exista; hasta entonces, el precio del asistente externo, que sí
   es un número real y conocido.
2. **Corte duro con degradación, no con error.** Al llegar al tope, la cuenta no
   se rompe: **se cae a inferencia local**, que es gratis y sigue funcionando.
   El usuario pierde la red y el asistente externo, no el producto. Esa es la
   diferencia entre un límite y una baja de servicio.
3. **Estimación previa al gasto.** Antes de mandar un request al asistente
   externo se estima su costo y se compara contra lo que queda. La API tiene un
   endpoint de conteo de tokens para exactamente esto: se cuenta antes, no se
   descubre después.
4. **Reparto de la cuota compartida a fin de mes.** El consumo se atribuye por
   cuenta durante todo el mes; a fin de mes se cobra lo efectivamente consumido,
   **nunca más que el tope**, porque el tope ya cortó en el paso 2.

**DoD:**

- Una cuenta que llega al tope recibe respuestas locales y un aviso claro, no un
  500 ni un cuelgue.
- El panel muestra consumido / disponible / cuánto falta para el corte.
- Bajar el tope a USD 0,10 y correr el agente hasta agotarlo produce un corte
  exacto: **el gasto real nunca supera el tope declarado**, y eso está en un
  test, no en una corrida a mano.
- El reparto de fin de mes suma exactamente el consumo medido — sin redondeos
  que aparezcan de la nada.

**Lo que NO se hace acá:** cobrar. Esta fase mide, atribuye y corta. El cobro es
la Fase 9 y el prepago con firma es la Fase 10.

#### El DoD, cerrado el 2026-08-26 (era deuda abierta)

> **Estado: CERRADA.** Los tres bugs de abajo están arreglados y cada uno tiene
> test de regresión. Lo que sigue se conserva escrito —y no se borra— porque
> explica _por qué_ el mecanismo podía estar bien construido y aun así no
> garantizar nada, que es la lección de la fase.

El mecanismo estaba construido y probado desde el principio: `qvac/budget.mjs` reserva antes de
gastar, escribe la reserva a disco _antes_ de que el request salga, liquida
contra lo real, devuelve la diferencia y cobra enteras las reservas huérfanas de
una corrida anterior. Eso funciona y tiene tests.

**Lo que no se cumple es la línea del DoD que importa:** "el gasto real nunca
supera el tope declarado". Tres bugs, y los tres se cierran acá y no en otra
fase, porque el tope es de esta fase:

- **B1 — el tope se resetea en cada reinicio.** La cuenta a la que se le imputa
  el consumo es la API key ([qvac/gateway.mjs:877](qvac/gateway.mjs#L877)), y
  las API keys viven **sólo en memoria** ([qvac/apikeys.mjs:15](qvac/apikeys.mjs#L15)).
  `budget.json` persiste `accounts[<id>]` fielmente, pero ese id no vuelve nunca
  después de un reinicio: el cliente reconecta, le dan una key nueva, y arranca
  con el tope entero otra vez. El archivo, mientras tanto, acumula cuentas
  huérfanas que nadie va a reclamar. **Un tope que se limpia reiniciando el
  proceso no es un tope: es una sugerencia.** Y no es un bug del ledger — el
  ledger hace bien su parte — es que le falta un sujeto estable.
  **Cerrado:** `qvac/apikeys.mjs` persiste el registro en
  `<storage>/apikeys.json` con escritura atómica y modo `0600`, y `bin.mjs` lo
  abre junto al ledger, antes del gateway. La key se guarda en claro, con el
  mismo criterio que `identity.json` — decisión tomada, no omisión, y anotada en
  el README. De yapa arregla algo que no era un bug declarado pero se sentía
  como uno: cada reinicio invalidaba la config de todos los clientes.
  _Test:_ «agotado el tope, reiniciar el nodo NO lo repone».
- **B2 — se liquida con un número que no son tokens.** Cuando el proveedor
  externo no manda `usage`, la liquidación usa `promptTokens: 0` y toma como
  tokens de salida el contador de **deltas SSE** de
  [qvac/gateway.mjs:1161](qvac/gateway.mjs#L1161). Un delta no es un token, y la
  entrada cobrada a cero es la mitad de la factura. Que el proveedor mande
  `usage` depende hoy de que el operador haya escrito
  `stream_options.include_usage` en su `upstreams.json` — un campo de un archivo
  que se puede olvidar, y que si se olvida no avisa nada.
  **Cerrado:** el cuerpo del pedido lo arma el nodo y `stream_options.include_usage`
  lo impone el código, no la config (eso cerró B4 de paso). Y si aun así el
  proveedor no manda `usage`, se liquida por la **reserva entera** —la cota
  superior con la que se autorizó el gasto— y se avisa por consola. Se equivoca
  para arriba, que es el único lado que no se pasa del tope.
  _Test:_ «un proveedor que no manda usage se liquida por la reserva, no por los
  deltas» — con el bug puesto daban 4 micro-dólares donde van 514.
- **B6 — la cota superior del prompt no es una cota superior.**
  `estimarPromptTokens` divide caracteres por 3 y se documenta como cota
  superior ([qvac/gateway.mjs:466](qvac/gateway.mjs#L466)). En CJK y en varios
  alfabetos no latinos la relación se acerca a 1 token por carácter, así que la
  reserva queda por debajo del gasto justo donde el comentario promete lo
  contrario.
  **Cerrado:** se cuentan bytes UTF-8 en vez de caracteres, con el mismo
  divisor. Y el comentario dejó de afirmar que es una cota superior demostrable,
  porque no lo es: es una estimación conservadora, y ahora lo dice.

**Criterio de cierre, y es el que ya pedía el DoD:** bajar el tope a USD 0,10,
agotarlo, **reiniciar el nodo** y verificar que sigue cortado. Ese reinicio no
estaba en el DoD original y es la única forma de que B1 no vuelva. Está en
`test/index.js` y pasa.

---

### Fase 6.6 — La cuota gratuita, del lado del proveedor (~1 día)

> **Estado 2026-08-26: CERRADA.** `qvac/quota.mjs` con ventana deslizante por
> hora, rechazo antes del primer chunk, cuotas independientes por par y el
> medidor en el panel de `/node`. Es el módulo con más cobertura del repo. No
> persiste entre reinicios, y eso está declarado en el README.

Implementa D23. Va acá y no más adelante por dos razones: comparte la forma con
la Fase 6.5 —un medidor con límite y degradación— y **no depende de D11**, así
que sigue siendo trabajo útil mientras el spike de la wallet no cierre.

**Dónde entra, exactamente:** [qvac/provider.mjs:167](qvac/provider.mjs#L167) ya
rechaza por capacidad antes del primer chunk, con el comentario que explica por
qué se rechaza en vez de encolar. La cuota es un segundo chequeo con la misma
forma, dos líneas más abajo. No hay que inventar un punto de control: ya existe.

**Qué se construye:**

1. **Medidor por clave de par, con ventana deslizante de 24 h.** Vive en el
   proveedor, no en el gateway.
2. **Rechazo antes del primer chunk**, con `code` propio, para que D4 reintente
   en otro candidato en vez de cortarle el stream al cliente.
3. **Se cuentan los tokens de SALIDA**, que son los que cuestan GPU. La entrada
   se procesa una vez y es barata; contarla complicaría el número sin cambiar
   quién paga qué.

**DoD:**

- Un par que agota la cuota recibe `quota_exceeded` y el consumidor cae a otro
  candidato o al modelo local, sin cortar un stream empezado.
- La cuota se repone sola con el correr de las horas, sin reiniciar el nodo:
  eso está en un test con reloj inyectado, no en una espera de 24 h.
- Dos pares distintos tienen cuotas independientes: agotar una no toca la otra.
- El panel del proveedor muestra cuánto regaló y a quién.

---

### Fase 7 — Desmockear `economic` (~1 día)

> **Estado 2026-08-26: CERRADA.** El manifiesto firmado lleva la dirección de
> cobro real que genera WDK, en `plasma`/`stable`. D13 implementado con seed
> propia —nunca derivada de la de red— cifrada con Argon2id + secretbox de
> sodium. Desbloquea 9, 10 y 11.
>
> **Lo que el spike encontró y cambió el plan:** WDK no acepta la seed de 32
> bytes que `identity.mjs` ya sabe generar —exige mnemonic BIP-39— y no trae con
> qué generarlo **ni dónde guardarlo**: `@tetherto/wdk-wallet` exporta errores e
> interfaces, no custodia. O sea que la mitad de D13 que decía _"o delegada al
> secret manager de WDK"_ no existe, y quedó la otra. Medido en
> `scripts/spike-d13-wallet-bare.mjs`, que se repite cuando WDK suba de versión
> (está en beta).
>
> **El límite honesto de la custodia, que hay que leer antes de fondear nada:**
> la passphrase sale de `PYRUS_WALLET_PASSPHRASE`, típicamente en el `.env`. Si
> ese `.env` vive al lado del keystore, el cifrado protege de un backup, de un
> repo y de un `pear stage` —**no** de alguien que ya tiene acceso a esa
> máquina. Se eligió a ojos abiertos: pedirla por consola en cada arranque rompe
> el arranque desatendido y la promesa de "doble clic y abre en el navegador".
> Queda escrito en `wallet.mjs`, en `.env.example` y en el propio comando.

Wallet real generada por WDK, `walletAddress` dentro del manifiesto **firmado**,
el `_mock` afuera, y `/node` mostrando la dirección de cobro del propio nodo.

**No se cobra nada todavía.** Esta fase solo hace que el manifiesto diga la
verdad.

**DoD — los cuatro puntos, y con qué se verificó cada uno:**

- ~~Dos nodos anuncian direcciones distintas y un par remoto verifica la firma.~~
  Test: además de las direcciones distintas, cambiarle la wallet a un manifiesto
  firmado lo **invalida** — que es la propiedad que impide reenviar el
  manifiesto de otro con la wallet propia adentro.
- ~~El manifiesto valida contra `manifest-v0.json` **sin tocar el schema**.~~
  Y ahora eso lo **comprueba un test**, leyendo las restricciones del archivo.
  Hasta acá no lo comprobaba nadie: `grep manifest-v0` sobre el árbol devolvía
  comentarios y nada más. Ver **B19**, que apareció justo por mirarlo.
- ~~El README pierde la línea que dice que `economic` es mock.~~ Reemplazada, no
  borrada: dice qué pasa con wallet y qué pasa sin ella.
- ~~D13 está implementado: la seed de la wallet no está en claro.~~ El test
  busca **palabra por palabra** de la frase dentro del keystore, y verifica que
  la dirección tampoco se guarde.

**Lo que esta fase NO hace, y conviene no confundir:** no se cobra nada. El
manifiesto ya dice a quién pagarle; pagarle es la Fase 9.

---

### Fase 8 — Precio comparable y precio que rutea (~1 día)

El precio deja de ser una constante igual en todos los nodos. Se deriva del
benchmark real que [qvac/provider.mjs:243](qvac/provider.mjs#L243) ya calcula
(tokens/s, TTFT) y entra al ruteo junto con la carga, cerrando D6 del roadmap
anterior, que sigue pendiente.

**DoD:**

- `Auto` elige por precio y latencia, y el log de ruteo **dice por qué** — no
  "primero de N candidatos".
- El chat muestra el costo estimado de cada respuesta.
- El README pierde las dos líneas de "el precio no es comparable" y "elegir nodo
  por carga no está implementado".

**Esta fase vale sola.** Si x402 se cae entero por D11, la 7 y la 8 siguen
siendo trabajo bueno que cierra deudas declaradas.

#### Estado 2026-08-26: CERRADA

La primera mitad ya estaba y estaba bien: `qvac/routing.mjs` como decisión pura
y testeable, orden por carga real, penalización al que falla y al lento, mocks
del modo `--demo` siempre detrás de cualquier candidato real, y el log diciendo
por qué. **D6 cerrado.**

La segunda entró ahora. **El precio que rutea es el del ledger, en
micro-dólares**, y por eso es comparable entre clases distintas de candidato:
para un asistente externo es el que declaró el operador en su config, y para un
par o el motor local es **cero** — que no es un placeholder sino la verdad de
hoy, porque el pago P2P es la Fase 9.

Va en el **paso 4** del orden, y las dos fronteras son el contenido de la fase:

- **Después de la carga**, porque la opción barata que está llena no es barata:
  la respuesta que no llega no es más económica, es ninguna.
- **Antes del histórico y de la latencia**, que es lo que pide el DoD. Cuesta
  menos de lo que parece: hoy esa comparación sólo separa gratis de pago, y
  entre pares —donde el histórico importa— siguen empatados y decide él.

Y reemplaza un accidente por un criterio: que "la de casa le gane a la que
cobra" ya pasaba, pero lo producía el desempate por `kind` del paso 7, que el
propio archivo declara _"preferencia del modo demo, ya no criterio"_.

**Dos cosas aparecieron al escribirlo, y las dos eran del código nuevo.**
`motivoDe` afirmaba "más barato" comparando con `!==`, o sea **asumiendo** que
el sort ya había ordenado por precio: al desactivar el criterio para verificar
que los tests lo cazaran, el log seguía diciendo "más barato" y nombraba como
ganador al más caro. Y el costo en el chat salía con cuatro decimales, así que
un turno de menos de 50 micros se mostraba `USD 0.0000` — idéntico a gratis, que
es la única distinción que esa línea existe para hacer.

**Lo que sigue sin ser cierto**, para que nadie lo lea de más: el string
`pricing` del manifiesto ("0.002 QVAC / 1K tok") sigue siendo decorativo y no
participa de ninguna decisión. Lo que rutea es el ledger, no el manifiesto.

---

### Fase 8.5 — El asistente externo como un candidato más (~1 día)

Con la Fase 8 hecha, el ruteo ya elige por precio y carga. Entonces el asistente
externo **no necesita un camino especial: es un candidato más**, con un precio
conocido (D19), capacidad prácticamente infinita, y tres condiciones de
elegibilidad en vez de una (D19: sin capacidad local, opt-in, y presupuesto).

Eso es lo que hace que esta fase sea chica. Todo lo que necesita ya existe:
`node:status` dice si los pares están saturados, el ruteo sabe comparar precios,
los headers de procedencia saben decir quién contestó, `local: true` ya sabe
excluir candidatos, y la Fase 6.5 ya sabe cortar.

**DoD:**

- Con la red saturada y el opt-in activado, el request se va al externo y la
  respuesta **dice que fue al externo** en los headers y en el chat.
- Con el opt-in apagado: 503 con el motivo, o local. Nunca el externo.
- Con el presupuesto agotado: local, con aviso. Nunca el externo.
- `local: true` nunca sale de la máquina, con o sin opt-in.
- El README dice, en la sección de "qué es simulado" o en la que la reemplace,
  que este camino manda el prompt a un tercero — la promesa de privacidad se
  acota ahí, no en una nota al pie.

#### Estado 2026-08-26: CERRADA

La tesis de la fase se sostuvo en la práctica, y vale dejarlo escrito porque era
la apuesta: el upstream entró como **una fila más** del registro (`kind:
'upstream'`) y `/v1/models`, `/v1/nodes`, `findAllByModelId`, `pickCandidate`,
el log de ruteo y los headers de procedencia empezaron a funcionar **sin una
línea especial en el despacho**. Los cuatro puntos del DoD tienen test de
integración contra un proveedor falso desde `e753e0a`, y la línea del README
—que es donde se acota la promesa de privacidad— está escrita.

**El DoD está completo.** El interruptor del opt-in vive en `/node`, con los
otros dos medidores, y se verificó en el navegador contra un nodo real con dos
upstreams: renderiza sin errores de consola, el click pega en el endpoint, el
server lo registra en su log y la tarjeta cambia de estado y de color.

**Los bugs de esta fase, cerrados:**

- **B3 — no hay timeout ni cancelación en el camino externo.** `completar()`
  acepta un `signal` y el gateway nunca se lo pasa
  ([qvac/gateway.mjs:1148](qvac/gateway.mjs#L1148)). El `req.on('close')` que
  cancela cuando el cliente cierra la pestaña existe **sólo en la rama P2P**
  ([qvac/gateway.mjs:670](qvac/gateway.mjs#L670)), con el comentario que explica
  que dejar al par generando para nadie es CPU que alguien paga. El argumento
  vale más todavía del otro lado: acá lo que sigue corriendo son dólares de la
  cuenta del operador. Y un proveedor que se cuelga sin cerrar el socket deja el
  request abierto y **la reserva comprometida para siempre**.
  **Cerrado:** el gateway arma un `AbortController` y lo ata al cierre del
  cliente; `completar()` suma dos relojes propios —60s al primer byte, 30s de
  silencio entre tokens, los dos configurables— y un corte propio no se
  reintenta. El test cuelga al proveedor y verifica las cuatro cosas que antes
  quedaban colgadas con él: el request termina, la reserva se libera, el slot
  del nodo se libera y no se cobra nada. De ahí salió una regla que faltaba: un
  request que muere **sin un solo token** liquida cero, porque cobrar la cota
  superior ahí sería cobrar un request que no ocurrió.
- **B4 — `extraBody` puede pisar el tope de salida.** Se esparce después de
  `max_tokens` y de `stream` en el cuerpo del pedido
  ([qvac/upstream.mjs:130](qvac/upstream.mjs#L130)). El único número que acota la
  reserva es sobre-escribible desde un archivo de config, y un `stream: false`
  puesto ahí rompe el parser de SSE sin decir por qué.
- **B7 — `GET /v1/upstream` no pide credencial**
  ([qvac/gateway.mjs:1457](qvac/gateway.mjs#L1457)). El POST sí. La respuesta no
  lleva secretos, pero sí el proveedor, los modelos, los nombres de las
  variables de entorno y si hay credencial cargada.
  **Cerrado:** la lectura pide credencial igual que el POST, y el test verifica
  las dos mitades — que sin key da 401, y que con key el secreto sigue sin
  aparecer en ningún lado de la respuesta.
- **B5 — el reintento sin idempotencia ya está en producción.** Tres intentos
  con backoff sobre un POST de streaming
  ([qvac/upstream.mjs:115](qvac/upstream.mjs#L115)). Es el Riesgo 10 de este
  documento, cuya mitigación (el `nonce` de D20) está agendada para la Fase 11.
  **Acotado, no cerrado.** Un corte propio —cliente ido, timeout— ya no se
  reintenta, y el reintento solo ocurre antes de leer una sola respuesta. Queda
  el caso real: si la conexión se cae _después_ de que el proveedor empezó a
  generar, `fetch` rechaza y se reintenta mientras el primer intento se sigue
  facturando. Eso no se arregla con un `if`: se arregla con el `nonce` de D20, y
  el dueño es la Fase 11.

---

### Fase 9 — x402 en el borde (~2-3 días) ← el hito técnico

> **CERRADA el 2026-08-27**, con el tx hash del explorer **declarado afuera** y no
> dado por bueno. El estado ítem por ítem y el camino de ese ítem están en
> **§ 0-quater**; el orden testnet-primero que lo condiciona, en **D30**. Se le
> sumaron D24, D25 y D27 —que son de
> [ROADMAP_REVISION-EVIDENCIA.md](ROADMAP_REVISION-EVIDENCIA.md)— y apareció
> **B20** en el camino: el tope de tokens que el 402 declaraba y no aplicaba
> nadie.

`402 Payment Required` sobre `/v1/chat/completions`, con el `accepts[]` armado
desde el manifiesto firmado del nodo elegido (D10), `X-PAYMENT` verificado
contra el facilitator antes de gastar GPU, y settlement posterior a la respuesta
(D12).

**DoD:**

- Un `curl` sin pago recibe un 402 legible que dice cuánto, a quién, en qué
  cadena y **hasta cuántos tokens** (D9). ✅ — y el tope que declara ahora
  además **se aplica**, que es la mitad que faltaba (B20).
- El mismo request con `@x402/fetch` devuelve tokens y un tx hash **visible en
  el explorer de Plasma**. Los tokens ✅; el **tx hash ❌ NO VERIFICADO** — hace
  falta fondear (D13 dice que no) _y_ verificar la dirección del contrato de
  Plasma. Lo que devuelven los tests es el hash de un facilitator falso.
- Matar el nodo a mitad de stream no cobra: la verificación protege al
  proveedor, la falta de settlement protege al cliente. ✅ contra un **par**;
  para un upstream HTTP **no se cumple hoy** — ver B21, abierto.

**Los dos ítems que le agregó la revisión por evidencia:**

- El recibo de D12 lleva además la **atestación del proveedor** (**D24**),
  firmada con la wallet. En esta fase sólo se emite y se guarda: no la consume
  nadie hasta la Fase 10, y es deliberado — hacia atrás no se firma.
- `pushLog` registra **prefill y decode por separado** (**D25**), con un campo
  que dice si el número fue medido por el proveedor o estimado de este lado.
  **D22 sin tocar**: esto registra, no tarifa.

**Y el que no estaba escrito en ninguna fase:** **D27**, los tres casos de corte
—cliente, proveedor, tope— decididos por quién cortó. Los tres con test.

---

### Fase 10 — Recibos y liquidación en lote (~2 días)

> **PARCIAL — hecha la primera mitad el 2026-08-28. Ver § 0-sexies.** Está el
> formato del recibo y del lote (`qvac/lote.mjs`), la firma del lote con la
> wallet, la acumulación en el gateway de lo que sirvió **este** nodo, la
> liquidación diferida local (`liquidarLote` = `x402.liquidar` por recibo) y
> `npm run verificar-lote`. **Falta:** el disparador que vacía el lote solo, y la
> otra mitad — que la atestación **del par** viaje por Protomux, firmada por él.
> Hoy este gateway no firma nada de lo que sirvió otro, y lo dice en el recibo.
> Reabrió y recerró la Fase 9 por la entrada `plasma-testnet` de `x402.mjs`.
> Ver también **D27**, que decide qué se firma cuando el stream muere a la mitad,
> y **D29**, que decide que la verificación es optimista y sin comité.

El recibo firmado por la wallet (no por la clave de red) viaja por Protomux al
proveedor, que los acumula. Cierra `settlement: 'batch-receipts'`, que el schema
declara desde el día uno.

**El insight que hace que esto sea barato:** la firma EIP-3009 **ya es el
recibo**. Es una autorización firmada off-chain que no obliga a liquidar en el
momento. Verificar sincrónico → servir → liquidar en lote es el mismo flujo de
la Fase 9 con el settlement diferido, no un mecanismo nuevo.

**Y esto es lo que mata la Fase 6:** con liquidación on-chain no hace falta un
ledger multi-escritor propio. Autobase sale del roadmap. Es alcance que se
borra, no que se agrega.

---

### Fase 11 — La capa agéntica que paga (~2-3 días) ← el pitch

Se rescata [old/PROMPT_CAPA-AGENTICA_DESCARTADO.md](old/PROMPT_CAPA-AGENTICA_DESCARTADO.md)
tal como está —agente documental, extracción validada con zod, confianza por
campo, `needs_review` explícito, `eval` publicando los fallos— y se le suma lo
que antes no podía tener: **presupuesto**.

```
pyrusllm agent ./facturas --budget 0.50
```

Gasta USD₮ real contra nodos que nunca vio, y el audit trail dice cuánto costó
cada campo extraído y qué máquina lo cobró.

Acá se juntan las dos mitades del proyecto: **un agente autónomo que compra
inferencia de proveedores desconocidos, sin registrarse en ninguno, pagando por
HTTP.** El agente no necesita correr bajo Bare —habla el protocolo de OpenAI
como cualquier cliente—, así que esta fase no toca el pipeline de distribución.

**El harness, que es la mitad del trabajo de esta fase** (D20). No es una capa
de prolijidad alrededor del agente: es lo que hace que un agente con wallet sea
operable.

| Control                 | Valor de arranque                                                           | Qué pasa al cruzarlo                                        |
| ----------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pasos por documento     | acotado y explícito                                                         | corta, marca `needs_review`, sigue con el próximo documento |
| Tokens por tarea        | derivado del presupuesto restante                                           | corta antes de gastar, no después                           |
| Timeout por herramienta | menor que el de la tarea                                                    | falla esa herramienta, no la tarea                          |
| Reintentos              | backoff exponencial con jitter, solo transitorios                           | tras el último intento, falla explícita en el audit trail   |
| Idempotencia            | `nonce` del pago para lo cobrable; hash del documento + campo para lo demás | el reintento no duplica ni el cobro ni la escritura         |

**DoD:**

- El agente se queda sin presupuesto a mitad de un lote y **para**, diciendo
  cuánto procesó y cuánto le faltó. Un agente que se pasa del presupuesto es
  peor que uno que no arranca.
- Matar la red a mitad de un lote y reanudar **no vuelve a cobrar** los
  documentos ya pagados. Esto se prueba, no se razona: es el DoD que justifica
  toda la columna de idempotencia.
- Cada campo extraído tiene, en el audit trail, la evidencia que lo originó, qué
  nodo respondió, qué decisión de ruteo se tomó y **cuánto costó**.

---

### Fase 11.5 — Evaluación adversarial (~1-2 días) ← no es opcional

Implementa D21. Va pegada a la Fase 11 y no después de la 12, porque un agente
con wallet y entradas de origen desconocido sin esta fase es exactamente el
problema que D21 describe.

**Qué se construye:**

1. **Fixtures envenenados** junto a los fixtures sucios que la Parte D ya pedía:
   instrucciones embebidas en el cuerpo, en metadatos, en texto invisible, y en
   la salida del OCR.
2. **Las cuatro métricas de D21** —obediencia a la inyección, violación de
   herramientas, exfiltración, gasto no autorizado— corriendo en el mismo
   comando `eval` que ya mide acierto por campo.
3. **Los tres controles duros** de D21: el presupuesto como límite de daño,
   `security.allowedTools` dejando de estar vacío, y el contenido del documento
   entrando siempre como dato y nunca como instrucción.
4. **Los tres campos nuevos del audit trail:** cadena de entrada completa,
   herramienta elegida con sus argumentos, y salida.

**DoD — y es el mismo criterio que el proyecto ya aplica a la tasa de acierto:**
las cuatro métricas se publican en el README **incluyendo los casos donde el
agente falla**. Un README que dice "la tasa de obediencia a inyección es 4% y
estos son los tres fixtures que la logran" vale más que uno que no mide. La
alternativa —no medirlo— no es "cero por ciento": es no saber.

---

### Fase 12 — MCP toolkit (~1-2 días, opcional)

`@tetherto/wdk-mcp-toolkit` expone la wallet del nodo como herramientas MCP
(balance, send, swap) con elicitations para aprobación humana explícita antes de
cualquier broadcast. Encaja con `security.toolCallPolicy` del manifiesto, que
hoy está en `allowlist` con la lista vacía.

Es upside, no criterio. Se corta primero si aprieta el reloj.

---

## 3 · Track V — VELA / Horizen (paralelo, no camino crítico)

### Por qué VELA no puede tocar la inferencia

VELA es WASM dentro de **AWS Nitro Enclaves**. Tres problemas, en orden de
gravedad:

1. **Contradice la tesis.** El README promete _"un marketplace de inferencia sin
   datacenter en el medio"_. Meter el cómputo en un enclave de Amazon es poner
   el datacenter en el medio. Quien lea las dos cosas juntas lo nota.
2. **No hay GPU ni forma de cargar los pesos.** Nitro Enclaves no tiene
   aceleración, y QVAC/`llama-cpp` es nativo, no WASM. Portar el motor a WASM
   attestado no es integrar: es otro proyecto.
3. **No hay streaming.** VELA es `request → cola en Entrypoint → ejecuta →
attestation → Exitpoint`: un ciclo on-chain por job. El producto vende TTFT y
   SSE.

[deck/Enclave.dc.html](deck/Enclave.dc.html) ya lo dice mejor: _"matching… sits
on the latency critical path. A round trip to the enclave per request may simply
not be viable."_

### Dónde VELA sí vale

El agujero real de la arquitectura no es la inferencia: es **quién computa
cuánto se le debe a cada proveedor sin ver todo**. Hoy ese lugar está vacío, y
la Fase 6 fue el intento de llenarlo. Un nodo que reporta 900 tokens cuando
sirvió 400 no tiene hoy quién lo contradiga — `recordPeerResult` en
[qvac/store.mjs:469](qvac/store.mjs#L469) le cree.

Los tres jobs que van adentro son deterministas y asíncronos, o sea que caben en
la forma nativa de VELA (_"the WASM-job-with-onchain-settlement shape"_, según
el propio deck):

| Job            | Qué resuelve                                                              | Reemplaza a           |
| -------------- | ------------------------------------------------------------------------- | --------------------- |
| **metering**   | recomputa el consumo desde el transcripto, no desde lo que el nodo afirma | nada — hoy no existe  |
| **settlement** | agrega recibos por proveedor y liquida en lote                            | Fase 6 / Autobase     |
| **reputation** | puntaje desde recibos firmados y spot-checks aleatorios                   | el mock de reputación |

### Fases del track

| #      | Qué                                                                                                                                                                                                                                                                       | Depende de                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **V1** | **Aplicación a Horizen con el deck como está.** Las slides 05 y 06 ya plantean el problema y proponen la clave efímera por request, marcado como _"the open question we bring, not a promise"_. Esa postura es la correcta y **no necesita código de VELA para aplicar**. | nada — ya está escrito        |
| **V2** | Metering en enclave: recomputar el consumo desde el transcripto                                                                                                                                                                                                           | Fase 10 + acceso a VELA + D17 |
| **V3** | Settlement y reputación en enclave                                                                                                                                                                                                                                        | V2                            |

**La acción que bloquea todo lo demás:** VELA está en closed beta y se entra por
formulario de early access. Es la única parte del calendario que **no depende
del equipo**. Se aplica primero y se sigue con las Fases 7–9 mientras tanto —
V2 y V3 no arrancan sin esa aprobación, y las fases del camino crítico no la
necesitan.

---

## 4 · x402 frente a "solo carga de crédito"

Queda escrito acá porque es la pregunta que va a volver.

Lo que decide el asunto es **quién paga**:

- Un **humano** carga crédito: abre una pantalla, conecta una wallet, aprueba.
  Eso no necesita x402.
- Un **agente** no puede hacer nada de eso. No tiene pantalla, ni cuenta, ni con
  quién registrarse.

Y el punto que cierra la discusión: **la red es de proveedores desconocidos.**
El descubrimiento es P2P y cualquiera entra al swarm mañana. Si la única forma
de pagar es cargar crédito, hay que cargar crédito **con cada nodo nuevo que
aparece** — o poner a alguien que agregue el saldo de todos. Ese alguien es
exactamente el intermediario que el README dice que no existe. **No hay tercera
opción.**

Las dos cosas terminan siendo la misma pieza en dos escalas:

| Caso                          | Mecanismo                                                       | Qué es en el stack |
| ----------------------------- | --------------------------------------------------------------- | ------------------ |
| Cliente ocasional, un request | x402 `exact`, se liquida                                        | la puerta          |
| Agente, 200 requests          | una autorización firmada mayor = **el crédito**, medido por uso | el pasillo         |

La carga de crédito es correcta, y se **funda con una firma x402** en vez de con
un registro. Eso es lo que la mantiene sin intermediario.

**Sobre "no inventemos nada":** x402 **es** el camino oficial de WDK
(`docs.wdk.tether.io/ai/x402/`, sobre `@tetherto/wdk-wallet-evm`). Un flujo de
cobro propio sería el invento.

---

## 5 · Riesgos

| #   | Riesgo                                                                                                                     | Cómo se mide                                                                                              | Plan B                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~WDK/x402 no corre bajo Bare~~ **CERRADO 2026-08-25**                                                                     | El spike de D11 pasó los cuatro pasos, con firma idéntica a Node                                          | — ya no hace falta                                                                                                                                                                            |
| 2   | **Plata real en mainnet** (Plasma no es testnet)                                                                           | Montos de $0.001 y una wallet con USD 2                                                                   | Facilitator self-hosted contra una EVM testnet con USD₮0                                                                                                                                      |
| 3   | El settle falla **después** de que el nodo ya gastó GPU                                                                    | Contar fallos de settle en el log de ruteo                                                                | Verificación estricta previa + montos chicos; la reputación por par ya existe en `recordPeerResult`                                                                                           |
| 4   | La seed de la wallet queda en claro como la de red                                                                         | Revisión de D13 antes de fondear nada                                                                     | No fondear hasta que esté cifrada. No es negociable                                                                                                                                           |
| 5   | Dependencia de un facilitator de terceros que Tether **no** respalda                                                       | —                                                                                                         | Self-hosted, ya presupuestado en la Fase 10                                                                                                                                                   |
| 6   | VELA no da early access, o lo da tarde                                                                                     | Aplicar primero y seguir sin esperar                                                                      | El Track V es paralelo justamente por esto: nada del camino crítico lo espera                                                                                                                 |
| 7   | **El operador adelanta el costo externo en fiat y cobra en USD₮** — riesgo de crédito y de cambio (R5.1)                   | Diferencia entre lo consumido y lo cobrado, por mes                                                       | El corte de la Fase 6.5 acota la exposición máxima a USD 20 por cuenta. Si no alcanza, pasar a (a) de D18: cobrado antes de gastar                                                            |
| 8   | **El precio intro de Sonnet 5 vence el 31-ago-2026** y el costo por turno sube 50% solo                                    | Está en el calendario, no hay que medirlo                                                                 | Calibrar la aritmética del tope con el precio estándar desde el día uno, no con el intro                                                                                                      |
| 9   | **Inyección de prompt** en documentos de origen externo                                                                    | Las cuatro métricas de la Fase 11.5                                                                       | Los tres controles duros de D21. El presupuesto acota el daño aunque la inyección funcione                                                                                                    |
| 10  | Un reintento cobra dos veces                                                                                               | Contar liquidaciones por `nonce` repetido en el log                                                       | La idempotencia de D20. Es la razón por la que el backoff no se implementa antes que ella. **2026-08-26: el backoff se implementó igual, antes que la idempotencia (B5). Acotarlo en la 8.5** |
| 11  | **El tope no sobrevive a un reinicio** (B1): la cuenta es la API key y las keys son de memoria                             | Agotar el tope, reiniciar, pedir de nuevo. Hoy pasa                                                       | Persistir la identidad de cuenta. Es el punto 1 del orden de la sección 0-ter y no se avanza sin él                                                                                           |
| 12  | **La liquidación del externo se cae a un contador de deltas** si el proveedor no manda `usage` (B2)                        | Correr un upstream sin `include_usage` y comparar el `costMicros` del log contra la factura del proveedor | Imponerlo desde el código y hacer ruidoso el `usage` ausente                                                                                                                                  |
| 13  | **Un request al externo sin timeout** deja la reserva comprometida y el gasto corriendo aunque el cliente se haya ido (B3) | Cerrar la pestaña a mitad de stream y mirar `reserved` en `/v1/budget`                                    | Pasar el `signal` que `completar()` ya acepta, y armar el mismo `req.on('close')` que ya tiene la rama P2P                                                                                    |

---

## 6 · Lo que sale del alcance

- **Autobase / ledger multi-escritor propio.** La Fase 10 lo vuelve innecesario:
  la liquidación es on-chain. Es la mejor noticia de este análisis — alcance que
  se borra.
- **Cobrar por `/v1/files/fetch`.** Es el mismo mecanismo pero duplica la
  superficie de prueba sin agregar nada al pitch. Después de la Fase 12, si
  acaso.
- **Inferencia dentro del enclave.** Por las tres razones de la sección 3.
- **Postpago con tope aplicado al facturar.** Descartado en D18: no es un tope,
  es un descuento sobre un gasto que ya ocurrió.
- **El asistente externo sin opt-in.** Descartado en D19. No hay una versión
  "por default está prendido porque mejora la experiencia": el prompt sale de la
  red y eso lo decide el dueño del prompt.

---

## 7 · Tabla resumen — orden de ejecución

Esta tabla es el plan **original**. Se conserva porque el orden que propone
sigue siendo el correcto; lo que cambió es dónde estamos parados dentro de él.
El estado real y el orden que se ejecuta desde el 2026-08-26 están en la
sección 0-ter, y manda esa. El estado de la Fase 9 en particular está en
**0-quater**, que es la que manda sobre esa fila.

| Orden | Qué                                             | Estado                                                                                       | Por qué ahí                                                                                                                                               |
| ----- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | **Aplicar al early access de VELA**             | pendiente                                                                                    | Es lo único que no controlamos. Se dispara y se sigue trabajando                                                                                          |
| 1     | **Fase 6.5 — presupuesto, corte y degradación** | **CERRADA 2026-08-26**                                                                       | **La única fase que no depende de D11.** Todo lo demás la hereda: el tope, el `--budget`, el límite de tokens y el límite de daño son la misma pieza      |
| 1'    | ~~Spike de D11~~ **HECHO**                      | cerrado                                                                                      | Pasó: WDK y x402 corren directo bajo Bare, con firma idéntica a Node                                                                                      |
| 1''   | Fase 6.6 — cuota gratuita del proveedor         | **cerrada**                                                                                  | Misma forma que la 6.5 y tampoco depende de D11. El punto de control ya existe en provider.mjs                                                            |
| 2     | Fase 7 — desmockear `economic` (incluye D13)    | **CERRADA 2026-08-26** · reabierta y re-cerrada 2026-08-27 por D30.1/D30.2 — ver 0-quinquies | Precondición de todo cobro. Desbloquea 9, 10 y 11                                                                                                         |
| 3     | Fase 8 — precio comparable y que rutea          | **CERRADA 2026-08-26**                                                                       | Vale sola aunque x402 se caiga                                                                                                                            |
| 4     | Fase 8.5 — el asistente externo como candidato  | **CERRADA 2026-08-26** (B3, B4, B7, y después B11, B12, B15, B16)                            | Chica, porque la 8 ya dejó el ruteo listo                                                                                                                 |
| 5     | Fase 9 — x402 en el borde                       | **CERRADA 2026-08-27**, con el tx hash afuera — ver 0-quater; reabierta y recerrada 2026-08-28 por la entrada `plasma-testnet` de la Fase 10 | El hito técnico. D9 exige `finish_reason: length` al recortar: eso es B14 (que lo REPORTA) más B20 (que hace que el recorte exista). Lleva D24, D25 y D27 |
| 5'    | **Bloque 0 de D30 — las precondiciones**        | **HECHO 2026-08-27** — ver 0-quinquies                                                       | Sin esto la 10 se escribe pero no se demuestra: no había activo, ni facilitator para 9746, ni forma de que el nodo firmara para otra red que mainnet      |
| 6     | Fase 10 — recibos y lote                        | **PARCIAL 2026-08-28** — formato, lote local, firma y liquidación diferida; ver 0-sexies     | Mata la Fase 6. Falta el flush automático y la atestación del par por Protomux                                                                            |
| 7     | Fase 11 — capa agéntica con harness             | **desbloqueada** (la 7 cerró)                                                                | El pitch                                                                                                                                                  |
| 8     | Fase 11.5 — evaluación adversarial              | no empezada                                                                                  | Pegada a la 11. No es opcional                                                                                                                            |
| 9     | Fase 12 — MCP toolkit                           | no empezada                                                                                  | Upside; se corta primero                                                                                                                                  |
| —     | V2/V3 — enclave                                 | no empezada                                                                                  | Cuando haya acceso y D17 esté cerrada                                                                                                                     |

**Trabajo que quedó fuera de toda fase y que hay que ubicar en alguna:** los 574
LOC de RAG que no importa nadie (B8), el instalador sin verificación de
integridad (B9) y la ausencia de CI (B10). Ninguno bloquea el camino crítico;
los tres son deuda que crece sola. B10 duele más desde el 2026-08-27: ahora hay
un `npm run bug-puesto` que sólo corre si alguien se acuerda de correrlo.

**Y dos decisiones abiertas que no son de ninguna fase nueva sino de dos que ya
están cerradas:** B21 (reabre la 8.5) y B22 (toca una entrada de la 8). Las dos
salieron de la Fase 9 y las dos son del dueño.

### Decisiones a cerrar

Todas son del dueño del proyecto, no de un agente (ver la regla de delegación
arriba). La columna **Tipo** dice por qué.

| #   | Decisión                                                                                                                      | Tipo                       | Bloquea             |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------- |
| D8  | El 402 vive en el gateway, no en el nodo                                                                                      | arquitectura               | Fase 9              |
| D9  | `exact` con tope declarado (Fase 9) → prepago (Fase 10); `finish_reason: length` si se recorta                                | negocio                    | Fase 9              |
| D10 | `payTo` directo a la wallet del proveedor, tomada del manifiesto firmado                                                      | negocio                    | Fase 9              |
| D11 | ~~Runtime de la wallet~~ **CERRADA**: `wdk-wallet-evm` directo bajo Bare                                                      | arquitectura               | — (desbloqueó 7–12) |
| D12 | Verificar sincrónico, liquidar después, recibo como evento SSE final                                                          | arquitectura               | Fase 9              |
| D13 | Seed de wallet separada de la de red y cifrada; no fondear antes                                                              | **seguridad**              | Fase 7              |
| D14 | Facilitator hosted hasta la Fase 10                                                                                           | arquitectura               | Fase 9              |
| D15 | Plasma default, Stable fallback; `chains` kebab-case sin tocar el schema                                                      | modelo de datos            | Fase 7              |
| D16 | Tres caminos de acceso: local gratis, key con saldo, desconocido con 402                                                      | negocio                    | Fase 9              |
| D17 | Cadena de liquidación si VELA entra — **se cierra recién con el early access**                                                | arquitectura               | V2                  |
| D18 | Tope impuesto **antes** del gasto: prepago (6.5) → autorizaciones denominadas (10). Nunca postpago                            | **negocio + seguridad**    | Fase 6.5            |
| D19 | Tres condiciones para el externo (sin capacidad + opt-in + presupuesto), divulgación en los headers, y qué modelo             | **negocio + privacidad**   | Fase 8.5            |
| D20 | Harness: pasos, tokens, timeouts, backoff solo transitorio, `nonce` como clave de idempotencia                                | arquitectura               | Fase 11             |
| D21 | Cuatro métricas adversariales publicadas con sus fallos + tres controles duros                                                | **seguridad**              | Fase 11.5           |
| D22 | Precio: referencia contra lo que el comprador no puede usar, no contra el token más barato; chicos gratis; piso USD 0,50/MTok | **negocio**                | Fase 8              |
| D23 | Cuota gratuita de 100.000 tokens/24 h, hecha cumplir por el proveedor y por clave de par                                      | **negocio + arquitectura** | Fase 6.6            |

---

## 8 · Item abierto

**La fecha de cierre de la aplicación a Horizen no está en este documento porque
no la sé.** Cambia un solo orden, no el plan:

- **Cierra en menos de dos semanas:** las Fases 7 y 8 se hacen igual (valen
  solas, y desmockear `economic` refuerza la aplicación), la Fase 9 se corre, y
  el esfuerzo va a pulir la narrativa del enclave para V1.
- **Hay más aire:** el orden de la sección 7 queda tal cual.

Es lo único de este roadmap que espera un dato de afuera.

---

## Fuentes

- [WDK — x402](https://docs.wdk.tether.io/ai/x402/) · [Node.js & Bare Quickstart](https://docs.wdk.tether.io/start-building/nodejs-bare-quickstart/) · [Arquitectura del SDK](https://docs.wdk.tether.io/sdk/get-started/) · [MCP Toolkit](https://docs.wdk.tether.io/ai/mcp-toolkit/) · [Agent Skills](https://docs.wdk.tether.io/ai/agent-skills/)
- [tetherto/pear-wrk-wdk](https://github.com/tetherto/pear-wrk-wdk)
- Precios, IDs de modelo, prompt caching, Batch API y conteo de tokens de la
  API de Claude: referencia consultada el 2026-08-25. **El precio intro de
  Sonnet 5 vence el 31-ago-2026** — revalidar antes de calibrar el tope.
- Precios de mercado para D22, consultados el 2026-08-25:
  [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing) ·
  [DeepInfra](https://deepinfra.com/llama) ·
  [comparativa multi-proveedor](https://www.morphllm.com/llm-api-pricing) ·
  [Groq](https://www.aipricing.guru/groq-pricing/)
- [Horizen Labs — VELA](https://horizenlabs.io/vela/) · [docs.horizen.io/vela](https://docs.horizen.io/vela/introduction) · [HorizenOfficial/vela](https://github.com/HorizenOfficial/vela)

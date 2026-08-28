# QVAC-Node — Roadmap Fase 2→6

> **ESTADO: CERRADO.** Fases 0–6. Se conserva por los enlaces entrantes y como
> registro de las decisiones D1–D7. **No es contexto de trabajo vigente.**
> Estado actual del proyecto: [`README.md`](../../README.md).
> Plan activo: [`ROADMAP_FASE7-X402.md`](../../ROADMAP_FASE7-X402.md) →
> [`ROADMAP_REVISION-EVIDENCIA.md`](../../ROADMAP_REVISION-EVIDENCIA.md).

Asume Fase 0 y Fase 1 cerradas (túnel de distribución validado en segunda máquina, inferencia local respondiendo un prompt dentro del worker de Bare). Este documento no repite esas fases: arranca donde el runbook original se queda corto — las decisiones de arquitectura que Fase 2 y Fase 3 necesitan y todavía no están tomadas por escrito.

Regla del documento: cada decisión tiene contexto, opciones consideradas, y **la que recomiendo** — no quedan preguntas abiertas para resolver bajo presión de reloj. Si el equipo prefiere la otra opción, lo importante es que quede escrita _una_ antes de tocar código, no cuál.

**Encuadre de producto (agregado):** el pitch se para sobre la idea de **marketplace de inferencias locales** — cada nodo es un proveedor que anuncia modelo, precio y disponibilidad en vivo; el gateway/panel es donde un comprador elige entre proveedores reales, no un directorio estático. Esto sube de prioridad el estado de carga por nodo (antes D6, ignorado) y no toca la firma del manifiesto (D2 mock aparte), que se mantiene tal como estaba planeada.

---

## 0-bis · Hard gate y narrativa de fallback (escrito 2026-08-22 20:00, entrega ~10:00 del 23)

**La hora está definida acá para no tener que decidirla adentro del problema.**

**Hard gate: 05:00 del domingo 23** (quedan ~6 h de reloj). En ese momento, una
sola pregunta, respondida con el comando y no con una opinión:

```bash
# en las DOS máquinas, al mismo tiempo
qvac-node peers --operator "<nombre>" --timeout 90 --expect 1
```

- **Exit 0 en ambas** → sigue el track P2P: `chat:request`/`chat:chunk` sobre el
  `FramedStream` que ya está abierto (Fase 3).
- **Exit 1 en cualquiera** → **se corta el track P2P** y la demo va con
  `serve --demo` + el gateway compatible con OpenAI. No se sigue peleando con la
  red después de esa hora.

### La narrativa del fallback, escrita ahora

Si el gate corta, esto es lo que se cuenta — y es coherente y defendible, no una
excusa:

> "El protocolo real funciona: el gateway habla OpenAI de verdad, cualquier
> cliente de terceros le apunta sin modificar una línea, y el manifiesto está
> firmado con Ed25519 sobre JCS y se verifica —con los casos negativos en el
> test suite. El descubrimiento P2P está implementado y anda entre dos procesos;
> lo que no cerramos en el reloj es el transporte de inferencia sobre ese canal.
> Es el siguiente track, y el gateway ya devuelve un 501 explícito en ese camino
> en vez de fingir una respuesta."

Lo que hace que esa historia se sostenga es que **nada en el repo miente**:
`serve` arranca vacío, los mocks solo aparecen con `--demo` y dicen "simulado",
un par P2P dice "par P2P verificado", el `economic`/`directory` del manifiesto
dicen `_mock`, y pedirle inferencia a un par remoto devuelve 501 con el motivo.
Si el jurado abre cualquiera de esas puertas, encuentra lo que la slide dijo.

**Lo que NO se hace si el gate corta:** tapar el 501 con el generador de mocks
para que la demo "se vea completa". Es exactamente la falla que se ve idéntica a
que funcione, y es la única forma de perder por deshonestidad en vez de por
alcance.

---

## 0 · Decisiones bloqueantes — cerrar antes de escribir código de Fase 2

### D1. Transporte gateway↔nodo (la más urgente — bloquea el DoD de Fase 3)

**Problema:** `manifest-v0.example.json` declara `node.endpoint.baseUrl: "http://localhost:11434/v1"` — el puerto local de `qvac serve openai`. Eso es _localhost del nodo_, inalcanzable para el gateway de otra máquina. Hyperswarm da un socket P2P (un stream de bytes), no un router HTTP hacia el localhost de otra PC. Ni Fase 2 ni Fase 3 del runbook original dicen cómo viaja el request real.

**Opciones:**

- (a) Túnel HTTP crudo sobre el stream de Hyperswarm: el gateway manda bytes HTTP, el nodo los reenvía a su propio `localhost:11434`.
- (b) Framing propio directo: el nodo llama a `completion()`/`loadModel()` del SDK en el mismo proceso que sostiene la conexión Hyperswarm, sin pasar por HTTP local.

**Decisión: (b).** Ya tenés `framed-stream` como dependencia y el patrón ya probado en `app.js` ↔ `workers/main.js` para el IPC del updater. Reusar esa misma librería para el canal gateway↔nodo evita un hop de red que no aporta nada (el nodo hablándose a sí mismo por loopback) y reduce superficie nueva a aprender bajo reloj.

**Protocolo mínimo (JSON por mensaje, vía `FramedStream` sobre la conexión Hyperswarm):**

| tipo                | dirección      | payload                                              |
| ------------------- | -------------- | ---------------------------------------------------- |
| `manifest:announce` | nodo → gateway | el manifiesto firmado (ya contemplado en Fase 2)     |
| `chat:request`      | gateway → nodo | `{ requestId, model, messages, stream }`             |
| `chat:accepted`     | nodo → gateway | `{ requestId }` — **agregado**, ver abajo            |
| `chat:chunk`        | nodo → gateway | `{ requestId, delta }`                               |
| `chat:done`         | nodo → gateway | `{ requestId }`                                      |
| `chat:error`        | nodo → gateway | `{ requestId, message, code }`                       |
| `chat:cancel`       | gateway → nodo | `{ requestId }` — **agregado**, ver abajo            |
| `node:status`       | nodo → gateway | `{ activeRequests, maxConcurrentRequests }` — ver D6 |

**Dos mensajes agregados al implementar Fase 3** (no estaban en la tabla original):

- **`chat:accepted`** — el modelo se carga perezoso, recién con el primer
  `chat:request`, para no romper la invariante de que arrancar el nodo no baja
  pesos. Eso puede tardar decenas de segundos. Sin un acuse, el consumidor no
  puede distinguir "está cargando 807 MB" de "se colgó", y tiene que elegir
  entre un timeout corto que mata cargas legítimas y uno largo que hace esperar
  de gordo contra un par muerto. Con el acuse son dos timeouts distintos: 8 s
  hasta el `accepted`, 120 s desde ahí hasta el primer token.
- **`chat:cancel`** — si el cliente HTTP cierra la pestaña, el par remoto
  seguiría generando tokens para nadie: CPU de otra persona, que en un
  marketplace es su plata. El gateway avisa y el proveedor corta el generador y
  libera el slot, así `node:status` vuelve a decir la verdad enseguida.

`chat:error` lleva además un `code` (`at_capacity`, `model_not_found`,
`invalid_request`, `inference_failed`) porque el consumidor necesita distinguir
"este par está lleno, probá otro" de "este request está mal, no lo reintentes".

El gateway mantiene un mapa `requestId → response SSE del cliente HTTP` y traduce cada `chat:chunk` a una línea `data:` sin tocar el contenido.

**Impacto si no se decide:** Fase 3 no tiene forma de completar su propio DoD ("un curl con stream:true devuelve tokens desde otro nodo").

---

### D2. El manifiesto vigente es del plan de 48h y contradice el runbook actual

**Problema:** `manifest-v0.json` (el schema "congelado") exige como `required` un bloque `economic` (wallet/chains/settlement) y un bloque `directory` (writerPublicKey/discoveryKey, estilo hyperbee/autobase). El runbook de 24h puso "WDK/recibos/liquidación" y "autobase/hyperdb/blind-pairing" en **Fuera de alcance**.

**Decisión (revisada):** **no se toca el schema.** Editar el zod y regenerar el JSON Schema bajo reloj es más riesgo del que ahorra — es tocar un pipeline de generación (`z.toJSONSchema`) que hoy no está en el camino crítico, para ganar prolijidad que nadie puntúa. En vez de eso, `economic` y `directory` se completan con **valores mock fijos** (una wallet dummy, un `discoveryKey` cualquiera que cumpla el pattern hex, `settlement: "batch-receipts"` literal) que solo existen para pasar la validación — el gateway y el nodo nunca los leen ni los usan para nada.

**Con una condición no negociable:** el mock queda marcado como tal donde se pueda ver, no escondido. Agregar un comentario en el código que arma el manifiesto (`// economic/directory: valores mock, no implementados en este track — ver ROADMAP`) y una línea en el README. La razón es la misma que ya usa el proyecto para no tapar fallas del SDK con un stub silencioso: un mock que parece funcional es peor que un campo faltante, porque si el jurado abre el manifiesto y ve una wallet con plata "real" sin que nadie lo aclare, la lectura es peor que si directamente no estuviera.

**Impacto si no se decide:** ninguno grave para Fase 2 en sí — el riesgo real es que el mock quede sin marcar y alguien (del equipo o del jurado) lo lea como funcionalidad real.

---

### D3. Cómo se entera el gateway de que un nodo se cayó

**Problema:** el manifiesto trae `expiresAt` pensado para un directorio append-only con expiración (modelo hyperbee). Fase 3 asume conexiones vivas de Hyperswarm, un modelo distinto.

**Decisión:** la tabla de candidatos del gateway vive en memoria y se actualiza por eventos de conexión/desconexión del socket — se cae la conexión, se cae el candidato, sin esperar ningún timestamp. `expiresAt` queda en el manifiesto por compatibilidad de schema pero no se usa para esto.

**Impacto si no se decide:** alguien intenta portar lógica de expiración de directorio a último momento, que es más trabajo y no resuelve nada que el propio socket no resuelva ya.

---

### D4. Reintento cuando el nodo elegido falla

**Problema:** el runbook lo deja abierto a propósito en Fase 5 ("arreglarlo o documentarlo honestamente").

**Decisión:** si el nodo elegido falla **antes** de mandar el primer chunk, el gateway reintenta automático en el siguiente candidato (mismo filtro modelId/capabilities). Si ya empezó a streamear, corta con un evento de error visible al cliente y **no reintenta** — el cliente ya tiene una respuesta parcial de un contexto que no se puede retomar en otro nodo.

**Impacto si no se decide:** el comportamiento ante la prueba de Fase 5 ("matar un nodo a mitad de stream") queda a criterio de quien esté programando en ese momento, en vivo.

---

### D5. Qué pasa si hay pares pero ninguno sirve el modelo pedido

**Problema:** el runbook cubre "cero pares en general" pero no "hay pares, ninguno tiene ese `modelId`" — el caso más probable en la demo si alguien prueba con un modelo distinto al seedeado.

**Decisión:** mismo principio que "cero pares" — respuesta de error clara y específica (`no hay nodos sirviendo <modelId>; disponibles: [...]`), nunca un cuelgue silencioso. Se implementa en la misma función de filtrado de Fase 3, no es un caso aparte.

---

### D6. Concurrencia por nodo (revisada — ahora es parte del valor del marketplace, no un descarte)

**Problema:** el manifiesto trae `qos.maxConcurrentRequests`, pero Fase 3 no lo usaba para nada.

**Decisión:** cada nodo emite `node:status` (`activeRequests`/`maxConcurrentRequests`, ver tabla de D1) periódicamente sobre el mismo `FramedStream`. El gateway lo guarda en la misma tabla en memoria de candidatos (junto al manifiesto) y lo usa para dos cosas: (1) al elegir nodo, preferir el de menor carga relativa en vez de puro round-robin — mismo costo de implementación, mejor resultado; (2) exponerlo en el panel de Fase 3.5 como "disponible / ocupado" por proveedor, que es lo que convierte el panel en un marketplace real y no solo un catálogo estático.

**Impacto si no se decide:** sin esto, el "marketplace" solo muestra precio y modelo pero no si el proveedor puede atenderte ahora — la pieza que más se parece a un marketplace de verdad queda afuera.

---

### D7. Tiempo de bootstrap al topic, sin medir

**Problema:** NOTES.md tiene tiempos de `pear install` y de propagación OTA, pero nada del tiempo de join+discovery de Hyperswarm — que cuenta para el objetivo de <60s de Fase 4 y depende de que la red no bloquee UDP/hole-punching.

**Decisión:** agregar la medición apenas el swarm esté funcionando en Fase 2 (ver tareas de Fase 2 abajo), y definir un plan B si la red del venue bloquea UDP: seeder y nodos de demo corriendo en una máquina con IP pública (VPS), no solo en laptops del venue.

---

## Fase 2 — Nodo, manifiesto firmado y swarm (revisada)

**Objetivo (sin cambios):** el nodo se anuncia en un topic fijo con un manifiesto firmado que otros pueden verificar.

**Manifiesto**

- Aplicar D2: schema sin tocar, `economic`/`directory` con valores mock marcados como tales en código y README. Portar a zod 4.
- `signManifest` / `verifyManifest`: Ed25519 sobre JCS (RFC 8785), con test de caso negativo.
- Sin generación de JSON Schema ni test de comparación (ya recortado en el runbook original).

**Swarm**

- Topic fijo, hardcodeado, vía `hyperswarm` (ya viene con el SDK).
- Cada conexión entrante/saliente se envuelve en `FramedStream` (D1) — es el mismo canal que después Fase 3 usa para `chat:request`/`chat:chunk`, no una conexión aparte.
- El nodo publica su manifiesto firmado al conectarse con un par. Un manifiesto que no verifica se descarta antes de leer nada más.
- **Nueva tarea (D6):** el nodo emite `node:status` (carga actual / capacidad) periódicamente por el mismo canal, además del manifiesto — es la pieza que hace que el marketplace muestre disponibilidad real, no solo catálogo.
- **Nueva tarea (D7):** medir tiempo desde `topic.join()` hasta la primera conexión de peer establecida. Anotarlo en NOTES.md junto a los otros números.

**Definition of done:** dos nodos en máquinas distintas se descubren en el topic e intercambian manifiestos verificados, sobre el mismo canal `FramedStream` que va a transportar requests de inferencia en Fase 3.

**Riesgo principal:** irse por la madriguera del protocolo. Con D1–D3 ya decididos, no hay que rediseñar nada en el momento — solo implementar.

---

## Fase 3 — Gateway sobre bare-http1 (revisada)

**Objetivo (sin cambios):** endpoint compatible con OpenAI, streaming de punta a punta, decisión de routing loggeada.

**Gateway**

- `POST /v1/chat/completions` sobre `bare-http1`. SSE a mano (chunked writes manuales).
- Filtra candidatos del topic por `modelId` y `capabilities.streaming` (sin cambios), y entre los que califican, prefiere el de menor carga relativa según `node:status` (D6) en vez de puro round-robin.
- Traduce el request HTTP a un mensaje `chat:request` (D1) sobre el `FramedStream` del nodo elegido; traduce cada `chat:chunk` a una línea `data:` SSE.
- Aplica D4 (reintento solo pre-primer-chunk) y D5 (mensaje claro si no hay match de modelo).
- Log de routing en JSON-Lines append-only: candidatos, elegido, motivo, y ahora también si hubo reintento y por qué.

**Cero modelo**

- El gateway arranca sin ningún modelo descargado (sin cambios).
- Si no hay pares — o hay pares sin el modelo pedido (D5) — mensaje claro, nunca un cuelgue silencioso.

**Definition of done:** un `curl` con `"stream": true` devuelve tokens desde otro nodo vía el canal `FramedStream`, y el log muestra por qué se eligió ese nodo.

**Riesgo principal:** el framing manual de SSE (sin cambios respecto del runbook original) — pero ya no hay que resolver en paralelo el problema de transporte P2P, porque quedó cerrado en D1.

---

## Fase 3.5 — Panel de modelos (pieza nueva, no estaba en el runbook original)

**Origen:** la idea es un panel tipo [build.nvidia.com/models](https://build.nvidia.com/models) — una grilla de modelos especializados (uno de arquitectura, uno de facturas, etc.), cada uno con un precio que define quien provee ese modelo, y el argumento de privacidad de que ninguna corporación grande maneja los datos.

**Por qué es casi gratis de construir:** el manifiesto (Fase 2) ya trae `models[].displayName`, `capabilities`, `pricing` y `metadata.tags`/`metadata.operator` por nodo. El gateway (Fase 3) ya arma una tabla en memoria de esos manifiestos para poder rutear. El panel no necesita ninguna pieza de datos nueva — solo exponer esa tabla y dibujarla.

**Backend**

- `GET /v1/models` en el mismo `bare-http1` del gateway: devuelve la tabla en memoria ya agregada (modelId, displayName, tags, pricing, operador) de los nodos conectados en ese momento. Es de solo lectura, no toca el camino de inferencia.

**Frontend**

- Un único archivo HTML estático (sin build, sin framework) servido por el propio gateway en `GET /`. Fetchea `/v1/models` y pinta una grilla de tarjetas: nombre del modelo, categoría (por `tags`: arquitectura/facturas/etc.), precio, quién lo provee, y un badge de **disponible / ocupado** según `node:status` (D6) — es lo que hace que se lea como marketplace y no como catálogo estático.
- Se actualiza sola (poll cada pocos segundos o reconexión simple) para que en la demo se vea un nodo nuevo aparecer en vivo cuando se conecta, y el badge de disponibilidad cambiar cuando un nodo está sirviendo un request.

**Precisión de la narrativa de privacidad — para no sobrevender en el pitch:** el claim correcto es _"ninguna corporación centralizada agrega tus datos a escala"_ (cierto: no pasa por OpenAI/Google/Anthropic). No es _"nadie más ve tu prompt"_ — el nodo que ejecuta la inferencia sí lo ve en texto plano, porque el cifrado E2E ("gateway ciego") está explícitamente fuera de alcance en este track. Vale la pena decirlo así de preciso si el jurado pregunta, en vez de que lo encuentren ellos.

**Definition of done:** abrir `http://localhost:<puerto>/` en un browser durante la demo muestra las tarjetas de los modelos realmente conectados en ese momento, con precio y proveedor.

**Riesgo principal:** que se coma tiempo de Fase 4/5, que sí son criterio de juzgado. Por eso es la **pieza más recortable de todo el roadmap** — más incluso que el manifiesto firmado (ver Tabla de recorte): si a H+16 el panel no está, se cuenta en las slides con una captura y no se sigue puliendo.

---

## Fase 4 — El install es la demo (revisada)

Sin cambios de objetivo. Agregar a **Infraestructura**:

- Cronometrar por separado el tiempo de swarm-join (D7) del tiempo de `pear install`, para saber cuál de los dos se come el minuto si el objetivo de <60s no se cumple.
- Si la red del venue bloquea UDP/hole-punching: seeder y nodos de demo deben poder correr desde una máquina con IP pública, no depender de que el hole-punching funcione en el momento. Probarlo con anticipación, no descubrirlo en el escenario.

---

## Fase 4.5 — Hermes Agent como cliente del gateway (agregado, bajo costo)

**Origen:** [Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research, open source, [repo](https://github.com/NousResearch/hermes-agent)) es un agente con memoria persistente que soporta apuntar su backend de LLM a **cualquier endpoint compatible con OpenAI** vía `base_url` en su config — Ollama, vLLM, llama.cpp, "cualquier proxy compatible con OpenAI" ([docs](https://hermes-agent.nousresearch.com/docs/integrations/providers)). Tu gateway de Fase 3 expone exactamente eso.

**Por qué es casi gratis:** no hay código nuevo en el repo de QVAC-Node. Es configuración de Hermes Agent, no integración:

```yaml
# ~/.hermes/config.yaml en la máquina de la demo
model:
  provider: custom
  base_url: http://127.0.0.1:<puerto-gateway>/v1
  default: <modelId exacto que anuncia tu nodo, ej. LLAMA_3_2_1B_INST_Q4_0>
```

El `default` tiene que matchear un `modelId` real anunciado por tus nodos — si no, cae en D5 (mensaje de "modelo no encontrado") en vivo.

**Por qué vale la pena para el pitch:** es la prueba de que el gateway realmente habla el protocolo de OpenAI — un agente de terceros, sin modificar una línea, elige tu red descentralizada en vez de una API de una gran corporación. Además, el modo de memoria "Holographic" de Hermes es SQLite 100% local, sin servicio externo — refuerza el mismo argumento de privacidad que ya viene con el panel de Fase 3.5, esta vez también del lado de la memoria del agente, no solo de la inferencia.

**Dónde entra en la demo:** como un paso extra dentro del "Recorrido del jurado" de Fase 4, después de que el `curl` a `/v1/chat/completions` ya funciona. Usar solo chat simple, sin tool calls, para no depender de que `security.toolCallPolicy` del nodo coincida con lo que Hermes intente usar.

**Riesgo:** es una dependencia externa que el equipo no controla — si Hermes Agent tiene un bug o un cambio de versión el día de la demo, no hay forma de arreglarlo rápido. Por eso: **no es criterio de juzgado, es puro upside** — se prueba con anticipación (no la primera vez en el escenario, mismo criterio que ya aplican al OTA) y si falla el día de la demo, se cae este paso sin afectar nada del resto del recorrido.

---

## Fase 5 — OTA en vivo y endurecimiento (revisada)

Sin cambios de objetivo. El punto "matar un nodo a mitad de stream y ver qué hace el gateway" ya no es una pregunta abierta — es una prueba de que D3 y D4 están bien implementados: la conexión cae, el candidato desaparece de la tabla, y si había un stream en curso el cliente recibe el error de corte (no un reintento silencioso a mitad de respuesta).

---

## Fase 6 — Submission y pitch (revisada)

Agregar a **Entregables**:

- La justificación escrita del process shape (ya pedida) debe incluir también por qué el transporte gateway↔nodo es `FramedStream` sobre Hyperswarm y no HTTP — es la misma disciplina de "decisión explicada por escrito" que ya aplican a la variante `main` del worker thread, y es la pregunta más probable que puede hacer el jurado si mira el código.
- Confirmar que la marca de mock en `economic`/`directory` (D2) sigue visible en el código y en el README al momento de entregar — es fácil que se pierda en un refactor de último momento.

---

## Tabla resumen — decisiones a cerrar antes de arrancar Fase 2

| #   | Decisión                                                                                                              | Bloquea                    |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| D0  | Panel de modelos (Fase 3.5): se corta primero que cualquier otra cosa si aprieta el reloj — no es criterio de juzgado | — (puro upside de pitch)   |
| D1  | Transporte gateway↔nodo: `FramedStream` sobre Hyperswarm, no HTTP a localhost                                         | Fase 3 completa            |
| D2  | No tocar el schema; `economic`/`directory` con mock marcado explícitamente (no silencioso)                            | Fase 2                     |
| D3  | Candidatos en memoria por estado de socket, no por `expiresAt`                                                        | Fase 3 / Fase 5            |
| D4  | Reintento solo pre-primer-chunk; corte limpio si ya se empezó a streamear                                             | Fase 5                     |
| D5  | Mensaje claro si hay pares sin el modelo pedido                                                                       | Fase 3                     |
| D6  | Nodo emite `node:status` (carga/capacidad); gateway lo usa para elegir y para el badge disponible/ocupado del panel   | Fase 2 / Fase 3 / Fase 3.5 |
| D7  | Medir tiempo de swarm-join; plan B si el venue bloquea UDP                                                            | Fase 4                     |

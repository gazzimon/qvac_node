# QVAC-Node — Roadmap Fase 2→6

Asume Fase 0 y Fase 1 cerradas (túnel de distribución validado en segunda máquina, inferencia local respondiendo un prompt dentro del worker de Bare). Este documento no repite esas fases: arranca donde el runbook original se queda corto — las decisiones de arquitectura que Fase 2 y Fase 3 necesitan y todavía no están tomadas por escrito.

Regla del documento: cada decisión tiene contexto, opciones consideradas, y **la que recomiendo** — no quedan preguntas abiertas para resolver bajo presión de reloj. Si el equipo prefiere la otra opción, lo importante es que quede escrita *una* antes de tocar código, no cuál.

---

## 0 · Decisiones bloqueantes — cerrar antes de escribir código de Fase 2

### D1. Transporte gateway↔nodo (la más urgente — bloquea el DoD de Fase 3)

**Problema:** `manifest-v0.example.json` declara `node.endpoint.baseUrl: "http://localhost:11434/v1"` — el puerto local de `qvac serve openai`. Eso es *localhost del nodo*, inalcanzable para el gateway de otra máquina. Hyperswarm da un socket P2P (un stream de bytes), no un router HTTP hacia el localhost de otra PC. Ni Fase 2 ni Fase 3 del runbook original dicen cómo viaja el request real.

**Opciones:**
- (a) Túnel HTTP crudo sobre el stream de Hyperswarm: el gateway manda bytes HTTP, el nodo los reenvía a su propio `localhost:11434`.
- (b) Framing propio directo: el nodo llama a `completion()`/`loadModel()` del SDK en el mismo proceso que sostiene la conexión Hyperswarm, sin pasar por HTTP local.

**Decisión: (b).** Ya tenés `framed-stream` como dependencia y el patrón ya probado en `app.js` ↔ `workers/main.js` para el IPC del updater. Reusar esa misma librería para el canal gateway↔nodo evita un hop de red que no aporta nada (el nodo hablándose a sí mismo por loopback) y reduce superficie nueva a aprender bajo reloj.

**Protocolo mínimo (JSON por mensaje, vía `FramedStream` sobre la conexión Hyperswarm):**

| tipo | dirección | payload |
|---|---|---|
| `manifest:announce` | nodo → gateway | el manifiesto firmado (ya contemplado en Fase 2) |
| `chat:request` | gateway → nodo | `{ requestId, model, messages, stream }` |
| `chat:chunk` | nodo → gateway | `{ requestId, delta }` |
| `chat:done` | nodo → gateway | `{ requestId }` |
| `chat:error` | nodo → gateway | `{ requestId, message }` |

El gateway mantiene un mapa `requestId → response SSE del cliente HTTP` y traduce cada `chat:chunk` a una línea `data:` sin tocar el contenido.

**Impacto si no se decide:** Fase 3 no tiene forma de completar su propio DoD ("un curl con stream:true devuelve tokens desde otro nodo").

---

### D2. El manifiesto vigente es del plan de 48h y contradice el runbook actual

**Problema:** `manifest-v0.json` (el schema "congelado") exige como `required` un bloque `economic` (wallet/chains/settlement) y un bloque `directory` (writerPublicKey/discoveryKey, estilo hyperbee/autobase). El runbook de 24h puso "WDK/recibos/liquidación" y "autobase/hyperdb/blind-pairing" en **Fuera de alcance**. Tal como está, ningún nodo puede publicar un manifiesto válido sin inventar datos económicos y de directorio que no se van a usar.

**Decisión:** recortar el schema a lo que Fase 2 real necesita — `schemaVersion`, `protocolVersion`, `node` (sin `endpoint.baseUrl`, ver D1), `models`, `security`, `signature`. Sacar `economic` y `directory` de `required` (o del schema entero). Documentar en el propio archivo por qué se recorta, con la misma disciplina de versionado que ya tiene (`schemaVersion` sube si hay cambio incompatible).

**Impacto si no se decide:** Fase 2 pierde tiempo generando campos falsos (wallet, discoveryKey) solo para pasar la validación de un schema que ya no representa el producto.

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

### D6. Concurrencia por nodo

**Problema:** el manifiesto trae `qos.maxConcurrentRequests`, pero Fase 3 no lo usa para descartar un nodo ocupado.

**Decisión:** se ignora para el timebox de 24h. Con 2 nodos de demo la probabilidad de dos requests simultáneos al mismo nodo durante el pitch es baja. Se documenta como limitación conocida en el README, no se resuelve salvo que sobre tiempo después de Fase 5.

---

### D7. Tiempo de bootstrap al topic, sin medir

**Problema:** NOTES.md tiene tiempos de `pear install` y de propagación OTA, pero nada del tiempo de join+discovery de Hyperswarm — que cuenta para el objetivo de <60s de Fase 4 y depende de que la red no bloquee UDP/hole-punching.

**Decisión:** agregar la medición apenas el swarm esté funcionando en Fase 2 (ver tareas de Fase 2 abajo), y definir un plan B si la red del venue bloquea UDP: seeder y nodos de demo corriendo en una máquina con IP pública (VPS), no solo en laptops del venue.

---

## Fase 2 — Nodo, manifiesto firmado y swarm (revisada)

**Objetivo (sin cambios):** el nodo se anuncia en un topic fijo con un manifiesto firmado que otros pueden verificar.

**Manifiesto**
- Aplicar D2: recortar `manifest-v0.json` a los campos vigentes. Portar a zod 4.
- `signManifest` / `verifyManifest`: Ed25519 sobre JCS (RFC 8785), con test de caso negativo.
- Sin generación de JSON Schema ni test de comparación (ya recortado en el runbook original).

**Swarm**
- Topic fijo, hardcodeado, vía `hyperswarm` (ya viene con el SDK).
- Cada conexión entrante/saliente se envuelve en `FramedStream` (D1) — es el mismo canal que después Fase 3 usa para `chat:request`/`chat:chunk`, no una conexión aparte.
- El nodo publica su manifiesto firmado al conectarse con un par. Un manifiesto que no verifica se descarta antes de leer nada más.
- **Nueva tarea (D7):** medir tiempo desde `topic.join()` hasta la primera conexión de peer establecida. Anotarlo en NOTES.md junto a los otros números.

**Definition of done:** dos nodos en máquinas distintas se descubren en el topic e intercambian manifiestos verificados, sobre el mismo canal `FramedStream` que va a transportar requests de inferencia en Fase 3.

**Riesgo principal:** irse por la madriguera del protocolo. Con D1–D3 ya decididos, no hay que rediseñar nada en el momento — solo implementar.

---

## Fase 3 — Gateway sobre bare-http1 (revisada)

**Objetivo (sin cambios):** endpoint compatible con OpenAI, streaming de punta a punta, decisión de routing loggeada.

**Gateway**
- `POST /v1/chat/completions` sobre `bare-http1`. SSE a mano (chunked writes manuales).
- Filtra candidatos del topic por `modelId` y `capabilities.streaming` (sin cambios).
- Traduce el request HTTP a un mensaje `chat:request` (D1) sobre el `FramedStream` del nodo elegido; traduce cada `chat:chunk` a una línea `data:` SSE.
- Aplica D4 (reintento solo pre-primer-chunk) y D5 (mensaje claro si no hay match de modelo).
- Log de routing en JSON-Lines append-only: candidatos, elegido, motivo, y ahora también si hubo reintento y por qué.

**Cero modelo**
- El gateway arranca sin ningún modelo descargado (sin cambios).
- Si no hay pares — o hay pares sin el modelo pedido (D5) — mensaje claro, nunca un cuelgue silencioso.

**Definition of done:** un `curl` con `"stream": true` devuelve tokens desde otro nodo vía el canal `FramedStream`, y el log muestra por qué se eligió ese nodo.

**Riesgo principal:** el framing manual de SSE (sin cambios respecto del runbook original) — pero ya no hay que resolver en paralelo el problema de transporte P2P, porque quedó cerrado en D1.

---

## Fase 4 — El install es la demo (revisada)

Sin cambios de objetivo. Agregar a **Infraestructura**:

- Cronometrar por separado el tiempo de swarm-join (D7) del tiempo de `pear install`, para saber cuál de los dos se come el minuto si el objetivo de <60s no se cumple.
- Si la red del venue bloquea UDP/hole-punching: seeder y nodos de demo deben poder correr desde una máquina con IP pública, no depender de que el hole-punching funcione en el momento. Probarlo con anticipación, no descubrirlo en el escenario.

---

## Fase 5 — OTA en vivo y endurecimiento (revisada)

Sin cambios de objetivo. El punto "matar un nodo a mitad de stream y ver qué hace el gateway" ya no es una pregunta abierta — es una prueba de que D3 y D4 están bien implementados: la conexión cae, el candidato desaparece de la tabla, y si había un stream en curso el cliente recibe el error de corte (no un reintento silencioso a mitad de respuesta).

---

## Fase 6 — Submission y pitch (revisada)

Agregar a **Entregables**:

- La justificación escrita del process shape (ya pedida) debe incluir también por qué el transporte gateway↔nodo es `FramedStream` sobre Hyperswarm y no HTTP — es la misma disciplina de "decisión explicada por escrito" que ya aplican a la variante `main` del worker thread, y es la pregunta más probable que puede hacer el jurado si mira el código.

---

## Tabla resumen — decisiones a cerrar antes de arrancar Fase 2

| # | Decisión | Bloquea |
|---|---|---|
| D1 | Transporte gateway↔nodo: `FramedStream` sobre Hyperswarm, no HTTP a localhost | Fase 3 completa |
| D2 | Recortar manifiesto a campos vigentes (sin `economic`/`directory` obligatorios) | Fase 2 |
| D3 | Candidatos en memoria por estado de socket, no por `expiresAt` | Fase 3 / Fase 5 |
| D4 | Reintento solo pre-primer-chunk; corte limpio si ya se empezó a streamear | Fase 5 |
| D5 | Mensaje claro si hay pares sin el modelo pedido | Fase 3 |
| D6 | Ignorar `maxConcurrentRequests` por ahora, documentar como limitación | — (bajo riesgo) |
| D7 | Medir tiempo de swarm-join; plan B si el venue bloquea UDP | Fase 4 |

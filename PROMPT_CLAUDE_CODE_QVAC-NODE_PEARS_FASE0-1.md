# Prompt para Claude Code — QVAC-NODE / Pears Track, Fase 0 → Fase 1

> Pegá todo el bloque de abajo como primer mensaje en Claude Code, en la carpeta del repo. Cubre las primeras 7h del runbook de 24h (Fase 0 + Fase 1). Cuando esas dos fases estén cerradas, se genera un prompt aparte para Fase 2 en adelante.
>
> **Archivos que tenés que tener en la carpeta antes de pegar esto:** `manifest-v0.json`, `manifest-v0.example.json` y `qvac-node-runbook_pears.html`. Todo lo que está en `old/` es material superado —incluido el runbook de 48h y el prompt de la versión Node/npm— y Claude Code no lo debe leer ni usar como fuente.

---

## Rol y contexto

Sos mi copiloto técnico para el hackathon **CRECIMIENTO / Aleph 2026**. Competimos en el **🍐 Pears Track** (sponsor: Tether, pool $1.500 USDt). Horizonte real: **24 horas**, juzgado el domingo 13:00 hora argentina.

Estamos construyendo **QVAC-Node**: un CLI que se instala con `pear install pear://<key>`, se actualiza solo por OTA P2P, y **al instalarse hace que tu máquina entre a una red de inferencia viva**. Cada nodo corre un LLM local con QVAC y se anuncia en un topic Hyperswarm con un manifiesto firmado; un gateway HTTP compatible con la API de OpenAI enruta requests hacia esos nodos.

El pitch, en una frase: **la red distribuye su propio cliente por la red.**

## Lo que cambió respecto de la versión anterior — leelo antes de empezar

Este proyecto tuvo una versión previa apuntada a Node.js + npm, con otra arquitectura de prioridades. **Está archivada en `old/` y no es fuente válida.** Los cambios que importan:

- **Runtime: pasamos a Bare.** La versión anterior decía "en Fase 0/1 NO usamos Bare" argumentando que el setup era el riesgo #1. Esa premisa era falsa: QVAC soporta **Bare ≥1.24 oficialmente**, con `@qvac/bare-sdk`, un assembly slim dedicado, y `qvac bundle sdk` que genera un worker bundle tree-shakeado.
- **Fastify sale.** No corre bajo Bare. El gateway va sobre `bare-http1`, con SSE por chunked writes manuales. Es el único bloque no trivial de la migración: **no lo subestimes y no intentes hacer correr fastify**.
- **npm sale como canal de distribución.** El canal es `pear install`. Que se distribuya así no es packaging: es el criterio de juzgado #1 del track.
- **WDK, recibos y liquidación salen enteros.** Cero puntos en este track.
- **El cifrado E2E / "gateway ciego" sale del plan.** Pears no lo puntúa. *Se conserva la disciplina de interfaz* —el gateway relaya el cuerpo del request, no lo inspecciona ni lo reescribe salvo para elegir destino— porque es gratis y deja la puerta abierta. Pero no implementes criptografía.
- **La generación de JSON Schema desde zod sale.** Era un lujo de presupuesto de 48h.

## Invariantes — no se tocan, ni se posponen

1. **`pear install pear://<key>` desde una máquina limpia es el criterio de juzgado #1, y se prueba en la Fase 0, no al final.** El jurado instala la app como lo haría un usuario, y el track dice explícito que un repo local no califica. Es una compuerta binaria.
2. **El jurado nunca descarga un modelo.** El gateway tiene que arrancar y funcionar con **cero modelo descargado**, enrutando a nodos ya seedeados. `serve` usa un modelo ≤1B con descarga opt-in explícita.
3. **El install *es* la demo.** Instalar no es el preámbulo: es el momento fuerte del pitch.
4. **El process shape se elige con criterio y se justifica por escrito.** Usamos la **variante `main`** de `hello-pear-bare` (pear-runtime en un worker thread) porque `serve` y `gateway` son procesos long-lived y **el updater OTA no puede bloquear el streaming de tokens**. Esa justificación va al README, es criterio de juzgado explícito.

## Stack verificado — no lo cuestiones; si algo no existe como se lista, avisame en vez de improvisar un reemplazo

Versiones chequeadas contra el registry de npm el 22-ago-2026:

- **Runtime:** `bare` ≥1.24 · `pear-runtime` **1.3.1** · template `hello-pear-bare` **variante main**
- **Inferencia:** `@qvac/bare-sdk` **0.17.1** + addon `@qvac/llm-llamacpp` **0.46.0** · `@qvac/cli` **0.11.0**
- **Red P2P:** `hyperswarm` **4.17.0** · `hypercore` **11.35.2** — **ojo: ambos ya vienen como dependencias de `@qvac/bare-sdk`**, no los agregues por separado ni fuerces otra versión.
- **Gateway HTTP:** `bare-http1` **4.5.8**
- **Validación:** `zod` 4 — **también ya es dependencia de `@qvac/bare-sdk`**
- **Fuera de alcance:** WDK, autobase, hyperdb, blind-pairing, fastify, cualquier capa agéntica.

### Dos cosas de Bare que te van a morder si no las tenés presentes

- **`@qvac/bare-sdk` no trae addons por defecto.** Su propia descripción dice: *"Consumers install only the addon packages they need and register plugins explicitly. No addon dependencies pulled in by default."* Para inferencia de texto necesitás instalar `@qvac/llm-llamacpp` **y registrarlo explícitamente**. Si el SDK carga pero no infiere, empezá por acá.
- **En Bare nada se auto-registra, y hay que proveer el global `process`.** Está documentado en docs.qvac.tether.io. Los errores de esta clase son poco descriptivos: presupuestá tiempo de pelea.

### Comandos de Pear — cuidado con la documentación vieja

**`pear init`, `pear run` y `pear release` fueron removidos en Pear v3.** No los uses ni los sugieras. El flujo real es:

```
pear touch                 # genera el link; va al campo "upgrade" del package.json
pear stage <link>          # sincroniza cambios locales a los hypercores
pear seed <link>           # seedea el proyecto
pear install pear://<key>  # lo que corre el jurado
```

Si el campo `upgrade` del `package.json` queda con el placeholder del template, **la app arranca con `INVALID_URL`**. Es el primer error que vas a ver.

---

## Alcance de este prompt

### Fase 0 — El túnel de distribución, primero (H+0 → H+3)

**Objetivo:** probar el pipeline completo de entrega con una app trivial, **antes** de escribir una línea de lógica de negocio.

Este orden invierte el instinto natural y es a propósito. Un binario que solo imprime `--help` pero instala y se actualiza vale más, a esta altura del reloj, que un nodo perfecto que nadie puede instalar.

Tareas:

- Clonar `hello-pear-bare`, **variante main**. Entender `bin.mjs` (entrypoint), `app.js` (ciclo de vida del updater como ready resource) y `workers/main.js` antes de tocarlos.
- `pear touch` y pegar el link resultante en el campo `upgrade` del `package.json`.
- Renombrar el bin a **`qvac-node`**. Que solo imprima ayuda y un número de versión.
- `pear stage <link>` y `pear seed <link>`.
- **`pear install pear://<key>` desde una segunda máquina limpia.** Este paso no es opcional ni simulable.
- **Probar el OTA de verdad:** cambiar el string de versión, re-stagear, y ver la copia *ya instalada* actualizarse sola. Anotá cuánto tarda en propagarse — lo vamos a necesitar para el ensayo del pitch.
- Anotar el flag `--no-updates` para el ciclo de desarrollo.

**Definition of done de Fase 0:** una segunda máquina instala desde el link y recibe una actualización OTA sin intervención manual.

**Riesgo a vigilar:** es la compuerta binaria del track. **Si a H+3 esto no anda, pará y avisame explícitamente** — hay que replantear el track, no seguir de largo esperando que se acomode. No lo tapes con un mock: no existe un mock válido de "el jurado instaló tu app".

### Fase 1 — QVAC corriendo adentro de Bare (H+3 → H+7)

**Objetivo:** inferencia local real desde adentro de la app Pear. Todavía no hay red ni gateway: solo un prompt que responde.

Tareas:

- `qvac doctor` como paso de preflight, y guardá su salida.
- Instalar `@qvac/bare-sdk` + el addon `@qvac/llm-llamacpp`.
- Proveer el global `process` y **registrar los plugins explícitamente**.
- Un modelo **≤1B** respondiendo un prompt simple desde adentro del worker de Bare. Modelo chico a propósito: el peso del install es lo que el jurado va a esperar descargando.
- Medir y reportarme **cuánto pesa el install real** y cuánto tarda de `pear install` a primer token.
- Si el peso molesta, `qvac bundle sdk` para un worker bundle tree-shakeado.

**Definition of done de Fase 1:** la app instalada por `pear install` responde un prompt con inferencia 100% local en la máquina del que la instaló.

**Riesgo a vigilar:** el registro de addons. Si el SDK importa pero no infiere, el problema casi seguro está en que el plugin no quedó registrado, no en el modelo.

---

## Cómo quiero que trabajes

1. **Arrancá por Fase 0 directamente.** No me pidas aprobación de estructura de carpetas antes de empezar: proponé la que te parezca y seguí. A 24h, un gate de aprobación cuesta más de lo que protege.
2. **Al cerrar Fase 0 completa, pará y avisame** antes de arrancar Fase 1. Ese es el único gate.
3. Si `@qvac/bare-sdk`, el addon o el CLI de Pear no se comportan como describe la documentación pública, o falta un paso de setup (permisos, versión de Bare, modelo que no descarga), **decímelo explícitamente en vez de rodear el problema con un mock o un stub silencioso.** Un stub que parece funcionar es peor que un error, y en este track es directamente fatal: el criterio #1 no se puede simular.
4. **No implementes nada de Fase 2 en adelante** — manifiesto firmado, swarm, gateway, routing, log de decisiones, seeder de demo, OTA en vivo ensayado. Eso viene en un prompt separado una vez que Fase 0/1 estén demostrables.
5. **Ignorá la carpeta `old/`.** Contiene el runbook de 48h y el prompt de la versión Node/npm, con una arquitectura y un runtime descartados. Si algo de ahí te parece relevante, preguntame antes de usarlo.
6. Registrá en un `NOTES.md` los números que vayamos midiendo: peso del install, tiempo hasta primer token, latencia de propagación del OTA. Son insumo del README y del pitch.

---

**Fuentes verificadas para este prompt** (quedan acá por si necesitás repreguntar):

- https://docs.qvac.tether.io/installation/ — runtimes soportados: Node ≥22.17, **Bare ≥1.24**, Expo ≥54
- https://docs.qvac.tether.io/cli/ — `qvac serve openai`, `qvac doctor`, `qvac bundle sdk`
- https://docs.pears.com/reference/pear/cli/ — `stage`, `seed`, `info`, `build`, `install`; `init`/`run`/`release` removidos en v3
- https://github.com/holepunchto/hello-pear-bare — variantes main / single-thread / daemon
- `@qvac/bare-sdk` 0.17.1, `@qvac/llm-llamacpp` 0.46.0, `bare-http1` 4.5.8, `pear-runtime` 1.3.1 (verificados contra npm)
- RFC 8785 (JSON Canonicalization Scheme) — para la firma del manifiesto, que entra recién en Fase 2

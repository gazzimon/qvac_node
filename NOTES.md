# NOTES — mediciones QVAC-Node

Números medidos, no estimados. Insumo del README y del pitch.
Máquina de medición: Windows 11 Pro 26200, Node 24.14.1, Bare 1.31.0, Pear 3.2.0.

---

## Fase 0 — túnel de distribución

**Link del proyecto:** `pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny`

### Peso del install

|                                             |           |
| ------------------------------------------- | --------- |
| Binario standalone win32-x64                | **55 MB** |
| **Lo que descarga el cliente**              | **55 MB** |
| Store completo (6 plataformas) en el seeder | 448 MB    |

El cliente **no** descarga los 448 MB: Hyperdrive replica sparse y baja solo
`/by-arch/<su-plataforma>/app/`. Medido: con las 6 plataformas publicadas, un
cliente win32-x64 transfirió 55 MB. Es el número que importa para el jurado.

Peso por plataforma del binario standalone:

| plataforma   | tamaño |
| ------------ | ------ |
| win32-arm64  | 52 MB  |
| win32-x64    | 55 MB  |
| darwin-arm64 | 78 MB  |
| darwin-x64   | 80 MB  |
| linux-x64    | 93 MB  |
| linux-arm64  | 94 MB  |

### Tiempos

| operación                                              | tiempo             |
| ------------------------------------------------------ | ------------------ |
| `pear install` completo (descarga + PATH)              | **12–13 s**        |
| Descarga sostenida observada                           | 22–24 MB/s, 1 peer |
| **Propagación OTA** (`pear stage` → `update aplicado`) | **~10 s**          |
| `npm run release` (6 plataformas: build + stage)       | 27 s               |
| `npm run release:host` (1 plataforma)                  | 6 s                |
| `npm run make` por plataforma                          | ~3 s               |

### OTA verificado

Probado dos veces, con la copia instalada **corriendo**:

- v0.1.0 → v0.2.0
- v0.2.0 → v0.3.0

El binario se reemplaza en disco y el anterior queda como
`qvac-node-<version-vieja>.exe` (rollback). Hace falta reiniciar el proceso para
correr la versión nueva; el updater avisa pero no mata el proceso en curso —
que es justamente lo que queremos cuando haya streaming de tokens.

---

## Estado de la Definition of Done de Fase 0

> "Una segunda máquina instala desde el link y recibe una actualización OTA sin
> intervención manual."

| paso                                | estado             |
| ----------------------------------- | ------------------ |
| `pear touch` → link en `upgrade`    | ✅                 |
| build standalone, 6 plataformas     | ✅                 |
| `pear build` → `by-arch/`           | ✅                 |
| `pear stage` / `pear seed`          | ✅                 |
| `pear install` desde el link        | ✅                 |
| OTA sobre copia instalada corriendo | ✅ (misma máquina) |
| **Segunda máquina limpia: INSTALL** | ✅                 |
| **Segunda máquina limpia: OTA**     | ⬜ pendiente       |

### Install cross-máquina verificado

Windows 11 (seeder) → MacBook Air Apple Silicon, sobre hotspot de iPhone.

|                 |                                       |
| --------------- | ------------------------------------- |
| Binario servido | `/by-arch/darwin-arm64/app/qvac-node` |
| Transferido     | **80.9 MB**                           |
| Velocidad pico  | **3.4 MB/s**                          |
| Versión         | 0.8.0 (verlink 0.5955)                |

La Mac no clonó el repo para instalar: `npm i -g pear` y `pear install`. Eligió
el binario de su arquitectura sola. Es el criterio de juzgado #1 del track,
cumplido de verdad y no simulado.

El pipeline entero está verificado, pero **de punta a punta en una sola
máquina**. El runbook dice explícito que este paso "no es opcional ni
simulable", y tiene razón: la instalación local puede estar resolviendo contra
el store de Pear en disco en vez de contra la red, y eso no se distingue desde
acá. Falta correr en una segunda máquina:

```
npm i -g pear
pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
```

con el seeder (`npm run seed`) corriendo en esta.

---

## TRAMPA DEL OTA — leer antes de ensayar el pitch

`pear-runtime-updater` agenda cada update en un punto **aleatorio** de una
ventana que por default es de **una hora**, y solo lo aplica al instante si la
versión nueva aparece dentro de los **primeros 60 segundos** de vida del
proceso (`_bootGracePeriod`).

Es un default correcto para una flota grande —evita que miles de nodos se
actualicen todos juntos— y es letal para una demo en vivo. Todos los OTA que
medimos en ~10s cayeron dentro de ese minuto de gracia por casualidad. La
primera vez que publicamos con el nodo corriendo hace más de un minuto, el
update simplemente no ocurrió.

Está cableado a **10 segundos** por default, configurable con `--update-delay`.

Verificado con el período de gracia ya vencido (nodo corriendo hace 95s):
**el OTA disparó a los 7 segundos del stage.**

Dato para el pitch: el OTA es **delta**. Al pasar de 0.7.0 a 0.8.0 se
transfirió **1.1 MB**, no los 55 MB del binario entero.

---

## La wifi de la sala: enlace cliente-a-cliente inestable

Un día entero de diagnóstico terminó acá, y **no era el código**.

Medido desde la máquina 1 (192.168.112.209) hacia la Mac (192.168.112.252),
las dos en la misma LAN:

| destino                 | pérdida          |
| ----------------------- | ---------------- |
| Gateway (192.168.112.1) | **0%** — 3 ms    |
| Mac, primera medición   | 0% — 6-29 ms     |
| Mac, una hora después   | **95%** (19/20)  |
| Mac, minutos después    | **100%** (15/15) |

El enlace de la máquina 1 al AP es perfecto y estable. El camino **entre los dos
clientes** se degradó hasta desaparecer.

Con esa pérdida no hay `pear install` posible: 78 MB son decenas de miles de
paquetes. Explica la firma exacta que perseguimos todo el día — `peer join`
seguido de 3 kB de metadata y después `0B/s`: los paquetes chicos pasan de a
ratos, el flujo bulk muere.

### El `ping` de Windows cuenta "Host inalcanzable" como paquete RECIBIDO

Trampa de diagnóstico que casi nos hace perder otro rato, medida el 22/8/2026
en la red del venue (192.168.140.0/22, gateway Fortinet):

```
> ping -n 20 192.168.140.98
Respuesta desde 192.168.140.97: Host de destino inaccesible.   (x8)
    Paquetes: enviados = 8, recibidos = 8, perdidos = 0
    (0% perdidos)
```

**0% de pérdida con el host completamente inalcanzable.** Las respuestas vienen
de la IP _propia_: es un ICMP Destination Unreachable que genera el stack
local cuando el ARP no resuelve, y `ping` lo suma a "recibidos".

Por eso el umbral de "no intentes con más de 5% de pérdida" que estaba en el
runbook **daba luz verde en falso**. El chequeo correcto es contar respuestas
de eco reales, que son las únicas que traen `TTL=`:

```
ping -n 10 <ip> | grep -c "TTL="
```

Estado de esa red al momento de medir:

| destino                                | resultado                                          |
| -------------------------------------- | -------------------------------------------------- |
| Gateway 192.168.140.1                  | **0% pérdida, 2–3 ms** — el enlace al AP está sano |
| 192.168.140.98                         | sin entrada ARP: no hay nada en esa IP             |
| 192.168.140.141 (MAC aleatoria, Apple) | tiene MAC pero **100% pérdida**                    |

Un host con MAC resuelta que no contesta un solo ping es la firma de
**aislamiento de clientes en el AP**, no de wifi malo.

**Pero eso no cancela el `pear install`:** Hyperswarm no necesita ruta directa
en la LAN, puede conectar por hole-punching a través de la DHT mientras las dos
máquinas tengan internet. El veredicto lo da el install, no el ping.

### Lo que quedó DESCARTADO por medición, no por intuición

| hipótesis                    | cómo se descartó                                           |
| ---------------------------- | ---------------------------------------------------------- |
| MTU / fragmentación          | `ping -f -l 1472` al gateway: OK (MTU 1500)                |
| UDP bloqueado entre clientes | 7/7 paquetes UDP de 32 a 1472 bytes llegaron               |
| Aislamiento de clientes      | los 5 vecinos de la LAN responden al ping                  |
| Firewall de Windows          | regla Allow para `pear.exe`, perfil **Public**, habilitada |
| Firewall de macOS            | apagado                                                    |
| Versión de Pear distinta     | 3.2.0 en las dos máquinas                                  |
| Sin internet                 | fue real una vez (hotspot sin datos), después 200          |

### Implicancia para el domingo

**El jurado instala desde esa misma wifi.** Si el enlace cliente-a-cliente es
inestable bajo carga, el install puede fallar delante de ellos.

Mitigaciones, de más a menos control nuestro:

1. **`server: true` ya está implementado**: cada nodo instalado reseedea, así que
   cuantos más nodos haya, más caminos alternativos existen. Antes había un solo
   origen posible.
2. Tener el seeder **físicamente cerca del AP**.
3. Tener un hotspot de celular **con datos** como plan B, y las dos máquinas ahí.
4. Antes de cualquier demo, medir: `ping -c 20 <ip-de-la-otra-maquina>`.
   Por encima de ~5% de pérdida, no intentar — va a fallar.

---

## Fase 1 — inferencia local con QVAC

### Definition of Done: CUMPLIDA

> "La app instalada por `pear install` responde un prompt con inferencia 100% local."

El binario standalone compilado corre inferencia real, sin red, con el comando
`qvac-node prompt "..."`. Verificado sobre `out/win32-x64/qvac-node.exe`, que es
exactamente el archivo que `pear build` publica en `/by-arch/win32-x64/app/`.

| paso                                                    | estado                      |
| ------------------------------------------------------- | --------------------------- |
| SDK de QVAC adentro del binario que se distribuye       | ✅                          |
| comando `qvac-node prompt "..."`                        | ✅                          |
| `qvac/worker.pear.entry.mjs` + `pear.stage.entrypoints` | ✅                          |
| addon de llamacpp adentro del standalone (bare-pack)    | ✅                          |
| `win32-arm64` fuera del release                         | ✅                          |
| peso real del install con el addon adentro              | ✅ medido                   |
| tiempo de `pear install` → primer token                 | ✅ máquina 1 / ⬜ máquina 2 |

**v0.10.0 publicada** (verlink 5969) y medida en la máquina 1: **~24 s** de
`pear install` a primer token. Falta repetirlo en la máquina 2, que es el
único lugar donde el install mide la red de verdad y no el store local.

### Arquitectura: dónde vive la inferencia

- `qvac/models.mjs` — catálogo de modelos. Datos puros, sin SDK, para que
  `bin.mjs` arme el `--help` sin arrastrar el addon.
- `qvac/global-process.mjs` — shim del global `process`. Vive solo porque el
  orden de evaluación de ESM importa: los imports corren antes del cuerpo del
  módulo que los declara, así que la asignación tiene que estar en un módulo
  propio importado **primero**, o el SDK ya evaluó sus referencias al global.
- `qvac/engine.mjs` — todo el trato con `@qvac/bare-sdk`. Lo va a reusar
  `serve`/`gateway` en Fase 2.
- `qvac/worker.pear.entry.mjs` — requisito del README de bare-sdk para apps
  Pear. **No participa de nuestro release** (publicamos binarios, no fuente);
  existe para el camino `pear run` desde el fuente y para no quedar fuera de
  contrato con el SDK.
- `bin.mjs` — importa `engine.mjs` de forma **dinámica**. Importar el plugin
  hace `dlopen` del addon (96 MB en win32-x64) en el acto, porque
  `@qvac/llm-llamacpp/addonLogging` hace `require.addon()` en el tope del
  módulo. Arrancar el nodo no tiene por qué pagar eso. bare-pack igual lo mete
  en el binario: su traverse sigue los `import()` con especificador literal
  (verificado: el binario pasó de 55 MB a 159 MB).

### Peso del install CON QVAC adentro (medido)

Lo que descarga el cliente es **solo su plataforma**: Hyperdrive replica sparse
y baja únicamente `/by-arch/<su-plataforma>/app/`.

| plataforma   | Fase 0  | **Fase 1**   | delta   | addon        |
| ------------ | ------- | ------------ | ------- | ------------ |
| darwin-arm64 | 80.9 MB | **105.3 MB** | +24 MB  | 13 MB        |
| darwin-x64   | 83.2 MB | **108.9 MB** | +26 MB  | 14 MB        |
| win32-x64    | 57.3 MB | **165.7 MB** | +108 MB | 96 MB        |
| linux-arm64  | 97.6 MB | **238.6 MB** | +141 MB | 112 MB       |
| linux-x64    | 97.0 MB | **264.7 MB** | +168 MB | 136 MB       |
| win32-arm64  | 53.5 MB | **sacada**   | —       | sin prebuild |

Store completo en el seeder: **843 MB** (eran 448 MB en Fase 0).

macOS pesa poco porque Metal viene en el sistema; Windows y Linux empaquetan
los backends de GPU dentro del `.bare`. Es un solo archivo por plataforma, no
es divisible.

**Para la demo, la Mac es la mejor máquina para instalar delante del jurado:**
105 MB contra 166 MB de Windows y 265 MB de Linux.

### `win32-arm64` fuera del release

`@qvac/llm-llamacpp` no publica prebuild para esa plataforma
(`prebuilds/` tiene android, darwin ×2, ios ×3, linux ×2 y win32-x64; no hay
win32-arm64). Sin prebuild, `bare-build` no tiene con qué linkear el addon.

Sacada de `package.json`, `scripts/make.js` y `scripts/release.js`. El próximo
`npm run release` completo la purga del hypercore: verificado con
`pear stage --dry-run`, que reporta `- /by-arch/win32-arm64/app/qvac-node.exe
(-53.5MB)`.

### La GPU integrada es 8x MÁS LENTA que el CPU en esta máquina

El hallazgo más útil de la fase, y contra la intuición. Medido sobre el binario
que se publica, Llama 3.2 1B en caché, mismo prompt, 3 corridas cada uno:

|                         | default (decide el SDK) | **`--gpu-layers 0`** (todo CPU) |
| ----------------------- | ----------------------- | ------------------------------- |
| carga del modelo        | 8.6 s                   | 7.6 s                           |
| **primer token (TTFT)** | 4.66 s                  | **0.59 s**                      |
| respuesta completa      | 10.6 s                  | 3.1 s                           |

Host: Intel Core i5-8250U + Intel UHD 620 (Vulkan), 17 GB de RAM total, ~1 GB
libre. Es una iGPU que comparte la RAM del sistema: mandarle capas paga la copia
sin ganar cómputo.

Por eso existe el flag `--gpu-layers <n>`. **No** se cambió el default: en una
Mac con Metal el offload a GPU sí conviene, y hardcodear 0 la castigaría. En la
máquina Windows de la demo hay que pasar el flag:

```
qvac-node prompt "..." --gpu-layers 0
```

Pendiente: medir lo mismo en la MacBook Apple Silicon antes de decidir si el
default se toca.

### v0.10.0 publicada: `pear install` → primer token

Publicada el 22/8/2026. Verlink `5962` → **`5969`**, `win32-arm64` purgado
(−53.5 MB). Medido en la máquina 1 con `npm run soak --install`, seeder
corriendo, modelo ya cacheado:

|                              |                               |
| ---------------------------- | ----------------------------- |
| `pear install` desde el link | **15.4 – 17.2 s**, 165.7 MB   |
| carga del modelo             | 8.0 s                         |
| **primer token**             | **0.58 s** (`--gpu-layers 0`) |
| **install → primer token**   | **~24 s**                     |

**Con la reserva de siempre:** la máquina 1 instala contra su propio store de
Pear en disco, así que estos 15 s no miden la red. El número que vale es el de
la máquina 2, y sigue pendiente.

### Soak de robustez: 7/7 corridas OK

`node scripts/soak.js --gpu-layers 0`, binario publicado, modelo en caché:

|                    | min        | mediana    | max        |
| ------------------ | ---------- | ---------- | ---------- |
| carga del modelo   | 7.4 s      | 8.0 s      | 8.3 s      |
| **TTFT**           | **0.54 s** | **0.58 s** | **0.66 s** |
| respuesta completa | 2.3 s      | 3.2 s      | 3.9 s      |

Dispersión baja: el TTFT máximo es 1.2x la mediana. Con el default (GPU) la
dispersión era mucho peor. Un argumento más para `--gpu-layers 0` en esta
máquina.

### BUG: el binario se cuelga para siempre si stdout es un pipe de libuv

El hallazgo más grave de esta ronda, y lo encontró el soak en su primera
corrida: 3 de 3 colgadas a los 600 s.

El CLI carga el modelo, imprime el banner y el prompt, y después **no emite un
solo token. Nunca.** Depende exclusivamente de qué le toca a stdout:

| stdout del hijo                            | resultado             |
| ------------------------------------------ | --------------------- |
| consola (`inherit`)                        | OK, ~12 s             |
| archivo (fd)                               | OK, ~16 s             |
| **pipe de libuv** (`spawn` de Node)        | **COLGADO, infinito** |
| pipe de shell (bash `\|`, PowerShell `\|`) | OK                    |

Aislado con un script de 20 líneas que sólo cambia el `stdio` del `spawn`: con
`['ignore','inherit','pipe']` anda, con `['ignore','pipe','pipe']` se cuelga.
stderr da igual; el que manda es stdout. Tampoco es stdin: da lo mismo `pipe`
que `ignore`.

libuv usa **named pipes** para el stdio de los hijos en Windows; los pipes
anónimos de un shell son otra cosa, y por eso `qvac-node prompt ... | grep`
desde bash funciona y confunde.

**Qué implica:**

- El soak escribe la salida del hijo a un **archivo**, no a un pipe. Está
  comentado en `scripts/soak.js`: si alguien lo "limpia" a `'pipe'`, vuelve el
  100% de cuelgues.
- Cualquier harness en Node o CI que capture la salida se cuelga.
- **Fase 2 va a chocar con esto de frente.** Si el gateway spawnea nodos y les
  lee stdout, se cuelga. Hay que resolverlo ahí con IPC de verdad (como el
  worker del OTA, que usa `FramedStream` sobre `Bare.IPC`) y no leyendo stdout.

Sin explicar todavía: por qué la generación se detiene en vez de sólo
bufferearse. Encaja con el otro síntoma sin explicar de más arriba —el TTFT 3x
peor del CLI compilado contra el mismo código bajo `bare`— y sospecho que es la
misma causa raíz en el manejo de stdout de Bare, pero no lo probé.

### Elección de modelo: Llama 3.2 1B (medido, no estimado)

Ambos dentro del límite de 1B del runbook, medidos con el modelo en caché:

|                    | SmolLM2 360M Q8 | **Llama 3.2 1B Q4_K** |
| ------------------ | --------------- | --------------------- |
| Peso               | 386 MB          | 807 MB                |
| Carga              | 11.5 s          | 19.9 s                |
| **TTFT**           | 0.74 s          | **1.46 s**            |
| Respuesta completa | 4.7 s           | 5.2 s                 |

Misma pregunta, "¿qué es una red peer-to-peer?":

- **360M:** _"Un red peer-to-peer es una red en que todos los usuarios que se
  buscan pueden leer y manejar sus información, no deja de trabajar con otros
  usuarios..."_ — incoherente.
- **1B:** _"Una red peer-to-peer (P2P) es una red de redes de Internet donde los
  nodos (computadoras) conectados entre ellos se comunican directamente entre sí
  sin la intervención de una red central."_ — correcta.

**Default: 1B.** La diferencia de TTFT es imperceptible en una demo; la de
calidad es entre algo que el jurado lee y asiente, y algo que da vergüenza
proyectar. El 360M queda disponible con `--model smol`.

### Los pesos bajan por hypercore, no por HTTP

El descriptor usa el esquema `registry://<registrySource>/<registryPath>` y el
`QVACRegistryClient` baja el blob desde un corestore. El registry expone 154
modelos para `llamacpp-completion`. Vale para el pitch: **los modelos también
viajan por P2P**, no solo el cliente.

La descarga de pesos es un efecto explícito de **pedir** una inferencia, nunca
un efecto de arrancar. La invariante del runbook sigue en pie: `qvac-node` a
secas no baja un solo byte de modelo. `--no-download` fuerza el modo estricto.

---

## Fase 2 — swarm y manifiesto firmado

### D7: tiempo de join al topic → primer manifiesto verificado

Medido con `qvac-node peers` en las **dos direcciones**, con dos procesos en la
**misma máquina** (Windows, DESKTOP-7GTOUA7), storages separados:

| corrida       | join → primer par | join → primer manifiesto verificado |
| ------------- | ----------------- | ----------------------------------- |
| A ve a B      | 5583 ms           | 5590 ms                             |
| B ve a A      | 3648 ms           | 3664 ms                             |
| A ve a B (2ª) | 8649 ms           | 8654 ms                             |
| B ve a A (2ª) | 6639 ms           | 6654 ms                             |

**Estos números NO son el número de D7.** Son loopback: los dos procesos están
en la misma máquina y se encuentran igual por la DHT, así que miden el
bootstrap al topic pero no el hole-punching entre dos redes. **Falta la
medición cross-máquina** (Windows ↔ MacBook), que es la que cuenta para el
objetivo de <60s de Fase 4 y la única que dice si el venue bloquea UDP.

Lo que sí se puede leer de acá:

- El bootstrap a la DHT domina: 3,6–8,6 s, con **1,5x de varianza entre
  corridas consecutivas** en condiciones idénticas. Cualquier gate de la demo
  tiene que tolerar ~10 s de descubrimiento, no 3.
- Verificar el manifiesto es **gratis** frente a encontrar el par: 5–15 ms
  entre "conectado" y "manifiesto verificado", siempre. La firma Ed25519 no
  está en el camino crítico de nada.

### El gate de `peers --expect` medía el estado, no el evento

Primera versión: al salir contaba los pares conectados **en ese instante**. Con
timeouts desparejos (A 45 s, B 40 s), A verificaba el manifiesto de B a los
5,6 s, B se iba a los 40 s, y a los 45 s A reportaba **0 pares y exit 1** —
después de haber cumplido el DoD.

El DoD de Fase 2 es un **evento** ("se descubrieron e intercambiaron
manifiestos verificados"), no un estado. Ahora `NodeSwarm` guarda una marca de
agua alta (`everVerified`) y el resumen imprime las dos cosas: `pares
conectados AHORA` y `verificados EN TOTAL`. El gate usa la segunda.

Es el mismo error que el falso positivo del verificador de la MacBook, con el
signo dado vuelta: un gate que mide lo que es fácil de medir en vez de lo que
la condición realmente dice.

### El descubrimiento tardó 38 s en una corrida: la varianza es el riesgo, no la media

Corridas de `serve --swarm` en dos procesos, misma máquina, mismo código:

| corrida | join → primer manifiesto verificado |
| ------- | ----------------------------------- |
| 1       | 3 664 ms                            |
| 2       | 5 590 ms                            |
| 3       | 6 654 ms                            |
| 4       | 8 654 ms                            |
| 5       | **38 334 ms**                       |

La quinta es la que importa: **10x la mediana**, sin cambiar una línea ni tocar
la red. Un test que esperaba 18 s dio "no hay pares" y mandó el prompt al nodo
local — un falso negativo que parecía un bug del ruteo y no lo era.

Consecuencias, ya aplicadas:

- El gate del runbook usa `--timeout 90`, no 30. Con 38 s de piso observado,
  cualquier ventana menor a un minuto va a fallar en falso alguna vez.
- **En la demo, el swarm se levanta ANTES de empezar a hablar**, no en vivo
  frente al jurado. El objetivo de <60 s de Fase 4 cuenta `pear install` →
  primer token; si además hay que esperar el descubrimiento, no entra.

### Concurrencia del SDK: 3 completions a la vez, sin mezclarse (medido)

`maxConcurrentRequests: 3` en el manifiesto es un número medido, no elegido.

Primer probe: comparó **tiempos** y concluyó "corre en paralelo". Casi lo doy
por bueno, pero las salidas concurrentes venían mucho más cortas que la
secuencial (5 y 10 deltas contra 36) — que es exactamente lo que se vería si
dos completions se pisaran y devolvieran basura rápido.

Segundo probe, mirando el **texto**: el baseline secuencial con el _mismo_
prompt daba 14 y 21 deltas con respuestas distintas. O sea que la varianza era
el sampling, no corrupción. El primer probe medía lo fácil de medir.

Tercer probe, decisivo: tres prompts pidiendo palabras distinguibles
(`BANANA`/`ELEFANTE`/`VIOLETA`), los tres a la vez. Cada respuesta trajo su
propia palabra y **ninguna trajo la de otro**. No hay cross-talk.

Igual el `Provider` impone el límite declarado y rechaza con `at_capacity` en
vez de encolar: así el consumidor se entera **antes** del primer chunk y D4
puede reintentar en otro candidato. Una cola haría esperar al cliente sin que
nadie sepa cuánto.

### Un cliente que se desconecta envenenaba el canal con ese par

El peor bug de esta fase, y el más difícil de leer desde afuera.

`res.write()` sobre una respuesta que el cliente ya cerró tira. Esa escritura
pasaba dentro del callback que atiende los `chat:chunk`, o sea **dentro del
handler `data` del `FramedStream`**. La excepción subía al pipe y se llevaba
puesto el canal con ese par.

Lo que se veía: el primer request andaba, el cliente cortaba a mitad, y desde
ahí **todos** los requests siguientes a ese par devolvían vacío. El par seguía
figurando conectado y verificado en la grilla, `node:status` seguía llegando —
sólo los `chat:request` no llegaban nunca más. Parecía un problema de ruteo.

Dos arreglos, porque uno solo no alcanza:

1. `emit()` envuelve la escritura y, si falla, cancela el request contra el par.
2. `_onMessage` del swarm envuelve **todo** el dispatch: un consumidor que tire
   una excepción no puede volver a romper el canal para los demás.

El segundo es el que importa. El primero arregla este bug; el segundo arregla la
clase entera.

### `chat:cancel` no cancelaba nada: el requestId nunca se asignaba

`requestIdEnVuelo` se inicializaba en `null` y lo único que hacía el código era
volver a ponerlo en `null` al llegar el primer chunk. Nunca recibía el id real,
así que cuando el cliente se iba, el `chat:cancel` no tenía qué mandar.

Se veía como que la cancelación "andaba" (no explotaba nada) mientras el par
seguía generando hasta el final. Ahora `streamFromPeer` devuelve el id por
`onStart` y el corte se verifica del lado del proveedor:
`cancelado por el consumidor` → `cortado tras 2 deltas`.

### `--demo --swarm` registraba el nodo local dos veces

`seed()` (de `--demo`) y `registerLocal()` (de `--swarm`) creaban cada uno una
fila `kind: 'real'` para `llama1b`. La grilla mostraba el mismo nodo local dos
veces, y peor: `localLoad()` sumaba las dos capacidades y el nodo **anunciaba 6
slots teniendo 3**. Anunciarle a la red el doble de capacidad de la que existe
es justo la clase de mentira que el manifiesto firmado está para evitar.

`registerLocal()` ahora borra cualquier fila `real` del mismo modelo antes de
insertar.

### Un par del swarm no puede caer en el generador de mocks

`serve --swarm` puebla el registro con pares reales (`kind: 'peer'`). El
`handleChat` del gateway ramificaba en `kind === 'real' ? engine : mock`, así
que un par remoto verificado caía en el **else** y el gateway le devolvía texto
enlatado al cliente haciéndolo pasar por inferencia remota.

Es la peor falla posible de esta pieza porque **se ve idéntica a que
funcione**. Ahora un `kind: 'peer'` responde **HTTP 501** diciendo que el par
está descubierto y su manifiesto verificado pero que el transporte de
inferencia P2P es Fase 3. El panel lo muestra tal cual.

Y el badge del panel decía `simulado` para esos pares (la lógica era
`kind === 'real' ? 'nodo real' : 'simulado'`): justo al revés de lo que pasa.
Ahora hay tres etiquetas, una por `kind`.

---

## Cosas que mordieron en Fase 1

### BUG DE bare-build: el argv no-ASCII se rompe en el binario standalone

En Windows, el binario de `bare-build --standalone` recibe el argv en la
codepage ANSI y destruye cualquier carácter no-ASCII. `bare.exe` con el mismo
string lo pasa intacto. Repro mínimo, sin QVAC de por medio:

```js
// argvtest.mjs
console.log('argv:', JSON.stringify(Bare.argv))
```

```
$ bare argvtest.mjs "Respondé ñ ¿qué?"
argv: [...,"Respondé ñ ¿qué?"]              <- bien

$ bare-build --standalone --host win32-x64 --out ./out/t argvtest.mjs
$ ./out/t/argvtest.exe "Respondé ñ ¿qué?"
argv: [...,"Respond� � �qu�?"]              <- roto
```

La pérdida es irreversible: cada byte queda como U+FFFD, no como latin1.

**Es grave para una demo en castellano.** Mitigación implementada:
`qvac-node prompt -` lee el prompt de **stdin**, que es un stream de bytes y no
pasa por esa conversión:

```
echo "¿Qué es una red peer-to-peer?" | qvac-node prompt -
```

Verificado: acentos intactos por stdin en el binario standalone.

### `sdk.plugins()` NO es idempotente

Llamarla dos veces tira `PLUGIN_ALREADY_REGISTERED`. Importa porque hay más de
un camino que registra: `qvac/worker.pear.entry.mjs` hace
`registerPlugin(llmPlugin)` **antes** de importar `bin.mjs`, y después
`engine.mjs` registra de nuevo. `engine.register()` se traga ese error
específico —y sólo ése.

### El logging de llama.cpp no se puede apagar del todo

Las dos líneas `parse: load the model metadata from disk file.` e
`initFromConfig: ...` que salen al cargar son `printf` crudos de llama.cpp,
anteriores al hook de logging. No las apaga `modelConfig.verbosity: 0`, ni
`setGlobalLogLevel('error')`, ni `setGlobalConsoleOutput(false)` del SDK
(las tres probadas). Redirigir el fd 1 es la única vía y se llevaría puesta la
respuesta. Se conviven.

### El binario CLI tiene 3x peor TTFT que el mismo código bajo `bare` — sin explicar

Reproducible y estable, pero **no** entendido:

|                                                  | TTFT  |
| ------------------------------------------------ | ----- |
| `bare bin.mjs prompt "..."`                      | 1.5 s |
| `qvac-node.exe prompt "..."`                     | 4.4 s |
| script de prueba con el mismo bundle, standalone | 1.5 s |

Descartados por medición, uno por uno: detección de hardware
(`getSystemResources()` devuelve exactamente lo mismo en los dos —Intel UHD
620, Vulkan, mismos cores—), `modelConfig.verbosity`, el callback `onProgress`,
leer el prompt de stdin vs de argv, el contenido del bundle (un script de
prueba con los mismos imports que `bin.mjs` —`app.js`, `bare-storage`,
`paparam`— da 165.69 MB contra 165.70 MB del CLI y corre rápido), e
`import` dinámico vs estático de `engine.mjs`.

Queda vivo el runner async de paparam, que no llegué a aislar.

**Por qué no bloquea:** `--gpu-layers 0` da 0.59 s de TTFT en el binario, o sea
mejor que los 1.5 s de `bare`. El camino de la demo no pasa por acá.

---

## Cosas que mordieron en Fase 0 (para no repetirlas)

- **`pear install` no sirve código fuente, sirve un binario compilado.** Busca
  `/by-arch/<plataforma>/app/<name>[.exe]`. Sin `pear build` previo falla con
  `Not found: .../qvac-node.exe`. El flujo es
  `make` → `pear build` → `pear stage` → `pear seed` → `pear install`.
- **`pear build` necesita `--package ./package.json` explícito.** Sin ese flag
  imprime el help y sale con código 1, sin decir qué falta.
- **`pear install --to <dir>` requiere que el directorio ya exista.** Si no,
  descarga los 55 MB completos y recién ahí falla con `ENOENT` en el `chmod`.
- **Pear NO respeta `.gitignore`.** Al stagear la raíz del repo subía `.git`,
  `old/`, los prompts y **1.1 GB de devDependencies** (`bare-build-*` son
  toolchains de cross-compilación para android/ios/darwin/linux/win32). Se
  resuelve stageando `./build`, no la raíz; `pear.stage.ignore` quedó como red
  de seguridad.
- **`release:host` no purga, a propósito.** Purgar stageando una sola
  plataforma borraría del hypercore los binarios de las otras cinco.
- **Cross-compilación: todas las plataformas compilan desde Windows.** No hace
  falta una Mac para publicar el binario de Mac. (Eran 6 en Fase 0; desde
  Fase 1 son 5: `win32-arm64` se sacó por falta de prebuild del addon.)

---

## Fase 5 — Hyperbee, Hyperdrive y el socket compartido

### Lo que se midió

| Qué                                                                | Resultado                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Archivo de 3 MB entre dos corestores locales (bare, misma máquina) | 305 ms, byte a byte idéntico                                                    |
| Archivo de 58 B entre dos `--storage` distintos, por el CLI real   | 2.2 s de punta a punta (incluye descubrimiento en la DHT)                       |
| Replicación del Hyperbee de un par por el socket del chat          | funciona: el nodo A leyó una clave escrita por B sin abrir una segunda conexión |
| Suite de tests                                                     | 16/16, 85/85 asserts                                                            |

### Protomux en vez de FramedStream: por qué hubo que cambiarlo

`FramedStream` se adueña del stream que envuelve. `corestore.replicate(socket)`
necesita ESE MISMO stream para multiplexar la replicación de hypercores. Las dos
cosas no entran en una conexión, y abrir una segunda es exactamente lo que D1
decidió no hacer.

La trampa concreta, que costó encontrar: `Protomux.from(socket)` devuelve
`socket.userData` si ya hay un mux ahí, y **si no, crea uno nuevo sin
guardarlo**. `corestore.replicate` hace lo mismo por su lado (vía
`Hypercore.createProtocolStream`, que sí lo guarda). Si el canal de control se
abre sin dejar el mux en `userData`, terminan DOS multiplexores escribiendo
frames intercalados sobre el mismo socket. Desde afuera se lee como "se cayó la
red". Por eso `channel.mjs` expone `attachMux(socket)` y `swarm.mjs` lo llama
primero, antes de replicar y antes de abrir el canal.

Lo que NO se pierde al sacar FramedStream: el cap de 16 MiB por frame que daba
`bits: 24`. `NoiseSecretStream` frena en `MAX_ATOMIC_WRITE = 0xffffff`, los
mismos 16 MiB, una capa más abajo — antes de que Protomux reserve nada.

Lo que se GANA: la basura de otra app que caiga en el mismo topic ya no llega al
dispatcher. Sin abrir el canal `qvac/node/v0` no hay a dónde entregársela.

### El topic subió a v1 y hay que entender por qué

Protomux y FramedStream no son compatibles en el cable. Visto en vivo contra un
nodo v0.10.0 corriendo al lado:

```
[swarm] conectado d6ad6dab… (1 par/es)
[swarm] d6ad6dab… no mando manifiesto, se descarta
[swarm] desconectado d6ad6dab… (0 par/es)
[swarm] conectado d6ad6dab… (1 par/es)      <- en loop
```

Los dos nodos estaban sanos. Se conectaban porque el topic era el mismo y
después se quedaban mudos hasta el `HANDSHAKE_TIMEOUT_MS`.

`qvac-node:marketplace:v1` convierte esa incompatibilidad silenciosa en una
ausencia limpia: durante la ventana del OTA los v0 se ven entre ellos y los v1
entre ellos. Cuando el último nodo se actualiza, el topic v0 queda vacío solo.

**Consecuencia para el runbook de 2 máquinas: las dos tienen que estar en la
misma versión.** Una en v0.10.0 y otra en v0.11.0 da cero pares verificados, y
el síntoma se lee igual que un problema de red — que es justo el falso positivo
que el gate de `--expect` existe para cazar.

### Un core recién abierto contesta `null`, no espera

Bug que se comió una tarde y que vuelve a morder a cualquiera que lea un
Hyperbee o un Hyperdrive remoto:

Un core recién abierto tiene `length === 0` **localmente**. Hyperbee, sobre un
core de largo cero, contesta `null` a cualquier `get` — en el acto, sin error y
sin esperar a nadie. Pedir un archivo que existe perfectamente del otro lado
devuelve "el drive no tiene esa ruta": un falso negativo idéntico a un link mal
escrito.

La cura es `await drive.update({ wait: true })` ANTES de leer, con
`findingPeers()` abierto para que ese update espere a que aparezca alguien en
vez de resolver contra cero pares. Está encapsulado en `Files._syncRemote()`.

### `mkdtempSync` de bare-fs en Windows rompe RocksDB

En Windows, `fs.mkdtempSync` de **bare-fs** devuelve una ruta extendida:

```
\\?\C:\Users\User\AppData\Local\Temp\qvac-x-h5h4s8
```

RocksDB le concatena `db/LOG` con barra normal, y después del prefijo `\\?\`
las barras normales son ilegales. El error:

```
Unexpected error for: \\?\C:\...\A\db/LOG: El nombre de archivo, el nombre de
directorio o la sintaxis de la etiqueta del volumen no son correctos. (EIO)
```

Node no lo hace: `fs.mkdtempSync` de Node devuelve la ruta normal y el mismo
Corestore abre sin chistar. Es específico de bare-fs.

**El código real no está afectado**: `swarmStorageDir()` usa `os.tmpdir()` y
`persistent()` directo, que devuelven rutas normales. Muerde solo en tests y
scripts que arman directorios temporales — por eso `test/index.js` arma el
suyo con `path.join(os.tmpdir(), 'qvac-test-' + …)` en vez de `mkdtemp`.

### Bug que cazó un test

`Directory.recordManifest` indexaba `model/<modelId>/<peerKey>` pero nunca
borraba las entradas del anuncio anterior. Un par que reanuncia con MENOS
modelos —porque descargó uno, o porque se quedó sin VRAM— dejaba su fila vieja
indexada para siempre, y el panel seguía diciendo que alguien sirve algo que ya
nadie sirve. Se reconstruye el índice usando la lista de modelos del manifiesto
guardado, y no un scan del prefijo `model/`: el `peerKey` es el último tramo de
esa clave, así que buscar "las de este par" obligaría a recorrer el índice
entero.

### Lo que sigue sin implementarse

**Autobase.** Era lo que hacía falta para el ledger multi-escritor (recibos,
reputación agregada, liquidación en QVAC), y no entraba por complejidad de
código sino por gobernanza: había que decidir quién es el primer escritor, cómo
entra el segundo, y quiénes firman la vista como indexers. La `apply` además
tenía que ser determinista y pura, e idempotente bajo re-ejecución, porque
Autobase trunca y re-aplica la vista cuando llega un mensaje viejo de un par que
estuvo offline.

**Ya no está en el roadmap, y esa es la buena noticia.** La Fase 10 lo vuelve
innecesario: la liquidación es on-chain y la firma EIP-3009 ya es el recibo, así
que no hace falta un ledger multi-escritor propio. Queda escrito en
[ROADMAP_FASE7-X402.md](ROADMAP_FASE7-X402.md), sección "Lo que sale del
alcance". Si algún día vuelve, va a ser por un estado compartido que no sea
plata —reputación agregada, metering verificable— y no por los pagos.

---

## Nodo Linux 24/7 — GMKtec K16 (Ubuntu 26.04)

Segunda máquina de medición, y la primera con Linux: **Ryzen con Radeon 680M
(RADV REMBRANDT, `uma: 1`), 25 GB de RAM, Ubuntu 26.04.1 LTS, kernel 7.0.0-30,
Node 22.22.1, npm 11.19.1.** Corre `serve --swarm` bajo systemd, 24/7.

### BUG: el binario standalone `linux-x64` no carga NINGÚN modelo

`pyrusllm-linux-x64` de v0.12.0 falla siempre con el mismo error:

```
initFromConfig: load the model from disk file and apply lora adapter, if any.
common_fit_params: encountered an error while trying to fit params to free device memory: failed to load model
```

El mensaje habla de memoria y **no es un problema de memoria**. Descartado uno
por uno, con evidencia:

| Hipótesis | Cómo se descartó |
| --- | --- |
| GGUF corrupto o truncado | Bajado dos veces, 807691648 bytes exactos las dos. `sha256` idéntico al de la máquina Windows donde el MISMO archivo carga bien: `406bd598…` |
| Específico de un modelo | `smollm2-360m-instruct-q8_0` (386 MB, q8_0) falla igual que `llama_3.2_1b…Q4_K` (808 MB, Q4_K). Dos cuantizaciones distintas |
| Offload a la iGPU | Falla con y sin `--gpu-layers 0`, por el camino de `prompt` y por el de `serve` |
| Vulkan / RADV | Con `VK_DRIVER_FILES=/nonexistent` la corrida imprime `no usable GPU found` y **falla idéntico** |
| Memoria del dispositivo | El carve-out de la 680M es de 5 GB (`mem_info_vram_total` = 5368709120), con 21 GB de RAM libre, para un modelo de 808 MB |
| Contexto demasiado grande | `DEFAULT_CTX_SIZE` es 2048 (`qvac/models.mjs:62`) |

**Lo único que cambia entre la corrida que falla y la que anda es el runtime:**

|  | resultado |
| --- | --- |
| `runtime: pear (installed)` — binario standalone | `failed to load model` |
| `runtime: bare (dev)` — `bare bin.mjs` sobre el fuente | **carga en 4.2 s y responde** |

Mismo GGUF, mismo hash, mismos flags, misma máquina, misma Vulkan enumerada.

#### Dónde está exactamente, según `strace`

Trazando `openat` en las dos corridas, la diferencia es de una línea:

| | genéricos (`hexagon`, `musa`, `openvino`, `cpu`, `vulkan`) | las 14 variantes (`cpu-haswell`, `cpu-zen4`, …) |
| --- | --- | --- |
| standalone | los prueba todos | **ninguna** |
| desde el fuente | los prueba todos | **las prueba una por una y carga `haswell`** |

Los genéricos salen de una lista fija compilada en el addon. Las variantes solo
pueden salir de **listar el directorio** — y el standalone **nunca lo abre**:
`grep O_DIRECTORY` sobre su traza no devuelve una sola línea contra el directorio
de backends; la del fuente lo abre quince veces.

**El binario standalone registra únicamente el backend Vulkan.** Sin backend de
CPU, `--gpu-layers 0` no tiene dónde poner los pesos. Eso explica los tres
síntomas: que Vulkan enumerara igual, que `--gpu-layers 0` no ayudara, y que con
`VK_DRIVER_FILES=/nonexistent` quedaran cero backends y el mensaje pasara a
`no usable GPU found`. El texto sobre "free device memory" era engañoso: ggml no
podía ajustar los parámetros porque no tenía dispositivo al cual ajustarlos.

Descartado además, con evidencia:

- **No es el renombre de la extracción.** Los 15 `.so` quedan en
  `/tmp/pyrusllm-<hash>/…/qvac__llm-llamacpp/` con nombres limpios, tamaños
  correctos y `rw-rw-r--`.
- **No es `__dirname` ni `backendsDir`.** El standalone sondea la ruta real de
  `/tmp`, así que `bare-build` sí reescribe `__dirname` a la carpeta extraída.
- **No es `/tmp` con `noexec`.** Está montado `rw,nosuid,nodev`.
- **`GGML_BACKEND_PATH` no lo arregla**, ni apuntando al directorio de los `.so`
  ni a su padre.

La rama de código que enumera el directorio simplemente no corre dentro del
binario empaquetado. **Eso ya no es de este repo**: está en el addon nativo o en
cómo `bare-build` lo empaqueta, y va aguas arriba con las dos trazas.

Es el mismo eje que
[«El binario CLI tiene 3x peor TTFT que el mismo código bajo `bare`»](#el-binario-cli-tiene-3x-peor-ttft-que-el-mismo-código-bajo-bare--sin-explicar),
que quedó sin explicar en Fase 1. Allá degradaba; acá es fatal.

**Alcance real:** cada release publica `pyrusllm-linux-x64` (269 MB en v0.12.0)
e `install.sh` lo instala en Linux sin avisar de nada. Ese artefacto **nunca
sirvió un token**. No se había notado porque todas las mediciones previas fueron
en Windows y macOS.

**Workaround en producción:** el nodo 24/7 corre desde el fuente
(`node_modules/bare-runtime-linux-x64/bin/bare bin.mjs …`), no desde el binario.

### El repo no se instala con npm 9

`npm install` con npm 9.2.0 —el que empaqueta Ubuntu aparte de Node 22— muere con:

```
npm ERR! Invalid comparator: file:vendor/ws-stub
```

npm 9 no sabe resolver un spec `file:` dentro de `overrides`, y `package.json`
usa exactamente eso para el stub de `ws`. Con npm 11 instala sin chistar.

`package.json` no declara `engines`, así que el usuario recibe un mensaje que no
significa nada. Cuatro líneas lo arreglan:

```json
"engines": { "node": ">=20", "npm": ">=10" }
```

### La 680M confirma lo de la iGPU: CPU gana

Con `--gpu-layers 0`, Llama 3.2 1B, desde el fuente:

|  |  |
| --- | --- |
| carga del modelo | 4.2 s |
| **primer token (TTFT)** | **0.08 s** |
| respuesta completa | 0.5 s |

Para comparar: la máquina Windows de la demo, sirviendo por la red en esa misma
sesión, dio **14.0 s de TTFT y 1 tok/s**. El hallazgo de la Intel UHD 620 se
sostiene en AMD.

### D7: «primer par» estaba midiendo dos cosas distintas

Dos corridas del mismo nodo contra el mismo par:

| Estado del nodo | primer par |
| --- | --- |
| clave recién generada, store vacío | **297.167 ms** |
| `clave existente reusada`, `2 par/es del directorio` | **4.357 ms** |

Los 297 s no eran la red ni el wifi: era un nodo virgen descubriendo todo desde
cero en la DHT. Un nodo con el directorio caliente se reconecta en 4 s. **Son
dos números distintos que hoy se reportan con la misma etiqueta**, y conviene
separarlos antes de sacar cualquier conclusión sobre el descubrimiento.

### `--storage` es flag de la raíz, no de `serve`

`swarmStorageDir()` lo lee de `cmd.flags.storage` (`bin.mjs:729`), y el flag está
declarado en el comando raíz (`bin.mjs:179`). `serve --storage <dir>` muere con
`UNKNOWN_FLAG: storage`; el orden correcto es `bin.mjs --storage <dir> serve …`.

Importa para cualquier despliegue con `bare`: en modo dev el default es
`os.tmpdir()`, así que un servicio mal invocado pierde la identidad de swarm en
cada reinicio y se anuncia como un nodo nuevo cada vez.

### El gate que faltaba: `npm run smoke`

El bug de arriba sobrevivió meses por una razón de proceso, no de código:
[`scripts/release.js`](scripts/release.js) compilaba los cinco targets, los
stageaba y los publicaba **sin ejecutar ninguno**. Compilar no es funcionar.

[`scripts/smoke.js`](scripts/smoke.js) corre un binario y exige que sirva un
token. Corre como gate en `release.js` antes del `pear stage`, y en
[`.github/workflows/artefactos.yml`](.github/workflows/artefactos.yml) sobre una
matriz de tres sistemas — lo único que cubre los targets cross-compilados, que
el gate del host no puede tocar.

**Trampa que casi se cuela, y por eso queda escrita.** La primera versión del
smoke corría con `--quiet` y daba OK si había salido *algún* texto. Pasó en
Windows con esto como supuesta respuesta:

```
parse: load the model metadata from disk file. initFromConfig: load the model...
```

Eso es el logging nativo de llama.cpp, que **no se puede apagar** (ver más
arriba, "El logging de llama.cpp no se puede apagar del todo"). Un smoke que
mide "hubo salida" mide el ruido del addon, no el trabajo del modelo — y habría
dado luz verde al binario roto, que es exactamente lo que vino a evitar.

La versión que quedó corre **sin** `--quiet` y exige la línea de TTFT que
imprime `bin.mjs:293`, con un número real: ese renglón dice `n/d` cuando el
stream terminó sin un solo delta, así que un modelo que carga pero no emite nada
también es FAIL.

Verificado en las tres direcciones, que es lo mínimo que se le puede pedir a un
gate:

| Qué se probó | Resultado |
| --- | --- |
| `win32-x64` standalone | **OK** — TTFT 0.38 s |
| `linux-x64` standalone | **FAIL** — "no pudo cargar el modelo" |
| `bare bin.mjs` en Linux (lo que corre el nodo 24/7) | **OK** — TTFT 0.07 s |

Dos detalles del diseño que no son adorno:

- **Escribe a un archivo, no a un pipe.** El binario se cuelga para siempre si
  su stdout es un pipe de libuv (ver arriba). Un smoke ingenuo se colgaba en la
  primera corrida.
- **Distingue "artefacto roto" de "hay un nodo corriendo".** El lock del registry
  daría un FAIL que no dice nada sobre el binario. En un nodo 24/7 eso pasa cada
  vez: hay que bajar el servicio para correr el smoke.

**Pendiente de la primera corrida en CI:** si los runners de GitHub pueden
alcanzar el swarm del registry de QVAC para bajar los pesos. Si no pueden, el
modelo va a tener que llegar por otra vía y el `actions/cache` no alcanza.

### D7 entre redes separadas: atravesar dos NAT no cuesta nada

Medido el 27/8/2026 con el nodo de la K16 corriendo como servicio de systemd, y
el segundo nodo en Windows moviéndose de red entre corridas. Mismo par en las
cuatro (`eea6107f…` ↔ `1749ebae…`).

| Escenario | primer par (D7) |
| --- | ---: |
| Nodo virgen (clave nueva, store vacío), misma LAN | **297 167 ms** |
| Directorio caliente, misma LAN (ethernet ↔ wifi) | 4 357 ms |
| Directorio caliente, misma LAN | 6 787 ms |
| Directorio caliente, misma LAN | 4 513 ms |
| **Directorio caliente, REDES DISTINTAS** (fibra ↔ red móvil) | **6 459 ms** |

**Los 297 s no eran la red.** Era un nodo virgen descubriendo todo desde cero en
la DHT. Un nodo con pares en el directorio se reconecta en 4–7 s. Son dos
números distintos que hoy se reportan con la misma etiqueta, y conviene
separarlos antes de sacar conclusiones sobre el descubrimiento.

**Y cruzar dos NAT cae dentro del rango de la misma LAN**, no fuera. No es un
caso fácil: la red móvil es casi con seguridad CGNAT, donde el teléfono no tiene
IP pública propia. El holepunch lo resolvió solo, sin un puerto abierto de
ningún lado.

### Inferencia remota sobre holepunch, medida

Chat fijado al nodo de la K16 desde el hotspot del teléfono, con el operador sin
acceso SSH a esa máquina en ese momento — el nodo sirvió solo:

| | TTFT | tok/s |
| --- | ---: | ---: |
| Primer request (arranque en frío, carga del modelo) | 6 091 ms | 2 |
| Segundo request (modelo ya cargado) | **271 ms** | **28** |
| Referencia: el mismo modelo local en la K16 | 70 ms | — |

Cruzar internet costó **~200 ms** de TTFT. El resto es la máquina.

### El nodo declara precio y NO cobra: `no charge`

Con la wallet activa (`0xDc0f…3404`, redes `plasma, stable`, liquidación
`batch-receipts`) y el manifiesto anunciando 1.000.000 QVAC por 1M de tokens de
salida, **las dos respuestas remotas se sirvieron con `no charge`**.

`cobroDe()` (`qvac/gateway.mjs:1458`) devuelve null en dos casos, y ninguno es un
error:

1. el manifiesto del par llegó sin `economic.walletAddress` → no se sabe a quién
   pagarle;
2. `x402.desafio()` devolvió null → el nodo no tiene **ninguna red de pago
   usable**. Plasma está apagada mientras no se declare
   `PYRUS_X402_PLASMA_ASSET_VERIFICADO=1`, así que dependería enteramente de que
   `@x402/evm` traiga activo por defecto para `eip155:988`.

**No era ninguna de las dos.** El manifiesto llegó completo — `GET /v1/nodes` en
el par muestra `economic.walletAddress`, `chains` y `settlement` — y la red
`stable` sí resuelve activo (`@x402/evm` devuelve USDT0
`0x779Ded…3736` para `eip155:988`; Plasma tira `No default asset configured`,
que es por lo que el código la declara a mano).

La respuesta está en la **condición que llama** a `cobroDe`, no adentro
(`qvac/gateway.mjs:1689`):

```js
if (sinCredencial) {
  const cobro = await cobroDe({ node, ... })
```

**El 402 solo existe para quien llega sin API key.** El panel se autentica con la
key del panel, así que `sinCredencial` es falso y el camino del cobro ni se
evalúa. Con credencial sos un cliente autenticado de este nodo y no pagás; sin
credencial, el nodo te ofrece pagar en vez de rechazarte.

#### El 402, medido

Mismo request sin `Authorization`, fijado a cada nodo:

| Fijado a | Respuesta |
| --- | --- |
| Par con wallet (K16) | **402** con el desafío |
| Nodo propio sin wallet usable | **401** pidiendo API key |

El desafío que devuelve:

```json
{"scheme":"exact","network":"eip155:988","amount":"1000",
 "payTo":"0xDc0f5891bBA48941bb02213fAB6Bc70721253404",
 "asset":"0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
 "extra":{"name":"USDT0","version":"1"},"outputTokenLimit":2048}
```

**D10 cumplido:** el `payTo` es la dirección del PROVEEDOR, no la del gateway que
contesta. No hay intermediario. Y Plasma no se ofrece, correctamente.

#### Lo anunciado y lo cobrado no coinciden

El header de la misma respuesta dice `X-Pyrus-Cost-Estimate-Micros: 0`. El precio
del ledger para P2P es cero, así que el 402 cae al piso declarado:
`amount: "1000"` = **US$ 0,001** (USDT0, 6 decimales).

O sea: la tarjeta del panel anuncia "1M QVAC por 1M de tokens de salida", y el
402 pide un **mínimo fijo de un milésimo de dólar**, sin importar ese precio ni
cuántos tokens se pidan. Está escrito en el código —"un 402 que pide cero no es
un cobro"— y no es un bug oculto, pero **hoy lo que se anuncia y lo que se firma
son dos números distintos**, y el panel no lo dice.

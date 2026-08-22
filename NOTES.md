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

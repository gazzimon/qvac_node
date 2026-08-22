# NOTES — mediciones QVAC-Node

Números medidos, no estimados. Insumo del README y del pitch.
Máquina de medición: Windows 11 Pro 26200, Node 24.14.1, Bare 1.31.0, Pear 3.2.0.

---

## Fase 0 — túnel de distribución

**Link del proyecto:** `pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny`

### Peso del install

| | |
|---|---|
| Binario standalone win32-x64 | **55 MB** |
| **Lo que descarga el cliente** | **55 MB** |
| Store completo (6 plataformas) en el seeder | 448 MB |

El cliente **no** descarga los 448 MB: Hyperdrive replica sparse y baja solo
`/by-arch/<su-plataforma>/app/`. Medido: con las 6 plataformas publicadas, un
cliente win32-x64 transfirió 55 MB. Es el número que importa para el jurado.

Peso por plataforma del binario standalone:

| plataforma | tamaño |
|---|---|
| win32-arm64 | 52 MB |
| win32-x64 | 55 MB |
| darwin-arm64 | 78 MB |
| darwin-x64 | 80 MB |
| linux-x64 | 93 MB |
| linux-arm64 | 94 MB |

### Tiempos

| operación | tiempo |
|---|---|
| `pear install` completo (descarga + PATH) | **12–13 s** |
| Descarga sostenida observada | 22–24 MB/s, 1 peer |
| **Propagación OTA** (`pear stage` → `update aplicado`) | **~10 s** |
| `npm run release` (6 plataformas: build + stage) | 27 s |
| `npm run release:host` (1 plataforma) | 6 s |
| `npm run make` por plataforma | ~3 s |

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

| paso | estado |
|---|---|
| `pear touch` → link en `upgrade` | ✅ |
| build standalone, 6 plataformas | ✅ |
| `pear build` → `by-arch/` | ✅ |
| `pear stage` / `pear seed` | ✅ |
| `pear install` desde el link | ✅ |
| OTA sobre copia instalada corriendo | ✅ (misma máquina) |
| **Segunda máquina limpia: INSTALL** | ✅ |
| **Segunda máquina limpia: OTA** | ⬜ pendiente |

### Install cross-máquina verificado

Windows 11 (seeder) → MacBook Air Apple Silicon, sobre hotspot de iPhone.

| | |
|---|---|
| Binario servido | `/by-arch/darwin-arm64/app/qvac-node` |
| Transferido | **80.9 MB** |
| Velocidad pico | **3.4 MB/s** |
| Versión | 0.8.0 (verlink 0.5955) |

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

| destino | pérdida |
|---|---|
| Gateway (192.168.112.1) | **0%** — 3 ms |
| Mac, primera medición | 0% — 6-29 ms |
| Mac, una hora después | **95%** (19/20) |
| Mac, minutos después | **100%** (15/15) |

El enlace de la máquina 1 al AP es perfecto y estable. El camino **entre los dos
clientes** se degradó hasta desaparecer.

Con esa pérdida no hay `pear install` posible: 78 MB son decenas de miles de
paquetes. Explica la firma exacta que perseguimos todo el día — `peer join`
seguido de 3 kB de metadata y después `0B/s`: los paquetes chicos pasan de a
ratos, el flujo bulk muere.

### Lo que quedó DESCARTADO por medición, no por intuición

| hipótesis | cómo se descartó |
|---|---|
| MTU / fragmentación | `ping -f -l 1472` al gateway: OK (MTU 1500) |
| UDP bloqueado entre clientes | 7/7 paquetes UDP de 32 a 1472 bytes llegaron |
| Aislamiento de clientes | los 5 vecinos de la LAN responden al ping |
| Firewall de Windows | regla Allow para `pear.exe`, perfil **Public**, habilitada |
| Firewall de macOS | apagado |
| Versión de Pear distinta | 3.2.0 en las dos máquinas |
| Sin internet | fue real una vez (hotspot sin datos), después 200 |

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

### Funciona: inferencia 100% local adentro de Bare

`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0, plugin `llmPlugin`
registrado explicitamente, modelo **SmolLM2-360M-Instruct-Q8_0** (360M, 386 MB).

| medicion | primera vez | modelo en cache |
|---|---|---|
| Carga del modelo | 80.5 s | **11.1 s** |
| **Primer token (TTFT)** | 6.04 s | **0.83 s** |
| Respuesta completa | 8.9 s | 3.9 s |

Host: Intel UHD 620 (Vulkan), 15.86 GB RAM total pero solo 0.96 GB libres.

### Los pesos bajan por hypercore, no por HTTP

El descriptor usa el esquema `registry://<registrySource>/<registryPath>` y el
`QVACRegistryClient` baja el blob desde un corestore. El registry expone 154
modelos para `llamacpp-completion`. Vale para el pitch: **los modelos tambien
viajan por P2P**, no solo el cliente.

### Peso del addon: el problema abierto de Fase 1

`@qvac/llm-llamacpp` son 519 MB de prebuilds. Por plataforma:

| plataforma | addon | proyeccion del install |
|---|---|---|
| linux-x64 | 136 MB | ~230 MB |
| win32-x64 | 96 MB | ~150 MB |
| darwin-arm64 | **13 MB** | **~93 MB** |
| darwin-x64 | 14 MB | ~94 MB |

macOS pesa poco porque Metal viene en el sistema; Windows y Linux empaquetan
los backends de GPU. Es un solo `.bare` por plataforma, no es divisible.

**`win32-arm64` NO tiene prebuild.** Hoy publicamos esa plataforma; con
inferencia adentro deja de ser viable y hay que sacarla del release.

### Calidad de salida: revisar antes del pitch

SmolLM2-360M responde en ~1s pero produce castellano incoherente. Es lo que el
jurado lee en pantalla. Alternativa dentro del limite de 1B del runbook:
`llama_3.2_1b_intruct_tool_calling_v2.Q4_K` (1B, 807 MB).

---

## Cosas que mordieron (para no repetirlas)

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
- **Cross-compilación: las 6 plataformas compilan desde Windows.** No hace
  falta una Mac para publicar el binario de Mac.

---

## Pendiente de medir (Fase 1)

- Peso del install **con QVAC + addon llamacpp** adentro.
- Tiempo de `pear install` a primer token.
- Si `qvac bundle sdk` (worker bundle tree-shakeado) baja el peso, y cuánto.
